```cpp
/**
 *  PaletteFlux GraphQL Studio
 *  File: paletteflux_studio/src/core/services/queries/AssetQueries.cpp
 *
 *  Description:
 *      Service-layer query handlers that provide read-access to Asset models
 *      (textures, shader nodes, animation curves, etc.).  The class aggregates
 *      persistence adapters, cache providers, and telemetry facilities in order
 *      to answer requests coming from GraphQL resolvers as well as legacy REST
 *      controllers.  Pagination, response-caching, and optimistic version checks
 *      are transparently applied so that callers can focus on higher-level
 *      orchestration logic.
 *
 *  Copyright © PaletteFlux
 */

#include "AssetQueries.h"

#include <chrono>
#include <mutex>
#include <optional>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>

#include "core/common/Pagination.h"
#include "core/common/TimeUtils.h"
#include "core/infra/cache/InMemoryCache.h"
#include "core/infra/monitoring/Metrics.h"
#include "core/models/Asset.h"
#include "core/repositories/AssetRepository.h"

using namespace paletteflux;
using json = nlohmann::json;

namespace paletteflux::services::queries
{

// ──────────────────────────────────────────────────────────────────────────────
//  Implementation helpers
// ──────────────────────────────────────────────────────────────────────────────

namespace
{
constexpr std::string_view kCachePrefixSingle = "asset:";
constexpr std::string_view kCachePrefixPaged  = "asset:list:";
constexpr std::chrono::seconds kDefaultTtl{10}; // hot asset cache window

// Cache key builder helpers
std::string buildAssetKey(const std::string &id, uint32_t revision)
{
    return fmt::format("{}{}:{}", kCachePrefixSingle, id, revision);
}

std::string buildListKey(const PaginationOptions &page, const AssetQueryFilter &filter)
{
    // Stable key for identical filter + page requests
    const std::string filterJson = json{
        {"type", filter.type},
        {"tags", filter.tags},
        {"updatedAfter", TimeUtils::toIso8601(filter.updatedAfter)}
    }
                                          .dump();
    return fmt::format("{}{}:{}:{}",
                       kCachePrefixPaged,
                       filterJson,
                       page.page(),
                       page.pageSize());
}
} // namespace

// ──────────────────────────────────────────────────────────────────────────────
//  ctor / dtor
// ──────────────────────────────────────────────────────────────────────────────

AssetQueries::AssetQueries(std::shared_ptr<repositories::AssetRepository> repository,
                           std::shared_ptr<infra::cache::InMemoryCache>     cacheProvider,
                           std::shared_ptr<infra::monitoring::Metrics>      metrics)
    : repository_(std::move(repository))
    , cache_(std::move(cacheProvider))
    , metrics_(std::move(metrics))
{
    if (repository_ == nullptr || cache_ == nullptr || metrics_ == nullptr)
    {
        throw std::invalid_argument("AssetQueries: dependencies may not be null");
    }
    SPDLOG_INFO("AssetQueries initialised");
}

// ──────────────────────────────────────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────────────────────────────────────

std::optional<models::Asset> AssetQueries::getById(const AssetId &id, uint32_t expectedRevision)
{
    auto timer = metrics_->timer("asset_queries.getById");

    const std::string cacheKey = buildAssetKey(id, expectedRevision);

    // 1. Try cache
    if (auto cached = cache_->get<models::Asset>(cacheKey))
    {
        metrics_->increment("asset_queries.hit");
        return cached;
    }

    metrics_->increment("asset_queries.miss");

    // 2. Hit persistence
    auto assetOpt = repository_->findById(id);
    if (!assetOpt)
    {
        // Cache negative result for a short period to prevent hammering
        cache_->put(cacheKey, std::nullopt, kDefaultTtl);
        return std::nullopt;
    }

    // 3. Apply optimistic revision check
    if (expectedRevision != 0 && (*assetOpt)->revision() != expectedRevision)
    {
        SPDLOG_WARN("Stale asset revision requested: id={}, expected={}, actual={}",
                    id,
                    expectedRevision,
                    (*assetOpt)->revision());
        return std::nullopt;
    }

    // 4. Cache & return
    cache_->put(cacheKey, *assetOpt, kDefaultTtl);
    return assetOpt;
}

Paginated<models::Asset> AssetQueries::list(const PaginationOptions &page,
                                            const AssetQueryFilter & filter)
{
    auto timer = metrics_->timer("asset_queries.list");

    const std::string cacheKey = buildListKey(page, filter);

    if (auto cached = cache_->get<Paginated<models::Asset>>(cacheKey))
    {
        metrics_->increment("asset_queries.list.hit");
        return *cached;
    }

    metrics_->increment("asset_queries.list.miss");

    auto results = repository_->findAll(page, filter);

    cache_->put(cacheKey, results, kDefaultTtl);
    return results;
}

json AssetQueries::toJson(const models::Asset &asset) const
{
    // Trivial JSON mapping – in reality, this could be delegated to a dedicated
    // serialisation component or generated from GraphQL schema.
    json j;
    j["id"]          = asset.id();
    j["name"]        = asset.name();
    j["type"]        = asset.type();
    j["tags"]        = asset.tags();
    j["revision"]    = asset.revision();
    j["createdAt"]   = TimeUtils::toIso8601(asset.createdAt());
    j["modifiedAt"]  = TimeUtils::toIso8601(asset.modifiedAt());
    return j;
}

json AssetQueries::resolveGraphQL(const GraphQLRequest &request)
{
    /*
     * A naïve GraphQL field resolver.  In production this would be implemented
     * with a proper GraphQL C++ library; here we only show the call-path.
     */

    if (request.operation == "asset")
    {
        // Expect id argument
        const std::string &id  = request.arguments.at("id");
        const uint32_t     rev = request.arguments.contains("revision")
                                     ? std::stoul(request.arguments.at("revision"))
                                     : 0;

        auto assetOpt = getById(id, rev);
        if (!assetOpt)
        {
            throw GraphQLNotFound(fmt::format("Asset {} not found", id));
        }
        return toJson(*assetOpt);
    }
    else if (request.operation == "assets")
    {
        PaginationOptions page;
        page.setPage(static_cast<size_t>(std::stoul(request.arguments.at("page"))));
        page.setPageSize(static_cast<size_t>(std::stoul(request.arguments.at("pageSize"))));

        AssetQueryFilter filter;
        if (request.arguments.contains("type"))
        {
            filter.type = request.arguments.at("type");
        }
        if (request.arguments.contains("tags"))
        {
            filter.tags = json::parse(request.arguments.at("tags")).get<std::vector<std::string>>();
        }

        auto paginated = list(page, filter);
        json           response;
        response["pageInfo"] = {{"page", paginated.page()},
                                {"pageSize", paginated.pageSize()},
                                {"totalElements", paginated.totalElements()}};

        json nodes = json::array();
        for (const auto &asset : paginated.elements())
        {
            nodes.push_back(toJson(asset));
        }
        response["nodes"] = nodes;
        return response;
    }
    else
    {
        throw GraphQLNotFound(fmt::format("Unknown operation '{}'", request.operation));
    }
}

} // namespace paletteflux::services::queries
```
