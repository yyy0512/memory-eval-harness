<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Strategy;

use Psr\Log\LoggerInterface;
use ProdSecureOrchestrator\Domain\CommandBus\CommandBusInterface;
use ProdSecureOrchestrator\Domain\Event\SecurityEvent;
use ProdSecureOrchestrator\Domain\EventProcessing\Resolvers\RemediationCommandResolverInterface;
use ProdSecureOrchestrator\Domain\FeatureToggle\FeatureToggleServiceInterface;
use Throwable;

/**
 * AutoRemediateStrategy
 *
 * A strategy implementation that attempts to automatically remediate
 * incoming security events when the corresponding toggle is enabled,
 * a remediation command is resolvable, and the event satisfies the
 * user-defined severity/impact thresholds.
 *
 * The strategy participates both in a Strategy- and Chain-of-Responsibility
 * pattern: if the event cannot be automatically handled it is forwarded
 * to the next strategy in the chain.
 */
final class AutoRemediateStrategy implements RemediationStrategyInterface
{
    private const METRIC_LABEL = 'auto_remediate';

    private ?RemediationStrategyInterface $next = null;

    public function __construct(
        private readonly FeatureToggleServiceInterface         $toggleService,
        private readonly RemediationCommandResolverInterface   $commandResolver,
        private readonly CommandBusInterface                   $commandBus,
        private readonly LoggerInterface                       $logger,
        private readonly AutoRemediateConfig                   $config
    ) {
    }

    /**
     * {@inheritdoc}
     */
    public function setNext(RemediationStrategyInterface $next): void
    {
        $this->next = $next;
    }

    /**
     * {@inheritdoc}
     */
    public function handle(SecurityEvent $event): void
    {
        // Bail early if the feature is globally disabled.
        if (!$this->toggleService->isEnabled(self::METRIC_LABEL)) {
            $this->delegate($event);

            return;
        }

        // Verify event matches auto-remediation rules.
        if (!$this->shouldAttemptRemediation($event)) {
            $this->delegate($event);

            return;
        }

        // Resolve a remediation command for the given event.
        $command = $this->commandResolver->resolve($event);

        if ($command === null) {
            $this->logger->info(
                sprintf(
                    '[%s] No remediation command registered for event %s. Escalating to next strategy.',
                    self::METRIC_LABEL,
                    $event->getId()
                ),
                ['event' => $event->toArray()]
            );

            $this->delegate($event);

            return;
        }

        try {
            $this->logger->debug(
                sprintf('[%s] Dispatching remediation command for event %s', self::METRIC_LABEL, $event->getId()),
                ['command' => get_class($command)]
            );

            $this->commandBus->dispatch($command);

            $this->logger->notice(
                sprintf('[%s] Automatic remediation executed for event %s', self::METRIC_LABEL, $event->getId()),
                ['command' => get_class($command)]
            );
        } catch (Throwable $e) {
            $this->logger->error(
                sprintf('[%s] Failed to remediate event %s: %s', self::METRIC_LABEL, $event->getId(), $e->getMessage()),
                ['exception' => $e, 'event' => $event->toArray()]
            );

            // Escalate to next strategy despite the failure to ensure event is not lost.
            $this->delegate($event);
        }
    }

    /**
     * Determines whether the current event meets the criteria for auto-remediation.
     *
     * @param SecurityEvent $event
     *
     * @return bool
     */
    private function shouldAttemptRemediation(SecurityEvent $event): bool
    {
        // Evaluate severity threshold.
        if ($event->getSeverity()->getLevel() > $this->config->maxSeverityLevel()) {
            return false;
        }

        // Explicit user ‑ or policy-filtered categories are never auto-remediated.
        if (in_array($event->getCategory(), $this->config->blacklistedCategories(), true)) {
            return false;
        }

        return true;
    }

    /**
     * Forwards the event to the next handler in the chain, if available.
     */
    private function delegate(SecurityEvent $event): void
    {
        if ($this->next !== null) {
            $this->next->handle($event);

            return;
        }

        // Fallback: if no further strategy exists, log that the event is effectively discarded here.
        $this->logger->warning(
            sprintf('[%s] Event %s reached end of remediation chain without being handled', self::METRIC_LABEL, $event->getId()),
            ['event' => $event->toArray()]
        );
    }
}

/**
 * Simple immutable value-object holding runtime configuration for auto-remediation.
 *
 * In a real-world scenario this would usually be populated from a YAML/JSON
 * config file, remote configuration service, or environment variables.
 */
final class AutoRemediateConfig
{
    /**
     * @param int   $maxSeverityLevel     The highest severity that may be auto-remediated
     * @param array $blacklistedCategories Event categories never to auto-remediate
     */
    public function __construct(
        private readonly int   $maxSeverityLevel = 4,
        private readonly array $blacklistedCategories = [],
    ) {
    }

    public function maxSeverityLevel(): int
    {
        return $this->maxSeverityLevel;
    }

    /**
     * @return string[]
     */
    public function blacklistedCategories(): array
    {
        return $this->blacklistedCategories;
    }
}

/**
 * Contract for all remediation strategies that participate in the handler chain.
 */
interface RemediationStrategyInterface
{
    /**
     * Inject the next strategy in the chain.
     */
    public function setNext(self $next): void;

    /**
     * Handle (or forward) an incoming security event.
     */
    public function handle(SecurityEvent $event): void;
}