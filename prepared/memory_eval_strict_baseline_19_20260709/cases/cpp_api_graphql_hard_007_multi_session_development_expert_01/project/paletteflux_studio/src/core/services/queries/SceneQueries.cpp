#include "core/services/queries/SceneQueries.hpp"

#include <chrono>
#include <future>
#include <memory>
#include <sstream>
#include <stdexcept>

#include "core/common/exceptions/NotFoundException.hpp"
#include "core/common/metrics/IMetricCollector.hpp"
#include "core/common/utils/ScopeTimer.hpp"
#include "core/domain/mappers/SceneMapper.hpp"
#include "spdlog/spdlog.h"

using namespace paletteflux::core;
using namespace paletteflux::core::services;
using namespace paletteflux::core::services::queries;
using namespace paletteflux::core::common;
using namespace paletteflux::core::domain;

namespace
{
/* -------------------------------------------------------------------------------------------------
 * Utility helpers (internal linkage)
 * ------------------------------------------------------------------------------------------------/
 */

// Compose a deterministic cache key for the SceneDTO result set.
std::string buildCacheKey(const Pagination& page,
                          const SceneFilter& filter) noexcept
{
    std::ostringstream oss;
    oss << "scenes:"
        << "page:" << page.offset() << ':' << page.limit()
        << "|sort:" << static_cast<int>(filter.sortOrder())
        << "|owner:" << (filter.ownerId().has_value() ? filter.ownerId()->str() : "any")
        << "|search:" << filter.searchQuery();
    return oss.str();
}

std::string buildCacheKey(const SceneId& id) noexcept
{
    std::ostringstream oss;
    oss << "scene:" << id.str();
    return oss.str();
}

} // namespace

/* -------------------------------------------------------------------------------------------------
 * SceneQueries implementation
 * ------------------------------------------------------------------------------------------------/
SceneQueries::SceneQueries(std::shared_ptr<ISceneRepository> repository,
                           std::shared_ptr<ICacheProvider>   cache,
                           std::shared_ptr<IMetricCollector> metrics)
        : _repository(std::move(repository))
        , _cache(std::move(cache))
        , _metrics(std::move(metrics))
{
    if (!_repository) { throw std::invalid_argument("SceneQueries: repository is null"); }
    if (!_cache) { spdlog::warn("SceneQueries: cache provider not configured ‒ caching disabled."); }
    if (!_metrics) { spdlog::warn("SceneQueries: metric collector not configured."); }
}

// -----------------------------------------------------------------------------
// Single-scene lookup
// -----------------------------------------------------------------------------
SceneDTO SceneQueries::getSceneById(const SceneId& id) const
{
    constexpr auto metricName = "queries.scene.get_by_id";
    auto timer                = _metrics ? std::make_unique<utils::ScopeTimer>([_metrics = _metrics, metricName](auto dur) {
                               _metrics->observe(metricName, dur.count());
                           })
                                         : nullptr;

    const auto cacheKey = buildCacheKey(id);

    // Try the cache first
    if (_cache)
    {
        if (auto cached = _cache->tryGet<SceneDTO>(cacheKey))
        {
            _metrics && _metrics->increment("cache.hit.scene");
            return *cached;
        }
        _metrics && _metrics->increment("cache.miss.scene");
    }

    // Repository fetch
    const auto sceneOpt = _repository->fetchById(id);
    if (!sceneOpt)
    {
        _metrics && _metrics->increment("scene.not_found");
        throw NotFoundException("Scene", id.str());
    }

    SceneDTO dto = SceneMapper::toDTO(*sceneOpt);

    // Store in cache (async to not block the critical path)
    if (_cache)
    {
        std::async(std::launch::async, [cache = _cache, key = cacheKey, dtoCopy = dto]() {
            cache->put<SceneDTO>(key, dtoCopy, std::chrono::minutes(10));
        });
    }

    return dto;
}

// -----------------------------------------------------------------------------
// Paginated list
// -----------------------------------------------------------------------------
PagedResult<SceneDTO>
SceneQueries::listScenes(const Pagination& page, const SceneFilter& filter) const
{
    constexpr auto metricName = "queries.scene.list";
    auto timer                = _metrics ? std::make_unique<utils::ScopeTimer>([_metrics = _metrics, metricName](auto dur) {
                               _metrics->observe(metricName, dur.count());
                           })
                                         : nullptr;

    if (!page.isValid())
    {
        throw std::invalid_argument("Invalid pagination parameters supplied");
    }

    const auto cacheKey = buildCacheKey(page, filter);

    // Attempt cache read
    if (_cache)
    {
        if (auto cached = _cache->tryGet<PagedResult<SceneDTO>>(cacheKey))
        {
            _metrics && _metrics->increment("cache.hit.scene_list");
            return *cached;
        }
        _metrics && _metrics->increment("cache.miss.scene_list");
    }

    // Repository fetch
    auto rawPaged = _repository->fetchAll(page, filter);

    // Map to DTO
    std::vector<SceneDTO> dtoItems;
    dtoItems.reserve(rawPaged.items.size());
    for (const auto& s : rawPaged.items)
    {
        dtoItems.emplace_back(SceneMapper::toDTO(s));
    }

    PagedResult<SceneDTO> result{std::move(dtoItems),
                                 rawPaged.totalCount,
                                 page.offset(),
                                 page.limit()};

    // Cache for subsequent consumers
    if (_cache)
    {
        // Background store to avoid blocking
        std::async(std::launch::async, [cache = _cache, key = cacheKey, resultCopy = result]() {
            cache->put<PagedResult<SceneDTO>>(key, resultCopy, std::chrono::seconds(45)); // short TTL
        });
    }

    return result;
}

// -----------------------------------------------------------------------------
// Reactive streaming of scene hierarchy nodes
// -----------------------------------------------------------------------------
void SceneQueries::streamSceneHierarchy(const SceneId& id,
                                        std::shared_ptr<ISceneNodeObserver> observer) const
{
    if (!observer) { throw std::invalid_argument("Observer must not be null"); }

    // We intentionally avoid caching here due to potential staleness in hierarchies
    auto sceneOpt = _repository->fetchById(id);
    if (!sceneOpt) { throw NotFoundException("Scene", id.str()); }

    const Scene& rootScene = *sceneOpt;

    // Observers may perform heavy operations; execute traversal asynchronously
    std::async(std::launch::async,
               [this, observer, &rootScene]() {
                   try
                   {
                       traverseNodeRecursive(rootScene.rootNode(), *observer);
                       observer->onCompleted();
                   }
                   catch (const std::exception& ex)
                   {
                       spdlog::error("Error while streaming scene hierarchy: {}", ex.what());
                       observer->onError(ex);
                   }
               });
}

/* -------------------------------------------------------------------------------------------------
 * Internal recursive traversal helper
 * ------------------------------------------------------------------------------------------------/
void SceneQueries::traverseNodeRecursive(const SceneNode&            node,
                                         ISceneNodeObserver& observer) const
{
    observer.onNext(SceneNodeMapper::toDTO(node));

    for (const SceneNode& child : node.children())
    {
        traverseNodeRecursive(child, observer);
    }
}