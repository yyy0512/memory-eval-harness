#include "AuthMiddleware.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <regex>
#include <spdlog/spdlog.h>     // Logging library
#include <jwt-cpp/jwt.h>       // https://github.com/Thalhammer/jwt-cpp
#include <nlohmann/json.hpp>   // JSON helper
#include "../utils/LruCache.hpp" // Simple header-only LRU cache used across the repo

// -------------------------------------------------------------------------------------------------
// NOTE: This file is part of PaletteFlux GraphQL Studio
// Copyright (c) 2024
// -------------------------------------------------------------------------------------------------

using namespace std::chrono_literals;

namespace paletteflux::http::middleware
{

// Internal helpers -------------------------------------------------------------------------------

namespace
{
    constexpr std::chrono::seconds kCacheTTL{10 * 60}; // 10 minutes
    constexpr std::size_t          kCacheSize{4'096};  // Enough for typical burst traffic

    // Extracts the bare token string from an Authorization header value.
    // e.g.  "Bearer  eyJhbGciOi..."  -> "eyJhbGciOi..."
    std::optional<std::string> extractBearer(const std::string &header)
    {
        static const std::regex kBearerRegex(R"(^\s*Bearer\s+([A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_.+/=]*)\s*$)",
                                             std::regex::icase);

        std::smatch match;
        if (std::regex_match(header, match, kBearerRegex) && match.size() == 2)
        {
            return match[1].str();
        }
        return std::nullopt;
    }

    //! Simple RAII helper to measure execution time (for tracing slow auth requests)
    class ScopeTimer
    {
    public:
        explicit ScopeTimer(const std::string &label)
            : _label(label), _start(std::chrono::steady_clock::now()) {}

        ~ScopeTimer()
        {
            const auto elapsed = std::chrono::steady_clock::now() - _start;
            if (elapsed > 20ms)
            {
                spdlog::debug("[AuthMiddleware] {} took {} ms",
                              _label,
                              std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
            }
        }

    private:
        std::string                                         _label;
        std::chrono::time_point<std::chrono::steady_clock>  _start;
    };
} // namespace

// -------------------------------------------------------------------------------------------------
// class AuthMiddleware
// -------------------------------------------------------------------------------------------------

AuthMiddleware::AuthMiddleware(std::shared_ptr<security::ITokenValidator> tokenValidator,
                               std::shared_ptr<security::IApiKeyRepository> apiKeyRepo,
                               std::shared_ptr<LruCache<std::string, AuthResult>> tokenCache)
    : _tokenValidator(std::move(tokenValidator))
    , _apiKeyRepository(std::move(apiKeyRepo))
    , _tokenCache(std::move(tokenCache))
{
    if (!_tokenCache)
    {
        _tokenCache = std::make_shared<LruCache<std::string, AuthResult>>(kCacheSize, kCacheTTL);
    }
}

// Main entry point -------------------------------------------------------------------------------

HttpResponse AuthMiddleware::handle(const HttpRequest &request,
                                    HttpContext &       context,
                                    NextHandler          next) const
{
    ScopeTimer timer("handle");

    try
    {
        const auto authHeader = request.header("Authorization");
        const auto apiKey     = request.header("X-Api-Key");

        // 1) Try bearer token --------------------------------------------------------------------
        if (!authHeader.empty())
        {
            if (auto token = extractBearer(authHeader))
            {
                return processBearer(*token, request, context, next);
            }

            // Malformed Authorization header
            return reject(HttpStatus::Unauthorized,
                          "Malformed Authorization header. Expected 'Bearer <JWT>'.");
        }

        // 2) Try legacy API key header -----------------------------------------------------------
        if (!apiKey.empty())
        {
            return processApiKey(apiKey, request, context, next);
        }

        // 3) Public endpoint? --------------------------------------------------------------------
        if (isPublicEndpoint(request))
        {
            return next(request, context); // Pass through without user information
        }

        // 4) Nothing worked -> Unauthorized ------------------------------------------------------
        return reject(HttpStatus::Unauthorized, "Missing authentication credentials.");
    }
    catch (const security::TokenExpiredError &e)
    {
        return reject(HttpStatus::Unauthorized, "Token expired.");
    }
    catch (const security::TokenValidationError &e)
    {
        spdlog::warn("[AuthMiddleware] Token validation failed: {}", e.what());
        return reject(HttpStatus::Unauthorized, "Invalid token.");
    }
    catch (const std::exception &e)
    {
        spdlog::error("[AuthMiddleware] Unexpected error: {}", e.what());
        return reject(HttpStatus::InternalServerError, "Internal authentication error.");
    }
}

// -------------------------------------------------------------------------------------------------
// Private helpers
// -------------------------------------------------------------------------------------------------

HttpResponse AuthMiddleware::processBearer(const std::string &token,
                                           const HttpRequest &request,
                                           HttpContext &      context,
                                           NextHandler        next) const
{
    // Check cache first
    if (auto cached = _tokenCache->get(token))
    {
        attachAuthResult(*cached, context);
        return next(request, context);
    }

    // Validate against configured public keys / issuer
    auto result = _tokenValidator->validate(token);

    // Cache only on success
    if (result.user.has_value())
    {
        _tokenCache->put(token, result);
    }

    attachAuthResult(result, context);
    return next(request, context);
}

HttpResponse AuthMiddleware::processApiKey(const std::string &apiKey,
                                           const HttpRequest &request,
                                           HttpContext &      context,
                                           NextHandler        next) const
{
    auto account = _apiKeyRepository->lookup(apiKey);
    if (!account)
    {
        return reject(HttpStatus::Unauthorized, "Invalid API key.");
    }

    AuthResult result{};
    result.user      = account->ownerUser;
    result.scopes    = account->scopes;
    result.authType  = AuthType::ApiKey;

    attachAuthResult(result, context);
    return next(request, context);
}

void AuthMiddleware::attachAuthResult(const AuthResult &result, HttpContext &context) const
{
    if (result.user)
    {
        context.setUser(*result.user);
    }
    if (!result.scopes.empty())
    {
        context.setScopes(result.scopes);
    }
    context.setAuthType(result.authType);
}

bool AuthMiddleware::isPublicEndpoint(const HttpRequest &req) const
{
    // Endpoints starting with /public or global static assets are anonymous
    static const std::regex kPublicPath(R"(^/(public|assets)/.*$)", std::regex::icase);
    return std::regex_match(req.target(), kPublicPath);
}

// Generates standardized error responses ----------------------------------------------------------

HttpResponse AuthMiddleware::reject(HttpStatus status, std::string_view message) const
{
    nlohmann::json body{
        {"error",   { {"code", static_cast<int>(status)}, {"message", message} }},
        {"success", false}
    };

    HttpResponse res;
    res.status(status);
    res.body(body.dump());
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res;
}

} // namespace paletteflux::http::middleware