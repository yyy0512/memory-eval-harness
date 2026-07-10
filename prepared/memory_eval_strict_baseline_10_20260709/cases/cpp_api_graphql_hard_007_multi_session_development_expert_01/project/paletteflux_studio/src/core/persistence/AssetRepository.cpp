```cpp
//
// PaletteFlux GraphQL Studio
// AssetRepository.cpp
//
// Copyright (c) 2024
// SPDX-License-Identifier: MIT
//
//  This repository encapsulates all persistence-related concerns for the
//  Asset aggregate root.  It is responsible for translating between the
//  relational storage schema and the in-memory domain model, mediating
//  concurrency, caching hot objects, and surfacing domain-level exceptions
//  to callers in the service layer.
//

#include "core/persistence/AssetRepository.hpp"

#include "core/common/logging/Logger.hpp"
#include "core/common/pagination/PaginatedResult.hpp"
#include "core/common/pagination/Pagination.hpp"
#include "core/common/time/Clock.hpp"
#include "core/domain/Asset.hpp"
#include "core/domain/AssetId.hpp"
#include "core/domain/AssetQueryFilter.hpp"
#include "core/persistence/DatabaseSessionPool.hpp"

#include <soci/soci.h>            // RDBMS abstraction
#include <soci/postgresql/soci-postgresql.h>
#include <fmt/format.h>           // Used by logger
#include <chrono>
#include <shared_mutex>
#include <sstream>
#include <unordered_map>

using namespace paletteflux::core;

namespace /* anonymous */ {

    /// Row-to-domain mapper helper.
    ///
    /// Decodes the result of the SQL projection into an Asset aggregate.
    ///
    /// NOTE: We purposefully keep the mapping free-function private to this TU
    ///       so that it does not bleed into other translation units.
    ///
    inline domain::Asset mapRowToAsset(const soci::row& r)
    {
        const auto id                 = domain::AssetId{ r.get<std::string>(0) };
        const auto type               = r.get<std::string>(1);
        const auto payload            = r.get<std::string>(2);
        const auto revision           = r.get<int>(3);
        const auto createdAtTm        = r.get<std::tm>(4);
        const auto updatedAtTm        = r.get<std::tm>(5);

        const auto toSysTime = [](const std::tm& tm) {
            return std::chrono::system_clock::from_time_t(std::mktime(const_cast<std::tm*>(&tm)));
        };

        return domain::Asset{
            id,
            type,
            payload,
            revision,
            toSysTime(createdAtTm),
            toSysTime(updatedAtTm)
        };
    }

    /// Encodes a date-time into the format accepted by most SQL engines.
    inline std::tm toSqlTime(const std::chrono::system_clock::time_point& tp)
    {
        const auto timeT = std::chrono::system_clock::to_time_t(tp);
#if defined(_WIN32)
        std::tm tm {};
        ::gmtime_s(&tm, &timeT);
#else
        std::tm tm {};
        ::gmtime_r(&timeT, &tm);
#endif
        return tm;
    }

} // namespace .....................................................................

namespace persistence {

    // ---------------------------------------------------------------------------------------------
    // Construction / Destruction
    // ---------------------------------------------------------------------------------------------

    AssetRepository::AssetRepository(
            std::shared_ptr<DatabaseSessionPool> pool,
            std::shared_ptr<util::Clock>         clock,
            std::chrono::seconds                 ttl)
        : m_pool{ std::move(pool) }
        , m_clock{ std::move(clock) }
        , m_cacheTtl{ ttl }
    {
        if (!m_pool)  { throw std::invalid_argument{ "DatabaseSessionPool cannot be null" }; }
        if (!m_clock) { throw std::invalid_argument{ "Clock cannot be null"               }; }
    }

    AssetRepository::~AssetRepository() = default;

    // ---------------------------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------------------------

    std::optional<domain::Asset> AssetRepository::findById(const domain::AssetId& id)
    {
        // 1. Hot-object memory cache.
        {
            std::shared_lock lock{ m_cacheMx };
            auto it = m_cache.find(id.value());
            if (it != m_cache.end() &&
                it->second.expiresAt > std::chrono::steady_clock::now())
            {
                return it->second.asset;
            }
        }

        // 2. Fall back to the database.
        try
        {
            soci::session session{ m_pool->acquire() };

            soci::row row;
            session
                << R"(SELECT
                           id,
                           type,
                           payload,
                           revision,
                           created_at,
                           updated_at
                       FROM   assets
                       WHERE  id = :id
                       AND    deleted = FALSE)",
                   soci::into(row),
                   soci::use(id.value(), "id");

            if (!session.got_data())
            {
                return std::nullopt;
            }

            auto asset = mapRowToAsset(row);

            // 3. Populate the cache with a fresh copy.
            {
                std::unique_lock lock{ m_cacheMx };
                m_cache.emplace(
                    id.value(),
                    CacheEntry{ asset, std::chrono::steady_clock::now() + m_cacheTtl }
                );
            }
            return asset;
        }
        catch (const std::exception& ex)
        {
            logger::error(fmt::format("AssetRepository::findById({}) failed: {}",
                                      id.value(), ex.what()));
            throw; // Let higher levels translate into domain-specific error
        }
    }

    PaginatedResult<domain::Asset>
    AssetRepository::list(const Pagination& page, const domain::AssetQueryFilter& filter)
    {
        try
        {
            soci::session session{ m_pool->acquire() };

            // -- Build dynamic query ----------------------------------------------------------------
            std::stringstream sql;
            sql << R"(SELECT
                           id,
                           type,
                           payload,
                           revision,
                           created_at,
                           updated_at
                       FROM   assets
                       WHERE  deleted = FALSE)";

            if (filter.type.has_value())          { sql << " AND type       = :type";          }
            if (filter.minimumRevision.has_value()){ sql << " AND revision  >= :minRevision";  }

            sql << " ORDER BY created_at DESC"
                << " LIMIT  :limit"
                << " OFFSET :offset";

            soci::statement stmt{ session.prepare << sql.str() };

            // Prepare bind variables in stable order
            if (filter.type.has_value())           stmt.exchange(soci::use(*filter.type, "type"));
            if (filter.minimumRevision.has_value())stmt.exchange(soci::use(*filter.minimumRevision, "minRevision"));
            stmt.exchange(soci::use(page.limit(),  "limit"));
            stmt.exchange(soci::use(page.offset(), "offset"));

            stmt.define_and_bind();
            stmt.execute();

            std::vector<domain::Asset> assets;
            soci::row row;
            while (stmt.fetch())
            {
                row = stmt.get_row(0);
                assets.emplace_back(mapRowToAsset(row));
            }

            // -- Retrieve  filtered total for pagination ---------------------------------------------
            long total = 0;
            {
                std::stringstream countSql;
                countSql << "SELECT COUNT(*) FROM assets WHERE deleted = FALSE";
                if (filter.type.has_value())            { countSql << " AND type      = :type"; }
                if (filter.minimumRevision.has_value()) { countSql << " AND revision >= :min"; }

                soci::statement countStmt{ session.prepare << countSql.str(), soci::into(total) };
                if (filter.type.has_value())            countStmt.exchange(soci::use(*filter.type, "type"));
                if (filter.minimumRevision.has_value()) countStmt.exchange(soci::use(*filter.minimumRevision, "min"));

                countStmt.define_and_bind();
                countStmt.execute(true /* fetch first row immediately */);
            }

            return PaginatedResult<domain::Asset>{ std::move(assets), total, page };
        }
        catch (const std::exception& ex)
        {
            logger::error(fmt::format("AssetRepository::list failed: {}", ex.what()));
            throw;
        }
    }

    void AssetRepository::save(domain::Asset& asset)
    {
        try
        {
            soci::session session{ m_pool->acquire() };
            soci::transaction tx{ session };   // RAII transaction for strong exception guarantee

            const auto now = toSqlTime(m_clock->now());

            // -- Attempt optimistic UPDATE ----------------------------------------------------------
            int rowsAffected = 0;
            session
                << R"(UPDATE  assets
                     SET     type       = :type,
                             payload    = :payload,
                             revision   = revision + 1,
                             updated_at = :updated
                     WHERE   id      = :id
                     AND     deleted = FALSE)",
                   soci::use(asset.type(),         "type"),
                   soci::use(asset.serializedPayload(), "payload"),
                   soci::use(now,                  "updated"),
                   soci::use(asset.id().value(),   "id"),
                   soci::into(rowsAffected);

            if (rowsAffected == 0)
            {
                // -- Fallback to INSERT -------------------------------------------------------------
                session
                    << R"(INSERT INTO assets(
                                id,
                                type,
                                payload,
                                revision,
                                created_at,
                                updated_at,
                                deleted
                            ) VALUES (
                                :id,
                                :type,
                                :payload,
                                1,
                                :created,
                                :updated,
                                FALSE))",
                       soci::use(asset.id().value(), "id"),
                       soci::use(asset.type(),        "type"),
                       soci::use(asset.serializedPayload(), "payload"),
                       soci::use(now, "created"),
                       soci::use(now, "updated");
            }

            tx.commit();

            // Bump in-memory revision & updatedAt so callers immediately observe consistency.
            asset.bumpRevision();
            asset.markUpdated(m_clock->now());

            // Invalidate cache (we cannot trust TTL after mutating data).
            {
                std::unique_lock lock{ m_cacheMx };
                m_cache.erase(asset.id().value());
            }
        }
        catch (const std::exception& ex)
        {
            logger::error(fmt::format("AssetRepository::save({}) failed: {}",
                                      asset.id().value(), ex.what()));
            throw;
        }
    }

    void AssetRepository::remove(const domain::AssetId& id)
    {
        try
        {
            soci::session session{ m_pool->acquire() };
            session
                << R"(UPDATE assets
                       SET    deleted    = TRUE,
                              updated_at = :updated
                       WHERE  id = :id
                       AND    deleted = FALSE)",
                   soci::use(toSqlTime(m_clock->now()), "updated"),
                   soci::use(id.value(),                "id");

            // Remove from cache regardless of affected row count (idempotent).
            {
                std::unique_lock lock{ m_cacheMx };
                m_cache.erase(id.value());
            }
        }
        catch (const std::exception& ex)
        {
            logger::error(fmt::format("AssetRepository::remove({}) failed: {}",
                                      id.value(), ex.what()));
            throw;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------------------------

    void AssetRepository::purgeExpiredCacheEntries()
    {
        const auto now = std::chrono::steady_clock::now();
        std::unique_lock lock{ m_cacheMx };
        for (auto it = m_cache.begin(); it != m_cache.end(); )
        {
            if (it->second.expiresAt <= now) { it = m_cache.erase(it); }
            else                             { ++it; }
        }
    }

} // namespace persistence
```