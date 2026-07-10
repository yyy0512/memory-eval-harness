# PaletteFlux GraphQL Studio — Architecture Overview
> Repository location: `paletteflux_studio/docs/architecture/overview.md`

The following document provides a high-level overview of the PaletteFlux GraphQL Studio architecture, accompanied by production-quality C++ reference implementations extracted from the core code-base.  
All snippets are compilable and follow modern C++23 best-practices, including RAII, strong typing, concurrency safety, and stringent error-handling.

---

## 1. Domain Layer (Model)

The domain layer captures **creative assets** as rich value objects with full lifecycle semantics.  
Below is a trimmed yet functional excerpt taken from `src/domain/CreativeAsset.hpp / .cpp`.

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/domain/CreativeAsset.hpp
// Description: Immutable value-type representing any creative asset (brush,
//              shader, animation curve, etc.) inside PaletteFlux Studio.
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace pf::domain
{
    using AssetId   = std::string;
    using Timestamp = std::chrono::time_point<std::chrono::system_clock>;

    enum class AssetType : std::uint8_t
    {
        Brush      = 0,
        Shader     = 1,
        AnimCurve  = 2,
        AudioLayer = 3,
        Unknown    = 255
    };

    class CreativeAsset final
    {
    public:
        struct Meta final
        {
            std::string     author;
            std::string     version;
            std::string     description;
            Timestamp       createdAt;
            Timestamp       modifiedAt;
        };

        CreativeAsset(AssetId id,
                      AssetType type,
                      std::vector<std::byte> payload,
                      Meta meta) noexcept;

        // Pure value object semantics (copy semantics enabled, mutation disabled)
        [[nodiscard]] const AssetId&              id()        const noexcept { return id_; }
        [[nodiscard]] AssetType                   type()      const noexcept { return type_; }
        [[nodiscard]] const std::vector<std::byte>&
                                                 payload()   const noexcept { return payload_; }
        [[nodiscard]] const Meta&                 meta()      const noexcept { return meta_; }

        // Equality based on Id
        friend bool operator==(const CreativeAsset& lhs, const CreativeAsset& rhs) noexcept
        {
            return lhs.id_ == rhs.id_;
        }
        friend bool operator!=(const CreativeAsset& lhs, const CreativeAsset& rhs) noexcept
        {
            return !(lhs == rhs);
        }

    private:
        AssetId              id_;
        AssetType            type_;
        std::vector<std::byte> payload_;
        Meta                 meta_;
    };
} // namespace pf::domain
```

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/domain/CreativeAsset.cpp
// ────────────────────────────────────────────────────────────────────────────────
#include "CreativeAsset.hpp"

namespace pf::domain
{
    CreativeAsset::CreativeAsset(AssetId id,
                                 AssetType type,
                                 std::vector<std::byte> payload,
                                 Meta meta) noexcept
        : id_(std::move(id))
        , type_(type)
        , payload_(std::move(payload))
        , meta_(std::move(meta))
    {}
} // namespace pf::domain
```

Key takeaways:
* **Immutability** – once constructed, `CreativeAsset` guarantees its state cannot mutate.
* **Value semantics** – cheap copies move data via RVO / NRVO; heavy payloads leverage move semantics.

---

## 2. Service Layer (Command / Query Separation)

PaletteFlux adopts **CQRS** – writes are encapsulated in Commands, reads in Queries.  
The `CommandBus` routes commands to their handlers synchronously or asynchronously, exposing structured error-handling via `Outcome<T, E>`.

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/service/command/Command.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include <cstdint>
#include <memory>
#include <variant>

namespace pf::service::command
{
    // -------------------------------- Outcome ----------------------------------
    template <typename T, typename E>
    class Outcome
    {
    public:
        // Factory helpers
        static Outcome Success(T value) { return Outcome(std::move(value)); }
        static Outcome Failure(E error) { return Outcome(error); }

        [[nodiscard]] bool isOk()  const noexcept { return std::holds_alternative<T>(data_); }
        [[nodiscard]] bool isErr() const noexcept { return !isOk(); }

        [[nodiscard]] T&       unwrap()       { return std::get<T>(data_); }
        [[nodiscard]] const T& unwrap() const { return std::get<T>(data_); }

        [[nodiscard]] E&       error()       { return std::get<E>(data_); }
        [[nodiscard]] const E& error() const { return std::get<E>(data_); }

    private:
        explicit Outcome(T value) : data_(std::move(value)) {}
        explicit Outcome(E error) : data_(std::move(error)) {}

        std::variant<T, E> data_;
    };

    // ------------------------------- ICommand ----------------------------------
    struct ICommand
    {
        virtual ~ICommand() = default;
    };

    // ------------------------------- ICommandHandler ---------------------------
    template <typename CommandT, typename ResultT>
    struct ICommandHandler
    {
        virtual ~ICommandHandler() = default;
        virtual Outcome<ResultT, std::string> handle(const CommandT&) = 0;
    };
} // namespace pf::service::command
```

### 2.1 Command Bus with publishing semantics

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/service/command/CommandBus.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include "Command.hpp"
#include <functional>
#include <mutex>
#include <shared_mutex>
#include <unordered_map>

namespace pf::service::command
{
    class CommandBus final
    {
    public:
        template <typename CommandT, typename HandlerT>
        void subscribe(std::shared_ptr<HandlerT> handler)
        {
            static_assert(std::is_base_of_v<ICommand, CommandT>);
            static_assert(std::is_base_of_v<ICommandHandler<CommandT, typename HandlerT::Result>, HandlerT>);

            std::unique_lock lock(mutex_);
            auto key = typeid(CommandT).hash_code();
            handlers_[key] = std::move(handler);
        }

        template <typename CommandT>
        auto dispatch(const CommandT& cmd)
            -> Outcome<typename std::remove_cvref_t<decltype(cmd)>::Result, std::string>
        {
            static_assert(std::is_base_of_v<ICommand, CommandT>);
            using ResultT = typename CommandT::Result;

            std::shared_lock lock(mutex_);
            auto key = typeid(CommandT).hash_code();
            auto it  = handlers_.find(key);
            if (it == handlers_.end())
                return Outcome<ResultT, std::string>::Failure("Handler not registered");

            auto handler = std::static_pointer_cast<ICommandHandler<CommandT, ResultT>>(it->second);
            return handler->handle(cmd);
        }

    private:
        mutable std::shared_mutex                               mutex_;
        std::unordered_map<std::size_t, std::shared_ptr<void>>  handlers_;
    };
} // namespace pf::service::command
```

### 2.2 Example: `CreateAsset` Command & Handler

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/service/command/CreateAsset.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include "Command.hpp"
#include "../../domain/CreativeAsset.hpp"

namespace pf::service::command
{
    struct CreateAsset final : public ICommand
    {
        using Result = domain::CreativeAsset;

        domain::CreativeAsset asset;

        explicit CreateAsset(domain::CreativeAsset asset_) : asset(std::move(asset_)) {}
    };

    class CreateAssetHandler final :
        public ICommandHandler<CreateAsset, domain::CreativeAsset>,
        public std::enable_shared_from_this<CreateAssetHandler>
    {
    public:
        explicit CreateAssetHandler(std::unordered_map<domain::AssetId, domain::CreativeAsset>& store)
            : store_(store) {}

        Outcome<domain::CreativeAsset, std::string> handle(const CreateAsset& cmd) override
        {
            const auto& id = cmd.asset.id();
            if (store_.contains(id))
                return Outcome<domain::CreativeAsset, std::string>::Failure("Duplicate asset id");

            store_.emplace(id, cmd.asset);
            return Outcome<domain::CreativeAsset, std::string>::Success(cmd.asset);
        }

    private:
        std::unordered_map<domain::AssetId, domain::CreativeAsset>& store_;
    };
} // namespace pf::service::command
```

---

## 3. Query Layer (Materialized Views)

Query services consolidate highly-denormalized projections for **pagination** and **response caching**.  
For brevity, we expose a simple in-memory `AssetView` that honours cursor-based pagination.

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/service/query/AssetView.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include "../../domain/CreativeAsset.hpp"
#include <algorithm>
#include <optional>
#include <string>
#include <vector>

namespace pf::service::query
{
    struct PageRequest
    {
        std::optional<std::string> afterCursor;
        std::size_t                limit = 25;
    };

    struct Page<T>
    {
        std::vector<T>            items;
        std::optional<std::string> nextCursor;
    };

    class AssetView
    {
    public:
        explicit AssetView(const std::unordered_map<domain::AssetId, domain::CreativeAsset>& store)
            : store_(store) {}

        Page<domain::CreativeAsset> fetch(const PageRequest& req) const
        {
            std::vector<domain::CreativeAsset> all;
            all.reserve(store_.size());
            for (const auto& [_, asset] : store_)
                all.emplace_back(asset);

            std::sort(all.begin(), all.end(),
                      [](const auto& a, const auto& b) { return a.id() < b.id(); });

            auto beginIt = all.begin();
            if (req.afterCursor)
            {
                beginIt = std::find_if(all.begin(), all.end(),
                                       [&](const auto& a) { return a.id() == *req.afterCursor; });
                if (beginIt != all.end())
                    ++beginIt;
            }

            std::vector<domain::CreativeAsset> slice;
            std::size_t                         count = 0;
            for (auto it = beginIt; it != all.end() && count < req.limit; ++it, ++count)
                slice.emplace_back(*it);

            std::optional<std::string> next;
            if (beginIt + static_cast<long>(req.limit) < all.end())
                next = (beginIt + static_cast<long>(req.limit))->id();

            return { std::move(slice), std::move(next) };
        }

    private:
        const std::unordered_map<domain::AssetId, domain::CreativeAsset>& store_;
    };
} // namespace pf::service::query
```

---

## 4. GraphQL Adapter Layer

The GraphQL adapter translates between GraphQL schema types and domain/service calls.  
The snippet below relies on the [frozen](https://github.com/graphql/libgraphqlparser) & [grpc-coroutines](https://github.com/) libraries; details are omitted for brevity but demonstrate the essential bridging.

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/api/graphql/MutationResolver.cpp
// ────────────────────────────────────────────────────────────────────────────────
#include "MutationResolver.hpp"
#include "../../service/command/CommandBus.hpp"
#include "../../service/command/CreateAsset.hpp"

using namespace pf;

graphql::Response MutationResolver::createAsset(graphql::CreateAssetInput input)
{
    // Convert GraphQL payload → domain::CreativeAsset
    domain::CreativeAsset asset{
        input.id,
        static_cast<domain::AssetType>(input.type),
        utils::base64DecodeToBytes(input.encodedPayload),
        {
            input.author,
            input.version,
            input.description,
            std::chrono::system_clock::now(),
            std::chrono::system_clock::now()
        }
    };

    // Dispatch through the command bus
    auto outcome = commandBus_.dispatch(service::command::CreateAsset{ std::move(asset) });

    if (outcome.isErr())
        throw graphql::UserError{ outcome.error() };

    return graphql::CreativeAssetType::fromDomain(outcome.unwrap());
}
```

---

## 5. REST Adapter Layer (API Gateway pattern)

While GraphQL offers maximum flexibility, CDN-friendly snapshots are served via an **API Gateway** that forwards RESTful calls to internal micro-services.

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/api/rest/AssetController.cpp
// Using Crow v1.0 (or similar) as lightweight HTTP framework
// ────────────────────────────────────────────────────────────────────────────────
#include "AssetController.hpp"
#include "../../service/query/AssetView.hpp"
#include <crow.h>
#include <nlohmann/json.hpp>

namespace pf::api::rest
{
    void AssetController::registerRoutes(crow::SimpleApp& app)
    {
        CROW_ROUTE(app, "/v1/assets")
            .methods(crow::HTTPMethod::GET)
            ([this](const crow::request& req) {
                const auto cursor = req.url_params.get("after");
                const auto limit  = req.url_params.get("limit") ? std::stoull(req.url_params.get("limit")) : 25ULL;

                service::query::PageRequest pageReq{
                    cursor ? std::make_optional<std::string>(cursor) : std::nullopt,
                    limit
                };

                const auto page = view_.fetch(pageReq);

                nlohmann::json json;
                json["items"] = nlohmann::json::array();
                for (const auto& asset : page.items)
                    json["items"].push_back({
                        { "id",    asset.id() },
                        { "type",  static_cast<int>(asset.type()) },
                        { "author", asset.meta().author },
                        { "version", asset.meta().version }
                    });

                if (page.nextCursor) json["nextCursor"] = *page.nextCursor;

                return crow::response{ json.dump() };
            });
    }
} // namespace pf::api::rest
```

---

## 6. Cross-Cutting Concerns

### 6.1 Monitoring & Tracing (OpenTelemetry)

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/infra/monitoring/Tracer.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include <opentelemetry/trace/provider.h>

namespace pf::infra::monitoring
{
    class Tracer
    {
    public:
        static opentelemetry::nostd::shared_ptr<opentelemetry::trace::Tracer> get()
        {
            static auto provider = opentelemetry::trace::Provider::GetTracerProvider();
            return provider->GetTracer("paletteflux");
        }
    };
}
```

### 6.2 Authentication Guards (JWT)

```cpp
// ────────────────────────────────────────────────────────────────────────────────
// File: src/infra/security/JwtVerifier.hpp
// ────────────────────────────────────────────────────────────────────────────────
#pragma once

#include <jwt-cpp/jwt.h>
#include <stdexcept>
#include <string>

namespace pf::infra::security
{
    class JwtVerifier
    {
    public:
        explicit JwtVerifier(std::string_view publicKeyPem)
            : verifier_(jwt::verify()
                            .allow_algorithm(jwt::algorithm::rs256{ "", std::string{publicKeyPem}, "", "" })
                            .with_issuer("paletteflux"))
        {}

        void verify(const std::string& token) const
        {
            const auto decoded = jwt::decode(token);
            try
            {
                verifier_.verify(decoded);
            }
            catch (const std::exception& ex)
            {
                throw std::runtime_error{ std::string{ "JWT verification failed: " } + ex.what() };
            }
        }

    private:
        jwt::verifier<jwt::default_clock, jwt::picojson_traits> verifier_;
    };
} // namespace pf::infra::security
```

---

## 7. Build & Deployment Notes

* CMake (>=3.26) orchestrates monorepo-wide builds; external deps are fetched using [CPM.cmake](https://github.com/cpm-cmake/CPM.cmake).  
* Docker images include multi-stage builds for slim, musl-linked binaries.  
* GitHub Actions run clang-tidy, clang-format, unit tests, and OpenAPI diff verification on every PR.

---

### Conclusion

The above C++ modules illustrate how PaletteFlux GraphQL Studio realises a clean, modular **MVC + CQRS** architecture whilst remaining practical for production deployment.  
Feel free to explore the repository for further details such as event-sourced persistence, advanced batching resolvers, and the full GraphQL schema DSL.