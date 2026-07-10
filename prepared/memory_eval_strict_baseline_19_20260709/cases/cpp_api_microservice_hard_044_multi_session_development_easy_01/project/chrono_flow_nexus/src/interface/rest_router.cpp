```cpp
/**
 *  chrono_flow_nexus/src/interface/rest_router.cpp
 *
 *  ChronoFlow Nexus — Interface Layer
 *  -----------------------------------
 *  This file wires REST endpoints to application-layer services using
 *  Pistache’s high-performance router.  All HTTP/JSON concerns terminate
 *  here; no business rules leak outside the application layer.  Endpoints
 *  are versioned, instrumented, and guarded by lightweight validation so
 *  transport-agnostic services remain blissfully unaware of HTTP details.
 *
 *  NOTE:
 *      1. Only routing/transport glue lives here—no business logic.
 *      2. Exceptions are translated to structured JSON error documents.
 *      3. All responses are compliant with RFC 7807 (Problem Details).
 */

#include "interface/rest_router.hpp"

#include <chrono>
#include <regex>
#include <utility>

#include <nlohmann/json.hpp>
#include <pistache/optional.h>
#include <pistache/router.h>

#include "application/services/task_service.hpp"
#include "application/services/time_entry_service.hpp"
#include "application/services/workload_service.hpp"
#include "infrastructure/observability/logger.hpp"
#include "infrastructure/observability/tracing.hpp"
#include "infrastructure/validation/iso8601.hpp"

using namespace Pistache;
using nlohmann::json;

namespace chrono_flow::interface {

// -----------------------------------------------------------------------------
// Helper utilities
// -----------------------------------------------------------------------------

namespace {

constexpr const char* kApiVersion = "v1";
constexpr std::chrono::seconds kDefaultTimeout{3};

enum class HttpMethod { Get, Post, Put, Patch, Del };

struct Error
{
    std::string type;
    std::string title;
    std::string detail;
    Http::Code httpCode;
};

static Http::Header::ContentType jsonCt{MIME(Application, Json)};

[[nodiscard]] json
error_to_json(const Error& err)
{
    return {
        {"type",   err.type},
        {"title",  err.title},
        {"detail", err.detail},
    };
}

/**
 * Converts a string to a std::chrono::system_clock::time_point.
 * Throws if the format doesn’t match ISO-8601.
 */
[[nodiscard]] std::chrono::system_clock::time_point
parse_instant(const std::string& iso)
{
    if (iso.empty())
        throw std::invalid_argument("Timestamp must not be empty");

    return infrastructure::validation::parse_iso8601(iso);
}

void
send_error(const Rest::Request& req,
           Http::ResponseWriter   res,
           const Error&           err)
{
    infrastructure::observability::log_warning(
        "Request {} {} failed: {}", req.method(), req.resource(), err.detail);

    res.headers().add<Http::Header::ContentType>(jsonCt);
    res.send(err.httpCode, error_to_json(err).dump());
}

// -----------------------------------------------------------------------------
// Adapter lambdas
// -----------------------------------------------------------------------------

auto make_time_entries_list_handler(
    std::shared_ptr<application::TimeEntryService> timeSvc)
{
    return [timeSvc](const Rest::Request& req, Http::ResponseWriter res) {
        try
        {
            const auto userId = req.query().get("userId").getOrElse("");
            const auto fromTs = req.query().get("from").getOrElse("");
            const auto toTs   = req.query().get("to").getOrElse("");

            if (userId.empty())
                throw std::invalid_argument("Query parameter 'userId' missing");

            auto fromInstant = parse_instant(fromTs);
            auto toInstant   = toTs.empty()
                                   ? std::chrono::system_clock::now()
                                   : parse_instant(toTs);

            const auto entries = timeSvc->fetch_entries(userId, fromInstant,
                                                        toInstant);

            json j{};
            j["data"] = json::array();
            for (const auto& e : entries)
                j["data"].push_back(e);

            res.headers().add<Http::Header::ContentType>(jsonCt);
            res.send(Http::Code::Ok, j.dump());
        }
        catch (const std::invalid_argument& ia)
        {
            send_error(req, std::move(res),
                       {"/validation-error", "Validation Error", ia.what(),
                        Http::Code::Bad_Request});
        }
        catch (const std::exception& ex)
        {
            send_error(req, std::move(res),
                       {"/internal-error", "Internal Server Error", ex.what(),
                        Http::Code::Internal_Server_Error});
        }
    };
}

auto make_time_entry_create_handler(
    std::shared_ptr<application::TimeEntryService> timeSvc)
{
    return [timeSvc](const Rest::Request& req, Http::ResponseWriter res) {
        try
        {
            const auto body = json::parse(req.body());
            const auto userId  = body.at("userId").get<std::string>();
            const auto taskId  = body.at("taskId").get<std::string>();
            const auto started = parse_instant(body.at("started").get<std::string>());
            const auto stopped = parse_instant(body.at("stopped").get<std::string>());

            auto entryId = timeSvc->create_entry(userId, taskId, started, stopped);

            res.headers().add<Http::Header::ContentType>(jsonCt);
            res.send(Http::Code::Created, json{{"id", entryId}}.dump());
        }
        catch (const json::exception& je)
        {
            send_error(req, std::move(res),
                       {"/parse-error", "JSON Parse Error", je.what(),
                        Http::Code::Bad_Request});
        }
        catch (const std::invalid_argument& ia)
        {
            send_error(req, std::move(res),
                       {"/validation-error", "Validation Error", ia.what(),
                        Http::Code::Bad_Request});
        }
        catch (const std::exception& ex)
        {
            send_error(req, std::move(res),
                       {"/internal-error", "Internal Server Error", ex.what(),
                        Http::Code::Internal_Server_Error});
        }
    };
}

auto make_task_get_handler(std::shared_ptr<application::TaskService> taskSvc)
{
    return [taskSvc](const Rest::Request& req, Http::ResponseWriter res) {
        const auto id = req.param(":id").as<std::string>();

        try
        {
            auto task = taskSvc->find_by_id(id);
            if (!task.has_value())
            {
                send_error(
                    req, std::move(res),
                    {"/not-found", "Not Found",
                     "Task with id '" + id + "' does not exist",
                     Http::Code::Not_Found});
                return;
            }

            res.headers().add<Http::Header::ContentType>(jsonCt);
            res.send(Http::Code::Ok, json(*task).dump());
        }
        catch (const std::exception& ex)
        {
            send_error(req, std::move(res),
                       {"/internal-error", "Internal Server Error", ex.what(),
                        Http::Code::Internal_Server_Error});
        }
    };
}

auto make_workload_summary_handler(
    std::shared_ptr<application::WorkloadService> workloadSvc)
{
    return [workloadSvc](const Rest::Request& req, Http::ResponseWriter res) {
        try
        {
            const auto teamId    = req.query().get("teamId").getOrElse("");
            const auto rangeIso  = req.query().get("range").getOrElse("P7D");

            if (teamId.empty())
                throw std::invalid_argument("Parameter 'teamId' must be provided");

            const auto range = infrastructure::validation::parse_iso8601_period(rangeIso);
            auto summary     = workloadSvc->summary_for(teamId, range);

            res.headers().add<Http::Header::ContentType>(jsonCt);
            res.send(Http::Code::Ok, json(summary).dump());
        }
        catch (const std::invalid_argument& ia)
        {
            send_error(req, std::move(res),
                       {"/validation-error", "Validation Error", ia.what(),
                        Http::Code::Bad_Request});
        }
        catch (const std::exception& ex)
        {
            send_error(req, std::move(res),
                       {"/internal-error", "Internal Server Error", ex.what(),
                        Http::Code::Internal_Server_Error});
        }
    };
}

}  // namespace

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

void
RestRouter::init(Pistache::Rest::Router& router,
                 const std::shared_ptr<application::TimeEntryService>& timeSvc,
                 const std::shared_ptr<application::TaskService>&      taskSvc,
                 const std::shared_ptr<application::WorkloadService>&  workloadSvc)
{
    using namespace std::literals;

    const auto base = std::string{"/api/"} + kApiVersion;

    // ----------------------------------------------------------------------
    // v1/time-entries                                                         
    // ----------------------------------------------------------------------
    router.addRoute(
        Http::Method::Get, base + "/time-entries",
        make_time_entries_list_handler(timeSvc));

    router.addRoute(
        Http::Method::Post, base + "/time-entries",
        make_time_entry_create_handler(timeSvc));

    // ----------------------------------------------------------------------
    // v1/tasks/:id                                                            
    // ----------------------------------------------------------------------
    router.addRoute(Http::Method::Get, base + "/tasks/:id",
                    make_task_get_handler(taskSvc));

    // ----------------------------------------------------------------------
    // v1/workload/summary                                                     
    // ----------------------------------------------------------------------
    router.addRoute(
        Http::Method::Get, base + "/workload/summary",
        make_workload_summary_handler(workloadSvc));

    infrastructure::observability::log_info(
        "REST routes for ChronoFlow Nexus (version {}) initialized", kApiVersion);
}

}  // namespace chrono_flow::interface
```