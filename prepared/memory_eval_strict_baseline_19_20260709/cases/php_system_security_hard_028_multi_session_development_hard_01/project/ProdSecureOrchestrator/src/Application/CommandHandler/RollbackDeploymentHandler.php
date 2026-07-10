<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\CommandHandler;

use ProdSecureOrchestrator\Application\Command\RollbackDeploymentCommand;
use ProdSecureOrchestrator\Application\Contracts\CommandHandlerInterface;
use ProdSecureOrchestrator\Domain\Event\DeploymentRolledBackEvent;
use ProdSecureOrchestrator\Domain\Exception\DeploymentNotFoundException;
use ProdSecureOrchestrator\Domain\Exception\DeploymentRollbackException;
use ProdSecureOrchestrator\Domain\Model\Deployment;
use ProdSecureOrchestrator\Domain\Repository\DeploymentRepositoryInterface;
use ProdSecureOrchestrator\Domain\Service\DeploymentServiceInterface;
use ProdSecureOrchestrator\Infrastructure\CircuitBreaker\CircuitBreakerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\Messenger\Exception\UnrecoverableMessageHandlingException;
use Symfony\Component\Messenger\Stamp\HandledStamp;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;
use Throwable;

/**
 * CommandHandler responsible for rolling back a previously executed deployment.
 *
 * This implementation keeps side-effects to a minimum and offloads the heavy-lifting
 * to the domain services to remain thin and testable. Transaction boundaries are
 * delegated to the repository or underlying ORM so that the handler stays agnostic
 * of persistence details.
 */
class RollbackDeploymentHandler implements CommandHandlerInterface
{
    private DeploymentRepositoryInterface $deploymentRepository;
    private DeploymentServiceInterface    $deploymentService;
    private EventDispatcherInterface      $dispatcher;
    private CircuitBreakerInterface       $circuitBreaker;
    private LoggerInterface               $logger;

    public function __construct(
        DeploymentRepositoryInterface $deploymentRepository,
        DeploymentServiceInterface    $deploymentService,
        EventDispatcherInterface      $dispatcher,
        CircuitBreakerInterface       $circuitBreaker,
        LoggerInterface               $logger
    ) {
        $this->deploymentRepository = $deploymentRepository;
        $this->deploymentService    = $deploymentService;
        $this->dispatcher           = $dispatcher;
        $this->circuitBreaker       = $circuitBreaker;
        $this->logger               = $logger;
    }

    /**
     * @throws UnrecoverableMessageHandlingException
     */
    public function __invoke(RollbackDeploymentCommand $command): void
    {
        // Guard: circuit breaker open -> short-circuit to avoid cascading failures.
        if ($this->circuitBreaker->isOpen()) {
            $this->logger->warning(
                'Rollback request skipped: circuit breaker is open.',
                ['deploymentId' => $command->deploymentId()]
            );

            throw new UnrecoverableMessageHandlingException(
                'Rollback short-circuited because circuit breaker is open'
            );
        }

        /** @var Deployment|null $deployment */
        $deployment = $this->deploymentRepository->find($command->deploymentId());

        // Guard: ensure the target deployment exists.
        if ($deployment === null) {
            $this->logger->error(
                'Deployment to rollback not found.',
                ['deploymentId' => $command->deploymentId()]
            );

            throw new DeploymentNotFoundException(
                sprintf('Deployment "%s" not found.', $command->deploymentId())
            );
        }

        // Guard: ensure the deployment can be rolled back.
        if (!$deployment->canRollback()) {
            $this->logger->notice(
                'Rollback skipped: deployment is not in a rollback-able state.',
                ['deploymentId' => $deployment->id(), 'status' => $deployment->status()]
            );

            // No exception thrown ‑ we treat this as a no-op for idempotency.
            return;
        }

        try {
            // The actual rollback logic resides in the domain service.
            $this->deploymentService->rollback($deployment);

            // Persist new deployment state atomically.
            $this->deploymentRepository->save($deployment);

            // Emit domain event for observers & further integrations.
            $this->dispatcher->dispatch(
                new DeploymentRolledBackEvent($deployment),
                DeploymentRolledBackEvent::NAME
            );

            $this->logger->info(
                'Deployment rolled back successfully.',
                ['deploymentId' => $deployment->id()]
            );
        } catch (Throwable $e) {
            $this->logger->critical(
                'Rollback failed.',
                [
                    'deploymentId' => $deployment->id(),
                    'exception'    => $e->getMessage(),
                ]
            );

            $this->circuitBreaker->recordFailure();

            // The circuit breaker will transition state depending on failure threshold.
            throw new DeploymentRollbackException(
                sprintf('Unable to rollback deployment "%s": %s', $deployment->id(), $e->getMessage()),
                0,
                $e
            );
        }

        // Mark a successful operation for the circuit breaker to potentially close.
        $this->circuitBreaker->recordSuccess();
    }

    /**
     * Symfony Messenger compatibility wrapper method.
     *
     * This keeps the class PSR-12 compliant while enabling automatic handler registration
     * through Messenger's component service discovery.
     */
    public function handle(RollbackDeploymentCommand $command): HandledStamp
    {
        $this($command); // Proxy to the __invoke method
        return new HandledStamp(null, self::class);
    }
}