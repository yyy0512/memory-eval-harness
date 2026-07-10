#pragma once
/**
 *  chrono_flow_nexus/src/application/commands/create_task_command.h
 *
 *  Copyright (c) ChronoFlow
 *
 *  High-level “application” command that orchestrates the creation of a new
 *  Task aggregate.  It is part of the Command side of the CQRS boundary: the
 *  command validates client-supplied data, converts it to a domain object,
 *  persists the aggregate through the repository, and emits an appropriate
 *  response DTO.
 *
 *  Because the header lives in the application layer, only interfaces
 *  belonging to the domain layer are referenced.  No infrastructure code
 *  should leak across this boundary—allowing the domain model to evolve
 *  independently from persistence concerns.
 */

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <boost/uuid/random_generator.hpp>
#include <boost/uuid/uuid.hpp>

#include "domain/entities/task.h"
#include "domain/repositories/task_repository.h"
#include "infrastructure/observability/logger.h"

namespace chrono_flow::application::commands {

/* ────────────────────────────────────────────────────────────────────────── */
/*  Error types                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

class CreateTaskError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class ValidationError final : public CreateTaskError {
public:
    explicit ValidationError(std::string msg) : CreateTaskError{std::move(msg)} {}
};

class PersistenceError final : public CreateTaskError {
public:
    explicit PersistenceError(std::string msg) : CreateTaskError{std::move(msg)} {}
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  DTOs                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

struct CreateTaskRequest {
    std::string                                  title;              // Mandatory – max 200 chars
    std::optional<std::string>                   description;        // Optional – free-form markdown
    std::optional<std::chrono::system_clock::time_point> due_date;   // Optional – UTC
    std::optional<std::uint32_t>                 estimated_minutes;  // Optional – ≥ 5
    std::string                                  owner_id;           // Mandatory – UUID string
    std::vector<std::string>                     labels;             // Optional – zero or more tags
};

struct CreateTaskResponse {
    boost::uuids::uuid task_id;
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  CreateTaskCommand                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

class CreateTaskCommand final {
public:
    /**
     *  Construct a CreateTaskCommand.
     *
     *  @param repo   Domain repository that persists Task aggregates.
     *  @param logger Application logger.
     */
    CreateTaskCommand(std::shared_ptr<domain::repositories::ITaskRepository> repo,
                      std::shared_ptr<infrastructure::observability::ILogger> logger)
        : repository_{std::move(repo)}
        , logger_{std::move(logger)}
    {
        if (!repository_) {
            throw std::invalid_argument{"CreateTaskCommand: repository pointer is null"};
        }
        if (!logger_) {
            throw std::invalid_argument{"CreateTaskCommand: logger pointer is null"};
        }
    }

    /**
     *  Execute the command; may throw CreateTaskError subclasses.
     */
    [[nodiscard]] CreateTaskResponse execute(const CreateTaskRequest& request) const
    {
        validate(request);

        // Create Task aggregate
        boost::uuids::uuid       task_id      = boost::uuids::random_generator()();
        domain::entities::Task   task{task_id,
                                      request.title,
                                      request.description.value_or(""),
                                      request.due_date,
                                      request.estimated_minutes,
                                      request.owner_id,
                                      request.labels,
                                      /* created_at = */ std::chrono::system_clock::now()};

        // Persist through repository
        try {
            repository_->persist(task);
        } catch (const std::exception& ex) {
            logger_->error("CreateTaskCommand::execute – persistence failed for task [{}]: {}",
                           boost::uuids::to_string(task_id),
                           ex.what());
            throw PersistenceError{"Failed to persist Task: " + std::string{ex.what()}};
        }

        logger_->info("Task [{}] successfully created (owner: {})",
                      boost::uuids::to_string(task_id),
                      request.owner_id);

        return CreateTaskResponse{task_id};
    }

private:
    /* Validate user-supplied data; throw ValidationError on breach. */
    void validate(const CreateTaskRequest& req) const
    {
        constexpr std::size_t kMaxTitleLength = 200;
        if (req.title.empty()) {
            throw ValidationError{"The 'title' field must not be empty"};
        }
        if (req.title.length() > kMaxTitleLength) {
            throw ValidationError{"The 'title' field exceeds the maximum length of 200 characters"};
        }
        if (req.estimated_minutes && *req.estimated_minutes < 5) {
            throw ValidationError{"The 'estimated_minutes' field must be at least 5 minutes"};
        }
        if (req.due_date && *req.due_date < std::chrono::system_clock::now()) {
            logger_->warn(
                "CreateTaskCommand::validate – due_date is in the past for user {}", req.owner_id);
        }
        // Additional business-rule validations can be added here in the future.
    }

    std::shared_ptr<domain::repositories::ITaskRepository>   repository_;
    std::shared_ptr<infrastructure::observability::ILogger>  logger_;
};

}  // namespace chrono_flow::application::commands