#include "http_server.hpp"

#include <boost/asio/co_spawn.hpp>
#include <boost/asio/detached.hpp>
#include <boost/asio/redirect_error.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <boost/asio/experimental/as_tuple.hpp>

#include <chrono>
#include <mutex>
#include <unordered_map>

#include "../interface/i_request_dispatcher.hpp"
#include "../common/logging/logger.hpp"
#include "../common/observability/metrics.hpp"
#include "../common/rate_limiting/token_bucket.hpp"

namespace chrono_flow::transport {

using tcp              = boost::asio::ip::tcp;
namespace http         = boost::beast::http;
namespace asio         = boost::asio;
using beast_error_code = boost::system::error_code;
using chrono           = std::chrono;

/*
 * Internal helpers & aliases
 * -------------------------------------------------- */
struct SharedState {
    std::shared_ptr<interface::IRequestDispatcher> dispatcher;
    std::shared_ptr<common::logging::Logger>       logger;
    std::shared_ptr<common::metrics::Registry>     metrics;
    std::shared_ptr<common::rate_limiting::TokenBucketFactory> token_bucket_factory;
};

/*
 * HTTPSession: One connection–one session
 * -------------------------------------------------- */
class HTTPSession final : public std::enable_shared_from_this<HTTPSession>
{
public:
    explicit HTTPSession(tcp::socket&& socket,
                         std::shared_ptr<SharedState> shared_state)
        : stream_(std::move(socket))
        , shared_state_(std::move(shared_state))
        , remote_addr_(stream_.socket().remote_endpoint().address())
    {
        shared_state_->logger->debug("HTTPSession created for {}", remote_addr_.to_string());
    }

    void start()
    {
        auto self = shared_from_this();
        asio::co_spawn(stream_.get_executor(), [self] { return self->do_read(); }, asio::detached);
    }

private:
    /* Read–process–write coroutine */
    asio::awaitable<void> do_read()
    {
        beast_error_code ec;
        for (;;)
        {
            http::request<http::string_body> req;
            co_await http::async_read(stream_, buffer_, req, asio::redirect_error(asio::use_awaitable, ec));

            if (ec == http::error::end_of_stream)
                break;  // Graceful close

            if (ec)
            {
                shared_state_->logger->warn("Read error: {}", ec.message());
                break;
            }

            // Rate-limiting check
            if (!rate_limit_pass())
            {
                co_await send_too_many_requests(req.version(), req.keep_alive());
                continue;
            }

            // Dispatch request to domain/application layer
            auto response = co_await shared_state_->dispatcher->dispatch(req);

            // Metrics
            shared_state_->metrics->increment("http_requests_total");
            shared_state_->metrics->observe("http_request_bytes", req.body().size());

            // Send response
            co_await http::async_write(stream_, *response, asio::redirect_error(asio::use_awaitable, ec));
            if (ec)
            {
                shared_state_->logger->warn("Write error: {}", ec.message());
                break;
            }

            if (!response->keep_alive())
                break;
        }

        // Graceful shutdown
        beast_error_code shutdown_ec;
        stream_.socket().shutdown(tcp::socket::shutdown_send, shutdown_ec);
    }

    bool rate_limit_pass()
    {
        auto bucket = shared_state_->token_bucket_factory->bucket_for(remote_addr_.to_string());
        return bucket->try_consume(1);
    }

    asio::awaitable<void> send_too_many_requests(unsigned version, bool keep_alive)
    {
        http::response<http::string_body> resp{http::status::too_many_requests, version};
        resp.set(http::field::server, "ChronoFlow-Nexus/" + std::to_string(Version::semver()));
        resp.set(http::field::content_type, "text/plain");
        resp.keep_alive(keep_alive);
        resp.body() = "Rate limit exceeded. Please slow down.";
        resp.prepare_payload();
        co_await http::async_write(stream_, resp, asio::use_awaitable);
    }

private:
    boost::beast::tcp_stream     stream_;
    boost::beast::flat_buffer    buffer_;
    std::shared_ptr<SharedState> shared_state_;
    boost::asio::ip::address     remote_addr_;
};

/*
 * HTTPServer: Listens and spawns sessions
 * -------------------------------------------------- */
class HTTPServer::Impl : public std::enable_shared_from_this<Impl>
{
public:
    Impl(asio::io_context& io_ctx,
         tcp::endpoint      endpoint,
         std::shared_ptr<interface::IRequestDispatcher> dispatcher,
         std::shared_ptr<common::logging::Logger> logger,
         std::shared_ptr<common::metrics::Registry> metrics,
         std::shared_ptr<common::rate_limiting::TokenBucketFactory> token_bucket_factory)
        : acceptor_(io_ctx)
        , socket_(io_ctx)
        , shared_state_(std::make_shared<SharedState>(SharedState{std::move(dispatcher),
                                                                  std::move(logger),
                                                                  std::move(metrics),
                                                                  std::move(token_bucket_factory)}))
    {
        beast_error_code ec;
        acceptor_.open(endpoint.protocol(), ec);
        if (ec) throw std::runtime_error("acceptor open: " + ec.message());

        acceptor_.set_option(asio::socket_base::reuse_address(true), ec);
        if (ec) throw std::runtime_error("acceptor set_option: " + ec.message());

        acceptor_.bind(endpoint, ec);
        if (ec) throw std::runtime_error("acceptor bind: " + ec.message());

        acceptor_.listen(asio::socket_base::max_listen_connections, ec);
        if (ec) throw std::runtime_error("acceptor listen: " + ec.message());
    }

    void run()
    {
        shared_state_->logger->info("HTTPServer listening on {}", acceptor_.local_endpoint());
        do_accept();
    }

private:
    void do_accept()
    {
        auto self = shared_from_this();
        acceptor_.async_accept(socket_, [self](beast_error_code ec) {
            if (!ec)
            {
                // Transfer ownership of the socket and spawn new session
                std::make_shared<HTTPSession>(std::move(self->socket_), self->shared_state_)->start();
            }
            else
            {
                self->shared_state_->logger->error("Accept error: {}", ec.message());
            }
            // Continue accepting
            self->do_accept();
        });
    }

private:
    tcp::acceptor                acceptor_;
    tcp::socket                  socket_;
    std::shared_ptr<SharedState> shared_state_;
};

/*
 * HTTPServer public API
 * -------------------------------------------------- */
HTTPServer::HTTPServer(asio::io_context& io_ctx,
                       const tcp::endpoint& endpoint,
                       std::shared_ptr<interface::IRequestDispatcher> dispatcher,
                       std::shared_ptr<common::logging::Logger> logger,
                       std::shared_ptr<common::metrics::Registry> metrics,
                       std::shared_ptr<common::rate_limiting::TokenBucketFactory> token_bucket_factory)
    : impl_(std::make_shared<Impl>(io_ctx,
                                   endpoint,
                                   std::move(dispatcher),
                                   std::move(logger),
                                   std::move(metrics),
                                   std::move(token_bucket_factory)))
{
}

void HTTPServer::run()
{
    impl_->run();
}

/*
 * Factory helper
 * -------------------------------------------------- */
std::shared_ptr<HTTPServer> HTTPServer::create(
    asio::io_context& io_ctx,
    const tcp::endpoint& endpoint,
    std::shared_ptr<interface::IRequestDispatcher> dispatcher,
    std::shared_ptr<common::logging::Logger> logger,
    std::shared_ptr<common::metrics::Registry> metrics,
    std::shared_ptr<common::rate_limiting::TokenBucketFactory> token_bucket_factory)
{
    return std::make_shared<HTTPServer>(io_ctx,
                                        endpoint,
                                        std::move(dispatcher),
                                        std::move(logger),
                                        std::move(metrics),
                                        std::move(token_bucket_factory));
}

}  // namespace chrono_flow::transport