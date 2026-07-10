#ifndef CHRONO_FLOW_NEXUS_APPLICATION_ANALYTICS_SERVICE_H
#define CHRONO_FLOW_NEXUS_APPLICATION_ANALYTICS_SERVICE_H

/**
 * ChronoFlow Nexus
 * ----------------
 * application/analytics_service.h
 *
 * A small, self-contained service-layer component that aggregates raw
 * domain events (TaskRecord) into higher-level productivity insights,
 * such as focus score and context-switch frequency.  The service is
 * intentionally header-only so that it can be included in multiple DSOs
 * (REST handlers, GraphQL resolvers, background jobs) without requiring
 * a separate compilation unit.
 *
 * NOTE:
 *  • The classes declared in the `domain` namespace act as *ports*
 *    (per Hexagonal/Onion architectures).  Concrete implementations
 *    reside in the infrastructure layer and are injected at runtime.
 *  • A *very lightweight* in-memory cache with per-item TTL is embedded
 *    to avoid hammering the repository when multiple requests ask for
 *    the same time window.  In production you would swap this out for
 *    Redis or Memcached, but the interface is deliberately minimal.
 */

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <ratio>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chrono_flow_nexus
{
namespace domain
{

/**
 * A raw time-tracking record persisted by the infrastructure layer.
 * start … inclusive
 * end   … exclusive
 */
struct TaskRecord
{
    std::chrono::system_clock::time_point start;
    std::chrono::system_clock::time_point end;
    std::string                             category;     // e.g. "development", "meeting", "break"
};

/**
 * Repository port responsible for retrieving persisted TaskRecord
 * entities.  Implementations MAY source data from a SQL DB, a time-series
 * store like InfluxDB, or an event stream (Kafka, Pulsar, …).
 */
class ITaskRepository
{
public:
    virtual ~ITaskRepository() = default;

    /**
     * Fetch all task records for [from, to) where userId == userId.
     * The contract guarantees stable ordering by `start` asc.
     */
    virtual std::vector<TaskRecord>
    fetchTasks(const std::string&                         userId,
               std::chrono::system_clock::time_point      from,
               std::chrono::system_clock::time_point      to) = 0;
};

} // namespace domain

namespace infrastructure
{

/**
 * Extremely lightweight, thread-safe cache with per-item TTL.  The goal
 * is to protect downstream repositories from hot-path re-computation,
 * not to provide a distributed, fault-tolerant cache layer.
 */
template <typename Key, typename Value>
class TTLCache
{
public:
    using clock      = std::chrono::steady_clock;
    using time_point = clock::time_point;
    using seconds    = std::chrono::seconds;

    explicit TTLCache(seconds ttl) : _ttl(ttl) {}

    void put(Key key, Value value)
    {
        const auto expiry = clock::now() + _ttl;

        {
            std::unique_lock lk{_mtx};
            _store.emplace(std::move(key), CacheEntry{std::move(value), expiry});
        }
        _purgeExpired(); // opportunistic cleanup
    }

    std::optional<Value> get(const Key& key)
    {
        std::shared_lock lk{_mtx};

        const auto it = _store.find(key);
        if (it == _store.end()) { return std::nullopt; }

        if (clock::now() >= it->second.expiry)
        {
            // expired
            lk.unlock();
            std::unique_lock wlk{_mtx};
            _store.erase(key);
            return std::nullopt;
        }

        return it->second.value;
    }

private:
    struct CacheEntry
    {
        Value      value;
        time_point expiry;
    };

    void _purgeExpired()
    {
        std::unique_lock lk{_mtx};
        const auto now = clock::now();
        for (auto it = _store.begin(); it != _store.end();)
        {
            if (now >= it->second.expiry)
            {
                it = _store.erase(it);
            }
            else { ++it; }
        }
    }

    std::unordered_map<Key, CacheEntry> _store;
    seconds                              _ttl;
    mutable std::shared_mutex            _mtx;
};

} // namespace infrastructure

namespace application
{

/**
 * Aggregate analytics produced from task records.
 */
struct FocusMetrics
{
    double                                   focusScore;         // 0.0 – 100.0
    std::chrono::seconds                     deepWorkDuration;   // time spent in deep work
    std::chrono::seconds                     totalTracked;       // total tracked time
    std::chrono::seconds                     contextSwitchTime;  // idle / switch overhead
};

/**
 * Service-layer abstraction that encapsulates all analytic operations.
 * Thread-safe and ready to be wired into both REST and GraphQL handlers.
 */
class AnalyticsService
{
public:
    using Clock        = std::chrono::system_clock;
    using TimePoint    = Clock::time_point;
    using Seconds      = std::chrono::seconds;
    using TimeSeries   = std::vector<std::pair<TimePoint, double>>; // ts -> focusScore

    explicit AnalyticsService(std::shared_ptr<domain::ITaskRepository> repo,
                              Seconds                                   cacheTtl = Seconds{60})
        : _repo(std::move(repo)), _cache(cacheTtl)
    {
        if (!_repo) { throw std::invalid_argument("repo must not be null"); }
    }

    /**
     * Calculate focus metrics for a single user over a specific period.
     */
    FocusMetrics computeFocusMetrics(const std::string& userId,
                                     TimePoint          from,
                                     TimePoint          to)
    {
        const CacheKey key{userId, from, to};

        // Fast path – check cache
        if (auto cached = _cache.get(key)) { return *cached; }

        // 1. Fetch data from repository (I/O)
        const auto records = _repo->fetchTasks(userId, from, to);

        // 2. Compute metrics
        const auto metrics = _deriveMetrics(records);

        // 3. Cache result
        _cache.put(key, metrics);

        return metrics;
    }

    /**
     * Produce a time series of daily focus scores for [from, to).
     * The time granularity is 1 day by default but can be customized.
     */
    TimeSeries computeDailyFocusSeries(const std::string& userId,
                                       TimePoint          from,
                                       TimePoint          to,
                                       Seconds            step = Seconds{24 * 60 * 60})
    {
        if (from >= to) { throw std::invalid_argument("from must be < to"); }
        if (step.count() <= 0) { throw std::invalid_argument("step must be positive"); }

        TimeSeries series;
        TimePoint  cursor = from;

        while (cursor < to)
        {
            const auto windowEnd = std::min(cursor + step, to);
            const auto m         = computeFocusMetrics(userId, cursor, windowEnd);

            series.emplace_back(cursor, m.focusScore);
            cursor = windowEnd;
        }
        return series;
    }

private:
    /* ---------- INTERNAL TYPES ---------- */

    struct CacheKey
    {
        std::string userId;
        TimePoint   from;
        TimePoint   to;

        bool operator==(const CacheKey& rhs) const noexcept
        {
            return userId == rhs.userId && from == rhs.from && to == rhs.to;
        }
    };

    struct CacheKeyHasher
    {
        std::size_t operator()(const CacheKey& k) const noexcept
        {
            constexpr std::size_t prime = 31;
            std::size_t            h    = std::hash<std::string>{}(k.userId);
            h                           = h * prime + std::hash<std::uint64_t>{}(k.from.time_since_epoch().count());
            h                           = h * prime + std::hash<std::uint64_t>{}(k.to.time_since_epoch().count());
            return h;
        }
    };

    /* ---------- METRIC COMPUTATION ---------- */

    static FocusMetrics _deriveMetrics(const std::vector<domain::TaskRecord>& records)
    {
        using namespace std::chrono;

        FocusMetrics m{};
        if (records.empty()) { return m; }

        seconds totalTracked{};
        seconds deepWork{};
        seconds contextSwitch{};

        // Business rule:
        //  – deep work block >= 25 min AND category != "meeting" / "break"
        //  – context switch is 5 min gap between tasks or category == "break"
        const auto isDeepWork = [](const domain::TaskRecord& r) {
            constexpr auto minDeepMinutes = minutes{25};
            const auto     duration       = duration_cast<minutes>(r.end - r.start);
            const bool     isMeeting      = r.category == "meeting" || r.category == "break";
            return duration >= minDeepMinutes && !isMeeting;
        };

        TimePoint prevEnd{records.front().start};

        for (const auto& r : records)
        {
            const auto dur = duration_cast<seconds>(r.end - r.start);
            totalTracked += dur;

            if (isDeepWork(r)) { deepWork += dur; }

            // gap between end(prev) and start(curr)
            if (r.start > prevEnd)
            {
                const auto gap = duration_cast<seconds>(r.start - prevEnd);
                if (gap > seconds{0} && gap <= minutes{15}) { contextSwitch += gap; }
            }
            prevEnd = r.end;
        }

        // Focus Score formula:
        // (deepWork / totalTracked) * 100  –  (contextSwitch / totalTracked) * 50
        if (totalTracked.count() > 0)
        {
            const double deepPct   = static_cast<double>(deepWork.count()) / totalTracked.count();
            const double switchPct = static_cast<double>(contextSwitch.count()) / totalTracked.count();
            const double raw       = (deepPct * 100.0) - (switchPct * 50.0);

            m.focusScore = std::clamp(raw, 0.0, 100.0);
        }
        m.deepWorkDuration  = deepWork;
        m.totalTracked      = totalTracked;
        m.contextSwitchTime = contextSwitch;

        return m;
    }

    /* ---------- DATA MEMBERS ---------- */

    std::shared_ptr<domain::ITaskRepository>                                        _repo;
    infrastructure::TTLCache<CacheKey, FocusMetrics, CacheKeyHasher>               _cache;
};

} // namespace application
} // namespace chrono_flow_nexus

#endif /* CHRONO_FLOW_NEXUS_APPLICATION_ANALYTICS_SERVICE_H */
