#include "rendering/JsonRenderer.h"

#include "core/model/Asset.h"
#include "core/model/SceneGraph.h"
#include "core/monitoring/Tracer.h"
#include "core/monitoring/Logger.h"
#include "core/versioning/SemVer.h"
#include "core/exceptions/RenderException.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <mutex>
#include <sstream>
#include <utility>

/*
 * The JsonRenderer turns domain model objects into a JSON-serialised
 * representation that is consumed by both GraphQL resolvers and the
 * REST “snapshot” endpoints.  For performance, a small in-memory LRU
 * cache is used so that hot scene graphs do not have to be re-encoded
 * for every request.  Cache invalidation is driven by the versioning
 * subsystem via optimistic scene version tokens supplied in
 * RenderOptions.
 *
 * Thread safety:
 *   – All mutations on the internal cache are guarded by a mutex.
 *
 * Error semantics:
 *   – Any problem in the rendering pipeline is surfaced through
 *     a specialised RenderException so that callers can map the
 *     failure into appropriate HTTP or GraphQL error codes.
 */

namespace pf = paletteflux;
namespace pf_render = paletteflux::rendering;

using json = nlohmann::json;

// ---------------------------------------------------------------------
// local utilities
// ---------------------------------------------------------------------

namespace
{

// Convert a std::chrono::system_clock::time_point to an ISO-8601 string.
std::string toIso8601(const std::chrono::system_clock::time_point& tp)
{
    std::time_t              tt = std::chrono::system_clock::to_time_t(tp);
    std::tm                  tm{};
#if defined(_MSC_VER)
    gmtime_s(&tm, &tt);
#else
    gmtime_r(&tt, &tm);
#endif
    char buffer[32];
    if (std::strftime(buffer, sizeof(buffer), "%FT%TZ", &tm) == 0)
    {
        return {};
    }
    return buffer;
}

// Recursively serialise an Asset node (and its children) into JSON.
// Depth limiting is used to safeguard against malicious cyclic graphs.
json serialiseAsset(const pf::model::Asset& asset,
                    bool                    recursively,
                    std::size_t             depth,
                    std::size_t             maxDepth)
{
    if (depth > maxDepth)
    {
        throw pf::rendering::RenderException(
            "Scene graph too deep – potential cycle or malicious input");
    }

    json j;
    j["id"]       = asset.id();
    j["name"]     = asset.name();
    j["type"]     = asset.type();
    j["version"]  = asset.revision();
    j["metadata"] = asset.metadata(); // assuming metadata returns nlohmann::json

    if (recursively)
    {
        j["children"] = json::array();
        for (const auto& child : asset.children())
        {
            j["children"].push_back(
                serialiseAsset(*child, true, depth + 1, maxDepth));
        }
    }

    return j;
}

// Compose a cache key from scene id, version and renderer flags.
std::string makeCacheKey(const pf::model::SceneId& sceneId,
                         const std::string&         versionTag,
                         bool                       recursive)
{
    std::ostringstream oss;
    oss << sceneId << ":" << versionTag << ":" << (recursive ? 'R' : 'F');
    return oss.str();
}

} // namespace

// ---------------------------------------------------------------------
//  ctors / dtors
// ---------------------------------------------------------------------

pf_render::JsonRenderer::JsonRenderer(std::shared_ptr<ILRUCache> cache,
                                      std::shared_ptr<monitoring::Tracer> tracer,
                                      std::shared_ptr<monitoring::Logger> logger,
                                      std::chrono::milliseconds           cacheTtl,
                                      std::size_t                         maxGraphDepth)
    : m_cache(std::move(cache))
    , m_tracer(std::move(tracer))
    , m_logger(std::move(logger))
    , m_cacheTtl(cacheTtl)
    , m_maxGraphDepth(maxGraphDepth)
{
    if (!m_cache || !m_tracer || !m_logger)
    {
        throw std::invalid_argument("JsonRenderer ctor: dependencies not set");
    }
}

// ---------------------------------------------------------------------
//  rendering API
// ---------------------------------------------------------------------

std::string pf_render::JsonRenderer::renderScene(
    const model::SceneGraph& scene,
    const RenderOptions&     opts)
{
    const auto cacheKey =
        makeCacheKey(scene.id(), scene.versionTag(), opts.recursive);

    // -----------------------------------------------------------------
    // fast-path: check cache
    // -----------------------------------------------------------------
    {
        std::lock_guard<std::mutex> guard(m_cacheMx);
        auto                        cached = m_cache->get(cacheKey);
        if (cached.has_value())
        {
            m_logger->debug("[JsonRenderer] Cache hit, key={}", cacheKey);
            return cached.value();
        }
    }

    monitoring::Span span = m_tracer->startSpan("renderSceneJSON");
    span.setTag("scene.id", scene.id());
    span.setTag("scene.version.tag", scene.versionTag());
    span.setTag("render.recursive", opts.recursive);

    json root;
    try
    {
        root["sceneId"]   = scene.id();
        root["version"]   = scene.versionTag();
        root["timestamp"] = toIso8601(std::chrono::system_clock::now());

        // serialise the root asset
        root["root"] = serialiseAsset(scene.root(), opts.recursive, 0,
                                      m_maxGraphDepth);

        // embed additional, client-requested properties
        if (opts.includeDebugInfo)
        {
            root["debug"]["graphDepth"]     = scene.depth();
            root["debug"]["assetCount"]     = scene.assetCount();
            root["debug"]["renderHostname"] = monitoring::envHostname();
        }
    }
    catch (const std::exception& ex)
    {
        span.setError(ex.what());
        m_logger->error("[JsonRenderer] Failed to render scene: {}", ex.what());
        throw rendering::RenderException(ex.what());
    }

    const std::string output = root.dump(opts.pretty ? 4 : -1);

    // -----------------------------------------------------------------
    // write to cache
    // -----------------------------------------------------------------
    {
        std::lock_guard<std::mutex> guard(m_cacheMx);
        m_cache->put(cacheKey, output, m_cacheTtl);
    }

    return output;
}

// ---------------------------------------------------------------------
//  cache priming helpers
// ---------------------------------------------------------------------

void pf_render::JsonRenderer::primeCache(const model::SceneGraph& scene,
                                         bool                    recursive)
{
    RenderOptions opts;
    opts.recursive = recursive;
    opts.pretty    = false;

    try
    {
        (void)renderScene(scene, opts);
    }
    catch (const std::exception& ex)
    {
        m_logger->warn("[JsonRenderer] Cache priming failed: {}", ex.what());
    }
}

// ---------------------------------------------------------------------
//  diagnostics
// ---------------------------------------------------------------------

json pf_render::JsonRenderer::cacheStats() const
{
    std::lock_guard<std::mutex> guard(m_cacheMx);
    json                        j;
    j["hits"]     = m_cache->hitCount();
    j["misses"]   = m_cache->missCount();
    j["size"]     = m_cache->size();
    j["capacity"] = m_cache->capacity();
    return j;
}

// ---------------------------------------------------------------------
//  explicit template instantiation (for shared_ptr in headers)
// ---------------------------------------------------------------------
template class std::shared_ptr<pf_render::JsonRenderer>;