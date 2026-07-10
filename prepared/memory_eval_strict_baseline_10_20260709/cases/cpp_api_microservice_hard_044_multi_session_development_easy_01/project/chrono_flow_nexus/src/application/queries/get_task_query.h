#pragma once
/**
 * chrono_flow_nexus/src/application/queries/get_task_query.h
 *
 * Copyright (c) ChronoFlow.
 *
 * This file is part of the ChronoFlow Nexus micro-service and is licensed
 * under the MIT License.  See LICENSE.txt for details.
 *
 * Query: GetTaskQuery
 * -------------------
 * A Command–Query-Separation (CQS) DTO used by the application layer to
 * retrieve a single Task aggregate from the domain model.  Besides the
 * mandatory Task-ID, the query can be parameterised with a point-in-time
 * snapshot (for time-travel debugging) and a flag that controls whether or
 * not expensive analytic projections should be calculated on the fly.
 *
 * The header also ships with a tiny validation helper to guarantee that
 * malformed requests are rejected at the boundary of the application layer
 * before hitting the domain/infrastructure tier.
 */

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>      // std::move
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_io.hpp>

namespace chrono_flow::application::queries {

/**
 * GetTaskQuery
 *
 * Immutable value object encapsulating the information required to
 * materialise a TaskReadModel from the persistence layer.
 */
class GetTaskQuery final
{
public:
    using Clock      = std::chrono::system_clock;
    using TimePoint  = Clock::time_point;

    /**
     * Construct a query object.
     *
     * @param taskId            The UUID that uniquely identifies a Task aggregate.
     * @param includeAnalytics  When set to true the handler must return the
     *                          Task decorated with analytic projections
     *                          (time-on-task, flow interruptions, etc.).
     * @param asOf              Optional point-in-time for temporal queries.
     *                          When populated, the handler MUST return a
     *                          historical snapshot that reflects the task
     *                          state at the given timestamp.
     *
     * @throws std::invalid_argument if the provided UUID is nil.
     */
    GetTaskQuery(boost::uuids::uuid taskId,
                 bool               includeAnalytics = false,
                 std::optional<TimePoint> asOf        = std::nullopt);

    // Defaulted copy / move semantics
    GetTaskQuery(const GetTaskQuery&)            = default;
    GetTaskQuery(GetTaskQuery&&) noexcept        = default;
    GetTaskQuery& operator=(const GetTaskQuery&) = default;
    GetTaskQuery& operator=(GetTaskQuery&&) noexcept = default;
    ~GetTaskQuery()                              = default;

    // Accessors ----------------------------------------------------------------
    [[nodiscard]] const boost::uuids::uuid& task_id() const noexcept   { return taskId_; }
    [[nodiscard]] bool include_analytics() const noexcept              { return includeAnalytics_; }
    [[nodiscard]] const std::optional<TimePoint>& as_of() const noexcept { return asOf_; }

private:
    boost::uuids::uuid        taskId_;
    bool                      includeAnalytics_;
    std::optional<TimePoint>  asOf_;
};

/**
 * GetTaskQueryValidationError
 *
 * Dedicated exception that can be intercepted by the API gateway layer in
 * order to convert validation failures into 4xx HTTP status codes or proper
 * GraphQL error responses.
 */
class GetTaskQueryValidationError final : public std::runtime_error
{
public:
    explicit GetTaskQueryValidationError(std::string  message)
        : std::runtime_error{ std::move(message) } {}
};

/**
 * GetTaskQueryValidator
 *
 * Lightweight validator meant to be used by request-mapping components
 * (REST controllers / GraphQL resolvers) before the query is dispatched to
 * its handler. Keeping validation outside of the handler allows the latter
 * to stay laser-focussed on business logic.
 */
class GetTaskQueryValidator
{
public:
    /**
     * Validate the supplied query.
     *
     * @throws GetTaskQueryValidationError if the query is malformed.
     */
    void validate(const GetTaskQuery& query) const;
};

// === Implementation Details ==================================================
inline GetTaskQuery::GetTaskQuery(boost::uuids::uuid taskId,
                                  bool               includeAnalytics,
                                  std::optional<TimePoint> asOf)
    : taskId_{ std::move(taskId) }
    , includeAnalytics_{ includeAnalytics }
    , asOf_{ std::move(asOf) }
{
    if (taskId_.is_nil())
    {
        throw std::invalid_argument{ "GetTaskQuery: taskId must not be nil" };
    }
}

inline void GetTaskQueryValidator::validate(const GetTaskQuery& query) const
{
    if (query.task_id().is_nil())
    {
        throw GetTaskQueryValidationError{ "Validation failed: taskId must not be nil" };
    }

    // Temporal constraints:  no future snapshots allowed
    if (query.as_of().has_value() &&
        query.as_of().value() > GetTaskQuery::Clock::now())
    {
        throw GetTaskQueryValidationError{ "Validation failed: 'asOf' cannot lie in the future" };
    }

    // Nothing else to validate for the time being.
}

} // namespace chrono_flow::application::queries