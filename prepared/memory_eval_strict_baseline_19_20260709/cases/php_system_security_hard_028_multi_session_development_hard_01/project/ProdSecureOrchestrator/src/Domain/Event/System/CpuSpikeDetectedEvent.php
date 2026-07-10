<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Event\System;

use DateTimeImmutable;
use JsonSerializable;
use ProdSecureOrchestrator\Domain\Event\DomainEvent;
use Ramsey\Uuid\Uuid;
use Ramsey\Uuid\UuidInterface;
use Stringable;

/**
 * Domain Event: Raised whenever the orchestrator detects that the average CPU
 * utilisation of a host (or container) has exceeded a declared SLA threshold.
 *
 * The event is immutable and may be safely serialized for transport across
 * process boundaries or stored in an event‐sourced store.
 *
 * @author ProdSecure
 */
final class CpuSpikeDetectedEvent implements DomainEvent, JsonSerializable, Stringable
{
    /**
     * Fully‐qualified host identifier in the service mesh.
     *
     * Examples:
     *  - physical: `dc01-rack03-node14`
     *  - kubernetes: `pod/prod/frontend-5d89d`
     */
    private string $hostId;

    /**
     * The measured CPU utilisation expressed as a percentage (0 – 100).
     */
    private float $loadPercentage;

    /**
     * Number of virtual/physical cores reported by the host at the time
     * of spike — useful when calculating absolute CPU time.
     */
    private int $coreCount;

    /**
     * When the spike started according to the monitoring data.
     */
    private DateTimeImmutable $occurredAt;

    /**
     * Correlation identifier linking this event to a larger incident
     * (e.g. related IO alerts, memory pressure alerts, etc.).
     */
    private UuidInterface $correlationId;

    /**
     * Arbitrary metadata for downstream handlers (e.g. tags such as
     * environment=prod, cluster=edge-us-east).
     *
     * A flat key/value bag is sufficient and serialisation friendly.
     * All keys MUST be strings; values MAY be scalars or null.
     *
     * @var array<string, scalar|null>
     */
    private array $context;

    /**
     * Creates a new immutable CpuSpikeDetectedEvent.
     *
     * @param array<string, scalar|null> $context
     */
    public function __construct(
        string             $hostId,
        float              $loadPercentage,
        int                $coreCount,
        DateTimeImmutable  $occurredAt,
        ?UuidInterface     $correlationId = null,
        array              $context = [],
    ) {
        $this->assertPercentage($loadPercentage);
        $this->assertCoreCount($coreCount);
        $this->assertContext($context);

        $this->hostId        = trim($hostId);
        $this->loadPercentage = $loadPercentage;
        $this->coreCount      = $coreCount;
        $this->occurredAt     = $occurredAt;
        $this->correlationId  = $correlationId ?? Uuid::uuid7(); // time-ordered UUID
        $this->context        = $context;
    }

    /**
     * Named constructor when an external metric payload is available.
     *
     * @param array{
     *     hostId:string,
     *     loadPercentage:float,
     *     coreCount:int,
     *     occurredAt:int|float|string|DateTimeImmutable,
     *     correlationId?:string|UuidInterface,
     *     context?:array<string, scalar|null>
     * } $payload
     *
     * @throws \InvalidArgumentException When required keys are missing or invalid.
     */
    public static function fromMetrics(array $payload): self
    {
        $required = ['hostId', 'loadPercentage', 'coreCount', 'occurredAt'];
        foreach ($required as $key) {
            if (!array_key_exists($key, $payload)) {
                throw new \InvalidArgumentException("Missing required metric key '{$key}'.");
            }
        }

        $occurredAt = $payload['occurredAt'];
        if (!$occurredAt instanceof DateTimeImmutable) {
            $occurredAt = new DateTimeImmutable('@' . (string) (is_numeric($occurredAt) ? $occurredAt : strtotime((string) $occurredAt)));
        }

        $correlationId = $payload['correlationId'] ?? null;
        if (is_string($correlationId)) {
            $correlationId = Uuid::fromString($correlationId);
        }

        /** @var array<string, scalar|null> $context */
        $context = $payload['context'] ?? [];

        return new self(
            (string) $payload['hostId'],
            (float) $payload['loadPercentage'],
            (int) $payload['coreCount'],
            $occurredAt,
            $correlationId instanceof UuidInterface ? $correlationId : null,
            $context,
        );
    }

    /* -----------------------------------------------------------------
     * DomainEvent interface
     * -----------------------------------------------------------------
     */

    public function occurredOn(): DateTimeImmutable
    {
        return $this->occurredAt;
    }

    public function correlationId(): UuidInterface
    {
        return $this->correlationId;
    }

    /**
     * Returns a human readable description, suitable for log lines.
     */
    public function __toString(): string
    {
        return sprintf(
            '[CPU-SPIKE] host=%s load=%.2f%% cores=%d at=%s corr=%s',
            $this->hostId,
            $this->loadPercentage,
            $this->coreCount,
            $this->occurredAt->format(DateTimeImmutable::ATOM),
            $this->correlationId->toString(),
        );
    }

    /**
     * Specification – JsonSerializable.
     *
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return [
            'eventType'      => self::class,
            'hostId'         => $this->hostId,
            'loadPercentage' => $this->loadPercentage,
            'coreCount'      => $this->coreCount,
            'occurredAt'     => $this->occurredAt->format(DateTimeImmutable::ATOM),
            'correlationId'  => $this->correlationId->toString(),
            'context'        => $this->context,
        ];
    }

    /* -----------------------------------------------------------------
     * Getters
     * -----------------------------------------------------------------
     */

    public function hostId(): string
    {
        return $this->hostId;
    }

    public function loadPercentage(): float
    {
        return $this->loadPercentage;
    }

    public function coreCount(): int
    {
        return $this->coreCount;
    }

    /**
     * @return array<string, scalar|null>
     */
    public function context(): array
    {
        return $this->context;
    }

    /* -----------------------------------------------------------------
     * Validation helpers
     * -----------------------------------------------------------------
     */

    private function assertPercentage(float $percentage): void
    {
        if ($percentage < 0 || $percentage > 100) {
            throw new \InvalidArgumentException(
                sprintf('CPU load percentage (%.2f) must be between 0 and 100.', $percentage)
            );
        }
    }

    private function assertCoreCount(int $coreCount): void
    {
        if ($coreCount <= 0) {
            throw new \InvalidArgumentException('Core count must be a positive integer.');
        }
    }

    /**
     * @param array<string, mixed> $context
     */
    private function assertContext(array $context): void
    {
        foreach ($context as $key => $value) {
            if (!is_scalar($value) && $value !== null) {
                throw new \InvalidArgumentException(sprintf(
                    'Context value for key "%s" must be scalar or null, %s given.',
                    $key,
                    get_debug_type($value)
                ));
            }
        }
    }
}
