```cpp
/**
 * ChronoFlow Nexus – Initial Schema Migration
 * -------------------------------------------
 * This executable applies the very first schema migration to a target
 * PostgreSQL database.  It is intended to run in CI/CD pipelines or
 * be invoked manually by operators during the bootstrap phase of an
 * environment.
 *
 * Compile (example):
 *   g++ -std=c++20 -Wall -Wextra -pedantic \
 *       -I/usr/include/postgresql -lpq \
 *       -o chrono_migrate_001 InitialSchemaMigration.cpp
 *
 * Usage:
 *   ./chrono_migrate_001 --conn "postgres://user:pass@host:5432/chronoflow"
 *
 * Exit codes:
 *   0  Migration executed (or already applied)
 *   1  Command-line / configuration error
 *   2  Database connection error
 *   3  Migration failure (statements rolled back)
 */

#include <libpq-fe.h>

#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

/* ------------------------------------------------------------
 *  Utility – Small RAII wrappers
 * ---------------------------------------------------------- */

namespace util
{
    // Simple ISO-8601 UTC timestamp for logging.
    std::string iso_now_utc()
    {
        std::time_t now = std::time(nullptr);
        std::tm tm_utc{};
#if defined(_WIN32)
        gmtime_s(&tm_utc, &now);
#else
        gmtime_r(&now, &tm_utc);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm_utc, "%FT%TZ");
        return oss.str();
    }

    void log_info(const std::string& msg)
    {
        std::cerr << "[" << iso_now_utc() << "] [INFO]  " << msg << '\n';
    }

    void log_error(const std::string& msg)
    {
        std::cerr << "[" << iso_now_utc() << "] [ERROR] " << msg << '\n';
    }

    // RAII wrapper around PGconn.
    class PgConnection
    {
    public:
        explicit PgConnection(const std::string& conninfo)
        {
            conn_ = PQconnectdb(conninfo.c_str());
            if (PQstatus(conn_) != CONNECTION_OK)
            {
                std::string err = PQerrorMessage(conn_);
                PQfinish(conn_);
                throw std::runtime_error("Failed to connect: " + err);
            }
        }

        ~PgConnection() noexcept { PQfinish(conn_); }

        PGconn* get() noexcept { return conn_; }
        const PGconn* get() const noexcept { return conn_; }

        // Disallow copying.
        PgConnection(const PgConnection&)            = delete;
        PgConnection& operator=(const PgConnection&) = delete;

        // Allow moving.
        PgConnection(PgConnection&& other) noexcept : conn_(other.conn_)
        {
            other.conn_ = nullptr;
        }
        PgConnection& operator=(PgConnection&& other) noexcept
        {
            std::swap(conn_, other.conn_);
            return *this;
        }

    private:
        PGconn* conn_{nullptr};
    };

    // RAII wrapper around PGresult.
    struct PgResult
    {
        explicit PgResult(PGresult* res = nullptr) : res_(res) {}
        ~PgResult() noexcept { PQclear(res_); }
        PGresult* get() noexcept { return res_; }

        // Non-copyable.
        PgResult(const PgResult&)            = delete;
        PgResult& operator=(const PgResult&) = delete;

        // Movable.
        PgResult(PgResult&& other) noexcept : res_(other.res_) { other.res_ = nullptr; }
        PgResult& operator=(PgResult&& other) noexcept
        {
            std::swap(res_, other.res_);
            return *this;
        }

    private:
        PGresult* res_{nullptr};
    };
} // namespace util

/* ------------------------------------------------------------
 *  Migration
 * ---------------------------------------------------------- */

class InitialSchemaMigration
{
public:
    static constexpr std::string_view kVersion = "001_initial_schema";

    explicit InitialSchemaMigration(PGconn* conn) : conn_(conn) {}

    // Returns true if the migration had to be applied, false if it
    // was already present.
    bool apply()
    {
        if (already_applied())
        {
            util::log_info("Migration " + std::string(kVersion) + " already applied – skipping.");
            return false;
        }

        util::log_info("Applying migration " + std::string(kVersion) + "…");

        // Start transaction.
        exec("BEGIN");

        // Guard rollback on failure.
        try
        {
            for (const auto& stmt : ddl_statements())
            {
                exec(stmt);
            }

            record_migration();
            exec("COMMIT");

            util::log_info("Migration " + std::string(kVersion) + " applied successfully.");
            return true;
        }
        catch (...)
        {
            util::log_error("Migration failed – rolling back.");
            exec("ROLLBACK");
            throw; // Re-throw to let caller handle exit code.
        }
    }

private:
    PGconn* conn_;

    void exec(const std::string& sql)
    {
        util::PgResult res(PQexec(conn_, sql.c_str()));
        if (PQresultStatus(res.get()) != PGRES_COMMAND_OK &&
            PQresultStatus(res.get()) != PGRES_TUPLES_OK)
        {
            throw std::runtime_error(std::string("SQL error: ") + PQerrorMessage(conn_) +
                                     " – While executing: " + sql);
        }
    }

    bool already_applied()
    {
        exec("CREATE TABLE IF NOT EXISTS schema_migrations ( "
             "    version      text primary key, "
             "    applied_at   timestamp with time zone not null default CURRENT_TIMESTAMP "
             ")");
        util::PgResult res(PQexec(conn_,
                                  ("SELECT 1 FROM schema_migrations WHERE version = '" +
                                   std::string(kVersion) + "'")
                                      .c_str()));
        return PQntuples(res.get()) > 0;
    }

    void record_migration()
    {
        exec("INSERT INTO schema_migrations (version) VALUES ('" + std::string(kVersion) + "')");
    }

    static const std::vector<std::string>& ddl_statements()
    {
        // clang-format off
        static const std::vector<std::string> kStatements = {
            // Enable required extensions ----------
            "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"",
            "CREATE EXTENSION IF NOT EXISTS pgcrypto",

            // Users table --------------------------
            R"raw(
            CREATE TABLE users (
                id           uuid primary key default uuid_generate_v4(),
                full_name    text not null,
                email        text not null unique,
                avatar_url   text,
                created_at   timestamp with time zone not null default CURRENT_TIMESTAMP,
                updated_at   timestamp with time zone not null default CURRENT_TIMESTAMP
            ))raw",

            // Projects -----------------------------
            R"raw(
            CREATE TABLE projects (
                id           uuid primary key default uuid_generate_v4(),
                owner_id     uuid not null references users(id) on delete cascade,
                name         text not null,
                description  text,
                archived_at  timestamp with time zone,
                created_at   timestamp with time zone not null default CURRENT_TIMESTAMP,
                updated_at   timestamp with time zone not null default CURRENT_TIMESTAMP,
                unique(owner_id, name)
            ))raw",

            // Tasks --------------------------------
            R"raw(
            CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done', 'archived');
            )raw",

            R"raw(
            CREATE TABLE tasks (
                id            uuid primary key default uuid_generate_v4(),
                project_id    uuid not null references projects(id) on delete cascade,
                assignee_id   uuid references users(id) on delete set null,
                title         text not null,
                description   text,
                status        task_status not null default 'todo',
                priority      integer not null default 0,
                due_date      date,
                created_at    timestamp with time zone not null default CURRENT_TIMESTAMP,
                updated_at    timestamp with time zone not null default CURRENT_TIMESTAMP
            ))raw",

            // Time Entries -------------------------
            R"raw(
            CREATE TABLE time_entries (
                id            uuid primary key default uuid_generate_v4(),
                task_id       uuid not null references tasks(id) on delete cascade,
                user_id       uuid not null references users(id) on delete cascade,
                start_time    timestamp with time zone not null,
                end_time      timestamp with time zone,
                duration_sec  integer generated always as (
                                CASE
                                    WHEN end_time is null THEN null
                                    ELSE extract(epoch from (end_time - start_time))
                                END
                               ) stored,
                created_at    timestamp with time zone not null default CURRENT_TIMESTAMP
            ))raw",

            // KPI Snapshots ------------------------
            R"raw(
            CREATE TABLE kpi_snapshots (
                id                      uuid primary key default uuid_generate_v4(),
                project_id              uuid not null references projects(id) on delete cascade,
                snapshot_date           date not null,
                time_on_task_seconds    integer not null,
                context_switch_count    integer not null,
                flow_interruption_count integer not null,
                created_at              timestamp with time zone not null default CURRENT_TIMESTAMP,
                unique(project_id, snapshot_date)
            ))raw",

            // Indexes for performance --------------
            "CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status)",
            "CREATE INDEX idx_time_entries_user_time ON time_entries(user_id, start_time)",
            "CREATE INDEX idx_kpi_snapshots_project_date ON kpi_snapshots(project_id, snapshot_date)"
        };
        // clang-format on
        return kStatements;
    }
};

/* ------------------------------------------------------------
 *  CLI parsing
 * ---------------------------------------------------------- */

struct CliConfig
{
    std::string conninfo;
};

CliConfig parse_cli(int argc, char* argv[])
{
    CliConfig cfg;

    for (int i = 1; i < argc; ++i)
    {
        std::string_view arg = argv[i];
        if (arg == "--conn" && i + 1 < argc)
        {
            cfg.conninfo = argv[++i];
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "Usage: " << argv[0] << " --conn POSTGRES_CONNECTION_URL\n";
            std::exit(0);
        }
        else
        {
            util::log_error("Unknown argument: " + std::string(arg));
            std::exit(1);
        }
    }

    if (cfg.conninfo.empty())
    {
        util::log_error("--conn is required");
        std::exit(1);
    }

    return cfg;
}

/* ------------------------------------------------------------
 *  Entry point
 * ---------------------------------------------------------- */

int main(int argc, char* argv[])
{
    try
    {
        auto cfg = parse_cli(argc, argv);

        util::PgConnection conn(cfg.conninfo);

        InitialSchemaMigration migration(conn.get());
        bool applied = migration.apply();

        return applied ? 0 : 0; // success
    }
    catch (const std::runtime_error& ex)
    {
        util::log_error(ex.what());
        return 3;
    }
    catch (const std::exception& ex)
    {
        util::log_error(std::string("Unexpected error: ") + ex.what());
        return 3;
    }
}
```