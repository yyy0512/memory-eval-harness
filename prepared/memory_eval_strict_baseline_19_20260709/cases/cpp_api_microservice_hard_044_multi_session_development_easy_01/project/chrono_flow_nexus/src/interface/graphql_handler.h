```cpp
/**
 * chrono_flow_nexus/src/interface/graphql_handler.h
 *
 * Copyright (c) 2024 ChronoFlow
 *
 * A high-level GraphQL entry-point for ChronoFlow Nexus.
 *
 * Thread-safe, cache-aware, and rate-limited request execution
 * targeted for use by the transport layer (e.g. HTTP server /
 * API-Gateway façade).  Although this header is self-contained
 * and therefore directly usable in unit-tests, in production the
 * actual application-specific resolvers are injected via the
 * IQueryExecutor interface.
 */

#pragma once

// STD
#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

// 3rd-party
#include <nlohmann/json.hpp>

namespace chrono_flow::interface
{

/* ============================================================================
 *  Helper data-structures
 * ==========================================================================*/

/**
 * GraphQLRequest
 *
 * Plain-old-data container mirroring the JSON GraphQL wire-format:
 *
 * {
 *   "query"         : "...",
 *   "operationName" : "...",
 *   "variables"     : { ... }
 * }
 *
 * The id field is an internal optimisation hint added by ChronoFlow to
 * improve cache hit accuracy when persisted queries are enabled.
 */
struct GraphQLRequest
{
    std::string           id;
    std::string           query;
    std::string           operationName;
    nlohmann::json        variables;

    // Convenience factory from a JSON payload delivered by the transport.
    static GraphQLRequest from_json(const nlohmann::json& payload)
    {
        GraphQLRequest req;
        if (payload.contains("id"))            req.id            = payload["id"].get<std::string>();
        if (payload.contains("query"))         req.query         = payload["query"].get<std::string>();
        if (payload.contains("operationName")) req.operationName = payload["operationName"].get<std::string>();
        if (payload.contains("variables"))     req.variables     = payload["variables"];
        return req;
    }
};

/**
 * ClientContext
 *
 * Additional request metadata injected by the transport layer
 * (e.g. http headers, source IP, authN claims …).
 */
struct ClientContext
{
    std::string  sourceAddress;      // IPv4 / IPv6
    std::string  userAgent;          // http-User-Agent header
    std::string  authSubject;        // decoded user-id / service-id
};

/* ============================================================================
 *  Observability contracts
 * ==========================================================================*/

class ILogger
{
public:
    virtual ~ILogger() = default;

    virtual void info (std::string_view msg)                                 = 0;
    virtual void warn (std::string_view msg)                                 = 0;
    virtual void error(std::string_view msg, const std::exception* e = nullptr) = 0;
};

/* ============================================================================
 *  Rate-Limiting
 * ==========================================================================*/

/**
 * IRateLimiter
 *
 * Microscopic interface enabling alternate implementations
 * (Redis-based, envoy-extern-auth, etc.).
 */
class IRateLimiter
{
public:
    virtual ~IRateLimiter() = default;

    // Returns true if the request MAY proceed.
    virtual bool allow(const std::string& clientKey) = 0;
};

/**
 * A small, thread-safe token-bucket implementation that stores its buckets
 * in-memory.  Meant for development / single-instance deployments only.
 */
class LocalTokenBucketLimiter final : public IRateLimiter
{
public:
    struct Config
    {
        std::size_t  capacity        = 50;  // max tokens / window
        std::size_t  refillPerSecond = 10;  // token refill speed
    };

    explicit LocalTokenBucketLimiter(Config cfg = {})
        : _cfg(cfg)
    {}

    bool allow(const std::string& clientKey) override
    {
        using namespace std::chrono;

        const auto now = steady_clock::now();

        std::lock_guard lk(_mtx);

        auto& bucket = _buckets[clientKey];
        if (!bucket.initialised)
        {
            bucket.tokens      = _cfg.capacity;
            bucket.lastRefill  = now;
            bucket.initialised = true;
        }

        // refill
        {
            const auto elapsed =
                duration_cast<seconds>(now - bucket.lastRefill).count();
            if (elapsed > 0)
            {
                const std::size_t refill =
                    static_cast<std::size_t>(elapsed) * _cfg.refillPerSecond;
                bucket.tokens = std::min<std::size_t>(
                    _cfg.capacity, bucket.tokens + refill);
                bucket.lastRefill = now;
            }
        }

        // try to acquire
        if (bucket.tokens == 0)
        {
            return false;
        }
        bucket.tokens--;
        return true;
    }

private:
    struct Bucket
    {
        bool                             initialised{false};
        std::size_t                      tokens{0};
        std::chrono::steady_clock::time_point lastRefill;
    };

    const Config                                      _cfg;
    std::unordered_map<std::string, Bucket>           _buckets;
    std::mutex                                        _mtx;
};

/* ============================================================================
 *  Caching
 * ==========================================================================*/

/**
 * ILRUCache – minimalistic generic interface for response caching.
 *
 * Key type is std::string (hash of query+variables), Value is nlohmann::json.
 */
class ILRUCache
{
public:
    virtual ~ILRUCache() = default;

    virtual bool            contains(const std::string& key) const           = 0;
    virtual std::optional<nlohmann::json>
                            get(const std::string& key) const                = 0;
    virtual void            put(const std::string& key, nlohmann::json body) = 0;
};

/**
 * Thread-safe LRU cache with a very small footprint (spin-lock free).
 *
 * NOT a fully featured LRU (evicts the oldest on overflow).  Good enough
 * for demonstration purposes.
 */
class LocalLRUCache final : public ILRUCache
{
public:
    explicit LocalLRUCache(std::size_t maxSize = 512)
        : _maxEntries(maxSize)
    {}

    bool contains(const std::string& key) const override
    {
        std::shared_lock rlk(_rw);
        return _data.find(key) != _data.end();
    }

    std::optional<nlohmann::json> get(const std::string& key) const override
    {
        std::shared_lock rlk(_rw);
        auto it = _data.find(key);
        if (it == _data.end())
            return std::nullopt;
        return it->second;
    }

    void put(const std::string& key, nlohmann::json body) override
    {
        std::unique_lock wlk(_rw);

        if (_data.size() >= _maxEntries)
        {
            // Evict an arbitrary (oldest) element: front of map.
            _data.erase(_data.begin());
        }
        _data[key] = std::move(body);
    }

private:
    const std::size_t                                   _maxEntries;
    std::unordered_map<std::string, nlohmann::json>     _data;
    mutable std::shared_mutex                           _rw;
};

/* ============================================================================
 *  Query Execution abstraction
 * ==========================================================================*/

/**
 * IQueryExecutor
 *
 * Domain/application level contract.  The GraphQLHandler delegates the
 * actual resolver mapping to this interface, allowing us to remain 100 %
 * agnostic with respect to the business rules and persistence concerns.
 *
 * NOTE: The use of nlohmann::json keeps the boundary flexible and avoids
 *       leaking GraphQL specific types upward in the architecture.
 */
class IQueryExecutor
{
public:
    virtual ~IQueryExecutor() = default;

    /**
     * Executes a validated GraphQL query.
     *
     * The implementation can assume that:
     *   • `query` is syntactically correct.
     *   • rate-limits have been enforced by GraphQLHandler.
     *   • variable coercion was already applied.
     */
    virtual nlohmann::json
    execute(const GraphQLRequest& request, const ClientContext& ctx) = 0;
};

/* ============================================================================
 *  GraphQLHandler
 * ==========================================================================*/

/**
 * GraphQLHandler
 *
 * This class sits at the API edge.  Responsibilities:
 *   1. Parse and basic validation of GraphQL envelopes.
 *   2. Rate-limit through IRateLimiter.
 *   3. Response caching (operation/variables keyed).
 *   4. Dispatch to application-layer resolvers (IQueryExecutor).
 *   5. Translate failure modes into GraphQL compliant error payloads.
 *
 * Thread-safe (read-only members, delegated concurrency handled by
 * collaborators).
 */
class GraphQLHandler final
{
public:
    struct Config
    {
        bool            enableCaching  = true;
        bool            persistErrors  = false; // Should errors be cached?
    };

    GraphQLHandler(std::shared_ptr<IQueryExecutor> exec,
                   std::shared_ptr<IRateLimiter>  limiter,
                   std::shared_ptr<ILRUCache>     cache,
                   std::shared_ptr<ILogger>       logger,
                   Config cfg = {})
        : _executor(std::move(exec))
        , _limiter (std::move(limiter ))
        , _cache   (std::move(cache   ))
        , _logger  (std::move(logger  ))
        , _cfg     (cfg)
    {
        if (!_executor || !_limiter || !_cache || !_logger)
        {
            throw std::invalid_argument(
                "GraphQLHandler: all collaborators must be non-null");
        }
    }

    /**
     * Main entry point.
     * Returns a JSON body conforming to the GraphQL response spec.
     */
    [[nodiscard]]
    nlohmann::json handle(const GraphQLRequest& request,
                          const ClientContext&  ctx)
    {
        const auto cacheKey = makeCacheKey(request, ctx);

        // 1. lookup cache (if enabled)
        if (_cfg.enableCaching)
        {
            if (const auto cached = _cache->get(cacheKey); cached)
            {
                _logger->info("[GraphQL] 200 Ok (cache-hit)");
                return *cached;
            }
        }

        // 2. enforce rate-limits
        if (!_limiter->allow(clientIdentifier(ctx)))
        {
            return buildRateLimitError();
        }

        // 3. Validate (syntactic)
        if (request.query.empty())
        {
            return buildClientError("Query must not be empty");
        }

        // TODO: integrate full GraphQL validation once 3rd-party parser is linked.

        // 4. Execute
        nlohmann::json response;
        try
        {
            const auto start = std::chrono::steady_clock::now();

            response = _executor->execute(request, ctx);

            const auto latency =
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - start).count();

            // Observability
            {
                std::ostringstream oss;
                oss << "[GraphQL] 200 Ok"
                    << " op=" << request.operationName
                    << " latency=" << latency << "ms";
                _logger->info(oss.str());
            }
        }
        catch (const std::exception& e)
        {
            _logger->error("[GraphQL] resolver threw", &e);
            response = buildServerError(e.what());
        }

        // 5. Cache
        if (_cfg.enableCaching)
        {
            const bool okResponse =
                !response.contains("errors") || _cfg.persistErrors;
            if (okResponse)
            {
                _cache->put(cacheKey, response);
            }
        }

        return response;
    }

private:
    /* ------------------------------------------------------------
     * Helpers
     * ---------------------------------------------------------- */

    // Creates a deterministic key (hash) based on the operation + variables.
    static std::string makeCacheKey(const GraphQLRequest& req,
                                    const ClientContext&)
    {
        std::string combined = req.id + '#' + req.operationName + '#' + req.query
                             + '#' + req.variables.dump();
        // Fowler–Noll–Vo hash (FNV-1a) – cheap and available.
        std::uint64_t hash = 14695981039346656037ULL; // offset basis
        for (unsigned char c : combined)
        {
            hash ^= c;
            hash *= 1099511628211ULL;
        }
        std::ostringstream oss;
        oss << std::hex << hash;
        return oss.str();
    }

    static std::string clientIdentifier(const ClientContext& ctx)
    {
        // For now use IP address; might include authSubject later.
        return ctx.sourceAddress;
    }

    static nlohmann::json buildRateLimitError()
    {
        return {
            { "errors", {
                { { "message", "Too many requests – slow down." },
                  { "extensions", {
                        { "code", "RATE_LIMIT_EXCEEDED"}
                    } }
                }
            } }
        };
    }

    static nlohmann::json buildClientError(std::string_view msg)
    {
        return {
            { "errors", {
                { { "message", msg.data() },
                  { "extensions", { { "code", "BAD_USER_INPUT"} } }
                }
            } }
        };
    }

    static nlohmann::json buildServerError(std::string_view msg)
    {
        return {
            { "errors", {
                { { "message", "Internal server error" },
                  { "extensions", { { "code", "INTERNAL_SERVER_ERROR"},
                                    { "details", msg.data() } } }
                }
            } }
        };
    }

private:
    const std::shared_ptr<IQueryExecutor> _executor;
    const std::shared_ptr<IRateLimiter>   _limiter;
    const std::shared_ptr<ILRUCache>      _cache;
    const std::shared_ptr<ILogger>        _logger;
    const Config                          _cfg;
};

} // namespace chrono_flow::interface
```