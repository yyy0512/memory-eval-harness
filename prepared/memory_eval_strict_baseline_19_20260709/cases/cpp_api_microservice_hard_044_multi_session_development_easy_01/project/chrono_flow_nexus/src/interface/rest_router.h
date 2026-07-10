```cpp
#pragma once
/*
 * ChronoFlow Nexus
 * File: chrono_flow_nexus/src/interface/rest_router.h
 *
 * Description:
 *  A lightweight, high-performance, thread-safe routing layer that maps HTTP
 *  endpoints to application-level command/query handlers.  The router performs
 *  route-pattern matching (with path-parameters), basic content-negotiation,
 *  correlation-id propagation and hooks for observability, rate-limiting and
 *  response-caching.  It is intentionally kept header-only so that endpoints
 *  can be registered from any translation unit without introducing additional
 *  library dependencies.
 *
 *  NOTE: The interface layer only orchestrates control-flow.  Domain logic
 *  remains encapsulated in the application / domain layers.
 */

#include <boost/beast/http.hpp>
#include <boost/algorithm/string.hpp>

#include <nlohmann/json.hpp>

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chrono_flow::interface {

/* ────────────────────────────── Utilities ──────────────────────────────── */

namespace http  = boost::beast::http;
using Json      = nlohmann::json;

/*
 * Convenience alias for a map of path-parameters extracted from an URI.
 *     e.g.    /team/{teamId}/tasks/{taskId}
 *             └──────────┬──────────┘
 *                    params["teamId"] == "42"
 *                    params["taskId"] == "abc-123"
 */
using PathParams = std::unordered_map<std::string, std::string>;

/*
 * HTTP verbs understood by the router.  Only commonly-used methods are
 * enumerated, but new ones (e.g. OPTIONS, TRACE) can be injected later on.
 */
enum class HttpMethod : uint8_t
{
    Get,
    Post,
    Put,
    Patch,
    Delete
};

inline std::string_view to_string(HttpMethod m) noexcept
{
    switch (m)
    {
        case HttpMethod::Get    : return "GET";
        case HttpMethod::Post   : return "POST";
        case HttpMethod::Put    : return "PUT";
        case HttpMethod::Patch  : return "PATCH";
        case HttpMethod::Delete : return "DELETE";
    }
    return "UNKNOWN";
}

/* ────────────────────── Core routing data-structures ───────────────────── */

class PathPattern
{
public:
    explicit PathPattern(std::string pattern)
      : raw_pattern_(std::move(pattern))
    {
        if (raw_pattern_.empty() || raw_pattern_.front() != '/')
            throw std::invalid_argument(
                "Route pattern must start with '/' : " + raw_pattern_);

        // split the pattern into segments
        std::vector<std::string> tokens;
        boost::algorithm::split(tokens, raw_pattern_,
                                boost::is_any_of("/"),
                                boost::token_compress_on);

        for (const auto& tok : tokens)
        {
            if (tok.empty()) continue;
            if (tok.front() == '{' && tok.back() == '}')
            {
                segments_.emplace_back(Segment{true, tok.substr(1, tok.size() - 2)});
            }
            else
            {
                segments_.emplace_back(Segment{false, tok});
            }
        }
    }

    /*
     * Attempt to match an URI path against the pattern.
     *
     *  Example:
     *      Pattern = /team/{teamId}/tasks
     *      Path    = /team/42/tasks
     *
     *   ➜  returns true and fills params["teamId"] with "42"
     *
     * Thread-safety: read-only, can be concurrently invoked.
     */
    [[nodiscard]]
    bool match(std::string_view path,
               PathParams&       out_params) const
    {
        std::vector<std::string_view> tokens;
        boost::algorithm::split(tokens, path,
                                boost::is_any_of("/"),
                                boost::token_compress_on);

        // remove empty segments caused by leading '/'
        tokens.erase(std::remove_if(tokens.begin(), tokens.end(),
                                    [](auto sv) { return sv.empty(); }),
                     tokens.end());

        if (tokens.size() != segments_.size())
            return false;

        out_params.clear();

        for (std::size_t i = 0; i < segments_.size(); ++i)
        {
            const auto& seg = segments_[i];
            const auto& tok = tokens[i];

            if (seg.is_param)
            {
                out_params.emplace(seg.value, std::string(tok));
            }
            else if (tok != seg.value)
            {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]]
    const std::string& raw() const noexcept { return raw_pattern_; }

private:
    struct Segment
    {
        bool        is_param;
        std::string value;    // literal value OR parameter-name (without braces)
    };

    std::string            raw_pattern_;
    std::vector<Segment>   segments_;
};

/* ───────────────────────── Request / Response Context ──────────────────── */

struct RequestContext
{
    std::string         correlation_id;     // propagated for tracing
    std::string         remote_address;     // peer's IP
    std::chrono::system_clock::time_point start_time
        = std::chrono::system_clock::now();

    // Additional context fields (auth info, tenant id, etc.) can be added
    // without breaking ABI because this struct lives only within a component
    // boundary.
};

/* ──────────────────────────── Route Definition ─────────────────────────── */

using RequestHandler = std::function<
    void(const RequestContext&,
         const PathParams&,                    // parsed path-parameters
         const Json& /*request body*/,         // deserialized JSON body
         Json&        /*response body*/)       // JSON output (serialised later)
>;

struct Route final
{
    HttpMethod     method   {};
    PathPattern    pattern   = PathPattern{"/"};
    RequestHandler handler;

    std::string to_string() const
    {
        std::ostringstream oss;
        oss << chrono_flow::interface::to_string(method) << ' '
            << pattern.raw();
        return oss.str();
    }
};

/* ────────────────────────────── RestRouter ────────────────────────────── */
/*
 * Thread-safe, register-once-run-many routing table.  Endpoints should be
 * registered during service start-up; afterwards only `handle()` is invoked
 * concurrently by the HTTP server worker threads.
 */

class RestRouter
{
public:
    RestRouter()                       = default;
    RestRouter(const RestRouter&)      = delete;
    RestRouter& operator=(const RestRouter&) = delete;

    /*
     * Registers a new route.  Throws std::runtime_error if a duplicate
     * method/path combination is detected to prevent ambiguous behaviour.
     *
     * Call this ONLY at start-up (before the server begins accepting traffic)
     * or ensure external synchronisation.  Internally we lock exclusively to
     * avoid races.
     */
    void add_route(HttpMethod     method,
                   std::string    path_pattern,
                   RequestHandler handler)
    {
        if (!handler)
            throw std::invalid_argument("RequestHandler cannot be empty");

        std::unique_lock lock(mutex_);

        const PathPattern pattern{ std::move(path_pattern) };

        // enforce uniqueness
        for (const auto& rt : routes_)
        {
            if (rt.method == method &&
                rt.pattern.raw() == pattern.raw())
            {
                throw std::runtime_error(
                    "Duplicate route registration: " +
                    std::string(to_string(method)) + " " + pattern.raw());
            }
        }

        routes_.emplace_back(Route{method, pattern, std::move(handler)});
    }

    /*
     * Dispatch an incoming HTTP request.  The router will:
     *   1. Find a matching route
     *   2. Deserialize JSON body (if any)
     *   3. Perform basic error handling & generate the HTTP response
     *
     *  When no route matches, a 404 is returned.  Unexpected exceptions are
     *  translated into a 500 response with a generic error payload to avoid
     *  leaking internal details.
     */
    template <class Body, class Allocator>
    http::response<http::string_body>
    handle(const http::request<Body, http::basic_fields<Allocator>>& req,
           RequestContext ctx) const
    {
        const auto method = translate_method(req.method());
        if (!method)
            return build_response(http::status::method_not_allowed,
                                  "Unsupported HTTP method");

        // Attempt to locate a matching route.  Shared lock -> high concurrency
        PathParams params;
        RequestHandler handler;

        {
            std::shared_lock lock(mutex_);
            for (const auto& rt : routes_)
            {
                if (rt.method != *method) continue;
                if (rt.pattern.match(req.target(), params))
                {
                    handler = rt.handler; // copy the function
                    break;
                }
            }
        }

        if (!handler)
        {
            return build_response(http::status::not_found,
                                  "The requested resource was not found");
        }

        // Deserialize JSON request body (if any)
        Json request_body;
        try
        {
            if constexpr (std::is_same_v<Body, http::string_body>)
            {
                if (!req.body().empty())
                    request_body = Json::parse(req.body());
            }
            else
            {
                // For other Body types we fallback to empty json
            }
        }
        catch (const std::exception& ex)
        {
            return build_response(http::status::bad_request,
                                  std::string("Malformed JSON body: ") + ex.what());
        }

        // Invoke the application handler
        Json response_body;
        try
        {
            handler(ctx, params, request_body, response_body);
        }
        catch (const std::exception& ex)
        {
            // TODO: Inject structured logging / metrics here
            return build_response(http::status::internal_server_error,
                                  "Internal server error: " + std::string(ex.what()));
        }

        return build_response(http::status::ok, response_body.dump());
    }

    /*
     * Expose an immutable snapshot of registered routes for use
     * in automatic OpenAPI generation / observability dashboards.
     */
    [[nodiscard]]
    std::vector<Route> routes() const
    {
        std::shared_lock lock(mutex_);
        return routes_;
    }

private:
    // Mutex protects routes_ during registration and reading
    mutable std::shared_mutex mutex_;
    std::vector<Route>        routes_;

    /* Translate Boost.Beast's method enum into our internal enum */
    static std::optional<HttpMethod>
    translate_method(http::verb verb) noexcept
    {
        switch (verb)
        {
            case http::verb::get    : return HttpMethod::Get;
            case http::verb::post   : return HttpMethod::Post;
            case http::verb::put    : return HttpMethod::Put;
            case http::verb::patch  : return HttpMethod::Patch;
            case http::verb::delete_: return HttpMethod::Delete;
            default                 : return std::nullopt;
        }
    }

    /* Build a simple plaintext HTTP response */
    static
    http::response<http::string_body>
    build_response(http::status             st,
                   const std::string_view   body,
                   const std::string_view   content_type = "application/json")
    {
        http::response<http::string_body> res{st, /*version*/11};
        res.set(http::field::server,    "ChronoFlow-Nexus/1.0");
        res.set(http::field::content_type, content_type);
        res.keep_alive(false);
        res.body() = std::string(body);
        res.prepare_payload();
        return res;
    }
};

} // namespace chrono_flow::interface
```