<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers;

use ProdSecureOrchestrator\Domain\EventProcessing\Core\DomainEventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Core\EventHandlerInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Routing\RouterStrategyInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Routing\ServiceEndpoint;
use ProdSecureOrchestrator\Infrastructure\ServiceMesh\ServiceRegistryInterface;
use ProdSecureOrchestrator\Infrastructure\Monitoring\LoggerInterface;
use ProdSecureOrchestrator\Domain\Exception\RoutingException;
use Throwable;

/**
 * Class RoutingHandler
 *
 * Responsible for determining where to route a given Domain Event next, based
 * on a pluggable RouterStrategy.  After successful routing, the handler passes
 * the event further down the Chain of Responsibility (if any).
 *
 * @package ProdSecureOrchestrator\Domain\EventProcessing\Handlers
 */
final class RoutingHandler implements EventHandlerInterface
{
    /**
     * @var EventHandlerInterface|null
     */
    private ?EventHandlerInterface $nextHandler = null;

    public function __construct(
        private readonly RouterStrategyInterface  $routerStrategy,
        private readonly ServiceRegistryInterface $serviceRegistry,
        private readonly LoggerInterface          $logger
    ) {
    }

    /**
     * Attach the next handler in the chain.
     *
     * @param EventHandlerInterface|null $handler
     * @return void
     */
    public function setNext(?EventHandlerInterface $handler): void
    {
        $this->nextHandler = $handler;
    }

    /**
     * Handles the event, routing it to one or more back-end services as
     * decided by the injected RouterStrategy implementation.
     *
     * @param DomainEventInterface $event
     * @throws RoutingException
     */
    public function handle(DomainEventInterface $event): void
    {
        try {
            /** @var ServiceEndpoint[] $targets */
            $targets = $this->routerStrategy->resolveTargets($event, $this->serviceRegistry);
        } catch (Throwable $e) {
            // Resolution failure is considered fatal for this handler
            $this->logger->error(
                sprintf(
                    'RouterStrategy "%s" failed to resolve targets for event "%s": %s',
                    $this->routerStrategy::class,
                    get_class($event),
                    $e->getMessage()
                ),
                ['exception' => $e]
            );
            throw new RoutingException('Unable to resolve routing targets.', previous: $e);
        }

        if (empty($targets)) {
            $this->logger->warning(
                sprintf(
                    'No routing target found for event "%s". The event will be passed unmodified to the next handler.',
                    get_class($event)
                )
            );
        }

        foreach ($targets as $endpoint) {
            try {
                $endpoint->dispatch($event);
                $this->logger->debug(
                    sprintf(
                        'Event "%s" successfully dispatched to endpoint "%s".',
                        get_class($event),
                        $endpoint->getIdentifier()
                    )
                );
            } catch (Throwable $e) {
                // Dispatch errors are logged, but we continue to attempt other endpoints
                $this->logger->error(
                    sprintf(
                        'Failed to dispatch event "%s" to endpoint "%s": %s',
                        get_class($event),
                        $endpoint->getIdentifier(),
                        $e->getMessage()
                    ),
                    ['exception' => $e]
                );
            }
        }

        // Continue down the Chain of Responsibility
        if ($this->nextHandler !== null) {
            $this->nextHandler->handle($event);
        }
    }
}
