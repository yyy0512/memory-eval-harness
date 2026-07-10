// File: paletteflux_studio/src/api/v1/rest/SceneController.cpp

/*
 *  PaletteFlux GraphQL Studio
 *  --------------------------
 *  Copyright (c) PaletteFlux
 *
 *  SceneController.cpp
 *
 *  REST controller exposing /api/v1/scenes endpoints.
 *
 *  The controller:
 *     • Delegates reads to SceneQueryService (CQRS query side).
 *     • Delegates mutations to SceneCommandService (CQRS command side).
 *     • Performs HTTP-aware concerns: routing, validation, pagination,
 *       serialization, error mapping, cache headers, and basic metrics.
 *
 *  Dependencies (provided by the parent project):
 *     • Pistache (HTTP routing)
 *     • nlohmann::json (serialization)
 *     • spdlog (logging)
 *     • SceneQueryService / SceneCommandService (domain layer)
 *
 *  NOTE: Implementations of the above services are not part of this file;
 *  only the orchestration logic that glues them to HTTP.
 */

#include <algorithm>
#include <chrono>
#include <memory>
#include <regex>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>
#include <pistache/async.h>
#include <pistache/http.h>
#include <pistache/router.h>
#include <spdlog/spdlog.h>

#include "api/v1/rest/SceneController.hpp"     // Corresponding header
#include "application/scene/SceneCommandService.hpp"
#include "application/scene/SceneQueryService.hpp"
#include "infrastructure/http/HttpUtils.hpp"
#include "infrastructure/metrics/Timer.hpp"

using nlohmann::json;
using namespace std::chrono_literals;

namespace paletteflux::api::v1::rest {

// -----------------------------
// Utilities
// -----------------------------

// Very small helper for validation.
namespace {

bool isUuid(const std::string& candidate)
{
    static const std::regex kUuidRegex(
        R"([0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[1-5][0-9a-fA-F]{3}\-[89abAB][0-9a-fA-F]{3}\-[0-9a-fA-F]{12})",
        std::regex::optimize);

    return std::regex_match(candidate, kUuidRegex);
}

struct Pagination
{
    std::size_t page     = 1;
    std::size_t perPage  = 20;
};

Pagination parsePagination(const Pistache::Rest::Request& req)
{
    Pagination p;
    if (req.hasQuery("page")) {
        p.page = std::max<std::size_t>(1, req.query().get("page").getOrElse("1").asNumber());
    }
    if (req.hasQuery("per_page")) {
        p.perPage = std::clamp<std::size_t>(req.query().get("per_page").getOrElse("20").asNumber(),
                                            1, 250);
    }
    return p;
}

}   // namespace

// -----------------------------
// SceneController impl
// -----------------------------

SceneController::SceneController(
    Pistache::Rest::Router& router,
    std::shared_ptr<application::scene::SceneQueryService> queryService,
    std::shared_ptr<application::scene::SceneCommandService> commandService)
    : m_router(router)
    , m_queryService(std::move(queryService))
    , m_commandService(std::move(commandService))
{
}

void SceneController::initRoutes()
{
    using namespace Pistache::Rest;

    Routes::Get(m_router, "/api/v1/scenes", Routes::bind(&SceneController::listScenes, this));
    Routes::Get(m_router, "/api/v1/scenes/:id", Routes::bind(&SceneController::getScene, this));

    Routes::Post(m_router, "/api/v1/scenes", Routes::bind(&SceneController::createScene, this));
    Routes::Patch(m_router, "/api/v1/scenes/:id", Routes::bind(&SceneController::updateScene, this));
    Routes::Delete(m_router, "/api/v1/scenes/:id", Routes::bind(&SceneController::deleteScene, this));

    spdlog::info("SceneController routes initialised");
}

// -----------------------------
// Handlers
// -----------------------------

void SceneController::listScenes(const Pistache::Rest::Request& req,
                                 Pistache::Http::ResponseWriter      res)
{
    infrastructure::metrics::Timer timer("SceneController.listScenes");

    try {
        auto pagination = parsePagination(req);

        application::scene::SceneQueryService::ScenePageQuery query{
            pagination.page, pagination.perPage
        };

        const auto [total, scenes] = m_queryService->fetchPage(std::move(query));

        json payload;
        payload["total"]     = total;
        payload["page"]      = pagination.page;
        payload["per_page"]  = pagination.perPage;
        payload["data"]      = scenes;                            // SceneDTO is json-serialisable.

        infrastructure::http::addCacheHeaders(res, 10s);
        res.send(Pistache::Http::Code::Ok, payload.dump());
    } catch (const std::exception& ex) {
        spdlog::error("Failed to list scenes: {}", ex.what());
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Internal_Server_Error,
                                        "internal_error",
                                        "Failed to list scenes");
    }
}

void SceneController::getScene(const Pistache::Rest::Request& req,
                               Pistache::Http::ResponseWriter      res)
{
    const auto id = req.param(":id").as<std::string>();

    if (!isUuid(id)) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "invalid_id",
                                        "Provided scene id is not a valid UUID");
        return;
    }

    infrastructure::metrics::Timer timer("SceneController.getScene");

    try {
        auto sceneOpt = m_queryService->fetchById(id);
        if (!sceneOpt) {
            infrastructure::http::sendError(res,
                                            Pistache::Http::Code::Not_Found,
                                            "scene_not_found",
                                            "Scene not found");
            return;
        }

        infrastructure::http::addCacheHeaders(res, 30s);
        res.send(Pistache::Http::Code::Ok, sceneOpt->dump());
    } catch (const std::exception& ex) {
        spdlog::error("Failed to get scene {}: {}", id, ex.what());
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Internal_Server_Error,
                                        "internal_error",
                                        "Failed to fetch scene");
    }
}

void SceneController::createScene(const Pistache::Rest::Request& req,
                                  Pistache::Http::ResponseWriter      res)
{
    infrastructure::metrics::Timer timer("SceneController.createScene");

    json body;
    try {
        body = json::parse(req.body());
    } catch (const json::parse_error& ex) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "invalid_json",
                                        "Request body contains invalid JSON");
        return;
    }

    // Basic validation
    if (!body.contains("name") || !body["name"].is_string()) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "missing_field",
                                        "`name` is required");
        return;
    }

    try {
        application::scene::CreateSceneCmd cmd;
        cmd.name        = body["name"].get<std::string>();
        cmd.description = body.value("description", "");
        cmd.ownerId     = req.headers().getRaw("X-User-Id").value_or(""); // Example of auth propagation

        auto createdScene = m_commandService->createScene(std::move(cmd));

        res.headers().add<Pistache::Http::Header::Location>("/api/v1/scenes/" + createdScene.id);
        res.send(Pistache::Http::Code::Created, createdScene.dump());
    } catch (const application::scene::SceneAlreadyExists& ex) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Conflict,
                                        "scene_exists",
                                        ex.what());
    } catch (const std::exception& ex) {
        spdlog::error("Failed to create scene: {}", ex.what());
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Internal_Server_Error,
                                        "internal_error",
                                        "Failed to create scene");
    }
}

void SceneController::updateScene(const Pistache::Rest::Request& req,
                                  Pistache::Http::ResponseWriter      res)
{
    const auto id = req.param(":id").as<std::string>();

    if (!isUuid(id)) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "invalid_id",
                                        "Provided scene id is not a valid UUID");
        return;
    }

    json body;
    try {
        body = json::parse(req.body());
    } catch (const json::parse_error&) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "invalid_json",
                                        "Invalid JSON body");
        return;
    }

    if (body.empty()) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "empty_body",
                                        "No fields provided to update");
        return;
    }

    try {
        application::scene::UpdateSceneCmd cmd;
        cmd.id          = id;
        if (body.contains("name")) {
            cmd.name = body["name"].get<std::string>();
        }
        if (body.contains("description")) {
            cmd.description = body["description"].get<std::string>();
        }
        if (body.contains("status")) {
            cmd.status = body["status"].get<std::string>();
        }

        auto updatedScene = m_commandService->updateScene(std::move(cmd));
        res.send(Pistache::Http::Code::Ok, updatedScene.dump());
    } catch (const application::scene::SceneNotFound&) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Not_Found,
                                        "scene_not_found",
                                        "Scene not found");
    } catch (const std::exception& ex) {
        spdlog::error("Failed to update scene {}: {}", id, ex.what());
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Internal_Server_Error,
                                        "internal_error",
                                        "Failed to update scene");
    }
}

void SceneController::deleteScene(const Pistache::Rest::Request& req,
                                  Pistache::Http::ResponseWriter      res)
{
    const auto id = req.param(":id").as<std::string>();

    if (!isUuid(id)) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Bad_Request,
                                        "invalid_id",
                                        "Provided scene id is not a valid UUID");
        return;
    }

    infrastructure::metrics::Timer timer("SceneController.deleteScene");

    try {
        m_commandService->deleteScene(id);
        res.send(Pistache::Http::Code::No_Content);
    } catch (const application::scene::SceneNotFound&) {
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Not_Found,
                                        "scene_not_found",
                                        "Scene not found");
    } catch (const std::exception& ex) {
        spdlog::error("Failed to delete scene {}: {}", id, ex.what());
        infrastructure::http::sendError(res,
                                        Pistache::Http::Code::Internal_Server_Error,
                                        "internal_error",
                                        "Failed to delete scene");
    }
}

}   // namespace paletteflux::api::v1::rest