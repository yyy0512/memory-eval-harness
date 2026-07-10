```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\Command;

use DateTimeInterface;
use JsonSerializable;
use Throwable;
use ProdSecureOrchestrator\Application\Command\Exception\NonUndoableCommandException;

/**
 * Interface CommandInterface
 *
 * Contract for every Command Pattern implementation issued and executed by the
 * ProdSecure Orchestrator.  A command encapsulates one discrete, atomic
 * remediation or automation step and is designed to be:
 *
 *  • Serializable (for audit-trails, queues, and distributed execution)
 *  • Self-sufficient (contains all data needed to execute on a remote worker)
 *  • Optionally undoable (safe rollback on failure)
 *
 * All implementing classes SHOULD be immutable and MUST NOT produce
 * side-effects until {@see execute()} is called.
 */
interface CommandInterface extends JsonSerializable
{
    public const PRIORITY_LOW      = 100;
    public const PRIORITY_NORMAL   = 200;
    public const PRIORITY_HIGH     = 300;
    public const PRIORITY_CRITICAL = 400;

    /**
     * Executes the command.
     *
     * @param CommandContext $context Provides infrastructure adapters,
     *                                telemetry collectors and security scopes
     *                                required by the command to run.
     *
     * @return CommandResult Represents the outcome (success, failure, metrics,
     *                       timings, etc.).
     *
     * @throws Throwable Any unhandled exception is considered a failure and is
     *                   propagated to the orchestrator, which will handle
     *                   alerting, retries and compensations.
     */
    public function execute(CommandContext $context): CommandResult;

    /**
     * Reverts the changes made by {@see execute()} when possible.
     *
     * Implementations must guarantee idempotency: calling undo multiple times
     * SHOULD NOT introduce additional side-effects.
     *
     * @param CommandContext $context Same contextual data passed to execute.
     *
     * @return CommandResult|null A result object or null when nothing had to be
     *                            undone (e.g., dry-run).
     *
     * @throws NonUndoableCommandException If the command cannot be safely
     *                                     reverted.
     * @throws Throwable                   On any unrecoverable error during
     *                                     rollback.
     */
    public function undo(CommandContext $context): ?CommandResult;

    /**
     * A short, human-friendly name such as "DisableUserAccount".
     */
    public function getName(): string;

    /**
     * Globally unique identifier for this command instance.  Must remain stable
     * for the lifetime of the object and safe for use as a primary key.
     */
    public function getUuid(): string;

    /**
     * Creation timestamp (UTC).
     */
    public function getCreatedAt(): DateTimeInterface;

    /**
     * Indicates whether the command supports {@see undo()}.
     */
    public function isUndoable(): bool;

    /**
     * Determines scheduler precedence.  Higher numbers take priority.
     *
     * @return int One of the PRIORITY_* constants or a custom value
     *             between 0-1000.
     */
    public function getPriority(): int;

    /**
     * Serialises the command into a flat associative array suitable for JSON
     * encoding, persistence, or transport over the wire.
     *
     * @return array<string,mixed>
     */
    public function toArray(): array;

    /**
     * Re-hydrates a command instance from a previously exported payload.
     *
     * @param array<string,mixed> $payload Original data returned by {@see toArray()}.
     *
     * @return static
     */
    public static function fromArray(array $payload): self;
}
```