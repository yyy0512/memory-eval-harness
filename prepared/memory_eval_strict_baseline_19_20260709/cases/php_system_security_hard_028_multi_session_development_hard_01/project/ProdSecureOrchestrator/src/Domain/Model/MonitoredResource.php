<?php
/**
 * ProdSecure Orchestrator
 *
 * @copyright   Copyright (c) 2024.
 * @license     Proprietary
 */

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Model;

use DateTimeImmutable;
use JsonSerializable;
use Ramsey\Uuid\Uuid;
use RuntimeException;

/**
 * The MonitoredResource is the central aggregate-root that represents any
 * infrastructure or application component tracked by ProdSecure Orchestrator.
 *
 * Responsibilities
 *  • Hold the canonical state of the resource (status, metrics, tags, etc.)
 *  • Enforce invariants and business rules
 *  • Produce immutable Domain Events that upstream handlers may react to
 *
 * Examples of resources: Kubernetes Pod, EC2 instance, Postgres cluster,
 * Nginx load-balancer, etc.
 */
final class MonitoredResource implements JsonSerializable
{
    /** @var string UUID v4 */
    private string $id;

    private string $displayName;

    private ResourceType $type;

    private ResourceStatus $status;

    /** @var array<string,string> Arbitrary key/value pairs */
    private array $tags = [];

    /**
     * @var array<string,MetricSample> Map of metric name -> latest sample
     */
    private array $metrics = [];

    private DateTimeImmutable $createdAt;
    private DateTimeImmutable $updatedAt;
    private DateTimeImmutable $lastHeartbeatAt;

    /** @var DomainEvent[] */
    private array $recordedEvents = [];

    /**
     * Factory named constructor.
     *
     * @throws RuntimeException
     */
    public static function register(
        string $displayName,
        ResourceType $type,
        array $tags = []
    ): self {
        if ($displayName === '') {
            throw new RuntimeException('Display name cannot be empty');
        }

        $now = new DateTimeImmutable();

        $self               = new self();
        $self->id           = Uuid::uuid4()->toString();
        $self->displayName  = $displayName;
        $self->type         = $type;
        $self->status       = ResourceStatus::UNKNOWN;
        $self->tags         = $tags;
        $self->createdAt    = $now;
        $self->updatedAt    = $now;
        $self->lastHeartbeatAt = $now;

        $self->recordEvent(new ResourceRegistered($self->id, $now));

        return $self;
    }

    private function __construct()
    {
        // enforce factory usage
    }

    /* ========================== Domain Behaviour ========================== */

    /**
     * Update or create a metric sample.
     *
     * @throws RuntimeException
     */
    public function updateMetric(string $name, float|int $value, ?DateTimeImmutable $occurredAt = null): void
    {
        $occurredAt ??= new DateTimeImmutable();

        if ($name === '') {
            throw new RuntimeException('Metric name cannot be empty');
        }

        $sample = new MetricSample($name, (float) $value, $occurredAt);
        $this->metrics[$name] = $sample;
        $this->touch();

        $this->recordEvent(new MetricUpdated($this->id, $sample));
    }

    /**
     * Register a heartbeat. If the resource was DOWN, surface an automatic
     * status recovery to DEGRADED (the strategy engine may upgrade again later).
     */
    public function registerHeartbeat(?DateTimeImmutable $at = null): void
    {
        $at ??= new DateTimeImmutable();
        $this->lastHeartbeatAt = $at;
        $this->touch();

        if ($this->status === ResourceStatus::DOWN) {
            $this->changeStatus(ResourceStatus::DEGRADED, $at, '__auto_heartbeat__');
        }
    }

    /**
     * Change current status.
     *
     * @throws RuntimeException
     */
    public function changeStatus(
        ResourceStatus $newStatus,
        ?DateTimeImmutable $occurredAt = null,
        ?string $reason = null
    ): void {
        if ($newStatus === $this->status) {
            // No-op
            return;
        }

        $occurredAt ??= new DateTimeImmutable();
        $previous = $this->status;
        $this->status = $newStatus;
        $this->touch();

        $this->recordEvent(
            new StatusChanged(
                $this->id,
                $previous,
                $newStatus,
                $occurredAt,
                $reason
            )
        );
    }

    /**
     * Add or update a tag.
     */
    public function tag(string $key, string $value): void
    {
        $this->tags[$key] = $value;
        $this->touch();
    }

    /**
     * Remove a tag.
     */
    public function untag(string $key): void
    {
        unset($this->tags[$key]);
        $this->touch();
    }

    /* ============================== Helpers =============================== */

    private function touch(): void
    {
        $this->updatedAt = new DateTimeImmutable();
    }

    private function recordEvent(DomainEvent $event): void
    {
        $this->recordedEvents[] = $event;
    }

    /**
     * Release and clear recorded events (Event sourcing pull-model).
     *
     * @return DomainEvent[]
     */
    public function pullDomainEvents(): array
    {
        $events               = $this->recordedEvents;
        $this->recordedEvents = [];

        return $events;
    }

    /* ============================= Getters =============================== */

    public function id(): string
    {
        return $this->id;
    }

    public function displayName(): string
    {
        return $this->displayName;
    }

    public function type(): ResourceType
    {
        return $this->type;
    }

    public function status(): ResourceStatus
    {
        return $this->status;
    }

    public function metrics(): array
    {
        return $this->metrics;
    }

    public function tags(): array
    {
        return $this->tags;
    }

    public function lastHeartbeatAt(): DateTimeImmutable
    {
        return $this->lastHeartbeatAt;
    }

    public function createdAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function updatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    /* ========================== Serialization ============================ */

    /**
     * Provide a minimal, stable, API-facing representation.
     */
    public function jsonSerialize(): array
    {
        return [
            'id'              => $this->id,
            'displayName'     => $this->displayName,
            'type'            => $this->type->value,
            'status'          => $this->status->value,
            'tags'            => $this->tags,
            'metrics'         => array_map(static fn (MetricSample $m) => $m->jsonSerialize(), $this->metrics),
            'lastHeartbeatAt' => $this->lastHeartbeatAt->format(DATE_ATOM),
            'createdAt'       => $this->createdAt->format(DATE_ATOM),
            'updatedAt'       => $this->updatedAt->format(DATE_ATOM),
        ];
    }
}

/* ============================== Enums ==================================== */

enum ResourceType: string
{
    case HOST          = 'host';
    case CONTAINER     = 'container';
    case DATABASE      = 'database';
    case SERVICE       = 'service';
    case LOAD_BALANCER = 'load_balancer';
}

enum ResourceStatus: string
{
    case HEALTHY  = 'healthy';
    case DEGRADED = 'degraded';
    case DOWN     = 'down';
    case UNKNOWN  = 'unknown';
}

/* =========================== Value Objects =============================== */

final class MetricSample implements JsonSerializable
{
    public function __construct(
        private string $name,
        private float $value,
        private DateTimeImmutable $recordedAt
    ) {
    }

    public function name(): string
    {
        return $this->name;
    }

    public function value(): float
    {
        return $this->value;
    }

    public function recordedAt(): DateTimeImmutable
    {
        return $this->recordedAt;
    }

    public function jsonSerialize(): array
    {
        return [
            'name'       => $this->name,
            'value'      => $this->value,
            'recordedAt' => $this->recordedAt->format(DATE_ATOM),
        ];
    }
}

/* ============================ Events ===================================== */

interface DomainEvent
{
    public function occurredAt(): DateTimeImmutable;
}

final class ResourceRegistered implements DomainEvent
{
    public function __construct(
        private string $resourceId,
        private DateTimeImmutable $occurredAt
    ) {
    }

    public function resourceId(): string
    {
        return $this->resourceId;
    }

    public function occurredAt(): DateTimeImmutable
    {
        return $this->occurredAt;
    }
}

final class MetricUpdated implements DomainEvent
{
    public function __construct(
        private string $resourceId,
        private MetricSample $sample
    ) {
    }

    public function resourceId(): string
    {
        return $this->resourceId;
    }

    public function sample(): MetricSample
    {
        return $this->sample;
    }

    public function occurredAt(): DateTimeImmutable
    {
        return $this->sample->recordedAt();
    }
}

final class StatusChanged implements DomainEvent
{
    public function __construct(
        private string $resourceId,
        private ResourceStatus $previous,
        private ResourceStatus $current,
        private DateTimeImmutable $occurredAt,
        private ?string $reason = null
    ) {
    }

    public function resourceId(): string
    {
        return $this->resourceId;
    }

    public function previous(): ResourceStatus
    {
        return $this->previous;
    }

    public function current(): ResourceStatus
    {
        return $this->current;
    }

    public function occurredAt(): DateTimeImmutable
    {
        return $this->occurredAt;
    }

    public function reason(): ?string
    {
        return $this->reason;
    }
}
