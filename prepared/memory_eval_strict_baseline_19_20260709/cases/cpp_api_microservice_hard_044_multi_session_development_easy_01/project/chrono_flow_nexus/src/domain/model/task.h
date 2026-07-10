#pragma once
/**
 *  chrono_flow_nexus/src/domain/model/task.h
 *
 *  Copyright (c) ChronoFlow
 *
 *  DOMAIN ‑ Model: Task
 *  --------------------
 *  This header defines the Task aggregate root, the heart of ChronoFlow’s
 *  productivity-centric domain model.  A Task represents a measurable unit
 *  of intentional work that can be scheduled, tracked, and analysed.  It
 *  exposes rich domain behaviour (state-machine transitions, elapsed-time
 *  calculation, tag management …) while protecting invariants through
 *  explicit validation and well-defined state transitions.
 *
 *  NOTE:
 *    • This is a header-only implementation for succinctness.  In larger
 *      code-bases you may want to separate interface and implementation.
 *    • The class is intentionally immutable from the outside: state mutations
 *      are channelled through behavioural member functions that enforce
 *      invariants and emit consistent timestamps.
 */

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace cfnx::domain::model
{
// Forward-declared helper for hashing TaskId.
struct TaskIdHash;

// ---------------------------------------------------------------------------
// Domain aliases / enumerations
// ---------------------------------------------------------------------------
using TaskId = std::uint64_t;

/**
 * Coarse-grained lifecycle states for a task.
 *
 *  Pending      – created but not yet started
 *  InProgress   – actively being worked on
 *  Paused       – temporarily halted, can be resumed
 *  Completed    – finished successfully
 *  Canceled     – deliberately abandoned
 */
enum class TaskStatus : std::uint8_t
{
    Pending,
    InProgress,
    Paused,
    Completed,
    Canceled
};

/**
 * Indicates the business urgency / importance of a task.
 */
enum class TaskPriority : std::uint8_t
{
    Low,
    Normal,
    High,
    Critical
};

// ---------------------------------------------------------------------------
// TimeWindow value object
// ---------------------------------------------------------------------------
/**
 * Represents a half-open interval [start, end) on the system clock.
 * A missing end means “still ongoing”.
 */
struct TimeWindow final
{
    std::chrono::system_clock::time_point start;
    std::optional<std::chrono::system_clock::time_point> end;

    /**
     * Returns the window’s duration.  If the end is not yet known,
     * computes the duration up to the current wall-clock time.
     */
    [[nodiscard]]
    std::chrono::seconds duration() const
    {
        const auto effectiveEnd =
            end.value_or(std::chrono::system_clock::now());

        if (effectiveEnd < start)
        {
            throw std::logic_error(
                "TimeWindow::duration(): end precedes start");
        }
        return std::chrono::duration_cast<std::chrono::seconds>(
            effectiveEnd - start);
    }
};

// ---------------------------------------------------------------------------
// Task aggregate
// ---------------------------------------------------------------------------
class Task final
{
public:
    //------------------------------------------------------------------------
    // Constructors / factory helpers
    //------------------------------------------------------------------------
    Task(TaskId                       id,
         std::string                  title,
         std::string                  description,
         TaskPriority                 priority      = TaskPriority::Normal,
         std::vector<std::string>     tags          = {},
         const TimeWindow&            scheduled     = {})
        : m_id(id)
        , m_title(std::move(title))
        , m_description(std::move(description))
        , m_priority(priority)
        , m_status(TaskStatus::Pending)
        , m_tags(std::move(tags))
        , m_scheduled(scheduled)
        , m_createdAt(std::chrono::system_clock::now())
        , m_updatedAt(m_createdAt)
    {
        validate();
    }

    // default copy / move semantics -------------------------------------------------
    Task(const Task&)            = default;
    Task(Task&&)                 = default;
    Task& operator=(const Task&) = default;
    Task& operator=(Task&&)      = default;
    ~Task()                      = default;

    //------------------------------------------------------------------------
    // Domain behaviour (state transitions)
    //------------------------------------------------------------------------
    /**
     * Starts the task, recording the current timestamp as the beginning of
     * the actual execution window.  May be invoked only from Pending|Paused.
     */
    void start()
    {
        switch (m_status)
        {
            case TaskStatus::Pending:
                m_actual.start = std::chrono::system_clock::now();
                transitionTo(TaskStatus::InProgress);
                break;

            case TaskStatus::Paused:
                transitionTo(TaskStatus::InProgress);
                break;

            default:
                throw std::logic_error("Task::start(): invalid state transition");
        }
    }

    /**
     * Pauses an in-progress task.  The “end” timestamp in the actual window
     * is left unset to allow duration to continue accumulating.
     */
    void pause()
    {
        if (m_status != TaskStatus::InProgress)
            throw std::logic_error("Task::pause(): task must be in progress");
        transitionTo(TaskStatus::Paused);
    }

    /**
     * Completes the task.  Duration is finalised.
     */
    void complete()
    {
        if (m_status != TaskStatus::InProgress &&
            m_status != TaskStatus::Paused)
        {
            throw std::logic_error("Task::complete(): task not active");
        }

        if (!m_actual.end.has_value())
            m_actual.end = std::chrono::system_clock::now();

        transitionTo(TaskStatus::Completed);
    }

    /**
     * Cancels the task irrespective of current progress.
     */
    void cancel()
    {
        if (m_status == TaskStatus::Completed)
            throw std::logic_error("Task::cancel(): task already completed");

        if (!m_actual.end.has_value() && m_status != TaskStatus::Pending)
            m_actual.end = std::chrono::system_clock::now();

        transitionTo(TaskStatus::Canceled);
    }

    //------------------------------------------------------------------------
    // Tags / categorisation
    //------------------------------------------------------------------------
    void addTag(std::string_view tag)
    {
        if (std::find(m_tags.begin(), m_tags.end(), tag) == m_tags.end())
        {
            m_tags.emplace_back(tag);
            m_updatedAt = std::chrono::system_clock::now();
        }
    }

    void removeTag(std::string_view tag)
    {
        const auto it = std::remove(m_tags.begin(), m_tags.end(), tag);
        if (it != m_tags.end())
        {
            m_tags.erase(it, m_tags.end());
            m_updatedAt = std::chrono::system_clock::now();
        }
    }

    //------------------------------------------------------------------------
    // Query functions
    //------------------------------------------------------------------------
    [[nodiscard]] TaskId                          id()           const noexcept { return m_id; }
    [[nodiscard]] const std::string&              title()        const noexcept { return m_title; }
    [[nodiscard]] const std::string&              description()  const noexcept { return m_description; }
    [[nodiscard]] TaskPriority                    priority()     const noexcept { return m_priority; }
    [[nodiscard]] TaskStatus                      status()       const noexcept { return m_status; }
    [[nodiscard]] const std::vector<std::string>& tags()         const noexcept { return m_tags; }
    [[nodiscard]] const TimeWindow&               scheduledWindow() const noexcept { return m_scheduled; }
    [[nodiscard]] const TimeWindow&               actualWindow()    const noexcept { return m_actual; }

    /**
     * Elapsed active time in seconds.  Convenience wrapper around
     * TimeWindow::duration().
     */
    [[nodiscard]]
    std::chrono::seconds elapsed() const
    {
        if (m_status == TaskStatus::Pending)
            return std::chrono::seconds{0};

        return m_actual.duration();
    }

    /**
     * Enforces object invariants (non-empty title, etc.).
     */
    void validate() const
    {
        if (m_title.empty())
            throw std::invalid_argument("Task::validate(): title must not be empty");

        if (m_description.empty())
            throw std::invalid_argument("Task::validate(): description must not be empty");

        if (m_actual.end && m_actual.end < m_actual.start)
            throw std::logic_error("Task::validate(): actual end precedes start");
    }

    //------------------------------------------------------------------------
    // Equality semantics (based solely on identity)
    //------------------------------------------------------------------------
    [[nodiscard]]
    bool operator==(const Task& other) const noexcept
    {
        return m_id == other.m_id;
    }

    [[nodiscard]]
    bool operator!=(const Task& other) const noexcept
    {
        return !(*this == other);
    }

private:
    //------------------------------------------------------------------------
    // Internal helpers
    //------------------------------------------------------------------------
    void transitionTo(TaskStatus newStatus)
    {
        if (m_status == newStatus) return; // no-op

        // basic finite-state-machine validation
        const auto ok = [&]() -> bool
        {
            switch (m_status)
            {
                case TaskStatus::Pending:
                    return (newStatus == TaskStatus::InProgress ||
                            newStatus == TaskStatus::Canceled);

                case TaskStatus::InProgress:
                    return (newStatus == TaskStatus::Paused     ||
                            newStatus == TaskStatus::Completed ||
                            newStatus == TaskStatus::Canceled);

                case TaskStatus::Paused:
                    return (newStatus == TaskStatus::InProgress ||
                            newStatus == TaskStatus::Canceled);

                default:
                    return false; // Completed | Canceled cannot transition
            }
        }();

        if (!ok)
            throw std::logic_error("Task::transitionTo(): illegal transition");

        m_status   = newStatus;
        m_updatedAt = std::chrono::system_clock::now();
    }

    //------------------------------------------------------------------------
    // Data members
    //------------------------------------------------------------------------
    TaskId                  m_id;
    std::string             m_title;
    std::string             m_description;
    TaskPriority            m_priority;
    TaskStatus              m_status;
    std::vector<std::string> m_tags;

    TimeWindow              m_scheduled;   // expectation
    TimeWindow              m_actual;      // reality (populated once started)

    std::chrono::system_clock::time_point m_createdAt;  // immutable
    std::chrono::system_clock::time_point m_updatedAt;  // mutation timestamp
};

// ---------------------------------------------------------------------------
// Hash support for unordered containers
// ---------------------------------------------------------------------------
struct TaskIdHash
{
    std::size_t operator()(const Task& task) const noexcept
    {
        return std::hash<TaskId>{}(task.id());
    }
};
} // namespace cfnx::domain::model