<?php

declare(strict_types=1);

namespace ProdSecure\Orchestrator\Domain\Event;

use DateTimeImmutable;
use JsonSerializable;

/**
 * Interface DomainEventInterface
 *
 * A Domain Event represents something that has happened in the
 * system that domain experts care about. Every event is immutable,
 * timestamped, and carries a unique identifier for audit-log integrity.
 *
 * Implementations SHOULD be Value Objects: i.e. they MUST NOT expose
 * setters or allow their internal state to be mutated once instantiated.
 *
 * Events are routed through the Chain of Responsibility pipeline and
 * consumed by read-models, projectors, or external integrations
 * (e.g. SIEM, incident-response playbooks, etc.).
 */
interface DomainEventInterface extends JsonSerializable
{
    /**
     * The canonical, dot-separated name of the event.
     *
     * Example: security.backup.failure_detected
     */
    public const EVENT_NAME_SEPARATOR = '.';

    /**
     * Returns a globally unique identifier for this event instance.
     *
     * Implementations MAY opt for ULID, UUIDv7 or any monotonic
     * sortable identifier that guarantees uniqueness.
     */
    public function id(): string;

    /**
     * Human-readable, fully-qualified name of the event type.
     *
     * Example output: "system_security.backup.failure_detected"
     */
    public static function eventName(): string;

    /**
     * The aggregate or entity identifier that the event pertains to.
     *
     * Not every domain model uses aggregates; if that is the case,
     * returning an empty string is acceptable.
     */
    public function aggregateId(): string;

    /**
     * ISO-8601 timestamp indicating when the event was raised.
     */
    public function occurredAt(): DateTimeImmutable;

    /**
     * Arbitrary, serialisable payload that captures the event's state.
     *
     * The payload MUST consist only of scalar values and/or nested arrays
     * so that it can be safely JSON-encoded for persistence or transport.
     *
     * @return array<string, mixed>
     */
    public function payload(): array;

    /**
     * Factory method for re-constituting an event from its persisted form.
     *
     * This is critical for event-sourced read-model reconstruction.
     *
     * @param array<string, mixed> $payload
     */
    public static function fromPayload(
        string $id,
        array $payload,
        DateTimeImmutable $occurredAt,
        string $aggregateId = ''
    ): static;

    /**
     * {@inheritDoc}
     *
     * Should return an associative array with at least:
     *  - 'id'
     *  - 'event_name'
     *  - 'occurred_at'
     *  - 'aggregate_id'
     *  - 'payload'
     */
    public function jsonSerialize(): array;
}