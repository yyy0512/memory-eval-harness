#pragma once
/**********************************************************************************************************************
 *  PaletteFlux GraphQL Studio – Command Bus
 *
 *  PaletteFlux GraphQL Studio is a creative-centric API platform that lets digital artists, game designers,
 *  and interactive storytellers compose, remix, and stream multilayer visual assets through a single GraphQL
 *  endpoint.  The CommandBus defined in this header is a core building block for the Command/Query–Separation
 *  (CQS) layer used by controllers to mutate the domain model in a predictable, testable way.
 *
 *  © 2023-present PaletteFlux contributors. Licensed under the Apache-2.0 License.
 *********************************************************************************************************************/

#include <any>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <stdexcept>
#include <string>
#include <typeindex>
#include <unordered_map>
#include <utility>

namespace paletteflux::core::services::commands {

/**
 * Exception thrown when attempting to register multiple handlers for the same command type.
 */
class CommandHandlerRegistrationException : public std::runtime_error {
public:
    explicit CommandHandlerRegistrationException(const std::string& msg)
        : std::runtime_error(msg) {}
};

/**
 * Exception thrown when no handler can be found for a dispatched command.
 */
class CommandHandlerNotFoundException : public std::runtime_error {
public:
    explicit CommandHandlerNotFoundException(const std::string& msg)
        : std::runtime_error(msg) {}
};

/**
 * Marker base class for all Commands.  A command represents an intention to mutate state
 * and optionally returns a result once executed by a handler.
 */
class ICommandBase {
public:
    virtual ~ICommandBase() = default;
};

/**
 * Generic command type.  The template parameter denotes the result returned by a handler.
 *
 * Example:
 *     struct CreateLayerCommand : public ICommand<LayerId> { ... };
 */
template <typename TResult>
class ICommand : public ICommandBase {
public:
    using ResultType = TResult;
    virtual ~ICommand() = default;
};

/**
 * Interface that every command handler must implement.
 * Each handler is responsible for a single Command type.
 */
template <typename TCommand>
class ICommandHandler {
public:
    using CommandType = TCommand;
    using ResultType  = typename TCommand::ResultType;

    virtual ~ICommandHandler() = default;

    /**
     * Processes the supplied command and returns the resulting value.
     * Implementations should be side-effect free other than intentional state changes.
     */
    virtual ResultType handle(const CommandType& command) = 0;
};

/**
 * Thread-safe in-memory bus responsible for routing commands to their registered handlers.
 * Controller components interact exclusively with this façade to mutate application state.
 */
class CommandBus {
public:
    CommandBus() = default;
    CommandBus(const CommandBus&)            = delete;
    CommandBus& operator=(const CommandBus&) = delete;

    /**
     * Registers a handler instance for the specified command type.
     *
     * Thread-safery: write-lock.
     *
     * @throws CommandHandlerRegistrationException if a handler is already registered.
     */
    template <typename TCommand>
    void registerHandler(std::shared_ptr<ICommandHandler<TCommand>> handler)
    {
        static_assert(std::is_base_of_v<ICommandBase, TCommand>,
                      "TCommand must inherit from ICommand<>");

        const std::type_index key(typeid(TCommand));

        std::unique_lock lock(mutex_);

        auto [it, inserted] =
            handlers_.emplace(key,
                              std::make_unique<HandlerModel<TCommand>>(std::move(handler)));

        if (!inserted) {
            throw CommandHandlerRegistrationException(
                "Handler already registered for command type: " + std::string(key.name()));
        }
    }

    /**
     * Dispatches a command instance to its registered handler and returns the handler's result.
     *
     * Thread-safety: read-lock.
     *
     * @throws CommandHandlerNotFoundException if no handler has been registered.
     * @throws std::runtime_error              if the stored handler’s result type mismatches.
     */
    template <typename TCommand>
    typename TCommand::ResultType dispatch(const TCommand& command) const
    {
        static_assert(std::is_base_of_v<ICommandBase, TCommand>,
                      "TCommand must inherit from ICommand<>");

        const std::type_index key(typeid(TCommand));

        std::shared_lock lock(mutex_);

        auto it = handlers_.find(key);
        if (it == handlers_.end()) {
            throw CommandHandlerNotFoundException(
                "No handler registered for command type: " + std::string(key.name()));
        }

        std::any resultAny = it->second->handle(command);

        try {
            return std::any_cast<typename TCommand::ResultType>(resultAny);
        } catch (const std::bad_any_cast&) {
            throw std::runtime_error("Return type mismatch when dispatching command type: " +
                                     std::string(key.name()));
        }
    }

private:
    /**
     * Type-erased polymorphic base class that allows storage of heterogeneous handler types
     * under a unified pointer for runtime dispatching.
     */
    class HandlerConcept {
    public:
        virtual ~HandlerConcept()                    = default;
        virtual std::any handle(const ICommandBase&) = 0;
    };

    /**
     * Concrete wrapper over an ICommandHandler<TCommand>.  Implements the type-erased interface.
     */
    template <typename TCommand>
    class HandlerModel final : public HandlerConcept {
    public:
        explicit HandlerModel(std::shared_ptr<ICommandHandler<TCommand>> handler)
            : handler_(std::move(handler))
        {
        }

        std::any handle(const ICommandBase& base) override
        {
            // We trust the bus to supply the correct concrete type.
            const auto& cmd = dynamic_cast<const TCommand&>(base);
            return std::any(handler_->handle(cmd));
        }

    private:
        std::shared_ptr<ICommandHandler<TCommand>> handler_;
    };

    mutable std::shared_mutex mutex_;
    std::unordered_map<std::type_index, std::unique_ptr<HandlerConcept>> handlers_;
};

}  // namespace paletteflux::core::services::commands