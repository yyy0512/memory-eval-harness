```cpp
/***************************************************************************************************
 *  PaletteFlux GraphQL Studio – LoggingMiddleware
 *
 *  File: paletteflux_studio/src/http/middleware/LoggingMiddleware.h
 *
 *  Description:
 *      HTTP–level middleware that wraps downstream handlers with structured logging,
 *      correlation-ID (a.k.a. request-ID) propagation, latency measurements, and
 *      panic-grade exception capture. Built to be framework-agnostic – any callable that
 *      takes an HttpRequest& and returns an HttpResponse can be wrapped.
 *
 *  Copyright:
 *      © 2024 PaletteFlux Interactive. All rights reserved.
 **************************************************************************************************/

#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <random>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>

#include "http/HttpRequest.h"   // Project-local abstractions
#include "http/HttpResponse.h"
#include "util/SysClock.h"      // Thin wrapper around std::chrono for unified clock source

namespace paletteflux::http::middleware
{

/**
 * LoggingMiddleware
 *
 * A lightweight decorator for request/response handlers.  Usage:
 *
 *      auto handlerWithLogging = LoggingMiddleware::wrap(originalHandler, logger);
 *      HttpResponse res = handlerWithLogging(request);
 *
 * Pros:
 *   • No inheritance required – returns a std::function.
 *   • Thread-safe as long as the provided spdlog::logger is thread-safe (default).
 *   • Configurable verbosity per instance.
 */
class LoggingMiddleware
{
public:
    struct Config
    {
        spdlog::level::level_enum logLevel              = spdlog::level::info;
        bool                     logHeaders             = false;
        bool                     logBody                = false;
        std::size_t              maxBodyLogBytes        = 4_KiB;  // safety cap
        std::string              correlationIdHeader    = "X-Request-ID";
    };

    /**
     * Wrap a downstream handler in a logging envelope.
     *
     * @param downstream  Any callable taking (HttpRequest&) → HttpResponse.
     * @param logger      Optional custom logger; if nullptr a colorized console logger is created.
     * @param cfg         Verbosity & behavior configuration.
     * @return std::function<HttpResponse(HttpRequest&)>
     */
    static std::function<http::HttpResponse(http::HttpRequest&)> wrap(
        std::function<http::HttpResponse(http::HttpRequest&)> downstream,
        std::shared_ptr<spdlog::logger>                       logger = nullptr,
        Config                                                cfg    = {})
    {
        if (!logger)
        {
            // Create default color console logger on first use.
            logger = spdlog::stdout_color_mt("paletteflux.http");
            logger->set_pattern("[%Y-%m-%d %H:%M:%S.%e] [%^%l%$] %v");
        }

        // Capture by value, producing a stateful closure.
        return [downstream      = std::move(downstream),
                logger          = std::move(logger),
                cfg](http::HttpRequest& req) -> http::HttpResponse
        {
            // Correlation-ID propagation / generation.
            std::string corrId = obtainOrGenerateCorrelationId(req, cfg.correlationIdHeader);
            // Ensure the correlation ID is echoed back in response.
            auto addCorrelationId = [&](http::HttpResponse& resp) {
                resp.headers().try_emplace(cfg.correlationIdHeader, corrId);
            };

            // --- Pre-request log ---------------------------------------------------------------
            {
                auto msg = fmt::format(
                    "→ {} {}  (id={})",
                    req.methodString(),
                    req.target(),
                    corrId);

                logger->log(cfg.logLevel, msg);

                if (cfg.logHeaders)
                {
                    for (const auto& [key, value] : req.headers())
                        logger->log(cfg.logLevel + 1, "    > {}: {}", key, value);
                }

                if (cfg.logBody && !req.body().empty())
                {
                    std::string_view bodyView{req.body()};
                    if (bodyView.size() > cfg.maxBodyLogBytes)
                        bodyView = bodyView.substr(0, cfg.maxBodyLogBytes);

                    logger->log(cfg.logLevel + 1,
                                "    > Body[{}]:\n{}\n",
                                req.body().size(),
                                bodyView);
                }
            }

            // --- Invoke downstream & measure latency ------------------------------------------
            auto start = util::SysClock::now();
            http::HttpResponse resp;
            try
            {
                resp = downstream(req);     // may throw
            }
            catch (const std::exception& ex)
            {
                auto dur = util::SysClock::now() - start;
                logger->error("✖ Exception while processing id={} ({} ms): {}",
                              corrId,
                              std::chrono::duration_cast<std::chrono::milliseconds>(dur).count(),
                              ex.what());
                throw;  // propagate – higher layers decide recovery policy.
            }

            auto durationMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                  util::SysClock::now() - start)
                                  .count();

            // Add correlation ID header if not present.
            addCorrelationId(resp);

            // --- Post-request log --------------------------------------------------------------
            {
                auto msg = fmt::format("← {} {}  [{}]  ({} ms)  id={}",
                                       req.methodString(),
                                       req.target(),
                                       static_cast<unsigned>(resp.statusCode()),
                                       durationMs,
                                       corrId);
                logger->log(cfg.logLevel, msg);

                if (cfg.logHeaders)
                {
                    for (const auto& [key, value] : resp.headers())
                        logger->log(cfg.logLevel + 1, "    < {}: {}", key, value);
                }

                if (cfg.logBody && !resp.body().empty())
                {
                    std::string_view bodyView{resp.body()};
                    if (bodyView.size() > cfg.maxBodyLogBytes)
                        bodyView = bodyView.substr(0, cfg.maxBodyLogBytes);

                    logger->log(cfg.logLevel + 1,
                                "    < Body[{}]:\n{}\n",
                                resp.body().size(),
                                bodyView);
                }
            }

            return resp;
        };
    }

private:
    // Generate pseudo-random UUIDv4 (not cryptographically secure).
    static std::string generateUuidV4()
    {
        static thread_local std::mt19937_64 rng{std::random_device{}()};
        std::uniform_int_distribution<uint64_t> dist;

        auto rand64 = [&] { return dist(rng); };

        uint64_t part1 = rand64();
        uint64_t part2 = rand64();

        std::ostringstream oss;
        oss << std::hex << std::nouppercase;

        // 8-4-4-4-12 layout
        oss.width(8);
        oss.fill('0');
        oss << (part1 >> 32);

        oss << '-';
        oss.width(4);
        oss << ((part1 >> 16) & 0xFFFF);

        oss << '-';
        oss.width(4);
        oss << ((part1)&0xFFFF);

        oss << '-';
        oss.width(4);
        oss << (part2 >> 48);

        oss << '-';
        oss.width(12);
        oss << (part2 & 0xFFFFFFFFFFFFULL);

        return oss.str();
    }

    static std::string obtainOrGenerateCorrelationId(http::HttpRequest& req,
                                                     std::string_view  headerName)
    {
        auto it = req.headers().find(headerName);
        if (it != req.headers().end() && !it->second.empty())
        {
            return it->second;
        }
        else
        {
            std::string id = generateUuidV4();
            req.headers().try_emplace(headerName, id);
            return id;
        }
    }
};

} // namespace paletteflux::http::middleware
```