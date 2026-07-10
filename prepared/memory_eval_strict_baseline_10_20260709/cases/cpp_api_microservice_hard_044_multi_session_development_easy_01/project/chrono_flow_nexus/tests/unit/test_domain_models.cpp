#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>
#include <unordered_map>
#include <sstream>
#include <utility>

#include <catch2/catch.hpp>
#include <nlohmann/json.hpp>

// -----------------------------------------------------------------------------
// Fallback stub domain models
//
// The real ChronoFlow Nexus code-base ships these headers.  When the unit tests
// are compiled inside the monorepo the `#include`s below will be picked up
// instead of the lightweight stubs declared further down.  This arrangement
// allows the test file to remain self-contained and still compile in open-source
// CI environments where the production sources are not available.
// -----------------------------------------------------------------------------
#if __has_include("chrono_flow_nexus/domain/TimeEntry.hpp")
    #include "chrono_flow_nexus/domain/TimeEntry.hpp"
#else
namespace chrono_flow_nexus::domain
{
    struct TimeEntry
    {
        std::string                         id;
        std::chrono::system_clock::time_point start;
        std::chrono::system_clock::time_point end;
        std::vector<std::string>            tags;

        TimeEntry() = default;

        TimeEntry(
            std::string                         id_,
            std::chrono::system_clock::time_point start_,
            std::chrono::system_clock::time_point end_,
            std::vector<std::string>            tags_ = {})
            : id{ std::move(id_) }
            , start{ start_ }
            , end{ end_ }
            , tags{ std::move(tags_) }
        {
            if (start >= end)
            {
                throw std::invalid_argument{ "start must be before end" };
            }
        }

        std::chrono::seconds duration() const
        {
            return std::chrono::duration_cast<std::chrono::seconds>(end - start);
        }

        bool operator==(const TimeEntry& other) const noexcept
        {
            return id == other.id && start == other.start && end == other.end
                && tags == other.tags;
        }
    };

    inline void to_json(nlohmann::json& j, const TimeEntry& t)
    {
        j = nlohmann::json{
            { "id",    t.id },
            { "start", std::chrono::duration_cast<std::chrono::milliseconds>(
                           t.start.time_since_epoch())
                           .count() },
            { "end", std::chrono::duration_cast<std::chrono::milliseconds>(
                         t.end.time_since_epoch())
                         .count() },
            { "tags",  t.tags }
        };
    }

    inline void from_json(const nlohmann::json& j, TimeEntry& t)
    {
        t.id = j.at("id").get<std::string>();

        const auto start_ms =
            std::chrono::milliseconds{ j.at("start").get<int64_t>() };
        const auto end_ms =
            std::chrono::milliseconds{ j.at("end").get<int64_t>() };

        t.start = std::chrono::system_clock::time_point{ start_ms };
        t.end   = std::chrono::system_clock::time_point{ end_ms };

        if (t.start >= t.end)
        {
            throw std::invalid_argument{
                "TimeEntry JSON: start must be before end"
            };
        }

        t.tags = j.at("tags").get<std::vector<std::string>>();
    }

    // A tiny analytic aggregate used by the tests
    struct WorkloadSnapshot
    {
        std::unordered_map<std::string, std::vector<TimeEntry>> bucket;

        // Inserts an entry keyed by `userId`
        void add(const std::string& userId, TimeEntry entry)
        {
            bucket[userId].push_back(std::move(entry));
        }

        // Total time (in seconds) spent by a given user
        [[nodiscard]] std::chrono::seconds totalForUser(
            const std::string& userId) const
        {
            auto it = bucket.find(userId);
            if (it == bucket.end())
            {
                return std::chrono::seconds{ 0 };
            }

            std::chrono::seconds acc{ 0 };
            for (const auto& e : it->second)
            {
                acc += e.duration();
            }

            return acc;
        }

        // Team-wide time (in seconds)
        [[nodiscard]] std::chrono::seconds total() const
        {
            std::chrono::seconds acc{ 0 };
            for (const auto& [_, entries] : bucket)
            {
                for (const auto& e : entries)
                {
                    acc += e.duration();
                }
            }
            return acc;
        }

        // Simple context-switch frequency: number of contiguous entries whose
        // tags differ from their predecessor.
        [[nodiscard]] std::size_t contextSwitches(const std::string& userId) const
        {
            auto it = bucket.find(userId);
            if (it == bucket.end() || it->second.size() < 2) { return 0; }

            std::size_t switches{ 0 };
            for (std::size_t i = 1; i < it->second.size(); ++i)
            {
                const auto& prev = it->second[i - 1];
                const auto& cur  = it->second[i];

                bool tagDiff = prev.tags != cur.tags;
                if (tagDiff) { ++switches; }
            }
            return switches;
        }
    };

} // namespace chrono_flow_nexus::domain
#endif

using namespace chrono_flow_nexus::domain;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
static std::chrono::system_clock::time_point make_tp(int64_t millis)
{
    return std::chrono::system_clock::time_point{ std::chrono::milliseconds{ millis } };
}

// -----------------------------------------------------------------------------
// Unit tests
// -----------------------------------------------------------------------------

TEST_CASE("TimeEntry enforces valid chronological order", "[domain][time-entry]")
{
    const auto now   = std::chrono::system_clock::now();
    const auto later = now + std::chrono::minutes{ 30 };

    SECTION("When end is before start, constructor throws")
    {
        REQUIRE_THROWS_AS(TimeEntry{ "id", later, now }, std::invalid_argument);
    }

    SECTION("When start and end are equal, constructor throws")
    {
        REQUIRE_THROWS_AS(TimeEntry{ "id", now, now }, std::invalid_argument);
    }

    SECTION("Valid interval does not throw")
    {
        REQUIRE_NOTHROW(TimeEntry{ "id", now, later });
    }
}

TEST_CASE("TimeEntry duration is computed correctly", "[domain][time-entry]")
{
    const auto start = make_tp(1'600'000'000'000);                      // epoch+1.6e12ms
    const auto end   = start + std::chrono::hours{ 2 } + std::chrono::minutes{ 15 };

    const TimeEntry entry{ "focus", start, end, { "code-review" } };

    REQUIRE(entry.duration() == std::chrono::seconds{ (2 * 3600) + (15 * 60) });
}

TEST_CASE("TimeEntry serializes and round-trip deserializes via JSON",
          "[domain][time-entry][json]")
{
    const auto start = make_tp(1'600'000'000'123);
    const auto end   = start + std::chrono::minutes{ 42 };

    const TimeEntry original{ "abc123", start, end, { "planning", "meeting" } };

    nlohmann::json j            = original;
    const TimeEntry  roundTripped = j.get<TimeEntry>();

    REQUIRE(original == roundTripped);

    // Validate JSON structure is stable
    REQUIRE(j.at("id").get<std::string>() == "abc123");
    REQUIRE(j.at("tags").size() == 2);
}

TEST_CASE("WorkloadSnapshot aggregates time correctly per user", "[analytic][aggregate]")
{
    WorkloadSnapshot snapshot;

    const auto dayStart = make_tp(1'600'100'000'000); // some epoch anchor

    snapshot.add("alice",
                 TimeEntry{ "e1",
                            dayStart,
                            dayStart + std::chrono::minutes{ 50 },
                            { "coding" } });
    snapshot.add("alice",
                 TimeEntry{ "e2",
                            dayStart + std::chrono::minutes{ 60 },
                            dayStart + std::chrono::minutes{ 120 },
                            { "meeting" } });

    snapshot.add("bob",
                 TimeEntry{ "e3",
                            dayStart + std::chrono::minutes{ 5 },
                            dayStart + std::chrono::minutes{ 65 },
                            { "research" } });

    REQUIRE(snapshot.totalForUser("alice") ==
            std::chrono::seconds{ (50 + 60) * 60 });

    REQUIRE(snapshot.totalForUser("bob") ==
            std::chrono::seconds{ 60 * 60 });

    REQUIRE(snapshot.total() ==
            std::chrono::seconds{ (50 + 60 + 60) * 60 });
}

TEST_CASE("WorkloadSnapshot counts context switches per user",
          "[analytic][context-switch]")
{
    WorkloadSnapshot snapshot;
    const auto base = make_tp(1'601'000'000'000);

    snapshot.add("carol",
                 TimeEntry{ "cs1",
                            base,
                            base + std::chrono::minutes{ 30 },
                            { "coding" } });
    snapshot.add("carol",
                 TimeEntry{ "cs2",
                            base + std::chrono::minutes{ 30 },
                            base + std::chrono::minutes{ 45 },
                            { "coding" } }); // same tag, no switch
    snapshot.add("carol",
                 TimeEntry{ "cs3",
                            base + std::chrono::minutes{ 45 },
                            base + std::chrono::minutes{ 60 },
                            { "email" } }); // diff tag, one switch
    snapshot.add("carol",
                 TimeEntry{ "cs4",
                            base + std::chrono::minutes{ 60 },
                            base + std::chrono::minutes{ 75 },
                            { "meeting" } }); // diff tag, another switch

    REQUIRE(snapshot.contextSwitches("carol") == 2);
}

TEST_CASE("WorkloadSnapshot returns zero for unknown users", "[analytic]")
{
    WorkloadSnapshot snapshot;

    REQUIRE(snapshot.totalForUser("ghost") == std::chrono::seconds{ 0 });
    REQUIRE(snapshot.contextSwitches("ghost") == 0);
}