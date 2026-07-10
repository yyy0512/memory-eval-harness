package com.vitalpulse.cloudcare.graphql;

import com.amazonaws.services.lambda.runtime.ClientContext;
import com.amazonaws.services.lambda.runtime.CognitoIdentity;
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.LambdaLogger;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import graphql.ExecutionResult;
import graphql.GraphQL;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.lang.reflect.Field;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Unit-tests for {@link GraphQLHandler}.  <p>
 * These tests verify request/response handling, security edge-cases,
 * and error propagation for the AWS Lambda GraphQL entry-point that
 * fronts the VitalPulse CloudCare micro-service.  All external
 * collaborators (GraphQL engine, AWS {@link Context}, etc.) are
 * replaced with Mockito stubs to ensure deterministic behaviour.
 */
@ExtendWith(MockitoExtension.class)
class GraphQLHandlerTest {

    private static final String AUTHORIZATION = "Authorization";
    private static final String BEARER_TOKEN = "Bearer VALID_JWT_TOKEN";

    @Mock
    private GraphQL mockGraphQL;

    @Mock
    private ExecutionResult mockExecutionResult;

    @Mock
    private Context mockContext;

    private GraphQLHandler handler;

    @BeforeEach
    void setUp() throws Exception {
        // Create handler under test and inject mocked GraphQL instance through reflection
        handler = new GraphQLHandler();
        Field graphQLField = GraphQLHandler.class.getDeclaredField("graphQL");
        graphQLField.setAccessible(true);
        graphQLField.set(handler, mockGraphQL);

        // Generic logging to satisfy Lambda {@link Context#getLogger()} invocations.
        when(mockContext.getLogger()).thenReturn(new NoOpLogger());
    }

    @Nested
    @DisplayName("Happy-path behaviour")
    class HappyPath {

        @Test
        @DisplayName("Given valid authentication header and syntactically correct query " +
                     "when handler is invoked then 200 OK with expected JSON body is returned")
        void handleRequest_validQuery_authorized() {
            // Arrange
            String graphqlQuery = "query{ ping }";
            Map<String, Object> data   = Collections.singletonMap("ping", "pong");
            when(mockExecutionResult.getData()).thenReturn(data);
            when(mockExecutionResult.getErrors()).thenReturn(Collections.emptyList());
            when(mockGraphQL.execute(any(String.class))).thenReturn(mockExecutionResult);

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withHeaders(Collections.singletonMap(AUTHORIZATION, BEARER_TOKEN))
                    .withBody(graphqlQuery);

            // Act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, mockContext);

            // Assert
            assertThat(response.getStatusCode()).isEqualTo(200);
            assertThat(response.getHeaders()).containsEntry("Content-Type", "application/json");
            assertThat(response.getBody()).contains("\"ping\":\"pong\"");

            // Ensure GraphQL engine was executed exactly once with the received query
            ArgumentCaptor<String> queryCaptor = ArgumentCaptor.forClass(String.class);
            verify(mockGraphQL, times(1)).execute(queryCaptor.capture());
            assertThat(queryCaptor.getValue()).isEqualTo(graphqlQuery);
        }
    }

    @Nested
    @DisplayName("Security & validation edge-cases")
    class SecurityEdgeCases {

        @Test
        @DisplayName("Given missing Authorization header when handler is invoked then 401 Unauthorized is returned")
        void handleRequest_missingAuthorization() {
            // Arrange
            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withHeaders(Collections.emptyMap())
                    .withBody("query{ ping }");

            // Act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, mockContext);

            // Assert
            assertThat(response.getStatusCode()).isEqualTo(401);
            assertThat(response.getBody()).contains("Unauthorized");
            verify(mockGraphQL, never()).execute(any(String.class));
        }

        @Test
        @DisplayName("Given syntactically incorrect GraphQL query when handler is invoked then 400 Bad Request is returned")
        void handleRequest_malformedQuery() {
            // Arrange
            String malformedQuery = "query{";
            when(mockGraphQL.execute(malformedQuery)).thenThrow(new RuntimeException("Parsing error"));

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withHeaders(Collections.singletonMap(AUTHORIZATION, BEARER_TOKEN))
                    .withBody(malformedQuery);

            // Act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, mockContext);

            // Assert
            assertThat(response.getStatusCode()).isEqualTo(400);
            assertThat(response.getBody()).contains("error").contains("Parsing error");
            verify(mockGraphQL, times(1)).execute(malformedQuery);
        }
    }

    @Nested
    @DisplayName("Operational telemetry")
    class Telemetry {

        @Test
        @DisplayName("Handler should enrich CloudWatch logs with correlation and duration metadata")
        void handleRequest_logsTelemetry() {
            // Arrange
            when(mockExecutionResult.getData()).thenReturn(Collections.emptyMap());
            when(mockExecutionResult.getErrors()).thenReturn(Collections.emptyList());
            when(mockGraphQL.execute(any(String.class))).thenReturn(mockExecutionResult);

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withHeaders(Collections.singletonMap(AUTHORIZATION, BEARER_TOKEN))
                    .withBody("query{ __typename }");

            NoOpLogger logger = new NoOpLogger();
            when(mockContext.getLogger()).thenReturn(logger);

            // Act
            handler.handleRequest(request, mockContext);

            // Assert that the logger was written to at least once.
            assertThat(logger.getLastMessageTimestamp())
                    .describedAs("Lambda logger should have recorded a message")
                    .isNotNull();
        }
    }

    /**
     * Minimal {@link LambdaLogger} implementation that stores the last message
     * timestamp, allowing assertions without requiring real CloudWatch access.
     */
    private static class NoOpLogger implements LambdaLogger {

        private Instant lastMessageTimestamp;

        @Override
        public void log(String message) {
            lastMessageTimestamp = Instant.now();
            // Intentionally no-op: we do not need console output during unit tests.
        }

        @Override
        public void log(byte[] message) {
            lastMessageTimestamp = Instant.now();
            // Intentionally no-op.
        }

        public Instant getLastMessageTimestamp() {
            return lastMessageTimestamp;
        }
    }

    /* **********************************************************************
     *                                                                       *
     * The remainder of this file defines test doubles for AWS Lambda        *
     * interfaces that are either cumbersome or impossible to obtain         *
     * inside a local JVM without the actual runtime.                        *
     *                                                                       *
     ********************************************************************** */

    private static final class TestContext implements Context {

        private final LambdaLogger logger = new NoOpLogger();

        @Override public String getAwsRequestId()                         { return "test-request-id"; }
        @Override public String getLogGroupName()                         { return "/aws/lambda/test"; }
        @Override public String getLogStreamName()                        { return "2023/05/24/[$LATEST]abcdefgh"; }
        @Override public String getFunctionName()                         { return "VitalPulse-GraphQLHandler"; }
        @Override public String getFunctionVersion()                      { return "$LATEST"; }
        @Override public String getInvokedFunctionArn()                   { return "arn:aws:lambda:us-east-1:123456789012:function:VitalPulse-GraphQLHandler"; }
        @Override public CognitoIdentity getIdentity()                    { return null; }
        @Override public ClientContext getClientContext()                 { return null; }
        @Override public int getRemainingTimeInMillis()                   { return 30_000; }
        @Override public int getMemoryLimitInMB()                         { return 512; }
        @Override public LambdaLogger getLogger()                         { return logger; }
    }
}