```cpp
/**
 *  ChronoFlow Nexus
 *  File: chrono_flow_nexus/src/domain/repository/repository_interfaces.h
 *
 *  Description:
 *  =============
 *  Domain-layer abstractions that follow the Repository Pattern and isolate
 *  the remainder of the code-base from any persistence concerns.
 *
 *  These interfaces purposefully return std::future<T> so that the application
 *  layer may decide whether to execute queries synchronously or delegate them
 *  to a thread-pool / coroutine context.  The concrete implementations in the
 *  infrastructure layer (e.g., PostgreSQL, MongoDB, Redis) are therefore free
 *  to adopt the most efficient completion model without leaking details upward.
 *
 *  All repositories operate under a Unit-of-Work boundary to guarantee
 *  transactional consistency when the underlying data store supports it.
 */

#ifndef CHRONO_FLOW_NEXUS_DOMAIN_REPOSITORY_INTERFACES_H
#define CHRONO_FLOW_NEXUS_DOMAIN_REPOSITORY_INTERFACES_H

#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace chrono_flow_nexus::domain
{
/**
 * Lightweight UUID abstraction used throughout the domain.  Concrete storage
 * types (e.g., boost::uuids::uuid or std::array<std::byte,16>) are hidden to
 * keep this header self-contained.
 */
struct UUID
{
    std::uint64_t high{};
    std::uint64_t low{};

    constexpr bool operator==(const UUID&) const noexcept = default;
};

/* Forward declarations of aggregate roots. */
struct TimeEntry;
struct Task;
struct User;
struct Team;
} // namespace chrono_flow_nexus::domain

namespace chrono_flow_nexus::domain::repository
{
/*--------------------------------------------------
 * Shared query-by-example helpers
 *--------------------------------------------------*/

/**
 * Pagination helper sent alongside most read operations.  Defaults are safe
 * for mobile clients that might execute n+1 queries unintentionally.
 */
struct Pagination
{
    std::size_t page      = 0;  // zero-based index
    std::size_t page_size = 50; // server-side cap will clamp higher values
};

/**
 * Reusable date-range filter that adheres to the ISO-8601 invariant
 * [from, to).  Inclusive lower-bound, exclusive upper-bound.
 */
struct DateRange
{
    std::chrono::system_clock::time_point from;
    std::chrono::system_clock::time_point to;
};

/*--------------------------------------------------
 * Exceptions
 *--------------------------------------------------*/

/**
 * Base-class for all repository-level errors, enabling callers to catch
 * aggregate errors instead of probing for a specific source.
 */
class RepositoryError : public std::runtime_error
{
public:
    explicit RepositoryError(const std::string& msg)
        : std::runtime_error{msg}
    {}
};

/*--------------------------------------------------
 * Base Repository interface (marker type)
 *--------------------------------------------------*/
class IRepository
{
public:
    virtual ~IRepository() = default;
};

/*--------------------------------------------------
 * TimeEntry Repository
 *--------------------------------------------------*/
/**
 * CRUD interface on the TimeEntry aggregate root.
 * NOTE: All mutating operations (insert, update, remove) are designed
 *       to be eventually consistent; they do not guarantee that changes
 *       are durable until the surrounding Unit-of-Work successfully
 *       commits.
 */
class ITimeEntryRepository : public IRepository
{
public:
    virtual ~ITimeEntryRepository() = default;

    /**
     * Retrieve every TimeEntry for a single user inside a date-range.  Clients
     * may opt-into chunked consumption via the Pagination argument.
     */
    virtual std::future<std::vector<domain::TimeEntry>>
    fetch_by_user(const domain::UUID& user_id,
                  const DateRange&    range,
                  const Pagination&   page = {}) = 0;

    /**
     * Retrieve a single TimeEntry by its primary identifier.
     */
    virtual std::future<std::optional<domain::TimeEntry>>
    find_by_id(const domain::UUID& id) = 0;

    /**
     * Persist a brand-new TimeEntry.  Returns the UUID assigned by the
     * underlying storage.  Fails with RepositoryError on conflicts.
     */
    virtual std::future<domain::UUID>
    insert(const domain::TimeEntry& entry) = 0;

    /**
     * Update a previously inserted TimeEntry.
     */
    virtual std::future<void>
    update(const domain::TimeEntry& entry) = 0;

    /**
     * Hard-delete a TimeEntry.  A no-op if the ID does not exist; callers can
     * decide whether that constitutes an application-level error.
     */
    virtual std::future<void>
    remove(const domain::UUID& id) = 0;
};

/*--------------------------------------------------
 * Task Repository
 *--------------------------------------------------*/
class ITaskRepository : public IRepository
{
public:
    virtual ~ITaskRepository() = default;

    virtual std::future<std::optional<domain::Task>>
    find_by_id(const domain::UUID& id) = 0;

    virtual std::future<std::vector<domain::Task>>
    fetch_by_user(const domain::UUID& user_id,
                  const Pagination&   page = {}) = 0;

    virtual std::future<std::vector<domain::Task>>
    fetch_by_team(const domain::UUID& team_id,
                  const Pagination&   page = {}) = 0;

    virtual std::future<domain::UUID>
    insert(const domain::Task& task) = 0;

    virtual std::future<void>
    update(const domain::Task& task) = 0;

    virtual std::future<void>
    remove(const domain::UUID& id) = 0;
};

/*--------------------------------------------------
 * Analytics Repository
 *--------------------------------------------------*/

/**
 * Aggregated KPI result computed by heavy-weight analytics queries.
 */
struct FlowMetric
{
    double time_on_task_minutes     = 0.0; // Focused work
    double context_switch_frequency = 0.0; // Count / hour
    double interruptions_per_hour   = 0.0;
};

/**
 * High-level analytics queries that crunch data across many aggregates.
 * These calls are intentionally coarse-grained so that the
 * service-implementation can batch or stream work as needed.
 */
class IAnalyticsRepository : public IRepository
{
public:
    virtual ~IAnalyticsRepository() = default;

    virtual std::future<FlowMetric>
    compute_flow_metric_for_user(const domain::UUID& user_id,
                                 const DateRange&    range) = 0;

    virtual std::future<FlowMetric>
    compute_flow_metric_for_team(const domain::UUID& team_id,
                                 const DateRange&    range) = 0;
};

/*--------------------------------------------------
 * Unit-of-Work
 *--------------------------------------------------*/

/**
 * Represents a boundary over which read and write operations must be
 * atomically committed.  Facilitates complex business workflows that touch
 * multiple aggregates by coordinating repository implementations underneath.
 *
 * Typical usage pattern:
 *
 *     auto uow = infrastructure::make_unit_of_work();
 *     auto task = uow->tasks()->find_by_id(task_id).get();
 *     ...
 *     uow->commit();
 *
 * If an exception escapes or the caller explicitly invokes rollback(), the
 * Unit-of-Work guarantees that no partial state leaks out.
 */
class IUnitOfWork
{
public:
    virtual ~IUnitOfWork() = default;

    virtual std::shared_ptr<ITimeEntryRepository> time_entries() = 0;
    virtual std::shared_ptr<ITaskRepository>      tasks()        = 0;
    virtual std::shared_ptr<IAnalyticsRepository> analytics()    = 0;

    /**
     * Flush all in-flight changes.  May throw RepositoryError when the
     * persistence engine rejects the transaction (for example due to a
     * violated constraint).
     */
    virtual void commit() = 0;

    /**
     * Best-effort rollback.  Guaranteed noexcept so that destructors can safely
     * call it without risking a terminate() during stack unwinding.
     */
    virtual void rollback() noexcept = 0;
};

} // namespace chrono_flow_nexus::domain::repository

#endif // CHRONO_FLOW_NEXUS_DOMAIN_REPOSITORY_INTERFACES_H
```