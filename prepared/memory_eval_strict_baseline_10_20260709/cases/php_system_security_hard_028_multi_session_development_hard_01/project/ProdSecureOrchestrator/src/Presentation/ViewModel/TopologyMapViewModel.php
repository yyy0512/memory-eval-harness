```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Presentation\ViewModel;

use ProdSecureOrchestrator\Domain\Service\TopologyServiceInterface;
use ProdSecureOrchestrator\Domain\DTO\TopologySnapshot;
use ProdSecureOrchestrator\Infrastructure\Event\EventBusInterface;
use ProdSecureOrchestrator\Infrastructure\Event\Events\TopologySnapshotUpdatedEvent;
use ProdSecureOrchestrator\Infrastructure\Exception\Runtime\ViewModelException;
use Psr\Log\LoggerInterface;
use SplObserver;
use SplSubject;

/**
 * TopologyMapViewModel
 *
 * The ViewModel that powers the real-time topology map widget.  It subscribes to
 * TopologyService updates (Observer Pattern), transforms domain snapshots into
 * UI-friendly data structures, and publishes change events to the front-end via
 * an EventBus.
 */
final class TopologyMapViewModel implements SplObserver
{
    private TopologyServiceInterface $topologyService;
    private EventBusInterface        $eventBus;
    private LoggerInterface          $logger;

    /**
     * Last cached snapshot.  Using cache avoids needless re-rendering when the
     * underlying data has not changed.
     */
    private ?TopologySnapshot $cachedSnapshot = null;

    /**
     * Indicates whether this ViewModel is currently registered as an observer
     * on the TopologyService.  Makes subscribe()/unsubscribe() idempotent.
     */
    private bool $isSubscribed = false;

    public function __construct(
        TopologyServiceInterface $topologyService,
        EventBusInterface        $eventBus,
        LoggerInterface          $logger
    ) {
        $this->topologyService = $topologyService;
        $this->eventBus        = $eventBus;
        $this->logger          = $logger;
    }

    /**
     * Returns the current topology in a format that can be JSON-encoded
     * directly by the controller or API layer.
     *
     * @return array{
     *     generated_at:int,
     *     nodes:array<int, array<string, mixed>>,
     *     links:array<int, array<string, mixed>>
     * }
     *
     * @throws ViewModelException When the snapshot cannot be retrieved.
     */
    public function getTopology(): array
    {
        try {
            $snapshot = $this->fetchLatestSnapshot();

            return [
                'generated_at' => $snapshot->generatedAt->getTimestamp(),
                'nodes'        => array_map(static fn($node) => $node->toArray(), $snapshot->nodes),
                'links'        => array_map(static fn($link) => $link->toArray(), $snapshot->links),
            ];
        } catch (\Throwable $e) {
            $this->logger->error('Unable to prepare topology for the view layer.', [
                'exception' => $e,
            ]);

            throw new ViewModelException(
                message: 'Failed to prepare topology data.',
                code:    0,
                previous: $e
            );
        }
    }

    /**
     * Observer Pattern — invoked whenever the TopologyService publishes an
     * update.  Refreshes the internal cache and broadcasts a UI update event.
     */
    public function update(SplSubject $subject): void
    {
        if (!$subject instanceof TopologyServiceInterface) {
            // Unknown subject — ignore but log at debug level.
            $this->logger->debug(sprintf(
                'TopologyMapViewModel received update from unexpected subject of type "%s".',
                $subject::class
            ));

            return;
        }

        try {
            $this->cachedSnapshot = $subject->takeSnapshot();

            $this->eventBus->dispatch(
                new TopologySnapshotUpdatedEvent($this->getTopology())
            );
        } catch (\Throwable $e) {
            // Observer implementations should never throw — just log the error.
            $this->logger->error('Failed to refresh topology snapshot inside ViewModel.', [
                'exception' => $e,
            ]);
        }
    }

    /**
     * Registers this ViewModel as an observer on the TopologyService.
     * Safe to call multiple times thanks to $isSubscribed guard.
     */
    public function subscribe(): void
    {
        if ($this->isSubscribed) {
            return;
        }

        $this->topologyService->attach($this);
        $this->isSubscribed = true;
    }

    /**
     * Detaches this ViewModel from the TopologyService.
     */
    public function unsubscribe(): void
    {
        if (!$this->isSubscribed) {
            return;
        }

        $this->topologyService->detach($this);
        $this->isSubscribed = false;
    }

    /**
     * Forces an immediate refresh of the cached snapshot and pushes an update
     * event, even if nothing changed.  Useful for manual "Refresh" buttons.
     *
     * @throws ViewModelException
     */
    public function refresh(): void
    {
        $this->cachedSnapshot = null;

        $this->eventBus->dispatch(
            new TopologySnapshotUpdatedEvent($this->getTopology())
        );
    }

    /**
     * Prevents observer-leak in long-running processes.
     */
    public function __destruct()
    {
        if ($this->isSubscribed) {
            $this->unsubscribe();
        }
    }

    /**
     * Retrieves the latest snapshot, pulling from cache when available.
     *
     * @throws ViewModelException
     */
    private function fetchLatestSnapshot(): TopologySnapshot
    {
        if ($this->cachedSnapshot === null) {
            $this->cachedSnapshot = $this->topologyService->takeSnapshot();
        }

        return $this->cachedSnapshot;
    }
}
```