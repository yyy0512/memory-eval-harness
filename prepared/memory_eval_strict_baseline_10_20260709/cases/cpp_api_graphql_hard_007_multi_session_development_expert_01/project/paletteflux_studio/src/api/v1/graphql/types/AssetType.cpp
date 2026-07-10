```cpp
// ─────────────────────────────────────────────────────────────────────────────
//  PaletteFlux GraphQL Studio
//  File: paletteflux_studio/src/api/v1/graphql/types/AssetType.cpp
//  Description: GraphQL “Asset” object type resolver implementation.
//               Bridges the internal domain model `pf::domain::Asset` with the
//               public GraphQL schema using microsoft/graphqlcpp service
//               abstractions.
// ─────────────────────────────────────────────────────────────────────────────

#include "api/v1/graphql/types/AssetType.h"

#include "api/v1/graphql/GraphQLErrorUtils.h"
#include "application/query/AssetQueryService.h"
#include "application/query/PreviewQueryService.h"
#include "application/query/TagQueryService.h"
#include "application/query/LayerQueryService.h"
#include "infrastructure/log/Logger.h"

#include <chrono>
#include <future>
#include <utility>

using namespace std::literals;
using namespace graphql;
using namespace graphql::service;

namespace pf::api::v1::graphql::types {

// ─────────────────────────────────────────────────────────────────────────────
// PIMPL details
// ─────────────────────────────────────────────────────────────────────────────
class AssetType::Impl final
{
public:
    explicit Impl(domain::Asset asset,
                  std::shared_ptr<application::query::AssetQueryService> assetQuerySrv,
                  std::shared_ptr<application::query::PreviewQueryService> previewQuerySrv,
                  std::shared_ptr<application::query::TagQueryService> tagQuerySrv,
                  std::shared_ptr<application::query::LayerQueryService> layerQuerySrv)
        : _asset(std::move(asset))
        , _assetQuerySrv(std::move(assetQuerySrv))
        , _previewQuerySrv(std::move(previewQuerySrv))
        , _tagQuerySrv(std::move(tagQuerySrv))
        , _layerQuerySrv(std::move(layerQuerySrv))
    { }

    const domain::Asset& asset() const noexcept { return _asset; }

    std::shared_ptr<application::query::AssetQueryService>  assetQuery()   const { return _assetQuerySrv; }
    std::shared_ptr<application::query::PreviewQueryService> previewQuery() const { return _previewQuerySrv; }
    std::shared_ptr<application::query::TagQueryService>     tagQuery()    const { return _tagQuerySrv; }
    std::shared_ptr<application::query::LayerQueryService>   layerQuery()  const { return _layerQuerySrv; }

private:
    domain::Asset                                            _asset;
    std::shared_ptr<application::query::AssetQueryService>   _assetQuerySrv;
    std::shared_ptr<application::query::PreviewQueryService> _previewQuerySrv;
    std::shared_ptr<application::query::TagQueryService>     _tagQuerySrv;
    std::shared_ptr<application::query::LayerQueryService>   _layerQuerySrv;
};

// ─────────────────────────────────────────────────────────────────────────────
// Ctor / Dtor
// ─────────────────────────────────────────────────────────────────────────────
AssetType::AssetType(
    domain::Asset                                             asset,
    std::shared_ptr<application::query::AssetQueryService>    assetQuerySrv,
    std::shared_ptr<application::query::PreviewQueryService>  previewQuerySrv,
    std::shared_ptr<application::query::TagQueryService>      tagQuerySrv,
    std::shared_ptr<application::query::LayerQueryService>    layerQuerySrv)
    : Object({
        "Asset",                   // Name as declared in the GraphQL schema
        {                          // Interfaces implemented
            "Node"
        }
      })
    , _impl(std::make_unique<Impl>(std::move(asset),
                                   std::move(assetQuerySrv),
                                   std::move(previewQuerySrv),
                                   std::move(tagQuerySrv),
                                   std::move(layerQuerySrv)))
{
}

// NOLINTNEXTLINE(cppcoreguidelines-special-member-functions)
AssetType::~AssetType() = default;

// ─────────────────────────────────────────────────────────────────────────────
// Resolver helpers
// ─────────────────────────────────────────────────────────────────────────────
namespace
{
    // Wrap blocking call in a std::future to comply with async GraphQL resolver
    template <typename F>
    auto asAsync(F&& fn) -> std::shared_ptr<response::Awaitable>
    {
        return std::make_shared<response::Awaitable>(
            std::async(std::launch::async, std::forward<F>(fn)));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field resolvers
// ─────────────────────────────────────────────────────────────────────────────
FieldResult<IDType> AssetType::getId() const
{
    return _impl->asset().id().toString();
}

FieldResult<std::string> AssetType::getName() const
{
    return _impl->asset().name();
}

FieldResult<std::string> AssetType::getMimeType() const
{
    return _impl->asset().mimeType();
}

FieldResult<response::IntType> AssetType::getByteSize() const
{
    return static_cast<response::IntType>(_impl->asset().byteSize());
}

FieldResult<DateTime> AssetType::getCreatedAt() const
{
    return _impl->asset().createdAt();
}

FieldResult<DateTime> AssetType::getUpdatedAt() const
{
    return _impl->asset().updatedAt();
}

AwaitableResolver AssetType::getTags(FieldParams params) const
{
    (void) params; // Unused today; kept for future filters/arguments

    return asAsync([impl = _impl] {
        try
        {
            auto tags = impl->tagQuery()->listForAsset(impl->asset().id());
            std::vector<std::shared_ptr<Object>> gqlTags;
            gqlTags.reserve(tags.size());

            for (const auto& tag : tags)
            {
                gqlTags.emplace_back(std::make_shared<TagType>(tag));
            }
            return FieldResult<std::vector<std::shared_ptr<Object>>>(std::move(gqlTags));
        }
        catch (const std::exception& ex)
        {
            spdlog::error("[AssetType] Failed to resolve tags: {}", ex.what());
            return FieldResult<std::vector<std::shared_ptr<Object>>>(
                GraphQLErrorUtils::toGraphQLError("Unable to resolve asset tags",
                                                  ex,
                                                  "AssetType::tags"));
        }
    });
}

AwaitableResolver AssetType::getLayers(FieldParams params) const
{
    (void) params;

    return asAsync([impl = _impl] {
        try
        {
            auto layers = impl->layerQuery()->listForAsset(impl->asset().id());
            std::vector<std::shared_ptr<Object>> gqlLayers;
            gqlLayers.reserve(layers.size());

            for (auto& layer : layers)
            {
                gqlLayers.emplace_back(std::make_shared<LayerType>(std::move(layer)));
            }
            return FieldResult<std::vector<std::shared_ptr<Object>>>(std::move(gqlLayers));
        }
        catch (const std::exception& ex)
        {
            spdlog::error("[AssetType] Failed to resolve layers: {}", ex.what());
            return FieldResult<std::vector<std::shared_ptr<Object>>>(
                GraphQLErrorUtils::toGraphQLError("Unable to resolve asset layers",
                                                  ex,
                                                  "AssetType::layers"));
        }
    });
}

AwaitableResolver AssetType::getPreviews(FieldParams params) const
{
    const std::optional<PreviewScale> scaleArg =
        params.arg<PreviewScale>("scale").value_or(PreviewScale::ORIGINAL);

    return asAsync([impl  = _impl,
                    scale = scaleArg.value_or(PreviewScale::ORIGINAL)] {
        try
        {
            auto previews = impl->previewQuery()->listForAsset(impl->asset().id(), scale);
            std::vector<std::shared_ptr<Object>> gqlPreviews;
            gqlPreviews.reserve(previews.size());

            for (auto& preview : previews)
            {
                gqlPreviews.emplace_back(std::make_shared<PreviewType>(std::move(preview)));
            }
            return FieldResult<std::vector<std::shared_ptr<Object>>>(std::move(gqlPreviews));
        }
        catch (const std::exception& ex)
        {
            spdlog::error("[AssetType] Failed to resolve previews: {}", ex.what());
            return FieldResult<std::vector<std::shared_ptr<Object>>>(
                GraphQLErrorUtils::toGraphQLError("Unable to resolve asset previews",
                                                  ex,
                                                  "AssetType::previews"));
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Introspection / Interface resolution
// ─────────────────────────────────────────────────────────────────────────────
bool AssetType::implementsService(const response::StringView& interfaceName) const noexcept
{
    return interfaceName == "Node"sv;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type mapping helpers for schema registration
// ─────────────────────────────────────────────────────────────────────────────
std::shared_ptr<Object> AssetType::make(
    const domain::Asset&                                       asset,
    const std::shared_ptr<application::query::AssetQueryService>&    assetQuerySrv,
    const std::shared_ptr<application::query::PreviewQueryService>&  previewQuerySrv,
    const std::shared_ptr<application::query::TagQueryService>&      tagQuerySrv,
    const std::shared_ptr<application::query::LayerQueryService>&    layerQuerySrv)
{
    return std::make_shared<AssetType>(asset,
                                       assetQuerySrv,
                                       previewQuerySrv,
                                       tagQuerySrv,
                                       layerQuerySrv);
}

} // namespace pf::api::v1::graphql::types
```