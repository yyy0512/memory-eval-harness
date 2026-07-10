/***************************************************************************************
 * PaletteFlux GraphQL Studio – SceneQueries
 *
 * File:    paletteflux_studio/src/core/services/queries/SceneQueries.h
 * Author:  PaletteFlux Core Team
 * License: MIT
 *
 * Description:
 *   SceneQueries exposes a thin, thread-safe service-layer abstraction that fetches
 *   immutable “read-models” (DTOs) of Scene aggregates. The class honours the CQRS
 *   principle by remaining *read-only* and delegating all persistence to an injected
 *   ISceneRepository while leveraging an ICacheProvider for aggressive, opt-in
 *   response caching. The public API is deliberately asynchronous-first to allow
 *   straightforward integration with coroutine-based GraphQL resolvers as well as
 *   REST controllers running on an I/O thread-pool.
 *
 *   The header is fully self-contained and can be included without linking against
 *   the rest of PaletteFlux. Mock repositories/caches can be injected easily for
 *   unit testing.
 ****************************************************************************************/

#pragma once

#include <chrono>
#include <cstdint>
#include <exception>
#include <future>
#include <memory>
#include <optional>
#include <shared_mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace paletteflux::core::services::queries {

/* ======================================================================================
 *  Utility: Timestamp helpers
 * ====================================================================================*/
using TimePoint = std::chrono::time_point<std::chrono::system_clock>;

inline TimePoint nowUtc()
{
    return std::chrono::system_clock::now();
}

/* ======================================================================================
 *  DTOs & Result Containers
 * ====================================================================================*/
struct SceneDTO
{
    std::string id;
    std::string slug;
    std::string name;
    std::string description;
    std::vector<std::string> tags;
    std::uint32_t revision;           // optimistic-locking rev
    TimePoint    createdAtUtc;
    TimePoint    updatedAtUtc;
};

struct PaginationInfo
{
    std::size_t  limit           = 25;
    std::string  cursor;                 // opaque base64 cursor
    bool         includeDeleted  = false;
};

struct PagedScenes
{
    std::vector<SceneDTO> items;
    std::string           nextCursor;
    bool                  hasMore = false;
};

/* ======================================================================================
 *  Exceptions
 * ====================================================================================*/
class QueryException : public std::runtime_error
{
public:
    explicit QueryException(const std::string& msg)
        : std::runtime_error(msg) {}
};

/* ======================================================================================
 *  Repository & Cache Abstractions
 * ====================================================================================*/
class ISceneRepository
{
public:
    virtual ~ISceneRepository() = default;

    virtual PagedScenes fetchPaged(const PaginationInfo& page)            = 0;
    virtual std::optional<SceneDTO> fetchById(const std::string& sceneId) = 0;
};

/*
 * A very small LRU-style cache interface. Implemented elsewhere using Redis,
 * Memcached, in-process LRU, etc.
 */
class ICacheProvider
{
public:
    virtual ~ICacheProvider() = default;

    virtual void put(const std::string& key,
                     const PagedScenes&  value,
                     std::chrono::milliseconds ttl) = 0;

    virtual void put(const std::string& key,
                     const SceneDTO&    value,
                     std::chrono::milliseconds ttl) = 0;

    virtual std::optional<PagedScenes> getPaged(const std::string& key)  const = 0;
    virtual std::optional<SceneDTO>    getItem (const std::string& key)  const = 0;
};

/* ======================================================================================
 *  SceneQueries – public façade
 * ====================================================================================*/
class SceneQueries
{
public:
    SceneQueries(std::shared_ptr<ISceneRepository> repository,
                 std::shared_ptr<ICacheProvider>   cache,
                 std::chrono::milliseconds         defaultTtl = std::chrono::minutes(5))
        : _repo(std::move(repository))
        , _cache(std::move(cache))
        , _defaultTtl(defaultTtl)
    {
        if (!_repo)  { throw std::invalid_argument("SceneQueries: repository must not be null"); }
        if (!_cache) { throw std::invalid_argument("SceneQueries: cache must not be null"); }
    }

    /*
     * Asynchronous page fetch. The returned future never throws – exceptions are
     * captured and re-thrown on `get()`. This design plays well with most coroutine
     * frameworks while still being std-only.
     */
    std::future<PagedScenes> listAsync(PaginationInfo page) const
    {
        // Detach into a background thread – in real world this would be a thread-pool.
        return std::async(std::launch::async, [this, page]() { return this->list(page); });
    }

    /*
     * Synchronous variant for internal, blocking clients.
     */
    PagedScenes list(const PaginationInfo& page) const
    {
        const auto cacheKey = buildCacheKey(page);
        if (auto cached = _cache->getPaged(cacheKey); cached.has_value())
        {
            return *cached;
        }

        PagedScenes result = _repo->fetchPaged(page);

        // In rare cases the repository might return an empty nextCursor; honour TTL but
        // avoid polluting the cache with huge empty pages.
        if (!result.items.empty())
        {
            _cache->put(cacheKey, result, _defaultTtl);
        }

        return result;
    }

    std::future<SceneDTO> getByIdAsync(std::string sceneId) const
    {
        return std::async(std::launch::async,
                          [this, id = std::move(sceneId)]() { return this->getById(id); });
    }

    SceneDTO getById(const std::string& sceneId) const
    {
        if (sceneId.empty()) { throw QueryException("SceneQueries::getById – id is empty"); }

        const auto cacheKey = "scene:" + sceneId;
        if (auto cached = _cache->getItem(cacheKey); cached.has_value())
        {
            return *cached;
        }

        auto sceneOpt = _repo->fetchById(sceneId);
        if (!sceneOpt.has_value())
        {
            std::ostringstream oss;
            oss << "Scene with id='" << sceneId << "' not found";
            throw QueryException(oss.str());
        }

        _cache->put(cacheKey, *sceneOpt, _defaultTtl);
        return *sceneOpt;
    }

    /*
     * Returns ISO-8601 query diagnostics for monitoring purposes.
     * The structure is intentionally trivial; could be expanded with latency,
     * cache hit ratio, etc.
     */
    struct Diagnostics
    {
        std::size_t inFlightRequests;
        TimePoint   generatedAtUtc;
    };

    Diagnostics diagnostics() const
    {
        std::shared_lock lock(_diagMutex);
        return {_inFlight, nowUtc()};
    }

private:
    /* Builds an opaque yet deterministic cache key. */
    static std::string buildCacheKey(const PaginationInfo& page)
    {
        std::ostringstream oss;
        oss << "scenes:"
            << "l=" << page.limit << ";"
            << "c=" << page.cursor << ";"
            << "d=" << (page.includeDeleted ? "1" : "0");
        return oss.str();
    }

    /* ==================================================================================
     *  Members – mutable stats are protected by a shared_mutex for read-mostly workloads
     * =================================================================================*/
    std::shared_ptr<ISceneRepository> _repo;
    std::shared_ptr<ICacheProvider>   _cache;
    std::chrono::milliseconds         _defaultTtl;

    mutable std::shared_mutex         _diagMutex;
    mutable std::size_t               _inFlight{0};
};

} // namespace paletteflux::core::services::queries