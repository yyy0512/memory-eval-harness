#ifndef PALETTEFLUX_STUDIO_API_V1_GRAPHQL_SCHEMA_H
#define PALETTEFLUX_STUDIO_API_V1_GRAPHQL_SCHEMA_H

/**
 *  PaletteFlux GraphQL Studio
 *  File: Schema.h
 *
 *  Description:
 *      Aggregates and owns the executable GraphQL schema used by the v1 API.
 *      The class encapsulates:
 *          • SDL loading / validation (with optional hot-reloading in dev)
 *          • Registration of application-level resolver functions
 *          • Pluggable instrumentation hooks (tracing, logging, metrics)
 *          • Thread-safe, lazy initialisation and lifetime management
 *
 *  The implementation is intentionally header-only to keep the module
 *  lightweight for downstream linkage. All heavyweight objects are allocated
 *  on demand and shielded behind smart pointers to avoid static-init order
 *  fiascos.
 *
 *  Dependencies:
 *      – graphqlcpp (https://github.com/microsoft/graphqlpp) or a compatible
 *        C++17 GraphQL engine that exposes the microsoft::graphql namespace.
 *      – A service-layer facade that exposes read/write use-cases (omitted).
 *
 *  Copyright:
 *      © 2023-2024 PaletteFlux Contributors. All rights reserved.
 */

#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <graphqlservice/GraphQLService.h>  // Upstream GraphQL runtime
#include <graphqlservice/introspection.h>

namespace paletteflux::studio::api::v1::graphql
{

//--------------------------------------------------------------------------------------------------------------------
// Forward Declarations
//--------------------------------------------------------------------------------------------------------------------

class IResolverRegistry;
class IMetricsSink;
class ILogSink;

//--------------------------------------------------------------------------------------------------------------------
// Schema::Options
//--------------------------------------------------------------------------------------------------------------------

/**
 *  Options used when constructing / reloading the executable schema.
 */
struct SchemaOptions
{
    bool enableIntrospection   = true;  // Toggle __schema / __type root fields
    bool enableTracing         = true;  // Expose Apollo-style tracing ext
    bool enableValidationCache = true;  // Cache parsed queries
    bool enableHotReload       = false; // Re-parse SDL on file change (dev)

    // Location of the SDL file on disk. If empty, embedded SDL will be used.
    std::filesystem::path sdlFileLocation {};

    // The amount of time between filesystem polls when hot-reloading.
    std::chrono::milliseconds hotReloadInterval { 250 };
};

//--------------------------------------------------------------------------------------------------------------------
// Schema
//--------------------------------------------------------------------------------------------------------------------

/**
 *  Singleton façade that owns the application GraphQL schema.
 *
 *  The main consumer is the HTTP/WS gateway layer that delegates GraphQL
 *  queries to this class for execution.
 */
class Schema final
{
public:
    /**
     *  Acquires the global schema instance (thread-safe, lazy).
     *  The very first call will perform the full initialisation sequence.
     */
    static Schema& instance();

    /**
     *  Must be called exactly once during process shutdown to release global
     *  resources in a deterministic order.
     */
    static void shutdown() noexcept;

    Schema(const Schema&)            = delete;
    Schema& operator=(const Schema&) = delete;
    Schema(Schema&&)                 = delete;
    Schema& operator=(Schema&&)      = delete;

    //---------------------------------------------------------------------
    // Introspection / Diagnostics
    //---------------------------------------------------------------------

    [[nodiscard]] const SchemaOptions& options() const noexcept;

    /**
     *  Returns the raw SDL used for the active executable schema.
     */
    [[nodiscard]] std::string sdl() const;

    /**
     *  Convenience helper forwarding into the underlying GraphQL runtime.
     */
    [[nodiscard]] const std::shared_ptr<graphql::schema::Schema>&
    executableSchema() const noexcept
    {
        return m_executableSchema;
    }

    /**
     *  Runs a GraphQL query against the schema.
     *
     *  @param   query       GraphQL query / mutation / subscription text
     *  @param   variables   Runtime variables
     *  @param   operation   Operation name (optional)
     *  @return  JSON-encoded execution result
     *
     *  Note: This call is thread-safe and re-entrant.
     */
    std::string execute(
        std::string_view                             query,
        const std::optional<graphql::response::Value>& variables = std::nullopt,
        const std::optional<std::string_view>&        operation  = std::nullopt) const;

private:
    //---------------------------------------------------------------------
    // Construction / Destruction (private)
    //---------------------------------------------------------------------

    Schema();
    explicit Schema(SchemaOptions opts);
    ~Schema();

    //---------------------------------------------------------------------
    // Internal Helpers
    //---------------------------------------------------------------------

    void   loadSDL();
    void   buildExecutableSchema();
    void   startFileWatcher();
    void   stopFileWatcher();
    bool   sdlFileHasChanged() const;
    void   reloadIfNecessary();
    size_t sdlHash(const std::string& sdl) const noexcept;

    //---------------------------------------------------------------------
    // Data Members
    //---------------------------------------------------------------------

    SchemaOptions                                   m_options;
    std::shared_ptr<IResolverRegistry>              m_resolverRegistry;
    std::shared_ptr<IMetricsSink>                   m_metricsSink;
    std::shared_ptr<ILogSink>                       m_logSink;

    std::shared_ptr<graphql::schema::Schema>        m_executableSchema;
    std::string                                     m_rawSDL;
    size_t                                          m_rawSDLHash { 0 };

    mutable std::mutex                              m_executeMutex;

    // Hot-reload
    std::atomic<bool>                               m_watching { false };
    std::thread                                     m_watcherThread;
    std::filesystem::file_time_type                 m_lastWriteTime {};
};

//--------------------------------------------------------------------------------------------------------------------
// Inline Implementations
//--------------------------------------------------------------------------------------------------------------------

inline const SchemaOptions& Schema::options() const noexcept
{
    return m_options;
}

//--------------------------------------------------------------------------------------------------------------------
// IResolverRegistry
//--------------------------------------------------------------------------------------------------------------------

/**
 *  Strategy interface bridging business logic resolvers with the GraphQL
 *  runtime. Allows the schema to be decoupled from the service layer.
 */
class IResolverRegistry
{
public:
    virtual ~IResolverRegistry() = default;

    /**
     *  Register application-specific GraphQL object types and resolvers.
     *  Invoked during Schema::buildExecutableSchema().
     */
    virtual void registerResolvers(
        const std::shared_ptr<graphql::schema::Schema>& schema) = 0;
};

//--------------------------------------------------------------------------------------------------------------------
// Null-Object Implementations (defaults for headless builds)
//--------------------------------------------------------------------------------------------------------------------

class NullMetricsSink final : public IMetricsSink
{
public:
    void recordExecutionTime(std::string_view /*field*/,
                             std::chrono::nanoseconds /*dur*/) {}
};

class NullLogSink final : public ILogSink
{
public:
    void log(std::string_view /*msg*/) {}
};

//--------------------------------------------------------------------------------------------------------------------
// IMetricsSink / ILogSink interfaces
//--------------------------------------------------------------------------------------------------------------------

class IMetricsSink
{
public:
    virtual ~IMetricsSink() = default;
    virtual void recordExecutionTime(std::string_view field,
                                     std::chrono::nanoseconds dur) = 0;
};

class ILogSink
{
public:
    virtual ~ILogSink() = default;
    virtual void log(std::string_view message) = 0;
};

//--------------------------------------------------------------------------------------------------------------------
// Schema::execute (declaration only)
//--------------------------------------------------------------------------------------------------------------------

inline std::string Schema::execute(
    std::string_view                             query,
    const std::optional<graphql::response::Value>& variables,
    const std::optional<std::string_view>&        operation) const
{
    // Protect concurrent access to the GraphQL runtime instance.
    std::scoped_lock guard { m_executeMutex };

    graphql::request::OperationParams params;
    params.query          = query;
    params.operationName  = operation ? std::string { *operation } : std::string {};
    params.variables      = variables ? *variables
                                      : graphql::response::Value { graphql::response::Type::Map };
    params.introspection  = m_options.enableIntrospection;

    auto startTs = std::chrono::high_resolution_clock::now();

    auto response    = m_executableSchema->execute(std::move(params));
    auto finishTs    = std::chrono::high_resolution_clock::now();
    auto elapsedNano = std::chrono::duration_cast<std::chrono::nanoseconds>(
        finishTs - startTs);

    if (m_metricsSink)
    {
        m_metricsSink->recordExecutionTime("graphql.request", elapsedNano);
    }

    try
    {
        std::ostringstream oss;
        oss << response;
        return oss.str();
    }
    catch (const std::exception& ex)
    {
        if (m_logSink) { m_logSink->log(ex.what()); }
        throw; // propagate to caller
    }
}

//--------------------------------------------------------------------------------------------------------------------

} // namespace paletteflux::studio::api::v1::graphql

#endif // PALETTEFLUX_STUDIO_API_V1_GRAPHQL_SCHEMA_H