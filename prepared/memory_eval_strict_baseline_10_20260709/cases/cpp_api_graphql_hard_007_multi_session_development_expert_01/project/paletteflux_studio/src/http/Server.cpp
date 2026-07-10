```cpp
/**
 * PaletteFlux GraphQL Studio
 * --------------------------
 * File:    paletteflux_studio/src/http/Server.cpp
 * Author:  PaletteFlux Platform Core Team
 *
 * A minimal-yet-production-ready asynchronous HTTP server that multiplexes
 * GraphQL and REST requests on top of Boost.Beast / Boost.Asio.  The server
 * follows PaletteFlux’s MVC / CQRS architecture by delegating business logic
 * to controllers / query handlers that live in other translation units.
 *
 * The component is deliberately self-contained so it can be dropped into
 * integration/unit tests without spinning a full reverse-proxy chain.
 */

#include <boost/asio.hpp>
#include <boost/asio/signal_set.hpp>
#include <boost/beast.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <chrono>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "http/Server.hpp"  // Public header (exposed to the rest of the codebase)
#include "infra/Logging.hpp"          // Project-internal structured logger
#include "infra/metrics/Metrics.hpp"  // Prometheus-style counters/histograms
#include "services/graphql/Executor.hpp"
#include "services/rest/Router.hpp"

namespace pf {               // Root namespace for PaletteFlux
namespace http {             // HTTP delivery mechanism
namespace beast = boost::beast;
namespace net   = boost::asio;
using tcp       = net::ip::tcp;
using Request   = beast::http::request<beast::http::string_body>;
using Response  = beast::http::response<beast::http::string_body>;

namespace {

/* --------------------------------------------------------------------------
 * Utility: keep-alive duration guarding.
 * ---------------------------------------------------------------------- */
constexpr std::chrono::seconds kDefaultTimeout{30};

/* --------------------------------------------------------------------------
 * Utility: translate exceptions into HTTP 5xx responses.
 * ---------------------------------------------------------------------- */
Response makeErrorResponse(beast::http::status status,
                           const std::string &what,
                           unsigned httpVersion)
{
    Response res{status, httpVersion};
    res.set(beast::http::field::server, PF_BUILD_SERVER_TAG);
    res.set(beast::http::field::content_type, "text/plain; charset=utf-8");
    res.body() = what;
    res.prepare_payload();
    return res;
}

/* --------------------------------------------------------------------------
 * Session: one per TCP connection.
 * ---------------------------------------------------------------------- */
class Session : public std::enable_shared_from_this<Session>
{
public:
    explicit Session(tcp::socket socket,
                     Server::RouterFn  router,
                     Server::MetricsFn metricsCb)
        : socket_{std::move(socket)}
        , strand_{socket_.get_executor()}
        , router_{std::move(router)}
        , metrics_{std::move(metricsCb)}
    {}

    void run()
    {
        net::dispatch(strand_,
                      beast::bind_front_handler(&Session::doRead,
                                                shared_from_this()));
    }

private:
    tcp::socket               socket_;
    net::strand<net::io_context::executor_type> strand_;
    beast::flat_buffer        buffer_;
    Request                   req_;
    Server::RouterFn          router_;
    Server::MetricsFn         metrics_;

    void doRead()
    {
        auto self = shared_from_this();
        beast::http::async_read(
            socket_, buffer_, req_,
            net::bind_executor(
                strand_,
                [self](beast::error_code ec, std::size_t bytes) {
                    self->onRead(ec, bytes);
                }));
    }

    void onRead(beast::error_code ec, std::size_t bytes)
    {
        if (ec == beast::http::error::end_of_stream) {
            return doClose();
        }
        if (ec) {
            log::warn("Session::onRead ‑ error: {}", ec.message());
            metrics_("error");
            return;
        }

        metrics_("bytes_in", bytes);

        // Route and build response
        Response res = router_(req_);

        auto self = shared_from_this();
        beast::http::async_write(
            socket_, res,
            net::bind_executor(
                strand_,
                [self, outSize = res.body().size()](beast::error_code writeEc,
                                                    std::size_t bytesWritten) {
                    self->onWrite(writeEc, bytesWritten, outSize);
                }));
    }

    void onWrite(beast::error_code ec,
                 std::size_t /*bytesWritten*/,
                 std::size_t respSize)
    {
        if (ec) {
            log::warn("Session::onWrite ‑ error: {}", ec.message());
            metrics_("error");
            return;
        }

        metrics_("bytes_out", respSize);

        if (req_.need_eof()) {
            return doClose();
        }

        // Read another request
        req_ = {};
        doRead();
    }

    void doClose()
    {
        beast::error_code ec;
        socket_.shutdown(tcp::socket::shutdown_send, ec);
        // we ignore not_connected errors
    }
};

}  // anonymous namespace

/* ==========================================================================
 * Constructor / Destructor
 * ===================================================================== */
Server::Server(const Config &cfg)
    : cfg_{cfg}
    , io_{static_cast<int>(cfg.threadPoolSize)}
    , acceptor_{io_}
    , signals_{io_, SIGINT, SIGTERM}
{
    openAcceptor();
    prepareSignalHandling();
    buildRouter();
    log::info("HTTP server constructed on 0.0.0.0:{} ({} threads)",
              cfg_.listenPort, cfg_.threadPoolSize);
}

/* --------------------------------------------------------------------------
 * Destructor ensures `stop()` is called.
 * ---------------------------------------------------------------------- */
Server::~Server()
{
    stop();  // idempotent
}

/* ==========================================================================
 * Public API
 * ===================================================================== */
void Server::start()
{
    doAccept();

    // Run the IO context on the configured thread pool.
    for (std::size_t i = 0; i < cfg_.threadPoolSize; ++i) {
        workers_.emplace_back([this] {
            try {
                io_.run();
            }
            catch (const std::exception &ex) {
                log::error("IO thread crashed: {}", ex.what());
            }
        });
    }

    log::info("HTTP server started, accepting connections.");
}

void Server::stop()
{
    if (stopped_.exchange(true)) {
        return;  // already stopped
    }

    log::info("Shutting down HTTP server …");
    beast::error_code ec;
    acceptor_.cancel(ec);
    acceptor_.close(ec);
    signals_.cancel(ec);
    io_.stop();

    for (auto &t: workers_) { if (t.joinable()) t.join(); }
}

/* ==========================================================================
 * Internal helpers
 * ===================================================================== */
void Server::openAcceptor()
{
    tcp::endpoint endpoint{net::ip::make_address(cfg_.listenAddress),
                           cfg_.listenPort};

    beast::error_code ec;

    acceptor_.open(endpoint.protocol(), ec);
    if (ec) PF_THROW_IO_ERROR("open()", ec);

    acceptor_.set_option(net::socket_base::reuse_address(true), ec);
    if (ec) PF_THROW_IO_ERROR("set_option()", ec);

    acceptor_.bind(endpoint, ec);
    if (ec) PF_THROW_IO_ERROR("bind()", ec);

    acceptor_.listen(net::socket_base::max_listen_connections, ec);
    if (ec) PF_THROW_IO_ERROR("listen()", ec);
}

void Server::prepareSignalHandling()
{
    signals_.async_wait([this](auto /*ec*/, int /*sig*/) {
        log::info("Signal caught, initiating graceful shutdown …");
        stop();
    });
}

void Server::doAccept()
{
    acceptor_.async_accept(
        net::make_strand(io_),
        beast::bind_front_handler(&Server::onAccept, this));
}

void Server::onAccept(beast::error_code ec, tcp::socket socket)
{
    if (ec) {
        if (stopped_) return;  // ignore after shutdown
        log::warn("Accept error: {}", ec.message());
    } else {
        // Spawn session
        std::make_shared<Session>(
            std::move(socket),
            router_,
            [this](const std::string &counter, std::size_t v = 1) {
                metrics_.increment(counter, v);
            })->run();
    }

    // Keep accepting incoming connections
    if (!stopped_) doAccept();
}

/* --------------------------------------------------------------------------
 * Router set-up
 * --------------------------------------------------------------------------------
 * We rely on separate translation units for GraphQL execution and REST routing.
 * The lambdas merely bridge to those services.
 * ---------------------------------------------------------------------- */
void Server::buildRouter()
{
    // GraphQL endpoint
    auto graphqlHandler = [](const Request &req) -> Response {
        if (req.method() != beast::http::verb::post) {
            return makeErrorResponse(beast::http::status::method_not_allowed,
                                     "Only POST allowed on /graphql",
                                     req.version());
        }

        try {
            auto payload = req.body();
            auto result  = services::graphql::Executor::instance()
                               .executeJson(payload);
            Response res{beast::http::status::ok, req.version()};
            res.set(beast::http::field::content_type,
                    "application/json; charset=utf-8");
            res.body() = result.dump();
            res.prepare_payload();
            return res;
        }
        catch (const services::graphql::BadRequest &ex) {
            return makeErrorResponse(beast::http::status::bad_request,
                                     ex.what(), req.version());
        }
        catch (const std::exception &ex) {
            log::warn("GraphQL handler threw: {}", ex.what());
            return makeErrorResponse(beast::http::status::internal_server_error,
                                     "Internal Server Error",
                                     req.version());
        }
    };

    // REST routing via Router service (path-to-controller mapping)
    auto restHandler = [](const Request &req) -> Response {
        try {
            return services::rest::Router::instance().route(req);
        }
        catch (const services::rest::NotFound &ex) {
            return makeErrorResponse(beast::http::status::not_found,
                                     ex.what(),
                                     req.version());
        }
        catch (const services::rest::BadRequest &ex) {
            return makeErrorResponse(beast::http::status::bad_request,
                                     ex.what(),
                                     req.version());
        }
        catch (const std::exception &ex) {
            log::warn("REST handler threw: {}", ex.what());
            return makeErrorResponse(beast::http::status::internal_server_error,
                                     "Internal Server Error",
                                     req.version());
        }
    };

    /* Build routing table */
    router_ = [graphql = std::move(graphqlHandler),
               rest    = std::move(restHandler)]
              (const Request &req) -> Response
    {
        if (req.target() == "/graphql"sv) {
            return graphql(req);
        }
        // A very light-weight check: all others fallback to REST router
        return rest(req);
    };
}

/* ==========================================================================
 * Metrics wrapper (thin abstraction to Prometheus/StatsD/…) 
 * ===================================================================== */
void Server::Metrics::increment(const std::string &key, std::size_t v)
{
    std::lock_guard lg(mu_);
    counters_[key] += v;
}

std::unordered_map<std::string, std::uint64_t> Server::Metrics::snapshot() const
{
    std::lock_guard lg(mu_);
    return counters_;
}

}  // namespace http
}  // namespace pf
```