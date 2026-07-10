// chrono_flow_nexus/src/application/commands/create_task_command.cpp
// ----------------------------------------------------------------------------
//  Copyright (c) ChronoFlow Contributors
//  SPDX-License-Identifier: BUSL-1.1
// ----------------------------------------------------------------------------
//
//  Implements the Create-Task application command.  The command sits in the
//  application layer and orchestrates input validation, domain construction,
//  persistence, and event-dispatching behind a single cohesive abstraction.
//
// ----------------------------------------------------------------------------

#include "application/commands/create_task_command.hpp"

#include <spdlog/spdlog.h>

#include "common/errors/operation_canceled_error.hpp"
#include "common/errors/validation_exception.hpp"
#include "common/observability/tracer.hpp"
#include "domain/entities/task.hpp"
#include "domain/repositories/task_repository.hpp"
#include "infrastructure/persistence/unit_of_work.hpp"
#include "infrastructure/validation/validator.hpp"

using chrono_flow::application::commands::CreateTaskCommand;
using chrono_flow::application::commands::CreateTaskCommandHandler;

namespace
{
constexpr char kTraceSpanName[] = "CreateTaskCommandHandler::Handle";
} // namespace

// -----------------------------------------------------------------------------
//  Constructor / DI wiring
// -----------------------------------------------------------------------------
CreateTaskCommandHandler::CreateTaskCommandHandler(
    std::shared_ptr<chrono_flow::domain::repositories::ITaskRepository>       taskRepository,
    std::shared_ptr<chrono_flow::infrastructure::persistence::IUnitOfWork>    unitOfWork,
    std::shared_ptr<chrono_flow::infrastructure::validation::IValidator<CreateTaskCommand>>
                                                                              validator,
    std::shared_ptr<chrono_flow::common::events::IEventDispatcher>            eventDispatcher) noexcept
    : m_taskRepository(std::move(taskRepository))
    , m_unitOfWork(std::move(unitOfWork))
    , m_validator(std::move(validator))
    , m_eventDispatcher(std::move(eventDispatcher))
{
    if (!m_taskRepository || !m_unitOfWork || !m_validator || !m_eventDispatcher)
    {
        throw std::invalid_argument(
            "CreateTaskCommandHandler – dependencies must not be null");
    }
}

// -----------------------------------------------------------------------------
//  Business logic
// -----------------------------------------------------------------------------
chrono_flow::domain::entities::TaskId
CreateTaskCommandHandler::Handle(const CreateTaskCommand& command,
                                 const common::CancellationToken& token)
{
    namespace entities    = chrono_flow::domain::entities;
    namespace observ      = chrono_flow::common::observability;

    // Early-exit if upstream has been cancelled
    if (token.IsCancellationRequested())
    {
        throw chrono_flow::common::errors::operation_canceled_error(
            "CreateTaskCommand canceled prior to execution");
    }

    // OpenTelemetry trace span – useful in distributed diagnostics
    auto span = observ::Tracer::StartSpan(kTraceSpanName);

    // 1) validate DTO
    const auto validationResult = m_validator->Validate(command);
    if (!validationResult.IsValid())
    {
        throw chrono_flow::common::errors::validation_exception(validationResult);
    }

    // 2) map DTO → domain entity
    entities::Task newTask(
        entities::TaskId::New(),
        command.accountId,
        command.title,
        command.description,
        command.estimateMinutes,
        command.dueAtUtc,
        entities::Task::Status::Planned);

    // 3) persist (transactional)
    auto tx = m_unitOfWork->BeginTransaction();

    try
    {
        m_taskRepository->Add(newTask);

        m_unitOfWork->Commit();   // flushes to database
        tx.Complete();            // marks RAII transaction as successful

        // 4) publish domain events post-commit
        m_eventDispatcher->DispatchAll(newTask.PullDomainEvents());

        spdlog::info("[CreateTask] account={} task={} title='{}'",
                     command.accountId.ToString(),
                     newTask.Id().ToString(),
                     command.title);

        return newTask.Id();
    }
    catch (...)
    {
        // rollback is automatic in tx dtor, but be explicit & log for clarity
        tx.Rollback();
        spdlog::error("[CreateTask] rolling back – exception re-thrown");
        throw; // propagate to caller
    }
}