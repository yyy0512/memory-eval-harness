```cpp
// chrono_flow_nexus/src/application/commands/start_timer_command.h
#pragma once

/**
 *  Copyright (c) 2024
 *  ChronoFlow Nexus — Productivity-centric time-tracking micro-service
 *
 *  Licensed under the MIT License (see LICENSE.md in the repository root for details)
 *
 *  This file defines the StartTimerCommand and its corresponding handler.
 *  The command lives in the Application layer and is agnostic of transport
 *  concerns.  It orchestrates the work necessary to start a timer for a task,
 *  delegating all state-ful operations to Domain and Infrastructure services.
 */

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>

#include "application/errors/command_validation_error.h"
#include "domain/common/strong_typedefs.h"           // UserId, TaskId
#include "domain/repositories/i_timer_repository.h"   // ITimerRepository
#include "domain/services/i_authorization_service.h"  // IAuthorizationService
#include "infrastructure/diagnostics/logger.h"        // ILogger
#include "infrastructure/diagnostics/tracing.h"       // TraceSpan

namespace chrono_flow::application::commands
{

/**
 *  Command object – an immutable DTO whose only responsibility is to capture
 *  intent in the most explicit, non-ambiguous form possible.
 */
class StartTimerCommand final
{
public:
    using Clock = std::chrono::system_clock;

    StartTimerCommand(domain::UserId           user_id,
                      domain::TaskId           task_id,
                      std::optional<Clock::time_point> start_time = std::nullopt)
        : _user_id{user_id}
        , _task_id{task_id}
        , _start_time{start_time.value_or(Clock::now())}
    {
        if (!_user_id || !_task_id)
        {
            throw application::errors::CommandValidationError{
                "StartTimerCommand must contain non-empty userId and taskId"};
        }
    }

    [[nodiscard]] domain::UserId           user_id() const noexcept { return _user_id; }
    [[nodiscard]] domain::TaskId           task_id() const noexcept { return _task_id; }
    [[nodiscard]] Clock::time_point        start_time() const noexcept { return _start_time; }

private:
    domain::UserId        _user_id;
    domain::TaskId        _task_id;
    Clock::time_point     _start_time;
};

/**
 *  Result DTO – returned by the handler so that upper layers (REST / GraphQL)
 *  can translate the outcome into a transport-level representation.
 */
struct StartTimerResult
{
    domain::TimerId            timer_id;
    StartTimerCommand::Clock::time_point actual_start_time;
};


/**
 *  Command Handler — encapsulates the application-level workflow necessary for
 *  starting a timer.  It orchestrates domain services, performs cross-cutting
 *  concerns (authorization, validation, logging, tracing) and returns a pure
 *  result.
 *
 *  Lifetime: usually scoped per request.  No state is preserved between calls.
 */
class StartTimerCommandHandler final
{
public:
    StartTimerCommandHandler(std::shared_ptr<domain::repositories::ITimerRepository> timer_repo,
                             std::shared_ptr<domain::services::IAuthorizationService> authz_svc,
                             std::shared_ptr<infrastructure::diagnostics::ILogger> logger)
        : _timer_repo{std::move(timer_repo)}
        , _authz_svc{std::move(authz_svc)}
        , _logger{std::move(logger)}
    {
        if (!_timer_repo || !_authz_svc || !_logger)
        {
            throw std::invalid_argument("StartTimerCommandHandler dependencies cannot be null");
        }
    }

    /**
     * Synchronously handle the command.  Throws on failure so that higher layers
     * can catch-and-translate to HTTP/GraphQL error responses.
     */
    [[nodiscard]]
    StartTimerResult handle(const StartTimerCommand& cmd)
    {
        using namespace std::chrono;

        infrastructure::diagnostics::TraceSpan span{"StartTimerCommandHandler::handle"};

        // 1. Authorization — ensure the caller is allowed to start a timer.
        if (!_authz_svc->can_start_timer(cmd.user_id(), cmd.task_id()))
        {
            _logger->warn("User {} attempted to start a timer for task {} without permission",
                          cmd.user_id(), cmd.task_id());
            throw std::runtime_error{"Forbidden — user lacks permission to start this timer"};
        }

        // 2. Domain-level invariant: verify no overlapping running timer exists.
        auto overlapping = _timer_repo->exists_running_timer(cmd.user_id());
        if (overlapping)
        {
            _logger->info("User {} already has an active timer ({}) — stopping it first",
                          cmd.user_id(), *overlapping);
            _timer_repo->stop_timer(*overlapping, cmd.start_time());
        }

        // 3. Persist the new timer.
        auto new_timer_id = _timer_repo->start_timer(cmd.user_id(),
                                                     cmd.task_id(),
                                                     cmd.start_time());

        _logger->info("Started timer {} for user {} on task {} @ {}",
                      new_timer_id, cmd.user_id(), cmd.task_id(),
                      duration_cast<milliseconds>(cmd.start_time().time_since_epoch()).count());

        // 4. Publish domain event (fire-and-forget).
        _timer_repo->publish_timer_started_event(new_timer_id, cmd.user_id(), cmd.task_id(), cmd.start_time());

        return StartTimerResult{new_timer_id, cmd.start_time()};
    }

private:
    std::shared_ptr<domain::repositories::ITimerRepository>    _timer_repo;
    std::shared_ptr<domain::services::IAuthorizationService>   _authz_svc;
    std::shared_ptr<infrastructure::diagnostics::ILogger>      _logger;
};

} // namespace chrono_flow::application::commands
```