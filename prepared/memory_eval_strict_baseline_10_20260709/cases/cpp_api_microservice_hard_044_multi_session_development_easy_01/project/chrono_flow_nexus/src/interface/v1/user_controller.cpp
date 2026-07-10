```cpp
/**
 * chrono_flow_nexus/src/interface/v1/user_controller.cpp
 *
 * This file implements the v1 `UserController`, the glue between the
 * transport layer (HTTP / GraphQL) and the application layer
 * (`UserService`).  All validation, rate-limiting integration, and
 * coarse-grained observability lives here; domain logic stays in the
 * service layer.
 *
 * NOTE:  The public header `user_controller.hpp` exposes only the
 * `registerRoutes()` function so that higher-level bootstrap code
 * can plug the controller into the global `Router`.
 */

#include "interface/v1/user_controller.hpp"

#include "application/services/i_user_service.hpp"
#include "application/services/query/paginated_query.hpp"
#include "application/dto/paged.hpp"
#include "application/dto/user_dto.hpp"

#include "infrastructure/logging/logger.hpp"
#include "infrastructure/metrics/metrics_registry.hpp"
#include "infrastructure/rate_limit/token_bucket.hpp"

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include <utility>      // std::move
#include <exception>
#include <string_view>

using chrono_flow::application::dto::Paged;
using chrono_flow::application::dto::UserDTO;
using chrono_flow::application::services::IUserService;
using chrono_flow::infrastructure::logging::Logger;
using chrono_flow::infrastructure::metrics::Counter;
using chrono_flow::infrastructure::rate_limit::TokenBucket;
using nlohmann::json;

namespace chrono_flow::interface::v1 {

/* --------------------------------------------------------------------- */
/*  Helper utilities                                                     */
/* --------------------------------------------------------------------- */

namespace {

constexpr std::string_view kApiPrefix = "/api/v1/users";

/**
 * Convert DTO -> JSON.  Centralized here so both REST and GraphQL
 * outputs remain consistent.
 */
static json toJson(const UserDTO& dto)
{
    return json{
        {"id", dto.id},
        {"display_name", dto.displayName},
        {"email", dto.email},
        {"created_at", dto.createdAt},
        {"updated_at", dto.updatedAt},
    };
}

/**
 * Throws std::runtime_error on soft validation failures.  Hard
 * validation (unique e-mail, etc.) is delegated to `UserService`.
 */
static void validateCreationPayload(const json& body)
{
    if (!body.contains("display_name") || !body["display_name"].is_string())
    {
        throw std::runtime_error{"Field `display_name` must be a string."};
    }
    if (!body.contains("email") || !body["email"].is_string())
    {
        throw std::runtime_error{"Field `email` must be a string."};
    }
}

/**
 * Map application exceptions to HTTP status codes.  The transport
 * layer ultimately turns the enum into a numeric status line (e.g.,
 * 400, 404, 409, etc.).
 */
static Response::Status mapException(const std::exception& ex) noexcept
{
    // A comprehensive mapping would inspect custom subclasses.  For
    // brevity we only recognize a handful of common ones.
    if (dynamic_cast<const chrono_flow::application::exceptions::EntityNotFound*>(&ex))
        return Response::Status::NotFound;
    if (dynamic_cast<const chrono_flow::application::exceptions::Conflict*>(&ex))
        return Response::Status::Conflict;
    if (dynamic_cast<const chrono_flow::application::exceptions::Validation*>(&ex))
        return Response::Status::BadRequest;

    return Response::Status::InternalServerError;
}

} // namespace

/* --------------------------------------------------------------------- */
/*  ctor / dtor                                                          */
/* --------------------------------------------------------------------- */

UserController::UserController(
        std::shared_ptr<IUserService>     userService,
        std::shared_ptr<TokenBucket>      rateLimiter,
        std::shared_ptr<MetricsRegistry>  metrics)
    : m_userService{std::move(userService)}
    , m_rateLimiter{std::move(rateLimiter)}
    , m_metrics{std::move(metrics)}
    , m_logger{Logger::get("UserController")}
{
    m_reqCounter = m_metrics->counter("cf_nexus_user_requests_total",
                                      "Total number of /users HTTP requests");
}

/* --------------------------------------------------------------------- */
/*  Public API                                                           */
/* --------------------------------------------------------------------- */

void UserController::registerRoutes(Router& router)
{
    /**
     * POST /api/v1/users
     */
    router.post(std::string{kApiPrefix}, [this](const Request& req) {
        return handleCreateUser(req);
    });

    /**
     * GET /api/v1/users/:id
     */
    router.get(std::string{kApiPrefix} + "/:id", [this](const Request& req) {
        return handleGetUser(req);
    });

    /**
     * PATCH /api/v1/users/:id
     */
    router.patch(std::string{kApiPrefix} + "/:id", [this](const Request& req) {
        return handleUpdateUser(req);
    });

    /**
     * GET /api/v1/users?page=N&size=M
     */
    router.get(std::string{kApiPrefix}, [this](const Request& req) {
        return handleListUsers(req);
    });
}

/* --------------------------------------------------------------------- */
/*  Private handlers                                                     */
/* --------------------------------------------------------------------- */

Response UserController::handleCreateUser(const Request& req)
{
    auto scopeTimer = m_metrics->timerGuard("cf_nexus_user_create_latency_ms");
    ++(*m_reqCounter);

    if (!m_rateLimiter->acquire())
    {
        return Response::tooManyRequests("Rate limit exceeded.");
    }

    try
    {
        json body = json::parse(req.body());
        validateCreationPayload(body);

        UserDTO created = m_userService->createUser({
            body["display_name"].get<std::string>(),
            body["email"].get<std::string>()
        });

        m_logger->info("User created. id={}", created.id);

        return Response::created(toJson(created));
    }
    catch (const json::parse_error& ex)
    {
        m_logger->warn("JSON parse error: {}", ex.what());
        return Response::badRequest("Malformed JSON payload.");
    }
    catch (const std::exception& ex)
    {
        m_logger->warn("Create user failed: {}", ex.what());
        return Response{mapException(ex), json{{"error", ex.what()}}};
    }
}

Response UserController::handleGetUser(const Request& req)
{
    auto scopeTimer = m_metrics->timerGuard("cf_nexus_user_get_latency_ms");
    ++(*m_reqCounter);

    if (!m_rateLimiter->acquire())
    {
        return Response::tooManyRequests("Rate limit exceeded.");
    }

    try
    {
        const auto& idParam = req.params().at("id");
        UserDTO user       = m_userService->getUser(idParam);

        return Response::ok(toJson(user));
    }
    catch (const std::exception& ex)
    {
        m_logger->warn("Get user failed: {}", ex.what());
        return Response{mapException(ex), json{{"error", ex.what()}}};
    }
}

Response UserController::handleUpdateUser(const Request& req)
{
    auto scopeTimer = m_metrics->timerGuard("cf_nexus_user_update_latency_ms");
    ++(*m_reqCounter);

    if (!m_rateLimiter->acquire())
    {
        return Response::tooManyRequests("Rate limit exceeded.");
    }

    try
    {
        const auto& idParam = req.params().at("id");
        json body           = json::parse(req.body());

        // Only display_name and email are patchable for now
        std::optional<std::string> displayName;
        std::optional<std::string> email;

        if (body.contains("display_name"))
        {
            if (!body["display_name"].is_string())
                throw std::runtime_error{"`display_name` must be a string"};
            displayName = body["display_name"].get<std::string>();
        }
        if (body.contains("email"))
        {
            if (!body["email"].is_string())
                throw std::runtime_error{"`email` must be a string"};
            email = body["email"].get<std::string>();
        }

        UserDTO updated = m_userService->updateUser(idParam, displayName, email);

        return Response::ok(toJson(updated));
    }
    catch (const json::parse_error& ex)
    {
        m_logger->warn("JSON parse error: {}", ex.what());
        return Response::badRequest("Malformed JSON payload.");
    }
    catch (const std::exception& ex)
    {
        m_logger->warn("Update user failed: {}", ex.what());
        return Response{mapException(ex), json{{"error", ex.what()}}};
    }
}

Response UserController::handleListUsers(const Request& req)
{
    auto scopeTimer = m_metrics->timerGuard("cf_nexus_user_list_latency_ms");
    ++(*m_reqCounter);

    if (!m_rateLimiter->acquire())
    {
        return Response::tooManyRequests("Rate limit exceeded.");
    }

    try
    {
        std::size_t page = 0;
        std::size_t size = 25; // sensible default

        if (auto it = req.query().find("page"); it != req.query().end())
            page = std::stoul(it->second);

        if (auto it = req.query().find("size"); it != req.query().end())
            size = std::stoul(it->second);

        application::services::query::PaginatedQuery query{page, size};

        Paged<UserDTO> paged = m_userService->listUsers(query);

        json result;
        result["items"] = json::array();
        for (const auto& user : paged.items)
            result["items"].emplace_back(toJson(user));

        result["pagination"] = {
            {"page",        paged.page},
            {"size",        paged.size},
            {"total_items", paged.totalItems},
            {"total_pages", paged.totalPages}
        };

        return Response::ok(result);
    }
    catch (const std::exception& ex)
    {
        m_logger->warn("List users failed: {}", ex.what());
        return Response{mapException(ex), json{{"error", ex.what()}}};
    }
}

} // namespace chrono_flow::interface::v1
```