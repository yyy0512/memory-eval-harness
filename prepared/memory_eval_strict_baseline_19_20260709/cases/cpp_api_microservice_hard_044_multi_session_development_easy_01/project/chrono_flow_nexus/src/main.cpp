```cpp
// chrono_flow_nexus/src/main.cpp
//
// ChronoFlow Nexus – main entry point.
//
// This file wires up transport (HTTP / GraphQL), observability (logging + metrics),
// configuration loading, adaptive rate–limiting, and graceful-shutdown handling.
//
// Dependencies (external):
//   - Boost (asio, beast)
//   - spdlog
//   - yaml-cpp
//   - prometheus-cpp
//
// Build (example):
//   g++ -std=c++20 -O2 -pthread main.cpp -lboost_system -lboost_thread -lyaml-cpp \
//       -lspdlog -lprometheus-cpp-core -lprometheus-cpp-pull -o chrono_flow_nexus
//

#include <atomic>
#include <chrono>
#include <csignal>
#include <filesystem>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>

#include <prometheus/exposer.h>
#include <prometheus/registry.h>
#include <prometheus/counter.h>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_color_sinks.h>

#include <yaml-cpp/yaml.h>

namespace cf_nexus
{
namespace net   = boost::asio;
namespace beast = boost::beast;
namespace http  = beast::http;
using tcp       = net::ip::tcp;

constexpr std::string_view kVersion = "1.4.2";   // simulated semantic version

//--------------------------------------------------------------------------
// Config ------------------------------------------------------------------
struct ServerConfig
{
    std::string host                 = "0.0.0.0";
    std::uint16_t port               = 8090;
    std::uint16_t metrics_port       = 9100;
    std::size_t   thread_pool_size   = std::thread::hardware_concurrency();
    std::uint32_t rate_limit_qps     = 50;  // per-IP, quick and dirty
    std::string   log_level          = "info";

    static ServerConfig load_from_file(const std::filesystem::path& file)
    {
        ServerConfig cfg;
        if (!std::filesystem::exists(file))
        {
            spdlog::warn("Config file {} not found, using defaults.", file.string());
            return cfg;
        }

        YAML::Node root = YAML::LoadFile(file.string());
        if (root["server"])
        {
            const auto s = root["server"];
            cfg.host               = s["host"].as<std::string>(cfg.host);
            cfg.port               = s["port"].as<std::uint16_t>(cfg.port);
            cfg.thread_pool_size   = s["threads"].as<std::size_t>(cfg.thread_pool_size);
            cfg.rate_limit_qps     = s["rate_limit_qps"].as<std::uint32_t>(cfg.rate_limit_qps);
        }
        if (root["metrics"])
        {
            const auto m = root["metrics"];
            cfg.metrics_port = m["port"].as<std::uint16_t>(cfg.metrics_port);
        }
        if (root["logging"])
        {
            cfg.log_level = root["logging"]["level"].as<std::string>(cfg.log_level);
        }
        return cfg;
    }
};

//--------------------------------------------------------------------------
// Simple token-bucket rate limiter (per process, not per-IP for brevity). --
class TokenBucketRateLimiter
{
public:
    explicit TokenBucketRateLimiter(uint32_t qps, uint32_t capacity = 100)
        : _capacity(capacity),
          _tokens(capacity),
          _fill_per_sec(qps),
          _last_fill(std::chrono::steady_clock::now())
    {}

    bool allow()
    {
        std::lock_guard lock(_mtx);

        using namespace std::chrono;
        const auto now    = steady_clock::now();
        const auto delta  = duration_cast<microseconds>(now - _last_fill).count();
        const double to_add = (delta / 1'000'000.0) * _fill_per_sec;

        if (to_add >= 1.0)
        {
            _tokens = std::min<double>(_capacity, _tokens + to_add);
            _last_fill = now;
        }

        if (_tokens >= 1.0)
        {
            _tokens -= 1.0;
            return true;
        }
        return false;
    }

private:
    const double  _capacity;
    double        _tokens;
    const double  _fill_per_sec;
    std::chrono::steady_clock::time_point _last_fill;
    std::mutex    _mtx;
};

//--------------------------------------------------------------------------
// HTTP session ------------------------------------------------------------
class HTTPSession : public std::enable_shared_from_this<HTTPSession>
{
public:
    HTTPSession(tcp::socket socket,
                TokenBucketRateLimiter& limiter,
                std::shared_ptr<prometheus::Counter> req_counter,
                std::shared_ptr<prometheus::Counter> err_counter)
        : _socket(std::move(socket)),
          _buffer(),
          _limiter(limiter),
          _req_counter(std::move(req_counter)),
          _err_counter(std::move(err_counter))
    {}

    void run()
    {
        do_read();
    }

private:
    void do_read()
    {
        auto self = shared_from_this();
        http::async_read(_socket, _buffer, _req,
            [this, self](beast::error_code ec, std::size_t) {
                if (ec == http::error::end_of_stream)
                    return do_close();
                if (ec)
                {
                    spdlog::error("read error: {}", ec.message());
                    _err_counter->Increment();
                    return;
                }
                // Rate-limit check
                if (!_limiter.allow())
                {
                    http::response<http::string_body> too_many_req{http::status::too_many_requests, _req.version()};
                    too_many_req.set(http::field::content_type, "text/plain");
                    too_many_req.body() = "rate limit exceeded";
                    too_many_req.prepare_payload();
                    return do_write(std::move(too_many_req));
                }

                handle_request();
            });
    }

    void handle_request()
    {
        _req_counter->Increment();

        http::response<http::string_body> res{http::status::ok, _req.version()};
        res.set(http::field::content_type, "application/json");
        res.keep_alive(_req.keep_alive());

        const std::string_view target = _req.target();
        if (_req.method() == http::verb::get && target == "/health")
        {
            res.body() = R"({"status":"ok","service":"chrono_flow_nexus","version":")" + std::string(kVersion) + "\"}";
        }
        else if (target == "/graphql")
        {
            // Placeholder – normally forward to GraphQL subsystem.
            res.body() = R"({"error":"GraphQL endpoint not implemented in this build"})";
            res.result(http::status::not_implemented);
        }
        else
        {
            res.body() = R"({"error":"resource not found"})";
            res.result(http::status::not_found);
        }
        res.prepare_payload();
        return do_write(std::move(res));
    }

    void do_write(http::response<http::string_body>&& msg)
    {
        auto self = shared_from_this();
        auto sp = std::make_shared<http::response<http::string_body>>(std::move(msg));
        http::async_write(_socket, *sp,
            [this, self, sp](beast::error_code ec, std::size_t) {
                if (ec)
                    spdlog::error("write error: {}", ec.message());
                if (!sp->keep_alive())
                    do_close();
                else
                    do_read(); // allow pipelining
            });
    }

    void do_close()
    {
        beast::error_code ec;
        _socket.shutdown(tcp::socket::shutdown_send, ec);
    }

    tcp::socket                   _socket;
    beast::flat_buffer            _buffer;
    http::request<http::string_body> _req;

    TokenBucketRateLimiter&       _limiter;
    std::shared_ptr<prometheus::Counter> _req_counter;
    std::shared_ptr<prometheus::Counter> _err_counter;
};

//--------------------------------------------------------------------------
// HTTP listener (acceptor) ------------------------------------------------
class HTTPListener : public std::enable_shared_from_this<HTTPListener>
{
public:
    HTTPListener(net::io_context& ioc,
                 tcp::endpoint endpoint,
                 TokenBucketRateLimiter& limiter,
                 std::shared_ptr<prometheus::Counter> req_counter,
                 std::shared_ptr<prometheus::Counter> err_counter)
        : _acceptor(ioc),
          _socket(ioc),
          _limiter(limiter),
          _req_counter(std::move(req_counter)),
          _err_counter(std::move(err_counter))
    {
        beast::error_code ec;
        _acceptor.open(endpoint.protocol(), ec);
        if (ec) throw beast::system_error{ec};

        _acceptor.set_option(net::socket_base::reuse_address(true), ec);
        if (ec) throw beast::system_error{ec};

        _acceptor.bind(endpoint, ec);
        if (ec) throw beast::system_error{ec};

        _acceptor.listen(net::socket_base::max_listen_connections, ec);
        if (ec) throw beast::system_error{ec};
    }

    void run()
    {
        do_accept();
    }

private:
    void do_accept()
    {
        auto self = shared_from_this();
        _acceptor.async_accept(_socket,
            [this, self](beast::error_code ec) {
                if (!ec)
                {
                    std::make_shared<HTTPSession>(std::move(_socket), _limiter,
                                                   _req_counter, _err_counter)
                        ->run();
                }
                else
                {
                    spdlog::error("accept error: {}", ec.message());
                }
                do_accept();
            });
    }

    tcp::acceptor                     _acceptor;
    tcp::socket                       _socket;
    TokenBucketRateLimiter&           _limiter;
    std::shared_ptr<prometheus::Counter> _req_counter;
    std::shared_ptr<prometheus::Counter> _err_counter;
};

//--------------------------------------------------------------------------
// Signal handling ---------------------------------------------------------
std::atomic<bool> g_terminate{false};

void signal_handler(int signo)
{
    spdlog::warn("Received signal {}, shutting down …", signo);
    g_terminate.store(true);
}

//--------------------------------------------------------------------------
// Logging setup -----------------------------------------------------------
void init_logging(const std::string& level)
{
    auto sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
    auto logger = std::make_shared<spdlog::logger>("cf_nexus", sink);
    spdlog::set_default_logger(logger);

    spdlog::set_pattern("[%Y-%m-%d %T.%e] [%^%l%$] %v");

    static const std::unordered_map<std::string, spdlog::level::level_enum> kMap{
        {"trace", spdlog::level::trace}, {"debug", spdlog::level::debug},
        {"info", spdlog::level::info},   {"warn", spdlog::level::warn},
        {"error", spdlog::level::err},   {"critical", spdlog::level::critical}};

    auto it = kMap.find(level);
    spdlog::set_level(it != kMap.end() ? it->second : spdlog::level::info);
}

//--------------------------------------------------------------------------
// Main --------------------------------------------------------------------
int main(int argc, char* argv[])
{
    try
    {
        const std::filesystem::path config_path =
            argc > 1 ? argv[1] : std::filesystem::path{"./config.yaml"};

        // Config & logging
        ServerConfig cfg = ServerConfig::load_from_file(config_path);
        init_logging(cfg.log_level);

        spdlog::info("Starting ChronoFlow Nexus v{}", kVersion);
        spdlog::info("Binding HTTP on {}:{}", cfg.host, cfg.port);

        // Prometheus exposer
        prometheus::Exposer exposer{"0.0.0.0:" + std::to_string(cfg.metrics_port)};
        auto registry = std::make_shared<prometheus::Registry>();

        auto& http_family     = prometheus::BuildCounter()
                                    .Name("cf_http_requests_total")
                                    .Help("Total HTTP requests")
                                    .Register(*registry);
        auto& http_err_family = prometheus::BuildCounter()
                                    .Name("cf_http_errors_total")
                                    .Help("Total HTTP error responses")
                                    .Register(*registry);

        auto http_counter     = http_family.Add({});
        auto http_err_counter = http_err_family.Add({});

        exposer.RegisterCollectable(registry);

        // Rate limiter (global)
        TokenBucketRateLimiter limiter(cfg.rate_limit_qps);

        // ASIO context
        net::io_context ioc(static_cast<int>(cfg.thread_pool_size));

        // Start listener
        auto endpoint = tcp::endpoint(net::ip::make_address(cfg.host), cfg.port);
        std::make_shared<HTTPListener>(ioc, endpoint, limiter,
                                       http_counter, http_err_counter)
            ->run();

        // OS signals
        std::signal(SIGINT, signal_handler);
        std::signal(SIGTERM, signal_handler);

        // Thread pool
        std::vector<std::thread> threads;
        for (std::size_t i = 1; i < cfg.thread_pool_size; ++i)
        {
            threads.emplace_back([&ioc] { ioc.run(); });
        }
        // Run on main thread
        spdlog::info("HTTP server running with {} threads", cfg.thread_pool_size);
        while (!g_terminate.load())
        {
            ioc.run_one();
        }
        ioc.stop();
        for (auto& t : threads) t.join();

        spdlog::info("ChronoFlow Nexus stopped gracefully.");
    }
    catch (const std::exception& ex)
    {
        spdlog::critical("Fatal exception: {}", ex.what());
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}

```