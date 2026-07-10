```cpp
/***************************************************************************************************
 *  chrono_flow_nexus/src/infrastructure/persistence/postgres_repository.cpp
 *
 *  ChronoFlow Nexus – Persistence Layer
 *
 *  This compilation unit implements a thread–safe PostgreSQL connection-pool, a lightweight
 *  unit-of-work, and a concrete TimeEntry repository. The implementation relies on libpqxx for
 *  database connectivity and spdlog for structured logging.  Higher-level layers (application /
 *  domain) interact exclusively through C++ interfaces declared elsewhere in the code-base
 *  (e.g., IUnitOfWork, ITimeEntryRepository).  All PostgreSQL specifics are therefore walled-off
 *  inside the infrastructure layer, keeping the remainder of the system blissfully agnostic of
 *  the underlying persistence mechanism.
 *
 *  NOTE: This file purposefully includes implementation of auxiliary constructs such as
 *        ConnectionPool and PostgresUnitOfWork so the listing remains self-contained
 *        and immediately compilable inside the larger project.
 **************************************************************************************************/

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <pqxx/pqxx>         // libpqxx – modern C++ wrapper around libpq
#include <spdlog/spdlog.h>    // Structured, high-performance logging

// ────────────────────────────────────────────────────────────────────────────────
// Forward declarations of domain / application abstractions that live in other
// translation units.  We only need their shape – not the full definition – here.
// ────────────────────────────────────────────────────────────────────────────────
namespace chrono_flow::domain {

/* Strongly-typed UUID wrapper (implementation stored elsewhere). */
class Uuid
{
public:
    explicit Uuid(std::string val = {}) : value_(std::move(val)) {}
    inline const std::string &str() const noexcept { return value_; }
    inline bool operator==(const Uuid &rhs) const noexcept { return value_ == rhs.value_; }
    inline bool operator!=(const Uuid &rhs) const noexcept { return !(*this == rhs); }

private:
    std::string value_;
};

/* Domain entity – value object representing a single time entry. */
struct TimeEntry final
{
    Uuid              id;
    Uuid              user_id;
    Uuid              task_id;
    std::chrono::system_clock::time_point started_at;
    std::chrono::system_clock::time_point ended_at;
    std::string       notes;
    std::uint32_t     version;  // Optimistic-locking column
};

/* DTO emitted by the application layer when creating a new time entry. */
struct TimeEntryCreateRequest final
{
    Uuid                                  user_id;
    Uuid                                  task_id;
    std::chrono::system_clock::time_point started_at;
    std::optional<std::chrono::system_clock::time_point> ended_at;
    std::string                           notes;
};

} // namespace chrono_flow::domain

namespace chrono_flow::application {

struct Pagination final
{
    std::size_t limit  = 50;
    std::size_t offset = 0;
};

/* Abstractions defined in ChronoFlow Nexus public headers. */
class IUnitOfWork
{
public:
    virtual ~IUnitOfWork()                                          = default;
    virtual void commit()                                           = 0;
    virtual void rollback() noexcept                                = 0;
};

class ITimeEntryRepository
{
public:
    virtual ~ITimeEntryRepository()                    = default;
    virtual domain::TimeEntry                                       //
    create(const domain::TimeEntryCreateRequest &dto)               = 0;

    virtual std::optional<domain::TimeEntry>                        //
    find_by_id(const domain::Uuid &id)                              = 0;

    virtual std::vector<domain::TimeEntry>                          //
    list(const Pagination &pagination)                              = 0;
};

} // namespace chrono_flow::application

// ────────────────────────────────────────────────────────────────────────────────
// Infrastructure Layer
// ────────────────────────────────────────────────────────────────────────────────
namespace chrono_flow::infrastructure::persistence {

/***************************************************************************************************
 * ConnectionPool – a minimal, thread-safe PostgreSQL connection pool
 **************************************************************************************************/
class ConnectionPool final
{
public:
    /* Construct the pool with `size` ready-to-use connections. */
    ConnectionPool(std::string conninfo, std::size_t size)
        : conninfo_(std::move(conninfo))
        , capacity_(size == 0 ? 1 : size)
    {
        create_connections(capacity_);
        spdlog::info("[ConnectionPool] Initialized with capacity {}", capacity_);
    }

    /* Non-copyable / non-movable */
    ConnectionPool(const ConnectionPool &)            = delete;
    ConnectionPool &operator=(const ConnectionPool &) = delete;
    ConnectionPool(ConnectionPool &&)                 = delete;
    ConnectionPool &operator=(ConnectionPool &&)      = delete;

    ~ConnectionPool() = default;

    /* Obtain an exclusive connection handle from the pool (blocks if none free). */
    std::shared_ptr<pqxx::connection> acquire()
    {
        std::unique_lock lock(mutex_);

        cv_.wait(lock, [this] { return !connections_.empty(); });

        auto connection = connections_.front();
        connections_.pop();
        return connection;
    }

    /* Return a connection to the pool (`connection` may be nullptr). */
    void release(std::shared_ptr<pqxx::connection> connection)
    {
        if (!connection) { return; }

        {
            std::scoped_lock lock(mutex_);
            connections_.push(std::move(connection));
        }
        cv_.notify_one();
    }

    inline std::size_t capacity() const noexcept { return capacity_; }

private:
    void create_connections(std::size_t n)
    {
        for (std::size_t i = 0; i < n; ++i)
        {
            try
            {
                auto conn = std::make_shared<pqxx::connection>(conninfo_);
                if (!conn->is_open())
                {
                    throw std::runtime_error("[ConnectionPool] Unable to open PostgreSQL connection");
                }
                connections_.push(std::move(conn));
            }
            catch (const std::exception &ex)
            {
                spdlog::critical("[ConnectionPool] Failed to initialize connection: {}", ex.what());
                throw;  // Bubble up – we cannot safely continue without a functioning pool
            }
        }
    }

    const std::string conninfo_;
    const std::size_t capacity_;

    std::mutex                                             mutex_;
    std::condition_variable                                cv_;
    std::queue<std::shared_ptr<pqxx::connection>>          connections_;
};

/***************************************************************************************************
 * PostgresUnitOfWork – one database transaction scope
 *
 * Provides ACID guarantees across multiple repository calls.  Instances are intentionally *not*
 * thread-safe; they are designed to be used and destroyed in the same calling thread.
 **************************************************************************************************/
class PostgresUnitOfWork final : public application::IUnitOfWork
{
public:
    explicit PostgresUnitOfWork(ConnectionPool &pool)
        : pool_(pool)
        , connection_(pool_.acquire())
        , transaction_(std::make_unique<pqxx::work>(*connection_))
    {
        spdlog::debug("[UnitOfWork] New transaction started (conn: {})", reinterpret_cast<void *>(connection_.get()));
        prepare_statements();  // idempotent – only runs the first time per connection
    }

    ~PostgresUnitOfWork() override
    {
        /* If user code forgot to commit / rollback, roll back automatically to prevent leakage. */
        if (!transaction_->committed())
        {
            try { transaction_->abort(); }
            catch (...) { /* Avoid throwing from destructor */ }
            spdlog::warn("[UnitOfWork] Transaction aborted in destructor (implicit rollback)");
        }
        pool_.release(std::move(connection_));
    }

    PostgresUnitOfWork(const PostgresUnitOfWork &)            = delete;
    PostgresUnitOfWork &operator=(const PostgresUnitOfWork &) = delete;
    PostgresUnitOfWork(PostgresUnitOfWork &&)                 = delete;
    PostgresUnitOfWork &operator=(PostgresUnitOfWork &&)      = delete;

    /* IUnitOfWork --------------------------------------------------------------------------- */
    void commit() override
    {
        try
        {
            transaction_->commit();
            spdlog::debug("[UnitOfWork] Transaction committed");
        }
        catch (const std::exception &ex)
        {
            spdlog::error("[UnitOfWork] Commit failed: {}", ex.what());
            throw;
        }
    }

    void rollback() noexcept override
    {
        try
        {
            transaction_->abort();
            spdlog::debug("[UnitOfWork] Transaction rolled back");
        }
        catch (const std::exception &ex)
        {
            spdlog::error("[UnitOfWork] Rollback failed: {}", ex.what());
        }
    }

    /* Expose reference to the underlying pqxx::work for repository usage. */
    inline pqxx::work &transaction() noexcept { return *transaction_; }

private:
    /* Register all prepared statements this microservice uses.  This
     * function is called *once per connection*. Thanks to libpqxx it is
     * harmless to call prepare() repeatedly with the same SQL string. */
    void prepare_statements()
    {
        /* clang-format off */
        connection_->prepare("time_entry_insert",
            "INSERT INTO time_entry "
            "(id, user_id, task_id, started_at, ended_at, notes, version) "
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1) "
            "RETURNING version");

        connection_->prepare("time_entry_select_by_id",
            "SELECT id, user_id, task_id, started_at, ended_at, notes, version "
            "FROM time_entry "
            "WHERE id = $1::uuid");

        connection_->prepare("time_entry_list",
            "SELECT id, user_id, task_id, started_at, ended_at, notes, version "
            "FROM time_entry "
            "ORDER BY started_at DESC "
            "LIMIT $1 OFFSET $2");
        /* clang-format on */
    }

    ConnectionPool                            &pool_;
    std::shared_ptr<pqxx::connection>          connection_;
    std::unique_ptr<pqxx::work>                transaction_;
};

/***************************************************************************************************
 * PostgresTimeEntryRepository – concrete implementation of ITimeEntryRepository
 **************************************************************************************************/
class PostgresTimeEntryRepository final : public application::ITimeEntryRepository
{
public:
    explicit PostgresTimeEntryRepository(PostgresUnitOfWork &uow) noexcept
        : uow_(uow) {}

    /* ITimeEntryRepository ------------------------------------------------------------------- */
    domain::TimeEntry create(const domain::TimeEntryCreateRequest &dto) override
    {
        // Generate deterministic UUID inside the DB for referential integrity
        //   (ChronoFlow uses uuid-ossp v4 @ DB side, so we just ask for it.)
        pqxx::result rid = uow_.transaction().exec("SELECT uuid_generate_v4()");
        const domain::Uuid new_id{rid[0][0].c_str()};

        pqxx::result res = uow_.transaction().prepared("time_entry_insert")
                              (new_id.str())                                    // id
                              (dto.user_id.str())                               // user_id
                              (dto.task_id.str())                               // task_id
                              (dto.started_at)                                  // started_at
                              (dto.ended_at ? *dto.ended_at : pqxx::null())     // ended_at
                              (dto.notes)                                       // notes
                              .exec();

        const std::uint32_t version = res[0][0].as<std::uint32_t>();

        spdlog::info("[Repository] Added TimeEntry {} (version={})", new_id.str(), version);

        return domain::TimeEntry{
            new_id,
            dto.user_id,
            dto.task_id,
            dto.started_at,
            dto.ended_at.value_or(dto.started_at),
            dto.notes,
            version};
    }

    std::optional<domain::TimeEntry> find_by_id(const domain::Uuid &id) override
    {
        pqxx::result res = uow_.transaction().prepared("time_entry_select_by_id")(id.str()).exec();

        if (res.empty()) { return std::nullopt; }

        return hydrate_from_row(res[0]);
    }

    std::vector<domain::TimeEntry> list(const application::Pagination &pagination) override
    {
        std::vector<domain::TimeEntry> out;
        out.reserve(pagination.limit);

        pqxx::result res = uow_.transaction()
                               .prepared("time_entry_list")(pagination.limit)(pagination.offset)
                               .exec();

        for (const auto &row : res)
        {
            out.push_back(hydrate_from_row(row));
        }
        return out;
    }

private:
    static domain::TimeEntry hydrate_from_row(const pqxx::row &row)
    {
        using chrono = std::chrono;

        auto field_to_tp = [](const pqxx::field &f) {
            /* libpqxx returns timestamps as strings; we can parse them back to time_point. */
            std::tm tm = {};
            std::istringstream ss(f.c_str());
            ss >> std::get_time(&tm, "%Y-%m-%d %H:%M:%S");  // naive local time
            if (ss.fail()) { throw std::runtime_error("Failed to parse timestamp from DB"); }
            return chrono::system_clock::from_time_t(std::mktime(&tm));
        };

        domain::TimeEntry entry;
        entry.id         = domain::Uuid{row["id"].c_str()};
        entry.user_id    = domain::Uuid{row["user_id"].c_str()};
        entry.task_id    = domain::Uuid{row["task_id"].c_str()};
        entry.started_at = field_to_tp(row["started_at"]);
        entry.ended_at   = row["ended_at"].is_null() ? entry.started_at : field_to_tp(row["ended_at"]);
        entry.notes      = row["notes"].c_str() ? row["notes"].c_str() : "";
        entry.version    = row["version"].as<std::uint32_t>();
        return entry;
    }

    PostgresUnitOfWork &uow_;
};

/***************************************************************************************************
 * Factory helpers – create a repository + unit-of-work bundle
 *
 * These overloads streamline usage inside the application service handlers:
 *
 *   ConnectionPool pool(conninfo, 10);
 *   auto uow        = make_unit_of_work(pool);           // RAII transaction
 *   auto repository = make_time_entry_repo(*uow);        // concrete repository
 *
 *   auto entry = repository->create(dto);
 *   uow->commit();
 **************************************************************************************************/
[[nodiscard]] inline std::unique_ptr<PostgresUnitOfWork> //
make_unit_of_work(ConnectionPool &pool)
{
    return std::make_unique<PostgresUnitOfWork>(pool);
}

[[nodiscard]] inline std::unique_ptr<PostgresTimeEntryRepository> //
make_time_entry_repo(PostgresUnitOfWork &uow)
{
    return std::make_unique<PostgresTimeEntryRepository>(uow);
}

} // namespace chrono_flow::infrastructure::persistence
```