```cpp
/***************************************************************************************
 * ChronoFlow Nexus
 * File: chrono_flow_nexus/src/application/analytics_service.cpp
 *
 * Description:
 *   Implementation of the AnalyticsService, the application-layer façade that orchestrates
 *   retrieval, aggregation, caching, and publication of productivity-centric KPIs such
 *   as time-on-task, context-switch frequency, and flow-state interruptions.  The service
 *   shields transport layers (REST & GraphQL) from the subtleties of querying the domain
 *   model, while guaranteeing deterministic latency via an in-memory LRU cache and fine-
 *   grained read/write locks.  All queries are versioned and traced so that operations
 *   teams can reproduce historical metrics when auditing SLA compliance.
 *
 * Copyright
 *   © 2024 ChronoFlow Contributors – All rights reserved.
 ****************************************************************************************/

#include "application/analytics_service.hpp"

#include <chrono>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <spdlog/spdlog.h>

using chrono_flow::application::AnalyticsService;

namespace /* anonymous */ {

/*-----------  Small helpers  ---------------------------------------------------------*/

template <typename... Args>
std::string formatKey(Args &&...args)
{
    std::ostringstream oss;
    (oss << ... << args);
    return oss.str();
}

/*-----------  Thread-safe LRU cache  --------------------------------------------------*/

template <typename Key, typename Value>
class LruCache
{
public:
    using clock         = std::chrono::steady_clock;
    using duration_type = std::chrono::milliseconds;

    struct Stats
    {
        std::size_t hits  = 0;
        std::size_t miss  = 0;
        std::size_t evict = 0;
    };

    explicit LruCache(std::size_t capacity,
                      duration_type ttl = std::chrono::minutes(5))
        : _capacity(capacity),
          _ttl(ttl)
    {
        if (_capacity == 0)
            throw std::invalid_argument("LRU cache capacity must be > 0");
    }

    bool get(const Key &key, Value &out)
    {
        std::unique_lock lock(_mtx);
        auto             it = _map.find(key);
        if (it == _map.end())
        {
            ++_stats.miss;
            return false;
        }

        if (clock::now() > it->second.expiry)
        {
            // entry expired – remove it.
            _list.erase(it->second.lruIt);
            _map.erase(it);
            ++_stats.miss;
            return false;
        }

        // promote entry to front of LRU list.
        _list.splice(_list.begin(), _list, it->second.lruIt);
        out = it->second.value;
        ++_stats.hits;
        return true;
    }

    void put(Key key, Value value)
    {
        std::unique_lock lock(_mtx);
        auto             it = _map.find(key);

        if (it != _map.end())
        {
            // Update existing entry.
            it->second.value  = std::move(value);
            it->second.expiry = clock::now() + _ttl;
            _list.splice(_list.begin(), _list, it->second.lruIt);
            return;
        }

        // Evict LRU element if capacity reached.
        if (_map.size() == _capacity)
        {
            const auto &lruKey = _list.back();
            _map.erase(lruKey);
            _list.pop_back();
            ++_stats.evict;
        }

        // Insert new element.
        _list.push_front(key);
        _map.emplace(std::move(key),
                     CacheEntry{ std::move(value), clock::now() + _ttl, _list.begin() });
    }

    Stats stats() const
    {
        std::shared_lock lock(_mtx);
        return _stats;
    }

private:
    struct CacheEntry
    {
        Value                             value;
        clock::time_point                 expiry;
        typename std::list<Key>::iterator lruIt;
    };

    mutable std::shared_mutex                 _mtx;
    std::size_t                               _capacity;
    duration_type                             _ttl;
    std::unordered_map<Key, CacheEntry>       _map;
    std::list<Key>                            _list;
    Stats                                     _stats;
};

} // namespace

/*=====================================================================================
 * AnalyticsService – public API
 *====================================================================================*/

AnalyticsService::AnalyticsService(std::shared_ptr<domain::IWorkSessionRepository>        wsRepo,
                                   std::shared_ptr<domain::IContextSwitchRepository>      csRepo,
                                   std::shared_ptr<domain::IFlowInterruptionRepository>   fiRepo,
                                   std::shared_ptr<infrastructure::IEventDispatcher>      dispatcher,
                                   std::shared_ptr<monitoring::IMetricRegistry>           metrics)
    : _workSessionRepo(std::move(wsRepo)),
      _contextSwitchRepo(std::move(csRepo)),
      _flowInterruptRepo(std::move(fiRepo)),
      _eventDispatcher(std::move(dispatcher)),
      _metricRegistry(std::move(metrics)),
      _cache(2'048 /* entries */, std::chrono::minutes(15))
{
    if (!_workSessionRepo || !_contextSwitchRepo || !_flowInterruptRepo)
        throw std::invalid_argument("AnalyticsService: repositories must not be null");

    spdlog::info("[AnalyticsService] Initialized with LRU cache capacity={} ttl={}min",
                 2'048,
                 15);
}

analytics::TimeOnTask
AnalyticsService::timeOnTask(const common::UUID &userId,
                             std::chrono::system_clock::time_point from,
                             std::chrono::system_clock::time_point to)
{
    const auto key = formatKey("tot:", userId, ':', from.time_since_epoch().count(), ':',
                               to.time_since_epoch().count());
    analytics::TimeOnTask result;
    if (_cache.get(key, result))
    {
        _recordMetric("time_on_task.cache_hit");
        return result;
    }

    _recordMetric("time_on_task.cache_miss");
    const auto sessions = _workSessionRepo->findByUserAndPeriod(userId, from, to);

    std::chrono::milliseconds total{ 0 };
    for (const auto &s : sessions)
        total += s.duration();

    result.userId        = userId;
    result.windowStart   = from;
    result.windowEnd     = to;
    result.totalDuration = total;
    result.sessionCount  = sessions.size();

    _cache.put(key, result);

    // Publish domain event so projections can be updated asynchronously.
    _eventDispatcher->dispatch(domain::events::TimeOnTaskComputed{ result });

    return result;
}

analytics::ContextSwitchFrequency
AnalyticsService::contextSwitchFrequency(const common::UUID &teamId,
                                         std::chrono::system_clock::time_point from,
                                         std::chrono::system_clock::time_point to)
{
    const auto key = formatKey("csf:", teamId, ':', from.time_since_epoch().count(), ':',
                               to.time_since_epoch().count());
    analytics::ContextSwitchFrequency result;
    if (_cache.get(key, result))
    {
        _recordMetric("context_switch.cache_hit");
        return result;
    }

    _recordMetric("context_switch.cache_miss");
    auto switches = _contextSwitchRepo->findByTeamAndPeriod(teamId, from, to);

    result.teamId      = teamId;
    result.windowStart = from;
    result.windowEnd   = to;
    result.count       = switches.size();

    _cache.put(key, result);
    _eventDispatcher->dispatch(domain::events::ContextSwitchFrequencyComputed{ result });

    return result;
}

analytics::FlowInterruptionStats
AnalyticsService::flowInterruptionStats(const common::UUID &projectId,
                                        std::chrono::system_clock::time_point from,
                                        std::chrono::system_clock::time_point to)
{
    const auto key = formatKey("fis:", projectId, ':', from.time_since_epoch().count(), ':',
                               to.time_since_epoch().count());
    analytics::FlowInterruptionStats result;
    if (_cache.get(key, result))
    {
        _recordMetric("flow_interruptions.cache_hit");
        return result;
    }

    _recordMetric("flow_interruptions.cache_miss");
    auto ints = _flowInterruptRepo->findByProjectAndPeriod(projectId, from, to);

    using ms = std::chrono::milliseconds;

    std::size_t              totalCount = ints.size();
    std::chrono::milliseconds totalLoss{ 0 };
    for (const auto &i : ints)
        totalLoss += i.interruptionDuration();

    result.projectId           = projectId;
    result.windowStart         = from;
    result.windowEnd           = to;
    result.interruptionCount   = totalCount;
    result.totalTimeLost       = totalLoss;
    result.avgTimeLostPerEvent = totalCount == 0 ? ms{ 0 } : totalLoss / totalCount;

    _cache.put(key, result);
    _eventDispatcher->dispatch(domain::events::FlowInterruptionComputed{ result });

    return result;
}

/*=====================================================================================
 * Private helpers
 *====================================================================================*/

void AnalyticsService::_recordMetric(std::string_view name) const noexcept
{
    try
    {
        if (_metricRegistry)
            _metricRegistry->counter(name).inc();
    }
    catch (const std::exception &ex)
    {
        spdlog::warn("[AnalyticsService] Failed to record metric '{}': {}", name, ex.what());
    }
}
```