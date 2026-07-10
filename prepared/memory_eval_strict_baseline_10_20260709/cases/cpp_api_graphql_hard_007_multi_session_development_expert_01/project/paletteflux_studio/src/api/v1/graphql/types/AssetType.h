#pragma once
/**************************************************************************************************
 *  File:    AssetType.h
 *  Project: PaletteFlux GraphQL Studio – API v1
 *  Desc:    GraphQL type wrapper for the domain model `Asset`. Integrates the domain entity with
 *           the C++ GraphQL runtime (microsoft/cppgraphqlgen-style). Exposes fine-grained, async
 *           field resolvers that delegate to the service layer while supporting response-caching,
 *           monitoring hooks, and future schema evolution.
 *
 *  © 2024 PaletteFlux. MIT License.
 **************************************************************************************************/
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <chrono>

#include <cppgraphqlgen/GraphQLService.h>        // 3rd-party GraphQL runtime
#include <cppgraphqlgen/GraphQLResponse.h>       // GraphQL response primitives
#include <cppgraphqlgen/GraphQLSchema.h>         // SDL builder utilities

#include "service_layer/AssetQueryService.h"     // Query façade (CQRS)
#include "service_layer/AssetUrlService.h"       // URL generator for previews
#include "telemetry/TraceSpan.h"                 // Monitoring / tracing
#include "utils/ISO8601.h"                       // Date-time formatting helpers

namespace paletteflux::api::v1::graphql::types
{

/**
 * GraphQL wrapper around `model::Asset`
 *
 * This type is *not* the domain model – it is a thin façade that lives entirely in the
 * GraphQL boundary layer. It receives a shared_ptr to a domain model instance and resolves
 * fields asynchronously by delegating to the *query* side of our CQRS architecture.
 */
class AssetType final : public ::graphql::service::Object
{
public:
    // clang-format off
    /**
     * Register type & resolvers with the GraphQL schema builder.
     *
     * Example:
     *     auto& builder = schema->GetBuilder();
     *     AssetType::AddTypeDefinition(builder);
     *     AssetType::AddResolvers(builder);
     */
    // clang-format on
    static void AddTypeDefinition(::graphql::schema::SchemaBuilder& builder);

    static void AddResolvers(::graphql::schema::SchemaBuilder& builder);

    /**
     * Factory helper used by resolver functions.
     */
    static std::shared_ptr<AssetType> Make(std::shared_ptr<model::Asset> asset,
                                           std::shared_ptr<service_layer::AssetQueryService> querySvc,
                                           std::shared_ptr<service_layer::AssetUrlService> urlSvc) noexcept
    {
        return std::shared_ptr<AssetType>(new AssetType(std::move(asset),
                                                        std::move(querySvc),
                                                        std::move(urlSvc)));
    }

private:
    // ──────────────────────────────────────────────── Construction ─────
    AssetType(std::shared_ptr<model::Asset> asset,
              std::shared_ptr<service_layer::AssetQueryService> querySvc,
              std::shared_ptr<service_layer::AssetUrlService> urlSvc) noexcept;

    // ──────────────────────────────────────────────── Resolvers ────────
    ::graphql::service::AwaitableResolver resolveId(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveName(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveCategory(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveMimeType(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveTags(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveSizeBytes(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveCreatedAt(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveUpdatedAt(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolvePreviewUrl(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveDependencies(::graphql::service::ResolverParams&&) const;
    ::graphql::service::AwaitableResolver resolveMeta(::graphql::service::ResolverParams&&) const;

    // ──────────────────────────────────────────────── Internals ────────
    std::shared_ptr<model::Asset> _asset;
    std::shared_ptr<service_layer::AssetQueryService> _querySvc;
    std::shared_ptr<service_layer::AssetUrlService>   _urlSvc;
};

/* ================================================= IMPLEMENTATION === */

inline AssetType::AssetType(std::shared_ptr<model::Asset> asset,
                            std::shared_ptr<service_layer::AssetQueryService> querySvc,
                            std::shared_ptr<service_layer::AssetUrlService> urlSvc) noexcept
    : ::graphql::service::Object({ "Asset" })
    , _asset(std::move(asset))
    , _querySvc(std::move(querySvc))
    , _urlSvc(std::move(urlSvc))
{
    if (!_asset)
    {
        throw std::invalid_argument("AssetType requires non-null model::Asset");
    }
}

/* --------------- Schema SDL Registration --------------------------- */
inline void AssetType::AddTypeDefinition(::graphql::schema::SchemaBuilder& builder)
{
    using namespace ::graphql::schema;
    builder.AddType("Asset", "Creative asset – brush, texture, audio layer, etc.",
        {
            Field("id",       "ID!",            "Stable, globally unique identifier"),
            Field("name",     "String!",        "Human-readable name"),
            Field("category", "String!",        "Domain specific category key"),
            Field("mimeType", "String!",        "IANA media type"),
            Field("tags",     "[String!]!",     "Free-form tag list"),
            Field("sizeBytes","Int!",           "Payload size in bytes"),
            Field("createdAt","DateTime!",      "ISO-8601 UTC timestamp"),
            Field("updatedAt","DateTime!",      "ISO-8601 UTC timestamp"),
            Field("previewUrl","URL!",          "CDN-ready preview URL"),
            Field("dependencies","[Asset!]!",   "Assets referenced by this asset"),
            Field("meta",     "JSON!",          "Opaque metadata blob")
        },
        { Directives::key("id") /* federation */ });
}

inline void AssetType::AddResolvers(::graphql::schema::SchemaBuilder& builder)
{
    using namespace ::graphql::schema;
    builder.AddResolver<AssetType>("Asset", {
        { "id",            &AssetType::resolveId },
        { "name",          &AssetType::resolveName },
        { "category",      &AssetType::resolveCategory },
        { "mimeType",      &AssetType::resolveMimeType },
        { "tags",          &AssetType::resolveTags },
        { "sizeBytes",     &AssetType::resolveSizeBytes },
        { "createdAt",     &AssetType::resolveCreatedAt },
        { "updatedAt",     &AssetType::resolveUpdatedAt },
        { "previewUrl",    &AssetType::resolvePreviewUrl },
        { "dependencies",  &AssetType::resolveDependencies },
        { "meta",          &AssetType::resolveMeta }
    });
}

/* --------------- Individual Field Resolvers ------------------------ */
inline ::graphql::service::AwaitableResolver
AssetType::resolveId(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.id");
    (void)params; // suppress unused warning
    return ::graphql::service::ModifiedResult(_asset->id());
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveName(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.name");
    (void)params;
    return ::graphql::service::ModifiedResult(_asset->name());
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveCategory(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.category");
    (void)params;
    return ::graphql::service::ModifiedResult(_asset->category());
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveMimeType(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.mimeType");
    (void)params;
    return ::graphql::service::ModifiedResult(_asset->mime_type());
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveTags(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.tags");
    (void)params;
    return ::graphql::service::ModifiedResult(_asset->tags());
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveSizeBytes(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.sizeBytes");
    (void)params;
    return ::graphql::service::ModifiedResult(static_cast<int>(_asset->size_bytes()));
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveCreatedAt(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.createdAt");
    (void)params;
    return ::graphql::service::ModifiedResult(utils::ISO8601::format(_asset->created_at()));
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveUpdatedAt(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.updatedAt");
    (void)params;
    return ::graphql::service::ModifiedResult(utils::ISO8601::format(_asset->updated_at()));
}

inline ::graphql::service::AwaitableResolver
AssetType::resolvePreviewUrl(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.previewUrl");
    (void)params;

    try
    {
        const std::string url = _urlSvc->buildPreviewUrl(_asset->id());
        return ::graphql::service::ModifiedResult(url);
    }
    catch (const std::exception& ex)
    {
        // Surface as GraphQL error
        return ::graphql::service::AwaitableResolver(
            ::graphql::service::FieldError("Failed to build preview URL", { ex.what() }));
    }
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveDependencies(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.dependencies");
    (void)params;

    try
    {
        const auto deps = _querySvc->fetchDependencies(_asset->id());
        std::vector<std::shared_ptr<AssetType>> gqlDeps;
        gqlDeps.reserve(deps.size());
        for (auto& dep : deps)
        {
            gqlDeps.emplace_back(AssetType::Make(
                dep, _querySvc, _urlSvc)); // reuse same services
        }
        return ::graphql::service::ModifiedResult(std::move(gqlDeps));
    }
    catch (const std::exception& ex)
    {
        return ::graphql::service::AwaitableResolver(
            ::graphql::service::FieldError("Failed to fetch dependencies", { ex.what() }));
    }
}

inline ::graphql::service::AwaitableResolver
AssetType::resolveMeta(::graphql::service::ResolverParams&& params) const
{
    const auto span = telemetry::TraceSpan::Scoped("Asset.meta");
    (void)params;
    return ::graphql::service::ModifiedResult(_asset->meta().toString());
}

} // namespace paletteflux::api::v1::graphql::types