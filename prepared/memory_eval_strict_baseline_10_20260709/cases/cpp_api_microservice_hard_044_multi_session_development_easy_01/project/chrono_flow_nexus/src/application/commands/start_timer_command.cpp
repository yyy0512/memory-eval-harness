```cpp
/**
 * chrono_flow_nexus/src/application/commands/start_timer_command.cpp
 *
 * Copyright (c) 2024 ChronoFlow.
 *
 * Implementation of StartTimerCommand—responsible for kicking-off a new running
 * timer for a given task / user pair.  The command enforces domain invariants
 * such as “one active timer per user”, persists state through the Unit-of-Work
 * abstraction, and emits a TimerStarted domain event so downstream subscribers
 * (e.g., the real-time websocket fan-out service) can react immediately.
 *
 * Layer:      Application
 * Depends on: Domain repositories, Unit-of-Work, EventBus, Clock, logging
 */

#include "application/commands/start_timer_command.h"

#include <boost/uuid/random_generator.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <spdlog/spdlog.h>

#include "application/dto/timer_dto.h"
#include "domain/entities/task.h"
#include "domain/entities/timer.h"
#include "domain/events/timer_started_event.h"
#include "domain/exceptions/domain_validation_exception.h"
#include "infrastructure/persistence/unit_of_work.h"

using namespace std::chrono_literals;
using chrono_flow::application::commands::StartTimerCommand;
using chrono_flow::application::commands::StartTimerRequest;
using chrono_flow::application::dto::TimerDTO;
namespace validation = chrono_flow::domain::exceptions;
namespace events     = chrono_flow::domain::events;

namespace
{
// -------- Helper utilities kept in an anonymous namespace ------------------

/**
 * Validates the consumer-provided request for obvious pre-conditions that
 * don’t require hitting the database.  Any failure throws
 * DomainValidationException, which is translated further up-stack into
 * an HTTP 400 response by our exception-to-problem-details mapper.
 */
void validate_static_request_contract(const StartTimerRequest& req)
{
    if (req.userId.empty())
    {
        throw validation::DomainValidationException{
            "StartTimerCommand::userId must not be empty"};
    }
    if (req.taskId.empty())
    {
        throw validation::DomainValidationException{
            "StartTimerCommand::taskId must not be empty"};
    }
}

} // namespace

//============================================================================
// ctor
//============================================================================
StartTimerCommand::StartTimerCommand(
    std::shared_ptr<domain::repositories::ITaskRepository>  taskRepo,
    std::shared_ptr<domain::repositories::ITimerRepository> timerRepo,
    std::shared_ptr<infrastructure::persistence::IUnitOfWork> unitOfWork,
    std::shared_ptr<utils::Clock> clock,
    std::shared_ptr<infrastructure::bus::IEventBus> eventBus)
    : m_taskRepo{std::move(taskRepo)}
    , m_timerRepo{std::move(timerRepo)}
    , m_unitOfWork{std::move(unitOfWork)}
    , m_clock{std::move(clock)}
    , m_eventBus{std::move(eventBus)}
{
    if (!m_taskRepo || !m_timerRepo || !m_unitOfWork || !m_clock || !m_eventBus)
    {
        throw std::invalid_argument{
            "StartTimerCommand – received one or more null dependencies"};
    }
}

//============================================================================
// execute
//============================================================================
TimerDTO StartTimerCommand::execute(const StartTimerRequest& request)
{
    validate_static_request_contract(request);

    spdlog::info("StartTimerCommand invoked; user='{}', task='{}', corr='{}'",
                 request.userId,
                 request.taskId,
                 request.correlationId.value_or("n/a"));

    //-------------------------------------------------------------
    // 1. Check if the task exists and the user has permission.
    //-------------------------------------------------------------
    auto task = m_taskRepo->findById(request.taskId);
    if (!task)
    {
        throw validation::DomainValidationException{
            "Cannot start timer – task does not exist"};
    }
    if (task->ownerId() != request.userId)
    {
        throw validation::DomainValidationException{
            "User does not own task – permission denied"};
    }
    if (task->isCompleted())
    {
        throw validation::DomainValidationException{
            "Cannot start timer – task already completed"};
    }

    //-------------------------------------------------------------
    // 2. Enforcement: only one active timer per user.
    //-------------------------------------------------------------
    if (auto active = m_timerRepo->findActiveByUser(request.userId); active)
    {
        throw validation::DomainValidationException{
            "User already has an active timer. "
            "Stop or pause it before starting another."};
    }

    //-------------------------------------------------------------
    // 3. Construct domain entity & stage it within the UoW.
    //-------------------------------------------------------------
    const auto now = m_clock->nowUtc();

    chrono_flow::domain::entities::Timer newTimer{
        boost::uuids::to_string(boost::uuids::random_generator()()),
        request.userId,
        request.taskId,
        now};

    m_timerRepo->add(newTimer);
    m_unitOfWork->registerNew(&newTimer);

    //-------------------------------------------------------------
    // 4. Commit transaction – persistence boundary.
    //-------------------------------------------------------------
    try
    {
        m_unitOfWork->commit();
    }
    catch (const std::exception& ex)
    {
        spdlog::error(
            "Failed to commit StartTimerCommand; err='{}' – rolling back", ex.what());
        m_unitOfWork->rollback();
        throw; // let upper layer translate this into 5xx
    }

    //-------------------------------------------------------------
    // 5. Publish domain event (async; out of transaction).
    //-------------------------------------------------------------
    events::TimerStartedEvent evt{
        newTimer.id(),
        newTimer.userId(),
        newTimer.taskId(),
        newTimer.startedAtUtc()};

    m_eventBus->publish(evt);

    //-------------------------------------------------------------
    // 6. Map to DTO for outward-facing layer.
    //-------------------------------------------------------------
    TimerDTO dto;
    dto.id           = newTimer.id();
    dto.userId       = newTimer.userId();
    dto.taskId       = newTimer.taskId();
    dto.startedAtUtc = newTimer.startedAtUtc();

    spdlog::debug("StartTimerCommand finished OK – timerId='{}'", dto.id);
    return dto;
}
```