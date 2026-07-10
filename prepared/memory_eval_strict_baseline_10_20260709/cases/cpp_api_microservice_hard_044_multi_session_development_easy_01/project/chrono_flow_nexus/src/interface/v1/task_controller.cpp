```cpp
/**
 *  chrono_flow_nexus/src/interface/v1/task_controller.cpp
 *
 *  Copyright (c) ChronoFlow Nexus.
 *
 *  An HTTP + GraphQL controller façade that wires version-1 Task endpoints
 *  to the application layer’s Command/Query buses.  The controller is
 *  intentionally thin: it validates/normalises transport concerns, delegates
 *  business logic, and finally serialises domain objects to JSON.
 *
 *  NOTE: Only transport-specific error handling lives here—business errors
 *  belong in the application layer and are expressed via domain-specific
 *  exceptions that the controller translates to HTTP status codes.
 */

#include "interface/v1/task_controller.hpp"

// 3rd-party
#include <nlohmann/json.hpp>

// C++ STL
#include <chrono>
#include <exception>
#include <regex>
#include <utility>

using json = nlohmann::json;

namespace chrono_flow::interface::v1
{

/* --------------------------------------------------------------------------
 * ctor / dtor
 * -------------------------------------------------------------------------- */

TaskController::TaskController(http::Router&                          router,
                               application::TaskCommandBus&          commandBus,
                               application::TaskQueryBus&            queryBus,
                               infra::metrics::MetricRegistry&       metrics,
                               infra::rate_limiting::RateLimiter&    rateLimiter,
                               infra::cache::ResponseCache&          responseCache)
    : router_{router}
    , commandBus_{commandBus}
    , queryBus_{queryBus}
    , metrics_{metrics}
    , rateLimiter_{rateLimiter}
    , responseCache_{responseCache}
    , reqCounter_{metrics_.counter("http_tasks_v1_requests_total")}
    , latencyHist_{metrics_.histogram("http_tasks_v1_latency_ms")}
{
    registerRoutes();
}

/* --------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

void TaskController::registerRoutes()
{
    using namespace std::placeholders;

    router_.GET  ("/api/v1/tasks",                                 std::bind(&TaskController::getTasks,      this, _1, _2));
    router_.GET  ("/api/v1/tasks/:taskId([0-9a-fA-F-]+)",          std::bind(&TaskController::getTaskById,   this, _1, _2));
    router_.POST ("/api/v1/tasks",                                 std::bind(&TaskController::createTask,    this, _1, _2));
    router_.PATCH("/api/v1/tasks/:taskId([0-9a-fA-F-]+)",          std::bind(&TaskController::updateTask,    this, _1, _2));
    router_.DELETE("/api/v1/tasks/:taskId([0-9a-fA-F-]+)",         std::bind(&TaskController::deleteTask,    this, _1, _2));
}

/* --------------------------------------------------------------------------
 * Endpoint implementations
 * -------------------------------------------------------------------------- */

void TaskController::getTasks(const http::Request& req, http::Response& res)
{
    const auto start = std::chrono::steady_clock::now();
    reqCounter_.increment();
    auto _latencyGuard = infra::metrics::ScopeTimer{latencyHist_};

    try
    {
        // 1. Rate-limit early exit
        if (!rateLimiter_.acquire("getTasks", req.clientIp()))
        {
            res.status(http::Status::TooManyRequests).json({{"error", "rate limit exceeded"}});
            return;
        }

        // 2. Cache hit?
        const auto cacheKey = responseCache_.keyFromRequest(req);
        if (auto cached = responseCache_.get(cacheKey); cached.has_value())
        {
            res.status(http::Status::Ok)
               .header("X-Cache-Hit", "true")
               .body(cached->body)
               .type("application/json");
            return;
        }

        // 3. Parse pagination parameters
        const std::size_t page     = std::stoul(req.query("page").value_or("0"));
        const std::size_t pageSize = std::stoul(req.query("pageSize").value_or("50"));
        const std::string sort     = req.query("sort").value_or("createdAt");

        // 4. Query bus dispatch
        const application::queries::TaskPageQuery query{page, pageSize, sort};
        const auto                                dtoPage = queryBus_.dispatch(query);

        // 5. Serialise
        json j;
        j["page"]      = dtoPage.page;
        j["pageSize"]  = dtoPage.pageSize;
        j["total"]     = dtoPage.total;
        j["tasks"]     = json::array();

        for (const auto& dto : dtoPage.items)
        {
            j["tasks"].push_back(toJson(dto));
        }

        res.status(http::Status::Ok).json(j);

        // 6. Cache store (short TTL)
        responseCache_.put(cacheKey, res, std::chrono::seconds{5});
    }
    catch (const std::invalid_argument& ex)
    {
        res.status(http::Status::BadRequest).json({{"error", ex.what()}});
    }
    catch (const std::exception& ex)
    {
        log::error("Unhandled exception in GET /tasks: {}", ex.what());
        res.status(http::Status::InternalServerError).json({{"error", "internal error"}});
    }
}

void TaskController::getTaskById(const http::Request& req, http::Response& res)
{
    reqCounter_.increment();
    auto _latencyGuard = infra::metrics::ScopeTimer{latencyHist_};

    try
    {
        if (!rateLimiter_.acquire("getTaskById", req.clientIp()))
        {
            res.status(http::Status::TooManyRequests).json({{"error", "rate limit exceeded"}});
            return;
        }

        const auto& taskIdStr = req.param("taskId");
        domain::TaskId taskId{taskIdStr};

        // Query bus
        const application::queries::TaskByIdQuery query{taskId};
        const auto                                dto   = queryBus_.dispatch(query);

        res.status(http::Status::Ok).json(toJson(dto));
    }
    catch (const domain::errors::NotFound& ex)
    {
        res.status(http::Status::NotFound).json({{"error", ex.what()}});
    }
    catch (const std::exception& ex)
    {
        log::error("Unhandled exception in GET /tasks/{} : {}", req.param("taskId"), ex.what());
        res.status(http::Status::InternalServerError).json({{"error", "internal error"}});
    }
}

void TaskController::createTask(const http::Request& req, http::Response& res)
{
    reqCounter_.increment();
    auto _latencyGuard = infra::metrics::ScopeTimer{latencyHist_};

    try
    {
        if (!rateLimiter_.acquire("createTask", req.clientIp()))
        {
            res.status(http::Status::TooManyRequests).json({{"error", "rate limit exceeded"}});
            return;
        }

        const auto payload = json::parse(req.body());

        // Input validation (basic)
        if (!payload.contains("title") || !payload["title"].is_string())
        {
            res.status(http::Status::BadRequest).json({{"error", "title field missing"}});
            return;
        }

        application::commands::CreateTaskCmd cmd{
            payload["title"].get<std::string>(),
            payload.value("description", ""),
            payload.value("dueAt", std::optional<std::string>{}),
            payload.value("assigneeId", std::optional<std::string>{})
        };

        const auto newId = commandBus_.dispatch(cmd);

        res.status(http::Status::Created)
           .header("Location", "/api/v1/tasks/" + newId.to_string())
           .json({{"taskId", newId.to_string()}});
    }
    catch (const domain::errors::Validation& ex)
    {
        res.status(http::Status::UnprocessableEntity).json({{"error", ex.what()}});
    }
    catch (const std::exception& ex)
    {
        log::error("Unhandled exception in POST /tasks: {}", ex.what());
        res.status(http::Status::InternalServerError).json({{"error", "internal error"}});
    }
}

void TaskController::updateTask(const http::Request& req, http::Response& res)
{
    reqCounter_.increment();
    auto _latencyGuard = infra::metrics::ScopeTimer{latencyHist_};

    try
    {
        if (!rateLimiter_.acquire("updateTask", req.clientIp()))
        {
            res.status(http::Status::TooManyRequests).json({{"error", "rate limit exceeded"}});
            return;
        }

        domain::TaskId taskId{req.param("taskId")};
        const auto     payload = json::parse(req.body());

        application::commands::UpdateTaskCmd cmd{taskId};

        if (payload.contains("title"))       cmd.title       = payload["title"].get<std::string>();
        if (payload.contains("description")) cmd.description = payload["description"].get<std::string>();
        if (payload.contains("dueAt"))       cmd.dueAt       = payload["dueAt"].get<std::string>();
        if (payload.contains("assigneeId"))  cmd.assigneeId  = payload["assigneeId"].get<std::string>();
        if (payload.contains("status"))      cmd.status      = payload["status"].get<std::string>();

        commandBus_.dispatch(cmd);

        res.status(http::Status::NoContent);
    }
    catch (const domain::errors::NotFound& ex)
    {
        res.status(http::Status::NotFound).json({{"error", ex.what()}});
    }
    catch (const domain::errors::Validation& ex)
    {
        res.status(http::Status::UnprocessableEntity).json({{"error", ex.what()}});
    }
    catch (const std::exception& ex)
    {
        log::error("Unhandled exception in PATCH /tasks/{} : {}", req.param("taskId"), ex.what());
        res.status(http::Status::InternalServerError).json({{"error", "internal error"}});
    }
}

void TaskController::deleteTask(const http::Request& req, http::Response& res)
{
    reqCounter_.increment();
    auto _latencyGuard = infra::metrics::ScopeTimer{latencyHist_};

    try
    {
        if (!rateLimiter_.acquire("deleteTask", req.clientIp()))
        {
            res.status(http::Status::TooManyRequests).json({{"error", "rate limit exceeded"}});
            return;
        }

        domain::TaskId taskId{req.param("taskId")};

        application::commands::DeleteTaskCmd cmd{taskId};
        commandBus_.dispatch(cmd);

        res.status(http::Status::NoContent);
    }
    catch (const domain::errors::NotFound& ex)
    {
        res.status(http::Status::NotFound).json({{"error", ex.what()}});
    }
    catch (const std::exception& ex)
    {
        log::error("Unhandled exception in DELETE /tasks/{} : {}", req.param("taskId"), ex.what());
        res.status(http::Status::InternalServerError).json({{"error", "internal error"}});
    }
}

/* --------------------------------------------------------------------------
 * Helper utilities
 * -------------------------------------------------------------------------- */

json TaskController::toJson(const application::dto::TaskDto& dto)
{
    return {
        {"taskId",      dto.id.to_string()},
        {"title",       dto.title},
        {"description", dto.description},
        {"status",      dto.status},
        {"assigneeId",  dto.assigneeId ? dto.assigneeId.value().to_string() : nullptr},
        {"createdAt",   dto.createdAt},
        {"updatedAt",   dto.updatedAt},
        {"dueAt",       dto.dueAt}
    };
}

} // namespace chrono_flow::interface::v1
```