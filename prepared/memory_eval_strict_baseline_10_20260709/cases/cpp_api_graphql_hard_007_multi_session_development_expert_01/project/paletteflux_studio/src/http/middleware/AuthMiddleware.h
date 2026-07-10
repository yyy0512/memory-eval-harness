#ifndef PALETTEFLUX_STUDIO_HTTP_MIDDLEWARE_AUTHMIDDLEWARE_H
#define PALETTEFLUX_STUDIO_HTTP_MIDDLEWARE_AUTHMIDDLEWARE_H

/*
 * PaletteFlux GraphQL Studio
 * File: AuthMiddleware.h
 *
 * Description:
 *  HTTP-layer middleware responsible for authenticating inbound requests.
 *  Supports JWT (Bearer) and static API-Key authentication schemes.
 *
 *  On success, a strongly-typed `UserClaims` object is injected into the
 *  request’s attribute map under the key “security.principal”.
 *
 *  On failure, the middleware aborts the pipeline, builds a JSON error
 *  payload, and returns HTTP 401/403 codes as appropriate.
 *
 *  Notes:
 *  - This file purposefully remains header-only to simplify dependency
 *    graphing for microservice packaging (single TU import is common).
 *  - Production deployments should wire the declarations below against
 *    concrete, crypto-backed `TokenVerifier` and persistent
 *    `ApiKeyRepository` implementations via DI wiring.
 */

#include <any>
#include <chrono>
#include <cstdint>
#include <exception>
#include <functional>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace paletteflux::security {

/* **********************************************************************
 *  UserClaims – model for authenticated identity
 * *********************************************************************/

struct UserClaims
{
    std::string                        sub;        // Subject / user identifier
    std::string                        role;       // Role / scope string
    std::chrono::system_clock::time_point expiresAt;
    std::unordered_map<std::string, std::string> custom;

    bool isExpired(std::chrono::seconds skew = std::chrono::seconds{0}) const noexcept
    {
        return std::chrono::system_clock::now() - skew > expiresAt;
    }
};

/* **********************************************************************
 *  TokenVerifier – pluggable strategy for verifying JWTs or similar
 * *********************************************************************/

class TokenVerifier
{
public:
    virtual ~TokenVerifier() = default;

    // Returns populated claims on success, std::nullopt otherwise
    virtual std::optional<UserClaims>
    verify(std::string_view token,
           std::chrono::seconds       leeway) const = 0;
};

/* **********************************************************************
 *  ApiKeyRepository – lookup interface for static API keys
 * *********************************************************************/

class ApiKeyRepository
{
public:
    virtual ~ApiKeyRepository() = default;

    // Returns associated claims (user record) when key is valid
    virtual std::optional<UserClaims>
    lookup(std::string_view apiKey) const = 0;
};

}   // namespace paletteflux::security

/* **********************************************************************
 *  Lightweight HTTP facade
 *
 *  These are intentionally minimal to keep the header self-contained.
 *  In production they would map to the actual framework’s Request /
 *  Response classes (e.g., Boost.Beast, Crow, Pistache, etc.).
 * *********************************************************************/

namespace paletteflux::http {

class Request
{
public:
    // Access raw header (returns empty string if missing)
    std::string header(const std::string& key) const
    {
        auto it = headers_.find(key);
        return it == headers_.end() ? "" : it->second;
    }

    // Attribute bag: stores arbitrary per-request data
    void setAttribute(std::string key, std::any value) { attributes_[std::move(key)] = std::move(value); }

    template<typename T>
    std::optional<T> attribute(const std::string& key) const
    {
        auto it = attributes_.find(key);
        if (it == attributes_.end()) return std::nullopt;
        try
        {
            return std::any_cast<T>(it->second);
        }
        catch (const std::bad_any_cast&)
        {
            return std::nullopt;
        }
    }

    // Mutators for test harness / stub wiring
    void _setHeader(std::string key, std::string value) { headers_[std::move(key)] = std::move(value); }

private:
    std::unordered_map<std::string, std::string> headers_;
    std::unordered_map<std::string, std::any>    attributes_;
};

class Response
{
public:
    void setStatus(int code) { statusCode_ = code; }
    void setHeader(std::string key, std::string value) { headers_[std::move(key)] = std::move(value); }
    void writeJson(std::string body) { body_ = std::move(body); contentType_ = "application/json"; }

    // Test helpers
    int                                _statusCode() const { return statusCode_; }
    const std::unordered_map<std::string, std::string>& _headers() const { return headers_; }
    const std::string&                 _body() const { return body_; }

private:
    int                                statusCode_{200};
    std::unordered_map<std::string, std::string> headers_;
    std::string                        contentType_{"text/plain"};
    std::string                        body_;
};

}   // namespace paletteflux::http

/* **********************************************************************
 *  AuthMiddleware – main implementation
 * *********************************************************************/

namespace paletteflux::http::middleware {

using security::ApiKeyRepository;
using security::TokenVerifier;
using security::UserClaims;
using http::Request;
using http::Response;

class AuthMiddleware final
{
public:
    // -----------------------------------------------------------------
    // Configuration model
    // -----------------------------------------------------------------
    struct Config
    {
        std::string              issuer;
        std::string              audience;
        std::chrono::seconds     leeway{std::chrono::seconds{60}};
        std::vector<std::string> acceptedSchemes{"Bearer", "PF-ApiKey"};

        // Whether anonymous requests are allowed to continue the chain.
        bool                     allowAnonymous{false};
    };

    // -----------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------
    AuthMiddleware(Config                                      cfg,
                   std::shared_ptr<TokenVerifier>              verifier,
                   std::shared_ptr<ApiKeyRepository>           apiKeys)
        : cfg_(std::move(cfg)),
          verifier_(std::move(verifier)),
          apiKeys_(std::move(apiKeys))
    {
        if (!verifier_ && !apiKeys_)
            throw std::invalid_argument(
                "AuthMiddleware requires at least one verification strategy");
    }

    // -----------------------------------------------------------------
    // The middleware operator
    // -----------------------------------------------------------------
    void operator()(Request&                      req,
                    Response&                     res,
                    const std::function<void()>&  next) const
    {
        try
        {
            auto authHeader = req.header("Authorization");

            if (authHeader.empty())
            {
                if (cfg_.allowAnonymous)
                {
                    next();
                    return;
                }

                unauthorized(res, "Missing Authorization header");
                return;
            }

            // Parse scheme + credential string
            std::string_view credential;
            auto             scheme = parseScheme(authHeader, credential);

            switch (scheme)
            {
                case SchemeType::Bearer:
                    if (!handleBearer(credential, req, res))
                        return;
                    break;

                case SchemeType::ApiKey:
                    if (!handleApiKey(credential, req, res))
                        return;
                    break;

                case SchemeType::Unknown:
                default:
                    unauthorized(res, "Unsupported authentication scheme");
                    return;
            }

            // User authenticated, continue chain
            next();
        }
        catch (const std::exception& ex)
        {
            // Robust error barrier: never leak stack traces to client
            forbidden(res, "Authentication processing error: " + std::string(ex.what()));
        }
    }

private:
    // -----------------------------------------------------------------
    // Enumerations & helpers
    // -----------------------------------------------------------------
    enum class SchemeType { Bearer, ApiKey, Unknown };

    static SchemeType parseScheme(const std::string& header,
                                  std::string_view&  outCredential)
    {
        auto firstSpace = header.find(' ');
        if (firstSpace == std::string::npos) return SchemeType::Unknown;

        std::string scheme = header.substr(0, firstSpace);
        outCredential      = std::string_view(header).substr(firstSpace + 1);

        if (scheme == "Bearer") return SchemeType::Bearer;
        if (scheme == "PF-ApiKey") return SchemeType::ApiKey;
        return SchemeType::Unknown;
    }

    bool handleBearer(std::string_view token, Request& req, Response& res) const
    {
        if (!verifier_)
        {
            unauthorized(res, "Bearer authentication disabled");
            return false;
        }

        auto claimsOpt = verifier_->verify(token, cfg_.leeway);
        if (!claimsOpt)
        {
            unauthorized(res, "Invalid or expired Bearer token");
            return false;
        }

        // Enforce issuer/audience if caller configured them
        const auto& claims = *claimsOpt;
        if ((!cfg_.issuer.empty() && claims.custom.at("iss") != cfg_.issuer) ||
            (!cfg_.audience.empty() && claims.custom.at("aud") != cfg_.audience))
        {
            forbidden(res, "Token issuer or audience mismatch");
            return false;
        }

        req.setAttribute("security.principal", claims);
        return true;
    }

    bool handleApiKey(std::string_view key, Request& req, Response& res) const
    {
        if (!apiKeys_)
        {
            unauthorized(res, "API-Key authentication disabled");
            return false;
        }

        auto claimsOpt = apiKeys_->lookup(key);
        if (!claimsOpt)
        {
            unauthorized(res, "Invalid API key");
            return false;
        }

        req.setAttribute("security.principal", *claimsOpt);
        return true;
    }

    // -----------------------------------------------------------------
    // Response builders
    // -----------------------------------------------------------------
    static void unauthorized(Response& res, const std::string& msg)
    {
        res.setStatus(401);
        res.setHeader("WWW-Authenticate", R"(Bearer realm="PaletteFlux", charset="UTF-8")");
        res.writeJson(jsonError("unauthorized", msg));
    }

    static void forbidden(Response& res, const std::string& msg)
    {
        res.setStatus(403);
        res.writeJson(jsonError("forbidden", msg));
    }

    static std::string jsonError(const std::string& code, const std::string& msg)
    {
        std::ostringstream oss;
        oss << R"({"error":{"code":")" << code << R"(","message":")" << msg << R"("}})";
        return oss.str();
    }

    // -----------------------------------------------------------------
    // Members
    // -----------------------------------------------------------------
    Config                               cfg_;
    std::shared_ptr<TokenVerifier>       verifier_;
    std::shared_ptr<ApiKeyRepository>    apiKeys_;
};

}   // namespace paletteflux::http::middleware

#endif // PALETTEFLUX_STUDIO_HTTP_MIDDLEWARE_AUTHMIDDLEWARE_H