#ifndef PALETTEFLUX_STUDIO_HTTP_SERVER_H
#define PALETTEFLUX_STUDIO_HTTP_SERVER_H

/*
 *  PaletteFlux GraphQL Studio – HTTP Server
 *
 *  This header provides a pragmatic, lightweight HTTP/HTTPS server façade
 *  around Boost.Beast and Boost.Asio.  While the public interface remains
 *  intentionally high-level and framework-agnostic, the implementation
 *  embraces production-grade concerns such as:
 *
 *    • Thread-pool I/O execution
 *    • Graceful shutdown with connection draining
 *    • Dynamic route registration (REST + GraphQL handler capability)
 *    • Basic observability hooks (request tracing, latency metrics)
 *    • TLS support toggle (for the API-gateway front-end)
 *
 *  Note: This header is meant to be *self-contained* so that library users
 *  can simply `#include "Server.h"` without linking extra compilation units.
 *  Only compile-time dependencies are Boost ≥ 1.78 and C++20.
 */

#include <boost/asio.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/version.hpp>
#include <boost/beast/ssl.hpp>

#include <chrono>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace pfx::http
{
    using Tcp                       = boost::asio::ip::tcp;
    namespace beast                 = boost::beast;
    namespace http                  = beast::http;
    using Request                   = http::request<http::string_body>;
    using Response                  = http::response<http::string_body>;
    using RequestHandler            = std::function<Response(Request&&)>;

    /* ---------------------------------------------------------------------- */
    /*                      Server Configuration Structure                    */
    /* ---------------------------------------------------------------------- */

    struct ServerConfig
    {
        uint16_t                port                     {8080};
        std::string             address                  {"0.0.0.0"};
        std::size_t             concurrency_hint         {std::thread::hardware_concurrency()};
        bool                    enable_tls               {false};
        std::string             cert_chain_file;    // Required if enable_tls
        std::string             private_key_file;    // Required if enable_tls
        std::string             dh_params_file;      // Optional
        std::chrono::seconds    graceful_shutdown_wait  {5};
    };

    /* ---------------------------------------------------------------------- */
    /*                            Routing Layer                               */
    /* ---------------------------------------------------------------------- */

    enum class HttpVerb : std::uint8_t
    {
        Get,
        Post,
        Put,
        Patch,
        Delete,
        Options,
        Head
    };

    struct RouteKey
    {
        std::string target;     // e.g. "/v1/assets"
        HttpVerb    verb;

        auto operator<=>(const RouteKey&) const = default;
    };

    struct RouteHasher
    {
        std::size_t operator()(const RouteKey& k) const noexcept
        {
            std::size_t seed = std::hash<std::string>{}(k.target);
            seed ^= static_cast<std::size_t>(k.verb) + 0x9e3779b9 + (seed << 6) + (seed >> 2);
            return seed;
        }
    };

    /* ---------------------------------------------------------------------- */
    /*                           Core Server Class                            */
    /* ---------------------------------------------------------------------- */

    class Server : public std::enable_shared_from_this<Server>
    {
    public:
        explicit Server(ServerConfig cfg = {}) :
            config_(std::move(cfg)),
            ioc_(static_cast<int>(std::max<std::size_t>(1, config_.concurrency_hint)))
        {
            if (config_.enable_tls)
            {
                ctx_ = create_ssl_context();
            }
        }

        ~Server()
        {
            stop(); // Ensure resources are cleaned up before destruction
        }

        /* -----------------------------  API  ----------------------------- */

        /*
         * Registers a handler for an HTTP route.  Overwrites any existing
         * handler for the same key. Thread-safe.
         */
        void register_route(const std::string& path,
                            HttpVerb verb,
                            RequestHandler handler)
        {
            std::unique_lock lock(route_mutex_);
            routes_[RouteKey{path, verb}] = std::move(handler);
        }

        /*
         * Starts the listener and thread-pool.  Non-blocking.
         */
        void start()
        {
            using namespace std::chrono_literals;

            if (running_)
                return;

            running_ = true;

            // Prepare the acceptor (with/without TLS)
            beast::error_code ec;

            Tcp::endpoint endpoint{boost::asio::ip::make_address(config_.address, ec),
                                   config_.port};
            if (ec)
                throw std::runtime_error("Invalid address: " + ec.message());

            acceptor_.emplace(ioc_);
            acceptor_->open(endpoint.protocol(), ec);
            if (ec)
                throw std::runtime_error("open: " + ec.message());

            acceptor_->set_option(boost::asio::socket_base::reuse_address(true), ec);
            if (ec)
                throw std::runtime_error("set_option: " + ec.message());

            acceptor_->bind(endpoint, ec);
            if (ec)
                throw std::runtime_error("bind: " + ec.message());

            acceptor_->listen(boost::asio::socket_base::max_listen_connections, ec);
            if (ec)
                throw std::runtime_error("listen: " + ec.message());

            do_accept();

            // Launch I/O threads
            for (std::size_t i = 0; i < config_.concurrency_hint; ++i)
            {
                thread_pool_.emplace_back([self = shared_from_this()] {
                    self->ioc_.run();
                });
            }
        }

        /*
         * Signals shutdown, waits up to `graceful_shutdown_wait`
         * for in-flight requests to finish.
         */
        void stop()
        {
            if (!running_)
                return;

            running_ = false;

            beast::error_code ec;
            if (acceptor_)
                acceptor_->close(ec); // stop accepting new connections

            // Allow current operations to finish
            std::this_thread::sleep_for(config_.graceful_shutdown_wait);

            ioc_.stop();

            for (auto& t : thread_pool_)
                if (t.joinable())
                    t.join();

            thread_pool_.clear();
        }

        /* -----------------------  Observability Hooks  ------------------- */

        void set_access_logger(std::function<void(const Request&, const Response&, std::chrono::nanoseconds)> cb)
        {
            access_logger_ = std::move(cb);
        }

    private:
        /* -----------------------  Session Management  ------------------- */

        class HttpSession : public std::enable_shared_from_this<HttpSession>
        {
        public:
            // Plain HTTP constructor
            HttpSession(beast::tcp_stream&& stream,
                        std::shared_ptr<Server> server) :
                stream_(std::move(stream)),
                server_(std::move(server))
            {}

            // HTTPS constructor
            HttpSession(beast::ssl_stream<beast::tcp_stream>&& stream,
                        std::shared_ptr<Server> server) :
                ssl_stream_(std::move(stream)),
                server_(std::move(server)),
                is_ssl_(true)
            {}

            void run()
            {
                if (is_ssl_)
                    do_handshake();
                else
                    do_read();
            }

        private:
            void do_handshake()
            {
                auto self = shared_from_this();
                ssl_stream_.async_handshake(boost::asio::ssl::stream_base::server,
                    beast::bind_front_handler(
                        &HttpSession::on_handshake,
                        self));
            }

            void on_handshake(beast::error_code ec)
            {
                if (ec)
                    return; // handshake failed, silently close

                do_read();
            }

            void do_read()
            {
                req_ = {};

                auto self = shared_from_this();
                auto& sock = is_ssl_ ? beast::get_lowest_layer(ssl_stream_) : stream_.socket();
                sock.expires_after(std::chrono::seconds(30));

                auto parser = std::make_shared<http::request_parser<http::string_body>>();
                parser->body_limit(32 * 1024 * 1024); // 32 MB payload cap

                if (is_ssl_)
                {
                    http::async_read(ssl_stream_, buffer_, *parser,
                                     beast::bind_front_handler(
                                         &HttpSession::on_read,
                                         self,
                                         parser));
                }
                else
                {
                    http::async_read(stream_, buffer_, *parser,
                                     beast::bind_front_handler(
                                         &HttpSession::on_read,
                                         self,
                                         parser));
                }
            }

            void on_read(std::shared_ptr<http::request_parser<http::string_body>> parser,
                         beast::error_code ec,
                         std::size_t bytes_transferred)
            {
                boost::ignore_unused(bytes_transferred);
                if (ec == http::error::end_of_stream)
                    return do_close();
                if (ec)
                    return; // read error

                req_ = parser->release();
                process_request();
            }

            void process_request()
            {
                auto start = std::chrono::high_resolution_clock::now();

                Response res;
                try
                {
                    res = server_->dispatch(std::move(req_));
                }
                catch (std::exception& e)
                {
                    res.result(http::status::internal_server_error);
                    res.set(http::field::content_type, "text/plain");
                    res.body() = "Internal Server Error: " + std::string(e.what());
                }

                auto elapsed = std::chrono::high_resolution_clock::now() - start;
                if (server_->access_logger_)
                    server_->access_logger_(req_, res, elapsed);

                auto self = shared_from_this();

                if (is_ssl_)
                {
                    http::async_write(ssl_stream_, res,
                        beast::bind_front_handler(&HttpSession::on_write, self, res.need_eof()));
                }
                else
                {
                    http::async_write(stream_, res,
                        beast::bind_front_handler(&HttpSession::on_write, self, res.need_eof()));
                }
            }

            void on_write(bool close, beast::error_code ec, std::size_t bytes_transferred)
            {
                boost::ignore_unused(bytes_transferred);
                if (ec)
                    return; // ignore write errors

                if (close)
                    return do_close();

                do_read();
            }

            void do_close()
            {
                beast::error_code ec;
                if (is_ssl_)
                {
                    ssl_stream_.shutdown(ec);
                    beast::get_lowest_layer(ssl_stream_).socket().shutdown(Tcp::socket::shutdown_both, ec);
                }
                else
                {
                    stream_.socket().shutdown(Tcp::socket::shutdown_both, ec);
                }
            }

            /* --------------- Session Members --------------- */

            beast::flat_buffer                 buffer_;
            Request                            req_;

            // Plain vs SSL variants – only one is active
            beast::tcp_stream                  stream_{};
            beast::ssl_stream<beast::tcp_stream> ssl_stream_{stream_.socket().get_executor().context(), boost::asio::ssl::context::tls_server};

            std::shared_ptr<Server>            server_;
            bool                               is_ssl_{false};
        };

        /* -------------------------  Accept Loop  ------------------------- */

        void do_accept()
        {
            acceptor_->async_accept(
                boost::asio::make_strand(ioc_),
                beast::bind_front_handler(
                    &Server::on_accept,
                    shared_from_this()));
        }

        void on_accept(beast::error_code ec, Tcp::socket socket)
        {
            if (ec)
            {
                std::cerr << "Accept error: " << ec.message() << '\n';
            }
            else
            {
                if (config_.enable_tls)
                {
                    // Move socket into SSL stream
                    beast::ssl_stream<beast::tcp_stream> ssl_stream{std::move(socket), *ctx_};
                    std::make_shared<HttpSession>(std::move(ssl_stream), shared_from_this())->run();
                }
                else
                {
                    beast::tcp_stream stream{std::move(socket)};
                    std::make_shared<HttpSession>(std::move(stream), shared_from_this())->run();
                }
            }

            if (running_)
                do_accept();
        }

        /* ----------------------  Routing Dispatcher  --------------------- */

        Response dispatch(Request&& req)
        {
            HttpVerb verb = to_verb(req.method());
            std::shared_lock lock(route_mutex_);

            auto it = routes_.find(RouteKey{std::string{req.target()}, verb});
            if (it == routes_.end())
            {
                // 404 fallback
                Response res{http::status::not_found, req.version()};
                res.set(http::field::content_type, "text/plain");
                res.body() = "Not Found";
                return res;
            }

            return it->second(std::move(req));
        }

        static HttpVerb to_verb(http::verb v)
        {
            switch (v)
            {
                case http::verb::get:     return HttpVerb::Get;
                case http::verb::post:    return HttpVerb::Post;
                case http::verb::put:     return HttpVerb::Put;
                case http::verb::patch:   return HttpVerb::Patch;
                case http::verb::delete_: return HttpVerb::Delete;
                case http::verb::options: return HttpVerb::Options;
                case http::verb::head:    return HttpVerb::Head;
                default:                  return HttpVerb::Get; // Fallback
            }
        }

        /* ------------------------  TLS Utilities  ------------------------ */

        std::shared_ptr<boost::asio::ssl::context> create_ssl_context()
        {
            namespace ssl = boost::asio::ssl;

            if (config_.cert_chain_file.empty() || config_.private_key_file.empty())
                throw std::runtime_error("TLS enabled but certificate/key paths not configured.");

            auto ctx = std::make_shared<ssl::context>(ssl::context::tls_server);
            ctx->set_options(
                ssl::context::default_workarounds |
                ssl::context::no_sslv2 |
                ssl::context::no_sslv3 |
                ssl::context::single_dh_use);

            ctx->use_certificate_chain_file(config_.cert_chain_file);
            ctx->use_private_key_file(config_.private_key_file, ssl::context::file_format::pem);

            if (!config_.dh_params_file.empty())
                ctx->use_tmp_dh_file(config_.dh_params_file);

            return ctx;
        }

        /* --------------------------  Members  ---------------------------- */

        ServerConfig                                                      config_;

        boost::asio::io_context                                           ioc_;
        std::optional<Tcp::acceptor>                                      acceptor_;
        std::shared_ptr<boost::asio::ssl::context>                        ctx_; // Only if TLS

        std::unordered_map<RouteKey, RequestHandler, RouteHasher>         routes_;
        std::shared_mutex                                                 route_mutex_;

        // Observability
        std::function<void(const Request&, const Response&, std::chrono::nanoseconds)> access_logger_;

        // Thread pool & lifecycle
        std::vector<std::thread>                                          thread_pool_;
        std::atomic_bool                                                  running_{false};
    };

} // namespace pfx::http

#endif // PALETTEFLUX_STUDIO_HTTP_SERVER_H