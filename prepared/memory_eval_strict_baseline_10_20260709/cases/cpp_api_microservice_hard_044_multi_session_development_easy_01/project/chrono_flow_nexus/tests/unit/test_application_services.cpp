```cpp
// chrono_flow_nexus/tests/unit/test_application_services.cpp
//
// Unit–tests for the application–layer services.  We rely on GoogleTest /
// GoogleMock for assertions and interaction verification.  Only the public
// service contracts are exercised—dependencies are substituted with mocks.
// ----------------------------------------------------------------------------
// NOTE:  The real production headers live under `chrono_flow_nexus/include`.
//        In the test-binary we only need the contracts, so forward declarations
//        are acceptable if the actual implementations are linked in.
//
#include <gtest/gtest.h>
#include <gmock/gmock.h>

#include <chrono>
#include <memory>
#include <unordered_map>
#include <vector>

using namespace std::chrono_literals;
using testing::_;
using testing::An;
using testing::Eq;
using testing::Invoke;
using testing::Return;

// ─────────────────────────────────────────────────────────────────────────────
// Domain primitives (abridged for test purposes)
// ─────────────────────────────────────────────────────────────────────────────
namespace chrono_flow::domain {

struct TimeEntry
{
    std::string             userId;
    std::string             taskId;
    std::chrono::system_clock::time_point start;
    std::chrono::system_clock::time_point stop;
};

struct FocusKpi
{
    std::string userId;
    std::chrono::seconds deepWorkDuration;
};

} // namespace chrono_flow::domain

// ─────────────────────────────────────────────────────────────────────────────
// Repository contracts — the real ones live in the production tree, but for
// unit-testing we only care about the interface so we can mock it.
// ─────────────────────────────────────────────────────────────────────────────
namespace chrono_flow::application {

using chrono_flow::domain::FocusKpi;
using chrono_flow::domain::TimeEntry;

class ITimeEntryRepository
{
public:
    virtual ~ITimeEntryRepository() = default;

    // Returns all time-entries for a user within the inclusive range.
    virtual std::vector<TimeEntry>
    findForUser(const std::string& userId,
                std::chrono::system_clock::time_point from,
                std::chrono::system_clock::time_point to) = 0;
};

class ICacheProvider
{
public:
    virtual ~ICacheProvider() = default;
    virtual std::optional<FocusKpi> get(const std::string& key)             = 0;
    virtual void                    put(const std::string& key,
                                         const FocusKpi&   value,
                                         std::chrono::seconds ttl)          = 0;
};

// Simplified application-service under test. In production this lives within
//   `application/time_tracking_service.hpp/.cpp`.
class TimeTrackingService
{
public:
    TimeTrackingService(std::shared_ptr<ITimeEntryRepository> repo,
                        std::shared_ptr<ICacheProvider>       cache)
        : repo_{std::move(repo)}
        , cache_{std::move(cache)}
    {}

    // Calculates deep-work KPI for a specific calendar day.  A session counts
    // as “deep work” only if it is > 25 minutes (Pomodoro threshold).
    FocusKpi calculateDailyFocus(
        const std::string& userId,
        std::chrono::system_clock::time_point dayStart) const
    {
        const auto cacheKey =
            userId + ":" +
            std::to_string(
                std::chrono::duration_cast<std::chrono::seconds>(
                    dayStart.time_since_epoch())
                    .count());

        // Fast path: in-memory cache hit.
        if (auto cached = cache_->get(cacheKey); cached.has_value())
        {
            return *cached;
        }

        auto dayEnd = dayStart + 24h - 1s;

        auto entries = repo_->findForUser(userId, dayStart, dayEnd);

        std::chrono::seconds deepWorkTotal{0};

        for (const auto& e : entries)
        {
            auto duration =
                std::chrono::duration_cast<std::chrono::seconds>(e.stop -
                                                                 e.start);

            if (duration >= std::chrono::minutes{25})
            {
                deepWorkTotal += duration;
            }
        }

        FocusKpi kpi{userId, deepWorkTotal};

        cache_->put(cacheKey, kpi, 15min);
        return kpi;
    }

private:
    std::shared_ptr<ITimeEntryRepository> repo_;
    std::shared_ptr<ICacheProvider>       cache_;
};

} // namespace chrono_flow::application

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────
namespace chrono_flow::tests {

class MockTimeEntryRepository final
    : public chrono_flow::application::ITimeEntryRepository
{
public:
    MOCK_METHOD(std::vector<chrono_flow::domain::TimeEntry>,
                findForUser,
                (const std::string&,
                 std::chrono::system_clock::time_point,
                 std::chrono::system_clock::time_point),
                (override));
};

class MockCacheProvider final : public chrono_flow::application::ICacheProvider
{
public:
    MOCK_METHOD(std::optional<chrono_flow::domain::FocusKpi>,
                get,
                (const std::string&),
                (override));

    MOCK_METHOD(void,
                put,
                (const std::string&,
                 const chrono_flow::domain::FocusKpi&,
                 std::chrono::seconds),
                (override));
};

} // namespace chrono_flow::tests

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────
namespace /* anon */ {

using chrono_flow::domain::TimeEntry;

auto make_time(std::chrono::sys_days day,
               std::chrono::seconds   offset) // offset into day
    -> std::chrono::system_clock::time_point
{
    return std::chrono::system_clock::time_point{day.time_since_epoch()} +
           offset;
}

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────────────────
namespace {

using chrono_flow::application::TimeTrackingService;
using chrono_flow::tests::MockCacheProvider;
using chrono_flow::tests::MockTimeEntryRepository;
using chrono_flow::domain::FocusKpi;

class TimeTrackingServiceTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        repo_  = std::make_shared<MockTimeEntryRepository>();
        cache_ = std::make_shared<MockCacheProvider>();
        svc_   = std::make_unique<TimeTrackingService>(repo_, cache_);
    }

    // Test fixtures
    std::shared_ptr<MockTimeEntryRepository> repo_;
    std::shared_ptr<MockCacheProvider>       cache_;
    std::unique_ptr<TimeTrackingService>     svc_;
};

TEST_F(TimeTrackingServiceTest, CalculatesDeepWorkCorrectlyAndCachesResult)
{
    using namespace std::chrono;

    // Given
    const std::string userId = "user-42";
    const sys_days     day   = 2024y / April / 5d;

    const auto session1Start = make_time(day,  8h + 0min);
    const auto session1Stop  = make_time(day,  8h + 50min); // 50m

    const auto session2Start = make_time(day, 13h + 30min);
    const auto session2Stop  = make_time(day, 13h + 45min); // 15m (should be ignored)

    const auto session3Start = make_time(day, 23h + 0min);
    const auto session3Stop  = make_time(day, 23h + 35min); // 35m

    std::vector<TimeEntry> mockData{
        {userId, "task-a", session1Start, session1Stop},
        {userId, "task-b", session2Start, session2Stop},
        {userId, "task-c", session3Start, session3Stop},
    };

    // Expect repo fetch exactly once and return the mockData vector.
    EXPECT_CALL(*repo_,
                findForUser(Eq(userId),
                            make_time(day, 0s),
                            make_time(day, 24h - 1s)))
        .Times(1)
        .WillOnce(Return(mockData));

    // Expect cache miss first, then the calculated value is stored.
    EXPECT_CALL(*cache_, get(_)).Times(1).WillOnce(Return(std::nullopt));
    EXPECT_CALL(*cache_, put(_, An<const FocusKpi&>(), 15min)).Times(1);

    // When
    FocusKpi kpi =
        svc_->calculateDailyFocus(userId, make_time(day, 0s));

    // Then
    // Deep-work sessions: session1 (50m) + session3 (35m) = 85m = 5100s
    EXPECT_EQ(kpi.userId, userId);
    EXPECT_EQ(kpi.deepWorkDuration, seconds{5100});
}

TEST_F(TimeTrackingServiceTest, RetrievesFromCacheAndSkipsRepository)
{
    using namespace std::chrono;

    const std::string userId = "user-cached";
    const sys_days     day   = 2024y / May / 12d;

    FocusKpi cachedValue{userId, seconds{3600}};

    // Expect cache hit.
    EXPECT_CALL(*cache_, get(_)).Times(1).WillOnce(Return(cachedValue));

    // Repository must never be touched on cache hit.
    EXPECT_CALL(*repo_, findForUser(_, _, _)).Times(0);

    // cache_.put is also not expected.
    EXPECT_CALL(*cache_, put(_, _, _)).Times(0);

    FocusKpi kpi =
        svc_->calculateDailyFocus(userId, make_time(day, 0s));

    EXPECT_EQ(kpi.deepWorkDuration, seconds{3600});
}

TEST_F(TimeTrackingServiceTest, HandlesEmptyResultGracefully)
{
    using namespace std::chrono;

    const std::string userId = "user-empty";
    const sys_days     day   = 2024y / June / 1d;

    EXPECT_CALL(*repo_, findForUser(_, _, _))
        .Times(1)
        .WillOnce(Return(std::vector<TimeEntry>{}));

    EXPECT_CALL(*cache_, get(_)).Times(1).WillOnce(Return(std::nullopt));
    EXPECT_CALL(*cache_, put(_, An<const FocusKpi&>(), 15min))
        .Times(1)
        .WillOnce(Invoke([](auto&&, const FocusKpi& kpi, auto)
                         {
                             // We expect zero deep-work seconds.
                             EXPECT_EQ(kpi.deepWorkDuration,
                                       std::chrono::seconds{0});
                         }));

    FocusKpi kpi =
        svc_->calculateDailyFocus(userId, make_time(day, 0s));

    EXPECT_EQ(kpi.deepWorkDuration, seconds{0});
}

} // namespace
```