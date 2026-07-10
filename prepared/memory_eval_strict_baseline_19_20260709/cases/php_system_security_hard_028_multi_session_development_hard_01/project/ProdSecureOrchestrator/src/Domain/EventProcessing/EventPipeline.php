```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing;

use DateTimeImmutable;
use Psr\Log\LoggerInterface;
use SplPriorityQueue;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;
use Throwable;
use ProdSecureOrchestrator\Domain\EventProcessing\Contract\EventHandlerInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contract\EventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Exception\PipelineTimeoutException;
use ProdSecureOrchestrator\Domain\EventProcessing\Exception\UnrecoverableHandlerFailure;
use ProdSecureOrchestrator\Domain\EventProcessing\ValueObject\EventContext;

/**
 * Class EventPipeline
 *
 * The EventPipeline orchestrates a series of {@see EventHandlerInterface} instances
 * (Chain-of-Responsibility) that are executed in priority order. Each handler can
 * choose to stop further propagation or enqueue asynchronous work.
 *
 * In addition, the pipeline:
 *  • Emits internal lifecycle notifications via Symfony EventDispatcher.
 *  • Records execution metrics for auditing/monitoring purposes.
 *  • Provides deterministic ordering through a stable priority queue.
 *
 * Typical usage:
 * <code>
 *  $pipeline = new EventPipeline([], $logger, $dispatcher);
 *  $pipeline->pushHandler(new AlertEscalationHandler(), priority: 100);
 *  $pipeline->process($event);
 * </code>
 */
final class EventPipeline
{
    /**
     * @var SplPriorityQueue<EventHandlerInterface>
     */
    private SplPriorityQueue $handlerQueue;

    private LoggerInterface             $logger;
    private EventDispatcherInterface    $dispatcher;
    private int                         $maxExecutionMillis;

    /**
     * @param iterable<EventHandlerInterface> $handlers
     * @param int                             $maxExecutionMillis Global timeout for a single event in milliseconds.
     */
    public function __construct(
        iterable $handlers,
        LoggerInterface $logger,
        EventDispatcherInterface $dispatcher,
        int $maxExecutionMillis = 10_000
    ) {
        $this->handlerQueue       = new SplPriorityQueue();
        $this->handlerQueue->setExtractFlags(SplPriorityQueue::EXTR_DATA); // we only care about the handler itself
        $this->logger             = $logger;
        $this->dispatcher         = $dispatcher;
        $this->maxExecutionMillis = $maxExecutionMillis;

        foreach ($handlers as $handler) {
            $this->pushHandler($handler);
        }
    }

    /**
     * Registers a new handler into the pipeline.
     *
     * @param int $priority Higher priority handlers run first (default = 0).
     */
    public function pushHandler(EventHandlerInterface $handler, int $priority = 0): void
    {
        // We use microtime(true) as tiebreaker to keep deterministic order when priorities match.
        $this->handlerQueue->insert([$handler, microtime(true)], $priority);
    }

    /**
     * Processes the given event synchronously.
     *
     * @throws PipelineTimeoutException       If processing time exceeds configured limit.
     * @throws UnrecoverableHandlerFailure    On unrecoverable handler exception.
     */
    public function process(EventInterface $event, ?EventContext $context = null): void
    {
        $startTime = microtime(true);
        $context   = $context ?? EventContext::fresh();

        $this->dispatcher->dispatch(new Lifecycle\EventPipelineStarted($event, $context));

        // Clone queue to avoid side-effects from reentrant modifications.
        $queue = clone $this->handlerQueue;
        while (!$queue->isEmpty()) {
            /** @var array{0: EventHandlerInterface, 1: float} $pack */
            $pack    = $queue->extract();
            $handler = $pack[0];

            if ($this->exceededTimeout($startTime)) {
                $this->dispatcher->dispatch(new Lifecycle\EventPipelineTimedOut($event, $context));
                $this->logger->error(
                    'Event processing timeout exceeded',
                    ['event' => $event::class, 'context' => $context->id()]
                );

                throw PipelineTimeoutException::forEvent($event::class, $this->maxExecutionMillis);
            }

            try {
                $result = $handler->handle($event, $context);
            } catch (Throwable $exception) {
                // The handler explicitly identifies if the failure is recoverable.
                if ($handler->supportsRecovery($exception)) {
                    $this->logger->warning(
                        'Recoverable error during event handling; continuing.',
                        [
                            'handler'   => $handler::class,
                            'exception' => $exception->getMessage(),
                            'event'     => $event::class,
                        ]
                    );
                    continue;
                }

                // Emit dispatch for global rescue subscribers.
                $this->dispatcher->dispatch(
                    new Lifecycle\EventHandlerFailed($event, $context, $handler, $exception)
                );

                $this->logger->critical(
                    'Unrecoverable error in event handler; aborting pipeline.',
                    [
                        'handler'   => $handler::class,
                        'exception' => $exception,
                        'event'     => $event::class,
                    ]
                );

                throw UnrecoverableHandlerFailure::fromHandler($handler::class, $exception);
            }

            // Handlers return a HandlerResult enum; STOP_PROCESSING breaks the loop.
            if ($result === HandlerResult::STOP_PROCESSING) {
                $this->logger->info(
                    'Event processing halted by handler.',
                    ['handler' => $handler::class, 'event' => $event::class]
                );
                break;
            }
        }

        $durationMs = (int) ((microtime(true) - $startTime) * 1000);

        $this->dispatcher->dispatch(new Lifecycle\EventPipelineFinished($event, $context, $durationMs));

        $this->logger->debug(
            'Event processed.',
            [
                'event'      => $event::class,
                'context'    => $context->id(),
                'handlers'   => $this->handlerQueue->count(),
                'durationMs' => $durationMs,
                'finishedAt' => (new DateTimeImmutable())->format('c'),
            ]
        );
    }

    private function exceededTimeout(float $startTime): bool
    {
        return (microtime(true) - $startTime) * 1000 >= $this->maxExecutionMillis;
    }
}

/**
 * Result codes returned by {@see EventHandlerInterface::handle} to indicate
 * how the pipeline should proceed.
 */
enum HandlerResult: int
{
    case CONTINUE         = 0;   // Continue to next handler.
    case STOP_PROCESSING  = 1;   // Halt pipeline; considered "handled".
    case HANDLED_ASYNC    = 2;   // Handled asynchronously; still continue.
}
```
