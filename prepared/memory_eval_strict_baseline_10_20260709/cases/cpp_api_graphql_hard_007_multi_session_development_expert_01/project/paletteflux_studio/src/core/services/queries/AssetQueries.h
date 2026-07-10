#pragma once
/**
 * PaletteFlux GraphQL Studio
 * File: paletteflux_studio/src/core/services/queries/AssetQueries.h
 *
 * This header defines the high-level query service responsible for fetching
 * read-only (CQRS “query” side) projections of creative assets.  The service
 * is consumed by REST and GraphQL controllers to materialize views optimised
 * for pagination, caching and schema evolution.
 *
 * Responsibilities
 * ─────────────────
 *  • Provide a single façade for all asset-read operations.
 *  • Delegate storage specifics to an injected repository abstraction.
 *  • Surface pagination utilities and filter helpers.
 *  • Emit monitoring metrics and enrich errors with domain context.
 *
 * NOTE: The interface is intentionally header-only to avoid build-system
 *       linkage complexity across micro-modules.  All implementation logic
 *       resides in this file and relies exclusively on abstract dependencies.
 */

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace paletteflux::core::services::queries {

// Forward declarations of domain types. Concrete definitions live in
// paletteflux_studio/src/core/domain/…
struct Asset;
struct AssetSummary;
struct AssetRelationship;

using AssetId = std::string;

/*─────────────────────────────────────────────────────────────────────────────
 * Pagination primitives
 *───────────────────────────────────────────────────────────────────────────*/

struct PageRequest
{
    std::size_t page          = 0;  // 0-based page index
    std::size_t pageSize      = 25; // items per page (bounded elsewhere)
    bool        withTotal     = true; // determines if totalCount must be computed

    [[nodiscard]] std::size_t offset() const noexcept { return page * pageSize; }
};

template <typename T>
struct PageResult
{
    std::vector<T> items;
    std::size_t    totalCount  = 0;  // overall matching items (optional)
    std::size_t    page        = 0;
    std::size_t    pageSize    = 0;
};

/*─────────────────────────────────────────────────────────────────────────────
 * Filtering helpers
 *───────────────────────────────────────────────────────────────────────────*/
struct AssetFilter
{
    std::optional<std::string> type;       // e.g. "ShaderNode", "SpriteSheet"
    std::optional<std::string> ownerId;    // user or team id
    std::optional<std::string> tagQuery;   // comma separated tag tokens
};

/*─────────────────────────────────────────────────────────────────────────────
 * Relationship helpers
 *───────────────────────────────────────────────────────────────────────────*/
enum class RelationshipDirection
{
    Inbound  = 0,
    Outbound = 1,
    Both     = 2
};

/*─────────────────────────────────────────────────────────────────────────────
 * Monitoring hooks
 *───────────────────────────────────────────────────────────────────────────*/
class IMetricsSink
{
public:
    virtual ~IMetricsSink() = default;

    virtual void recordQueryDuration(const std::string& queryName,
                                     std::chrono::nanoseconds duration) noexcept = 0;
};

/*─────────────────────────────────────────────────────────────────────────────
 * Repository abstraction
 *───────────────────────────────────────────────────────────────────────────*/
class IAssetRepository
{
public:
    virtual ~IAssetRepository() = default;

    virtual std::optional<Asset> findById(const AssetId& id) = 0;

    virtual PageResult<AssetSummary> findAll(const PageRequest& request,
                                             const AssetFilter& filter) = 0;

    virtual std::vector<AssetRelationship> findRelationships(
        const AssetId&             id,
        RelationshipDirection      direction) = 0;
};

/*─────────────────────────────────────────────────────────────────────────────
 * Domain-level exception
 *───────────────────────────────────────────────────────────────────────────*/
class QueryServiceError final : public std::runtime_error
{
    using std::runtime_error::runtime_error;
};

/*─────────────────────────────────────────────────────────────────────────────
 * AssetQueries façade
 *───────────────────────────────────────────────────────────────────────────*/
class AssetQueries
{
public:
    explicit AssetQueries(std::shared_ptr<IAssetRepository> repo,
                          std::shared_ptr<IMetricsSink>    metricsSink = nullptr)
        : m_repo(std::move(repo))
        , m_metrics(std::move(metricsSink))
    {
        if (!m_repo)
            throw QueryServiceError(
                "AssetQueries requires a non-null IAssetRepository instance");
    }

    AssetQueries(const AssetQueries&)            = delete;
    AssetQueries& operator=(const AssetQueries&) = delete;
    AssetQueries(AssetQueries&&)                 = delete;
    AssetQueries& operator=(AssetQueries&&)      = delete;
    ~AssetQueries()                              = default;

    /**
     * Fetch a single asset by identifier.
     *
     * Throws QueryServiceError if no asset exists and 'allowMissing == false'.
     *
     * @param id             Unique asset identifier.
     * @param allowMissing   If true, returns std::nullopt instead of throwing.
     */
    [[nodiscard]] std::optional<Asset> byId(const AssetId& id,
                                            bool allowMissing = false) const
    {
        const auto start = std::chrono::high_resolution_clock::now();

        auto asset = m_repo->findById(id);

        if (!allowMissing && !asset)
            throw QueryServiceError("Asset '" + id + "' not found");

        recordDuration("AssetQueries.byId", start);
        return asset;
    }

    /**
     * Return a paginated list of AssetSummary projections.
     *
     * Example:
     *  PageRequest req{ .page = 1, .pageSize = 50 };
     *  AssetFilter filter{ .type = "ShaderNode" };
     *  auto page = queries.list(req, filter);
     */
    [[nodiscard]] PageResult<AssetSummary> list(const PageRequest& request,
                                                const AssetFilter& filter = {}) const
    {
        const auto start = std::chrono::high_resolution_clock::now();

        if (request.pageSize == 0)
            throw QueryServiceError("PageRequest.pageSize must be greater than 0");

        auto result = m_repo->findAll(request, filter);
        recordDuration("AssetQueries.list", start);
        return result;
    }

    /**
     * Traverse relationship edges for a given asset.
     *
     * @param id          Source asset identifier.
     * @param direction   Edge direction (inbound/outbound/both).
     */
    [[nodiscard]] std::vector<AssetRelationship>
    relationships(const AssetId& id, RelationshipDirection direction) const
    {
        const auto start = std::chrono::high_resolution_clock::now();

        auto rels = m_repo->findRelationships(id, direction);
        recordDuration("AssetQueries.relationships", start);
        return rels;
    }

private:
    void recordDuration(const std::string& name,
                        std::chrono::high_resolution_clock::time_point start) const
    {
        if (m_metrics)
        {
            const auto elapsed =
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::high_resolution_clock::now() - start);
            m_metrics->recordQueryDuration(name, elapsed);
        }
    }

private:
    std::shared_ptr<IAssetRepository> m_repo;
    std::shared_ptr<IMetricsSink>     m_metrics;
};

} // namespace paletteflux::core::services::queries