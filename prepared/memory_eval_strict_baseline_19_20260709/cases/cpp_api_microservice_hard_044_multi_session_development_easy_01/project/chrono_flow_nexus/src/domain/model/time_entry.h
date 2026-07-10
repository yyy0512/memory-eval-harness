```cpp
#pragma once
/**
 * chrono_flow_nexus/src/domain/model/time_entry.h
 *
 * ChronoFlow Nexus
 * ----------------
 * Domain model representing a single user-initiated “time entry”.
 * A time entry can span multiple “segments” (work/pause/resume cycles)
 * and exposes rich behaviour—rather than acting as a passive DTO—to
 * guarantee invariants around chronology, status transitions, and
 * aggregate duration calculations.
 *
 * NOTE:
 *  • Header-only implementation for convenience; compilation unit can be
 *    split later if symbol visibility or build-times become a concern.
 *  • No external (de-)serialization logic is present here—those concerns
 *    belong to the interface/transport layer.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <ostream>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chrono_flow::domain::model {

class TimeEntry final
{
public:
    // ------------------------  Type Aliases  -------------------------
    using Clock      = std::chrono::system_clock;
    using TimePoint  = std::chrono::time_point<Clock>;
    using Duration   = std::chrono::seconds;
    using TagList    = std::vector<std::string>;

    // -----------------------  Nested Structs  ------------------------
    struct Id
    {
        // Unparsed UUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
        std::string value;

        explicit Id(std::string v) : value{std::move(v)}
        {
            if (!is_valid_uuid(value))
                throw std::invalid_argument("TimeEntry::Id – invalid UUID format");
        }

        friend bool operator==(const Id& lhs, const Id& rhs) noexcept
        {
            return lhs.value == rhs.value;
        }
        friend bool operator!=(const Id& lhs, const Id& rhs) noexcept
        {
            return !(lhs == rhs);
        }
        friend std::ostream& operator<<(std::ostream& os, const Id& id)
        {
            return os << id.value;
        }

        struct Hasher
        {
            std::size_t operator()(const Id& id) const noexcept
            {
                return std::hash<std::string>{}(id.value);
            }
        };

    private:
        static bool is_valid_uuid(std::string_view candidate)
        {
            // very light validation; do *not* cryptographically validate.
            static const std::regex rx(
                "^[0-9a-fA-F]{8}-"
                "[0-9a-fA-F]{4}-"
                "[0-9a-fA-F]{4}-"
                "[0-9a-fA-F]{4}-"
                "[0-9a-fA-F]{12}$",
                std::regex::ECMAScript);
            return std::regex_match(candidate.begin(), candidate.end(), rx);
        }
    };

    enum class Status : std::uint8_t
    {
        Running,
        Paused,
        Completed
    };

    // -----------------------  Factory Methods  -----------------------
    /**
     * Starts a new running time-entry.
     *
     * @param id          Stable, caller-supplied identifier (UUID).
     * @param started_at  Timestamp representing the *first* "clock-in".
     * @param description Human-readable description. Must not be empty.
     * @param tags        Optional list of tags.
     */
    static TimeEntry start_new(Id id,
                               TimePoint started_at,
                               std::string description,
                               TagList tags = {})
    {
        if (description.empty())
            throw std::invalid_argument("TimeEntry::start_new – description must not be empty");

        TimeEntry entry{std::move(id), std::move(description), std::move(tags)};
        entry.segments_.push_back(Segment{started_at, std::nullopt});
        entry.status_ = Status::Running;
        return entry;
    }

    // ---------------------  Observational Methods  -------------------
    Status        status()        const noexcept { return status_; }
    const Id&     id()            const noexcept { return id_; }
    const TagList& tags()         const noexcept { return tags_; }
    const std::string& description() const noexcept { return description_; }

    /**
     * Returns the *aggregate* duration across all closed segments.  If the
     * entry is still running, includes the partial duration up to `now`.
     */
    Duration total_duration(TimePoint now = Clock::now()) const
    {
        Duration total{0};
        for (const auto& s : segments_)
        {
            const TimePoint end = s.to.value_or(now);
            total += std::chrono::duration_cast<Duration>(end - s.from);
        }
        return total;
    }

    // ----------------------  Behavioural API  ------------------------
    /**
     * Pause a running entry.
     *
     * @throws std::logic_error if entry is not in Running state.
     */
    void pause(TimePoint at)
    {
        ensure_status(Status::Running, "pause");

        Segment& current = segments_.back();
        validate_chronology(current.from, at, "pause");
        current.to = at;
        status_    = Status::Paused;
    }

    /**
     * Resume a paused entry by opening a new segment.
     *
     * @throws std::logic_error if entry is not in Paused state.
     */
    void resume(TimePoint at)
    {
        ensure_status(Status::Paused, "resume");
        segments_.push_back(Segment{at, std::nullopt});
        status_ = Status::Running;
    }

    /**
     * Completes the entry, closing any open segment.
     *
     * @throws std::logic_error if already completed.
     */
    void stop(TimePoint at)
    {
        if (status_ == Status::Completed)
            throw std::logic_error("TimeEntry::stop – already completed");

        if (status_ == Status::Running)
        {
            Segment& current = segments_.back();
            validate_chronology(current.from, at, "stop");
            current.to = at;
        }
        else // Paused
        {
            // last segment already closed—no check needed
        }
        status_ = Status::Completed;
    }

    // ----------------------  Mutation Helpers  -----------------------
    void set_description(std::string new_desc)
    {
        if (new_desc.empty())
            throw std::invalid_argument("TimeEntry::set_description – description must not be empty");
        description_ = std::move(new_desc);
    }

    void add_tag(std::string tag)
    {
        if (tag.empty())
            throw std::invalid_argument("TimeEntry::add_tag – tag must not be empty");
        tags_.push_back(std::move(tag));
    }

    void remove_tag(const std::string& tag_to_remove)
    {
        tags_.erase(
            std::remove(tags_.begin(), tags_.end(), tag_to_remove),
            tags_.end());
    }

    // ------------------------  Operators  ----------------------------
    friend std::ostream& operator<<(std::ostream& os, const TimeEntry& e)
    {
        os << "TimeEntry{id=" << e.id_.value     //
           << ", status=" << to_string(e.status_)
           << ", segments=" << e.segments_.size()
           << ", total=" << e.total_duration().count() << "s}";
        return os;
    }

    friend bool operator==(const TimeEntry& lhs, const TimeEntry& rhs) noexcept
    {
        return lhs.id_ == rhs.id_;
    }
    friend bool operator!=(const TimeEntry& lhs, const TimeEntry& rhs) noexcept
    {
        return !(lhs == rhs);
    }

private:
    // ------------------  Internal Data Structures  -------------------
    struct Segment
    {
        TimePoint               from;
        std::optional<TimePoint> to; // nullopt => currently running
    };

    // -------------------------  Members  -----------------------------
    Id              id_;
    std::string     description_;
    TagList         tags_;
    Status          status_{Status::Paused};
    std::vector<Segment> segments_;

    // -------------------  Private Ctor / Helpers  --------------------
    TimeEntry(Id id, std::string description, TagList tags)
        : id_{std::move(id)}
        , description_{std::move(description)}
        , tags_{std::move(tags)}
    {
    }

    void ensure_status(Status expected, const char* op) const
    {
        if (status_ != expected)
            throw std::logic_error(std::string("TimeEntry::") + op +
                                   " – invalid status transition");
    }

    static void validate_chronology(TimePoint from, TimePoint to, const char* ctx)
    {
        if (to < from)
            throw std::invalid_argument(std::string("TimeEntry::") + ctx +
                                        " – end-time precedes start-time");
    }

    static constexpr std::string_view to_string(Status s) noexcept
    {
        switch (s)
        {
        case Status::Running:   return "Running";
        case Status::Paused:    return "Paused";
        case Status::Completed: return "Completed";
        }
        return "Unknown";
    }
};

} // namespace chrono_flow::domain::model
```