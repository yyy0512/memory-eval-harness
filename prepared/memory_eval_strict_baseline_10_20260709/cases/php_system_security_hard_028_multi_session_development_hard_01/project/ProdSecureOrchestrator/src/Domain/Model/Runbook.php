```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Model;

use DateTimeImmutable;
use Exception;
use JsonSerializable;
use Ramsey\Uuid\Uuid;

/**
 * A Runbook is an aggregate root that represents a chain of remediation commands
 * to be executed in a deterministic order.  It contains meta-data for audit-trails,
 * versioning for optimistic-locking, and convenience helpers that orchestrate step
 * execution / rollback with granular error reporting.
 *
 * NOTE:  In a real-world code-base each enum / interface / exception would live in
 * its own file.  They are co-located here strictly to keep the snippet self-contained.
 */

/* ============================================================================
 * Domain Enums
 * ============================================================================*/
enum RunbookStatus: string
{
    case DRAFT        = 'draft';
    case IN_PROGRESS  = 'in_progress';
    case COMPLETED    = 'completed';
    case FAILED       = 'failed';
    case ROLLED_BACK  = 'rolled_back';
}

enum StepStatus: string
{
    case PENDING     = 'pending';
    case RUNNING     = 'running';
    case SUCCESS     = 'success';
    case FAILED      = 'failed';
    case ROLLED_BACK = 'rolled_back';
}

/* ============================================================================
 * Exceptions
 * ============================================================================*/
class RunbookException extends Exception {}
class RunbookValidationException extends RunbookException {}
class RunbookExecutionException extends RunbookException {}

/* ============================================================================
 * Context passed into every command.
 * Gives access to service-mesh discovery, secrets, current tenant, etc.
 * ============================================================================*/
final class RunbookContext
{
    public function __construct(
        public readonly string            $tenantId,
        public readonly array             $secrets,
        public readonly array             $serviceEndpoints, // e.g.  ['vault' => 'https://vault.local']
        public readonly ?DateTimeImmutable $triggeredAt = null,
    ) {
    }

    public function service(string $key): string
    {
        return $this->serviceEndpoints[$key]
            ?? throw new RunbookExecutionException("Service endpoint '{$key}' not found in context.");
    }
}

/* ============================================================================
 * Command Pattern Interface
 * ============================================================================*/
interface RunbookStepInterface extends JsonSerializable
{
    public function getId(): string;
    public function getName(): string;

    public function getStatus(): StepStatus;
    public function setStatus(StepStatus $status): void;

    /**
     * Execute the remediation logic. Must be idempotent.
     * @throws RunbookExecutionException
     */
    public function execute(RunbookContext $context): void;

    /**
     * Roll back the executed step.  Must be safe to call if the step hasn't been executed.
     * @throws RunbookExecutionException
     */
    public function rollback(RunbookContext $context): void;
}

/* ============================================================================
 * A trivial base implementation to speed up step authoring.
 * ============================================================================*/
abstract class AbstractRunbookStep implements RunbookStepInterface
{
    private StepStatus $status = StepStatus::PENDING;
    private readonly string $id;

    public function __construct(
        private readonly string $name,
    ) {
        $this->id = Uuid::uuid4()->toString();
    }

    public function getId(): string         { return $this->id; }
    public function getName(): string       { return $this->name; }
    public function getStatus(): StepStatus { return $this->status; }
    public function setStatus(StepStatus $status): void { $this->status = $status; }

    public function jsonSerialize(): mixed
    {
        return [
            'id'     => $this->id,
            'name'   => $this->name,
            'status' => $this->status->value,
        ];
    }
}

/* ============================================================================
 * Aggregate Root
 * ============================================================================*/
final class Runbook implements JsonSerializable
{
    /** @var RunbookStepInterface[] */
    private array $steps = [];

    private RunbookStatus     $status;
    private int               $version;
    private DateTimeImmutable $createdAt;
    private ?DateTimeImmutable $updatedAt = null;

    public function __construct(
        private readonly string $name,
        private ?string         $description = null,
    ) {
        $this->status    = RunbookStatus::DRAFT;
        $this->createdAt = new DateTimeImmutable();
        $this->version   = 1;
    }

    /* ----------------------------------------------------------------------
     *  Step Management
     * -------------------------------------------------------------------- */
    public function addStep(RunbookStepInterface $step): void
    {
        if ($this->status !== RunbookStatus::DRAFT) {
            throw new RunbookValidationException('Steps can only be modified while runbook is in DRAFT.');
        }

        $this->steps[$step->getId()] = $step;
        $this->touch();
    }

    public function removeStep(string $stepId): void
    {
        if ($this->status !== RunbookStatus::DRAFT) {
            throw new RunbookValidationException('Steps can only be modified while runbook is in DRAFT.');
        }

        if (!isset($this->steps[$stepId])) {
            throw new RunbookValidationException("Step '{$stepId}' does not exist in runbook.");
        }

        unset($this->steps[$stepId]);
        $this->touch();
    }

    /**
     * Ensure the runbook is valid prior to execution or persistence.
     * @throws RunbookValidationException
     */
    public function validate(): void
    {
        if (trim($this->name) === '') {
            throw new RunbookValidationException('Runbook name cannot be empty.');
        }

        if ($this->steps === []) {
            throw new RunbookValidationException('Runbook must have at least one step.');
        }
    }

    /* ----------------------------------------------------------------------
     *  Execution
     * -------------------------------------------------------------------- */
    /**
     * Executes the runbook step by step.  If any step fails, a best effort rollback
     * will be performed in reverse order.
     *
     * @throws RunbookExecutionException when execution fails irrecoverably.
     */
    public function execute(RunbookContext $context): void
    {
        $this->validate();

        if ($this->status === RunbookStatus::COMPLETED) {
            throw new RunbookExecutionException('Runbook has already completed successfully.');
        }
        if ($this->status === RunbookStatus::IN_PROGRESS) {
            throw new RunbookExecutionException('Runbook is already running.');
        }

        $this->status = RunbookStatus::IN_PROGRESS;
        $this->touch();

        $executedStack = [];

        try {
            foreach ($this->steps as $step) {
                /** @var RunbookStepInterface $step */
                $step->setStatus(StepStatus::RUNNING);
                $step->execute($context);
                $step->setStatus(StepStatus::SUCCESS);
                $executedStack[] = $step;
                $this->touch();
            }

            $this->status = RunbookStatus::COMPLETED;
            $this->touch(true);
        } catch (Exception $e) {
            // Mark the failed step
            if ($step ?? null) {
                $step->setStatus(StepStatus::FAILED);
            }

            $this->status = RunbookStatus::FAILED;
            $this->touch();

            // Attempt rollback for already executed steps in reverse order
            $this->rollback($context, $executedStack);

            throw new RunbookExecutionException(
                "Runbook execution failed at step '{$step->getName()}' with message: {$e->getMessage()}",
                previous: $e
            );
        }
    }

    /**
     * @param RunbookStepInterface[] $executedStack
     */
    private function rollback(RunbookContext $context, array $executedStack): void
    {
        foreach (array_reverse($executedStack) as $executedStep) {
            try {
                $executedStep->rollback($context);
                $executedStep->setStatus(StepStatus::ROLLED_BACK);
            } catch (Exception $rollbackException) {
                // Swallow exception but log; Runbook is still considered failed.
                // In production we would inject a logger here.
            }
        }

        $this->status = RunbookStatus::ROLLED_BACK;
        $this->touch(true);
    }

    /* ----------------------------------------------------------------------
     *  Accessors
     * -------------------------------------------------------------------- */
    public function getName(): string               { return $this->name; }
    public function getDescription(): ?string       { return $this->description; }
    public function getSteps(): array               { return array_values($this->steps); }
    public function getStatus(): RunbookStatus      { return $this->status; }
    public function getVersion(): int               { return $this->version; }
    public function getCreatedAt(): DateTimeImmutable { return $this->createdAt; }
    public function getUpdatedAt(): ?DateTimeImmutable { return $this->updatedAt; }

    /* ----------------------------------------------------------------------
     *  Helpers
     * -------------------------------------------------------------------- */
    private function touch(bool $finalize = false): void
    {
        $this->updatedAt = new DateTimeImmutable();
        if ($finalize === false) {
            $this->version++;
        }
    }

    public function jsonSerialize(): mixed
    {
        return [
            'name'        => $this->name,
            'description' => $this->description,
            'status'      => $this->status->value,
            'version'     => $this->version,
            'created_at'  => $this->createdAt->format(DateTimeImmutable::ATOM),
            'updated_at'  => $this->updatedAt?->format(DateTimeImmutable::ATOM),
            'steps'       => $this->steps,
        ];
    }
}
```