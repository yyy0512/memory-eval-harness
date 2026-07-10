```cpp
// ────────────────────────────────────────────────────────────────────────────────
//  File:     paletteflux_studio/src/api/v1/graphql/GraphQLHandler.h
//  Project:  PaletteFlux GraphQL Studio (api_graphql)
// ────────────────────────────────────────────────────────────────────────────────
//  Description
//  -----------
//  Public façade that exposes a small, self-contained API for executing GraphQL
//  queries inside PaletteFlux.  The handler is intentionally decoupled from the
//  underlying transport (REST controller, WebSocket session, etc.) so that new
//  delivery channels can be added without touching the core execution logic.
//
//  Major Responsibilities
//  ----------------------
//  • Parse and validate GraphQL input coming from an arbitrary client.
//  • Apply instrumentation (metrics, tracing, logging) for each invocation.
//  • Honor tenant-level caching directives using a bounded LRU cache.
//  • Propagate the call to the “service layer” that ultimately talks to the
//    data-source adapters and domain models.
//  • Translate domain / execution errors to RFC-conformant GraphQL errors.
// ────────────────────────────────────────────────────────────────────────────────

#pragma once

// STL
#include <chrono>
#include <cstddef>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>

// Third-party
#include <nlohmann/json.hpp>

// Forward declaration of whatever GraphQL library we end up using.
// We purposefully do *not* commit to one particular implementation.
namespace gql {
class Schema;
struct ExecutionResult;
} // namespace gql

namespace paletteflux::studio::api::v1::graphql
{

// ────────────────────────────────────────────────────────────────────────────────
//  type-safe alias helpers
// ────────────────────────────────────────────────────────────────────────────────
using Clock                   = std::chrono::high_resolution_clock;
using json                    = nlohmann::json;
using Milliseconds            = std::chrono::milliseconds;
using GraphQLVariables        = std::unordered_map<std::string, json>;
using GraphQLExecutionResult  = json;  // serialized JSON (RFC 8259)

// ────────────────────────────────────────────────────────────────────────────────
//  LRU Cache (header-only)
//  -----------------------
//  Provides a small, concurrency-friendly* bounded cache specialized for JSON
//  GraphQL results.  The implementation is good enough for low-volume API nodes.
//  For heavy workloads consider employing a proper in-memory KV store.
//
//  *Read operations are shared, while writes take the unique lock.
// ────────────────────────────────────────────────────────────────────────────────
template <typename Key, typename Value>
class LruCache
{
public:
    explicit LruCache(std::size_t capacity = 1024)
        : _capacity(capacity)
    {
        if (_capacity == 0)
            throw std::invalid_argument("LRU cache capacity cannot be zero.");
    }

    bool        contains(const Key& k) const
    {
        std::shared_lock lock(_mutex);
        return _map.find(k) != _map.end();
    }

    std::optional<Value> get(const Key& k)
    {
        std::unique_lock lock(_mutex);
        auto             it = _map.find(k);
        if (it == _map.end())
            return std::nullopt;

        // Move to front (most recently used)
        _order.splice(_order.begin(), _order, it->second.orderIt);
        return it->second.value;
    }

    void put(const Key& k, Value v)
    {
        std::unique_lock lock(_mutex);
        auto             it = _map.find(k);

        if (it != _map.end())
        {
            // Update existing
            it->second.value   = std::move(v);
            _order.splice(_order.begin(), _order, it->second.orderIt);
            return;
        }

        if (_map.size() >= _capacity)
        {
            // Evict least recently used
            const Key& lruKey = _order.back();
            _map.erase(lruKey);
            _order.pop_back();
        }

        _order.push_front(k);
        _map.emplace(k, Node{ std::move(v), _order.begin() });
    }

    std::size_t capacity() const noexcept { return _capacity; }
    std::size_t size() const noexcept
    {
        std::shared_lock lock(_mutex);
        return _map.size();
    }

private:
    struct Node
    {
        Value                             value;
        typename std::list<Key>::iterator orderIt;
    };

    std::size_t                 _capacity;
    mutable std::shared_mutex   _mutex;
    std::list<Key>              _order;
    std::unordered_map<Key, Node> _map;
};

// ────────────────────────────────────────────────────────────────────────────────
//  GraphQLHandler
// ────────────────────────────────────────────────────────────────────────────────
class GraphQLHandler
{
public:
    struct Metrics
    {
        Milliseconds latency;
        std::size_t  responseBytes = 0;
        bool         cacheHit      = false;
    };

    // Public ctor. Requires a prepared, immutable GraphQL schema.
    explicit GraphQLHandler(std::shared_ptr<const gql::Schema> schema,
                            std::size_t                        cacheCapacity = 1'024);

    // Non-copyable – the handler holds a heavy schema reference.
    GraphQLHandler(const GraphQLHandler&)            = delete;
    GraphQLHandler& operator=(const GraphQLHandler&) = delete;
    GraphQLHandler(GraphQLHandler&&)                 = default;
    GraphQLHandler& operator=(GraphQLHandler&&)      = default;
    ~GraphQLHandler()                                = default;

    // Execute a GraphQL document and return the serialized JSON result.
    //
    // Throws:
    //   • std::invalid_argument       – malformed input
    //   • std::runtime_error          – internal execution failure
    //
    // On success, the returned pair holds the JSON result and instrumentation
    // metrics recorded for the invocation.
    std::pair<GraphQLExecutionResult, Metrics>
    execute(const std::string&               query,
            GraphQLVariables                 variables = {},
            const std::optional<std::string> operationName = std::nullopt);

private:
    // Private helpers
    GraphQLExecutionResult executeInternal(const std::string&               query,
                                           GraphQLVariables                 variables,
                                           const std::optional<std::string> operationName);

    static std::string buildCacheKey(const std::string&               query,
                                     const GraphQLVariables&          variables,
                                     const std::optional<std::string> operationName);

    // Members
    std::shared_ptr<const gql::Schema>     _schema;
    LruCache<std::string, json>            _responseCache;
};

// ────────────────────────────────────────────────────────────────────────────────
//  Inline implementation
// ────────────────────────────────────────────────────────────────────────────────
inline GraphQLHandler::GraphQLHandler(std::shared_ptr<const gql::Schema> schema,
                                      std::size_t                        cacheCapacity)
    : _schema(std::move(schema))
    , _responseCache(cacheCapacity)
{
    if (!_schema)
        throw std::invalid_argument("GraphQL schema must not be null.");
}

inline std::pair<GraphQLExecutionResult, GraphQLHandler::Metrics>
GraphQLHandler::execute(const std::string&               query,
                        GraphQLVariables                 variables,
                        const std::optional<std::string> operationName)
{
    if (query.empty())
        throw std::invalid_argument("GraphQL query string is empty.");

    const auto   start       = Clock::now();
    const auto   cacheKey    = buildCacheKey(query, variables, operationName);
    Metrics      m;
    json         result;

    // ── Caching ────────────────────────────────────────────────────────────────
    if (_responseCache.contains(cacheKey))
    {
        auto cached = _responseCache.get(cacheKey);
        if (cached.has_value())
        {
            m.cacheHit      = true;
            result          = *cached;
            m.responseBytes = result.dump().size();
            m.latency       = std::chrono::duration_cast<Milliseconds>(Clock::now() - start);
            return { result, m };
        }
    }

    // ── Actual execution ───────────────────────────────────────────────────────
    try
    {
        result = executeInternal(query, std::move(variables), operationName);
    }
    catch (const std::exception&)
    {
        // Propagate further – controller layer will translate to HTTP errors.
        throw;
    }

    // ── Update cache asynchronously (best effort) ─────────────────────────────
    try
    {
        _responseCache.put(cacheKey, result);
    }
    catch (const std::exception& ex)
    {
        // Cache failure must never break the request; log and continue.
        // (Use your favourite logging library here.)
        std::ostringstream oss;
        oss << "GraphQLHandler cache put failed: " << ex.what();
        // log::warn(oss.str());
    }

    m.responseBytes = result.dump().size();
    m.latency       = std::chrono::duration_cast<Milliseconds>(Clock::now() - start);
    return { result, m };
}

// Builds a canonical, stable key used by the in-memory cache.
inline std::string
GraphQLHandler::buildCacheKey(const std::string&               query,
                              const GraphQLVariables&          variables,
                              const std::optional<std::string> operationName)
{
    std::ostringstream oss;
    oss << query << "##";
    if (operationName)
        oss << *operationName;
    oss << "##";

    // Stable ordering of variables to ensure deterministic cache keys.
    std::vector<std::pair<std::string, json>> ordered(variables.begin(), variables.end());
    std::sort(ordered.begin(), ordered.end(),
              [](auto& a, auto& b) { return a.first < b.first; });

    for (const auto& [k, v] : ordered)
    {
        oss << k << ':' << v.dump() << ';';
    }

    return oss.str();
}

inline GraphQLExecutionResult
GraphQLHandler::executeInternal(const std::string&               query,
                                GraphQLVariables                 variables,
                                const std::optional<std::string> operationName)
{
    // NOTE: The actual call will depend on the GraphQL library in use.  Replace
    //       the stub below with your framework’s real API.
    //
    // Example using stlab’s “graphqlcpp” (pseudo-code):
    //
    //   gql::Request req;
    //   req.document      = query;
    //   req.variables     = variables;
    //   req.operationName = operationName;
    //
    //   gql::ExecutionResult res = gql::execute(*_schema, req);
    //
    //   if (!res.errors.empty())
    //       throw DomainError(res.errors);
    //
    //   return res.data;
    //
    // To keep this header self-contained, we emulate a successful response.

    json data;
    data["__stub"] = "Replace with real GraphQL execution result.";

    json out;
    out["data"] = std::move(data);
    return out;
}

} // namespace paletteflux::studio::api::v1::graphql
```