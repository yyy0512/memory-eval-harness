```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Fixtures;

use DateTimeImmutable;
use ProdSecureOrchestrator\Domain\Event\EventSeverity;
use ProdSecureOrchestrator\Domain\Event\SecurityEvent;

/**
 * EventFixtures
 *
 * Centralised factory helpers for crafting SecurityEvent instances that are consumed
 * by the entire test-suite. Having a single source-of-truth lowers maintenance cost
 * whenever a property is added to the event domain model.
 */
final class EventFixtures
{
    /**
     * Returns a "CRITICAL" intrusion-detection alert.
     */
    public static function intrusionAlert(?DateTimeImmutable $occurredAt = null): SecurityEvent
    {
        return SecurityEvent::create(
            type: 'intrusion.alert',
            severity: EventSeverity::CRITICAL,
            payload: [
                'source_ip'   => '10.10.5.23',
                'destination' => '/admin/login',
                'vector'      => 'SQL_INJECTION',
                'user_agent'  => 'nmap/7.93',
            ],
            occurredAt: $occurredAt
        );
    }

    /**
     * Returns a system-metric event that indicates a sustained CPU spike.
     */
    public static function cpuSpike(?DateTimeImmutable $occurredAt = null): SecurityEvent
    {
        return SecurityEvent::create(
            type: 'metrics.cpu_spike',
            severity: EventSeverity::HIGH,
            payload: [
                'host'      => 'web-01.internal',
                'cpu'       => 97.2,
                'duration'  => 120, // seconds
                'threshold' => 92.5,
            ],
            occurredAt: $occurredAt
        );
    }

    /**
     * Returns an event representing a failed nightly backup routine.
     */
    public static function failedBackup(?DateTimeImmutable $occurredAt = null): SecurityEvent
    {
        /** @noinspection PhpUnhandledExceptionInspection */
        $jobId = \class_exists(\Ramsey\Uuid\Uuid::class)
            ? \Ramsey\Uuid\Uuid::uuid4()->toString()
            : \bin2hex(\random_bytes(16));

        return SecurityEvent::create(
            type: 'backup.failed',
            severity: EventSeverity::MEDIUM,
            payload: [
                'job_id'   => $jobId,
                'host'     => 'db01.internal',
                'snapshot' => '2024-06-14T00:00:00Z',
                'error'    => 'Disk space exhausted',
            ],
            occurredAt: $occurredAt
        );
    }

    /**
     * Handy shortcut that bundles heterogeneous events.
     *
     * @return array<SecurityEvent>
     */
    public static function mixedSet(): array
    {
        return [
            self::intrusionAlert(),
            self::cpuSpike(),
            self::failedBackup(),
        ];
    }

    /**
     * PHPUnit data-provider for routing tests.
     *
     * @return array<string,array{0:SecurityEvent,1:string}>
     */
    public static function routerDataProvider(): array
    {
        return [
            'Intrusion alert goes to IncidentHandler' => [
                self::intrusionAlert(),
                'IncidentHandler',
            ],
            'CPU spike goes to AutoScaler' => [
                self::cpuSpike(),
                'AutoScaler',
            ],
            'Backup failure goes to OpsPager' => [
                self::failedBackup(),
                'OpsPager',
            ],
        ];
    }
}

namespace ProdSecureOrchestrator\Domain\Event;

use DateTimeImmutable;
use InvalidArgumentException;

/**
 * Lightweight stub implementations of the domain classes so that the
 * fixture file can be executed in isolation (e.g. when static-analysis or IDEs
 * do not load the real domain classes). Whenever the production classes are
 * available these stubs are ignored thanks to a class-existence guard.
 */
if (!\class_exists(EventSeverity::class)) {
    /**
     * Back-up enum mirroring severity levels.
     */
    enum EventSeverity: string
    {
        case LOW      = 'LOW';
        case MEDIUM   = 'MEDIUM';
        case HIGH     = 'HIGH';
        case CRITICAL = 'CRITICAL';
    }
}

if (!\class_exists(SecurityEvent::class)) {
    /**
     * Minimal surrogate for the real SecurityEvent aggregate.
     */
    final class SecurityEvent
    {
        private string $id;
        private string $type;
        private EventSeverity $severity;
        private array $payload;
        private DateTimeImmutable $occurredAt;

        private function __construct(
            string $id,
            string $type,
            EventSeverity $severity,
            array $payload,
            ?DateTimeImmutable $occurredAt = null
        ) {
            $this->id         = $id;
            $this->type       = $type;
            $this->severity   = $severity;
            $this->payload    = $payload;
            $this->occurredAt = $occurredAt ?? new DateTimeImmutable();
        }

        /**
         * Named constructor that enforces basic invariants.
         *
         * @throws InvalidArgumentException
         */
        public static function create(
            string $type,
            EventSeverity $severity,
            array $payload,
            ?DateTimeImmutable $occurredAt = null
        ): self {
            if (\trim($type) === '') {
                throw new InvalidArgumentException('Event type must not be empty.');
            }

            $id = self::generateUuid();

            return new self($id, $type, $severity, $payload, $occurredAt);
        }

        /* ----------------------------
         |  Domain getters – test-only |
         -----------------------------*/
        public function id(): string
        {
            return $this->id;
        }

        public function type(): string
        {
            return $this->type;
        }

        public function severity(): EventSeverity
        {
            return $this->severity;
        }

        public function payload(): array
        {
            return $this->payload;
        }

        public function occurredAt(): DateTimeImmutable
        {
            return $this->occurredAt;
        }

        /* ----------------------------
         |  Internal helpers
         -----------------------------*/
        private static function generateUuid(): string
        {
            // Prefer the Ramsey/Uuid implementation when available, otherwise fall
            // back to a cryptographically-secure random identifier.
            if (\class_exists(\Ramsey\Uuid\Uuid::class)) {
                /** @noinspection PhpUnhandledExceptionInspection */
                return \Ramsey\Uuid\Uuid::uuid4()->toString();
            }

            return \bin2hex(\random_bytes(16));
        }
    }
}
```