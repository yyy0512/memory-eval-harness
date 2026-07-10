<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\EventProcessing\Handlers;

use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\EventHandlerInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Contracts\EventInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\ValueObject\EventSeverity;
use ProdSecureOrchestrator\Infrastructure\Notification\NotifierInterface;
use ProdSecureOrchestrator\Infrastructure\Notification\Model\Message;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * NotificationHandler
 *
 * Part of the Chain-of-Responsibility that processes incoming events and decides
 * whether a user-facing notification should be sent.  The handler is designed
 * to be side-effect free for events that do not meet the alerting criteria, and
 * makes a best-effort attempt (with retries) for events that do.
 *
 * Typical downstream handlers may include persistence, audit logging,
 * auto-remediation, or escalation.  Failure to notify MUST NOT interrupt the
 * remaining chain.
 */
final class NotificationHandler implements EventHandlerInterface
{
    /** @var int Seconds between retry attempts */
    private const RETRY_BACKOFF_SECONDS = 2;

    /**
     * @var int Maximum number of retry attempts before giving up permanently.
     *          (The notifier implementation may decide to queue or DLQ failed
     *          deliveries.)
     */
    private const MAX_RETRIES = 3;

    private ?EventHandlerInterface $next = null;

    public function __construct(
        private readonly NotifierInterface $notifier,
        private readonly LoggerInterface $logger,
        /**
         * A map of event type => minimum severity that should trigger
         * a notification.  Provided at DI-time so operators can override
         * thresholds without code changes (e.g. via YAML).
         *
         * @var array<string, EventSeverity>
         */
        private readonly array $severityThresholds = []
    ) {
    }

    /**
     * PSR-15-inspired chaining helper.  Fluent interface so that handlers can
     * be wired together succinctly.
     */
    public function setNext(EventHandlerInterface $handler): EventHandlerInterface
    {
        $this->next = $handler;

        return $handler;
    }

    /**
     * {@inheritDoc}
     */
    public function handle(EventInterface $event): void
    {
        try {
            if ($this->shouldNotify($event)) {
                $this->dispatchNotification($event);
            }
        } catch (Throwable $exception) {
            // We swallow exceptions so that the chain never halts.  The error
            // is nevertheless recorded for later analysis.
            $this->logger->error(
                'NotificationHandler failed to dispatch',
                [
                    'event_id'   => $event->getId(),
                    'event_type' => $event->getType(),
                    'exception'  => $exception,
                ]
            );
        } finally {
            // Continue down the chain even if we failed or decided not to notify.
            $this->next?->handle($event);
        }
    }

    /**
     * Determine whether the provided event warrants a user notification.
     *
     * @throws \UnexpectedValueException when the event exposes an unknown severity.
     */
    private function shouldNotify(EventInterface $event): bool
    {
        $type     = $event->getType();
        $severity = $event->getSeverity();

        if (!$severity instanceof EventSeverity) {
            throw new \UnexpectedValueException(
                sprintf(
                    'Event id "%s" has severity of unexpected type "%s".',
                    $event->getId(),
                    get_debug_type($severity)
                )
            );
        }

        // Default to the lowest threshold (send everything) if no override has
        // been configured for this event type.
        $threshold = $this->severityThresholds[$type] ?? EventSeverity::LOW;

        return $severity->value >= $threshold->value;
    }

    /**
     * Attempt to send a notification using the injected NotifierInterface.
     * Retries on transient failures using a naive exponential back-off.
     */
    private function dispatchNotification(EventInterface $event): void
    {
        $message = Message::fromEvent($event);

        for ($attempt = 1; $attempt <= self::MAX_RETRIES; $attempt++) {
            try {
                $this->notifier->notify($message);

                $this->logger->info(
                    'Notification dispatched',
                    [
                        'event_id'    => $event->getId(),
                        'attempt'     => $attempt,
                        'destination' => $message->getDestination(),
                    ]
                );

                // Success — exit early.
                return;
            } catch (Throwable $exception) {
                $this->logger->warning(
                    'Transient failure while dispatching notification',
                    [
                        'event_id'   => $event->getId(),
                        'attempt'    => $attempt,
                        'exception'  => $exception->getMessage(),
                    ]
                );

                if ($attempt >= self::MAX_RETRIES) {
                    // Give up — we have exhausted retries.
                    throw $exception;
                }

                // Naive backoff.  For very high volume systems consider jitter.
                sleep(self::RETRY_BACKOFF_SECONDS ** $attempt);
            }
        }
    }
}