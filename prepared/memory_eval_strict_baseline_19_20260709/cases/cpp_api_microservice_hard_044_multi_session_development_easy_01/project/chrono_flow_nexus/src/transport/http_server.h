```cpp
#pragma once
/**
 * chrono_flow_nexus/src/transport/http_server.h
 *
 * A lightweight yet production-grade asynchronous HTTP 1.1 server built on
 * Boost.Beast / Boost.Asio.  The server is opinionated to match ChronoFlow
 * Nexus’ transport-layer conventions: it is non-blocking, cancellable,
 * instrumented for observability, and provides hooks for request validation,
 * adaptive rate-limiting, and structured logging.  A request is delegated to a
 * user-supplied Router functor that converts an HTTP request to its
 * corresponding HTTP response (REST or GraphQL).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  Copyright (c) 2023-2024 ChronoFlow
 * ──────────────────────────────────────────────────────────────────────────────
 */

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>

#include <boost/asio.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>

namespace chrono_flow::transport {

namespace beast  = boost::beast;
namespace http   = beast::http;
namespace asio   = boost::asio;
using     tcp    = asio::ip::tcp;

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

/**
 * Router:
 * Function object that maps an HTTP request → HTTP response.  Thread-safe.
 *
 * NOTE: The Router concept is intentionally light so that the transport layer
 * can remain agnostic of the Interface/Application layers.  In production the
 * Router would be implemented by the REST / GraphQL interface boundary where
 * it can integrate validation, authentication and domain dispatching.
 */
using Router =
    std::function<http::response<http::string_body>(http::request<http::string_body>)>;

/**
 * RateLimiter:
 * Interface for adaptive, token-bucket like rate-limiting.  Implemented in the
 * infrastructure layer; injected here for transport concerns.  Concrete
 * implementations can leverage Redis, Token-Bucket algorithms, or Envoy filters.
 */
class RateLimiter
{
public:
    virtual ~RateLimiter() = default;

    // Obtains a token for the caller-identified key (e.g. API key or IP addr).
    // Returns `true` if the request is permitted, `false` otherwise.
    [[nodiscard]] virtual bool acquire(const std::string& caller_key) = 0;
};

/* -------------------------------------------------------------------------- */
/*                               Helper utilities                             */
/* -------------------------------------------------------------------------- */
inline http::response<http::string_body>
make_error_response(http::status status,
                    const std::string& what,
                    const bool keep_alive) noexcept
{
    http::response<http::string_body> res{status, /*version=*/11};
    res.set(http::field::content_type, "application/json");
    res.keep_alive(keep_alive);
    res.body() = std::string{R"({"error":")"} + what + R"("})";
    res.prepare_payload();
    return res;
}

/* -------------------------------------------------------------------------- */
/*                                   Session                                  */
/* -------------------------------------------------------------------------- */

/**
 * HttpSession
 *
 *  Manages a single TCP connection.  Lifespan is self-owned (shared_ptr) and
 *  terminates when the socket closes.  Each request is processed sequentially
 *  to respect HTTP/1.1 ordering guarantees.  Keep-alive is supported.
 */
class HttpSession : public std::enable_shared_from_this<HttpSession>
{
public:
    HttpSession(tcp::socket&& socket,
                std::shared_ptr<Router> router,
                std::shared_ptr<RateLimiter> rate_limiter,
                std::chrono::seconds request_timeout = std::chrono::seconds{20})
        : stream_(std::move(socket)),
          router_(std::move(router)),
          rate_limiter_(std::move(rate_limiter)),
          deadline_(stream_.get_executor()),
          request_timeout_(request_timeout)
    {
        // Disable Nagle to reduce latency.
        beast::error_code ec;
        stream_.socket().set_option(asio::ip::tcp::no_delay(true), ec);
    }

    /* ------------------------------ Life-cycle ----------------------------- */

    // Start the asynchronous session.
    void run()
    {
        do_read();
        on_deadline_check();
    }

    /* ---------------------------------------------------------------------- */

private:
    /* ------------------------------- Reading ------------------------------ */

    void do_read()
    {
        // Reset the deadline.
        deadline_.expires_after(request_timeout_);

        // Make the request empty before reading,
        // otherwise the operation behavior is undefined.
        req_ = {};

        // Read a request
        http::async_read(
            stream_,
            buffer_,
            req_,
            beast::bind_front_handler(&HttpSession::on_read, shared_from_this()));
    }

    void on_read(beast::error_code ec, std::size_t bytes_transferred)
    {
        boost::ignore_unused(bytes_transferred);

        if (ec == http::error::end_of_stream)
            return do_close();

        if (ec) {
            // Unexpected error
            return fail(ec, "read");
        }

        // Check rate-limiting
        const auto caller_key = req_.base()["X-Api-Key"].to_string();
        if (rate_limiter_ && !rate_limiter_->acquire(caller_key)) {
            res_ = make_error_response(http::status::too_many_requests,
                                       "Rate limit exceeded",
                                       req_.keep_alive());
        } else {
            // Delegate routing.
            try {
                res_ = (*router_)(std::move(req_));
                res_.keep_alive(res_.need_eof() ? false : req_.keep_alive());
            } catch (const std::exception& ex) {
                res_ = make_error_response(http::status::internal_server_error,
                                           ex.what(),
                                           req_.keep_alive());
            }
        }

        // Write the response
        http::async_write(
            stream_,
            res_,
            beast::bind_front_handler(&HttpSession::on_write,
                                      shared_from_this(),
                                      res_.need_eof()));
    }

    /* ------------------------------- Writing ------------------------------ */

    void on_write(bool close, beast::error_code ec, std::size_t bytes_transferred)
    {
        boost::ignore_unused(bytes_transferred);

        if (ec)
            return fail(ec, "write");

        if (close) {
            // Close connection gracefully
            return do_close();
        }

        // Clear response and initiate another read for pipelining / keep-alive.
        res_ = {};
        do_read();
    }

    /* ------------------------------- Closing ------------------------------ */

    void do_close()
    {
        beast::error_code ec;
        stream_.socket().shutdown(tcp::socket::shutdown_send, ec);
        // At this point the session object will be destroyed.
    }

    /* -------------------------- Timeout management ------------------------ */

    void on_deadline_check()
    {
        if (deadline_.expiry() <= std::chrono::steady_clock::now()) {
            // The deadline has passed.  Close socket to cancel outstanding ops.
            beast::error_code ec;
            stream_.socket().close(ec);
            return; // <- If closed, session will be destroyed soon.
        }

        // Put the actor back to sleep.
        deadline_.async_wait(
            beast::bind_front_handler(&HttpSession::on_deadline_check,
                                      shared_from_this()));
    }

    /* ----------------------------- Utilities ------------------------------ */

    static void fail(beast::error_code ec, std::string_view what)
    {
        // In a production service this should be replaced with structured
        // logging (e.g., OpenTelemetry).
        std::cerr << "[transport] " << what << ": " << ec.message() << "\n";
    }

    /* --------------------------- Data members ----------------------------- */
    beast::tcp_stream                 stream_;
    beast::flat_buffer                buffer_;
    http::request<http::string_body>  req_;
    http::response<http::string_body> res_;

    std::shared_ptr<Router>           router_;
    std::shared_ptr<RateLimiter>      rate_limiter_;

    asio::steady_timer                deadline_;
    std::chrono::seconds              request_timeout_;
};

/* -------------------------------------------------------------------------- */
/*                                   Server                                   */
/* -------------------------------------------------------------------------- */

/**
 * HttpServer
 *
 * Accepts incoming TCP connections and spins up `HttpSession` instances to
 * handle them.  Thread-safe stop() permits idempotent, coordinated shutdowns.
 */
class HttpServer : public std::enable_shared_from_this<HttpServer>
{
public:
    HttpServer(asio::io_context& ioc,
               std::string        address,
               std::uint16_t      port,
               std::shared_ptr<Router> router,
               std::shared_ptr<RateLimiter> rate_limiter = nullptr,
               std::size_t        max_pending_accepts = 1024)
        : ioc_(ioc),
          acceptor_(ioc),
          router_(std::move(router)),
          rate_limiter_(std::move(rate_limiter)),
          is_stopping_(false),
          max_pending_accepts_(max_pending_accepts)
    {
        // Resolve address & bind acceptor.
        const auto ip_addr  = asio::ip::make_address(address);
        const auto endpoint = tcp::endpoint{ip_addr, port};

        beast::error_code ec;

        acceptor_.open(endpoint.protocol(), ec);
        if (ec)
            throw beast::system_error{ec};

        // Allow address reuse.
        acceptor_.set_option(asio::socket_base::reuse_address(true), ec);
        if (ec)
            throw beast::system_error{ec};

        acceptor_.bind(endpoint, ec);
        if (ec)
            throw beast::system_error{ec};

        acceptor_.listen(static_cast<int>(max_pending_accepts_), ec);
        if (ec)
            throw beast::system_error{ec};
    }

    /* ----------------------------- Life-cycle ----------------------------- */

    // Starts accepting connections asynchronously.
    void run()
    {
        do_accept();
    }

    // Thread-safe, idempotent shutdown.
    void stop()
    {
        const bool expected = false;
        if (is_stopping_.compare_exchange_strong(expected, true)) {
            beast::error_code ec;
            acceptor_.cancel(ec);
            acceptor_.close(ec);
        }
    }

    ~HttpServer()
    {
        stop();
    }

    /* ---------------------------------------------------------------------- */

private:
    void do_accept()
    {
        acceptor_.async_accept(
            asio::make_strand(ioc_),
            beast::bind_front_handler(
                &HttpServer::on_accept,
                shared_from_this()));
    }

    void on_accept(beast::error_code ec, tcp::socket socket)
    {
        if (ec) {
            if (ec == asio::error::operation_aborted)
                return; // Shutting down
            std::cerr << "[transport] accept: " << ec.message() << "\n";
        } else {
            // Launch the session for this connection
            std::make_shared<HttpSession>(
                std::move(socket),
                router_,
                rate_limiter_)->run();
        }

        if (!is_stopping_)
            do_accept(); // Accept next connection
    }

    /* ------------------------------ Members ------------------------------- */
    asio::io_context&       ioc_;
    tcp::acceptor           acceptor_;

    std::shared_ptr<Router>       router_;
    std::shared_ptr<RateLimiter>  rate_limiter_;

    std::atomic_bool        is_stopping_;
    std::size_t             max_pending_accepts_;
};

} // namespace chrono_flow::transport
```