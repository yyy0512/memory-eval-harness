```java
package com.vitalpulse.cloudcare.authorizer;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.events.APIGatewayCustomAuthorizerRequest;
import com.vitalpulse.cloudcare.authorizer.exception.InvalidTokenException;
import com.vitalpulse.cloudcare.authorizer.model.AuthPolicy;
import com.vitalpulse.cloudcare.authorizer.model.PolicyDocument;
import com.vitalpulse.cloudcare.authorizer.security.TokenVerifier;
import com.vitalpulse.cloudcare.authorizer.security.VerifiedToken;
import org.assertj.core.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link TokenAuthorizerHandler}. <br>
 * <p>
 *  The class verifies the following behavioural aspects:
 *  <ul>
 *      <li>Valid OAuth2 / JWT tokens are converted into an <i>Allow</i> policy with the correct principal id.</li>
 *      <li>Invalid, missing or malformed tokens lead to a <i>Deny</i> policy.</li>
 *      <li>The handler caches verification results for the same Authorization header in order to save cold-start
 *          latency and external introspection calls.</li>
 *      <li>All relevant information is written to the Lambda {@link Context#getLogger()}.</li>
 *  </ul>
 * </p>
 */
@ExtendWith(MockitoExtension.class)
class TokenAuthorizerHandlerTest {

    private static final String EXAMPLE_METHOD_ARN =
            "arn:aws:execute-api:us-east-1:123456789012:abcdef/prod/GET/patients";

    @Mock
    private TokenVerifier tokenVerifier;

    @Mock
    private Context lambdaContext;

    private TokenAuthorizerHandler handler;

    @BeforeEach
    void setUp() {
        handler = new TokenAuthorizerHandler(tokenVerifier);
        when(lambdaContext.getAwsRequestId()).thenReturn(UUID.randomUUID().toString());
        when(lambdaContext.getFunctionName()).thenReturn("token-authorizer");
        when(lambdaContext.getLogger()).thenReturn(System.out::println);
    }

    @Nested
    @DisplayName("Happy Path")
    class HappyPath {

        @Test
        @DisplayName("Should return an allow policy for a valid bearer token")
        void shouldAllowAccessForValidToken() throws Exception {
            // Arrange
            String token = "Bearer valid.jwt.token";
            APIGatewayCustomAuthorizerRequest request = buildRequest(token);
            VerifiedToken verifiedToken = new VerifiedToken(
                    "user-123",
                    Map.of("scope", "patient/*.read"),
                    Instant.now().plusSeconds(300)
            );

            when(tokenVerifier.verify("valid.jwt.token")).thenReturn(verifiedToken);

            // Act
            AuthPolicy response = handler.handleRequest(request, lambdaContext);

            // Assert
            assertThat(response).isNotNull();
            assertThat(response.getPrincipalId()).isEqualTo("user-123");

            PolicyDocument.Statement statement = response.getPolicyDocument().getStatement().get(0);
            assertThat(statement.getEffect()).isEqualTo("Allow");
            assertThat(statement.getResource()).contains(EXAMPLE_METHOD_ARN);

            // Verify interaction
            verify(tokenVerifier, times(1)).verify("valid.jwt.token");
        }

        @Test
        @DisplayName("Should hit cache after first verification for identical token")
        void shouldCacheVerificationResult() throws Exception {
            // Arrange
            String token = "Bearer cached.jwt.token";
            APIGatewayCustomAuthorizerRequest firstCall = buildRequest(token);
            APIGatewayCustomAuthorizerRequest secondCall = buildRequest(token);

            VerifiedToken verifiedToken = new VerifiedToken(
                    "user-999",
                    Collections.emptyMap(),
                    Instant.now().plusSeconds(60)
            );
            when(tokenVerifier.verify("cached.jwt.token")).thenReturn(verifiedToken);

            // Act
            AuthPolicy firstResponse = handler.handleRequest(firstCall, lambdaContext);
            AuthPolicy secondResponse = handler.handleRequest(secondCall, lambdaContext);

            // Assert
            assertThat(firstResponse.getPrincipalId()).isEqualTo("user-999");
            assertThat(secondResponse.getPrincipalId()).isEqualTo("user-999");

            // Token verification must only be executed ONCE due to caching
            verify(tokenVerifier, times(1)).verify("cached.jwt.token");
        }
    }

    @Nested
    @DisplayName("Unhappy Path")
    class UnhappyPath {

        @ParameterizedTest(name = "Should deny when Authorization header is \"{0}\"")
        @NullAndEmptySource
        @ValueSource(strings = {"Bearer", "foo", "Bearer   ", "Basic abcdef"})
        void shouldDenyAccessForMissingOrMalformedToken(String tokenHeader) {
            // Arrange
            APIGatewayCustomAuthorizerRequest request = buildRequest(tokenHeader);

            // Act
            AuthPolicy response = handler.handleRequest(request, lambdaContext);

            // Assert
            assertThat(response.getPolicyDocument().getStatement().get(0).getEffect())
                    .isEqualTo("Deny");
            assertThat(response.getPrincipalId())
                    .isEqualTo("anonymous");
            verify(tokenVerifier, never()).verify(anyString());
        }

        @Test
        @DisplayName("Should deny access when verifier throws InvalidTokenException")
        void shouldDenyAccessForInvalidToken() throws Exception {
            // Arrange
            String token = "Bearer malformed.jwt.token";
            APIGatewayCustomAuthorizerRequest request = buildRequest(token);

            when(tokenVerifier.verify("malformed.jwt.token"))
                    .thenThrow(new InvalidTokenException("Signature validation failed"));

            // Act
            AuthPolicy response = handler.handleRequest(request, lambdaContext);

            // Assert
            assertThat(response.getPolicyDocument().getStatement().get(0).getEffect())
                    .isEqualTo("Deny");
            assertThat(response.getPrincipalId()).isEqualTo("anonymous");
        }

        @Test
        @DisplayName("Should log error details when verifier throws unexpected exception")
        void shouldLogUnexpectedException() throws Exception {
            // Arrange
            String token = "Bearer boom.jwt.token";
            APIGatewayCustomAuthorizerRequest request = buildRequest(token);
            RuntimeException fatal = new RuntimeException("Verifier downstream outage");

            when(tokenVerifier.verify("boom.jwt.token")).thenThrow(fatal);

            // Capture logs (using lambda context)
            ArgumentCaptor<String> logCaptor = ArgumentCaptor.forClass(String.class);
            doNothing().when(lambdaContext.getLogger()).log(logCaptor.capture());

            // Act
            AuthPolicy response = handler.handleRequest(request, lambdaContext);

            // Assert
            Assertions.assertThat(response.getPolicyDocument().getStatement().get(0).getEffect())
                    .isEqualTo("Deny");

            // Verify logs contain stack trace
            assertThat(
                    logCaptor.getAllValues().stream().anyMatch(msg -> msg.contains("Verifier downstream outage"))
            ).isTrue();
        }
    }

    // ---------------------------------------------------------------------
    // Helper Methods
    // ---------------------------------------------------------------------

    private static APIGatewayCustomAuthorizerRequest buildRequest(String tokenHeader) {
        APIGatewayCustomAuthorizerRequest request = new APIGatewayCustomAuthorizerRequest();
        request.setAuthorizationToken(tokenHeader);
        request.setMethodArn(EXAMPLE_METHOD_ARN);
        return request;
    }
}
```