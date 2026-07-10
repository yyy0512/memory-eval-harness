#include "interface/rate_limiter_middleware.hpp"

#include "common/http/http_constants.hpp"
#include "common/http/request_context.hpp"
#include "common/logging/logger.hpp"
#include "common/metrics/metrics_registry.hpp"
#include "infrastructure/rate_limiter_service.hpp"

#include <chrono>
#include <cstdlib>
#include <exception>
#include <optional>
#include <sstream>
#include <string>
#include <utility>

namespace chrono_flow_nexus::interface {

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

namespace {

// Format a std::chrono::system_clock::time_point as a UNIX epoch seconds string.
std::string toUnixEpochSeconds(const std::chrono::system_clock::time_point& tp)
{
    using namespace std::chrono;
    const auto secs = duration_cast<seconds>(tp.time_since_epoch()).count();
    return std::to_string(secs);
}

// Default weight for a request (used for REST, non-batched GraphQL queries).
constexpr std::uint32_t kDefaultCost = 1u;

} // namespace

// ---------------------------------------------------------------------------------------------------------------------
// RateLimiterMiddleware implementation
// ---------------------------------------------------------------------------------------------------------------------

RateLimiterMiddleware::RateLimiterMiddleware(
    std::shared_ptr<infrastructure::RateLimiterService> rateLimiter,
    std::chrono::milliseconds                         externalTimeout,
    logging::Logger                                   logger)
    : rateLimiter_(std::move(rateLimiter))
    , externalTimeout_(externalTimeout)
    , logger_(std::move(logger))
    , metrics_(common::metrics::MetricsRegistry::instance())
{
    if (!rateLimiter_) { throw std::invalid_argument("RateLimiterMiddleware: rateLimiter must not be null"); }
}

void RateLimiterMiddleware::operator()(common::http::RequestContext& ctx,
                                       const NextCallback&          next) const
{
    try
    {
        // Allow requests coming from trusted infrastructure components to bypass rate-limits.
        if (isExempt(ctx))
        {
            next(ctx);
            return;
        }

        const std::string key     = computeKey(ctx);
        const std::uint32_t cost  = requestCost(ctx);
        const auto decision       = rateLimiter_->consume(key, cost, externalTimeout_);
        const bool       allowed  = decision.allowed;

        // Surface bucket metadata for both success and throttled responses.
        applyRateLimitHeaders(ctx, decision);

        if (!allowed)
        {
            // Metrics
            metrics_.incrementCounter("rate_limiting.dropped_requests", {{"route", ctx.routeName()}});

            // Build 429 response
            buildThrottledResponse(ctx, decision);
            return;
        }

        // Metrics
        metrics_.incrementCounter("rate_limiting.passed_requests", {{"route", ctx.routeName()}});

        // Request within limits → hand over to next stage.
        next(ctx);
    }
    catch (const std::exception& ex)
    {
        // Fail-open on rate-limiter errors but log aggressively.
        logger_.error("RateLimiterMiddleware: unexpected error '{}', failing open", ex.what());
        metrics_.incrementCounter("rate_limiting.errors", {});

        next(ctx);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------------------------------------------------

bool RateLimiterMiddleware::isExempt(const common::http::RequestContext& ctx) const
{
    // Example exemptions:
    // 1) Requests carrying an internal service token
    // 2) Health-check probes
    // 3) API routes explicitly marked as "public"

    if (ctx.headers().contains(common::http::constants::kHeaderInternalRequest))
    {
        return true;
    }

    if (ctx.routeName() == "/health" || ctx.routeName() == "/readiness")
    {
        return true;
    }

    return false;
}

std::string RateLimiterMiddleware::computeKey(const common::http::RequestContext& ctx) const
{
    // Give precedence to authenticated user id; otherwise fall back to client IP.
    if (ctx.auth().has_value())
    {
        return "u:" + ctx.auth()->principalId;
    }

    return "ip:" + ctx.clientIp();
}

std::uint32_t RateLimiterMiddleware::requestCost(const common::http::RequestContext& ctx) const
{
    // GraphQL requests can submit multiple operations in a single payload.
    if (ctx.isGraphQL())
    {
        const auto gqlCost = ctx.additionalMetadata().getUInt("graphql.operation_count", 1U);
        return std::max(gqlCost, kDefaultCost);
    }

    return kDefaultCost;
}

void RateLimiterMiddleware::applyRateLimitHeaders(common::http::RequestContext&                  ctx,
                                                  const infrastructure::RateLimiterDecision&     decision) const
{
    ctx.response().setHeader("X-RateLimit-Limit", std::to_string(decision.limit));
    ctx.response().setHeader("X-RateLimit-Remaining", std::to_string(decision.remaining));

    if (decision.resetAt.has_value())
    {
        ctx.response().setHeader("X-RateLimit-Reset", toUnixEpochSeconds(*decision.resetAt));
    }

    if (decision.retryAfterSeconds > 0)
    {
        ctx.response().setHeader("Retry-After", std::to_string(decision.retryAfterSeconds));
    }
}

void RateLimiterMiddleware::buildThrottledResponse(
    common::http::RequestContext&              ctx,
    const infrastructure::RateLimiterDecision& decision) const
{
    ctx.response().status(common::http::Status::TooManyRequests);
    ctx.response().setContentType(common::http::constants::kMimeJson);

    std::ostringstream payload;
    payload << R"({"error":{"code":429,"message":"Rate limit exceeded","details":{")"
            << R"("limit":)" << decision.limit << R"(,"remaining":0)"
            << R"(,"retry_after":)" << decision.retryAfterSeconds << R"(}}})";

    ctx.response().body(payload.str());

    logger_.warn("Request throttled (key='{}', limit={}, cost={}, retry_after={}s)",
                 computeKey(ctx),
                 decision.limit,
                 requestCost(ctx),
                 decision.retryAfterSeconds);
}

} // namespace chrono_flow_nexus::interface