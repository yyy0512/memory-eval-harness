#ifndef PALETTEFLUX_STUDIO_API_V1_REST_ASSET_CONTROLLER_H
#define PALETTEFLUX_STUDIO_API_V1_REST_ASSET_CONTROLLER_H

/*
 *  PaletteFlux Studio
 *  ------------------
 *  Copyright (c) 2024
 *
 *  File: AssetController.h
 *  Description:
 *      REST controller that exposes `/api/v1/assets` resources for legacy HTTP
 *      clients. The controller is implemented on top of the Pistache HTTP
 *      library and delegates business logic to the `AssetService` while
 *      converting domain models to JSON-friendly DTOs.
 *
 *  NOTE:
 *      This header is self-contained (header-only) to simplify integration in
 *      samples and unit tests. In larger code-bases it is recommended to split
 *      declarations and definitions.
 */

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <pistache/endpoint.h>
#include <pistache/http.h>
#include <pistache/router.h>
#include <pistache/serializer/rapidjson.h>
#include <nlohmann/json.hpp>

#include "core/metrics/LatencyHistogram.h"
#include "core/metrics/Counter.h"
#include "core/http/Pagination.h"
#include "domain/model/Asset.h"
#include "domain/service/AssetService.h"

namespace paletteflux::api::v1::rest {

/**
 * AssetController
 * ----------------
 * Orchestrates HTTP requests related to Assets.
 *
 * Routes:
 *      GET    /api/v1/assets
 *      GET    /api/v1/assets/:id
 *      POST   /api/v1/assets
 *      PUT    /api/v1/assets/:id
 *      DELETE /api/v1/assets/:id
 */
class AssetController final {
public:
    /**
     * Construct a new AssetController
     * 
     * @param router     Router to which routes will be added.
     * @param service    Business-logic facade responsible for Asset CRUD.
     * @param mountPath  Base URI prefix, e.g. "/api/v1".
     */
    AssetController(Pistache::Rest::Router&               router,
                    std::shared_ptr<service::AssetService> service,
                    std::string                           mountPath = "/api/v1")
        : _service(std::move(service))
        , _mountPath(std::move(mountPath))
        , _routeScope(router)
        , _reqCounter("rest_asset_requests_total")
        , _latencyHist("rest_asset_latency_seconds",
                       {0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0})
    {
        buildRoutes();
    }

    AssetController(const AssetController&)            = delete;
    AssetController& operator=(const AssetController&) = delete;
    AssetController(AssetController&&)                 = default;
    AssetController& operator=(AssetController&&)      = default;

    ~AssetController() = default;

private:
    // -----------------------------------------------------------
    // Route registration
    // -----------------------------------------------------------
    void buildRoutes()
    {
        using namespace Pistache::Rest;

        const std::string base = _mountPath + "/assets";

        _routeScope.route(base)
            .methods(Pistache::Http::Method::Get)
            .handler([this](const Pistache::Rest::Request& req,
                            Pistache::Http::ResponseWriter writer) {
                instrumented([&] { listAssets(req, std::move(writer)); });
            });

        _routeScope.route(base + "/:id")
            .methods(Pistache::Http::Method::Get)
            .handler([this](const Pistache::Rest::Request& req,
                            Pistache::Http::ResponseWriter writer) {
                instrumented([&] { getAssetById(req, std::move(writer)); });
            });

        _routeScope.route(base)
            .methods(Pistache::Http::Method::Post)
            .handler([this](const Pistache::Rest::Request& req,
                            Pistache::Http::ResponseWriter writer) {
                instrumented([&] { createAsset(req, std::move(writer)); });
            });

        _routeScope.route(base + "/:id")
            .methods(Pistache::Http::Method::Put)
            .handler([this](const Pistache::Rest::Request& req,
                            Pistache::Http::ResponseWriter writer) {
                instrumented([&] { updateAsset(req, std::move(writer)); });
            });

        _routeScope.route(base + "/:id")
            .methods(Pistache::Http::Method::Delete)
            .handler([this](const Pistache::Rest::Request& req,
                            Pistache::Http::ResponseWriter writer) {
                instrumented([&] { deleteAsset(req, std::move(writer)); });
            });
    }

    // -----------------------------------------------------------
    // Request handlers
    // -----------------------------------------------------------
    void listAssets(const Pistache::Rest::Request& req,
                    Pistache::Http::ResponseWriter writer)
    {
        try {
            core::http::Pagination page =
                core::http::Pagination::fromQuery(req.query());

            auto result = _service->listAll(page);
            nlohmann::json body;
            body["data"] = toJsonArray(result.items);
            body["pagination"] = {
                {"page", page.page()},
                {"per_page", page.perPage()},
                {"total_items", result.totalItems},
                {"total_pages", result.totalPages}
            };

            writer.headers().add<Pistache::Http::Header::ContentType>(
                MIME(Application, Json));
            writer.send(Pistache::Http::Code::Ok, body.dump());
        } catch (const std::exception& ex) {
            sendError(writer, Pistache::Http::Code::Internal_Server_Error, ex);
        }
    }

    void getAssetById(const Pistache::Rest::Request& req,
                      Pistache::Http::ResponseWriter writer)
    {
        const std::string idStr = req.param(":id").as<std::string>();

        try {
            std::optional<domain::model::Asset> maybeAsset =
                _service->findById(idStr);
            if (!maybeAsset) {
                sendNotFound(writer, "Asset id=" + idStr + " not found");
                return;
            }
            nlohmann::json body = toJson(*maybeAsset);
            writer.headers().add<Pistache::Http::Header::ContentType>(
                MIME(Application, Json));
            writer.send(Pistache::Http::Code::Ok, body.dump());
        } catch (const std::exception& ex) {
            sendError(writer, Pistache::Http::Code::Internal_Server_Error, ex);
        }
    }

    void createAsset(const Pistache::Rest::Request& req,
                     Pistache::Http::ResponseWriter writer)
    {
        if (!req.hasHeader<Pistache::Http::Header::ContentType>() ||
            req.headers()
                    .tryGet<Pistache::Http::Header::ContentType>()
                    ->mime() != MIME(Application, Json)) {
            sendError(writer, Pistache::Http::Code::Unsupported_Media_Type,
                      "Expected Content-Type: application/json");
            return;
        }

        try {
            nlohmann::json input = nlohmann::json::parse(req.body());
            domain::model::Asset asset = _service->createFromJson(input);
            nlohmann::json body        = toJson(asset);

            // Return 201 + Location header
            writer.headers().add<Pistache::Http::Header::ContentType>(
                MIME(Application, Json));
            writer.headers().add<Pistache::Http::Header::Location>(
                _mountPath + "/assets/" + asset.id());
            writer.send(Pistache::Http::Code::Created, body.dump());
        } catch (const nlohmann::json::exception& ex) {
            sendError(writer, Pistache::Http::Code::Bad_Request,
                      "Invalid JSON payload: " + std::string(ex.what()));
        } catch (const std::exception& ex) {
            sendError(writer, Pistache::Http::Code::Internal_Server_Error, ex);
        }
    }

    void updateAsset(const Pistache::Rest::Request& req,
                     Pistache::Http::ResponseWriter writer)
    {
        const std::string idStr = req.param(":id").as<std::string>();

        try {
            nlohmann::json input = nlohmann::json::parse(req.body());

            std::optional<domain::model::Asset> maybe =
                _service->updateFromJson(idStr, input);
            if (!maybe) {
                sendNotFound(writer, "Asset id=" + idStr + " not found");
                return;
            }
            writer.headers().add<Pistache::Http::Header::ContentType>(
                MIME(Application, Json));
            writer.send(Pistache::Http::Code::Ok, toJson(*maybe).dump());
        } catch (const nlohmann::json::exception& ex) {
            sendError(writer, Pistache::Http::Code::Bad_Request,
                      "Invalid JSON payload: " + std::string(ex.what()));
        } catch (const std::exception& ex) {
            sendError(writer, Pistache::Http::Code::Internal_Server_Error, ex);
        }
    }

    void deleteAsset(const Pistache::Rest::Request& req,
                     Pistache::Http::ResponseWriter writer)
    {
        const std::string idStr = req.param(":id").as<std::string>();

        try {
            bool removed = _service->remove(idStr);
            if (!removed) {
                sendNotFound(writer, "Asset id=" + idStr + " not found");
                return;
            }
            writer.send(Pistache::Http::Code::No_Content);
        } catch (const std::exception& ex) {
            sendError(writer, Pistache::Http::Code::Internal_Server_Error, ex);
        }
    }

    // -----------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------
    template <typename Callable>
    void instrumented(Callable&& c)
    {
        _reqCounter.increment();
        const auto start = std::chrono::steady_clock::now();
        try {
            c();
        } catch (...) {
            // Rethrow after metrics to allow outer layer handling
            _latencyHist.observe(
                std::chrono::duration<double>(
                    std::chrono::steady_clock::now() - start)
                    .count());
            throw;
        }
        _latencyHist.observe(
            std::chrono::duration<double>(
                std::chrono::steady_clock::now() - start)
                .count());
    }

    static nlohmann::json toJson(const domain::model::Asset& a)
    {
        return {
            {"id", a.id()},
            {"name", a.name()},
            {"type", a.type()},
            {"created_at",
             std::chrono::duration_cast<std::chrono::seconds>(
                 a.createdAt().time_since_epoch())
                 .count()},
            {"updated_at",
             std::chrono::duration_cast<std::chrono::seconds>(
                 a.updatedAt().time_since_epoch())
                 .count()}
            // TODO: include additional metadata & relationships
        };
    }

    static nlohmann::json toJsonArray(
        const std::vector<domain::model::Asset>& assets)
    {
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& a : assets) {
            arr.push_back(toJson(a));
        }
        return arr;
    }

    static void sendError(Pistache::Http::ResponseWriter& writer,
                          Pistache::Http::Code            code,
                          const std::exception&           ex)
    {
        sendError(writer, code, ex.what());
    }

    static void sendError(Pistache::Http::ResponseWriter& writer,
                          Pistache::Http::Code            code,
                          std::string                      msg)
    {
        nlohmann::json body   = {{"error", msg}};
        auto           status = static_cast<uint32_t>(code);
        writer.headers().add<Pistache::Http::Header::ContentType>(
            MIME(Application, Json));
        writer.send(code, body.dump());
        // Additionally log to stderr; a production system would use
        // a structured logger instead.
        std::cerr << "[AssetController] ERROR (" << status << "): " << msg
                  << std::endl;
    }

    static void sendNotFound(Pistache::Http::ResponseWriter& writer,
                             const std::string&              message)
    {
        sendError(writer, Pistache::Http::Code::Not_Found, message);
    }

    // -----------------------------------------------------------
    // State
    // -----------------------------------------------------------
    std::shared_ptr<service::AssetService> _service;
    std::string                            _mountPath;

    // Pistache provides scope-based removal of routes.
    Pistache::Rest::Route::Scoped         _routeScope;

    // Metrics
    core::metrics::Counter                _reqCounter;
    core::metrics::LatencyHistogram       _latencyHist;
};

} // namespace paletteflux::api::v1::rest

#endif // PALETTEFLUX_STUDIO_API_V1_REST_ASSET_CONTROLLER_H