```cpp
/**
 *  File:    AssetController.cpp
 *  Project: PaletteFlux GraphQL Studio – REST façade
 *
 *  Description:
 *  ------------
 *  Implements the REST controller that exposes CRUD operations for creative
 *  assets (brush strokes, shader nodes, animation curves, …) under the
 *  “/api/v1/assets” resource collection.  The controller is thin by design:
 *  it merely validates/normalises inbound HTTP requests, delegates all domain
 *  work to the service layer (Command / Query separation), and finally maps
 *  service results to an HTTP/JSON representation while integrating with the
 *  project’s monitoring, authentication, and error–handling subsystems.
 *
 *  The code purposefully targets production‐grade requirements:
 *    • defensive input validation
 *    • pagination & conditional GET (ETag)
 *    • structured error responses (RFC-7807)
 *    • metrics & tracing hooks
 *    • graceful degradation of internal failures
 *
 *  NOTE: This source file purposefully contains only *implementation* details;
 *  the public interface can be found in `AssetController.hpp`.
 */

#include "api/v1/rest/AssetController.hpp"

#include <chrono>
#include <memory>
#include <sstream>
#include <utility>

// 3rd-party dependencies (header-only, therefore safe to include here)
#include <nlohmann/json.hpp>                // JSON serialisation
#include <fmt/format.h>                     // Type-safe string formatting

// PaletteFlux internal headers
#include "core/http/HttpRouter.hpp"
#include "core/http/HttpStatus.hpp"
#include "core/http/QueryParser.hpp"
#include "core/metrics/Timer.hpp"
#include "core/security/AuthContext.hpp"
#include "core/utils/ISO8601.hpp"
#include "services/asset/AssetCommandService.hpp"
#include "services/asset/AssetQueryService.hpp"
#include "services/common/PageRequest.hpp"
#include "services/common/PageResult.hpp"
#include "utils/ApiProblem.hpp"
#include "utils/Logger.hpp"

using paletteflux::api::v1::rest::AssetController;
using paletteflux::core::http::HttpRequest;
using paletteflux::core::http::HttpResponse;
using paletteflux::core::http::HttpStatus;
using paletteflux::core::http::HttpRouter;
using paletteflux::core::security::AuthContext;
using paletteflux::services::asset::AssetQueryService;
using paletteflux::services::asset::AssetCommandService;
using paletteflux::services::common::PageRequest;
using paletteflux::services::common::PageResult;

namespace
{
    constexpr char kDefaultMimeType[] = "application/json; charset=utf-8";

    // Utility: converts service-level page result to JSON according to our
    // public REST schema. We isolate this to make the handlers more readable.
    nlohmann::json toJson(const PageResult<AssetDTO>& page)
    {
        nlohmann::json j;
        j["data"] = nlohmann::json::array();
        for (const auto& dto : page.content)
        {
            j["data"].push_back(dto.toJson()); // AssetDTO already provides .toJson()
        }

        j["page"] = {
            {"index",       page.pageIndex},
            {"size",        page.pageSize},
            {"totalPages",  page.totalPages},
            {"totalItems",  page.totalItems}
        };
        return j;
    }

    // Generate a weak ETag following the convention: W/"<updated>@<checksum>"
    std::string makeWeakETag(std::string_view lastUpdatedIso, std::size_t checksum)
    {
        return fmt::format(R"(W/"{}@{:x}")", lastUpdatedIso, checksum);
    }

    // Robust string -> std::uint64_t conversion with clamping to avoid throwing
    std::uint64_t toUint64OrDefault(std::string_view str, std::uint64_t fallback)
    {
        try
        {
            return std::stoull(std::string{str});
        }
        catch (...)
        {
            return fallback;
        }
    }
} // anonymous namespace


/* ===================================================================== *
 *  C O N S T R U C T O R  /  R O U T E  R E G I S T R A T I O N
 * ===================================================================== */
AssetController::AssetController(
        std::shared_ptr<HttpRouter>          router,
        std::shared_ptr<AssetQueryService>   querySvc,
        std::shared_ptr<AssetCommandService> cmdSvc,
        std::shared_ptr<Logger>              logger)
    : m_router{std::move(router)}
    , m_querySvc{std::move(querySvc)}
    , m_cmdSvc{std::move(cmdSvc)}
    , m_logger{std::move(logger)}
{
    using paletteflux::core::http::Method;

    m_router->addRoute(Method::GET,    "/api/v1/assets",            this, &AssetController::listAssets);
    m_router->addRoute(Method::GET,    "/api/v1/assets/:id",        this, &AssetController::getAsset);
    m_router->addRoute(Method::POST,   "/api/v1/assets",            this, &AssetController::createAsset);
    m_router->addRoute(Method::PATCH,  "/api/v1/assets/:id",        this, &AssetController::updateAsset);
    m_router->addRoute(Method::DELETE, "/api/v1/assets/:id",        this, &AssetController::deleteAsset);

    m_logger->info("AssetController routes registered");
}

/* ===================================================================== *
 *  H A N D L E R S
 * ===================================================================== */

HttpResponse
AssetController::listAssets(const HttpRequest& req, const AuthContext& authCtx) const noexcept
{
    Timer latencyTimer{"asset.list"}; // metrics

    try
    {
        // -----------------------------------------------------------------
        // 1) Parse & validate query parameters
        // -----------------------------------------------------------------
        QueryParser qp{req.query()};

        std::uint64_t page     = toUint64OrDefault(qp.get("page").value_or("0"), 0);
        std::uint64_t perPage  = toUint64OrDefault(qp.get("perPage").value_or("25"), 25);
        perPage                = std::min<std::uint64_t>(perPage, 250);   // upper bound

        const std::optional<std::string> tagFilter = qp.get("tag");
        const PageRequest pageReq{
            static_cast<std::size_t>(page),
            static_cast<std::size_t>(perPage)};

        // -----------------------------------------------------------------
        // 2) Delegate to query service
        // -----------------------------------------------------------------
        PageResult<AssetDTO> result =
            m_querySvc->fetchAssetsPage(pageReq, tagFilter, authCtx.userId());

        // -----------------------------------------------------------------
        // 3) Build response – support conditional GET
        // -----------------------------------------------------------------
        nlohmann::json       body  = toJson(result);
        std::string          bodyStr = body.dump();

        std::size_t          checksum = std::hash<std::string>{}(bodyStr);
        auto                 lastUpdatedIso = paletteflux::utils::iso8601::format(result.maxUpdated);

        std::string          etag  = makeWeakETag(lastUpdatedIso, checksum);

        // ETag / If-None-Match
        if (auto ifNone = req.header("If-None-Match"))
        {
            if (*ifNone == etag)
            {
                return HttpResponse{HttpStatus::NotModified};
            }
        }

        // -----------------------------------------------------------------
        // 4) Finally craft and return
        // -----------------------------------------------------------------
        HttpResponse resp{HttpStatus::Ok};
        resp.setHeader("Content-Type", kDefaultMimeType);
        resp.setHeader("ETag", etag);
        resp.setBody(std::move(bodyStr));

        return resp;
    }
    catch (const ServiceException& ex)
    {
        return ApiProblem::fromServiceError(ex)
                .toHttpResponse(m_logger);
    }
    catch (const std::exception& ex)
    {
        return ApiProblem::fromUnexpectedError(ex)
                .toHttpResponse(m_logger);
    }
}

HttpResponse
AssetController::getAsset(const HttpRequest& req, const AuthContext& authCtx) const noexcept
{
    Timer latencyTimer{"asset.get"};

    try
    {
        const std::string assetId = req.pathParam("id").value_or("");
        if (assetId.empty())
        {
            return ApiProblem::badRequest("Missing path parameter: id")
                    .toHttpResponse(m_logger);
        }

        const AssetDTO dto = m_querySvc->fetchById(assetId, authCtx.userId());

        // conditional GET support
        std::string etag = makeWeakETag(
            paletteflux::utils::iso8601::format(dto.updatedAt),
            dto.revision);

        if (auto ifNone = req.header("If-None-Match"); ifNone && *ifNone == etag)
        {
            return HttpResponse{HttpStatus::NotModified};
        }

        // success
        HttpResponse resp{HttpStatus::Ok};
        resp.setHeader("Content-Type", kDefaultMimeType);
        resp.setHeader("ETag", etag);
        resp.setBody(dto.toJson().dump());
        return resp;
    }
    catch (const NotFoundException& ex)
    {
        return ApiProblem::resourceNotFound(ex.what())
                .toHttpResponse(m_logger);
    }
    catch (const ServiceException& ex)
    {
        return ApiProblem::fromServiceError(ex)
                .toHttpResponse(m_logger);
    }
    catch (const std::exception& ex)
    {
        return ApiProblem::fromUnexpectedError(ex)
                .toHttpResponse(m_logger);
    }
}

HttpResponse
AssetController::createAsset(const HttpRequest& req, const AuthContext& authCtx) const noexcept
{
    Timer latencyTimer{"asset.create"};

    try
    {
        // We expect JSON body
        if (!req.hasBody())
        {
            return ApiProblem::badRequest("Empty request body")
                    .toHttpResponse(m_logger);
        }

        const nlohmann::json payload = nlohmann::json::parse(req.body(), nullptr, /*allow_exceptions=*/true);

        // Validate & map into command DTO
        CreateAssetCommand cmd = CreateAssetCommand::fromJson(payload);
        cmd.ownerId = authCtx.userId();

        const AssetDTO created = m_cmdSvc->create(std::move(cmd));

        // Location header should point to the newly created resource
        std::string location = fmt::format("/api/v1/assets/{}", created.id);

        HttpResponse resp{HttpStatus::Created};
        resp.setHeader("Content-Type", kDefaultMimeType);
        resp.setHeader("Location", location);
        resp.setBody(created.toJson().dump());

        return resp;
    }
    catch (const json::exception& ex)
    {
        return ApiProblem::badRequest(fmt::format("Malformed JSON: {}", ex.what()))
                .toHttpResponse(m_logger);
    }
    catch (const ValidationException& ex)
    {
        return ApiProblem::validationError(ex.validationErrors())
                .toHttpResponse(m_logger);
    }
    catch (const ServiceException& ex)
    {
        return ApiProblem::fromServiceError(ex)
                .toHttpResponse(m_logger);
    }
    catch (const std::exception& ex)
    {
        return ApiProblem::fromUnexpectedError(ex)
                .toHttpResponse(m_logger);
    }
}

HttpResponse
AssetController::updateAsset(const HttpRequest& req, const AuthContext& authCtx) const noexcept
{
    Timer latencyTimer{"asset.update"};

    try
    {
        const std::string assetId = req.pathParam("id").value_or("");
        if (assetId.empty())
        {
            return ApiProblem::badRequest("Missing path parameter: id")
                    .toHttpResponse(m_logger);
        }

        if (!req.hasBody())
        {
            return ApiProblem::badRequest("Empty request body")
                    .toHttpResponse(m_logger);
        }

        const nlohmann::json payload = nlohmann::json::parse(req.body(), nullptr, true);

        PatchAssetCommand cmd  = PatchAssetCommand::fromJson(payload);
        cmd.assetId            = assetId;
        cmd.requesterId        = authCtx.userId();

        const AssetDTO updated = m_cmdSvc->update(std::move(cmd));

        HttpResponse resp{HttpStatus::Ok};
        resp.setHeader("Content-Type", kDefaultMimeType);
        resp.setBody(updated.toJson().dump());
        return resp;
    }
    catch (const ConcurrencyException& ex)
    {
        return ApiProblem::concurrencyConflict(ex.what())
                .toHttpResponse(m_logger);
    }
    catch (const NotFoundException& ex)
    {
        return ApiProblem::resourceNotFound(ex.what())
                .toHttpResponse(m_logger);
    }
    catch (const ValidationException& ex)
    {
        return ApiProblem::validationError(ex.validationErrors())
                .toHttpResponse(m_logger);
    }
    catch (const ServiceException& ex)
    {
        return ApiProblem::fromServiceError(ex)
                .toHttpResponse(m_logger);
    }
    catch (const std::exception& ex)
    {
        return ApiProblem::fromUnexpectedError(ex)
                .toHttpResponse(m_logger);
    }
}

HttpResponse
AssetController::deleteAsset(const HttpRequest& req, const AuthContext& authCtx) const noexcept
{
    Timer latencyTimer{"asset.delete"};

    try
    {
        const std::string assetId = req.pathParam("id").value_or("");
        if (assetId.empty())
        {
            return ApiProblem::badRequest("Missing path parameter: id")
                    .toHttpResponse(m_logger);
        }

        DeleteAssetCommand cmd;
        cmd.assetId     = assetId;
        cmd.requesterId = authCtx.userId();

        m_cmdSvc->remove(std::move(cmd));

        // 204 No Content — resource successfully deleted
        return HttpResponse{HttpStatus::NoContent};
    }
    catch (const NotFoundException& ex)
    {
        return ApiProblem::resourceNotFound(ex.what())
                .toHttpResponse(m_logger);
    }
    catch (const ServiceException& ex)
    {
        return ApiProblem::fromServiceError(ex)
                .toHttpResponse(m_logger);
    }
    catch (const std::exception& ex)
    {
        return ApiProblem::fromUnexpectedError(ex)
                .toHttpResponse(m_logger);
    }
}
```