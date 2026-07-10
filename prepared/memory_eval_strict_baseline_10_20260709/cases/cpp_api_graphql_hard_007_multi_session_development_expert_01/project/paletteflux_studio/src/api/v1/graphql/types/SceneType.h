```cpp
#pragma once
/**
 *  paletteflux_studio/src/api/v1/graphql/types/SceneType.h
 *  ---------------------------------------------------------------------------
 *  Production-grade GraphQL type definition for the Scene aggregate root.
 *  While this header purposefully ships with a _very_ small set of
 *  self-contained abstractions to keep the snippet compilable in isolation,
 *  the real application links against an industry-proven GraphQL runtime
 *  (e.g. cppgraphqlgen or even a bespoke engine built around LLVM coroutines).
 *
 *  Created as part of PaletteFlux GraphQL Studio — see project root LICENSE.
 */

#include <string>
#include <vector>
#include <unordered_map>
#include <memory>
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <optional>
#include <chrono>
#include <stdexcept>

namespace paletteflux::api::v1 {

/* ============================================================================
 * Domain layer forward declarations
 * ========================================================================== */
namespace domain {

using Clock        = std::chrono::system_clock;
using ISODateTime  = Clock::time_point;

struct Layer
{
    std::string id;
    std::string name;
    std::string shaderNodeGraphId;
};

struct User
{
    std::string id;
    std::string displayName;
};

struct Scene
{
    std::string               id;
    std::string               name;
    ISODateTime               createdAt;
    std::optional<ISODateTime> updatedAt;
    std::string               authorId;

    /* Convenience accessors — noexcept so they can be used
     * freely inside third-party callbacks without fear of exceptions. */
    const std::string&        getId()        const noexcept { return id; }
    const std::string&        getName()      const noexcept { return name; }
    ISODateTime               getCreatedAt() const noexcept { return createdAt; }
    const std::optional<ISODateTime>&
                              getUpdatedAt() const noexcept { return updatedAt; }
    const std::string&        getAuthorId()  const noexcept { return authorId; }
};

} // namespace domain

/* ============================================================================
 * Service-layer abstractions
 * ========================================================================== */
namespace services {

/**
 * Pure virtual interface representing the query-side of the Scene
 * aggregate. An implementation is provided by the Scene read-model
 * micro-service, typically backed by a CQRS-friendly data store.
 */
class SceneQueryService
{
public:
    virtual ~SceneQueryService() = default;

    virtual std::optional<domain::Scene>  getSceneById(
            const std::string& id)                                   const = 0;

    virtual std::optional<domain::User>   getUserById(
            const std::string& userId)                               const = 0;

    virtual std::vector<domain::Layer>    getLayersForScene(
            const std::string& sceneId,
            std::optional<std::size_t> first,
            std::optional<std::string>  afterCursor)                 const = 0;
};

} // namespace services

/* ============================================================================
 * GraphQL builder primitives (stub implementation)
 * ========================================================================== */
namespace common {

class GraphQLObjectBuilder
{
public:
    using Resolver = std::function<void()>;

    GraphQLObjectBuilder& field(const std::string&, Resolver)
    {
        /* No-op stub – real implementation stores metadata. */
        return *this;
    }
};

class GraphQLTypeRegistry
{
public:
    GraphQLObjectBuilder object(const std::string&)
    {
        /* No-op stub – real implementation returns a proper DSL builder. */
        return {};
    }
};

} // namespace common
} // namespace paletteflux::api::v1

/* ============================================================================
 *                                                                          *
 *                    DataLoader (synchronous stub)                         *
 *                                                                          *
 *  A tiny, header-only utility implementing the DataLoader pattern.        *
 *  In production we swap it with an async version that internally          *
 *  dispatches work to a folly::Executor or a Boost ASIO thread pool.       *
 *                                                                          *
 * ========================================================================== */
namespace paletteflux::api::v1::graphql::types {

template<typename Key, typename Value>
class SynchronousDataLoader
{
public:
    using BatchLoaderFn = std::function<std::vector<Value>(const std::vector<Key>&)>;

    explicit SynchronousDataLoader(BatchLoaderFn loader)
        : _batchLoader(std::move(loader))
    {
        if (!_batchLoader)
            throw std::invalid_argument("DataLoader: batch loader function is null");
    }

    /* Non-copyable, but movable. */
    SynchronousDataLoader(const SynchronousDataLoader&)            = delete;
    SynchronousDataLoader& operator=(const SynchronousDataLoader&) = delete;
    SynchronousDataLoader(SynchronousDataLoader&&)                 = default;
    SynchronousDataLoader& operator=(SynchronousDataLoader&&)      = default;

    Value load(const Key& key)
    {
        /* Fast-path: shared read lock. */
        {
            std::shared_lock guard(_mutex);
            auto it = _cache.find(key);
            if (it != _cache.end())
                return it->second;
        }

        /* Slow-path: acquire exclusive lock and batch-load. */
        std::unique_lock guard(_mutex);

        /* Another thread might have populated the cache in the meantime. */
        auto it = _cache.find(key);
        if (it != _cache.end())
            return it->second;

        auto results = _batchLoader({ key });
        if (results.empty())
            throw std::runtime_error("DataLoader returned an empty result set");

        _cache.emplace(key, results.front());
        return results.front();
    }

    void clearCache()
    {
        std::unique_lock guard(_mutex);
        _cache.clear();
    }

private:
    BatchLoaderFn                      _batchLoader;
    std::unordered_map<Key, Value>     _cache;
    mutable std::shared_mutex          _mutex;
};

/* ============================================================================
 *                        SceneType – GraphQL facade
 * ========================================================================== */
class SceneType final
{
public:
    using ISODateTime = domain::Clock::time_point;

    /* --------------------------------------------------------------------- */
    /*  Static registration hook                                             */
    /* --------------------------------------------------------------------- */
    static void registerType(
        paletteflux::api::v1::common::GraphQLTypeRegistry& registry,
        std::shared_ptr<paletteflux::api::v1::services::SceneQueryService> svc)
    {
        if (!svc) throw std::invalid_argument("SceneType::registerType: svc is nullptr");

        auto builder = registry.object("Scene");

        /* Basic scalars */
        builder.field("id"        , []{ /* framework wires resolver */ });
        builder.field("name"      , []{});
        builder.field("createdAt" , []{});
        builder.field("updatedAt" , []{});

        /* Nested collections / relations */
        builder.field("layers"    , []{});
        builder.field("author"    , []{});
    }

    /* --------------------------------------------------------------------- */
    /*  Field resolvers (called by GraphQL runtime)                          */
    /* --------------------------------------------------------------------- */
    static std::string                      resolveId       (const domain::Scene& s) { return s.getId(); }
    static std::string                      resolveName     (const domain::Scene& s) { return s.getName(); }
    static ISODateTime                      resolveCreatedAt(const domain::Scene& s) { return s.getCreatedAt(); }
    static std::optional<ISODateTime>       resolveUpdatedAt(const domain::Scene& s) { return s.getUpdatedAt(); }

    static std::vector<domain::Layer> resolveLayers(
        const domain::Scene&                             scene,
        std::optional<std::size_t>                       first,
        std::optional<std::string>                       after,
        const paletteflux::api::v1::services::SceneQueryService& svc)
    {
        return svc.getLayersForScene(scene.getId(), first, after);
    }

    static std::optional<domain::User> resolveAuthor(
        const domain::Scene&                             scene,
        const paletteflux::api::v1::services::SceneQueryService& svc)
    {
        return svc.getUserById(scene.getAuthorId());
    }

private:
    SceneType()  = delete;
    ~SceneType() = delete;
};

} // namespace paletteflux::api::v1::graphql::types
```