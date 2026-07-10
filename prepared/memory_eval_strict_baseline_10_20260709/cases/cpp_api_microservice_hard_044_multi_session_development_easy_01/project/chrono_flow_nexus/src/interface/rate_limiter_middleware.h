#pragma once
/**
 * chrono_flow_nexus/src/interface/rate_limiter_middleware.h
 *
 * Copyright (c) ChronoFlow
 *
 * The rate-limiter middleware sits in the HTTP / GraphQL interface layer
 * and guards the API surface against traffic bursts while collecting
 * operational metrics.  It is implemented as a generic, header-only
 * component so that it can be easily composed into different transport
 * stacks (e.g. Pistache, Boost.Beast, custom GRPC interceptors).
 *
 * The design is based on a token-bucket algorithm with:
 *   – A configurable refill-rate (tokens per time-slice)
 *   – A burst capacity
 *   – Per-client / API-key isolation
 *
 * Thread-safety is mandatory because the middleware may be shared across
 * worker threads that process requests concurrently.
 */

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>

namespace chrono_flow::interface
{
/* Forward declarations for loosely-coupled metrics / logging back-ends.
 * Concrete implementations are provided in the infrastructure layer.
 */
namespace metrics
{
struct IMetricsRegistry
{
    virtual ~IMetricsRegistry() = default;

    virtual void inc_counter(const std::string& name,
                             std::int64_t value = 1) noexcept = 0;
    virtual void observe_histogram(const std::string& name,
                                   double                value) noexcept = 0;
};
} // namespace metrics

namespace logging
{
struct ILogger
{
    virtual ~ILogger() = default;

    virtual void info(const std::string& msg) noexcept  = 0;
    virtual void warn(const std::string& msg) noexcept  = 0;
    virtual void error(const std::string& msg) noexcept = 0;
};
} // namespace logging

/**
 * RateLimiterMiddleware
 * ---------------------
 * A pluggable middleware that can be injected into any request handling
 * pipeline.  The operator()(Request, Response, Next) call signature
 * matches the "Onion" middleware pattern used by popular frameworks.
 *
 * The middleware is header-only because Request / Response / Next are
 * template parameters that depend on the surrounding stack.
 */
class RateLimiterMiddleware final
{
  public:
    /**
     * Config
     * ------
     * requests_per_unit : How many requests are allowed during a single
     *                     time window *without* consuming burst capacity.
     * burst_capacity    : Additional tokens that allow short-lived spikes.
     * time_unit         : The logical window length for the above rate.
     *
     * key_resolver      : Extracts the "client identifier" from the
     *                     incoming request.  Example: IP address, API key,
     *                     OAuth subject, etc.
     */
    struct Config
    {
        std::size_t                                           requests_per_unit   = 100;
        std::size_t                                           burst_capacity      = 20;
        std::chrono::milliseconds                             time_unit           = std::chrono::seconds(1);
        std::function<std::string(const void* /*Request*/ )> key_resolver        = nullptr;
    };

    RateLimiterMiddleware(Config                                 cfg,
                          std::shared_ptr<metrics::IMetricsRegistry> metrics = nullptr,
                          std::shared_ptr<logging::ILogger>          logger  = nullptr)
        : cfg_{std::move(cfg)}
        , metrics_{std::move(metrics)}
        , logger_{std::move(logger)}
    {
        if (!cfg_.key_resolver)
        {
            // Fallback: treat all traffic as one "client".
            cfg_.key_resolver = [](const void*) { return std::string{"__global"}; };
        }
    }

    RateLimiterMiddleware(const RateLimiterMiddleware&)            = delete;
    RateLimiterMiddleware& operator=(const RateLimiterMiddleware&) = delete;
    RateLimiterMiddleware(RateLimiterMiddleware&&)                 = delete;
    RateLimiterMiddleware& operator=(RateLimiterMiddleware&&)      = delete;

    ~RateLimiterMiddleware() = default;

    /**
     * operator()
     * ----------
     * Generic middleware entry point.  Compatible with most pipeline
     * libraries that accept a `Next` functor/lambda.
     *
     * Request  : Transport-specific immutable request type
     * Response : Transport-specific mutable response type
     * Next     : Callable to advance execution down the chain
     */
    template <typename Request, typename Response, typename Next>
    void operator()(const Request& req, Response& res, Next&& next)
    {
        const auto now           = Clock::now();
        const auto client_key    = cfg_.key_resolver(static_cast<const void*>(&req));
        const bool allowed       = try_consume_token(client_key, now);

        if (allowed)
        {
            // Proceed to the next middleware / handler
            next();
        }
        else
        {
            // Throttle: respond with HTTP 429 or protocol-specific error
            set_too_many_requests_response(res);

            if (logger_)
            {
                logger_->warn("Rate limiter blocked request from client=" + client_key);
            }
            if (metrics_)
            {
                metrics_->inc_counter("rate_limiter.blocked");
            }
        }
    }

    /**
     * Manually clears the internal state.  Useful in tests or when the
     * administrator signals that certain clients should be released.
     */
    void reset()
    {
        std::unique_lock lock{buckets_mutex_};
        buckets_.clear();
    }

  private:
    using Clock      = std::chrono::steady_clock;
    using TimePoint  = Clock::time_point;

    struct Bucket
    {
        std::atomic<std::size_t> tokens;
        TimePoint                last_refill;
        std::mutex               mtx; // Protects refill logic
    };

    // ---------------------------------------------------------------------
    // Implementation details
    // ---------------------------------------------------------------------

    bool try_consume_token(const std::string& client_key, TimePoint now)
    {
        Bucket& bucket = get_or_create_bucket(client_key, now);

        // Exclusive lock for the given bucket to avoid racy refill / consume.
        std::lock_guard lk{bucket.mtx};

        maybe_refill(bucket, now);

        if (bucket.tokens.load(std::memory_order_relaxed) == 0)
        {
            // No available tokens
            return false;
        }

        bucket.tokens.fetch_sub(1, std::memory_order_relaxed);
        return true;
    }

    void maybe_refill(Bucket& bucket, TimePoint now)
    {
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            now - bucket.last_refill);

        if (elapsed >= cfg_.time_unit)
        {
            const auto units_passed = elapsed / cfg_.time_unit;
            const auto refill_tokens =
                units_passed.count() * cfg_.requests_per_unit;

            const std::size_t new_value = std::min<std::size_t>(
                bucket.tokens.load(std::memory_order_relaxed) + refill_tokens,
                cfg_.requests_per_unit + cfg_.burst_capacity);

            bucket.tokens.store(new_value, std::memory_order_relaxed);
            bucket.last_refill += units_passed * cfg_.time_unit;
        }
    }

    Bucket& get_or_create_bucket(const std::string& client_key, TimePoint now)
    {
        {
            std::shared_lock slk{buckets_mutex_};
            auto             it = buckets_.find(client_key);
            if (it != buckets_.end())
            {
                return it->second;
            }
        }

        // Upgrade to unique lock to insert a new bucket
        std::unique_lock ulk{buckets_mutex_};
        auto             [it, inserted] = buckets_.try_emplace(
            client_key,
            Bucket{static_cast<std::size_t>(cfg_.requests_per_unit
                                            + cfg_.burst_capacity),
                   now});

        if (inserted && metrics_)
        {
            metrics_->inc_counter("rate_limiter.bucket_created");
        }
        return it->second;
    }

    template <typename Response>
    static void set_too_many_requests_response(Response& res)
    {
        // Generic implementation assumes Response has:
        //   – status(int)
        //   – body(std::string)
        // This can be specialised by the caller if needed.
        res.status(429);
        res.body("Too Many Requests");
    }

    // ---------------------------------------------------------------------
    // Members
    // ---------------------------------------------------------------------

    Config                                   cfg_;
    std::shared_ptr<metrics::IMetricsRegistry> metrics_;
    std::shared_ptr<logging::ILogger>          logger_;

    std::unordered_map<std::string, Bucket> buckets_;
    mutable std::shared_mutex               buckets_mutex_;
};

} // namespace chrono_flow::interface