<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\Command;

use ProdSecureOrchestrator\Domain\Command\CommandInterface;
use ProdSecureOrchestrator\Domain\Command\CommandResultInterface;
use ProdSecureOrchestrator\Application\Exception\CommandExecutionException;

/**
 * Contract for all Command handlers inside the ProdSecure Orchestrator.
 *
 * Handlers are part of the Command-Bus subsystem and are responsible for
 * executing the business logic embedded in a Command value object. They must
 * be stateless and idempotent so that the bus can safely retry commands in the
 * face of transient failures.
 *
 * To enable zero-configuration auto-wiring, each handler advertises the FQCN
 * of the Command it supports through {@see CommandHandlerInterface::getSupportedCommandClass()}.
 * The Command Bus will dispatch a command to the first handler whose supported
 * class matches exactly (`===`) the command’s runtime class.
 *
 * Error handling strategy:
 *   * Recoverable errors should be dealt with internally (e.g. retry, circuit-breaker).
 *   * Non-recoverable errors MUST throw {@see CommandExecutionException}. The
 *     bus will log/audit the exception and stop further processing.
 *
 * @template TCommand of CommandInterface
 */
interface CommandHandlerInterface
{
    /**
     * Returns the class name of the Command this handler can execute.
     *
     * The returned value MUST be a concrete class name and is used by the
     * Command Bus as a routing key. Returning an interface or an abstract class
     * is not supported and will lead to undefined behaviour.
     *
     * @return class-string<TCommand>
     */
    public static function getSupportedCommandClass(): string;

    /**
     * Executes the Command.
     *
     * Implementations may rely on infrastructure concerns (database, message
     * queues, external APIs) injected via constructor. The Command object
     * MUST NOT be mutated so that event-sourcing snapshots remain deterministic.
     *
     * @param TCommand $command
     * @return CommandResultInterface  A value object capturing the outcome.
     *
     * @throws CommandExecutionException If execution fails irrecoverably.
     */
    public function __invoke(CommandInterface $command): CommandResultInterface;
}