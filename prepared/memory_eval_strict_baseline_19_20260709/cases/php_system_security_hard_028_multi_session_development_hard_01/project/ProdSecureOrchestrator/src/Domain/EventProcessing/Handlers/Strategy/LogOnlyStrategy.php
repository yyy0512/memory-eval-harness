<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers\Strategy;

use DateTimeInterface;
use Psr\Log\LoggerInterface;
use Throwable;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\EventHandlingStrategyInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\StrategyResult;
use ProdSecureOrchestrator\Domain\EventProcessing\Event\EventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\ValueObject\HandlerContext;

/**
 * Strategy that *only* logs an incoming event.
 *
 * This strategy is useful for low–priority, informational, or audit-only
 * events where no escalation or automated remediation is required.  It still
 * participates in the Chain-of-Responsibility so that downstream handlers
 * are aware that the event has been acknowledged.
 */
final class LogOnlyStrategy implements EventHandlingStrategyInterface
{
    private const DEFAULT_LOG_CHANNEL = 'security.audit';

    private LoggerInterface $logger;
    private string $logChannel;

    public function __construct(LoggerInterface $logger, ?string $logChannel = null)
    {
        $this->logger     = $logger;
        $this->logChannel = $logChannel ?? self::DEFAULT_LOG_CHANNEL;
    }

    /**
     * {@inheritdoc}
     */
    public function supports(EventInterface $event, HandlerContext $context): bool
    {
        /**
         * Accept everything by default, but this is a convenient place to
         * whitelist/blacklist severities, types, or tenants via the Context.
         */
        return true;
    }

    /**
     * {@inheritdoc}
     */
    public function handle(EventInterface $event, HandlerContext $context): StrategyResult
    {
        try {
            $this->logger->info(
                sprintf(
                    '[%s] %s (%s) handled by %s @ %s',
                    $this->logChannel,
                    $event->getName(),
                    $event->getId(),
                    __CLASS__,
                    $event->getOccurredAt()->format(DateTimeInterface::ATOM)
                ),
                [
                    'event'      => $event->toArray(),
                    'environment'=> $context->getEnvironment(),
                    'tenant'     => $context->getTenantId(),
                    'correlation'=> $context->getCorrelationId(),
                ]
            );

            return StrategyResult::logOnlySuccessful($event);
        } catch (Throwable $throwable) {
            // Defensive logging so we don’t lose diagnostic breadcrumbs
            $this->logger->error(
                sprintf(
                    'Failed to log event "%s" (%s) in %s: %s',
                    $event->getName(),
                    $event->getId(),
                    __CLASS__,
                    $throwable->getMessage()
                ),
                [
                    'exception' => $throwable,
                    'event'     => method_exists($event, 'toArray') ? $event->toArray() : null,
                ]
            );

            return StrategyResult::logOnlyFailed($event, $throwable);
        }
    }
}