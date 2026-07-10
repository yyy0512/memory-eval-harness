```cpp
/*
 * PaletteFlux GraphQL Studio – entry point
 * ----------------------------------------
 * This file boots the PaletteFlux Studio HTTP server that exposes:
 *
 *   1. `/graphql`  –  single GraphQL endpoint (POST)
 *   2. `/api/*`    –  curated REST endpoints for legacy clients
 *   3. `/healthz`  –  liveness / readiness probe
 *
 * The application demonstrates how an MVC-centric engine can be wrapped in a
 * lightweight HTTP façade while remaining production-ready through:
 *
 *   • Structured configuration (env-vars + JSON fallback)
 *   • Rich diagnostics via spdlog
 *   • Graceful shutdown on SIGINT / SIGTERM
 *   • Basic in-memory response caching
 *   • Thread-pool request dispatch
 *
 * NOTE:
 *  – External dependencies are kept header-only so that the file can be built
 *    with a single-TU CMake target:
 *        nlohmann::json      https://github.com/nlohmann/json
 *        cpp-httplib         https://github.com/yhirose/cpp-httplib
 *        spdlog              https://github.com/gabime/spdlog
 */

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "httplib.h"            // header-only HTTP/WebSocket server
#include "json.hpp"             // nlohmann::json
#include "spdlog/sinks/stdout_color_sinks.h"
#include "spdlog/spdlog.h"

using json = nlohmann::json;

// -------------------------------------------------------------
// Configuration
// -------------------------------------------------------------
struct AppConfig {
    std::string host           = "0.0.0.0";
    uint16_t    port           = 8080;
    std::size_t threadPoolSize = std::thread::hardware_concurrency();
    std::chrono::seconds cacheTTL{5};

    static AppConfig fromEnv() {
        AppConfig cfg;

        if (const char* h = std::getenv("PF_HOST")) cfg.host = h;
        if (const char* p = std::getenv("PF_PORT")) cfg.port = static_cast<uint16_t>(std::stoi(p));
        if (const char* t = std::getenv("PF_THREADS"))
            cfg.threadPoolSize = static_cast<std::size_t>(std::stoi(t));
        if (const char* c = std::getenv("PF_CACHE_TTL"))
            cfg.cacheTTL = std::chrono::seconds(std::stoi(c));

        return cfg;
    }
};

// -------------------------------------------------------------
// Simple in-memory response cache (per-endpoint)
// -------------------------------------------------------------
class ResponseCache {
public:
    struct CachedItem {
        std::string              payload;
        std::chrono::steady_clock::time_point expiry;
    };

    explicit ResponseCache(std::chrono::seconds ttl) : ttl_{ttl} {}

    bool get(const std::string& key, std::string& out) const {
        std::shared_lock lock(mutex_);
        auto it = storage_.find(key);
        if (it == storage_.end() || expired(it->second)) return false;
        out = it->second.payload;
        return true;
    }

    void put(const std::string& key, std::string value) {
        std::unique_lock lock(mutex_);
        storage_[key] = {std::move(value),
                         std::chrono::steady_clock::now() + ttl_};
    }

private:
    bool expired(const CachedItem& item) const {
        return std::chrono::steady_clock::now() > item.expiry;
    }

    std::chrono::seconds                              ttl_;
    mutable std::shared_mutex                         mutex_;
    std::unordered_map<std::string, CachedItem>       storage_;
};

// -------------------------------------------------------------
// Very small GraphQL stub
//   – For real usage plug in e.g. graphql-cpp or libgraphqlparser
// -------------------------------------------------------------
class GraphQLExecutor {
public:
    json execute(const std::string& query, const json& variables) {
        // Stub implementation demonstrating CQS separation.
        if (query.find("IntrospectionQuery") != std::string::npos) {
            return introspection();
        }

        // Example command:   mutation { ping(message:"Hello") }
        if (query.find("ping") != std::string::npos) {
            return ping(variables.value("message", "pong"));
        }

        // Example query:     query { serverTime }
        if (query.find("serverTime") != std::string::npos) {
            return serverTime();
        }

        return error("Unsupported operation");
    }

private:
    static json error(std::string msg) {
        return {{"errors", {{{"message", std::move(msg)}}}}};
    }

    static json serverTime() {
        using namespace std::chrono;
        auto now   = system_clock::now();
        auto epoch = duration_cast<milliseconds>(now.time_since_epoch()).count();
        return {{"data", {{"serverTime", epoch}}}};
    }

    static json ping(std::string message) {
        return {{"data", {{"ping", std::move(message)}}}};
    }

    static json introspection() {
        return {{"data",
                 {{"__schema",
                   {{"description",
                     "Introspection stub – replace with real schema"}}}}}};
    }
};

// -------------------------------------------------------------
// Monitoring utilities
// -------------------------------------------------------------
class MetricsRegistry {
public:
    void incCounter(const std::string& name) {
        std::lock_guard<std::mutex> lock(mutex_);
        ++counters_[name];
    }

    json snapshot() const {
        std::lock_guard<std::mutex> lock(mutex_);
        json j;
        for (const auto& [k, v] : counters_) j[k] = v;
        return j;
    }

private:
    mutable std::mutex                mutex_;
    std::unordered_map<std::string,int> counters_;
};

// -------------------------------------------------------------
// Graceful shutdown flag
// -------------------------------------------------------------
namespace {
std::atomic_bool g_terminate{false};

void signalHandler(int signal) {
    spdlog::warn("Received signal {}, shutting down gracefully …", signal);
    g_terminate.store(true);
}
}  // namespace

// -------------------------------------------------------------
// REST handler helpers
// -------------------------------------------------------------
json sampleAssetList() {
    // Imagine this slice comes from a query handler / read replica.
    return json::array(
        {json{{"id", 1}, {"name", "NebulaBrush"}, {"type", "brush"}},
         json{{"id", 2}, {"name", "RetroShader"}, {"type", "shader"}},
         json{{"id", 3}, {"name", "BounceCurve"}, {"type", "animation"}}});
}

// -------------------------------------------------------------
// Application entry
// -------------------------------------------------------------
int main() try {
    // ---------------------------------------------------------
    // Prepare logging
    // ---------------------------------------------------------
    auto logger = spdlog::stdout_color_mt("paletteflux");
    spdlog::set_pattern("[%H:%M:%S %z] [%^%L%$] %v");
    logger->info("Booting PaletteFlux GraphQL Studio …");

    // ---------------------------------------------------------
    // Load configuration
    // ---------------------------------------------------------
    const AppConfig cfg = AppConfig::fromEnv();
    logger->info("Configuration – host: {}, port: {}, threads: {}, cacheTTL: {}s",
                 cfg.host, cfg.port, cfg.threadPoolSize, cfg.cacheTTL.count());

    // ---------------------------------------------------------
    // Instantiate shared components
    // ---------------------------------------------------------
    GraphQLExecutor      gqlExecutor;
    ResponseCache        cache{cfg.cacheTTL};
    MetricsRegistry      metrics;

    // ---------------------------------------------------------
    // Create HTTP server
    // ---------------------------------------------------------
    httplib::Server server;

    // Thread-pool
    server.new_task_queue =
        [n = cfg.threadPoolSize]() { return new httplib::ThreadPool(n); };

    // 1. GraphQL endpoint
    server.Post("/graphql",
                [&](const httplib::Request& req, httplib::Response& res) {
                    metrics.incCounter("graphql_requests");

                    // Respect content-type application/json
                    if (req.get_header_value("Content-Type").find("application/json") ==
                        std::string::npos) {
                        res.status = 415;  // Unsupported Media Type
                        return;
                    }

                    json request;
                    try {
                        request = json::parse(req.body);
                    } catch (const std::exception& ex) {
                        res.status = 400;
                        res.set_content(
                            json{{"errors",
                                  {{{"message", "Malformed JSON payload"}}}}}
                                .dump(),
                            "application/json");
                        return;
                    }

                    const std::string query = request.value("query", "");
                    const json        vars  = request.value("variables", json::object());

                    if (query.empty()) {
                        res.status = 400;
                        res.set_content(
                            json{{"errors",
                                  {{{"message", "`query` must be supplied"}}}}}
                                .dump(),
                            "application/json");
                        return;
                    }

                    // Simple cache keyed by full query + variables
                    const std::string cacheKey = query + vars.dump();
                    std::string       cached;
                    if (cache.get(cacheKey, cached)) {
                        res.set_content(cached, "application/json");
                        res.set_header("X-Cache", "HIT");
                        return;
                    }

                    json result = gqlExecutor.execute(query, vars);

                    std::string payload = result.dump();
                    cache.put(cacheKey, payload);
                    res.set_content(std::move(payload), "application/json");
                    res.set_header("X-Cache", "MISS");
                });

    // 2. REST – asset list
    server.Get("/api/assets",
               [&](const httplib::Request&, httplib::Response& res) {
                   metrics.incCounter("rest_assets_requests");

                   std::string cached;
                   if (cache.get("asset_list", cached)) {
                       res.set_content(cached, "application/json");
                       res.set_header("X-Cache", "HIT");
                       return;
                   }

                   json data = {{"data", sampleAssetList()}};
                   std::string payload = data.dump();
                   cache.put("asset_list", payload);

                   res.set_content(std::move(payload), "application/json");
                   res.set_header("X-Cache", "MISS");
               });

    // 3. Health check
    server.Get("/healthz", [&](const httplib::Request&, httplib::Response& res) {
        res.set_content("ok", "text/plain");
    });

    // 4. Metrics snapshot
    server.Get("/metrics",
               [&](const httplib::Request&, httplib::Response& res) {
                   res.set_content(metrics.snapshot().dump(), "application/json");
               });

    // ---------------------------------------------------------
    // Register signal handlers
    // ---------------------------------------------------------
    std::signal(SIGINT,  signalHandler);
    std::signal(SIGTERM, signalHandler);

    // ---------------------------------------------------------
    // Start server in a separate thread
    // ---------------------------------------------------------
    std::thread serverThread([&] {
        logger->info("HTTP server listening on {}:{}", cfg.host, cfg.port);
        if (!server.listen(cfg.host.c_str(), cfg.port)) {
            logger->error("Failed to bind on {}:{}", cfg.host, cfg.port);
            g_terminate.store(true);
        }
    });

    // Loop until termination requested
    while (!g_terminate.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }

    // Graceful shutdown
    logger->info("Termination requested, shutting down server …");
    server.stop();
    if (serverThread.joinable()) serverThread.join();

    // Flush logs + diagnostics
    logger->info("Final metrics: {}", metrics.snapshot().dump());
    spdlog::shutdown();

    return EXIT_SUCCESS;

} catch (const std::exception& ex) {
    spdlog::critical("Unhandled exception at top-level: {}", ex.what());
    return EXIT_FAILURE;
} catch (...) {
    spdlog::critical("Unknown fatal exception");
    return EXIT_FAILURE;
}
```