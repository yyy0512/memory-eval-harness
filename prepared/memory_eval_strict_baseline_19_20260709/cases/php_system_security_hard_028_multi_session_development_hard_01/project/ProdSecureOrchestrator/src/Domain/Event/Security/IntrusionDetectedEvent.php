<?php
/**
 * ProdSecure Orchestrator
 *
 * @author     ProdSecure
 * @copyright  Copyright (c) …
 * @license    MIT
 */

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Event\Security;

use DateTimeImmutable;
use InvalidArgumentException;
use JsonSerializable;
use ProdSecureOrchestrator\Domain\Common\DomainEvent;
use ProdSecureOrchestrator\Domain\ValueObject\Security\Severity;
use Ramsey\Uuid\Uuid;
use Ramsey\Uuid\UuidInterface;

/**
 * Domain Event that gets raised whenever the IDS/IPS pipeline
 * reports a confirmed intrusion attempt.
 *
 * The event is immutable and is deliberately lightweight so that it
 * can be freely cloned, queued, and serialized across bounded contexts.
 */
final class IntrusionDetectedEvent implements DomainEvent, JsonSerializable
{
    /**
     * Unique identifier for the event instance (idempotency key).
     */
    private readonly UuidInterface $eventId;

    /**
     * Time (UTC) at which the intrusion was detected.
     */
    private readonly DateTimeImmutable $occurredOn;

    /**
     * Human-readable identifier of the detecting sensor or micro-service.
     */
    private readonly string $source;

    /**
     * IP address/network identifier of the malicious actor.
     */
    private readonly string $attackerIp;

    /**
     * Host or asset that was targeted by the intrusion.
     */
    private readonly string $targetHostname;

    /**
     * Category of the intrusion (e.g. SQL_INJECTION, XSS, RANSOMWARE)
     */
    private readonly string $threatType;

    /**
     * Severity encapsulated as a rich enum-like value object.
     */
    private readonly Severity $severity;

    /**
     * Optional correlation identifier – useful when the attack is linked
     * to a larger alert chain (e.g. MITRE ATT&CK).
     */
    private readonly ?UuidInterface $correlationId;

    /**
     * IntrusionDetectedEvent constructor (private: use factory method instead)
     *
     * @param UuidInterface      $eventId
     * @param DateTimeImmutable  $occurredOn
     * @param string             $source
     * @param string             $attackerIp
     * @param string             $targetHostname
     * @param string             $threatType
     * @param Severity           $severity
     * @param UuidInterface|null $correlationId
     */
    private function __construct(
        UuidInterface $eventId,
        DateTimeImmutable $occurredOn,
        string $source,
        string $attackerIp,
        string $targetHostname,
        string $threatType,
        Severity $severity,
        ?UuidInterface $correlationId = null,
    ) {
        $this->assertValidIp($attackerIp);

        $this->eventId       = $eventId;
        $this->occurredOn    = $occurredOn;
        $this->source        = $source;
        $this->attackerIp    = $attackerIp;
        $this->targetHostname = $targetHostname;
        $this->threatType    = $threatType;
        $this->severity      = $severity;
        $this->correlationId = $correlationId;
    }

    /**
     * Factory method for safer construction with sensible defaults.
     */
    public static function raise(
        string $source,
        string $attackerIp,
        string $targetHostname,
        string $threatType,
        Severity $severity,
        ?UuidInterface $correlationId = null,
        ?DateTimeImmutable $occurredOn = null,
    ): self {
        return new self(
            Uuid::uuid7(),
            $occurredOn ?: new DateTimeImmutable('now', new \DateTimeZone('UTC')),
            $source,
            $attackerIp,
            $targetHostname,
            $threatType,
            $severity,
            $correlationId
        );
    }

    /* -------------------------------------------------
     * Implementation of DomainEvent interface
     * ------------------------------------------------- */

    public function eventId(): UuidInterface
    {
        return $this->eventId;
    }

    public function occurredOn(): DateTimeImmutable
    {
        return $this->occurredOn;
    }

    /* -------------------------------------------------
     * Accessors
     * ------------------------------------------------- */

    public function source(): string
    {
        return $this->source;
    }

    public function attackerIp(): string
    {
        return $this->attackerIp;
    }

    public function targetHostname(): string
    {
        return $this->targetHostname;
    }

    public function threatType(): string
    {
        return $this->threatType;
    }

    public function severity(): Severity
    {
        return $this->severity;
    }

    public function correlationId(): ?UuidInterface
    {
        return $this->correlationId;
    }

    /* -------------------------------------------------
     * Serialization helpers
     * ------------------------------------------------- */

    /**
     * Used by JsonSerializable and AMQP/Redis producers.
     */
    public function toPayload(): array
    {
        return [
            'event_id'       => $this->eventId->toString(),
            'occurred_on'    => $this->occurredOn->format(DATE_ATOM),
            'source'         => $this->source,
            'attacker_ip'    => $this->attackerIp,
            'target_hostname'=> $this->targetHostname,
            'threat_type'    => $this->threatType,
            'severity'       => $this->severity->value,
            'correlation_id' => $this->correlationId?->toString(),
        ];
    }

    /**
     * Re-hydrate the domain event from a raw message payload.
     *
     * @throws InvalidArgumentException
     */
    public static function fromPayload(array $data): self
    {
        foreach ([
            'event_id',
            'occurred_on',
            'source',
            'attacker_ip',
            'target_hostname',
            'threat_type',
            'severity',
        ] as $required) {
            if (!array_key_exists($required, $data)) {
                throw new InvalidArgumentException("Missing required payload key: {$required}");
            }
        }

        return new self(
            Uuid::fromString($data['event_id']),
            new DateTimeImmutable($data['occurred_on']),
            (string) $data['source'],
            (string) $data['attacker_ip'],
            (string) $data['target_hostname'],
            (string) $data['threat_type'],
            Severity::from($data['severity']),
            isset($data['correlation_id']) ? Uuid::fromString($data['correlation_id']) : null
        );
    }

    public function jsonSerialize(): array
    {
        return $this->toPayload();
    }

    public function __toString(): string
    {
        return json_encode($this->toPayload(), JSON_THROW_ON_ERROR);
    }

    /* -------------------------------------------------
     * Private helpers
     * ------------------------------------------------- */

    private function assertValidIp(string $ip): void
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            throw new InvalidArgumentException('Invalid IP address given: ' . $ip);
        }
    }
}