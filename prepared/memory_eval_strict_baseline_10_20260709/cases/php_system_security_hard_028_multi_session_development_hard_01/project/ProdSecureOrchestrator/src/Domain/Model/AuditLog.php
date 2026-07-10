<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Model;

use DateTimeImmutable;
use JsonSerializable;
use Ramsey\Uuid\Uuid;
use Ramsey\Uuid\UuidInterface;
use ValueError;

/**
 * Value object that represents a single immutable audit-log entry.
 *
 * Typical usage:
 *   $log = AuditLog::record(
 *       eventType: AuditEventType::SECURITY,
 *       actor:      'svc-firewall',
 *       resource:   'tcp/443',
 *       context:    ['ruleId' => 8742, 'action' => 'blocked']
 *   );
 *
 * Although the model is persistence-agnostic, it was intentionally designed
 * to map 1-to-1 to popular ORMs such as Doctrine or Eloquent by exposing
 * DTO-friendly toArray()/fromArray() helpers and JSON-serialization support.
 *
 * The class is deliberately *final* because the domain has no valid reasons
 * for polymorphic audit logs. Modification of an entry after construction is
 * forbidden; callers must create a new instance instead.
 */
final class AuditLog implements JsonSerializable
{
    /**
     * Unique identifier of the audit record (ULID/UUID v7 friendly).
     */
    private readonly UuidInterface $id;

    /**
     * What kind of event are we logging?
     */
    private readonly AuditEventType $eventType;

    /**
     * Who/what triggered the event? Could be a user, a micro-service,
     * a scheduled job, etc.
     */
    private readonly string $actor;

    /**
     * High-level resource descriptor. Example:
     *   - "k8s/deployment/prod-api"
     *   - "vm/i-0b123ab4c"
     *   - "tcp/443"
     */
    private readonly string $resource;

    /**
     * Server-generated timestamp in UTC.
     */
    private readonly DateTimeImmutable $occurredAt;

    /**
     * Arbitrary, JSON-serialisable key/value data that enriches the log.
     */
    private readonly array $context;

    /**
     * @throws ValueError When validation fails.
     */
    private function __construct(
        UuidInterface      $id,
        AuditEventType     $eventType,
        string             $actor,
        string             $resource,
        DateTimeImmutable  $occurredAt,
        array              $context = [],
    ) {
        // Lightweight value validation to avoid polluting domain services.
        $actor    = trim($actor);
        $resource = trim($resource);

        if ($actor === '') {
            throw new ValueError('AuditLog: Actor must be a non-empty string.');
        }

        if ($resource === '') {
            throw new ValueError('AuditLog: Resource must be a non-empty string.');
        }

        $this->id         = $id;
        $this->eventType  = $eventType;
        $this->actor      = $actor;
        $this->resource   = $resource;
        $this->occurredAt = $occurredAt->setTimezone(new \DateTimeZone('UTC'));
        $this->context    = $context;
    }

    /**
     * Factory helper to create a new audit-log entry.
     *
     * @throws ValueError When validation fails.
     */
    public static function record(
        AuditEventType    $eventType,
        string            $actor,
        string            $resource,
        array             $context = [],
        ?UuidInterface    $id = null,
        ?DateTimeImmutable $occurredAt = null,
    ): self {
        return new self(
            $id         ?? Uuid::uuid7(),
            $eventType,
            $actor,
            $resource,
            $occurredAt ?? new DateTimeImmutable('now', new \DateTimeZone('UTC')),
            $context,
        );
    }

    /**
     * Re-hydration helper used by infrastructure layers (ORM, HTTP, CLI, etc.).
     *
     * @throws ValueError When validation fails or payload is incomplete.
     */
    public static function fromArray(array $payload): self
    {
        foreach (['id', 'eventType', 'actor', 'resource', 'occurredAt', 'context'] as $key) {
            if (!array_key_exists($key, $payload)) {
                throw new ValueError("AuditLog: Missing key '{$key}' in payload.");
            }
        }

        $id = Uuid::fromString($payload['id']);

        /** @var AuditEventType $eventType */
        $eventType = AuditEventType::from($payload['eventType']);

        $occurredAt = new DateTimeImmutable($payload['occurredAt'], new \DateTimeZone('UTC'));

        $context = is_array($payload['context'])
            ? $payload['context']
            : json_decode((string)$payload['context'], true, flags: JSON_THROW_ON_ERROR);

        return new self(
            $id,
            $eventType,
            $payload['actor'],
            $payload['resource'],
            $occurredAt,
            $context,
        );
    }

    /**
     * Converts the log to a flat associative array suitable for storage or transport.
     */
    public function toArray(): array
    {
        return [
            'id'         => $this->id->toString(),
            'eventType'  => $this->eventType->value,
            'actor'      => $this->actor,
            'resource'   => $this->resource,
            'occurredAt' => $this->occurredAt->format(DATE_ATOM),
            'context'    => $this->context,
        ];
    }

    /* -------------------------------------------------------------------------
     * Getters
     * ---------------------------------------------------------------------- */

    public function id(): UuidInterface
    {
        return $this->id;
    }

    public function eventType(): AuditEventType
    {
        return $this->eventType;
    }

    public function actor(): string
    {
        return $this->actor;
    }

    public function resource(): string
    {
        return $this->resource;
    }

    public function occurredAt(): DateTimeImmutable
    {
        return $this->occurredAt;
    }

    /**
     * Returns a *read-only* copy of the contextual data.
     */
    public function context(): array
    {
        return $this->context;
    }

    /* -------------------------------------------------------------------------
     * Convenience
     * ---------------------------------------------------------------------- */

    /**
     * Implementation for JsonSerializable so objects can be passed directly
     * to json_encode() without leaking private state.
     *
     * @return array<string, mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toArray();
    }

    /**
     * Human-readable representation used mainly for debugging.
     */
    public function __toString(): string
    {
        return sprintf(
            '[%s] %s | %s | %s',
            $this->occurredAt->format('Y-m-d H:i:s T'),
            $this->eventType->value,
            $this->actor,
            $this->resource,
        );
    }
}

/**
 * Strongly-typed enum for audit event categories.
 */
enum AuditEventType: string
{
    case SECURITY    = 'security';
    case PERFORMANCE = 'performance';
    case BACKUP      = 'backup';
    case DEPLOYMENT  = 'deployment';
    case LOAD_BALANCER = 'load_balancer';
    case SYSTEM      = 'system';
    case CUSTOM      = 'custom';
}