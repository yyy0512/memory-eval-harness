```cpp
/**
 * chrono_flow_nexus/src/application/queries/get_analytics_query.cpp
 *
 * Copyright (c) 2024 ChronoFlow
 *
 * Implementation of GetAnalyticsQuery and GetAnalyticsQueryHandler.
 *
 * The query collects productivity analytics such as time-on-task, context
 * switch frequency, and workload insights.  It demonstrates how the
 * application-layer “query” side interacts with infrastructure services
 * (repository, cache, logging, metrics) while keeping domain logic isolated.
 */

#include <chrono>
#include <functional>
#include <optional>
#include <sstream>
#include <string>
#include <utility>

#include "application/queries/get_analytics_query.h"

#include "application/exceptions/application_exceptions.h"
#include "domain/repositories/analytics_repository.h"
#include "infrastructure/cache/cache_provider.h"
#include "infrastructure/logging/logger.h"
#include "infrastructure/metrics/metrics_collector.h"
#include "infrastructure/tracing/trace_span.h"

namespace chrono_flow::application::queries
{

// ─────────────────────────────────────────────────────────────────────────────
//  GetAnalyticsQuery
// ─────────────────────────────────────────────────────────────────────────────
GetAnalyticsQuery::GetAnalyticsQuery(Parameters params)
    : params_(std::move(params))
{
    // Cheap validation to avoid expensive processing later on.
    if (!params_.time_range.has_value())
    {
        throw validation_error("GetAnalyticsQuery::Parameters.time_range is required");
    }

    if (params_.time_range->end < params_.time_range->start)
    {
        throw validation_error("GetAnalyticsQuery::Parameters.time_range.end < start");
    }
}

const GetAnalyticsQuery::Parameters& GetAnalyticsQuery::params() const noexcept
{
    return params_;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GetAnalyticsQueryHandler
// ─────────────────────────────────────────────────────────────────────────────
GetAnalyticsQueryHandler::GetAnalyticsQueryHandler(
    std::shared_ptr<domain::repositories::IAnalyticsRepository>          repository,
    std::shared_ptr<infrastructure::cache::ICacheProvider>               cache,
    std::shared_ptr<infrastructure::logging::ILogger>                    logger,
    std::shared_ptr<infrastructure::metrics::IMetricsCollector>          metrics)
    : repository_(std::move(repository))
    , cache_(std::move(cache))
    , logger_(std::move(logger))
    , metrics_(std::move(metrics))
{
    if (!repository_ || !cache_ || !logger_ || !metrics_)
    {
        throw std::invalid_argument(
            "GetAnalyticsQueryHandler - ctor received null dependency");
    }
}

// Generates a stable, collision-resistant cache key for the query.
static std::string
build_cache_key(const GetAnalyticsQuery& query)
{
    std::stringstream ss;
    const auto& p = query.params();

    ss << "analytics:"
       << std::chrono::duration_cast<std::chrono::seconds>(
              p.time_range->start.time_since_epoch())
              .count()
       << '-'
       << std::chrono::duration_cast<std::chrono::seconds>(
              p.time_range->end.time_since_epoch())
              .count();

    if (p.user_ids.has_value())
    {
        for (const auto& uid : *p.user_ids) { ss << ':' << uid; }
    }

    ss << ':' << p.include_workload_insights
       << ':' << p.include_context_switches;

    return ss.str();
}

domain::dto::AnalyticsDto
GetAnalyticsQueryHandler::handle(const GetAnalyticsQuery& query,
                                 const CancellationToken& cancel)
{
    auto span = infrastructure::tracing::TraceSpan::create(
        "GetAnalyticsQueryHandler::handle");

    const auto start_timer = std::chrono::steady_clock::now();
    metrics_->increment_counter("analytics_query_total");

    try
    {
        // 1. Fast path: check response cache
        const auto cache_key = build_cache_key(query);
        if (auto cached = cache_->get<domain::dto::AnalyticsDto>(cache_key))
        {
            metrics_->increment_counter("analytics_query_cache_hit");
            logger_->info("Cache hit for key={}", cache_key);
            return *cached;
        }

        metrics_->increment_counter("analytics_query_cache_miss");
        logger_->debug("Cache miss, key={}", cache_key);

        // 2. Pull data from repository (potentially expensive)
        if (cancel.is_cancellation_requested())
        {
            throw operation_cancelled("GetAnalyticsQueryHandler - cancelled");
        }

        domain::repository::AnalyticsCriteria criteria;
        criteria.time_range              = *query.params().time_range;
        criteria.user_ids                = query.params().user_ids;
        criteria.include_workload        = query.params().include_workload_insights;
        criteria.include_context_switch  = query.params().include_context_switches;

        auto analytics = repository_->aggregate(criteria, cancel);

        // 3. Cache the result (TTL: 10 seconds under heavy traffic, else 60)
        const std::chrono::seconds ttl =
            analytics.rows > 10'000
                ? std::chrono::seconds{10}
                : std::chrono::seconds{60};

        cache_->put(cache_key, analytics, ttl);

        // 4. Record execution time
        const auto end_timer = std::chrono::steady_clock::now();
        const auto latency =
            std::chrono::duration_cast<std::chrono::milliseconds>(end_timer
                                                                  - start_timer)
                .count();
        metrics_->observe_histogram("analytics_query_latency_ms", latency);

        logger_->info("Analytics query handled ({} ms, rows={})",
                      latency, analytics.rows);

        return analytics;
    }
    catch (const std::exception& ex)
    {
        metrics_->increment_counter("analytics_query_error");
        logger_->error("Failed to handle GetAnalyticsQuery: {}", ex.what());
        throw; // Let caller translate to transport-layer error
    }
}

} // namespace chrono_flow::application::queries
```