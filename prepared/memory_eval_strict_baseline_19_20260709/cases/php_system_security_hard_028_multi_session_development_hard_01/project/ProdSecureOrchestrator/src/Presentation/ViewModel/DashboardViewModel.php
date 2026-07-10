```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Presentation\ViewModel;

use DateTime;
use DateTimeImmutable;
use DateTimeZone;
use JsonSerializable;
use SplObjectStorage;
use SplObserver;
use SplSubject;
use Throwable;
use Psr\Log\LoggerInterface;
use ProdSecureOrchestrator\Application\Command\Alert\EscalateAlertCommand;
use ProdSecureOrchestrator\Application\Command\Backup\TriggerBackupCommand;
use ProdSecureOrchestrator\Application\Command\CommandBusInterface;
use ProdSecureOrchestrator\Application\Exception\CommandDispatchException;
use ProdSecureOrchestrator\Domain\Alert\AlertStreamServiceInterface;
use ProdSecureOrchestrator\Domain\Backup\BackupStatusServiceInterface;
use ProdSecureOrchestrator\Domain\Deployment\DeploymentAutomationServiceInterface;
use ProdSecureOrchestrator\Domain\Metrics\PerformanceMetricsServiceInterface;
use ProdSecureOrchestrator\Presentation\Exception\ViewModelException;

/**
 * DashboardViewModel
 *
 * Acts as the bridge between the domain layer and the presentation layer.
 * Exposes a real-time, observable representation of the system state so that
 * UI widgets can reactively update themselves without directly depending on
 * domain services.
 */
final class DashboardViewModel implements SplSubject
{
    private SplObjectStorage $observers;

    public function __construct(
        private readonly AlertStreamServiceInterface $alertStream,
        private readonly PerformanceMetricsServiceInterface $metricsService,
        private readonly BackupStatusServiceInterface $backupService,
        private readonly DeploymentAutomationServiceInterface $deploymentService,
        private readonly CommandBusInterface $commandBus,
        private readonly LoggerInterface $logger,
    ) {
        $this->observers = new SplObjectStorage();
    }

    /* -----------------------------------------------------------------
     |  Observer pattern plumbing
     | -----------------------------------------------------------------
     */

    public function attach(SplObserver $observer): void
    {
        $this->observers->attach($observer);
    }

    public function detach(SplObserver $observer): void
    {
        $this->observers->detach($observer);
    }

    public function notify(): void
    {
        foreach ($this->observers as $observer) {
            $observer->update($this);
        }
    }

    /* -----------------------------------------------------------------
     |  Snapshot & polling
     | -----------------------------------------------------------------
     */

    private ?DashboardSnapshot $snapshot = null;
    private string $lastChecksum = '';

    /**
     * Actively polls all domain services and, if the aggregated system-state
     * has changed, notifies any attached observers.
     *
     * @throws ViewModelException
     */
    public function poll(): void
    {
        try {
            $snapshot = new DashboardSnapshot(
                alerts:      $this->alertStream->currentActiveAlerts(),
                metrics:     $this->metricsService->collectLatest(),
                backups:     $this->backupService->latestBackupStatuses(),
                deployments: $this->deploymentService->recentDeployments(),
                capturedAt:  new DateTimeImmutable('now', new DateTimeZone('UTC')),
            );
        } catch (Throwable $e) {
            $this->logger->critical('DashboardViewModel polling failed.', ['exception' => $e]);

            throw new ViewModelException('Unable to poll dashboard data.', 0, $e);
        }

        $checksum = $snapshot->checksum();

        // Only push updates if something actually changed.
        if ($checksum !== $this->lastChecksum) {
            $this->snapshot     = $snapshot;
            $this->lastChecksum = $checksum;
            $this->notify();
        }
    }

    /**
     * Returns the most recent snapshot, lazily polling once on first call.
     *
     * @throws ViewModelException
     */
    public function snapshot(): DashboardSnapshot
    {
        if ($this->snapshot === null) {
            $this->poll();
        }

        return $this->snapshot;
    }

    /* -----------------------------------------------------------------
     |  User-initiated actions (Command pattern)
     | -----------------------------------------------------------------
     */

    /**
     * Escalates an alert by dispatching an EscalateAlertCommand through
     * the application command bus.
     */
    public function escalateAlert(string $alertId): void
    {
        $this->dispatchCommand(new EscalateAlertCommand($alertId));
    }

    /**
     * On-demand backup trigger for a specific node.
     */
    public function triggerBackup(string $nodeId): void
    {
        $this->dispatchCommand(new TriggerBackupCommand($nodeId));
    }

    /**
     * Generic, fail-safe command dispatcher that wraps the Command Bus with
     * logging and typed error handling for the ViewModel layer.
     *
     * @throws ViewModelException
     */
    public function dispatchCommand(object $command): void
    {
        try {
            $this->commandBus->dispatch($command);
        } catch (CommandDispatchException|Throwable $e) {
            $this->logger->error('Command dispatch failed.', [
                'command'   => get_debug_type($command),
                'exception' => $e,
            ]);

            throw new ViewModelException('Command dispatch failed.', 0, $e);
        }
    }
}

/* -------------------------------------------------------------------------
 |  Supporting value-objects
 | -------------------------------------------------------------------------
*/

/**
 * Immutable data-transfer object representing a point-in-time snapshot of the
 * dashboard state. Implements JsonSerializable for easy consumption by the
 * presentation layer (e.g., JSON responses or template engines).
 */
final class DashboardSnapshot implements JsonSerializable
{
    /**
     * @param list<AlertDto>        $alerts
     * @param PerformanceMetricsDto $metrics
     * @param list<BackupStatusDto> $backups
     * @param list<DeploymentDto>   $deployments
     */
    public function __construct(
        private readonly array              $alerts,
        private readonly object             $metrics,
        private readonly array              $backups,
        private readonly array              $deployments,
        private readonly DateTimeImmutable  $capturedAt,
    ) {
    }

    /**
     * Provides a stable checksum used to detect state changes without needing
     * deep object comparison.
     */
    public function checksum(): string
    {
        return hash(
            'sha256',
            serialize([
                'alerts'      => $this->alerts,
                'metrics'     => $this->metrics,
                'backups'     => $this->backups,
                'deployments' => $this->deployments,
            ]),
        );
    }

    public function jsonSerialize(): array
    {
        return [
            'alerts'      => $this->alerts,
            'metrics'     => $this->metrics,
            'backups'     => $this->backups,
            'deployments' => $this->deployments,
            'captured_at' => $this->capturedAt->format(DateTime::ATOM),
        ];
    }

    /** @return list<AlertDto> */
    public function alerts(): array
    {
        return $this->alerts;
    }

    public function metrics(): object
    {
        return $this->metrics;
    }

    /** @return list<BackupStatusDto> */
    public function backups(): array
    {
        return $this->backups;
    }

    /** @return list<DeploymentDto> */
    public function deployments(): array
    {
        return $this->deployments;
    }

    public function capturedAt(): DateTimeImmutable
    {
        return $this->capturedAt;
    }
}
```