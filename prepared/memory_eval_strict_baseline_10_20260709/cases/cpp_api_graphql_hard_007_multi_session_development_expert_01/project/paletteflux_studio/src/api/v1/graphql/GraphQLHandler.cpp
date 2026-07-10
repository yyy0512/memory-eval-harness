#include "GraphQLHandler.h"              // <project specific header> – included first on purpose
                                         // (enforces that the header is self-contained)
#include <nlohmann/json.hpp>             // https://github.com/nlohmann/json
#include <boost/algorithm/string.hpp>    // For url-parameter parsing/helpers
#include <spdlog/spdlog.h>               // Logging
#include <chrono>
#include <functional>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>

namespace paletteflux::api::v1::graphql
{

using json = nlohmann::json;

/* ---------- Lightweight HTTP primitives ---------------------------------- */
/* NOTE:
 * PaletteFlux runs on top of an internal HTTP-stack that ultimately translates
 * to these value-types.  We re-declare them here to keep the compilation unit
 * self-contained while still providing all features required by the handler.
 */
struct HttpRequest
{
    std::string                                      method;   // "GET", "POST", …
    std::string                                      target;   // "/graphql?query=…"
    std::unordered_map<std::string, std::string>     headers;
    std::string                                      body;
};

struct HttpResponse
{
    int                                              statusCode {200};
    std::unordered_map<std::string, std::string>     headers;
    std::string                                      body;

    void setHeader(std::string_view name, std::string_view value)
    {
        headers.emplace(name, value);
    }
};

/* ---------- Extremely small metrics façade -------------------------------- */
class RequestMetrics
{
public:
    void record(std::string_view operation,
                std::chrono::milliseconds latency,
                bool                      success) noexcept
    {
        try
        {
            spdlog::info("GraphQL op '{}' finished in {} ms ({})",
                         operation.empty() ? "<anonymous>" : operation.data(),
                         latency.count(),
                         success ? "success" : "failure");
        }
        catch (...)
        {
            /* Do not propagate – metrics must never fail request path */
        }
    }
};

/* ---------- In-Process, Time-Aware LRU Cache ------------------------------ */
class ResponseCache
{
public:
    explicit ResponseCache(std::size_t maxEntries = 1'024)
        : m_maxEntries(maxEntries)
    {
    }

    std::optional<json> get(const std::string& key)
    {
        std::shared_lock lock(m_mutex);

        const auto now = std::chrono::steady_clock::now();
        auto       it  = m_cache.find(key);
        if (it == m_cache.end() || it->second.expiry < now)
            return std::nullopt;

        return it->second.payload;
    }

    void put(const std::string& key,
             json              payload,
             std::chrono::seconds ttl = std::chrono::seconds {30})
    {
        std::unique_lock lock(m_mutex);

        if (m_cache.size() >= m_maxEntries)
        {
            /* Simple FIFO eviction – production would use true LRU */
            m_cache.erase(m_cache.begin());
        }

        m_cache.emplace(key,
                        CacheEntry {
                            std::move(payload),
                            std::chrono::steady_clock::now() + ttl
                        });
    }

private:
    struct CacheEntry
    {
        json                                   payload;
        std::chrono::steady_clock::time_point  expiry;
    };

    std::unordered_map<std::string, CacheEntry> m_cache;
    std::size_t                                 m_maxEntries;
    std::shared_mutex                           m_mutex;
};

/* ---------- Thin façade around underlying GraphQL-Core -------------------- */
class GraphQLSchema
{
public:
    /* Executes a query and returns a JSON-serializable response according to:
     * https://spec.graphql.org/June2018/#sec-Response-Format
     */
    [[nodiscard]]
    json execute(const std::string& query,
                 const json&        variables,
                 const std::string& operationName) const
    {
        /* In real life, this function would delegate to graphql-cpp or
         * libgraphqlparser bindings.  For the purpose of this compilation unit
         * we return a canned response in order to focus on handler behavior.
         */
        return {
            { "data",
              { { "echo",
                  { { "query", query },
                    { "variables", variables },
                    { "operationName", operationName } } } } }
        };
    }
};

/* ------------------------------------------------------------------------- */
/*                            GraphQLHandler                                 */
/* ------------------------------------------------------------------------- */

class GraphQLHandler
{
public:
    explicit GraphQLHandler(std::shared_ptr<GraphQLSchema> schema,
                            std::shared_ptr<RequestMetrics> metrics   = std::make_shared<RequestMetrics>(),
                            std::shared_ptr<ResponseCache>  cache     = std::make_shared<ResponseCache>())
        : m_schema (std::move(schema))
        , m_metrics(std::move(metrics))
        , m_cache  (std::move(cache))
    {
        if (!m_schema)
            throw std::invalid_argument("GraphQLHandler: schema is nullptr");
    }

    /* Primary entry point called by PaletteFlux HTTP server */
    void handleRequest(const HttpRequest& req, HttpResponse& res)
    {
        using Clock = std::chrono::steady_clock;
        const auto start = Clock::now();

        bool success = true;
        std::string operationName;

        try
        {
            /* 1. Parse incoming request into canonical GraphQL parts */
            ParsedRequest parsed = parseIncomingRequest(req);

            operationName = parsed.operationName;

            /* 2. Caching: Look for pre-computed result */
            const auto cacheKey = computeCacheKey(parsed.query,
                                                  parsed.variables,
                                                  parsed.operationName);

            if (auto cached = m_cache->get(cacheKey))
            {
                spdlog::debug("Cache hit for key {}", cacheKey);
                buildHttpResponse(*cached, res, /*fromCache*/ true);
                return;
            }

            /* 3. Execute using schema */
            json executionResult = m_schema->execute(parsed.query,
                                                     parsed.variables,
                                                     parsed.operationName);

            /* 4. Persist to cache (only if no 'errors' member) */
            if (!executionResult.contains("errors"))
            {
                m_cache->put(cacheKey, executionResult);
            }

            buildHttpResponse(executionResult, res, /*fromCache*/ false);
        }
        catch (const std::exception& ex)
        {
            success               = false;
            res.statusCode        = 400;
            res.headers["Content-Type"] = "application/json";

            json errorBody = {
                { "errors",
                  json::array( { { { "message", ex.what() } } } ) }
            };
            res.body = errorBody.dump();
        }

        /* 5. Metrics */
        const auto latency = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 Clock::now() - start);

        m_metrics->record(operationName, latency, success);
    }

private:
    /* ----------- Request Parsing ----------------------------------------- */
    struct ParsedRequest
    {
        std::string query;
        json        variables;
        std::string operationName;
    };

    ParsedRequest parseIncomingRequest(const HttpRequest& req) const
    {
        if (req.method == "GET")
        {
            return parseFromUrl(req.target);
        }
        else if (req.method == "POST")
        {
            if (auto it = req.headers.find("Content-Type");
                it == req.headers.end() ||
                !boost::algorithm::starts_with(boost::algorithm::to_lower_copy(it->second),
                                               "application/json"))
            {
                throw std::runtime_error("POST /graphql must use Content-Type: application/json");
            }
            return parseFromBody(req.body);
        }

        throw std::runtime_error("Unsupported HTTP method for /graphql endpoint");
    }

    ParsedRequest parseFromBody(const std::string& body) const
    {
        json payload = json::parse(body);

        ParsedRequest result;
        result.query         = payload.value("query", "");
        result.operationName = payload.value("operationName", "");

        if (payload.contains("variables"))
        {
            result.variables = payload["variables"];
        }

        if (result.query.empty())
            throw std::runtime_error("Missing 'query' field in request payload");

        return result;
    }

    ParsedRequest parseFromUrl(const std::string& target) const
    {
        /* Very small ad-hoc query-parameter parser (expects “…?key=value&…”) */
        ParsedRequest result;

        const auto qmPos = target.find('?');
        if (qmPos == std::string::npos)
            throw std::runtime_error("GET /graphql requires '?query=' parameter");

        const std::string_view qs = target.substr(qmPos + 1);
        for (const auto& token : boost::algorithm::split_regex_copy(std::string {qs},
                                                                    boost::regex("&")))
        {
            const auto eqPos = token.find('=');
            if (eqPos == std::string::npos)
                continue;

            const std::string key   = token.substr(0, eqPos);
            const std::string value = decodeUrlComponent(token.substr(eqPos + 1));

            if (key == "query")
                result.query = value;
            else if (key == "operationName")
                result.operationName = value;
            else if (key == "variables")
                result.variables = json::parse(value);
        }

        if (result.query.empty())
            throw std::runtime_error("Missing 'query' parameter");

        return result;
    }

    static std::string decodeUrlComponent(std::string_view s)
    {
        std::ostringstream oss;
        for (size_t i = 0; i < s.size(); ++i)
        {
            if (s[i] == '%' && i + 2 < s.size())
            {
                const std::string hex = std::string {s.substr(i + 1, 2)};
                oss << static_cast<char>(std::stoi(hex, nullptr, 16));
                i += 2;
            }
            else if (s[i] == '+')
            {
                oss << ' ';
            }
            else
            {
                oss << s[i];
            }
        }
        return oss.str();
    }

    /* ----------- HTTP Response Construction ------------------------------ */
    static void buildHttpResponse(const json& payload,
                                  HttpResponse& res,
                                  bool fromCache)
    {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "max-age=0, private, must-revalidate");

        if (fromCache)
            res.setHeader("X-Cache", "HIT");
        else
            res.setHeader("X-Cache", "MISS");

        res.body = payload.dump();
    }

    /* ----------- Cache Key Computation ------------------------------------ */
    static std::string computeCacheKey(const std::string& query,
                                       const json&        variables,
                                       const std::string& operationName)
    {
        std::size_t seed = 0x9e3779b97f4a7c15ULL;
        hashCombine(seed, query);
        hashCombine(seed, variables.dump());
        hashCombine(seed, operationName);

        return std::to_string(seed);
    }

    template<typename T>
    static void hashCombine(std::size_t& seed, const T& v)
    {
        std::hash<T> hasher;
        seed ^= hasher(v) + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2);
    }

    /* --------------------------------------------------------------------- */
    std::shared_ptr<GraphQLSchema>  m_schema;
    std::shared_ptr<RequestMetrics> m_metrics;
    std::shared_ptr<ResponseCache>  m_cache;
};

} // namespace paletteflux::api::v1::graphql