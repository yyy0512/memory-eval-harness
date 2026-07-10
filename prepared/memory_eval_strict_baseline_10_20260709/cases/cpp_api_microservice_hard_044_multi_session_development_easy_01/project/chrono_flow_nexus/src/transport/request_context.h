#ifndef CHRONO_FLOW_NEXUS_TRANSPORT_REQUEST_CONTEXT_H
#define CHRONO_FLOW_NEXUS_TRANSPORT_REQUEST_CONTEXT_H

/*
 * ChronoFlow Nexus – RequestContext
 *
 * Copyright (c) ChronoFlow
 *
 * Licensed under the MIT License.  See LICENSE file in the project root for details.
 *
 * -------------------------------------------------------------------------------
 *  Purpose
 *  -------
 *  RequestContext is the thin contract that travels across the entire execution
 *  path of a single inbound API request (REST or GraphQL).  It provides:
 *
 *    • Trace/correlation identifiers for distributed-tracing systems.
 *    • Authenticated principal + permission snapshot.
 *    • Tenant information for multi-tenant installations.
 *    • A cancellation token for cooperative aborts (timeouts, retries, client
 *      disconnects, etc.).
 *    • An extensible key–value metadata bag for feature-specific data that
 *      doesn’t belong to the domain model (pagination cursors, rate-limit cost,
 *      A/B bucket id, …).
 *
 *  The context is stored thread-locally during request processing and can be
 *  re-attached from worker pools or async continuations using the RAII
 *  ScopeGuard helper.
 *
 *  NOTE: This header is intentionally self-contained and does not rely on
 *        3rd-party libraries to keep the transport boundary lean.
 */

#include <any>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>

namespace chrono_flow::transport {

//==============================================================================
// CancellationToken
//==============================================================================

/*
 * Cooperative cancelation primitive inspired by std::stop_token (C++20) but
 * simplified for C++17.  Long-running operations periodically check the token
 * and throw a std::runtime_error when cancellation was requested.
 */
class CancellationToken
{
public:
    void request_cancel() noexcept
    {
        cancelled_.store(true, std::memory_order_release);
    }

    bool is_cancellation_requested() const noexcept
    {
        return cancelled_.load(std::memory_order_acquire);
    }

    void throw_if_cancellation_requested() const
    {
        if (is_cancellation_requested())
        {
            throw std::runtime_error("Request cancelled");
        }
    }

private:
    std::atomic<bool> cancelled_{false};
};

//==============================================================================
// RequestContext
//==============================================================================

class RequestContext
{
public:
    using Clock      = std::chrono::steady_clock;
    using TimePoint  = Clock::time_point;
    using Metadata   = std::unordered_map<std::string, std::any>;
    using PermissionsSet = std::unordered_map<std::string, bool>;

    struct ClientInfo
    {
        std::string ip_address;
        std::string user_agent;
        std::string locale;

        std::string to_string() const
        {
            std::ostringstream oss;
            oss << "{ip=\"" << ip_address << "\", ua=\"" << user_agent
                << "\", locale=\"" << locale << "\"}";
            return oss.str();
        }
    };

    //--------------------------------------------------------------------------
    // Factory helpers
    //--------------------------------------------------------------------------

    static std::shared_ptr<RequestContext> create_root(
        std::string             requestId,
        std::string             correlationId,
        std::string             httpMethod,
        std::string             path,
        ClientInfo              client,
        std::optional<std::string> tenant             = std::nullopt,
        std::optional<std::string> authenticatedUser  = std::nullopt,
        PermissionsSet          permissions           = {})
    {
        return std::shared_ptr<RequestContext>(new RequestContext{
            std::move(requestId),
            std::move(correlationId),
            std::move(httpMethod),
            std::move(path),
            std::move(client),
            std::move(tenant),
            std::move(authenticatedUser),
            std::move(permissions),
            Clock::now(),
            std::make_shared<CancellationToken>(),
            {}
        });
    }

    // Create a child context sharing the same cancellation token + correlation id.
    std::shared_ptr<RequestContext> create_child(std::string requestId_suffix = "") const
    {
        std::string childId = request_id_;
        if (!requestId_suffix.empty())
        {
            childId += "/" + requestId_suffix;
        }

        return std::shared_ptr<RequestContext>(new RequestContext{
            std::move(childId),
            correlation_id_,                 // propagate corr-id
            http_method_,
            request_path_,
            client_info_,
            tenant_,
            authenticated_user_,
            permissions_,
            receive_time_,                   // keep original timestamp
            cancellation_token_,             // shared token
            metadata_                        // shallow copy
        });
    }

    //--------------------------------------------------------------------------
    // Accessors
    //--------------------------------------------------------------------------

    const std::string& request_id()       const noexcept { return request_id_;       }
    const std::string& correlation_id()   const noexcept { return correlation_id_;   }
    const std::string& http_method()      const noexcept { return http_method_;      }
    const std::string& request_path()     const noexcept { return request_path_;     }
    const ClientInfo&  client_info()      const noexcept { return client_info_;      }
    const TimePoint&   receive_time()     const noexcept { return receive_time_;     }

    const std::optional<std::string>& tenant() const noexcept { return tenant_; }
    const std::optional<std::string>& authenticated_user() const noexcept
    {
        return authenticated_user_;
    }

    const PermissionsSet& permissions() const noexcept { return permissions_; }

    bool has_permission(const std::string& perm) const
    {
        auto it = permissions_.find(perm);
        return it != permissions_.end() && it->second;
    }

    std::shared_ptr<CancellationToken> cancellation_token() const noexcept
    {
        return cancellation_token_;
    }

    //--- Metadata -------------------------------------------------------------

    // Returns nullopt if key does not exist or cannot be cast to T.
    template <typename T>
    std::optional<T> try_get_meta(const std::string& key) const
    {
        auto it = metadata_.find(key);
        if (it == metadata_.end())
            return std::nullopt;

        try
        {
            return std::any_cast<T>(it->second);
        }
        catch (const std::bad_any_cast&)
        {
            return std::nullopt;
        }
    }

    template <typename T>
    void set_meta(std::string key, T&& value)
    {
        std::lock_guard<std::mutex> lock(meta_mutex_);
        metadata_[std::move(key)] = std::any(std::forward<T>(value));
    }

    //--------------------------------------------------------------------------
    // JSON representation (for structured logs / traces)
    //--------------------------------------------------------------------------

    std::string to_json() const
    {
        std::ostringstream oss;
        oss << "{"
            << "\"requestId\":\""      << request_id_       << "\","
            << "\"correlationId\":\""  << correlation_id_   << "\","
            << "\"method\":\""         << http_method_      << "\","
            << "\"path\":\""           << request_path_     << "\","
            << "\"tenant\":"           << (tenant_ ? "\"" + *tenant_ + "\"" : "null") << ","
            << "\"user\":"             << (authenticated_user_ ? "\"" + *authenticated_user_ + "\"" : "null") << ","
            << "\"client\":"           << "\"" << client_info_.to_string() << "\""
            << "}";
        return oss.str();
    }

    //--------------------------------------------------------------------------
    // Thread-local binding helpers
    //--------------------------------------------------------------------------

    // Returns current context for the calling thread or throws.
    static std::shared_ptr<RequestContext> current()
    {
        auto ptr = current_raw();
        if (!ptr)
        {
            throw std::runtime_error("RequestContext::current() called outside of a bound scope");
        }
        return ptr;
    }

    static bool has_current() noexcept
    {
        return static_cast<bool>(current_raw());
    }

    /*
     * ScopeGuard
     * ----------
     * Binds a RequestContext to the calling thread for the lifetime of the
     * guard.  Nested scopes restore the previous context automatically.
     */
    class ScopeGuard
    {
    public:
        explicit ScopeGuard(std::shared_ptr<RequestContext> ctx) noexcept
            : previous_(current_raw())
        {
            current_raw() = std::move(ctx);
        }

        // Non-copyable
        ScopeGuard(const ScopeGuard&)            = delete;
        ScopeGuard& operator=(const ScopeGuard&) = delete;

        // Move-enabled
        ScopeGuard(ScopeGuard&& other) noexcept
            : previous_(std::move(other.previous_))
        {
            other.previous_.reset();
        }

        ScopeGuard& operator=(ScopeGuard&&) = delete;

        ~ScopeGuard() noexcept
        {
            current_raw() = std::move(previous_);
        }

    private:
        std::shared_ptr<RequestContext> previous_;
    };

private:
    //--------------------------------------------------------------------------
    // Implementation details
    //--------------------------------------------------------------------------

    RequestContext(std::string             requestId,
                   std::string             correlationId,
                   std::string             httpMethod,
                   std::string             path,
                   ClientInfo              client,
                   std::optional<std::string> tenant,
                   std::optional<std::string> authenticatedUser,
                   PermissionsSet          permissions,
                   TimePoint               receivedAt,
                   std::shared_ptr<CancellationToken> cancelToken,
                   Metadata                metadata)
        : request_id_(std::move(requestId)),
          correlation_id_(std::move(correlationId)),
          http_method_(std::move(httpMethod)),
          request_path_(std::move(path)),
          client_info_(std::move(client)),
          tenant_(std::move(tenant)),
          authenticated_user_(std::move(authenticatedUser)),
          permissions_(std::move(permissions)),
          receive_time_(receivedAt),
          cancellation_token_(std::move(cancelToken)),
          metadata_(std::move(metadata))
    {
    }

    // Thread-local storage accessor
    static std::shared_ptr<RequestContext>& current_raw() noexcept
    {
        thread_local std::shared_ptr<RequestContext> tls_ctx;
        return tls_ctx;
    }

private:
    std::string             request_id_;
    std::string             correlation_id_;
    std::string             http_method_;
    std::string             request_path_;
    ClientInfo              client_info_;
    std::optional<std::string> tenant_;
    std::optional<std::string> authenticated_user_;
    PermissionsSet          permissions_;
    TimePoint               receive_time_;
    std::shared_ptr<CancellationToken> cancellation_token_;

    Metadata                metadata_;
    mutable std::mutex      meta_mutex_; // protects metadata_ for concurrent reads/writes
};

} // namespace chrono_flow::transport

#endif // CHRONO_FLOW_NEXUS_TRANSPORT_REQUEST_CONTEXT_H