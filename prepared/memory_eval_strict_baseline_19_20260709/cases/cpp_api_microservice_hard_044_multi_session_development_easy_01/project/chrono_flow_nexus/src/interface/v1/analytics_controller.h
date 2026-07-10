#ifndef CHRONO_FLOW_NEXUS_SRC_INTERFACE_V1_ANALYTICS_CONTROLLER_H_
#define CHRONO_FLOW_NEXUS_SRC_INTERFACE_V1_ANALYTICS_CONTROLLER_H_

/**
 *  chrono_flow_nexus/src/interface/v1/analytics_controller.h
 *
 *  Copyright (c) ChronoFlow.
 *
 *  Exposes version-1 REST and GraphQL handlers that surface fine-grained
 *  productivity analytics (time-on-task, context-switch frequency, etc.)
 *  to client applications.  The controller is **transport-layer agnostic**:
 *  it depends on _thin_ abstractions offered by the transport package
 *  instead of concrete HTTP servers.  This ensures the higher-level
 *  interface remains portable across `boost::beast`, `restinio`, or
 *  any other I/O framework used by deployments.
 *
 *  ┌─────────── ChronoFlow Nexus Layered Architecture ───────────┐
 *  │  Transport  │ interface │ application │ domain │ infra      │
 *  └──────────────────────────────────────────────────────────────┘
 */

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <boost/asio/awaitable.hpp>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

namespace chrono_flow
{
/* Forward-declarations for cross-layer dependencies.  */
namespace transport
{
class HttpRouter;         // Registers path → handler bindings.
struct HttpRequest;       // Immutable request wrapper.
struct HttpResponse;      // Mutable response builder.
} // namespace transport

namespace graphql
{
class ResolverRegistry;   // Maps field → resolver bindings.
} // namespace graphql

namespace metrics
{
class IMetricsRegistry;
class Counter;
} // namespace metrics

namespace application
{
class IAnalyticsQueryService; // Domain-level analytics façade.
} // namespace application

namespace infrastructure
{
class IResponseCache;
class IRateLimiter;
} // namespace infrastructure


namespace interface::v1
{

/**
 * AnalyticsController
 * -------------------
 * Bridge between the external HTTP/GraphQL façade and the internal
 * application-level analytics services.  The controller transparently
 * wires:
 *
 *   • rate-limiting
 *   • response caching
 *   • structured observability hooks
 *
 * before delegating query execution to the underlying service layer.
 */
class AnalyticsController final
{
public:
    /**
     * Dependency-injection constructor.
     *
     * @param analyticsService  Handles the actual analytics queries.
     * @param responseCache     Short-lived, in-memory JSON cache.
     * @param rateLimiter       Adaptive rate-limiting strategy.
     * @param registry          Global metrics registry.
     */
    explicit AnalyticsController(
        std::shared_ptr<application::IAnalyticsQueryService> analyticsService,
        std::shared_ptr<infrastructure::IResponseCache>       responseCache,
        std::shared_ptr<infrastructure::IRateLimiter>         rateLimiter,
        metrics::IMetricsRegistry&                            registry);

    /* Non-copyable but movable. */
    AnalyticsController(const AnalyticsController&)            = delete;
    AnalyticsController& operator=(const AnalyticsController&) = delete;
    AnalyticsController(AnalyticsController&&)                 noexcept = default;
    AnalyticsController& operator=(AnalyticsController&&)      noexcept = default;
    ~AnalyticsController()                                     = default;

    /**
     * Registers REST endpoints under `/v1/analytics/…` on the provided router.
     * This method is idempotent: calling it multiple times on the same router
     * is safe and has no side-effects.
     */
    void wireRestEndpoints(transport::HttpRouter& router);

    /**
     * Registers GraphQL resolvers under the `Analytics` root type.
     */
    void wireGraphQlResolvers(graphql::ResolverRegistry& registry);

private:
    /* ----------  REST handlers (co_routines)  ---------- */

    /**
     * GET /v1/analytics/time-on-task?user_id=…&from=…&to=…
     */
    boost::asio::awaitable<transport::HttpResponse>
    getTimeOnTask(const transport::HttpRequest& req);

    /**
     * GET /v1/analytics/flow-metrics?team_id=…&window=…
     */
    boost::asio::awaitable<transport::HttpResponse>
    getFlowMetrics(const transport::HttpRequest& req);

    /* ----------  Infrastructure helpers  ---------- */

    bool shouldThrottle(const transport::HttpRequest& req) const;

    std::optional<nlohmann::json>
    tryServeFromCache(std::string_view cacheKey) const;

    void saveToCache(std::string_view      cacheKey,
                     const nlohmann::json& payload,
                     std::chrono::seconds  ttl);

    [[nodiscard]]
    static nlohmann::json buildProblemJson(int                 status,
                                           std::string_view    title,
                                           std::string_view    detail) noexcept;

private:
    /* ----------  Injected collaborators  ---------- */
    std::shared_ptr<application::IAnalyticsQueryService> analyticsService_;
    std::shared_ptr<infrastructure::IResponseCache>      responseCache_;
    std::shared_ptr<infrastructure::IRateLimiter>        rateLimiter_;

    /* ----------  Metrics (lifetime bound to registry)  ---------- */
    metrics::Counter* counterRequests_{nullptr};
    metrics::Counter* counterErrors_  {nullptr};

    /* ----------  Constants  ---------- */
    constexpr static std::string_view kRestPrefix    = "/v1/analytics";
    constexpr static std::string_view kCacheTimeOnTask   = "time_on_task:";
    constexpr static std::string_view kCacheFlowMetrics  = "flow_metrics:";
};

/* ========================================================================== */
/*                              Inline implementation                         */
/* ========================================================================== */

inline AnalyticsController::AnalyticsController(
        std::shared_ptr<application::IAnalyticsQueryService> analyticsService,
        std::shared_ptr<infrastructure::IResponseCache>      responseCache,
        std::shared_ptr<infrastructure::IRateLimiter>        rateLimiter,
        metrics::IMetricsRegistry&                           registry)
    : analyticsService_(std::move(analyticsService))
    , responseCache_   (std::move(responseCache))
    , rateLimiter_     (std::move(rateLimiter))
{
    // Lazily look-up (or create) counters in registry.
    // (No-throw: registry is expected to handle collisions internally.)
    counterRequests_ = /* registry.counter("interface.v1.analytics.requests_total") */ nullptr;
    counterErrors_   = /* registry.counter("interface.v1.analytics.errors_total")   */ nullptr;
}

inline bool
AnalyticsController::shouldThrottle(const transport::HttpRequest& req) const
{
    if (!rateLimiter_) { return false; }
    try
    {
        return rateLimiter_->isThrottled(req /*+ other correlation data */);
    }
    catch (const std::exception& ex)
    {
        spdlog::error("Rate-limiter failure: {}", ex.what());
        return false;  // Fail-open to avoid cascading user errors.
    }
}

inline std::optional<nlohmann::json>
AnalyticsController::tryServeFromCache(std::string_view cacheKey) const
{
    if (!responseCache_) { return std::nullopt; }
    try
    {
        return responseCache_->get(cacheKey);
    }
    catch (const std::exception& ex)
    {
        spdlog::warn("Cache read error: {}", ex.what());
        return std::nullopt;
    }
}

inline void
AnalyticsController::saveToCache(std::string_view      cacheKey,
                                 const nlohmann::json& payload,
                                 std::chrono::seconds  ttl)
{
    if (!responseCache_) { return; }
    try
    {
        responseCache_->put(cacheKey, payload, ttl);
    }
    catch (const std::exception& ex)
    {
        spdlog::warn("Cache write error: {}", ex.what());
    }
}

inline nlohmann::json
AnalyticsController::buildProblemJson(int              status,
                                      std::string_view title,
                                      std::string_view detail) noexcept
{
    return {
        { "status", status  },
        { "title",  title   },
        { "detail", detail  }
    };
}

} // namespace interface::v1
} // namespace chrono_flow

#endif // CHRONO_FLOW_NEXUS_SRC_INTERFACE_V1_ANALYTICS_CONTROLLER_H_
