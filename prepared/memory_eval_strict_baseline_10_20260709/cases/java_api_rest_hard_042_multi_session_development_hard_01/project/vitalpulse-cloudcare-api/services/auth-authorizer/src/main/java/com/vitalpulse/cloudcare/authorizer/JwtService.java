package com.vitalpulse.cloudcare.authorizer;

import com.auth0.jwk.Jwk;
import com.auth0.jwk.JwkProvider;
import com.auth0.jwk.JwkProviderBuilder;
import com.auth0.jwk.SigningKeyNotFoundException;
import com.auth0.jwt.JWT;
import com.auth0.jwt.JWTVerifier;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.exceptions.JWTDecodeException;
import com.auth0.jwt.exceptions.JWTVerificationException;
import com.auth0.jwt.interfaces.DecodedJWT;
import com.auth0.jwt.interfaces.RSAKeyProvider;

import java.net.URL;
import java.security.interfaces.RSAPublicKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.*;

/**
 * JwtService is responsible for validating inbound OAuth2 / OIDC access tokens
 * that secure VitalPulse CloudCare endpoints.  Validation is performed against
 * a remote JWKS (JSON Web Key Set) endpoint—typically an AWS Cognito or Okta
 * tenant—and enforces issuer, audience, expiration, and signature requirements.
 *
 * Thread-safe and suitable for use within AWS Lambda execution environments
 * where a single instance may serve thousands of subsequent invocations.
 *
 * Example usage (inside a Lambda authorizer):
 *
 * <pre>{@code
 *     JwtService jwtService = JwtService.defaultFor(
 *          new URL(System.getenv("JWKS_URL")),
 *          System.getenv("OIDC_ISSUER"),
 *          System.getenv("OIDC_AUDIENCE"));
 *
 *     DecodedJWT jwt = jwtService.authenticate(event.getBearerToken());
 * }</pre>
 */
public class JwtService {

    // ---------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------

    private static final String BEARER_PREFIX = "Bearer ";
    private static final Duration DEFAULT_JWKS_CACHE_TTL = Duration.ofMinutes(5);
    private static final int DEFAULT_JWKS_CACHE_SIZE = 10;
    private static final Duration DEFAULT_JWKS_HTTP_TIMEOUT = Duration.ofSeconds(2);

    // ---------------------------------------------------------------------------------------
    // Instance state
    // ---------------------------------------------------------------------------------------

    private final String expectedIssuer;
    private final String expectedAudience;
    private final JWTVerifier verifier;

    // ---------------------------------------------------------------------------------------
    // Factory methods
    // ---------------------------------------------------------------------------------------

    /**
     * Creates a JwtService instance using recommended default cache configuration.
     */
    public static JwtService defaultFor(URL jwksUrl,
                                        String expectedIssuer,
                                        String expectedAudience) {

        Objects.requireNonNull(jwksUrl, "jwksUrl");
        Objects.requireNonNull(expectedIssuer, "expectedIssuer");
        Objects.requireNonNull(expectedAudience, "expectedAudience");

        JwkProvider provider = new JwkProviderBuilder(jwksUrl)
                .cached(DEFAULT_JWKS_CACHE_SIZE, DEFAULT_JWKS_CACHE_TTL) // sized + expiring cache
                .timeout(DEFAULT_JWKS_HTTP_TIMEOUT)                       // outbound HTTP timeout
                .build();

        return new JwtService(provider, expectedIssuer, expectedAudience);
    }

    // ---------------------------------------------------------------------------------------
    // Constructors
    // ---------------------------------------------------------------------------------------

    /**
     * Creates a JwtService with a caller-supplied JwkProvider.  The provider can be
     * wrapped with custom caching, tracing, or audit logging logic as needed.
     */
    public JwtService(JwkProvider jwkProvider,
                      String expectedIssuer,
                      String expectedAudience) {

        this.expectedIssuer = expectedIssuer;
        this.expectedAudience = expectedAudience;

        RSAKeyProvider keyProvider = new CachingRsaKeyProvider(jwkProvider);

        Algorithm algorithm = Algorithm.RSA256(keyProvider);
        this.verifier = JWT.require(algorithm)
                           .withIssuer(expectedIssuer)
                           .withAudience(expectedAudience)
                           .acceptLeeway(2) // allow small clock skew
                           .build();
    }

    // ---------------------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------------------

    /**
     * Validates the supplied bearer token and returns a decoded, verified JWT.
     *
     * @param bearerToken The Authorization header value (e.g. "Bearer abc.def.ghi")
     * @return Verified DecodedJWT
     * @throws TokenValidationException when token is missing, malformed, or fails any verification step.
     */
    public DecodedJWT authenticate(String bearerToken) {
        String compactToken = sanitize(bearerToken);

        try {
            DecodedJWT jwt = verifier.verify(compactToken);
            trackTokenAge(jwt);
            return jwt;
        } catch (JWTVerificationException | SigningKeyNotFoundException e) {
            throw new TokenValidationException("Token verification failed: " + e.getMessage(), e);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    /**
     * Removes the "Bearer " prefix (if present) and basic null/blank checking.
     */
    private String sanitize(String bearerToken) {
        if (bearerToken == null || bearerToken.trim().isEmpty()) {
            throw new TokenValidationException("Missing bearer token");
        }

        String value = bearerToken.trim();
        if (value.startsWith(BEARER_PREFIX)) {
            value = value.substring(BEARER_PREFIX.length());
        }

        if (value.split("\\.").length != 3) {
            throw new TokenValidationException("JWT is not in compact form");
        }
        return value;
    }

    /**
     * Emits CloudWatch metric for token age in seconds.  This telemetry helps detect
     * replay or excessive clock skew issues across distributed devices.
     *
     * NOTE: Metric publishing is performed asynchronously to avoid impacting latency.
     */
    private void trackTokenAge(DecodedJWT jwt) {
        try {
            long ageSeconds = Instant.now().getEpochSecond() - jwt.getIssuedAt().toInstant().getEpochSecond();
            TokenAgeMetricsPublisher.publish(ageSeconds);
        } catch (Exception ignore) {
            // Non-fatal: do not block customer traffic if metrics fail
        }
    }

    // ---------------------------------------------------------------------------------------
    // Inner classes
    // ---------------------------------------------------------------------------------------

    /**
     * RSAKeyProvider that wraps a JwkProvider and adds an in-memory TTL cache
     * so we do not hit the provider (network) for every verification.
     */
    private static class CachingRsaKeyProvider implements RSAKeyProvider {

        private final JwkProvider delegate;
        private final ConcurrentMap<String, TimedKey> cache = new ConcurrentHashMap<>();
        private final Duration ttl = DEFAULT_JWKS_CACHE_TTL;

        CachingRsaKeyProvider(JwkProvider delegate) {
            this.delegate = delegate;
        }

        @Override
        public RSAPublicKey getPublicKeyById(String kid) {
            try {
                TimedKey entry = cache.compute(kid, (keyId, existing) -> {
                    if (existing == null || existing.isExpired()) {
                        return fetchAndWrap(keyId);
                    }
                    return existing;
                });
                return entry.key;
            } catch (SigningKeyNotFoundException e) {
                throw e; // Let upstream convert to JWTVerificationException
            } catch (Exception e) {
                throw new SigningKeyNotFoundException("Unable to obtain RSA key", e);
            }
        }

        @Override
        public RSAPublicKey getPublicKey() {
            // Not used – we always resolve by kid
            return null;
        }

        @Override
        public String getPrivateKeyId() {
            // Not needed for verification only
            return null;
        }

        @Override
        public java.security.interfaces.RSAPrivateKey getPrivateKey() {
            return null;
        }

        private TimedKey fetchAndWrap(String kid) {
            try {
                Jwk jwk = delegate.get(kid);
                RSAPublicKey pub = (RSAPublicKey) jwk.getPublicKey();
                return new TimedKey(pub, Instant.now().plus(ttl));
            } catch (Exception e) {
                throw new SigningKeyNotFoundException("Failed to download JWK", e);
            }
        }

        /** simple value object with TTL */
        private static final class TimedKey {
            final RSAPublicKey key;
            final Instant expiresAt;

            TimedKey(RSAPublicKey key, Instant expiresAt) {
                this.key = key;
                this.expiresAt = expiresAt;
            }

            boolean isExpired() {
                return Instant.now().isAfter(expiresAt);
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // Custom Exception
    // ---------------------------------------------------------------------------------------

    /**
     * Wrapper exception used throughout the platform so callers do not need to
     * leak library-specific classes (Auth0).  Safe to bubble all the way to the
     * API Gateway Lambda authorizer which converts it to 401/403 responses.
     */
    public static class TokenValidationException extends RuntimeException {
        public TokenValidationException(String message) { super(message); }
        public TokenValidationException(String message, Throwable cause) { super(message, cause); }
    }

    // ---------------------------------------------------------------------------------------
    // Metrics publisher placeholder
    // ---------------------------------------------------------------------------------------

    /**
     * Lightweight abstraction for CloudWatch metrics emission.  In production this
     * would delegate to AWS SDK v2 CloudWatch client or an internal shared library.
     * To keep the example self-contained we simply enqueue the metric.
     */
    private static final class TokenAgeMetricsPublisher {

        private static final ExecutorService EXECUTOR =
                Executors.newSingleThreadExecutor(r -> {
                    Thread t = new Thread(r, "token-age-metrics-publisher");
                    t.setDaemon(true);
                    return t;
                });

        static void publish(long ageSeconds) {
            EXECUTOR.submit(() -> {
                // TODO: replace with real CloudWatch PutMetricData call
                System.out.println("DEBUG Metric TokenAgeSeconds=" + ageSeconds);
            });
        }
    }
}