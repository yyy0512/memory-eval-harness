#pragma once
/*****************************************************************************************
 * File:    CreateAssetCommandHandler.h
 * Project: PaletteFlux GraphQL Studio  (api_graphql)
 *
 * Copyright © PaletteFlux
 *
 * Description:
 *   Concrete command-handler responsible for the “create asset” use-case.  The handler
 *   performs syntactic / semantic validation, persists the new domain object through the
 *   repository / unit-of-work abstraction, emits a corresponding domain event, and
 *   returns the newly materialised model instance back to the caller (typically a
 *   controller or GraphQL resolver).
 *
 *   The implementation follows CQRS / Command-Query Separation and is designed to be
 *   instantiated by an IoC container (e.g. Boost.DI, cpp-di, or a bespoke factory).
 *
 * Usage example:
 *   auto handler = container.Resolve<CreateAssetCommandHandler>();
 *   auto asset   = handler.Handle(CreateAssetCommand{ ... });
 *
 *****************************************************************************************/

#include <memory>
#include <string>
#include <utility>
#include <chrono>
#include <exception>
#include <stdexcept>
#include <system_error>

#include "core/common/UUID.h"
#include "core/domain/Asset.h"
#include "core/services/commands/CreateAssetCommand.h"
#include "core/services/commands/ICommandHandler.h"
#include "core/persistence/IAssetRepository.h"
#include "core/persistence/IUnitOfWork.h"
#include "core/infrastructure/events/IEventBus.h"
#include "core/infrastructure/events/AssetCreatedEvent.h"
#include "core/services/validation/IValidator.h"
#include "core/telemetry/Tracing.h"
#include "core/exceptions/ApplicationError.h"

namespace paletteflux::studio::core::services::commands
{

/**
 * Production-grade handler for CreateAssetCommand.
 *
 * Thread-safety: the handler stores only shared_ptr-managed service references that must
 * themselves guarantee either immutability or internal synchronisation whenever used in a
 * multi-threaded environment (e.g. by REST/GraphQL controllers executing in a thread
 * pool).  The handler itself is stateless after construction and is therefore safe to be
 * used concurrently.
 */
class CreateAssetCommandHandler final :
    public ICommandHandler<CreateAssetCommand, std::shared_ptr<domain::Asset>>
{
public:
    /**
     * Ctor injected with required service collaborators.
     *
     * @param repository  Repository façade for Asset aggregates.
     * @param unitOfWork  Transaction boundary for atomic persistence.
     * @param eventBus    Event dispatcher for eventual consistency.
     * @param validator   Strategy that validates incoming commands.
     *
     * @throws std::invalid_argument if any dependency is null.
     */
    CreateAssetCommandHandler(
        std::shared_ptr<persistence::IAssetRepository>                         repository,
        std::shared_ptr<persistence::IUnitOfWork>                              unitOfWork,
        std::shared_ptr<infrastructure::events::IEventBus>                    eventBus,
        std::shared_ptr<services::validation::IValidator<CreateAssetCommand>> validator)
        : m_repository(std::move(repository))
        , m_unitOfWork(std::move(unitOfWork))
        , m_eventBus(std::move(eventBus))
        , m_validator(std::move(validator))
    {
        if (!m_repository || !m_unitOfWork || !m_eventBus || !m_validator)
        {
            throw std::invalid_argument(
                "CreateAssetCommandHandler: all constructor parameters must be non-null.");
        }
    }

    /**
     * Handles the CreateAssetCommand.
     *
     * @param command Immutable command DTO.
     * @return Newly created Asset aggregate.
     *
     * @throws services::validation::ValidationError on validation failure.
     * @throws ApplicationError                      on business rule violation.
     * @throws persistence::PersistenceError         on repository / DB failure.
     */
    [[nodiscard]]
    std::shared_ptr<domain::Asset> Handle(const CreateAssetCommand& command) override
    {
        // ---------------------------------------------------------------------------------
        // Distributed tracing span – automatically finished on scope exit.
        // ---------------------------------------------------------------------------------
        auto span = telemetry::Tracing::StartSpan("CreateAssetCommandHandler::Handle");
        span->SetAttribute("asset.type", command.assetType);
        span->SetAttribute("asset.author", command.requestedBy);

        try
        {
            // --------------------------------------------------------------------------
            // 1. Validate command (sync).  This includes defensive duplication check.
            // --------------------------------------------------------------------------
            m_validator->ValidateOrThrow(command);

            if (m_repository->Exists(command.id))
            {
                throw ApplicationError(
                    "Asset with id '" + command.id.ToString() + "' already exists.",
                    ApplicationErrorCode::DuplicateResource);
            }

            // --------------------------------------------------------------------------
            // 2. Create aggregate root and persist through repository/UoW.
            // --------------------------------------------------------------------------
            auto nowUtc = std::chrono::system_clock::now();

            auto asset = std::make_shared<domain::Asset>(
                command.id,
                command.assetType,
                command.name,
                command.metadata,
                command.requestedBy,
                nowUtc);

            m_repository->Add(asset);

            // Unit-of-work guarantees atomicity (commit/rollback semantics).
            m_unitOfWork->Commit();

            // --------------------------------------------------------------------------
            // 3. Publish domain event for downstream consumers (async).
            // --------------------------------------------------------------------------
            infrastructure::events::AssetCreatedEvent evt
            {
                .assetId      = asset->Id(),
                .assetType    = asset->Type(),
                .createdBy    = asset->Author(),
                .createdAtUtc = asset->CreatedAtUtc()
            };
            m_eventBus->Publish(evt);

            // --------------------------------------------------------------------------
            // 4. Return the freshly created aggregate.
            // --------------------------------------------------------------------------
            return asset;
        }
        catch (const services::validation::ValidationError& ex)
        {
            span->SetError(ex.what());
            throw; // rethrow – caller will map to HTTP 422 / GraphQL user error
        }
        catch (const std::exception& ex)
        {
            span->SetError(ex.what());
            // Translate to a domain-specific error to avoid leaking implementation details.
            throw ApplicationError(
                std::string("Failed to create asset: ") + ex.what(),
                ApplicationErrorCode::UnhandledException);
        }
    }

private:
    std::shared_ptr<persistence::IAssetRepository>                         m_repository;
    std::shared_ptr<persistence::IUnitOfWork>                              m_unitOfWork;
    std::shared_ptr<infrastructure::events::IEventBus>                    m_eventBus;
    std::shared_ptr<services::validation::IValidator<CreateAssetCommand>> m_validator;
};

} // namespace paletteflux::studio::core::services::commands