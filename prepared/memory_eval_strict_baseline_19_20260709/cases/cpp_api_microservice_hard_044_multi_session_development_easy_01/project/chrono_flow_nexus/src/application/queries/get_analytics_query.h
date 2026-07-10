```cpp
#pragma once
/**
 * chrono_flow_nexus/src/application/queries/get_analytics_query.h
 *
 * Copyright (c) 2024 ChronoFlow
 *
 * Licensed under the MIT License.  See LICENSE file in the project root for full license information.
 *
 * ---------------------------------------------------------------------------
 *  Query object used by the Application layer (CQRS) to request analytics
 *  from the Domain layer without leaking transport-specific concerns.
 *
 *  The query is intentionally immutable after construction; any modification
 *  must happen by creating a new instance, thus keeping command/query objects
 *  thread-safe and side-effect free.
 * ---------------------------------------------------------------------------
 */

#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include "application/common/query_base.h"   // <IQuery> base type (returns TResult)
#include "application/dto/analytics_dto.h"   // <AnalyticsDto> transfer object

namespace chrono_flow::application::queries {

//--------------------------------------------------------------------------
//  Helpers & Strong Types
//--------------------------------------------------------------------------

/**
 * Metric enumerates the high-level KPI categories supported by the
 * analytics subsystem.  Adding new categories will *not* break binary
 * compatibility, provided they are appended to the end of the enum list.
 */
enum class Metric : std::uint8_t
{
    TimeOnTask = 0,
    ContextSwitches,
    FlowInterruptions,
    WorkloadUtilization,
    ActiveTasks,
    //  Future metrics go here …
};

/**
 * Small value object representing an inclusive date/time range.
 */
struct DateRange final
{
    using Clock      = std::chrono::system_clock;
    using TimePoint  = Clock::time_point;

    TimePoint from;   // inclusive
    TimePoint to;     // inclusive

    constexpr DateRange(TimePoint f, TimePoint t) : from{f}, to{t}
    {
        if (from > to) [[unlikely]]
        {
            throw std::invalid_argument(
                "DateRange ctor: 'from' must be earlier than or equal to 'to'.");
        }
    }

    [[nodiscard]] constexpr bool contains(TimePoint tp) const noexcept
    {
        return from <= tp && tp <= to;
    }
};

//--------------------------------------------------------------------------
//  Main Query Object
//--------------------------------------------------------------------------

/**
 * GetAnalyticsQuery (CQRS – Query side)
 *
 * Request object that encapsulates all parameters required to retrieve
 * analytics for a set of users, teams, or projects within a given period.
 *
 * The associated handler resolves the query into an AnalyticsDto aggregate,
 * performing pagination and rate-limiting checks before dispatching to the
 * domain’s read model.
 */
class GetAnalyticsQuery final
    : public common::IQuery<dto::AnalyticsDto>   // TResult = AnalyticsDto
{
public:
    using Clock = std::chrono::system_clock;

    // Optional pagination parameters supplied by REST/GraphQL adapters
    struct Pagination
    {
        std::uint32_t limit  = 100;  // number of rows/page
        std::uint32_t offset = 0;    // 0-based row offset

        constexpr Pagination(std::uint32_t l = 100, std::uint32_t o = 0)
            : limit{l}, offset{o}
        {
            if (limit == 0U || limit > 10'000U)
            {
                throw std::out_of_range(
                    "Pagination.limit must be between 1 and 10 000 (inclusive)");
            }
        }
    };

    //---------------------------------------------------------------------------

    /**
     * Construct a fully-formed query.
     *
     * tenantId  – Multi-tenant isolation key (cannot be empty)
     * actorId   – The user or service initiating the request (cannot be empty)
     * range     – Inclusive date/time range for which to compute analytics
     * metrics   – Set of metrics to be calculated.  When empty, defaults to *all*.
     */
    explicit GetAnalyticsQuery(
        std::string                         tenantId,
        std::string                         actorId,
        DateRange                           range,
        std::unordered_set<Metric>          metrics   = {},
        std::vector<std::string>            projectIds = {},
        std::vector<std::string>            userIds    = {},
        Pagination                          pagination  = Pagination{})
        : m_tenantId{std::move(tenantId)},
          m_actorId{std::move(actorId)},
          m_range{range},
          m_metrics{std::move(metrics)},
          m_projectIds{std::move(projectIds)},
          m_userIds{std::move(userIds)},
          m_pagination{pagination}
    {
        if (m_tenantId.empty()) [[unlikely]]
        {
            throw std::invalid_argument("GetAnalyticsQuery: tenantId cannot be empty");
        }
        if (m_actorId.empty()) [[unlikely]]
        {
            throw std::invalid_argument("GetAnalyticsQuery: actorId cannot be empty");
        }

        // If the client didn’t request specific metrics, compute all
        if (m_metrics.empty())
        {
            m_metrics = {
                Metric::TimeOnTask,
                Metric::ContextSwitches,
                Metric::FlowInterruptions,
                Metric::WorkloadUtilization,
                Metric::ActiveTasks};
        }
    }

    //----------------------------------------------------------------------
    //  Introspection – accessors are intentionally read-only
    //----------------------------------------------------------------------

    [[nodiscard]] const std::string& tenant_id()     const noexcept { return m_tenantId; }
    [[nodiscard]] const std::string& actor_id()      const noexcept { return m_actorId; }
    [[nodiscard]] const DateRange&   range()         const noexcept { return m_range; }
    [[nodiscard]] const std::unordered_set<Metric>&
                                        metrics()    const noexcept { return m_metrics; }
    [[nodiscard]] const std::vector<std::string>&
                                        project_ids() const noexcept { return m_projectIds; }
    [[nodiscard]] const std::vector<std::string>&
                                        user_ids()    const noexcept { return m_userIds; }
    [[nodiscard]] const Pagination&   pagination()   const noexcept { return m_pagination; }

private:
    //  --- Data Members (immutable) --------------------------------------
    std::string                    m_tenantId;
    std::string                    m_actorId;
    DateRange                      m_range;
    std::unordered_set<Metric>     m_metrics;
    std::vector<std::string>       m_projectIds;
    std::vector<std::string>       m_userIds;
    Pagination                     m_pagination;
};

} // namespace chrono_flow::application::queries
```
