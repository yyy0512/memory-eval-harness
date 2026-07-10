```cpp
// SPDX-License-Identifier: Apache-2.0
//
// ChronoFlow Nexus – Authentication middleware
//
// This middleware is responsible for:
//
//  • Extracting the Bearer token from the HTTP `Authorization` header.
//  • Validating JSON Web Tokens (JWT) via the domain‐layer TokenValidator.
//  • Enriching the request context with the decoded user principal so that
//    downstream handlers (REST controllers, GraphQL resolvers, etc.) can
//    make authorization decisions.
//  • Performing basic metrics/telemetry (latency histogram, failure counter).
//
// NOTE: The public interface is declared in `auth_middleware.h`.  Implementation
// is purposely kept free of transport-specific details; only a minimal Request /
// Response abstraction is assumed to exist in `transport/http_types.hpp`.
//
#include "interface/auth_middleware.h"

#include <chrono>
#include <sstream>
#include <string_view>
#include <utility>

#include <nlohmann/json.hpp>                 // 3rd-party – used only for error responses
#include "application/telemetry/metrics.h"   // project-internal
#include "application/telemetry/tracing.h"   // project-internal
#include "infrastructure/logging/logger.h"   // project-internal
#include "transport/http_types.hpp"          // project-internal

using chrono::steady_clock;

namespace cf::interface {

namespace {

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

constexpr std::string_view kBearerPrefix{"Bearer "};

std::string trim(std::string_view sv) {
    auto begin = sv.find_first_not_of(" \t\r\n");
    auto end   = sv.find_last_not_of(" \t\r\n");
    return (begin == std::string_view::npos)
               ? std::string{}
               : std::string{sv.substr(begin, end - begin + 1)};
}

bool extractToken(std::string_view authHeader, std::string& outToken) {
    authHeader = trim(authHeader);

    if (authHeader.size() <= kBearerPrefix.size()) { return false; }

    if (!std::equal(kBearerPrefix.begin(),
                    kBearerPrefix.end(),
                    authHeader.begin(),
                    [](char a, char b) { return std::tolower(a) == std::tolower(b); })) {
        return false;
    }

    outToken.assign(authHeader.substr(kBearerPrefix.size()));
    return !outToken.empty();
}

transport::HttpResponse makeJsonErrorResponse(
    transport::HttpStatus status,
    std::string_view      message,
    std::string_view      code = "") {

    nlohmann::json body{
        {"error", message},
    };
    if (!code.empty()) { body["code"] = code; }

    transport::HttpResponse res{status};
    res.setHeader("Content-Type", "application/json");
    res.setBody(body.dump());

    return res;
}

}  // namespace

// ---------------------------------------------------------------------------
// ctor / dtor
// ---------------------------------------------------------------------------

AuthMiddleware::AuthMiddleware(std::shared_ptr<domain::ITokenValidator> validator,
                               std::shared_ptr<logging::Logger>        logger,
                               telemetry::Metrics&                      metrics)
    : m_validator{std::move(validator)}
    , m_logger{std::move(logger)}
    , m_metrics{metrics.auth()} {
    if (!m_validator) { throw std::invalid_argument{"validator == nullptr"}; }
    if (!m_logger) { throw std::invalid_argument{"logger == nullptr"}; }
}

// ---------------------------------------------------------------------------
// operator() – core logic
// ---------------------------------------------------------------------------

void AuthMiddleware::operator()(transport::HttpRequest&  req,
                                transport::HttpResponse& res,
                                Next                     next) const {

    // Start tracing span
    auto span = telemetry::Tracing::startSpan("AuthMiddleware");

    const auto start = steady_clock::now();
    m_metrics.requestsTotal.inc();

    try {
        // -----------------------------------------------------------------
        // 1. Extract Authorization header
        // -----------------------------------------------------------------
        const auto* authHeaderPtr = req.getHeader("Authorization");
        if (!authHeaderPtr) {
            m_metrics.failMissingHeader.inc();
            res = makeJsonErrorResponse(transport::HttpStatus::Unauthorized,
                                        "Missing Authorization header",
                                        "AUTH_HEADER_MISSING");
            return;
        }
        std::string token;
        if (!extractToken(*authHeaderPtr, token)) {
            m_metrics.failMalformedHeader.inc();
            res = makeJsonErrorResponse(transport::HttpStatus::Unauthorized,
                                        "Malformed Authorization header",
                                        "AUTH_HEADER_MALFORMED");
            return;
        }

        // -----------------------------------------------------------------
        // 2. Validate & decode token
        // -----------------------------------------------------------------
        auto principal = m_validator->validate(token);
        if (!principal) {
            m_metrics.failInvalidToken.inc();
            res = makeJsonErrorResponse(transport::HttpStatus::Unauthorized,
                                        "Invalid or expired token",
                                        "TOKEN_INVALID");
            return;
        }

        // -----------------------------------------------------------------
        // 3. Enrich request context
        // -----------------------------------------------------------------
        req.setContext("principal", std::move(principal));  // Move to avoid copy

        // -----------------------------------------------------------------
        // 4. Continue chain
        // -----------------------------------------------------------------
        next(req, res);

    } catch (const std::exception& ex) {
        m_metrics.failUnhandledException.inc();
        m_logger->error("AuthMiddleware: unhandled exception: {}", ex.what());

        res = makeJsonErrorResponse(transport::HttpStatus::InternalServerError,
                                    "Internal authentication error",
                                    "AUTH_INTERNAL_ERROR");
    } catch (...) {
        m_metrics.failUnhandledException.inc();
        m_logger->error("AuthMiddleware: unknown exception");

        res = makeJsonErrorResponse(transport::HttpStatus::InternalServerError,
                                    "Internal authentication error",
                                    "AUTH_INTERNAL_ERROR");
    }

    // -----------------------------------------------------------------
    // 5. Record latency
    // -----------------------------------------------------------------
    const auto duration =
        std::chrono::duration_cast<std::chrono::microseconds>(steady_clock::now() - start);
    m_metrics.latency.usecs.observe(static_cast<double>(duration.count()));
}

}  // namespace cf::interface
```