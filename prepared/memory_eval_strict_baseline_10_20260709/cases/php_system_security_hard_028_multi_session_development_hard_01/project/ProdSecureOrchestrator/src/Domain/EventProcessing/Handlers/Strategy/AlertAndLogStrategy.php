```php
<?php
/**
 * This file is part of the ProdSecure Orchestrator package.
 *
 * (c) 2024 ProdSecure Inc. <opensource@prodsecure.com>
 *
 * For the full copyright and license information, please view
 * the LICENSE file that was distributed with this source code.
 */

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Strategy;

use ProdSecureOrchestrator\Contracts\Alerting\AlertDispatcherInterface;
use ProdSecureOrchestrator\Contracts\Monitoring\MetricsCollectorInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\DomainEventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\HandlerStrategyInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\SeverityAwareEventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\ValueObject\HandlerResponse;
use ProdSecureOrchestrator\Domain\Shared\Enum\Severity;
use Psr\Log\LoggerInterface;
use Symfony\Component\RateLimiter\RateLimiterFactory;
use Symfony\Component\RateLimiter\RateLimiterInterface;
use Throwable;

/**
 * AlertAndLogStrategy
 *
 * A Strategy-pattern implementation that is responsible for
 *  1. Persisting every incoming event to a PSR-3–compatible log channel
 *  2. Dispatching an alert (e-mail, Slack, PagerDuty, etc.) for events that
 *     reach at least MEDIUM severity
 *  3. Recording associated Prometheus/OpenTelemetry metrics
 *
 * The class purposefully swallows internal exceptions so that the
 * chain-of-responsibility pipeline remains uninterrupted.
 */
final class AlertAndLogStrategy implements HandlerStrategyInterface
{
    /** PSR-3 logger for raw event lines */
    private LoggerInterface $logger;

    /** Abstraction around vendor-specific alerting channels */
    private AlertDispatcherInterface $alertDispatcher;

    /** Metrics collector for time-series dashboards/SLAs */
    private MetricsCollectorInterface $metrics;

    /** Symfony RateLimiter instance to avoid alert storms */
    private RateLimiterInterface $alertLimiter;

    /**
     * AlertAndLogStrategy constructor.
     */
    public function __construct(
        LoggerInterface $logger,
        AlertDispatcherInterface $alertDispatcher,
        MetricsCollectorInterface $metricsCollector,
        RateLimiterFactory $rateLimiterFactory
    ) {
        $this->logger          = $logger;
        $this->alertDispatcher = $alertDispatcher;
        $this->metrics         = $metricsCollector;
        $this->alertLimiter    = $rateLimiterFactory->create('alert_and_log_strategy');
    }

    /**
     * Whether the given event should be handled by this strategy.
     *
     * We support only events that explicitly expose a Severity.
     */
    public function supports(DomainEventInterface $event): bool
    {
        return $event instanceof SeverityAwareEventInterface;
    }

    /**
     * Process the event: log, alert, collect metrics.
     *
     * @throws \RuntimeException Never, by design. Errors are internalised.
     */
    public function handle(DomainEventInterface $event, array $context = []): HandlerResponse
    {
        if (!$this->supports($event)) {
            return HandlerResponse::notHandled('Event not supported by AlertAndLogStrategy.');
        }

        /** @var SeverityAwareEventInterface $event */
        $severity = $event->getSeverity();

        $this->logEvent($event, $severity);
        $this->collectMetrics($severity);

        // Dispatch an alert only if policy allows it and we stay under the rate-limit.
        if ($this->shouldAlert($severity)) {
            $this->dispatchAlert($event, $context);
        }

        return HandlerResponse::handled();
    }

    /* -----------------------------------------------------------------
     |  Internal helper methods
     | -----------------------------------------------------------------
     */

    /**
     * Persist the event to a PSR-3 log channel.
     */
    private function logEvent(SeverityAwareEventInterface $event, Severity $severity): void
    {
        $message = sprintf('[%s] %s :: %s', $severity->name, $event->getCode(), $event->getMessage());

        // Map Severity enum → PSR-3 log level
        $levelMap = [
            Severity::LOW      => 'info',
            Severity::MEDIUM   => 'warning',
            Severity::HIGH     => 'error',
            Severity::CRITICAL => 'critical',
        ];

        $logLevel = $levelMap[$severity] ?? 'info';

        $this->logger->log($logLevel, $message, [
            'domain_event' => $event->toArray(),
            'context'      => 'AlertAndLogStrategy',
        ]);
    }

    /**
     * Push metrics to the collector (e.g., Prometheus, StatsD, OTEL).
     */
    private function collectMetrics(Severity $severity): void
    {
        $this->metrics->increment('events_total', [
            'strategy' => 'alert_and_log',
        ]);

        $this->metrics->increment('events_by_severity', [
            'strategy' => 'alert_and_log',
            'severity' => strtolower($severity->name),
        ]);
    }

    /**
     * Apply business rules & rate-limits to decide if an alert is warranted.
     */
    private function shouldAlert(Severity $severity): bool
    {
        // Only MEDIUM and above trigger alerts; lower severities are logged silently.
        if ($severity->value < Severity::MEDIUM->value) {
            return false;
        }

        // Use token-bucket rate limiter (configured outside) to avoid flooding.
        return $this->alertLimiter->consume(1)->isAccepted();
    }

    /**
     * Dispatch the alert via the configured AlertDispatcher. Exceptions
     * are captured and logged so that upstream workflow is never interrupted.
     */
    private function dispatchAlert(SeverityAwareEventInterface $event, array $context): void
    {
        try {
            $this->alertDispatcher->dispatch(
                message: $event->getMessage(),
                options: [
                    'severity' => $event->getSeverity()->name,
                    'code'     => $event->getCode(),
                    'payload'  => $event->toArray(),
                    'context'  => $context,
                ],
            );

            $this->metrics->increment('alerts_dispatched_total', [
                'strategy' => 'alert_and_log',
            ]);
        } catch (Throwable $e) {
            // Swallow exceptions so that the event pipeline keeps flowing.
            $this->logger->error('Alert dispatch failed', [
                'exception'    => $e,
                'failed_event' => $event->toArray(),
            ]);

            $this->metrics->increment('alerts_failed_total', [
                'strategy' => 'alert_and_log',
            ]);
        }
    }
}
```