#pragma once

/**
 * ChronoFlow Nexus – Postgres Repository
 * --------------------------------------
 * This header provides a thin, generic repository abstraction on top of
 * libpqxx that stores domain aggregates as JSON documents in a PostgreSQL
 * table of the following (recommended) structure:
 *
 *    CREATE TABLE my_table(
 *        id      UUID  PRIMARY KEY,
 *        payload JSONB NOT NULL,
 *        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *    );
 *
 * Domain objects serialized to JSONB keep the schema versioned inside the
 * document, allowing blue-green deployments without destructive migrations.
 *
 * The repository is intentionally **header-only** to keep all template
 * definitions visible to consuming translation units.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

namespace chrono_flow_nexus::infrastructure::persistence {

/**
 * SqlError – wraps pqxx::sql_error, masking third-party details from callers.
 */
class SqlError final : public std::runtime_error {
public:
    explicit SqlError(std::string msg)
        : std::runtime_error{std::move(msg)}
    {}
};

/**
 * PagedResult – represents a slice of a full result-set together with
 * pagination metadata.
 */
template <typename T>
struct PagedResult {
    std::vector<T> items;
    std::uint64_t total{0};
    std::uint32_t page{0};
    std::uint32_t pageSize{0};
};

/**
 * PostgresRepository – a generic, lightweight repository that persists domain
 * objects as JSON documents in PostgreSQL. It is designed for high-throughput
 * scenarios: connections are re-used (via a simple shared_ptr) and every
 * call performs a single round-trip to the database.
 *
 * `Model` must:
 *   • be default constructible
 *   • support conversion to/from nlohmann::json (via external to_json/from_json
 *     or Serializer/RowMapper delegates supplied to the constructor)
 *
 * `Key` represents the identifier type (uuid, int, string, …).
 */
template <typename Model, typename Key = std::string>
class PostgresRepository
{
public:
    using RowMapper   = std::function<Model(const pqxx::row&)>;
    using Serializer  = std::function<nlohmann::json(const Model&)>;
    using Clock       = std::chrono::system_clock;

    /**
     * Create a repository bound to a concrete database table.
     *
     * @param conn           Shared connection (ideally from a pool).
     * @param tableName      Table the repository operates on.
     * @param rowMapper      Callback that builds `Model` from a pqxx::row.
     * @param keyExtractor   Extracts the id/key from a domain object.
     * @param serializer     Callback that converts `Model` to JSON.
     */
    PostgresRepository(std::shared_ptr<pqxx::connection> conn,
                       std::string                       tableName,
                       RowMapper                         rowMapper,
                       std::function<Key(const Model&)>  keyExtractor,
                       Serializer                        serializer)
        : _conn{std::move(conn)}
        , _table{std::move(tableName)}
        , _rowMapper{std::move(rowMapper)}
        , _keyExtractor{std::move(keyExtractor)}
        , _serializer{std::move(serializer)}
    {
        if (!_conn || !_conn->is_open()) {
            throw std::invalid_argument{"Postgres connection must be valid and open"};
        }
    }

    /**
     * Retrieve an entity by id.
     */
    std::optional<Model> findById(const Key& id) const
    {
        try {
            pqxx::read_transaction tx{*_conn};
            pqxx::result res = tx.exec_params(
                "SELECT payload "
                "FROM " + _table + " "
                "WHERE id = $1",
                id);

            if (res.empty()) { return std::nullopt; }

            // Build a pseudo row with the JSON payload so the mapper can
            // reconstruct the domain object. We don’t expose this hack to
            // callers – they simply provide a mapper that understands JSON.
            return _rowMapper(res[0]);
        }
        catch (const pqxx::sql_error& ex) {
            throw SqlError{ex.what()};
        }
    }

    /**
     * Retrieve a page of entities.
     */
    PagedResult<Model> findAll(std::uint32_t page, std::uint32_t pageSize) const
    {
        const std::uint32_t offset = page * pageSize;

        try {
            pqxx::read_transaction tx{*_conn};

            const pqxx::result countRes =
                tx.exec1("SELECT count(*) FROM " + _table);
            const std::uint64_t total =
                countRes[0].as<std::uint64_t>();

            pqxx::result res = tx.exec_params(
                "SELECT payload "
                "FROM " + _table + " "
                "ORDER BY created_at DESC "
                "LIMIT $1 OFFSET $2",
                pageSize,
                offset);

            std::vector<Model> list;
            list.reserve(res.size());
            for (const auto& row : res) {
                list.push_back(_rowMapper(row));
            }

            return {std::move(list), total, page, pageSize};
        }
        catch (const pqxx::sql_error& ex) {
            throw SqlError{ex.what()};
        }
    }

    /**
     * Persist a new entity and return its key (generated by the DB).
     */
    Key insert(const Model& model) const
    {
        try {
            pqxx::work tx{*_conn};

            const nlohmann::json json = _serializer(model);

            const pqxx::result res = tx.exec_params(
                "INSERT INTO " + _table + " (payload) "
                "VALUES ($1::jsonb) "
                "RETURNING id",
                json.dump());

            Key key = res[0][0].as<Key>();
            tx.commit();
            return key;
        }
        catch (const pqxx::sql_error& ex) {
            throw SqlError{ex.what()};
        }
    }

    /**
     * Update an existing entity.
     */
    void update(const Key& id, const Model& model) const
    {
        try {
            pqxx::work tx{*_conn};

            const nlohmann::json json = _serializer(model);

            const pqxx::result res = tx.exec_params(
                "UPDATE " + _table + " "
                "SET payload = $2::jsonb, updated_at = now() "
                "WHERE id = $1",
                id,
                json.dump());

            if (res.affected_rows() == 0) {
                throw SqlError{"Update failed – entity not found"};
            }

            tx.commit();
        }
        catch (const pqxx::sql_error& ex) {
            throw SqlError{ex.what()};
        }
    }

    /**
     * Remove an entity from the store.
     */
    void remove(const Key& id) const
    {
        try {
            pqxx::work tx{*_conn};

            const pqxx::result res = tx.exec_params(
                "DELETE FROM " + _table + " WHERE id = $1",
                id);

            if (res.affected_rows() == 0) {
                throw SqlError{"Delete failed – entity not found"};
            }

            tx.commit();
        }
        catch (const pqxx::sql_error& ex) {
            throw SqlError{ex.what()};
        }
    }

private:
    std::shared_ptr<pqxx::connection> _conn;
    std::string                       _table;
    RowMapper                         _rowMapper;
    std::function<Key(const Model&)>  _keyExtractor;
    Serializer                        _serializer;
};

} // namespace chrono_flow_nexus::infrastructure::persistence