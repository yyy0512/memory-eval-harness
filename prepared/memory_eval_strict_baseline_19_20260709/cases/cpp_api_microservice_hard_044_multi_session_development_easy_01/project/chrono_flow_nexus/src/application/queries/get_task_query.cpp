```cpp
// chrono_flow_nexus/src/application/queries/get_task_query.cpp
//
// This file implements the GetTaskQuery, the canonical read-side use-case
// for retrieving an individual Task (optionally enriched with analytics)
// from the ChronoFlow Nexus application layer.
//
// ────────────────────────────────────────────────────────────────────────────
// NOTE: The surrounding interfaces (ILogger, ICache, ITracer, etc.) are part
// of the existing project and are only forward-declared here to keep the
// translation unit self-contained. The concrete implementations live in the
// `infrastructure` layer and are injected at runtime via the composition
// root (a.k.a. main.cpp / DI container).
// ────────────────────────────────────────────────────────────────────────────

#include "application/queries/get_task_query.h"

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

// ──────────────────────── Forward Declarations ─────────────────────────────
namespace chrono_flow_nexus::domain::models
{
    struct Task; // Domain aggregate root (immutable once persisted)
} // namespace chrono_flow_nexus::domain::models

namespace chrono_flow_nexus::domain::repositories
{
    class ITaskReadRepository; // Read-side repository abstraction
} // namespace chrono_flow_nexus::domain::repositories

namespace chrono_flow_nexus::application::dto
{
    struct TaskDto; // Flat data-transfer object returned by the API layer
} // namespace chrono_flow_nexus::application::dto

namespace chrono_flow_nexus::infrastructure::logging
{
    class ILogger; // Sink-agnostic structured-logging interface
} // namespace chrono_flow_nexus::infrastructure::logging

namespace chrono_flow_nexus::infrastructure::cache
{
    class ICache; // Simple key/value LRU cache with TTL semantics
} // namespace chrono_flow_nexus::infrastructure::cache

namespace chrono_flow_nexus::infrastructure::metrics
{
    class IMetricsCollector; // Prometheus/OpenTelemetry abstraction
} // namespace chrono_flow_nexus::infrastructure::metrics

namespace chrono_flow_nexus::infrastructure::tracing
{
    class ITracer;
    class ISpan;
} // namespace chrono_flow_nexus::infrastructure::tracing

// ───────────────────────── Implementation Details ──────────────────────────
using chrono_flow_nexus::application::dto::TaskDto;
using chrono_flow_nexus::domain::models::Task;

namespace app      = chrono_flow_nexus::application;
namespace infra    = chrono_flow_nexus::infrastructure;
namespace domain   = chrono_flow_nexus::domain;

namespace chrono_flow_nexus::application::queries
{

// Helper — compose a unique cache key that prevents analytics flags
// from bleeding into requests that don't ask for them.
static std::string buildCacheKey(std::string_view taskId, bool includeAnalytics)
{
    std::string key;
    key.reserve(taskId.size() + 18);
    key.append("task:")
        .append(taskId)
        .append(":analytics(")
        .append(includeAnalytics ? "1" : "0")
        .append(")");
    return key;
}

/*==========================================================================*
 * ctor
 *==========================================================================*/
GetTaskQuery::GetTaskQuery(std::shared_ptr<domain::repositories::ITaskReadRepository> repository,
                           std::shared_ptr<infra::cache::ICache>                    cache,
                           std::shared_ptr<infra::logging::ILogger>                logger,
                           std::shared_ptr<infra::metrics::IMetricsCollector>      metrics,
                           std::shared_ptr<infra::tracing::ITracer>                tracer)
    : repository_{std::move(repository)}
    , cache_      {std::move(cache)}
    , logger_     {std::move(logger)}
    , metrics_    {std::move(metrics)}
    , tracer_     {std::move(tracer)}
{
    if (!repository_ || !cache_ || !logger_ || !metrics_ || !tracer_) {
        throw std::invalid_argument(
            "GetTaskQuery: all dependencies must be non-null shared_ptrs");
    }
}

/*==========================================================================*
 * operator() – Use-case entry point
 *==========================================================================*/
std::optional<TaskDto> GetTaskQuery::operator()(const Request& request) const
{
    // --------------------- Basic input validation -------------------------
    if (request.taskId.empty()) {
        logger_->warn("GetTaskQuery rejected request: empty taskId");
        metrics_->incrementCounter("chrono_flow_get_task_rejected_total");
        throw std::invalid_argument("taskId must not be empty");
    }

    // ----------------------------- Tracing --------------------------------
    std::unique_ptr<infra::tracing::ISpan> span =
        tracer_->startSpan("GetTaskQuery::execute",
                           {{"task.id", request.taskId},
                            {"analytics", request.includeAnalytics}});

    // ----------------------- Observe / start timer ------------------------
    const auto start = std::chrono::steady_clock::now();
    metrics_->incrementCounter("chrono_flow_get_task_total");

    // --------------------------- Cache lookup -----------------------------
    const std::string cacheKey = buildCacheKey(request.taskId, request.includeAnalytics);

    if (auto cached = cache_->template get<TaskDto>(cacheKey); cached.has_value()) {
        metrics_->incrementCounter("chrono_flow_get_task_cache_hit_total");
        span->setAttribute("cache_hit", true);
        span->end();
        return cached;
    }

    span->setAttribute("cache_hit", false);

    // ----------------------- Repository delegation ------------------------
    std::optional<Task> task = repository_->findById(request.taskId);
    if (!task) {
        metrics_->incrementCounter("chrono_flow_get_task_not_found_total");
        span->addEvent("task_not_found");
        span->end();
        return std::nullopt; // 404 – handled by transport layer
    }

    // --------------------------- Mapping DTO ------------------------------
    TaskDto dto = TaskDto::fromDomain(*task, request.includeAnalytics);

    // ---------------------------- Caching ---------------------------------
    constexpr auto kTtl = std::chrono::minutes(5);
    try {
        cache_->put(cacheKey, dto, kTtl);
    } catch (const std::exception& ex) {
        // Cache failures must not impact the request path
        logger_->error("GetTaskQuery cache put failed: {}", ex.what());
        span->addEvent("cache_put_error");
    }

    // ---------------------- Metrics & tracing -----------------------------
    const auto duration = std::chrono::steady_clock::now() - start;
    metrics_->recordHistogram("chrono_flow_get_task_latency_ms",
                              std::chrono::duration_cast<std::chrono::milliseconds>(duration)
                                  .count());
    span->setAttribute("latency_ms",
                       static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                               duration)
                                               .count()));
    span->end();

    return dto;
}

} // namespace chrono_flow_nexus::application::queries
```