```cpp
// Copyright (c) PaletteFlux
// SPDX-License-Identifier: MIT
//
// LoggingMiddleware.cpp
// ---------------------------------------------------------
//  This middleware decorates every inbound HTTP request /
//  outbound HTTP response with structured logs that feed our
//  observability pipeline (Elastic ⟶ Kibana dashboards).
//
//  Responsibilities:
//   * Assign (or propagate) a correlation-id to each request.
//   * Measure wall-clock latency of controller execution.
//   * Capture HTTP method, target path, response status, and
//     outcome (success | failure).
//   * Surface unhandled exceptions as 5xx responses while
//     ensuring that sensitive data never reaches the log.
//
//  The implementation purposefully avoids any direct coupling
//  to the underlying HTTP engine (Boost.Beast, Crow, Pistache,
//  etc.).  Instead, it relies on PaletteFlux’s minimal
//  request/response façade defined in `http/HttpTypes.hpp`.
//
//  NOTE: This file only contains the implementation details.
//        The interface can be found in
//        `paletteflux_studio/include/http/middleware/LoggingMiddleware.hpp`.
//

#include "http/middleware/LoggingMiddleware.hpp"

#include <chrono>
#include <exception>
#include <iomanip>
#include <sstream>
#include <string>
#include <utility>

#include "core/UUID.hpp"            // <- PaletteFlux util for RFC-4122 UUIDs
#include "http/HttpStatus.hpp"      // <- Enum class { OK = 200, InternalServerError = 500, … }
#include "monitoring/Metrics.hpp"   // <- Counter & Histogram helpers
#include <spdlog/spdlog.h>

namespace pf::http::middleware
{

namespace
{
constexpr std::string_view kCorrelationHeader = "x-correlation-id";

/**
 * Utility: Convert duration to microseconds-precision string.
 */
template <typename ClockDuration>
std::string durationToMicroString(ClockDuration dur)
{
    using Micros = std::chrono::microseconds;
    const auto us = std::chrono::duration_cast<Micros>(dur).count();
    std::ostringstream oss;
    oss << us << "µs";
    return oss.str();
}
} // namespace

// ---------------------------------------------------------------------------
// Constructor & lifecycle
// ---------------------------------------------------------------------------

LoggingMiddleware::LoggingMiddleware()
    : _logger{spdlog::get("http")}
{
    // If the shared "http" logger hasn’t been registered yet, create it.
    if (!_logger)
    {
        _logger = spdlog::stdout_color_mt("http");
        _logger->set_pattern(R"([%Y-%m-%dT%H:%M:%S.%eZ] [%^%l%$] [%n] %v)");
        _logger->set_level(spdlog::level::info);
    }

    // Register metrics once. Subsequent calls are idempotent.
    using monitoring::Metrics;
    Metrics::counter("http_requests_total",
                     "Overall number of HTTP requests grouped by method, status.");
    Metrics::histogram("http_request_duration_microseconds",
                       "Request processing latency in micro-seconds.");
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

void LoggingMiddleware::handle(Request&           request,
                               Response&          response,
                               NextHandler&&      next) const
{
    const auto start = std::chrono::steady_clock::now();

    // ---------------------------------------------------------------------
    // 1. Correlation-Id propagation / generation
    // ---------------------------------------------------------------------
    std::string correlationId;

    if (auto* hdr = request.headers().tryGet(kCorrelationHeader))
    {
        correlationId = *hdr;
    }
    else
    {
        correlationId = core::UUID::v4(); // generate RFC4122 UUIDv4
        request.headers().set(kCorrelationHeader, correlationId);
    }

    // Add to response for downstream consumers (Browsers, gRPC, etc.)
    response.headers().set(kCorrelationHeader, correlationId);

    // Contextualise log entries with correlation-id
    auto log = _logger->clone(fmt::format("{}", correlationId));

    // ---------------------------------------------------------------------
    // 2. Delegate execution further down the pipeline, catch exceptions
    // ---------------------------------------------------------------------
    HttpStatus code = HttpStatus::InternalServerError;

    try
    {
        next(request, response);
        code = response.status();
    }
    catch (const std::exception& ex)
    {
        // Controller threw an unhandled exception – convert to 500.
        response.setStatus(HttpStatus::InternalServerError);
        response.setBody(R"({"error":"Internal Server Error"})"); // Do not leak details

        log->error("Unhandled exception during request processing: {}", ex.what());
        code = HttpStatus::InternalServerError;
    }
    catch (...)
    {
        response.setStatus(HttpStatus::InternalServerError);
        response.setBody(R"({"error":"Internal Server Error"})");

        log->error("Unknown non-std exception during request processing.");
        code = HttpStatus::InternalServerError;
    }

    // ---------------------------------------------------------------------
    // 3. Record timing & push observability artefacts
    // ---------------------------------------------------------------------
    const auto    end           = std::chrono::steady_clock::now();
    const auto    latency       = end - start;
    const auto    latencyString = durationToMicroString(latency);
    const char*   outcome       = static_cast<int>(code) >= 500 ? "failure" : "success";

    monitoring::Metrics::counter("http_requests_total")
        .add(1.0,
             {
                 {"method",   request.methodString()},
                 {"status",   std::to_string(static_cast<int>(code))},
                 {"outcome",  outcome}
             });

    monitoring::Metrics::histogram("http_request_duration_microseconds")
        .observe(std::chrono::duration_cast<std::chrono::microseconds>(latency).count(),
                 {
                     {"method", request.methodString()},
                     {"status", std::to_string(static_cast<int>(code))}
                 });

    // ---------------------------------------------------------------------
    // 4. Structured log output
    // ---------------------------------------------------------------------
    log->info(R"({{"method":"{}","path":"{}","status":{},"latency":"{}","outcome":"{}"}})",
              request.methodString(),
              request.target(),
              static_cast<int>(code),
              latencyString,
              outcome);
}

} // namespace pf::http::middleware
```