```markdown
# ADR 003 – Database Schema Design

Date: 2024-06-19  
Status: Accepted  
Superseded-By: N/A  
Deciders: Core Platform Team  

## Context

PaletteFlux GraphQL Studio must persist an ever-evolving set of creative
objects (brush strokes, shader graphs, timeline clips, etc.) while exposing
strongly-typed queries through both GraphQL and curated REST snapshots.  

The data layer therefore needs to satisfy the following (sometimes competing)
requirements:

* **High write throughput** for near-realtime collaboration.
* **Flexible schema evolution** that maps cleanly into the public GraphQL
  contract (backwards compatible migrations, deprecations, version gates).
* **Transactional integrity** across cross-asset mutations (e.g.,
  `MergeLayerCommand`, `DetachAnimationCurveCommand`).
* **Efficient read projections** to support cache-friendly REST endpoints
  (denormalised tables, materialised views).
* **Polyglot persistance**: the initial MVP targets PostgreSQL 16, with
  optional off-loading of volumetric textures to S3 & Redis.  

After several spikes we have converged on the following approach:

1. **Relational core** in PostgreSQL using a *star-schema* pattern – central
   `asset` fact table linking into type-specific dimension tables
   (`brush_stroke_dim`, `shader_node_dim`, …).
2. **CQRS materialised views**: write focus remains normalised; specialised,
   read-optimised tables are refreshed asynchronously by a “view projector”
   worker service.
3. **Event-first migrations**: DDL is generated via version-controlled JSON
   events and replayed through a declarative migration runner.
4. **C++20 Data-Access Layer** wraps `libpqxx` with compile-time SQL fragments
   (see code below).  

The rest of this ADR documents the canonical DDL, C++ data-access helpers, and
migration strategy.

---

## Decision

We will:

* Maintain **single-writer** discipline via *optimistic concurrency* and row
  version columns (`xmin` in Postgres).
* Use **UUID v7 primary keys** to provide locality when sharding becomes
  necessary.
* Represent polymorphic assets in a unified `asset` table with a
  `asset_kind` enum as a type discriminator.
* Keep binary payloads (PNG, EXR, audio) out-of-band in S3; Postgres stores
  only a signed URL reference.
* Hand-roll a **lightweight domain-repository** layer in C++ (header-only
  template), using RAII to guarantee transaction rollbacks on exceptions.

---

## Consequences

* Migrating to another SQL store (e.g., CockroachDB) is less frightening
  because we own the DDL generator.
* GraphQL resolvers gain a single, consistent *view builder* API that composes
  predicate trees instead of raw SQL strings.
* Slightly higher upfront complexity in the C++ DAL, but long-term safety and
  clarity outweigh that cost.

---

## Canonical C++ Implementation

Below is an *excerpt* of the actual production code. It focuses on the
repository and schema definition for the `asset` core table and its shader
dimension. The snippets compile with **C++20** and require **libpqxx ≥ 7.x**.

### `src/db/connection_pool.hpp`

```cpp
#pragma once
/**
 * A minimal connection-pool wrapper around libpqxx with automatic recycling.
 */
#include <pqxx/pqxx>
#include <condition_variable>
#include <mutex>
#include <queue>
#include <string>
#include <string_view>
#include <memory>
#include <stdexcept>

namespace pf::db {

class ConnectionPool {
public:
    explicit ConnectionPool(std::string_view dsn,
                            std::size_t maxSize = 8)
        : _dsn{dsn}, _maxSize{maxSize}
    {
        if (maxSize == 0)
            throw std::invalid_argument("maxSize must be > 0");
    }

    // Acquire a shared_ptr that returns the connection automatically
    // when the last reference is destroyed.
    [[nodiscard]]
    std::shared_ptr<pqxx::connection> acquire()
    {
        std::unique_lock lk{_mtx};
        _cv.wait(lk, [this] { return !_pool.empty() || _inUse < _maxSize; });

        if (_pool.empty()) {
            // create new
            ++_inUse;
            return std::shared_ptr<pqxx::connection>{
                new pqxx::connection{_dsn},
                [this](pqxx::connection* c) { release(c); }
            };
        } else {
            auto conn = _pool.front();
            _pool.pop();
            return std::shared_ptr<pqxx::connection>{
                conn,
                [this](pqxx::connection* c) { release(c); }
            };
        }
    }

private:
    void release(pqxx::connection* c)
    {
        std::scoped_lock lk{_mtx};
        if (_pool.size() < _maxSize && c->is_open()) {
            _pool.push(c);
        } else {
            delete c;
            --_inUse;
        }
        _cv.notify_one();
    }

    std::string           _dsn;
    std::size_t           _maxSize;
    std::size_t           _inUse{0};
    std::mutex            _mtx;
    std::condition_variable _cv;
    std::queue<pqxx::connection*> _pool;
};

} // namespace pf::db
```

### `src/db/repository.hpp`

```cpp
#pragma once
/**
 * Generic repository base that provides exception-safe CRUD helpers.
 */
#include "connection_pool.hpp"
#include <fmt/format.h>
#include <optional>
#include <type_traits>
#include <concepts>

namespace pf::db {

class RepositoryError : public std::runtime_error {
    using std::runtime_error::runtime_error;
};

template <typename T>
concept Persistable =
    requires(T obj)
{
    { T::table_name } -> std::convertible_to<std::string_view>;
    { obj.id }        -> std::convertible_to<std::string_view>;
};

template <Persistable Model>
class Repository {
public:
    explicit Repository(ConnectionPool& pool)
        : _pool{pool} {}

    [[nodiscard]]
    std::optional<Model> findById(std::string_view id)
    {
        auto conn = _pool.acquire();
        pqxx::work txn{*conn};

        const auto query = fmt::format(
            "SELECT {} FROM {} WHERE id = $1 LIMIT 1",
            Model::columns, Model::table_name);

        auto res = txn.exec_params(query, id);
        txn.commit();

        if (res.empty())
            return std::nullopt;

        return Model::fromRow(res[0]);
    }

    void insert(const Model& m)
    {
        auto conn = _pool.acquire();
        pqxx::work txn{*conn};

        const auto query = fmt::format(
            "INSERT INTO {} ({}) VALUES ({})",
            Model::table_name, Model::columnsInsert, Model::placeholders());

        txn.exec_params(query, m.toTuple());
        txn.commit();
    }

    void upsert(const Model& m)
    {
        auto conn = _pool.acquire();
        pqxx::work txn{*conn};

        const auto query = fmt::format(
            "INSERT INTO {} ({}) VALUES ({}) "
            "ON CONFLICT(id) DO UPDATE SET {}",
            Model::table_name,
            Model::columnsInsert,
            Model::placeholders(),
            Model::updateAssignments());

        txn.exec_params(query, m.toTupleForUpsert());
        txn.commit();
    }

private:
    ConnectionPool& _pool;
};

} // namespace pf::db
```

### `src/model/asset.hpp`

```cpp
#pragma once
/**
 * Domain model representing the central `asset` table.
 */
#include <cstdint>
#include <pqxx/pqxx>
#include <string>
#include <tuple>

namespace pf::model {

enum class AssetKind : std::uint8_t {
    BrushStroke,
    ShaderNode,
    AnimationCurve,
    SoundLayer
};

struct Asset {
    std::string   id;         // UUID v7
    AssetKind     kind;
    std::string   name;
    std::string   owner_user_id;
    std::int64_t  created_at; // epoch micros
    std::int64_t  updated_at;

    // Static metadata for Repository<T>
    static constexpr std::string_view table_name      = "asset";
    static constexpr std::string_view columns         = "id, kind, name, owner_user_id, created_at, updated_at";
    static constexpr std::string_view columnsInsert   = "id, kind, name, owner_user_id, created_at, updated_at";

    static std::string placeholders(std::size_t offset = 1)
    {
        // ($1, $2, $3, ...)
        std::string p{};
        for (std::size_t i = 0; i < 6; ++i)
            p += "$" + std::to_string(offset + i) + (i < 5 ? ", " : "");
        return p;
    }

    // Parses a pqxx row into an Asset
    [[nodiscard]]
    static Asset fromRow(const pqxx::row& r)
    {
        return {
            r["id"].c_str(),
            static_cast<AssetKind>(r["kind"].as<int>()),
            r["name"].c_str(),
            r["owner_user_id"].c_str(),
            r["created_at"].as<std::int64_t>(),
            r["updated_at"].as<std::int64_t>()
        };
    }

    [[nodiscard]]
    auto toTuple() const
    {
        return std::make_tuple(id,
                               static_cast<int>(kind),
                               name,
                               owner_user_id,
                               created_at,
                               updated_at);
    }

    [[nodiscard]]
    auto toTupleForUpsert() const { return toTuple(); }

    static std::string updateAssignments()
    {
        return "kind = EXCLUDED.kind, "
               "name = EXCLUDED.name, "
               "owner_user_id = EXCLUDED.owner_user_id, "
               "created_at = EXCLUDED.created_at, "
               "updated_at = EXCLUDED.updated_at";
    }
};

} // namespace pf::model
```

### `src/model/shader_node.hpp`

```cpp
#pragma once
/**
 * Dimension table for shader-specific data.
 * Demonstrates 1-to-1 relationship to `asset` via shared PK.
 */
#include <pqxx/pqxx>
#include <string>
#include <tuple>

namespace pf::model {

struct ShaderNodeDim {
    std::string  asset_id;         // PK + FK → asset.id
    std::string  glsl_source;
    std::string  thumbnail_url;

    static constexpr std::string_view table_name    = "shader_node_dim";
    static constexpr std::string_view columns       = "asset_id, glsl_source, thumbnail_url";
    static constexpr std::string_view columnsInsert = columns;

    [[nodiscard]]
    static ShaderNodeDim fromRow(const pqxx::row& r)
    {
        return {
            r["asset_id"].c_str(),
            r["glsl_source"].c_str(),
            r["thumbnail_url"].c_str()
        };
    }

    [[nodiscard]]
    auto toTuple() const
    {
        return std::make_tuple(asset_id, glsl_source, thumbnail_url);
    }

    static std::string placeholders(std::size_t offset = 1)
    {
        return "$" + std::to_string(offset)   + ", " +
               "$" + std::to_string(offset+1) + ", " +
               "$" + std::to_string(offset+2);
    }

    static std::string updateAssignments()
    {
        return "glsl_source = EXCLUDED.glsl_source, "
               "thumbnail_url = EXCLUDED.thumbnail_url";
    }

    [[nodiscard]]
    auto toTupleForUpsert() const { return toTuple(); }
};

} // namespace pf::model
```

### Migration DDL (excerpt)

```sql
-- 20240619103042_create_asset_core.sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS asset (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
    kind          smallint NOT NULL,
    name          text      NOT NULL,
    owner_user_id uuid      NOT NULL,
    created_at    bigint    NOT NULL,
    updated_at    bigint    NOT NULL,
    CHECK (created_at <= updated_at)
);

CREATE TABLE IF NOT EXISTS shader_node_dim (
    asset_id      uuid PRIMARY KEY,
    glsl_source   text NOT NULL,
    thumbnail_url text NOT NULL,
    FOREIGN KEY(asset_id) REFERENCES asset(id) ON DELETE CASCADE
);
```

---

## Rollout Plan

1. Ship the new schema behind a feature flag (`env PF_ENABLE_STAR_SCHEMA=1`).
2. Backfill existing rows with an online job that streams from the legacy
   JSONB columns into the new dimension tables.
3. Gradually route read traffic to the DAL; monitor **slow query logs** and
   **pg_stat_statements**.
4. Once error budget < 0.1 % for 7 consecutive days, drop the legacy tables.

---

## Alternatives Considered

* **Document store (MongoDB)** – schema-less flexibility is nice, but
  transactional guarantees for cross-asset edits become painful.
* **NoSQL + GraphQL layering (e.g., AWS AppSync + DynamoDB)** – would lock
  us into a vendor and make local developer experience harder.
* **ORM (like sqlpp11, ODB)** – extra abstraction haze, compile times,
  and inevitably hand-written SQL for performance hotspots anyway.

---

*This ADR and code excerpts are part of the PaletteFlux GraphQL Studio
reference implementation released under the MIT license.*
```