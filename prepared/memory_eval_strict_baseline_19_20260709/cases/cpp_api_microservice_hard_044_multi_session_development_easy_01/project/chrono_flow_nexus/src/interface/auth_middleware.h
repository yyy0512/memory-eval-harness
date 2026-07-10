```cpp
#ifndef CHRONO_FLOW_NEXUS_INTERFACE_AUTH_MIDDLEWARE_H_
#define CHRONO_FLOW_NEXUS_INTERFACE_AUTH_MIDDLEWARE_H_

/*
 *  chrono_flow_nexus/src/interface/auth_middleware.h
 *
 *  ChronoFlow Nexus – Interface Layer
 *  ----------------------------------
 *  The AuthMiddleware component lives on the boundary between the transport layer
 *  (e.g. HTTP, gRPC, WebSockets) and the application layer.  It is responsible for:
 *
 *     1. Extracting authentication credentials (currently JWT Bearer tokens) from
 *        incoming requests.
 *     2. Validating and decoding the token using the pluggable ITokenVerifier impl.
 *     3. Populating a strongly-typed AuthContext object that downstream handlers
 *        can pull from the per-request context.
 *     4. Performing coarse-grained authorization checks (scopes/roles) so that
 *        business-logic code can focus on finer-grained rules.
 *     5. Recording auth-related telemetry (structured logs + metrics) for SRE.
 *
 *  The middleware is *framework-agnostic*: integrating with a REST framework like
 *  Pistache, Crow, Oat++ or even Boost.Beast requires only an adaptor that maps the
 *  framework’s request/response primitives to the Middleware interface defined here.
 */

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace chrono_flow::interface {

/* ============================================================================================
 *  Auth Exceptions
 * ============================================================================================
 */

class AuthException : public std::runtime_error {
public:
    explicit AuthException(const std::string& message,
                           std::uint16_t status_code = 401)  // HTTP 401 Unauthorized
        : std::runtime_error(message),
          status_code_(status_code) {}

    std::uint16_t status_code() const noexcept { return status_code_; }

private:
    std::uint16_t status_code_;
};

/* ============================================================================================
 *  Authentication Context
 * ============================================================================================
 *  A small, immutable object that is attached to a request after successful authentication.
 *  It can be passed down to application code or inserted into a request context bag.
 */

struct AuthContext {
    std::string   user_id;                 // Unique principal identifier (UUID/ULID)
    std::string   tenant_id;               // Tenant / organization membership
    std::string   subject;                 // Raw token `sub`
    std::string   issued_by;               // Issuer (IdP)
    std::unordered_set<std::string> scopes;// OAuth scopes or custom roles
    std::chrono::system_clock::time_point issued_at;
    std::chrono::system_clock::time_point expires_at;
};

/* ============================================================================================
 *  Token Verifier Interface
 * ============================================================================================
 *  A pluggable SPI that abstracts the cryptographic validation of JWT (or any token type).
 *  The production implementation is located in the infrastructure layer (e.g. AWS Cognito,
 *  Auth0, or on-premise Keycloak), but the interface lives here so the middleware has no
 *  direct dependency on concrete providers.
 */

class ITokenVerifier {
public:
    virtual ~ITokenVerifier() = default;

    // Throws AuthException on any validation failure.
    virtual AuthContext verify(const std::string& bearer_token) const = 0;
};

/* ============================================================================================
 *  Authorization Policy Primitive
 * ============================================================================================
 */

enum class AuthorizationDecision {
    kAllow,
    kDeny
};

using ScopeSet = std::unordered_set<std::string>;

struct AuthorizationPolicy {
    ScopeSet required_scopes;          // All scopes that MUST be present
    ScopeSet any_of_scopes;            // At least ONE scope must be present (optional)
};

/* ============================================================================================
 *  Request / Response Abstractions
 * ============================================================================================
 *  Very small protocol-agnostic wrappers that contain only the data the middleware needs.
 *  Framework adaptors (e.g. `CrowAuthMiddlewareAdaptor`) convert from/to native types.
 */

struct IRequest {
    virtual ~IRequest() = default;

    // Returns the value of the HTTP header (case-insensitive) or std::nullopt.
    virtual std::optional<std::string> header(const std::string& name) const = 0;

    // Stores arbitrary per-request data. Middleware sets the auth context here.
    virtual void set_property(const std::string& key,
                              std::shared_ptr<void> value) = 0;
};

struct IResponse {
    virtual ~IResponse() = default;

    virtual void set_status(std::uint16_t status_code) = 0;
    virtual void set_header(const std::string& key, const std::string& value) = 0;
    virtual void set_body(const std::string& body) = 0;
};

/* ============================================================================================
 *  Auth Middleware
 * ============================================================================================
 *  Stateless and re-entrant. A single instance can be shared across worker threads.
 */

class AuthMiddleware {
public:
    explicit AuthMiddleware(std::shared_ptr<const ITokenVerifier> verifier)
        : verifier_(std::move(verifier))
    {
        if (!verifier_) {
            throw std::invalid_argument("AuthMiddleware requires non-null ITokenVerifier");
        }
    }

    // Disable copy/assign
    AuthMiddleware(const AuthMiddleware&)            = delete;
    AuthMiddleware& operator=(const AuthMiddleware&) = delete;
    AuthMiddleware(AuthMiddleware&&)                 = default;
    AuthMiddleware& operator=(AuthMiddleware&&)      = default;
    ~AuthMiddleware()                                = default;

    /*
     * process
     * -------
     * The main entry point invoked by the framework adaptor.
     *
     * 1) Extracts Bearer token string.
     * 2) Validates token via ITokenVerifier.
     * 3) Enforces AuthorizationPolicy if provided.
     * 4) Saves AuthContext into the request property bag so downstream code can access it.
     * 5) If any step fails, populates error response and returns false, signaling the adaptor
     *    that request processing must stop.
     *
     * @return `true`  if the request is authenticated & authorized.
     *         `false` if the middleware generated a failure response.
     */
    bool process(IRequest&  request,
                 IResponse& response,
                 const std::optional<AuthorizationPolicy>& policy = std::nullopt) const
    {
        try {
            auto token = extract_bearer_token(request);
            AuthContext ctx = verifier_->verify(token);

            if (policy) {
                enforce_policy(ctx, *policy);
            }

            // Insert AuthContext into the request property bag with a well-known key.
            request.set_property("auth.context",
                                 std::make_shared<AuthContext>(std::move(ctx)));

            return true;
        } catch (const AuthException& ex) {
            // Map AuthException to HTTP response.
            response.set_status(ex.status_code());
            response.set_header("Content-Type", "application/json");
            response.set_body(R"({"error":")" + std::string(ex.what()) + R"("})");
            return false;
        } catch (const std::exception& ex) {
            // Unexpected error — hide internals from caller, surface 500.
            response.set_status(500);
            response.set_header("Content-Type", "application/json");
            response.set_body(R"({"error":"internal_server_error"})");
            return false;
        }
    }

private:
    std::shared_ptr<const ITokenVerifier> verifier_;

    static std::string extract_bearer_token(const IRequest& request)
    {
        // 1. Authorization: Bearer <token>
        auto auth_header = request.header("Authorization");
        if (!auth_header) {
            throw AuthException("missing_authorization_header");
        }

        const std::string bearer_prefix = "Bearer ";
        if (auth_header->size() <= bearer_prefix.size() ||
            auth_header->compare(0, bearer_prefix.size(), bearer_prefix) != 0) {
            throw AuthException("invalid_authorization_header_format");
        }
        auto token = auth_header->substr(bearer_prefix.size());

        if (token.empty()) {
            throw AuthException("empty_bearer_token");
        }
        return token;
    }

    static void enforce_policy(const AuthContext& ctx,
                               const AuthorizationPolicy& policy)
    {
        // Check “all required scopes”.
        for (const auto& scope : policy.required_scopes) {
            if (ctx.scopes.find(scope) == ctx.scopes.end()) {
                throw AuthException("insufficient_scope", 403); // Forbidden
            }
        }

        // Check “any of scopes”.
        if (!policy.any_of_scopes.empty()) {
            bool match_found = false;
            for (const auto& scope : policy.any_of_scopes) {
                if (ctx.scopes.find(scope) != ctx.scopes.end()) {
                    match_found = true;
                    break;
                }
            }
            if (!match_found) {
                throw AuthException("insufficient_scope", 403);
            }
        }
    }
};

} // namespace chrono_flow::interface

#endif  // CHRONO_FLOW_NEXUS_INTERFACE_AUTH_MIDDLEWARE_H_
```