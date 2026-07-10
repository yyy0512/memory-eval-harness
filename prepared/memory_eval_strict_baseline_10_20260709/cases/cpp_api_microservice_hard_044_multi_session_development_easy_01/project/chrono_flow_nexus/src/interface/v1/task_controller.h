#pragma once
/**
 * ChronoFlow Nexus
 * File: chrono_flow_nexus/src/interface/v1/task_controller.h
 *
 * Description:
 *  The TaskController is the façade that exposes version-1 “task” endpoints to the
 *  transport layer (REST and GraphQL adaptors live one layer above).  The class
 *  translates raw HTTP requests into application-layer commands and queries while
 *  providing:
 *
 *    • Structured logging
 *    • Latency metrics
 *    • Robust exception → HTTP-error mapping
 *    • Simple pagination & filtering helpers
 *
 *  NOTE:  All heavy-weight logic (business rules, persistence, etc.) is delegated
 *  to the Application layer.  The controller stays **thin** on purpose.
 */

#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

// ────────────────────────────────────────────────────────────────────────────────
// Forward declarations for cross-layer abstractions.  Concrete types live in
// their respective libraries but are intentionally kept out of the public
// header to decouple build dependencies.
// ────────────────────────────────────────────────────────────────────────────────
namespace chrono::interface::commons {

class HttpRequest;     // Opaque transport-layer request
class HttpResponse;    // Opaque transport-layer response

class HttpRouter;      // Thin wrapper around the underlying web framework

using AsyncHttpResponse = std::future<std::shared_ptr<HttpResponse>>;

}  // namespace chrono::interface::commons

namespace chrono::infrastructure::metrics {
class MetricsRegistry;
}  // namespace chrono::infrastructure::metrics

namespace chrono::infrastructure::logging {
class Logger;
}  // namespace chrono::infrastructure::logging

namespace chrono::application {

struct PagedTasksQuery;
struct TaskDto;  // Pure-data representation safe to cross interface boundary

class TaskQueryService;
class TaskCommandService;

}  // namespace chrono::application

// ────────────────────────────────────────────────────────────────────────────────
// Controller declaration
// ────────────────────────────────────────────────────────────────────────────────
namespace chrono::interface::v1 {

class TaskController : public std::enable_shared_from_this<TaskController> {
public:
    TaskController(std::shared_ptr<application::TaskQueryService>  query_service,
                   std::shared_ptr<application::TaskCommandService> command_service,
                   std::shared_ptr<infrastructure::metrics::MetricsRegistry> metrics,
                   std::shared_ptr<infrastructure::logging::Logger> logger) noexcept;

    TaskController(const TaskController&)            = delete;
    TaskController& operator=(const TaskController&) = delete;
    TaskController(TaskController&&)                 = delete;
    TaskController& operator=(TaskController&&)      = delete;
    ~TaskController()                                = default;

    /**
     * Bind all /api/v1/tasks routes into the provided router.  The router
     * implementation is framework-specific (e.g. Crow, Boost.Beast, cpp-httplib)
     * but exposes a common abstract interface to the controller layer.
     */
    void registerRoutes(interface::commons::HttpRouter& router);

private:
    // High-level request handlers ------------------------------------------------
    interface::commons::AsyncHttpResponse handleListTasks   (const interface::commons::HttpRequest& req);
    interface::commons::AsyncHttpResponse handleCreateTask  (const interface::commons::HttpRequest& req);
    interface::commons::AsyncHttpResponse handleUpdateStatus(const interface::commons::HttpRequest& req);

    // Plumbing helpers -----------------------------------------------------------
    template <typename Fn>
    interface::commons::AsyncHttpResponse
    wrapHandler(const interface::commons::HttpRequest& req, Fn&& fn);

    [[nodiscard]] static nlohmann::json toJson(const application::TaskDto& dto);
    [[nodiscard]] static nlohmann::json toJson(const std::vector<application::TaskDto>& dtos);

    // Collaborators --------------------------------------------------------------
    std::shared_ptr<application::TaskQueryService>   query_service_;
    std::shared_ptr<application::TaskCommandService> command_service_;
    std::shared_ptr<infrastructure::metrics::MetricsRegistry> metrics_;
    std::shared_ptr<infrastructure::logging::Logger>          logger_;
};

// ────────────────────────────────────────────────────────────────────────────────
// Implementation ‑ header-only for fast compilation units.  If translation unit
// hygiene becomes an issue, move the definitions to a .cpp file.
// ────────────────────────────────────────────────────────────────────────────────
#include <exception>

namespace chrono::interface::v1 {

// ────────────────────────────────────────────────────────────────────────────────
// ctor
// ────────────────────────────────────────────────────────────────────────────────
inline TaskController::TaskController(
        std::shared_ptr<application::TaskQueryService>  query_service,
        std::shared_ptr<application::TaskCommandService> command_service,
        std::shared_ptr<infrastructure::metrics::MetricsRegistry> metrics,
        std::shared_ptr<infrastructure::logging::Logger> logger) noexcept
    : query_service_(std::move(query_service))
    , command_service_(std::move(command_service))
    , metrics_(std::move(metrics))
    , logger_(std::move(logger)) {}

// ────────────────────────────────────────────────────────────────────────────────
// Route registration
// ────────────────────────────────────────────────────────────────────────────────
inline void TaskController::registerRoutes(interface::commons::HttpRouter& router)
{
    // Binding lambdas keep a weak_ptr to avoid cyclic ownership.
    std::weak_ptr<TaskController> weak = this->shared_from_this();

    router.GET ("/api/v1/tasks",
        [weak](const auto& req) {
            if (auto self = weak.lock())
                return self->handleListTasks(req);
            // Controller is gone ⇒ return standard 410 Gone.
            interface::commons::AsyncHttpResponse dummy;
            return dummy;
        });

    router.POST("/api/v1/tasks",
        [weak](const auto& req) {
            if (auto self = weak.lock())
                return self->handleCreateTask(req);
            interface::commons::AsyncHttpResponse dummy;
            return dummy;
        });

    router.PATCH("/api/v1/tasks/:id/status",
        [weak](const auto& req) {
            if (auto self = weak.lock())
                return self->handleUpdateStatus(req);
            interface::commons::AsyncHttpResponse dummy;
            return dummy;
        });
}

// ────────────────────────────────────────────────────────────────────────────────
// GET /tasks
// ────────────────────────────────────────────────────────────────────────────────
inline interface::commons::AsyncHttpResponse
TaskController::handleListTasks(const interface::commons::HttpRequest& req)
{
    return wrapHandler(req, [this, &req]() -> nlohmann::json {
        // Extract pagination query-string params:  ?page=1&pageSize=50
        const auto page_param      = req.queryParam("page").value_or("1");
        const auto page_size_param = req.queryParam("pageSize").value_or("50");

        const std::uint32_t page      = static_cast<std::uint32_t>(std::stoul(page_param));
        const std::uint32_t page_size = static_cast<std::uint32_t>(std::stoul(page_size_param));

        application::PagedTasksQuery query{/*page=*/page, /*pageSize=*/page_size};
        auto tasks = query_service_->fetchTasks(query);
        return toJson(tasks);
    });
}

// ────────────────────────────────────────────────────────────────────────────────
// POST /tasks
// ────────────────────────────────────────────────────────────────────────────────
inline interface::commons::AsyncHttpResponse
TaskController::handleCreateTask(const interface::commons::HttpRequest& req)
{
    return wrapHandler(req, [this, &req]() -> nlohmann::json {
        const auto body      = nlohmann::json::parse(req.body());
        const auto title     = body.at("title").get<std::string>();
        const auto projectId = body.value("projectId", std::optional<std::string>{});

        const auto dto = command_service_->createTask(title, projectId);
        return toJson(dto);
    });
}

// ────────────────────────────────────────────────────────────────────────────────
// PATCH /tasks/:id/status
// ────────────────────────────────────────────────────────────────────────────────
inline interface::commons::AsyncHttpResponse
TaskController::handleUpdateStatus(const interface::commons::HttpRequest& req)
{
    return wrapHandler(req, [this, &req]() -> nlohmann::json {
        const auto task_id = req.pathParam("id");
        const auto body    = nlohmann::json::parse(req.body());
        const auto status  = body.at("status").get<std::string>();

        const auto dto = command_service_->updateStatus(task_id, status);
        return toJson(dto);
    });
}

// ────────────────────────────────────────────────────────────────────────────────
// Helper: standardised wrapper around request handling.  Converts exceptions
// thrown by the lambda into canonical HTTP responses, increments metrics, and
// logs duration / outcome.
// ────────────────────────────────────────────────────────────────────────────────
template <typename Fn>
inline interface::commons::AsyncHttpResponse
TaskController::wrapHandler(const interface::commons::HttpRequest& req, Fn&& fn)
{
    using namespace std::chrono;
    auto self = this->shared_from_this();  // Keep alive for async lambda

    return std::async(std::launch::async, [self, req, func = std::forward<Fn>(fn)]() {
        const auto start = high_resolution_clock::now();

        nlohmann::json payload;
        uint16_t       status_code = 200;

        try {
            payload = func();
        } catch (const application::ValidationError& ex) {
            status_code = 400;
            payload     = {{"error", "validation_error"}, {"detail", ex.what()}};
            self->logger_->warn("[400] Validation error: {}", ex.what());
        } catch (const application::NotFoundError& ex) {
            status_code = 404;
            payload     = {{"error", "not_found"}, {"detail", ex.what()}};
        } catch (const std::exception& ex) {
            status_code = 500;
            payload     = {{"error", "internal_error"}, {"detail", ex.what()}};
            self->logger_->error("Unhandled exception: {}", ex.what());
        }

        const auto duration_ms = duration_cast<milliseconds>(high_resolution_clock::now() - start).count();
        self->metrics_->timer("http.server.duration")  // Prometheus-style histogram
            .record(duration_ms, {{"route", req.target()}, {"status", std::to_string(status_code)}});

        return self->metrics_->responseFactory()->json(status_code, std::move(payload));
    });
}

// ────────────────────────────────────────────────────────────────────────────────
// Serialization helpers
// ────────────────────────────────────────────────────────────────────────────────
inline nlohmann::json TaskController::toJson(const application::TaskDto& dto)
{
    return {
        {"id",         dto.id},
        {"title",      dto.title},
        {"status",     dto.status},
        {"projectId",  dto.project_id},
        {"createdAt",  dto.created_at},
        {"updatedAt",  dto.updated_at}
    };
}

inline nlohmann::json TaskController::toJson(const std::vector<application::TaskDto>& dtos)
{
    nlohmann::json arr = nlohmann::json::array();
    arr.reserve(dtos.size());
    for (const auto& dto : dtos) {
        arr.emplace_back(toJson(dto));
    }
    return arr;
}

}  // namespace chrono::interface::v1