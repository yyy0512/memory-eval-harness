```cpp
/***************************************************************************************
 * ChronoFlow Nexus – RedisCache Implementation
 *
 *  File:   chrono_flow_nexus/src/infrastructure/caching/redis_cache.cpp
 *  Author: ChronoFlow Nexus Team
 *
 *  Description:
 *      Production-grade Redis caching implementation used by the ChronoFlow Nexus
 *      micro-service.  The component offers connection-pooling, automatic
 *      instrumentation (metrics + tracing), JSON serialization, and resilient
 *      error-handling so that cache failures never jeopardize the primary code path.
 *
 *  Dependencies:
 *      - redis++ (https://github.com/sewenew/redis-plus-plus)
 *      - hiredis
 *      - nlohmann/json (https://github.com/nlohmann/json)
 *      - spdlog (https://github.com/gabime/spdlog)
 *      - prometheus-cpp (optional, compile-time toggle)
 *      - opentelemetry-cpp (optional, compile-time toggle)
 *
 *  Note:
 *      This source file only defines the implementation.  Corresponding interfaces
 *      and data-structures live in “redis_cache.hpp” and sibling headers.
 ****************************************************************************************/

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <sw/redis++/redis++.h>

#ifdef CHRONOFLOW_ENABLE_PROMETHEUS
#include <prometheus/counter.h>
#include <prometheus/registry.h>
#endif

#ifdef CHRONOFLOW_ENABLE_OTEL
#include <opentelemetry/trace/provider.h>
#endif

#include "infrastructure/caching/redis_cache.hpp"
#include "shared/utils/string_utils.hpp"

namespace chrono::infrastructure::caching {

// -------------------------------------------------------------------------------------------------
// Helper macros
// -------------------------------------------------------------------------------------------------
#ifndef CHRONOFLOW_CACHE_RETRIES
#define CHRONOFLOW_CACHE_RETRIES 2
#endif

// -------------------------------------------------------------------------------------------------
// Metrics helpers (no-op when Prometheus disabled at compile time)
// -------------------------------------------------------------------------------------------------
namespace {
#ifdef CHRONOFLOW_ENABLE_PROMETHEUS
struct PrometheusMetrics {
    prometheus::Family<prometheus::Counter>& cache_requests_family;
    prometheus::Counter& cache_hits;
    prometheus::Counter& cache_misses;
    prometheus::Counter& cache_set;
};

static PrometheusMetrics build_prometheus_metrics()
{
    static auto registry = std::make_shared<prometheus::Registry>();

    auto& request_family = prometheus::BuildCounter()
                               .Name("chronoflow_cache_requests_total")
                               .Help("Total number of cache requests.")
                               .Register(*registry);

    auto& hits = request_family.Add({{"result", "hit"}});
    auto& misses = request_family.Add({{"result", "miss"}});
    auto& set = request_family.Add({{"result", "set"}});

    return {request_family, hits, misses, set};
}
#else
struct PrometheusMetrics {
    void noop() {}
};
static PrometheusMetrics build_prometheus_metrics() { return {}; }
#endif
}  // namespace

// -------------------------------------------------------------------------------------------------
// OpenTelemetry helpers (no-op when OTEL disabled)
// -------------------------------------------------------------------------------------------------
namespace {
#ifdef CHRONOFLOW_ENABLE_OTEL
auto make_span(const std::string& name)
{
    namespace otel = opentelemetry::trace;

    auto provider = otel::Provider::GetTracerProvider();
    auto tracer = provider->GetTracer("chronoflow.redis_cache");
    return tracer->StartSpan(name);
}
#else
struct NullSpan {
    void End() const noexcept {}
};
static NullSpan make_span(const std::string&) { return {}; }
#endif
}  // namespace

// -------------------------------------------------------------------------------------------------
// CTOR / DTOR
// -------------------------------------------------------------------------------------------------
RedisCache::RedisCache(const RedisConfig& cfg)
    : _config{cfg}
    , _metrics{build_prometheus_metrics()}
{
    spdlog::info("RedisCache | Initializing.  host={}, port={}, poolSize={}",
                 _config.host,
                 _config.port,
                 _config.pool_size);

    sw::redis::ConnectionOptions conn_opts;
    conn_opts.host = _config.host;
    conn_opts.port = static_cast<int>(_config.port);
    conn_opts.password = _config.password;
    conn_opts.db = static_cast<int>(_config.database);
    conn_opts.socket_timeout = std::chrono::milliseconds{_config.socket_timeout_ms};

    sw::redis::ConnectionPoolOptions pool_opts;
    pool_opts.size = _config.pool_size;
    pool_opts.wait_timeout = std::chrono::milliseconds{_config.wait_timeout_ms};
    pool_opts.connection_lifetime = std::chrono::seconds{_config.connection_lifetime_s};

    try {
        _redis = std::make_unique<sw::redis::Redis>(conn_opts, pool_opts);
        _redis->ping();
    } catch (const std::exception& ex) {
        spdlog::critical("RedisCache | Failed to establish connection to Redis at {}:{} -> {}",
                         _config.host,
                         _config.port,
                         ex.what());
        throw;  // Surface error upward ‑ the application must decide whether to continue.
    }

    spdlog::info("RedisCache | Successfully initialized Redis connection pool.");
}

RedisCache::~RedisCache() = default;

// -------------------------------------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------------------------------------
namespace {

template <typename T>
[[nodiscard]] inline std::string serialize(const T& value)
{
    return nlohmann::json(value).dump();
}

template <typename T>
[[nodiscard]] inline std::optional<T> deserialize(const std::string& str)
{
    try {
        auto json = nlohmann::json::parse(str);
        return json.get<T>();
    } catch (const std::exception& ex) {
        spdlog::warn("RedisCache | Failed to deserialize JSON payload: {}", ex.what());
        return std::nullopt;
    }
}

}  // namespace

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------
template <typename T>
std::optional<T> RedisCache::get(const std::string& key)
{
    auto span = make_span("RedisCache::get");
    using chrono_clock = std::chrono::steady_clock;
    const auto start_ts = chrono_clock::now();

    try {
        for (std::size_t attempt = 0; attempt <= CHRONOFLOW_CACHE_RETRIES; ++attempt) {
            try {
                auto val = _redis->get(key);
                if (!val) {
#ifdef CHRONOFLOW_ENABLE_PROMETHEUS
                    _metrics.cache_misses.Increment();
#endif
                    return std::nullopt;
                }

#ifdef CHRONOFLOW_ENABLE_PROMETHEUS
                _metrics.cache_hits.Increment();
#endif
                auto result = deserialize<T>(*val);
                return result;
            } catch (const sw::redis::TimeoutError& timeout) {
                if (attempt == CHRONOFLOW_CACHE_RETRIES) {
                    spdlog::error(
                        "RedisCache | Timeout retrieving key='{}' after {} attempts: {}",
                        key,
                        CHRONOFLOW_CACHE_RETRIES + 1,
                        timeout.what());
                    return std::nullopt;  // degrade gracefully
                }
                spdlog::warn(
                    "RedisCache | Timeout retrieving key='{}', attempt {}/{}. Retrying…",
                    key,
                    attempt + 1,
                    CHRONOFLOW_CACHE_RETRIES + 1);
            }
        }
    } catch (const std::exception& ex) {
        spdlog::error("RedisCache | Error retrieving key='{}': {}", key, ex.what());
    }

    const auto latency =
        std::chrono::duration_cast<std::chrono::microseconds>(chrono_clock::now() - start_ts);
    span.End();
    return std::nullopt;
}

template <typename T>
bool RedisCache::set(const std::string& key, const T& value, std::chrono::seconds ttl)
{
    auto span = make_span("RedisCache::set");
    using chrono_clock = std::chrono::steady_clock;
    const auto start_ts = chrono_clock::now();

    const auto body = serialize(value);

    try {
        for (std::size_t attempt = 0; attempt <= CHRONOFLOW_CACHE_RETRIES; ++attempt) {
            try {
                _redis->set(key, body);
                if (ttl.count() > 0) {
                    _redis->expire(key, ttl);
                }
#ifdef CHRONOFLOW_ENABLE_PROMETHEUS
                _metrics.cache_set.Increment();
#endif
                span.End();
                return true;
            } catch (const sw::redis::TimeoutError& timeout) {
                if (attempt == CHRONOFLOW_CACHE_RETRIES) {
                    spdlog::error(
                        "RedisCache | Timeout setting key='{}' after {} attempts: {}",
                        key,
                        CHRONOFLOW_CACHE_RETRIES + 1,
                        timeout.what());
                    span.End();
                    return false;
                }
                spdlog::warn(
                    "RedisCache | Timeout setting key='{}', attempt {}/{}. Retrying…",
                    key,
                    attempt + 1,
                    CHRONOFLOW_CACHE_RETRIES + 1);
            }
        }
    } catch (const std::exception& ex) {
        spdlog::error("RedisCache | Failed to set key='{}': {}", key, ex.what());
    }

    span.End();
    return false;
}

bool RedisCache::invalidate(const std::string& key)
{
    auto span = make_span("RedisCache::invalidate");
    try {
        return _redis->del(key) == 1;
    } catch (const std::exception& ex) {
        spdlog::error("RedisCache | Error invalidating key='{}': {}", key, ex.what());
        return false;  // Never throw from cache invalidation; continue app flow.
    }
}

std::size_t RedisCache::invalidate_namespace(const std::string& prefix)
{
    auto span = make_span("RedisCache::invalidate_namespace");
    try {
        std::size_t removed = 0;
        constexpr std::size_t scan_batch = 1000;

        auto cursor = 0ULL;
        do {
            std::vector<std::string> keys;
            cursor = _redis->scan(cursor, prefix + "*", scan_batch, std::back_inserter(keys));
            if (!keys.empty()) {
                removed += _redis->del(keys.begin(), keys.end());
            }
        } while (cursor != 0ULL);

        spdlog::info("RedisCache | Flushed {} keys with prefix='{}'", removed, prefix);
        return removed;
    } catch (const std::exception& ex) {
        spdlog::error("RedisCache | Error flushing namespace (prefix='{}'): {}", prefix, ex.what());
        return 0;
    }
}

// -------------------------------------------------------------------------------------------------
// Explicit template instantiations
//   – Commonly cached types are instantiated here to avoid linker issues.
// -------------------------------------------------------------------------------------------------
template std::optional<nlohmann::json> RedisCache::get<nlohmann::json>(const std::string& key);
template bool RedisCache::set<nlohmann::json>(const std::string& key,
                                              const nlohmann::json& value,
                                              std::chrono::seconds ttl);

// You can add more explicit instantiations below as needed.
// e.g. template bool RedisCache::set<UserDTO>(…);
// -------------------------------------------------------------------------------------------------

}  // namespace chrono::infrastructure::caching
```
