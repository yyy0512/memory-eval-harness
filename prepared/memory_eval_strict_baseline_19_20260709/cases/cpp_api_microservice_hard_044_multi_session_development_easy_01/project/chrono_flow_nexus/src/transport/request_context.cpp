#include "transport/request_context.hpp"

#include <atomic>
#include <boost/uuid/uuid_generators.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <chrono>
#include <memory>
#include <spdlog/spdlog.h>
#include <string>
#include <utility>

#include "infrastructure/metrics/registry.hpp"   // Metrics registry abstraction.

/*
 *  Implementation of RequestContext, the transport-layer carrier for all
 *  per-request metadata (correlation-id, tenant, authenticated principal …).
 *
 *  The object is thread-safe and designed to travel across async boundaries
 *  by means of std::shared_ptr<>.  A thread-local slot keeps the “current”
 *  context so downstream code can fetch it without explicit parameter
 *  plumbing, while the nested ScopeGuard disables accidental leaks in cases
 *  where worker threads are re-used (e.g. a thread-pool).
 */

namespace chrono_flow_nexus::transport {

namespace {

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Very cheap UUIDv4 – good enough for correlation IDs.
std::string generateCorrelationId()
{
    static thread_local boost::uuids::random_generator gen;
    return boost::uuids::to_string(gen());
}

} // namespace


// ---------------------------------------------------------------------------
// Thread-local plumbing
// ---------------------------------------------------------------------------

thread_local std::weak_ptr<RequestContext> RequestContext::tlsCurrent_;

// static
std::shared_ptr<RequestContext> RequestContext::current()
{
    return tlsCurrent_.lock();
}

// static
void RequestContext::setCurrent(const std::shared_ptr<RequestContext>& ctx)
{
    tlsCurrent_ = ctx;
}

// static
void RequestContext::reset()
{
    tlsCurrent_.reset();
}



// ---------------------------------------------------------------------------
// ctor / dtor
// ---------------------------------------------------------------------------

RequestContext::RequestContext(std::string              correlation,
                               std::string              tenant,
                               std::string              principal,
                               std::string              remoteAddr,
                               Headers                  headers,
                               std::chrono::system_clock::time_point startedAt)
    : correlationId_(correlation.empty() ? generateCorrelationId() : std::move(correlation))
    , tenant_(std::move(tenant))
    , principal_(std::move(principal))
    , remoteAddr_(std::move(remoteAddr))
    , headers_(std::move(headers))
    , startedAt_(startedAt == std::chrono::system_clock::time_point{}
                     ? std::chrono::system_clock::now()
                     : startedAt)
    , cancelled_(std::make_shared<std::atomic_bool>(false))
    , logger_(spdlog::get("request") ? spdlog::get("request") : spdlog::default_logger())
{
    logger_->trace("RequestContext created [cid={}, tenant={}, principal={}, addr={}]",
                   correlationId_, tenant_, principal_, remoteAddr_);
}

RequestContext::~RequestContext()
{
    try
    {
        const auto elapsed =
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now() -
                                                                  startedAt_)
                .count();
        logger_->trace("RequestContext destroyed [cid={}, elapsed={}ms]", correlationId_, elapsed);
    }
    catch (...)
    {
        // noexcept ‑ never let exceptions propagate from dtor.
    }
}



// ---------------------------------------------------------------------------
// accessors
// ---------------------------------------------------------------------------

const std::string& RequestContext::correlationId() const noexcept { return correlationId_; }
const std::string& RequestContext::tenant() const noexcept { return tenant_; }
const std::string& RequestContext::principal() const noexcept { return principal_; }
const std::string& RequestContext::remoteAddr() const noexcept { return remoteAddr_; }
const RequestContext::Headers& RequestContext::headers() const noexcept { return headers_; }
std::chrono::system_clock::time_point RequestContext::startedAt() const noexcept
{
    return startedAt_;
}



// ---------------------------------------------------------------------------
// logging helpers
// ---------------------------------------------------------------------------

void RequestContext::logDebug(std::string_view msg) const
{
    logger_->debug("[cid={}] {}", correlationId_, msg);
}

void RequestContext::logInfo(std::string_view msg) const
{
    logger_->info("[cid={}] {}", correlationId_, msg);
}

void RequestContext::logWarn(std::string_view msg) const
{
    logger_->warn("[cid={}] {}", correlationId_, msg);
}

void RequestContext::logError(std::string_view msg) const
{
    logger_->error("[cid={}] {}", correlationId_, msg);
}



// ---------------------------------------------------------------------------
// cancellation support
// ---------------------------------------------------------------------------

void RequestContext::cancel()
{
    const bool expected = false;
    if (cancelled_ && cancelled_->compare_exchange_strong(const_cast<bool&>(expected), true))
    {
        logger_->warn("RequestContext cancelled [cid={}]", correlationId_);
    }
}

bool RequestContext::isCancelled() const noexcept
{
    return cancelled_ && cancelled_->load(std::memory_order_relaxed);
}



// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

void RequestContext::observe(std::string_view metricName, double value) const
{
    if (auto* reg = metrics::Registry::instance())
    {
        reg->observe(metricName,
                     value,
                     {{"correlation_id", correlationId_}, {"tenant", tenant_}});
    }
}



// ---------------------------------------------------------------------------
// ScopeGuard impl
// ---------------------------------------------------------------------------

RequestContext::ScopeGuard::ScopeGuard(std::shared_ptr<RequestContext> ctx)
    : previous_(RequestContext::current())
{
    RequestContext::setCurrent(std::move(ctx));
}

RequestContext::ScopeGuard::~ScopeGuard()
{
    RequestContext::setCurrent(previous_);
}

} // namespace chrono_flow_nexus::transport