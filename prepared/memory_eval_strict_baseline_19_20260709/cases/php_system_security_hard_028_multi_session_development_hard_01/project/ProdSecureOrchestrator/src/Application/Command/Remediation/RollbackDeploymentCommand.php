```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\Command\Remediation;

use DateTimeImmutable;
use ProdSecureOrchestrator\Application\Command\CommandException;
use ProdSecureOrchestrator\Application\Command\CommandInterface;
use ProdSecureOrchestrator\Application\Event\Deployment\RollbackCompletedDomainEvent;
use ProdSecureOrchestrator\Application\Event\Deployment\RollbackFailedDomainEvent;
use ProdSecureOrchestrator\Application\Event\DomainEventDispatcherInterface;
use ProdSecureOrchestrator\Domain\Audit\AuditTrailServiceInterface;
use ProdSecureOrchestrator\Domain\Deployment\DeploymentManagerInterface;
use ProdSecureOrchestrator\Domain\Remediation\RollbackPolicyInterface;
use ProdSecureOrchestrator\Domain\Remediation\ValueObject\RollbackResult;
use Psr\Log\LoggerInterface;
use Symfony\Component\Lock\Exception\LockConflictedException;
use Symfony\Component\Lock\LockFactory;
use Symfony\Component\Lock\LockInterface;
use Throwable;

/**
 * RollbackDeploymentCommand
 *
 * Command that safely rolls back a deployment identified by its unique
 * deployment ID. The operation is guarded by a distributed lock to guarantee
 * idempotency across multiple application workers and audited for compliance
 * purposes.
 *
 * This command adheres to the Command Pattern used throughout the
 * ProdSecure Orchestrator to ensure every operational step is both reversible
 * and traceable.
 */
final class RollbackDeploymentCommand implements CommandInterface
{
    private const LOCK_TTL = 60; // Lock expires automatically after 1 minute.

    private LockInterface $lock;

    public function __construct(
        private readonly string $deploymentId,
        private readonly string $initiatedBy,
        private readonly DeploymentManagerInterface $deploymentManager,
        private readonly RollbackPolicyInterface $rollbackPolicy,
        private readonly AuditTrailServiceInterface $auditTrail,
        private readonly DomainEventDispatcherInterface $eventDispatcher,
        private readonly LoggerInterface $logger,
        private readonly LockFactory $lockFactory
    ) {
        $this->lock = $this->lockFactory->createLock(
            resource: sprintf('deployment.rollback.%s', $this->deploymentId),
            ttl: self::LOCK_TTL
        );
    }

    /**
     * Execute the command.
     *
     * @return RollbackResult
     *
     * @throws CommandException When the rollback cannot be completed.
     */
    public function execute(): RollbackResult
    {
        try {
            $this->acquireLock();
            $this->assertRollbackAllowed();

            $start = new DateTimeImmutable();
            $this->logger->info(
                'Rollback started',
                ['deployment_id' => $this->deploymentId, 'initiated_by' => $this->initiatedBy]
            );

            // Perform the actual rollback via the domain service.
            $details = $this->deploymentManager->rollback($this->deploymentId);

            $end      = new DateTimeImmutable();
            $duration = $end->getTimestamp() - $start->getTimestamp();

            // Build the result value-object.
            $result = new RollbackResult(
                deploymentId: $this->deploymentId,
                succeeded: true,
                details: $details,
                duration: $duration
            );

            // Audit & notify.
            $this->auditTrail->record(
                actor: $this->initiatedBy,
                action: 'deployment.rollback',
                target: $this->deploymentId,
                meta: [
                    'duration' => $duration,
                ]
            );

            $this->eventDispatcher->dispatch(
                new RollbackCompletedDomainEvent(
                    deploymentId: $this->deploymentId,
                    completedAt: $end,
                    initiatedBy: $this->initiatedBy,
                    duration: $duration
                )
            );

            $this->logger->info(
                'Rollback finished',
                [
                    'deployment_id' => $this->deploymentId,
                    'duration'      => $duration,
                    'initiated_by'  => $this->initiatedBy,
                ]
            );

            return $result;
        } catch (Throwable $e) {
            // Handle error gracefully and provide enriched context.
            $this->handleFailure($e);
            // Wrap and throw to keep interface stable.
            throw new CommandException(
                sprintf('Unable to rollback deployment "%s"', $this->deploymentId),
                previous: $e
            );
        } finally {
            $this->releaseLock();
        }
    }

    /**
     * Attempt to obtain the distributed lock for the rollback operation.
     *
     * @throws CommandException If the lock could not be acquired
     */
    private function acquireLock(): void
    {
        try {
            if (!$this->lock->acquire(true)) {
                throw new CommandException(
                    sprintf(
                        'Rollback for deployment "%s" is already being processed by another worker.',
                        $this->deploymentId
                    )
                );
            }
        } catch (LockConflictedException $e) {
            throw new CommandException(
                sprintf(
                    'Rollback for deployment "%s" is already being processed by another worker.',
                    $this->deploymentId
                ),
                previous: $e
            );
        }
    }

    private function assertRollbackAllowed(): void
    {
        if (!$this->rollbackPolicy->canRollback($this->deploymentId)) {
            throw new CommandException(
                sprintf(
                    'Active rollback policy does not permit rollback for deployment "%s".',
                    $this->deploymentId
                )
            );
        }
    }

    private function handleFailure(Throwable $error): void
    {
        $this->logger->error(
            'Rollback failed',
            [
                'deployment_id' => $this->deploymentId,
                'error'         => $error->getMessage(),
                'initiated_by'  => $this->initiatedBy,
            ]
        );

        $this->auditTrail->record(
            actor: $this->initiatedBy,
            action: 'deployment.rollback.failed',
            target: $this->deploymentId,
            meta: ['error' => $error->getMessage()]
        );

        $this->eventDispatcher->dispatch(
            new RollbackFailedDomainEvent(
                deploymentId: $this->deploymentId,
                failedAt: new DateTimeImmutable(),
                reason: $error->getMessage(),
                initiatedBy: $this->initiatedBy
            )
        );
    }

    /**
     * Ensure the lock is always released,
     * even in the case of unhandled exceptions.
     */
    private function releaseLock(): void
    {
        if ($this->lock->isAcquired()) {
            $this->lock->release();
        }
    }
}
```