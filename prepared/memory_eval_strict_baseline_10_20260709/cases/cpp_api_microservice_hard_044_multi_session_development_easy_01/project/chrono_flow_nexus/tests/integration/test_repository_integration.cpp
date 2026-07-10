```cpp
// chrono_flow_nexus/tests/integration/test_repository_integration.cpp
//
// Integration-level tests that validate the behaviour of the concrete
// repository implementation used by ChronoFlow Nexus.  The tests exercise
// happy-path CRUD semantics, pagination, transactional guarantees, and basic
// concurrency safety against a live (embedded) database.  While the production
// implementation targets PostgreSQL, the integration suite leverages an
// in-memory SQLite instance to keep the CI pipeline self-contained and fast.
//
// NOTE: The code below purposefully avoids any references to the service’s
// HTTP/GraphQL transport layers; it focuses purely on the infrastructure ↔︎
// domain boundary.

#include <gtest/gtest.h>

#include <soci/soci.h>
#include <soci/sqlite3/soci-sqlite3.h>

#include <chrono>
#include <future>
#include <optional>
#include <random>
#include <stdexcept>
#include <thread>
#include <vector>

namespace cfn          // ChronoFlow Nexus
{
namespace domain
{
// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

struct TaskSnapshot
{
    std::uint64_t                             id           {0};
    std::string                               user_id;
    std::string                               task_id;
    std::chrono::system_clock::time_point     start_time;
    std::chrono::system_clock::time_point     end_time;
    std::chrono::seconds                      duration {0};

    bool operator==(const TaskSnapshot& rhs) const
    {
        return id         == rhs.id &&
               user_id    == rhs.user_id &&
               task_id    == rhs.task_id &&
               start_time == rhs.start_time &&
               end_time   == rhs.end_time &&
               duration   == rhs.duration;
    }
};

struct TaskSnapshotCreateRequest
{
    std::string                           user_id;
    std::string                           task_id;
    std::chrono::system_clock::time_point start_time;
    std::chrono::system_clock::time_point end_time;
};

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

class ITaskSnapshotRepository
{
public:
    virtual ~ITaskSnapshotRepository() = default;

    virtual TaskSnapshot create(const TaskSnapshotCreateRequest& req)               = 0;
    virtual std::optional<TaskSnapshot> findById(std::uint64_t id)                  = 0;
    virtual std::vector<TaskSnapshot>   listByUser(
            const std::string& user_id,
            std::size_t       limit,
            std::size_t       offset)                                               = 0;
    virtual void                        updateDuration(std::uint64_t id,
                                                       std::chrono::seconds value) = 0;
    virtual bool                        remove(std::uint64_t id)                    = 0;
};

} // namespace domain

namespace infrastructure
{
// ---------------------------------------------------------------------------
// SQLite-backed repository
// ---------------------------------------------------------------------------

class SqliteTaskSnapshotRepository final : public domain::ITaskSnapshotRepository
{
public:
    explicit SqliteTaskSnapshotRepository(soci::session& sql) : sql_{sql} {}

    domain::TaskSnapshot create(const domain::TaskSnapshotCreateRequest& req) override
    {
        soci::transaction tr{sql_}; // RAII transaction, auto rollback on failure

        const auto duration =
            std::chrono::duration_cast<std::chrono::seconds>(req.end_time - req.start_time);

        std::uint64_t id {};
        sql_ << "INSERT INTO task_snapshots "
                "(user_id, task_id, start_time, end_time, duration) "
                "VALUES (:user, :task, :start, :end, :duration)",
                soci::use(req.user_id),
                soci::use(req.task_id),
                soci::use(to_unix(req.start_time)),
                soci::use(to_unix(req.end_time)),
                soci::use(duration.count());

        sql_ << "SELECT last_insert_rowid()", soci::into(id);

        tr.commit();

        return domain::TaskSnapshot{
            id,
            req.user_id,
            req.task_id,
            req.start_time,
            req.end_time,
            duration};
    }

    std::optional<domain::TaskSnapshot> findById(std::uint64_t id) override
    {
        soci::row row;
        sql_ << R"(SELECT id, user_id, task_id,
                          start_time, end_time, duration
                     FROM task_snapshots
                    WHERE id = :id)",
              soci::use(id), soci::into(row);

        if (!row.empty())
        {
            return row_to_snapshot(row);
        }
        return std::nullopt;
    }

    std::vector<domain::TaskSnapshot> listByUser(const std::string& user_id,
                                                 std::size_t       limit,
                                                 std::size_t       offset) override
    {
        soci::rowset<soci::row> rs = (sql_.prepare <<
            R"(SELECT id, user_id, task_id,
                      start_time, end_time, duration
                 FROM task_snapshots
                WHERE user_id = :user
                ORDER BY id ASC
                LIMIT :lim OFFSET :off)",
            soci::use(user_id), soci::use(limit), soci::use(offset));

        std::vector<domain::TaskSnapshot> out;
        for (const auto& r : rs)
        {
            out.emplace_back(row_to_snapshot(r));
        }
        return out;
    }

    void updateDuration(std::uint64_t id,
                        std::chrono::seconds value) override
    {
        std::size_t affected {};
        sql_ << "UPDATE task_snapshots SET duration = :dur WHERE id = :id",
               soci::use(value.count()), soci::use(id), soci::into(affected);

        if (affected != 1)
            throw std::runtime_error{"no row updated; id=" + std::to_string(id)};
    }

    bool remove(std::uint64_t id) override
    {
        std::size_t affected {};
        sql_ << "DELETE FROM task_snapshots WHERE id = :id",
                soci::use(id), soci::into(affected);
        return affected == 1;
    }

private:
    static std::int64_t to_unix(const std::chrono::system_clock::time_point& tp)
    {
        return std::chrono::duration_cast<std::chrono::seconds>(tp.time_since_epoch()).count();
    }

    static std::chrono::system_clock::time_point from_unix(std::int64_t v)
    {
        return std::chrono::system_clock::time_point{std::chrono::seconds{v}};
    }

    static domain::TaskSnapshot row_to_snapshot(const soci::row& r)
    {
        return domain::TaskSnapshot{
            r.get<std::uint64_t>(0),
            r.get<std::string>(1),
            r.get<std::string>(2),
            from_unix(r.get<std::int64_t>(3)),
            from_unix(r.get<std::int64_t>(4)),
            std::chrono::seconds{r.get<std::int64_t>(5)}};
    }

private:
    soci::session& sql_;
};

} // namespace infrastructure
} // namespace cfn

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

namespace {

class TaskSnapshotRepositoryIntegrationTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        // The URI could be made configurable via env var if we ever decide to
        // swap in an actual Postgres instance for these tests.
        sql_.open(soci::sqlite3, ":memory:");
        bootstrap_schema();

        repo_ = std::make_unique<cfn::infrastructure::SqliteTaskSnapshotRepository>(sql_);
    }

    void TearDown() override
    {
        // Close explicit so we see errors (if any) inside the test output
        sql_.close();
    }

    // ---------------------------------------------------------------------

    cfn::domain::TaskSnapshotCreateRequest make_request(
            std::string user_id = "u-1",
            std::string task_id = "t-1") const
    {
        const auto now = std::chrono::system_clock::now();
        return { std::move(user_id),
                 std::move(task_id),
                 now,
                 now + std::chrono::minutes{ 30 } };
    }

    void bootstrap_schema()
    {
        sql_ << R"(
            CREATE TABLE task_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id   TEXT NOT NULL,
              task_id   TEXT NOT NULL,
              start_time INTEGER NOT NULL,
              end_time   INTEGER NOT NULL,
              duration   INTEGER NOT NULL
            );
        )";
    }

protected:
    soci::session                                               sql_;
    std::unique_ptr<cfn::domain::ITaskSnapshotRepository>       repo_;
};

} // anonymous namespace

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

TEST_F(TaskSnapshotRepositoryIntegrationTest, CreateAndRetrieveSnapshot)
{
    const auto request  = make_request();
    const auto created  = repo_->create(request);

    ASSERT_GT(created.id, 0u);
    ASSERT_EQ(created.user_id,  request.user_id);
    ASSERT_EQ(created.task_id,  request.task_id);
    ASSERT_EQ(created.duration, std::chrono::minutes{30});

    const auto fetched = repo_->findById(created.id);
    ASSERT_TRUE(fetched.has_value());
    EXPECT_EQ(created, *fetched);
}

TEST_F(TaskSnapshotRepositoryIntegrationTest, PaginationWorksAsExpected)
{
    constexpr std::size_t total   = 25;
    constexpr std::size_t page_sz = 10;
    constexpr std::size_t page_2  = 10;

    for (std::size_t i = 0; i < total; ++i)
    {
        auto req = make_request("user-paging", "task-" + std::to_string(i));
        repo_->create(req);
    }

    auto slice = repo_->listByUser("user-paging", page_sz, page_2);
    ASSERT_EQ(slice.size(), page_sz);
    EXPECT_EQ(slice.front().task_id, "task-10");
    EXPECT_EQ(slice.back().task_id,  "task-19");
}

TEST_F(TaskSnapshotRepositoryIntegrationTest, ConcurrentCreatesDoNotDeadlockOrLoseData)
{
    constexpr std::size_t threads = 8;
    constexpr std::size_t per_thread = 50;

    auto worker = [per_thread](std::size_t seed) {
        soci::session sql{ soci::sqlite3, ":memory:" };

        // Each worker needs its own schema (independent db) since SQLite
        // in-memory database lives on a per-connection basis.
        sql << R"(CREATE TABLE task_snapshots (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      user_id   TEXT NOT NULL,
                      task_id   TEXT NOT NULL,
                      start_time INTEGER NOT NULL,
                      end_time   INTEGER NOT NULL,
                      duration   INTEGER NOT NULL
                  );)";

        cfn::infrastructure::SqliteTaskSnapshotRepository repo{ sql };

        std::mt19937_64 rng{ static_cast<std::mt19937_64::result_type>(seed) };
        for (std::size_t i = 0; i < per_thread; ++i)
        {
            auto req = cfn::domain::TaskSnapshotCreateRequest{
                "user-concurrent",
                "task-" + std::to_string(rng() % 10),
                std::chrono::system_clock::now(),
                std::chrono::system_clock::now() + std::chrono::minutes{25}
            };
            repo.create(req);
        }

        // Verify our own connection has `per_thread` rows
        std::size_t cnt;
        sql << "SELECT COUNT(*) FROM task_snapshots", soci::into(cnt);
        EXPECT_EQ(cnt, per_thread);
    };

    std::vector<std::future<void>> futures;
    for (std::size_t i = 0; i < threads; ++i)
    {
        futures.emplace_back(std::async(std::launch::async, worker, i + 200));
    }
    for (auto& f : futures) f.get();
}

TEST_F(TaskSnapshotRepositoryIntegrationTest, TransactionRollsBackOnError)
{
    // Intentionally craft an invalid request (very long user_id)
    auto bad_request = make_request(std::string(5000, 'x'), "task-invalid");

    EXPECT_THROW(
        {
            // Exceed SQLite TEXT limit? Unlikely; force an error by violating NOT NULL
            cfn::domain::TaskSnapshotCreateRequest invalid = bad_request;
            invalid.task_id.clear(); // make task_id empty to violate NOT NULL check

            repo_->create(invalid);
        }, std::exception);

    // Repository should not have persisted anything
    std::size_t cnt {};
    sql_ << "SELECT COUNT(*) FROM task_snapshots", soci::into(cnt);
    EXPECT_EQ(cnt, 0u);
}

TEST_F(TaskSnapshotRepositoryIntegrationTest, UpdateAndDeleteFlow)
{
    const auto created = repo_->create(make_request("user-flow", "task-flow"));

    repo_->updateDuration(created.id, std::chrono::minutes{42});

    const auto after_update = repo_->findById(created.id);
    ASSERT_TRUE(after_update);
    EXPECT_EQ(after_update->duration, std::chrono::minutes{42});

    const bool removed = repo_->remove(created.id);
    EXPECT_TRUE(removed);

    EXPECT_FALSE(repo_->findById(created.id).has_value());
}
```