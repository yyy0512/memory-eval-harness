#pragma once
/**
 * PaletteFlux GraphQL Studio – REST Adapter
 * ----------------------------------------
 * SceneController.h
 *
 * Copyright (c) PaletteFlux.
 *
 * MIT-licensed – see LICENSE file for details.
 *
 * This header defines a production-grade REST controller that exposes
 * versioned CRUD endpoints for Scene model objects.  It follows the
 * MVC philosophy embraced by the PaletteFlux backend: thin controllers,
 * fat services, strict CQS separation, and HTTP/JSON boundaries.
 *
 * The controller is implemented against the elegant Pistache HTTP stack,
 * paired with nlohmann::json for ergonomic JSON (de)serialisation.
 *
 * Thread-safety:
 *  The controller itself is stateless; any shared state is delegated to
 *  the injected service layer.  All service interfaces must therefore be
 *  implemented in a thread-safe manner when used with the Pistache
 *  multithreaded HTTP endpoint.
 */

#include <pistache/router.h>
#include <pistache/endpoint.h>
#include <pistache/http.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace paletteflux::api::v1::rest
{

/* ============================================================
 *  Data-Transfer Objects
 * ============================================================
 */

/**
 * POCO representing a flattened Scene projection suitable for REST
 * serialisation.  Many fields that exist in the canonical domain model
 * (materials, nodes, animations, …) are deliberately elided to keep the
 * REST representation lightweight and version-agnostic.
 */
struct SceneDTO
{
    std::string       id;
    std::string       name;
    std::string       createdAt;   // ISO-8601 UTC
    std::string       updatedAt;   // ISO-8601 UTC
    nlohmann::json    metadata;    // Arbitrary user-defined key/value pairs
};

// nlohmann::json (de)serialisation helpers
inline void to_json(nlohmann::json& j, const SceneDTO& dto)
{
    j = nlohmann::json{
        {"id",         dto.id},
        {"name",       dto.name},
        {"createdAt",  dto.createdAt},
        {"updatedAt",  dto.updatedAt},
        {"metadata",   dto.metadata},
    };
}

inline void from_json(const nlohmann::json& j, SceneDTO& dto)
{
    j.at("id").get_to(dto.id);
    j.at("name").get_to(dto.name);
    j.at("createdAt").get_to(dto.createdAt);
    j.at("updatedAt").get_to(dto.updatedAt);
    if (j.contains("metadata"))
        j.at("metadata").get_to(dto.metadata);
}

/* ============================================================
 *  Service-Layer Contracts (CQS)
 * ============================================================
 */

class ISceneQueryService
{
public:
    virtual ~ISceneQueryService() = default;

    /**
     * Returns a paginated slice of SceneDTOs.
     *
     * @param page      1-based page index
     * @param pageSize  number of items per page (bounded by implementation)
     */
    virtual std::vector<SceneDTO>
    listScenes(std::uint32_t page, std::uint32_t pageSize) = 0;

    /**
     * Returns a materialised view for a single Scene or std::nullopt
     * if the id does not correspond to any existing aggregate.
     */
    virtual std::optional<SceneDTO>
    getSceneById(const std::string& id) = 0;
};

class ISceneCommandService
{
public:
    virtual ~ISceneCommandService() = default;

    /**
     * Creates a new Scene aggregate based on the supplied payload
     * and returns the materialised DTO.
     *
     * @throws std::invalid_argument  if validation fails
     * @throws std::runtime_error     on persistence/network errors
     */
    virtual SceneDTO
    createScene(const nlohmann::json& payload) = 0;

    /**
     * Performs a full update of a Scene aggregate.  Returns the updated
     * DTO on success or std::nullopt when the resource does not exist.
     *
     * @throws std::invalid_argument  if validation fails
     * @throws std::runtime_error     on persistence/network errors
     */
    virtual std::optional<SceneDTO>
    updateScene(const std::string& id, const nlohmann::json& payload) = 0;

    /**
     * Deletes the requested Scene.  Returns true on success, false if the
     * id did not correspond to a known aggregate.
     *
     * @throws std::runtime_error on persistence/network errors
     */
    virtual bool
    deleteScene(const std::string& id) = 0;
};

/* ============================================================
 *  Controller
 * ============================================================
 */

class SceneController
{
public:
    SceneController(std::shared_ptr<ISceneQueryService>  queryService,
                    std::shared_ptr<ISceneCommandService> commandService,
                    const std::shared_ptr<Pistache::Rest::Router>& router)
        : queryService_{std::move(queryService)}
        , commandService_{std::move(commandService)}
        , router_{router}
    {
        if (!router_)
            throw std::invalid_argument("router must not be null");

        initRoutes();
    }

    SceneController(const SceneController&)            = delete;
    SceneController(SceneController&&)                 = delete;
    SceneController& operator=(const SceneController&) = delete;
    SceneController& operator=(SceneController&&)      = delete;

private:
    /* ---------- Route binding ------------------------------------------------ */

    void initRoutes()
    {
        using namespace Pistache::Rest;

        Routes::Get    (*router_, "/api/v1/scenes",      Routes::bind(&SceneController::listScenes,  this));
        Routes::Get    (*router_, "/api/v1/scenes/:id",  Routes::bind(&SceneController::getScene,    this));
        Routes::Post   (*router_, "/api/v1/scenes",      Routes::bind(&SceneController::createScene, this));
        Routes::Put    (*router_, "/api/v1/scenes/:id",  Routes::bind(&SceneController::updateScene, this));
        Routes::Delete (*router_, "/api/v1/scenes/:id",  Routes::bind(&SceneController::deleteScene, this));
    }

    /* ---------- REST handlers ------------------------------------------------- */

    /**
     * GET /api/v1/scenes?page=1&pageSize=25
     */
    void listScenes(const Pistache::Rest::Request&  req,
                    Pistache::Http::ResponseWriter  resp)
    {
        try
        {
            const std::uint32_t page     = req.query().get("page").toUInt32().getOrElse(1);
            const std::uint32_t pageSize = req.query().get("pageSize").toUInt32().getOrElse(25);

            const auto list = queryService_->listScenes(page, pageSize);

            nlohmann::json body;
            body["items"] = list;
            body["pagination"] = {
                {"page",      page},
                {"pageSize",  pageSize},
                {"count",     list.size()}
            };

            // Conservative caching: 10 seconds – enough for CDN fan-out
            resp.headers().add<Pistache::Http::Header::CacheControl>(
                "public, max-age=10");

            resp.send(Pistache::Http::Code::Ok,
                      body.dump(),
                      MIME(Application, Json));
        }
        catch (const std::exception& ex)
        {
            resp.send(Pistache::Http::Code::Internal_Server_Error,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
    }

    /**
     * GET /api/v1/scenes/:id
     */
    void getScene(const Pistache::Rest::Request&  req,
                  Pistache::Http::ResponseWriter  resp)
    {
        const auto id = req.param(":id").as<std::string>();

        try
        {
            const auto dto = queryService_->getSceneById(id);
            if (!dto)
            {
                resp.send(Pistache::Http::Code::Not_Found,
                          nlohmann::json{{"error", "Scene not found"}}.dump(),
                          MIME(Application, Json));
                return;
            }

            // Allow downstream caches to keep a copy for 60 seconds
            resp.headers().add<Pistache::Http::Header::CacheControl>(
                "public, max-age=60");

            resp.send(Pistache::Http::Code::Ok,
                      nlohmann::json(*dto).dump(),
                      MIME(Application, Json));
        }
        catch (const std::exception& ex)
        {
            resp.send(Pistache::Http::Code::Internal_Server_Error,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
    }

    /**
     * POST /api/v1/scenes
     *
     * Body:
     * {
     *   "name": "My first scene",
     *   "metadata": { ... }
     * }
     */
    void createScene(const Pistache::Rest::Request&  req,
                     Pistache::Http::ResponseWriter  resp)
    {
        try
        {
            const auto payload = nlohmann::json::parse(req.body());
            const auto dto     = commandService_->createScene(payload);

            resp.send(Pistache::Http::Code::Created,
                      nlohmann::json(dto).dump(),
                      MIME(Application, Json));
        }
        catch (const nlohmann::json::parse_error& /*ex*/)
        {
            resp.send(Pistache::Http::Code::Bad_Request,
                      R"({"error":"Invalid JSON payload"})",
                      MIME(Application, Json));
        }
        catch (const std::invalid_argument& ex)
        {
            resp.send(Pistache::Http::Code::Bad_Request,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
        catch (const std::exception& ex)
        {
            resp.send(Pistache::Http::Code::Internal_Server_Error,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
    }

    /**
     * PUT /api/v1/scenes/:id
     */
    void updateScene(const Pistache::Rest::Request&  req,
                     Pistache::Http::ResponseWriter  resp)
    {
        const auto id = req.param(":id").as<std::string>();

        try
        {
            const auto payload = nlohmann::json::parse(req.body());
            const auto dto     = commandService_->updateScene(id, payload);

            if (!dto)
            {
                resp.send(Pistache::Http::Code::Not_Found,
                          nlohmann::json{{"error", "Scene not found"}}.dump(),
                          MIME(Application, Json));
                return;
            }

            resp.send(Pistache::Http::Code::Ok,
                      nlohmann::json(*dto).dump(),
                      MIME(Application, Json));
        }
        catch (const nlohmann::json::parse_error& /*ex*/)
        {
            resp.send(Pistache::Http::Code::Bad_Request,
                      R"({"error":"Invalid JSON payload"})",
                      MIME(Application, Json));
        }
        catch (const std::invalid_argument& ex)
        {
            resp.send(Pistache::Http::Code::Bad_Request,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
        catch (const std::exception& ex)
        {
            resp.send(Pistache::Http::Code::Internal_Server_Error,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
    }

    /**
     * DELETE /api/v1/scenes/:id
     */
    void deleteScene(const Pistache::Rest::Request&  req,
                     Pistache::Http::ResponseWriter  resp)
    {
        const auto id = req.param(":id").as<std::string>();

        try
        {
            const bool deleted = commandService_->deleteScene(id);
            if (!deleted)
            {
                resp.send(Pistache::Http::Code::Not_Found,
                          nlohmann::json{{"error", "Scene not found"}}.dump(),
                          MIME(Application, Json));
                return;
            }

            resp.send(Pistache::Http::Code::No_Content);
        }
        catch (const std::exception& ex)
        {
            resp.send(Pistache::Http::Code::Internal_Server_Error,
                      nlohmann::json{{"error", ex.what()}}.dump(),
                      MIME(Application, Json));
        }
    }

    /* ---------- Data members -------------------------------------------------- */

    std::shared_ptr<ISceneQueryService>   queryService_;
    std::shared_ptr<ISceneCommandService> commandService_;
    std::shared_ptr<Pistache::Rest::Router> router_;
};

} // namespace paletteflux::api::v1::rest