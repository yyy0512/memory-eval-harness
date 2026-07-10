```cpp
// chrono_flow_nexus/tests/test_main.cpp
//
// Entry-point and core integration tests for ChronoFlow Nexus.
//
// The real project comes with a deep hierarchy of components, but for the
// purpose of regression and CI signal we keep the test-suite self-contained:
//  • Tests rely only on public headers, or, when that is not possible, on a
//    minimal façade class that mimics behaviour of production code.
//  • A custom Google-Test listener streams structured logs to spdlog so that
//    failures are traceable in standard observability tooling.
//
// To build with CMake:
//   add_executable(cf_nexus_tests test_main.cpp)
//   target_link_libraries(cf_nexus_tests PRIVATE GTest::gtest_main spdlog::spdlog)
//   gtest_discover_tests(cf_nexus_tests)
// ----------------------------------------------------------------------------

#include <gtest/gtest.h>
#include <spdlog/spdlog.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <future>
#include <list>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using namespace std::chrono_literals;

// ============================================================================
// Test Utilities
// ============================================================================

namespace test_util {

class ScopedLogLevel
{
public:
    explicit ScopedLogLevel(spdlog::level::level_enum lvl)
        : old_level_{spdlog::get_level()}
    {
        spdlog::set_level(lvl);
    }
    ScopedLogLevel(const ScopedLogLevel&)            = delete;
    ScopedLogLevel& operator=(const ScopedLogLevel&) = delete;
    ~ScopedLogLevel() { spdlog::set_level(old_level_); }

private:
    spdlog::level::level_enum old_level_;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tiny helper that waits until a condition becomes true or the timeout elapses
// (used in concurrency tests to avoid flaky behaviour).
// ─────────────────────────────────────────────────────────────────────────────
template <class Predicate>
bool wait_until(const std::chrono::steady_clock::time_point& deadline, Predicate pred)
{
    while (std::chrono::steady_clock::now() < deadline)
    {
        if (pred())
            return true;
        std::this_thread::sleep_for(1ms);
    }
    return pred();
}

} // namespace test_util

// ============================================================================
// In-Memory LRU Cache (minimal façade).
// In production this type sits in the infrastructure layer, backed by Redis or
// membrane-cache; here we provide a lightweight reference implementation so
// that domain/application-layer tests have something to rely on.
// ============================================================================

template <class Key, class Value>
class LruCache
{
public:
    explicit LruCache(std::size_t capacity) : capacity_{capacity} {}

    void put(const Key& key, const Value& value)
    {
        std::lock_guard lk{mtx_};

        // Update existing entry.
        if (auto it = map_.find(key); it != map_.end())
        {
            it->second->second = value;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }

        // Evict if necessary.
        if (list_.size() == capacity_)
        {
            map_.erase(list_.back().first);
            list_.pop_back();
        }

        list_.emplace_front(key, value);
        map_[key] = list_.begin();
    }

    std::optional<Value> get(const Key& key)
    {
        std::lock_guard lk{mtx_};
        if (auto it = map_.find(key); it != map_.end())
        {
            list_.splice(list_.begin(), list_, it->second); // refresh position
            return it->second->second;
        }
        return std::nullopt;
    }

    std::size_t size() const
    {
        std::lock_guard lk{mtx_};
        return list_.size();
    }

private:
    mutable std::mutex mtx_;
    std::size_t capacity_;
    std::list<std::pair<Key, Value>> list_;
    std::unordered_map<Key, typename std::list<std::pair<Key, Value>>::iterator> map_;
};

// ============================================================================
// Token-Bucket Rate-Limiter
// ----------------------------------------------------------------------------
//  • thread-safe
//  • time-driven token replenishment
//  • constant-time fast-path
// ============================================================================

class RateLimiter
{
public:
    RateLimiter(std::uint32_t max_tokens, std::chrono::milliseconds refill_interval)
        : capacity_{max_tokens}
        , tokens_{max_tokens}
        , refill_interval_{refill_interval}
        , last_refill_{std::chrono::steady_clock::now()}
    {}

    bool allow()
    {
        refill_if_needed();

        std::uint32_t current_tokens = tokens_.load(std::memory_order_relaxed);
        while (current_tokens > 0)
        {
            if (tokens_.compare_exchange_weak(
                    current_tokens, current_tokens - 1, std::memory_order_acq_rel))
            {
                return true;
            }
            // else: current_tokens updated by CAS
        }
        return false;
    }

    std::uint32_t remaining() const { return tokens_.load(std::memory_order_relaxed); }

private:
    void refill_if_needed()
    {
        auto now  = std::chrono::steady_clock::now();
        auto diff = now - last_refill_;

        if (diff < refill_interval_)
            return;

        if (refill_mtx_.try_lock())
        {
            // Double-checked locking to avoid duplicate refill.
            diff = std::chrono::steady_clock::now() - last_refill_;
            if (diff >= refill_interval_)
            {
                tokens_.store(capacity_, std::memory_order_release);
                last_refill_ = std::chrono::steady_clock::now();
            }
            refill_mtx_.unlock();
        }
    }

    const std::uint32_t                  capacity_;
    std::atomic<std::uint32_t>           tokens_;
    const std::chrono::milliseconds      refill_interval_;
    std::chrono::steady_clock::time_point last_refill_;
    std::mutex                            refill_mtx_;
};

// ============================================================================
// Domain: Productivity Metrics
// ----------------------------------------------------------------------------
// Computes context-switch frequency given a sequence of task events.
// ============================================================================

namespace cf::domain {

struct TaskEvent
{
    std::string            task_id;
    std::chrono::nanoseconds duration;
};

class AnalyticsCalculator
{
public:
    // context-switch frequency = number of task changes / total time (hours)
    double context_switch_frequency(const std::vector<TaskEvent>& events) const
    {
        if (events.size() <= 1)
            return 0.0;

        std::uint64_t switches = 0;
        for (std::size_t i = 1; i < events.size(); ++i)
        {
            if (events[i].task_id != events[i - 1].task_id)
                ++switches;
        }

        auto total_nanos = std::accumulate(
            events.begin(), events.end(), std::chrono::nanoseconds{0},
            [](auto acc, const auto& ev) { return acc + ev.duration; });

        if (total_nanos.count() == 0)
            return 0.0;

        double hours = static_cast<double>(total_nanos.count()) / 3.6e12; // 1h = 3.6e12ns
        return switches / hours;
    }
};

} // namespace cf::domain

// ============================================================================
// Google-Test Custom Event Listener
// ============================================================================

class SpdlogSinkListener final : public ::testing::EmptyTestEventListener
{
public:
    void OnTestStart(const ::testing::TestInfo& info) override
    {
        spdlog::info("[ RUN      ] {}.{}", info.test_case_name(), info.name());
    }

    void OnTestPartResult(const ::testing::TestPartResult& result) override
    {
        if (result.failed())
        {
            spdlog::error("{}({}): {}", result.file_name(), result.line_number(),
                          result.summary());
        }
    }

    void OnTestEnd(const ::testing::TestInfo& info) override
    {
        const char* status = info.result()->Passed() ? "OK" : "FAILED";
        spdlog::info("[ {} ] {}.{}", status, info.test_case_name(), info.name());
    }
};

// ============================================================================
// TEST-SUITE
// ============================================================================

TEST(RateLimiterTest, AllowsUpToCapacityThenBlocks)
{
    RateLimiter limiter{5, 1s};

    for (int i = 0; i < 5; ++i)
    {
        EXPECT_TRUE(limiter.allow()) << "Limiter should allow initial burst.";
    }
    EXPECT_FALSE(limiter.allow()) << "Limiter must block when capacity is exceeded.";

    // Wait for refill interval and ensure limiter resets.
    std::this_thread::sleep_for(1100ms);
    EXPECT_TRUE(limiter.allow()) << "Limiter should allow after refill.";
}

TEST(RateLimiterTest, IsThreadSafeUnderContention)
{
    RateLimiter limiter{50, 2s};
    std::atomic<int> allowed{0};

    auto hammer = [&] {
        for (int i = 0; i < 1000; ++i)
        {
            if (limiter.allow())
                ++allowed;
        }
    };

    std::vector<std::thread> threads;
    for (int i = 0; i < 8; ++i)
        threads.emplace_back(hammer);

    for (auto& t : threads)
        t.join();

    EXPECT_LE(allowed.load(), 50) << "Limiter must enforce global capacity.";
}

TEST(LruCacheTest, EvictsLeastRecentlyUsedItem)
{
    LruCache<std::string, int> cache{3};
    cache.put("A", 1);
    cache.put("B", 2);
    cache.put("C", 3);

    // Access "A" so that "B" becomes LRU
    ASSERT_TRUE(cache.get("A").has_value());

    cache.put("D", 4); // should evict "B"

    EXPECT_FALSE(cache.get("B").has_value());
    EXPECT_TRUE(cache.get("C").has_value());
    EXPECT_TRUE(cache.get("A").has_value());
    EXPECT_TRUE(cache.get("D").has_value());
    EXPECT_EQ(cache.size(), 3u);
}

TEST(AnalyticsCalculatorTest, ComputesCorrectContextSwitchFrequency)
{
    using namespace std::chrono;
    cf::domain::AnalyticsCalculator calc;

    std::vector<cf::domain::TaskEvent> events = {
        {"T1", 30min},
        {"T1", 10min},
        {"T2", 20min},
        {"T3", 60min},
        {"T3",  5min},
        {"T2", 15min},
    };

    // Switches: T1->T2, T2->T3, T3->T2 -> 3 switches
    auto total_minutes = 30 + 10 + 20 + 60 + 5 + 15; // =140min
    double expected_frequency = 3.0 / (static_cast<double>(total_minutes) / 60.0);

    double actual = calc.context_switch_frequency(events);
    EXPECT_NEAR(actual, expected_frequency, 1e-6);
}

// ============================================================================
// main()
// ============================================================================

int main(int argc, char** argv)
{
    // Fast-fail on allocation errors.
    std::set_new_handler([] {
        spdlog::critical("Out of memory – terminating test-runner.");
        std::abort();
    });

    // Init logging + gtest
    spdlog::set_pattern("[%H:%M:%S.%e] [%^%l%$] %v");
    spdlog::set_level(spdlog::level::info);

    ::testing::InitGoogleTest(&argc, argv);

    // Replace default printer with spdlog sink for better CI visibility
    auto& listeners = ::testing::UnitTest::GetInstance()->listeners();
    delete listeners.Release(listeners.default_result_printer());
    listeners.Append(new SpdlogSinkListener);

    const int ret = RUN_ALL_TESTS();
    spdlog::info("Test-run completed with exit code {}", ret);
    return ret;
}
```