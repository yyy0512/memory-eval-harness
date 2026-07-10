```php
<?php
/**
 * This file is part of ProdSecure Orchestrator.
 *
 * (c) 2024 SecureOps Inc. <opensource@secureops.example>
 *
 * @license   MIT
 */

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Model;

use DateTimeImmutable;
use JsonSerializable;
use Ramsey\Uuid\Uuid;
use Ramsey\Uuid\UuidInterface;
use RuntimeException;
use Stringable;

/**
 * Represents a security / monitoring alert flowing through the Orchestrator.
 *
 * The aggregate encapsulates all domain logic for state-changes; i.e. it makes
 * sure that only valid transitions occur (OPEN → ACKNOWLEDGED → RESOLVED or
 * OPEN → ESCALATED → RESOLVED).
 *
 * The entity is designed to be persistence-agnostic; repositories are free to
 * map it to a relational database, Mongo, Kafka stream, etc.
 */
final class Alert implements JsonSerializable, Stringable
{
    /** @var UuidInterface */
    private UuidInterface $id;

    /** @var string Human-readable title */
    private string $title;

    /** @var string Longer, often machine-generated description */
    private string $description;

    /** @var AlertSeverity */
    private AlertSeverity $severity;

    /** @var AlertStatus */
    private AlertStatus $status;

    /** @var DateTimeImmutable Moment the alert entered the system */
    private DateTimeImmutable $createdAt;

    /** @var DateTimeImmutable Last time the alert was touched */
    private DateTimeImmutable $updatedAt;

    /** @var string[] Arbitrary user-supplied tags, e.g. ["network", "l7", "customer-paywall"] */
    private array $tags = [];

    /** @var array<string, mixed> Additional structured metadata; must be JSON-serializable */
    private array $context = [];

    private function __construct(
        UuidInterface     $id,
        string            $title,
        string            $description,
        AlertSeverity     $severity,
        DateTimeImmutable $createdAt,
        DateTimeImmutable $updatedAt,
        array             $tags = [],
        array             $context = []
    ) {
        $this->assertTitle($title);
        $this->assertDescription($description);

        $this->id          = $id;
        $this->title       = $title;
        $this->description = $description;
        $this->severity    = $severity;
        $this->status      = AlertStatus::OPEN;
        $this->createdAt   = $createdAt;
        $this->updatedAt   = $updatedAt;
        $this->tags        = array_values(array_unique($tags));
        $this->context     = $context;
    }

    /**
     * Factory method—keeps constructor private so we can evolve invariants safely.
     */
    public static function raise(
        string        $title,
        string        $description,
        AlertSeverity $severity,
        array         $tags = [],
        array         $context = []
    ): self {
        $now = new DateTimeImmutable('now');
        return new self(
            Uuid::uuid4(),
            $title,
            $description,
            $severity,
            $now,
            $now,
            $tags,
            $context
        );
    }

    /* ---------------------------------------------------------------------
     |  State-transition commands
     | --------------------------------------------------------------------*/

    /**
     * Acknowledge the alert; only OPEN alerts may be acknowledged.
     *
     * @throws RuntimeException when state transition is illegal.
     */
    public function acknowledge(string $operatorId): void
    {
        if ($this->status !== AlertStatus::OPEN) {
            throw new RuntimeException(
                sprintf(
                    'Alert %s cannot be acknowledged because it is not OPEN (current status: %s).',
                    $this->id,
                    $this->status->value
                )
            );
        }

        $this->status    = AlertStatus::ACKNOWLEDGED;
        $this->updatedAt = new DateTimeImmutable('now');
        $this->context['acknowledgedBy'] = $operatorId;
    }

    /**
     * Resolve the alert.
     *
     * @throws RuntimeException on invalid status transition.
     */
    public function resolve(string $operatorId): void
    {
        if (!in_array($this->status, [AlertStatus::ACKNOWLEDGED, AlertStatus::ESCALATED, AlertStatus::OPEN], true)) {
            throw new RuntimeException(
                sprintf(
                    'Alert %s cannot be resolved from status %s.',
                    $this->id,
                    $this->status->value
                )
            );
        }

        $this->status    = AlertStatus::RESOLVED;
        $this->updatedAt = new DateTimeImmutable('now');
        $this->context['resolvedBy'] = $operatorId;
    }

    /**
     * Escalate the alert—typically bumps severity and marks status as ESCALATED.
     *
     * @throws RuntimeException on invalid transition or when new severity is not higher.
     */
    public function escalate(string $operatorId, AlertSeverity $newSeverity): void
    {
        if ($this->status === AlertStatus::RESOLVED) {
            throw new RuntimeException(sprintf('Resolved alert %s cannot be escalated.', $this->id));
        }

        if ($newSeverity->priority() <= $this->severity->priority()) {
            throw new RuntimeException(
                sprintf(
                    'Cannot escalate alert %s to equal or lower severity (%s ≤ %s).',
                    $this->id,
                    $newSeverity->value,
                    $this->severity->value
                )
            );
        }

        $this->severity  = $newSeverity;
        $this->status    = AlertStatus::ESCALATED;
        $this->updatedAt = new DateTimeImmutable('now');
        $this->context['escalatedBy'] = $operatorId;
    }

    /* ---------------------------------------------------------------------
     |  Getters (the aggregate is immutable from the outside)
     | --------------------------------------------------------------------*/
    public function id(): UuidInterface
    {
        return $this->id;
    }

    public function title(): string
    {
        return $this->title;
    }

    public function description(): string
    {
        return $this->description;
    }

    public function severity(): AlertSeverity
    {
        return $this->severity;
    }

    public function status(): AlertStatus
    {
        return $this->status;
    }

    public function tags(): array
    {
        return $this->tags;
    }

    public function context(): array
    {
        return $this->context;
    }

    public function createdAt(): DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function updatedAt(): DateTimeImmutable
    {
        return $this->updatedAt;
    }

    /* ---------------------------------------------------------------------
     |  Utility
     | --------------------------------------------------------------------*/
    public function __toString(): string
    {
        return sprintf(
            '[%s] %s ‑ %s (%s)',
            $this->severity->value,
            $this->title,
            $this->status->value,
            $this->id
        );
    }

    public function jsonSerialize(): array
    {
        return [
            'id'          => $this->id->toString(),
            'title'       => $this->title,
            'description' => $this->description,
            'severity'    => $this->severity->value,
            'status'      => $this->status->value,
            'tags'        => $this->tags,
            'context'     => $this->context,
            'createdAt'   => $this->createdAt->format(DATE_ATOM),
            'updatedAt'   => $this->updatedAt->format(DATE_ATOM),
        ];
    }

    /* ---------------------------------------------------------------------
     |  Validation helpers
     | --------------------------------------------------------------------*/
    private function assertTitle(string $title): void
    {
        if ($title === '' || mb_strlen($title) > 255) {
            throw new RuntimeException('Alert title must be between 1 and 255 characters.');
        }
    }

    private function assertDescription(string $description): void
    {
        if ($description === '') {
            throw new RuntimeException('Alert description cannot be empty.');
        }
    }
}

/* -------------------------------------------------------------------------
 |  Supporting Enumerations
 | ------------------------------------------------------------------------*/

/**
 * Severity scale ordered by criticality.
 */
enum AlertSeverity: string
{
    case INFO     = 'info';
    case LOW      = 'low';
    case MEDIUM   = 'medium';
    case HIGH     = 'high';
    case CRITICAL = 'critical';

    /**
     * Numerical priority—higher value ⇒ more severe.
     */
    public function priority(): int
    {
        return match ($this) {
            self::INFO     => 0,
            self::LOW      => 1,
            self::MEDIUM   => 2,
            self::HIGH     => 3,
            self::CRITICAL => 4,
        };
    }
}

/**
 * Legal life-cycle phases for an Alert.
 */
enum AlertStatus: string
{
    case OPEN         = 'open';
    case ACKNOWLEDGED = 'acknowledged';
    case ESCALATED    = 'escalated';
    case RESOLVED     = 'resolved';
}
```