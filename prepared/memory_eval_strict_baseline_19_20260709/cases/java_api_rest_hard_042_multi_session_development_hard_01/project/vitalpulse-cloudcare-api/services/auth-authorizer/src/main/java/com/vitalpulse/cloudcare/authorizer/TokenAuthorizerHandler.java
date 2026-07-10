package com.vitalpulse.cloudcare.authorizer;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayCustomAuthorizerRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayCustomAuthorizerResponse;
import com.amazonaws.services.lambda.runtime.events.IamPolicyResponse;
import com.amazonaws.services.lambda.runtime.events.IamPolicyResponse.IamPolicy;
import com.amazonaws.services.lambda.runtime.events.IamPolicyResponse.IamPolicy.Statement;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.interfaces.RSAPublicKey;
import java.text.ParseException;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * AWS Lambda Custom Authorizer that validates OAuth2 / SMART-on-FHIR JWT access tokens and returns
 * an IAM policy granting/denying access to API Gateway resources.
 *
 * Environment variables:
 *   JWKS_URL  - HTTPS URL pointing to the Identity Provider's JWKS endpoint
 *   AUDIENCE  - Expected audience claim (comma-separated list)
 *   ISSUER    - Expected issuer claim
 *
 * The handler caches JWKS for {@link #CACHE_TTL} to avoid excessive network traffic.
 */
public class TokenAuthorizerHandler
        implements RequestHandler<APIGatewayCustomAuthorizerRequestEvent, APIGatewayCustomAuthorizerResponse> {

    private static final String ENV_JWKS_URL = "JWKS_URL";
    private static final String ENV_AUDIENCE = "AUDIENCE";
    private static final String ENV_ISSUER   = "ISSUER";

    private static final Duration CACHE_TTL = Duration.ofMinutes(10);

    private static final JwksCache JWKS_CACHE = new JwksCache();

    @Override
    public APIGatewayCustomAuthorizerResponse handleRequest(
            final APIGatewayCustomAuthorizerRequestEvent request, final Context context) {

        final String methodArn = request.getMethodArn();

        try {
            String authorizationHeader = Optional.ofNullable(request.getHeaders())
                                                 .map(h -> h.get("Authorization"))
                                                 .orElse(null);

            if (authorizationHeader == null || !authorizationHeader.startsWith("Bearer ")) {
                return deny("anonymous", methodArn, "Missing or invalid Authorization header");
            }

            String token = authorizationHeader.substring("Bearer ".length()).trim();
            SignedJWT jwt = SignedJWT.parse(token);

            validateSignature(jwt);
            validateClaims(jwt);

            // Compute allowed/denied based on scopes & request resource
            Set<String> tokenScopes = getScopes(jwt);
            String requiredScope    = ScopeResolver.resolveRequiredScope(request);

            if (!tokenScopes.contains(requiredScope)) {
                return deny(getSubject(jwt), methodArn,
                        String.format("Scope '%s' is required but token contains %s", requiredScope, tokenScopes));
            }

            return allow(getSubject(jwt), methodArn, buildContext(jwt));

        } catch (ParseException | SecurityException e) {
            return deny("anonymous", methodArn, "Token parse error: " + e.getMessage());
        } catch (IOException | JOSEException e) {
            return deny("anonymous", methodArn, "Token verification error: " + e.getMessage());
        } catch (Exception e) {
            return deny("anonymous", methodArn, "Unexpected error: " + e.getMessage());
        }
    }

    /* ---------------------------------------------------------------------- */
    /* ---------------------------  Validation  ----------------------------- */
    /* ---------------------------------------------------------------------- */

    private void validateSignature(SignedJWT jwt) throws IOException, JOSEException, ParseException {
        JWSHeader header = jwt.getHeader();
        String kid       = header.getKeyID();
        if (kid == null) {
            throw new SecurityException("Missing kid header");
        }

        JWKSet jwkSet   = JWKS_CACHE.getOrLoad(getJwksUrl());
        JWK jwk         = jwkSet.getKeyByKeyId(kid);
        if (jwk == null || !(jwk instanceof RSAKey)) {
            throw new SecurityException("Unable to find RSA key with kid=" + kid);
        }

        RSAPublicKey publicKey = ((RSAKey) jwk).toRSAPublicKey();
        RSASSAVerifier verifier = new RSASSAVerifier(publicKey, Collections.singleton(JWSAlgorithm.RS256));

        if (!jwt.verify(verifier)) {
            throw new SecurityException("JWT signature verification failed");
        }
    }

    private void validateClaims(SignedJWT jwt) throws ParseException {
        String expectedIssuer = getRequiredEnv(ENV_ISSUER);
        Set<String> expectedAudiences = new HashSet<>(Arrays.asList(getRequiredEnv(ENV_AUDIENCE).split(",")));

        String issuer  = jwt.getJWTClaimsSet().getIssuer();
        List<String> aud = jwt.getJWTClaimsSet().getAudience();

        if (!expectedIssuer.equals(issuer)) {
            throw new SecurityException("Invalid issuer: " + issuer);
        }

        if (aud == null || aud.stream().noneMatch(expectedAudiences::contains)) {
            throw new SecurityException("Invalid audience: " + aud);
        }

        Date exp = jwt.getJWTClaimsSet().getExpirationTime();
        if (exp == null || exp.before(new Date())) {
            throw new SecurityException("Token is expired");
        }
    }

    private Set<String> getScopes(SignedJWT jwt) throws ParseException {
        Object scopeClaim = jwt.getJWTClaimsSet().getClaim("scope");
        if (scopeClaim == null) {
            return Collections.emptySet();
        }
        if (scopeClaim instanceof String) {
            return new HashSet<>(Arrays.asList(((String) scopeClaim).split(" ")));
        }
        if (scopeClaim instanceof Collection) {
            //noinspection unchecked
            return new HashSet<>((Collection<String>) scopeClaim);
        }
        return Collections.emptySet();
    }

    private String getSubject(SignedJWT jwt) throws ParseException {
        return Optional.ofNullable(jwt.getJWTClaimsSet().getSubject()).orElse("unknown");
    }

    /* ---------------------------------------------------------------------- */
    /* ------------------------  Utility Builders  -------------------------- */
    /* ---------------------------------------------------------------------- */

    private APIGatewayCustomAuthorizerResponse allow(String principalId, String methodArn, Map<String, String> context) {
        return buildPolicy(principalId, "Allow", methodArn, context);
    }

    private APIGatewayCustomAuthorizerResponse deny(String principalId, String methodArn, String reason) {
        Map<String, String> ctx = new HashMap<>();
        ctx.put("error", reason);
        return buildPolicy(principalId, "Deny", methodArn, ctx);
    }

    private APIGatewayCustomAuthorizerResponse buildPolicy(
            String principalId, String effect, String methodArn, Map<String, String> context) {

        IamPolicy policy = IamPolicy.builder()
                .withVersion("2012-10-17")
                .withStatement(Collections.singletonList(
                        Statement.builder()
                                .withAction("execute-api:Invoke")
                                .withEffect(effect)
                                .withResource(Collections.singletonList(methodArn))
                                .build()))
                .build();

        return APIGatewayCustomAuthorizerResponse.builder()
                .withPrincipalId(principalId)
                .withPolicyDocument(policy)
                .withContext(context)
                .build();
    }

    private Map<String, String> buildContext(SignedJWT jwt) throws ParseException {
        Map<String, String> ctx = new HashMap<>();
        ctx.put("sub", getSubject(jwt));
        ctx.put("tenant", String.valueOf(jwt.getJWTClaimsSet().getClaim("tenant_id")));
        ctx.put("scp", String.join(" ", getScopes(jwt)));
        return ctx;
    }

    /* ---------------------------------------------------------------------- */
    /* ------------------------------  Helpers  ----------------------------- */
    /* ---------------------------------------------------------------------- */

    private String getJwksUrl() {
        return getRequiredEnv(ENV_JWKS_URL);
    }

    private String getRequiredEnv(String key) {
        String value = System.getenv(key);
        if (value == null || value.isEmpty()) {
            throw new IllegalStateException("Environment variable " + key + " is not set");
        }
        return value;
    }

    /* ---------------------------------------------------------------------- */
    /* ----------------------------  JWKS Cache  ---------------------------- */
    /* ---------------------------------------------------------------------- */

    /**
     * Thread-safe in-memory JWKS cache with TTL. Suitable for low-volume authorizer invocations.
     */
    private static final class JwksCache {

        private final Map<String, Entry> cache = new ConcurrentHashMap<>();

        public JWKSet getOrLoad(String url) throws IOException {
            Entry entry = cache.get(url);
            if (entry != null && !entry.isExpired()) {
                return entry.jwkSet;
            }

            synchronized (this) {
                // Double-check after acquiring lock
                entry = cache.get(url);
                if (entry != null && !entry.isExpired()) {
                    return entry.jwkSet;
                }
                JWKSet fresh = fetchJwks(url);
                cache.put(url, new Entry(fresh));
                return fresh;
            }
        }

        private JWKSet fetchJwks(String url) throws IOException {
            try (InputStream in = new URL(url).openStream()) {
                return JWKSet.load(in);
            } catch (ParseException e) {
                throw new IOException("Unable to parse JWKS from " + url, e);
            }
        }

        private static final class Entry {
            private final JWKSet jwkSet;
            private final Instant loadedAt = Instant.now();

            private Entry(JWKSet jwkSet) {
                this.jwkSet = jwkSet;
            }

            private boolean isExpired() {
                return loadedAt.plus(CACHE_TTL).isBefore(Instant.now());
            }
        }
    }

    /* ---------------------------------------------------------------------- */
    /* ------------------------  Scope Resolution  -------------------------- */
    /* ---------------------------------------------------------------------- */

    /**
     * Translates API Gateway methodArn to FHIR scope required by the endpoint.
     * This implementation is intentionally simple; in real life you may load
     * configuration from an external source or API Gateway authorizer context.
     */
    private static final class ScopeResolver {

        private static final Map<String, String> PATH_SCOPE_MAP = init();

        private static Map<String, String> init() {
            Map<String, String> map = new HashMap<>();
            map.put("/v1/patients", "patient/*.read");
            map.put("/v1/patients/*/medications", "patient/MedicationRequest.read");
            map.put("/v1/telemetry", "user/Observation.write");
            map.put("/v1/orders", "user/ServiceRequest.write");
            return map;
        }

        static String resolveRequiredScope(APIGatewayCustomAuthorizerRequestEvent request) {
            String path = Optional.ofNullable(request.getPath())
                                  .orElse("");
            return PATH_SCOPE_MAP.entrySet()
                    .stream()
                    .filter(e -> match(e.getKey(), path))
                    .map(Map.Entry::getValue)
                    .findFirst()
                    .orElse("openid"); // fallback to most harmless
        }

        private static boolean match(String pattern, String path) {
            // Tiny glob-like matcher: * matches segment
            String[] pParts = pattern.split("/");
            String[] aParts = path.split("/");

            if (pParts.length != aParts.length) {
                return false;
            }
            for (int i = 0; i < pParts.length; i++) {
                if ("*".equals(pParts[i])) {
                    continue;
                }
                if (!pParts[i].equals(aParts[i])) {
                    return false;
                }
            }
            return true;
        }
    }
}