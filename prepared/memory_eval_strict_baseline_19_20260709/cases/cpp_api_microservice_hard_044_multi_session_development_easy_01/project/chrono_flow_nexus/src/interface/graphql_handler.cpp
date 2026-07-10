#include "interface/graphql_handler.hpp"

#include <chrono>
#include <exception>
#include <future>
#include <memory>
#include <sstream>
#include <string>
#include <utility>

#include "application/service_locator.hpp"
#include "domain/exceptions/domain_exception.hpp"
#include "infrastructure/cache/response_cache.hpp"
#include "infrastructure/logging/logger.hpp"
#include "infrastructure/metrics/metrics_collector.hpp"
#include "infrastructure/rate_limiting/rate_limiter.hpp"
#include "interface/http/http_request.hpp"
#include "interface/http/http_response.hpp"
#include "interface/http/status_codes.hpp"

#include <graphql/executor.hpp>
#include <graphql/parser.hpp>
#include <nlohmann/json.hpp>

namespace chrono_flow::interface {

using json = nlohmann::json;
using transport::HttpRequest;
using transport::HttpResponse;
using transport::http_status::Code;

/* ------------------------------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------------------------------*/

/**
 * Extract the client's logical identifier from the request. We fallback to the remote
 * address if no authenticated user is present. This function is used to apply rate-limits
 * and drive observability correlations.
 */
static std::string resolve_client_id(const HttpRequest& req) {
    if (auto id = req.header("X-Auth-User"); !id.empty()) {
        return id;
    }
    return req.remote_address();
}

/**
 * Compute a deterministic cache key for the given GraphQL request. The variables object
 * is canonicalized so that logically-equivalent queries map to the same cache entry,
 * regardless of whitespace differences in the JSON payload.
 */
static std::string compute_cache_key(std::string_view query,
                                     const json&          variables,
                                     std::string_view     operation_name) {
    // Naïve but sufficient; production code would use a faster/stronger hash.
    std::ostringstream oss;
    oss << query << "::" << variables.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)
        << "::" << operation_name;
    return std::to_string(std::hash<std::string>{}(oss.str()));
}

/* ------------------------------------------------------------------------------------------------------------------
 * GraphQLHandler implementation
 * ------------------------------------------------------------------------------------------------------------------*/

GraphQLHandler::GraphQLHandler(std::shared_ptr<graphql::Schema>                       schema,
                               std::shared_ptr<application::ServiceLocator>          services,
                               std::shared_ptr<infrastructure::ResponseCache>        cache,
                               std::shared_ptr<infrastructure::RateLimiter>          limiter,
                               std::shared_ptr<infrastructure::metrics::Collector>   metrics)
    : m_schema(std::move(schema))
    , m_services(std::move(services))
    , m_cache(std::move(cache))
    , m_rate_limiter(std::move(limiter))
    , m_metrics(std::move(metrics)) {
    if (!m_schema) { throw std::invalid_argument("GraphQLHandler requires a non-null schema"); }
    if (!m_services) { throw std::invalid_argument("GraphQLHandler requires a non-null ServiceLocator"); }
    if (!m_cache) { throw std::invalid_argument("GraphQLHandler requires a non-null ResponseCache"); }
    if (!m_rate_limiter) { throw std::invalid_argument("GraphQLHandler requires a non-null RateLimiter"); }
    if (!m_metrics) { throw std::invalid_argument("GraphQLHandler requires a non-null metrics collector"); }
}

/**
 * Entry point for HTTP transport code. It validates the request, enforces rate-limits,
 * serves cache hits, executes the GraphQL query, and returns a JSON response that is
 * spec-compliant with `application/graphql-response+json`.
 */
HttpResponse GraphQLHandler::handle_request(const HttpRequest& req) {
    auto start_time = std::chrono::steady_clock::now();

    HttpResponse resp;
    resp.header("Content-Type", "application/graphql-response+json");

    try {
        /* ----------------------------------------------------------------------
         * 1. Basic HTTP validation
         * --------------------------------------------------------------------*/
        if (req.method() != "POST") {
            resp.status(Code::MethodNotAllowed);
            resp.body(R"({"errors":[{"message":"Only POST is supported"}]})");
            return resp;
        }

        auto client_id = resolve_client_id(req);

        /* ----------------------------------------------------------------------
         * 2. Apply adaptive rate limit
         * --------------------------------------------------------------------*/
        if (!m_rate_limiter->acquire(client_id)) {
            resp.status(Code::TooManyRequests);
            resp.body(R"({"errors":[{"message":"Rate limit exceeded"}]})");
            m_metrics->increment("graphql.rate_limit_exceeded");
            return resp;
        }

        /* ----------------------------------------------------------------------
         * 3. Parse request payload
         * --------------------------------------------------------------------*/
        json body_json;
        try {
            body_json = json::parse(req.body());
        } catch (const json::parse_error& e) {
            resp.status(Code::BadRequest);
            resp.body(R"({"errors":[{"message":"Invalid JSON payload"}]})");
            m_metrics->increment("graphql.bad_request.json_parse_error");
            return resp;
        }

        const std::string query          = body_json.value("query", "");
        const json        variables_json = body_json.value("variables", json::object());
        const std::string operation_name = body_json.value("operationName", "");

        if (query.empty()) {
            resp.status(Code::BadRequest);
            resp.body(R"({"errors":[{"message":"Request JSON must include \"query\""}]})");
            m_metrics->increment("graphql.bad_request.missing_query");
            return resp;
        }

        /* ----------------------------------------------------------------------
         * 4. Response caching (look-up)
         * --------------------------------------------------------------------*/
        const auto cache_key = compute_cache_key(query, variables_json, operation_name);
        if (auto cached = m_cache->get(cache_key)) {
            resp.status(Code::Ok);
            resp.body(*cached);
            resp.header("X-Cache-Hit", "1");
            m_metrics->increment("graphql.cache.hit");
            return resp;
        }
        resp.header("X-Cache-Hit", "0");
        m_metrics->increment("graphql.cache.miss");

        /* ----------------------------------------------------------------------
         * 5. GraphQL execution
         * --------------------------------------------------------------------*/
        graphql::Context gql_ctx(
            /* services   */ *m_services,
            /* variables  */ variables_json,
            /* clientId   */ client_id,
            /* metrics    */ m_metrics);

        // Offload heavy execution to a background thread if the transport layer
        // is single-threaded. In practice, ChronoFlow Nexus uses a thread-pool.
        auto future_result = std::async(std::launch::async, [this, &gql_ctx, &query, &operation_name]() {
            return graphql::execute(*m_schema, query, operation_name, gql_ctx);
        });

        const auto execution_timeout = std::chrono::seconds(10);
        if (future_result.wait_for(execution_timeout) == std::future_status::timeout) {
            m_metrics->increment("graphql.execution.timeout");
            throw std::runtime_error("GraphQL execution timed out");
        }

        const json result_json = future_result.get();

        /* ----------------------------------------------------------------------
         * 6. Persist result in cache if applicable
         * --------------------------------------------------------------------*/
        if (!result_json.contains("errors")) {
            // Cache successful responses for 30 seconds; respect dynamic TTL later
            constexpr std::chrono::seconds default_ttl{30};
            m_cache->put(cache_key, result_json.dump(), default_ttl);
        }

        /* ----------------------------------------------------------------------
         * 7. Build HTTP response
         * --------------------------------------------------------------------*/
        resp.status(Code::Ok);
        resp.body(result_json.dump());
        m_metrics->observe(
            "graphql.latency_ms",
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start_time)
                .count());
        return resp;
    }
    /* --------------------------------------------------------------------------
     * Domain-level exceptions propagate through the GraphQL error mechanism and
     * must not crash the process. All exceptions get surfaced as 200 OK according
     * to the GraphQL spec, but we still measure them to keep the pipeline healthy.
     * ------------------------------------------------------------------------*/
    catch (const domain::DomainException& e) {
        m_metrics->increment("graphql.domain_exception");
        Logger::error("DomainException in GraphQL handler: {}", e.what());

        resp.status(Code::Ok);
        resp.body(json{
                      {"errors",
                       json::array({json{
                           {"message", e.public_message()},
                           {"extensions",
                            json{{"code", "DOMAIN_ERROR"}, {"detail", e.what()}}}}})})
                      .dump());
        return resp;
    }
    catch (const graphql::ValidationError& e) {
        m_metrics->increment("graphql.validation_error");
        Logger::warn("GraphQL validation failed: {}", e.what());

        resp.status(Code::Ok);
        resp.body(json{
                      {"errors",
                       json::array({json{
                           {"message", "GraphQL validation error"},
                           {"extensions", json{{"detail", e.what()}}}}})})
                      .dump());
        return resp;
    }
    catch (const std::exception& e) {
        m_metrics->increment("graphql.unhandled_exception");
        Logger::critical("Unhandled exception in GraphQL handler: {}", e.what());

        resp.status(Code::InternalServerError);
        resp.body(R"({"errors":[{"message":"Internal server error"}]})");
        return resp;
    } catch (...) {
        m_metrics->increment("graphql.unknown_exception");
        Logger::critical("Unknown non-std exception in GraphQL handler");

        resp.status(Code::InternalServerError);
        resp.body(R"({"errors":[{"message":"Internal server error"}]})");
        return resp;
    }
}

/* ------------------------------------------------------------------------------------------------------------------
 * Public lifecycle helpers
 * ------------------------------------------------------------------------------------------------------------------*/

void GraphQLHandler::invalidate_schema(std::shared_ptr<graphql::Schema> new_schema) {
    std::scoped_lock lock(m_schema_mutex);
    m_schema = std::move(new_schema);
    Logger::info("GraphQL schema hot-reloaded");
}

} // namespace chrono_flow::interface