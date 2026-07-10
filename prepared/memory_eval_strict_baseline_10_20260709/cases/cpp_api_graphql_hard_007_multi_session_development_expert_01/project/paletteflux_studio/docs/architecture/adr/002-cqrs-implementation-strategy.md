# Architecture Decision Record: 002 – CQRS Implementation Strategy  
PaletteFlux GraphQL Studio (`api_graphql`)

---

## Status  
Accepted – 2024-03-31

## Context  
PaletteFlux GraphQL Studio must deal with two distinct classes of operations:

1. Commands – mutations that **change** the state of complex, nested scene graphs (e.g. *AddBrushStroke*, *UpdateShaderNode*, *DeleteAnimationCurve*).  
2. Queries – read-only requests that **project** the current state into multiple materialized views optimized for GraphQL and REST pagination/caching.

A traditional CRUD service layer struggled to provide:

* Fine-grained performance optimisation per use-case (read vs. write).
* Clear reasoning about side-effects in a real-time, collaborative editing workflow.
* Predictable version evolution across both GraphQL and REST surfaces.

Therefore, the team decided to adopt **Command–Query Responsibility Segregation (CQRS)** at the C++ service boundary that underpins our GraphQL resolvers, background workers, and REST endpoints.

## Decision  
We introduce a lightweight, header-only CQRS framework (~700 LoC) that:

* Separates *CommandBus* and *QueryBus* with compile-time type-safety.
* Allows synchronous and asynchronous (std::future-based) dispatch.
* Provides decorator hooks for cross-cutting concerns (metrics, tracing, auth policies).
* Enables zero-runtime-reflection handler registration via constexpr meta-tables.
* Remains agnostic of the transport/protocol layer (GraphQL, REST, gRPC, …).

## Consequences  
1. All mutating operations funnel through a *Command* class and a matching *CommandHandler*.  
2. All read operations funnel through a *Query* class and a matching *QueryHandler*.  
3. GraphQL resolvers no longer access repositories directly; they depend only on `ICommandBus`/`IQueryBus`.  
4. We gain explicit seams for unit testing, request tracing, policy enforcement, and offline re-hydration of command streams.  
5. The codebase grows by ~7 % but readability and long-term maintenance improve markedly.

---

## Reference Implementation  
Below is the production-grade, header-only mini-framework that powers the above decision.  
Copy is deliberately placed in the ADR to keep the decision and its enforcement mechanism side-by-side.

```cpp
// =============================================================
// File: include/pf/cqrs/Cqrs.hpp
// Description: Header-only CQRS framework used by PaletteFlux.
// =============================================================
#pragma once

#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <typeindex>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace pf::cqrs {

// ---------------------------------------------------------------------------
// Infrastructure Exceptions
// ---------------------------------------------------------------------------

class DispatchError : public std::runtime_error
{
public:
    explicit DispatchError(const std::string& msg) : std::runtime_error(msg) {}
};

class HandlerNotFound : public DispatchError
{
public:
    explicit HandlerNotFound(const std::string& typeName)
        : DispatchError("CQRS handler not found for [" + typeName + "]") {}
};

// ---------------------------------------------------------------------------
// Type Traits – Command / Query identification
// ---------------------------------------------------------------------------

struct ICommand     { virtual ~ICommand() = default; };
struct IQuery       { virtual ~IQuery() = default; };
struct IVoidResult  {};
struct IUnit        : IVoidResult {};  // Alias for semantic clarity

// ---------------------------------------------------------------------------
// Interfaces – Buses & Handlers
// ---------------------------------------------------------------------------

template<typename CommandT>
struct ICommandHandler
{
    static_assert(std::is_base_of_v<ICommand, CommandT>,
                  "CommandT must derive from ICommand");
    virtual ~ICommandHandler() = default;
    virtual void handle(const CommandT& cmd) = 0;
};

template<typename QueryT>
struct IQueryHandler
{
    static_assert(std::is_base_of_v<IQuery, QueryT>,
                  "QueryT must derive from IQuery");
    virtual ~IQueryHandler() = default;

    // The handler returns the query's declared result type.
    using Result = typename QueryT::Result;
    virtual Result handle(const QueryT& qry) = 0;
};

struct ICommandBus
{
    virtual ~ICommandBus() = default;
    virtual void dispatch(const ICommand& cmd) = 0;
};

struct IQueryBus
{
    virtual ~IQueryBus() = default;

    template<typename QueryT>
    auto ask(const QueryT& qry) -> typename QueryT::Result
    {
        static_assert(std::is_base_of_v<IQuery, QueryT>,
                      "QueryT must derive from IQuery");
        return askImpl(typeid(QueryT), &qry).template as<typename QueryT::Result>();
    }

private:
    struct AnyResult
    {
        template<typename T>
        T& as()
        {
            return dynamic_cast<Holder<T>*>(ptr.get())->value;
        }
        template<typename T>
        const T& as() const
        {
            return dynamic_cast<const Holder<T>*>(ptr.get())->value;
        }

        // Internal buffer
        struct IBase       { virtual ~IBase() = default; };
        template<typename T>
        struct Holder final : IBase { explicit Holder(T v) : value(std::move(v)) {} T value; };
        std::unique_ptr<IBase> ptr;
    };

    virtual AnyResult askImpl(std::type_index, const void* qryPtr) = 0;
};

// ---------------------------------------------------------------------------
// In-Memory Bus Implementation
// ---------------------------------------------------------------------------

class InMemoryBus final : public ICommandBus, public IQueryBus
{
public:
    // Registration API (thread-safe)
    template<typename CommandT>
    void registerHandler(std::unique_ptr<ICommandHandler<CommandT>> handler)
    {
        const auto key = std::type_index(typeid(CommandT));
        std::lock_guard<std::mutex> lk(mutex_);
        if (commandHandlers_.count(key) != 0)
            throw DispatchError("Duplicate command handler registration");
        commandHandlers_[key] =
            [h = std::move(handler)](const ICommand& cmd) -> void
            {
                h->handle(static_cast<const CommandT&>(cmd));
            };
    }

    template<typename QueryT>
    void registerHandler(std::unique_ptr<IQueryHandler<QueryT>> handler)
    {
        const auto key = std::type_index(typeid(QueryT));
        std::lock_guard<std::mutex> lk(mutex_);
        if (queryHandlers_.count(key) != 0)
            throw DispatchError("Duplicate query handler registration");
        queryHandlers_[key] =
            [h = std::move(handler)](const IQuery& qry) -> AnyResult
            {
                using ResultType = typename QueryT::Result;
                ResultType res = h->handle(static_cast<const QueryT&>(qry));
                return AnyResult{std::make_unique<AnyResult::Holder<ResultType>>(std::move(res))};
            };
    }

    // ICommandBus
    void dispatch(const ICommand& cmd) override
    {
        const auto key = std::type_index(typeid(cmd));
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = commandHandlers_.find(key);
        if (it == commandHandlers_.end())
            throw HandlerNotFound(key.name());
        it->second(cmd);
    }

private:
    // IQueryBus
    AnyResult askImpl(std::type_index key, const void* qryPtr) override
    {
        std::lock_guard<std::mutex> lk(mutex_);
        auto it = queryHandlers_.find(key);
        if (it == queryHandlers_.end())
            throw HandlerNotFound(key.name());
        return it->second(*static_cast<const IQuery*>(qryPtr));
    }

    // Handler maps
    std::unordered_map<std::type_index, std::function<void(const ICommand&)>> commandHandlers_;
    std::unordered_map<std::type_index,
        std::function<IQueryBus::AnyResult(const IQuery&)>> queryHandlers_;
    std::mutex mutex_;
};

// ---------------------------------------------------------------------------
// Decorators – Metrics, Tracing, Policy Enforcement
// ---------------------------------------------------------------------------

class TracingCommandBus final : public ICommandBus
{
public:
    explicit TracingCommandBus(std::shared_ptr<ICommandBus> inner)
        : inner_(std::move(inner)) {}

    void dispatch(const ICommand& cmd) override
    {
        trace("cmd", typeid(cmd).name());
        inner_->dispatch(cmd);
    }

private:
    void trace(const char* kind, const std::string& name)
    {
        // In production we forward this to the central OpenTelemetry sink.
        // Here we use stderr as a fallback.
        std::fprintf(stderr, "[TRACE] %s: %s\n", kind, name.c_str());
    }
    std::shared_ptr<ICommandBus> inner_;
};

class TracingQueryBus final : public IQueryBus
{
public:
    explicit TracingQueryBus(std::shared_ptr<IQueryBus> inner)
        : inner_(std::move(inner)) {}

private:
    AnyResult askImpl(std::type_index idx, const void* qryPtr) override
    {
        trace("qry", idx.name());
        return inner_->askImpl(idx, qryPtr);
    }
    void trace(const char* kind, const std::string& name)
    {
        std::fprintf(stderr, "[TRACE] %s: %s\n", kind, name.c_str());
    }
    std::shared_ptr<IQueryBus> inner_;
};

// ---------------------------------------------------------------------------
// Asynchronous Dispatch Helpers
// ---------------------------------------------------------------------------

class AsyncCommandBus final : public ICommandBus
{
public:
    explicit AsyncCommandBus(std::shared_ptr<ICommandBus> inner)
        : inner_(std::move(inner)) {}

    void dispatch(const ICommand& cmd) override
    {
        // Fire-and-forget – errors surfaced via future::get elsewhere.
        std::packaged_task<void()> task([this, &cmd]
        {
            inner_->dispatch(cmd);
        });
        std::future<void> fut = task.get_future();
        std::thread(std::move(task)).detach();
        futures_.emplace_back(std::move(fut));
    }

    void wait()  // helpful in tests
    {
        for (auto& f : futures_) f.wait();
        futures_.clear();
    }

private:
    std::shared_ptr<ICommandBus> inner_;
    std::vector<std::future<void>> futures_;
};

// ---------------------------------------------------------------------------
// Helper Macro – Registration boilerplate removal
// ---------------------------------------------------------------------------

#define PF_CQRS_REGISTER_COMMAND(bus, CommandType, HandlerType, ...) \
    static_assert(std::is_base_of_v<pf::cqrs::ICommand, CommandType>); \
    bus.registerHandler<CommandType>(std::make_unique<HandlerType>(__VA_ARGS__));

#define PF_CQRS_REGISTER_QUERY(bus, QueryType, HandlerType, ...) \
    static_assert(std::is_base_of_v<pf::cqrs::IQuery, QueryType>); \
    bus.registerHandler<QueryType>(std::make_unique<HandlerType>(__VA_ARGS__));

} // namespace pf::cqrs
```

---

## Usage Example  
Below is a trimmed, yet buildable demonstration of how GraphQL resolvers integrate the bus.

```cpp
// ================================================
// File: src/scene/commands/AddBrushStroke.hpp
// ================================================
#pragma once
#include <string>
#include <vector>
#include "pf/cqrs/Cqrs.hpp"

namespace pf::scene {

struct AddBrushStroke final : pf::cqrs::ICommand
{
    std::string layerId;
    std::vector<float> points;   // x1,y1,x2,y2,…
};

// Repository façade (normally injected via DI)
struct ILayerRepository
{
    virtual ~ILayerRepository() = default;
    virtual void addStroke(const std::string& layerId,
                           const std::vector<float>& pts) = 0;
};

// -----------------------------------------------
// Handler
// -----------------------------------------------
class AddBrushStrokeHandler final :
    public pf::cqrs::ICommandHandler<AddBrushStroke>
{
public:
    explicit AddBrushStrokeHandler(std::shared_ptr<ILayerRepository> repo)
        : repo_(std::move(repo)) {}

    void handle(const AddBrushStroke& cmd) override
    {
        if (cmd.points.empty())
            throw std::invalid_argument("points must not be empty");
        repo_->addStroke(cmd.layerId, cmd.points);
    }

private:
    std::shared_ptr<ILayerRepository> repo_;
};

} // namespace pf::scene
```

```cpp
// ================================================
// File: src/scene/queries/GetLayerStrokes.hpp
// ================================================
#pragma once
#include <string>
#include <vector>
#include "pf/cqrs/Cqrs.hpp"

namespace pf::scene {

struct GetLayerStrokes final : pf::cqrs::IQuery
{
    using Stroke = std::vector<float>;
    using Result = std::vector<Stroke>;

    std::string layerId;
};

class GetLayerStrokesHandler final :
    public pf::cqrs::IQueryHandler<GetLayerStrokes>
{
public:
    explicit GetLayerStrokesHandler(std::shared_ptr<ILayerRepository> repo)
        : repo_(std::move(repo)) {}

    Result handle(const GetLayerStrokes& qry) override
    {
        // Real implementation would fetch & transform DTOs.
        return repo_->getStrokesForLayer(qry.layerId);
    }

private:
    std::shared_ptr<ILayerRepository> repo_;
};

} // namespace pf::scene
```

```cpp
// ================================================
// File: src/api/GraphQL/MutationResolver.cpp
// ================================================
#include "pf/cqrs/Cqrs.hpp"
#include "scene/commands/AddBrushStroke.hpp"

using namespace pf;

class MutationResolver
{
public:
    explicit MutationResolver(std::shared_ptr<cqrs::ICommandBus> bus)
        : bus_(std::move(bus)) {}

    bool addBrushStroke(const std::string& layerId,
                        std::vector<float> points)
    {
        scene::AddBrushStroke cmd{layerId, std::move(points)};
        bus_->dispatch(cmd);
        return true;
    }

private:
    std::shared_ptr<cqrs::ICommandBus> bus_;
};
```

---

## Migration Plan  
1. Introduce the framework header in `v0.13.0`.  
2. Refactor existing mutation endpoints in small vertical slices (domain by domain).  
3. Remove direct repository access from controllers once full parity is reached.  
4. Enable event sourcing for commands in `v0.14.0` (future ADR).

---

## Rejected Alternatives  
* Full-blown *Event Sourcing* from day one – too heavy for current release timeline.  
* Off-the-shelf frameworks (e.g. Axon, CAF) – licensing and binary size concerns.  

---

©️ PaletteFlux Studio, 2024