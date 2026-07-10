#include "core/persistence/SceneRepository.h"

#include <chrono>
#include <shared_mutex>
#include <spdlog/spdlog.h>

#include "core/db/ConnectionPool.h"
#include "core/domain/Scene.h"
#include "core/errors/RepositoryError.h"
#include "core/utils/SqlUtils.h"

using namespace paletteflux;
using namespace paletteflux::core;
using namespace paletteflux::core::persistence;
using namespace paletteflux::core::domain;
using namespace std::chrono_literals;

namespace
{
    // Helper ------------------------------------------------------------------
    template <typename Fn>
    void executeSafely(Fn &&fn, const std::string &context)
    {
        try
        {
            fn();
        }
        catch (const std::exception &ex)
        {
            spdlog::error("SceneRepository error ({}): {}", context, ex.what());
            throw errors::RepositoryError{
                fmt::format("SceneRepository [{}] failed: {}", context, ex.what())};
        }
    }

    struct SceneRow
    {
        uuid::uuid        id;
        std::string       name;
        std::string       description;
        nlohmann::json    metadata;
        std::string       createdAt;
        std::string       updatedAt;
    };

    Scene toDomain(const SceneRow &row)
    {
        Scene scene;
        scene.id          = row.id;
        scene.name        = row.name;
        scene.description = row.description;
        scene.metadata    = row.metadata;
        scene.createdAt   = row.createdAt;
        scene.updatedAt   = row.updatedAt;
        return scene;
    }

    SceneRow toRow(const Scene &scene)
    {
        return SceneRow{
            scene.id,
            scene.name,
            scene.description,
            scene.metadata,
            scene.createdAt,
            scene.updatedAt};
    }
} // namespace

// -----------------------------------------------------------------------------
// ctor / dtor
// -----------------------------------------------------------------------------
SceneRepository::SceneRepository(db::ConnectionPool &pool,
                                 std::chrono::seconds              cacheTtl /* = 30s*/)
    : _pool{pool},
      _cacheTtl{cacheTtl}
{
    spdlog::info("SceneRepository initialised (cache TTL = {}s)", cacheTtl.count());
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
std::optional<Scene> SceneRepository::findById(const uuid::uuid &id)
{
    // 1. Try cache first -------------------------------------------------------
    {
        std::shared_lock lock{_cacheMtx};
        const auto it = _cache.find(id);
        if (it != _cache.end() && !isExpired(it->second))
        {
            spdlog::trace("SceneRepository cache hit for id {}", uuid::to_string(id));
            return it->second.scene;
        }
    }

    // 2. Hit the database ------------------------------------------------------
    auto conn = _pool.acquire();
    const std::string sql = R"(
        SELECT id, name, description, metadata, created_at, updated_at
        FROM   scenes
        WHERE  id = :id
        LIMIT  1;
    )";

    std::optional<Scene> result;
    executeSafely(
        [&]
        {
            auto stmt = conn->createStatement(sql);
            stmt.bind(":id", uuid::to_string(id));
            if (stmt.executeStep())
            {
                SceneRow row{
                    uuid::from_string(stmt.column_text(0)),
                    stmt.column_text(1),
                    stmt.column_text(2),
                    nlohmann::json::parse(stmt.column_text(3)),
                    stmt.column_text(4),
                    stmt.column_text(5)};

                result = toDomain(row);
            }
        },
        "findById");

    // 3. Cache it --------------------------------------------------------------
    if (result)
    {
        std::unique_lock lock{_cacheMtx};
        _cache.emplace(id, CacheEntry{*result, Clock::now()});
    }

    return result;
}

std::vector<Scene> SceneRepository::findAll(int limit, int offset)
{
    std::vector<Scene> scenes;
    auto               conn = _pool.acquire();

    const std::string sql = R"(
        SELECT id, name, description, metadata, created_at, updated_at
        FROM   scenes
        ORDER BY created_at DESC
        LIMIT  :limit
        OFFSET :offset;
    )";

    executeSafely(
        [&]
        {
            auto stmt = conn->createStatement(sql);
            stmt.bind(":limit", limit);
            stmt.bind(":offset", offset);

            while (stmt.executeStep())
            {
                SceneRow row{
                    uuid::from_string(stmt.column_text(0)),
                    stmt.column_text(1),
                    stmt.column_text(2),
                    nlohmann::json::parse(stmt.column_text(3)),
                    stmt.column_text(4),
                    stmt.column_text(5)};

                scenes.emplace_back(toDomain(row));
            }
        },
        "findAll");

    // update cache
    {
        std::unique_lock lock{_cacheMtx};
        for (auto &s : scenes)
        {
            _cache.insert_or_assign(s.id, CacheEntry{s, Clock::now()});
        }
    }

    return scenes;
}

void SceneRepository::save(const Scene &scene)
{
    const bool isUpdate = exists(scene.id);
    auto       conn     = _pool.acquire();

    const std::string sqlInsert = R"(
        INSERT INTO scenes
              (id, name, description, metadata, created_at, updated_at)
        VALUES (:id, :name, :description, :metadata, :created_at, :updated_at)
    )";

    const std::string sqlUpdate = R"(
        UPDATE scenes SET
              name        = :name,
              description = :description,
              metadata    = :metadata,
              updated_at  = :updated_at
        WHERE id = :id
    )";

    executeSafely(
        [&]
        {
            const auto &sql = isUpdate ? sqlUpdate : sqlInsert;
            auto        stmt = conn->createStatement(sql);

            // common bindings
            stmt.bind(":id", uuid::to_string(scene.id));
            stmt.bind(":name", scene.name);
            stmt.bind(":description", scene.description);
            stmt.bind(":metadata", scene.metadata.dump());

            if (isUpdate)
            {
                stmt.bind(":updated_at", scene.updatedAt);
            }
            else
            {
                stmt.bind(":created_at", scene.createdAt);
                stmt.bind(":updated_at", scene.updatedAt);
            }

            stmt.execute();
        },
        "save");

    // Cache -------------------------------------------------------------------
    {
        std::unique_lock lock{_cacheMtx};
        _cache.insert_or_assign(scene.id, CacheEntry{scene, Clock::now()});
    }
}

void SceneRepository::remove(const uuid::uuid &id)
{
    auto conn = _pool.acquire();

    const std::string sql = R"(
        DELETE FROM scenes WHERE id = :id;
    )";

    executeSafely(
        [&]
        {
            auto stmt = conn->createStatement(sql);
            stmt.bind(":id", uuid::to_string(id));
            stmt.execute();
        },
        "remove");

    // Evict cache
    {
        std::unique_lock lock{_cacheMtx};
        _cache.erase(id);
    }
}

bool SceneRepository::exists(const uuid::uuid &id) const
{
    auto conn = _pool.acquire();

    const std::string sql = R"(
        SELECT 1 FROM scenes WHERE id = :id LIMIT 1;
    )";

    bool found = false;
    executeSafely(
        [&]
        {
            auto stmt = conn->createStatement(sql);
            stmt.bind(":id", uuid::to_string(id));
            found = stmt.executeStep();
        },
        "exists");

    return found;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------
bool SceneRepository::isExpired(const CacheEntry &entry) const
{
    return (Clock::now() - entry.inserted) > _cacheTtl;
}

void SceneRepository::sweepCache()
{
    std::unique_lock lock{_cacheMtx};
    for (auto it = _cache.begin(); it != _cache.end();)
    {
        if (isExpired(it->second))
        {
            it = _cache.erase(it);
        }
        else
        {
            ++it;
        }
    }
}

// -----------------------------------------------------------------------------
// Maintenance (called from timer or background thread)
// -----------------------------------------------------------------------------
void SceneRepository::performMaintenance()
{
    sweepCache();
}