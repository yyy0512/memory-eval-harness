```cpp
/**
 * chrono_flow_nexus/src/interface/v1/analytics_controller.cpp
 *
 * Copyright (c) ChronoFlow
 *
 * Defines REST v1 analytics endpoints (time-on-task, context switch frequency,
 * flow-state interruptions).  The controller lives in the “interface” layer
 * and wires HTTP transport concerns to the application/query layer while
 * taking care of cross-cutting requirements such as structured logging,
 * rate-limiting, response-caching, and metrics collection.
 */

#include "interface/v1/analytics_controller.hpp"

#include "application/query_bus.hpp"
#include "application/queries/time_on_task_query.hpp"
#include "application/queries/context_switch_frequency_query.hpp"
#include "application/queries/flow_state_interruptions_query.hpp"

#include "infrastructure/cache/response_cache.hpp"
#include "infrastructure/http/http_router.hpp"
#include "infrastructure/http/http_request.hpp"
#include "infrastructure/http/http_response.hpp"
#include "infrastructure/logging/logger.hpp"
#include "infrastructure/metrics/metrics_registry.hpp"
#include "infrastructure/rate_limiting/rate_limiter.hpp"

#include <nlohmann/json.hpp>

#include <boost/algorithm/string.hpp>
#include <boost/lexical_cast.hpp>
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_io.hpp>

#include <chrono>
#include <ctime>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string>
#include <utility>

namespace chrono_flow::interface::v1
{

using json = nlohmann::json;
using Clock = std::chrono::system_clock;

namespace
{
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to parse an RFC-3339/ISO-8601 timestamp (UTC, “Z” suffix) into a
 * std::chrono::system_clock::time_point.  Returns std::nullopt on failure.
 */
std::optional<Clock::time_point> parse_iso8601(const std::string &input)
{
    // Expected format: YYYY-MM-DDTHH:MM:SSZ (e.g. 2024-03-31T17:15:00Z)
    std::tm tm {};
    std::istringstream ss {input};
    ss >> std::get_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    if (ss.fail())
    {
        return std::nullopt;
    }

    // std::time_t assumes local but timegm interprets as UTC.  Chromium,
    // musl, and others expose timegm.  When not available, fall back to
    // manual conversion (omitted here for brevity).
#if defined(__unix__) || defined(__APPLE__)
    const std::time_t utc_time = ::timegm(&tm);
#else
    const std::time_t utc_time = _mkgmtime(&tm); // MSVC
#endif
    return Clock::from_time_t(utc_time);
}

/**
 * Serialise a chrono time_point back to UTC ISO-8601.
 */
std::string iso8601(const Clock::time_point &tp)
{
    const std::time_t t = Clock::to_time_t(tp);
    std::tm tm {};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    std::ostringstream ss;
    ss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    return ss.str();
}

/**
 * Build a unique, deterministic cache key from an HTTP request.
 * The key MUST include every piece of information affecting the response
 * (endpoint + query string) but SHOULD omit volatile headers (e.g. Date).
 */
std::string build_cache_key(const infrastructure::http::HttpRequest &req)
{
    // Path   → /v1/analytics/time-on-task
    // Query  → userId=...&from=...&to=...
    std::string key {req.target()};
    key += '?';
    key += req.query_string();
    return key;
}

/**
 * Shorthand: produce a 400 response with error details in JSON.
 */
void respond_bad_request(infrastructure::http::HttpResponse          &res,
                         const std::string                           &message,
                         infrastructure::logging::Logger             &logger,
                         const std::string_view                       endpoint)
{
    logger.warn("[{}] 400 – {}", endpoint, message);
    res.status(400);
    res.set_header("Content-Type", "application/json");
    res.body(json{
        {"error", "Bad Request"},
        {"message", message},
    }.dump());
}

/**
 * Shorthand: produce a 500 response with error details in JSON.
 */
void respond_internal_error(infrastructure::http::HttpResponse          &res,
                            const std::string                           &message,
                            infrastructure::logging::Logger             &logger,
                            const std::string_view                       endpoint)
{
    logger.error("[{}] 500 – {}", endpoint, message);
    res.status(500);
    res.set_header("Content-Type", "application/json");
    res.body(json{
        {"error", "Internal Server Error"},
        {"message", message},
    }.dump());
}

} // namespace anonymous

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

AnalyticsController::AnalyticsController(
        std::shared_ptr<infrastructure::http::HttpRouter>  router,
        std::shared_ptr<application::QueryBus>             query_bus,
        std::shared_ptr<infrastructure::cache::ResponseCache> cache,
        std::shared_ptr<infrastructure::rate_limiting::RateLimiter> limiter,
        std::shared_ptr<infrastructure::metrics::MetricsRegistry>  metrics,
        std::shared_ptr<infrastructure::logging::Logger>   logger)
    : router_  (std::move(router))
    , query_bus_(std::move(query_bus))
    , cache_   (std::move(cache))
    , limiter_ (std::move(limiter))
    , metrics_ (std::move(metrics))
    , logger_  (std::move(logger))
{
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

void AnalyticsController::register_routes()
{
    using infrastructure::http::HttpRequest;
    using infrastructure::http::HttpResponse;

    router_->get(
        "/v1/analytics/time-on-task",
        [self = shared_from_this()](const HttpRequest &req, HttpResponse &res)
        { self->handle_time_on_task(req, res); });

    router_->get(
        "/v1/analytics/context-switch-frequency",
        [self = shared_from_this()](const HttpRequest &req, HttpResponse &res)
        { self->handle_context_switch_frequency(req, res); });

    router_->get(
        "/v1/analytics/flow-state-interruptions",
        [self = shared_from_this()](const HttpRequest &req, HttpResponse &res)
        { self->handle_flow_state_interruptions(req, res); });

    logger_->info("AnalyticsController v1 routes registered");
}

// ---------------------------------------------------------------------------
// Endpoint implementations
// ---------------------------------------------------------------------------

void AnalyticsController::handle_time_on_task(
        const infrastructure::http::HttpRequest &req,
        infrastructure::http::HttpResponse      &res)
{
    constexpr std::string_view ENDPOINT = "GET /v1/analytics/time-on-task";

    // Rate-limit
    if (!limiter_->acquire(req))
    {
        res.status(429);
        res.set_header("Retry-After", std::to_string(limiter_->retry_after_seconds()));
        res.body(R"({"error":"Too Many Requests"})");
        metrics_->counter("cf.interface.rate_limited_total").inc();
        return;
    }

    // Try fast-path cache
    const std::string cache_key = build_cache_key(req);
    if (auto cached = cache_->get(cache_key))
    {
        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(*cached);
        metrics_->counter("cf.interface.cache_hit_total").inc();
        return;
    }

    metrics_->counter("cf.interface.cache_miss_total").inc();

    //--------------------
    // Input validation
    //--------------------
    const auto user_id_str = req.get_parameter("userId");
    const auto from_str    = req.get_parameter("from");
    const auto to_str      = req.get_parameter("to");

    if (user_id_str.empty() || from_str.empty() || to_str.empty())
    {
        respond_bad_request(res, "Missing required query parameters "
                                 "userId, from, or to.", *logger_, ENDPOINT);
        return;
    }

    // Parse UUID
    boost::uuids::uuid user_id {};
    try
    {
        user_id = boost::lexical_cast<boost::uuids::uuid>(user_id_str);
    }
    catch (const boost::bad_lexical_cast &)
    {
        respond_bad_request(res, "userId must be a valid UUID", *logger_, ENDPOINT);
        return;
    }

    auto from_tp = parse_iso8601(from_str);
    auto to_tp   = parse_iso8601(to_str);

    if (!from_tp || !to_tp || *from_tp >= *to_tp)
    {
        respond_bad_request(res,
                            "from/to must be valid ISO-8601 timestamps (UTC) "
                            "and 'from' < 'to'",
                            *logger_,
                            ENDPOINT);
        return;
    }

    //--------------------
    // Dispatch query
    //--------------------
    try
    {
        application::queries::TimeOnTaskQuery query {
            std::move(user_id),
            *from_tp,
            *to_tp
        };

        const auto result =
            query_bus_->dispatch<application::queries::TimeOnTaskResult>(query);

        //--------------------
        // Success → JSON
        //--------------------
        json payload;
        payload["userId"]     = boost::uuids::to_string(user_id);
        payload["from"]       = iso8601(*from_tp);
        payload["to"]         = iso8601(*to_tp);
        payload["seconds"]    = result.total_seconds;
        payload["sessionCnt"] = result.session_count;

        const std::string body = payload.dump();

        // Cache positive response for 60 s to reduce load on compute-heavy
        // analytics path.  The TTL may later be tuned per endpoint.
        cache_->put(cache_key, body, std::chrono::seconds{60});

        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(body);

        metrics_->counter("cf.interface.analytics.time_on_task_ok_total").inc();
    }
    catch (const application::QueryValidationException &ex)
    {
        respond_bad_request(res, ex.what(), *logger_, ENDPOINT);
    }
    catch (const std::exception &ex)
    {
        respond_internal_error(res, ex.what(), *logger_, ENDPOINT);
        metrics_->counter("cf.interface.analytics.time_on_task_error_total").inc();
    }
}

void AnalyticsController::handle_context_switch_frequency(
        const infrastructure::http::HttpRequest &req,
        infrastructure::http::HttpResponse      &res)
{
    constexpr std::string_view ENDPOINT =
        "GET /v1/analytics/context-switch-frequency";

    if (!limiter_->acquire(req))
    {
        res.status(429);
        res.set_header("Retry-After", std::to_string(limiter_->retry_after_seconds()));
        res.body(R"({"error":"Too Many Requests"})");
        metrics_->counter("cf.interface.rate_limited_total").inc();
        return;
    }

    const std::string cache_key = build_cache_key(req);
    if (auto cached = cache_->get(cache_key))
    {
        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(*cached);
        metrics_->counter("cf.interface.cache_hit_total").inc();
        return;
    }
    metrics_->counter("cf.interface.cache_miss_total").inc();

    const auto user_id_str = req.get_parameter("userId");
    const auto from_str    = req.get_parameter("from");
    const auto to_str      = req.get_parameter("to");
    if (user_id_str.empty() || from_str.empty() || to_str.empty())
    {
        respond_bad_request(res, "Missing required query parameters "
                                 "userId, from, or to.", *logger_, ENDPOINT);
        return;
    }

    boost::uuids::uuid user_id {};
    try { user_id = boost::lexical_cast<boost::uuids::uuid>(user_id_str); }
    catch (...) {
        respond_bad_request(res, "userId must be a valid UUID", *logger_, ENDPOINT);
        return;
    }

    auto from_tp = parse_iso8601(from_str);
    auto to_tp   = parse_iso8601(to_str);
    if (!from_tp || !to_tp || *from_tp >= *to_tp)
    {
        respond_bad_request(res,
                            "from/to must be valid ISO-8601 timestamps (UTC) "
                            "and 'from' < 'to'",
                            *logger_,
                            ENDPOINT);
        return;
    }

    try
    {
        application::queries::ContextSwitchFrequencyQuery query {
            std::move(user_id),
            *from_tp,
            *to_tp
        };

        const auto result =
            query_bus_->dispatch<application::queries::ContextSwitchFrequencyResult>(
                query);

        json payload {
            {"userId", boost::uuids::to_string(user_id)},
            {"from",   iso8601(*from_tp)},
            {"to",     iso8601(*to_tp)},
            {"switchCnt", result.switch_count},
            {"avgSwitchesPerHour", result.avg_switches_per_hour}
        };

        const std::string body = payload.dump();
        cache_->put(cache_key, body, std::chrono::seconds{30}); // Shorter TTL
        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(body);
        metrics_->counter(
            "cf.interface.analytics.context_switch_frequency_ok_total").inc();
    }
    catch (const std::exception &ex)
    {
        respond_internal_error(res, ex.what(), *logger_, ENDPOINT);
        metrics_->counter(
            "cf.interface.analytics.context_switch_frequency_error_total").inc();
    }
}

void AnalyticsController::handle_flow_state_interruptions(
        const infrastructure::http::HttpRequest &req,
        infrastructure::http::HttpResponse      &res)
{
    constexpr std::string_view ENDPOINT =
        "GET /v1/analytics/flow-state-interruptions";

    if (!limiter_->acquire(req))
    {
        res.status(429);
        res.set_header("Retry-After", std::to_string(limiter_->retry_after_seconds()));
        res.body(R"({"error":"Too Many Requests"})");
        metrics_->counter("cf.interface.rate_limited_total").inc();
        return;
    }

    const std::string cache_key = build_cache_key(req);
    if (auto cached = cache_->get(cache_key))
    {
        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(*cached);
        metrics_->counter("cf.interface.cache_hit_total").inc();
        return;
    }
    metrics_->counter("cf.interface.cache_miss_total").inc();

    const auto team_id_str = req.get_parameter("teamId");
    const auto from_str    = req.get_parameter("from");
    const auto to_str      = req.get_parameter("to");
    if (team_id_str.empty() || from_str.empty() || to_str.empty())
    {
        respond_bad_request(res, "Missing required query parameters "
                                 "teamId, from, or to.", *logger_, ENDPOINT);
        return;
    }

    boost::uuids::uuid team_id {};
    try { team_id = boost::lexical_cast<boost::uuids::uuid>(team_id_str); }
    catch (...) {
        respond_bad_request(res, "teamId must be a valid UUID", *logger_, ENDPOINT);
        return;
    }

    auto from_tp = parse_iso8601(from_str);
    auto to_tp   = parse_iso8601(to_str);
    if (!from_tp || !to_tp || *from_tp >= *to_tp)
    {
        respond_bad_request(res,
                            "from/to must be valid ISO-8601 timestamps (UTC) "
                            "and 'from' < 'to'",
                            *logger_,
                            ENDPOINT);
        return;
    }

    try
    {
        application::queries::FlowStateInterruptionsQuery query {
            team_id,
            *from_tp,
            *to_tp
        };

        const auto result =
            query_bus_->dispatch<application::queries::FlowStateInterruptionsResult>(
                query);

        json interruptions = json::array();
        for (const auto &i : result.interruptions)
        {
            interruptions.push_back(json{
                {"start", iso8601(i.start)},
                {"durationSeconds", i.duration_seconds},
                {"reason", i.reason},
            });
        }

        json payload {
            {"teamId", boost::uuids::to_string(team_id)},
            {"from",   iso8601(*from_tp)},
            {"to",     iso8601(*to_tp)},
            {"interruptions", std::move(interruptions)},
        };

        const std::string body = payload.dump();
        cache_->put(cache_key, body, std::chrono::seconds{120});
        res.status(200);
        res.set_header("Content-Type", "application/json");
        res.body(body);
        metrics_->counter(
            "cf.interface.analytics.flow_state_interruptions_ok_total").inc();
    }
    catch (const std::exception &ex)
    {
        respond_internal_error(res, ex.what(), *logger_, ENDPOINT);
        metrics_->counter(
            "cf.interface.analytics.flow_state_interruptions_error_total").inc();
    }
}

} // namespace chrono_flow::interface::v1
```