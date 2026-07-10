```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\Event\Backup;

use DateTimeImmutable;
use JsonSerializable;
use ProdSecureOrchestrator\Domain\Event\DomainEventInterface;
use ProdSecureOrchestrator\Shared\ValueObject\Environment;
use ProdSecureOrchestrator\Shared\ValueObject\Uuid;
use RuntimeException;

/**
 * BackupFailedEvent is raised whenever a backup or snapshot operation fails.
 *
 * In line with the Chain-of-Responsibility + Strategy pipeline, this event is consumed
 * by escalation handlers that may retry the job, roll back partially-completed tasks,
 * or notify on-call responders via the alerting subsystem.
 *
 * @author
 */
final class BackupFailedEvent implements DomainEventInterface, JsonSerializable
{
    /** Semantic versioning of the event payload – allows consumers to evolve safely. */
    public const SCHEMA_VERSION = 1;

    private Uuid $eventId;
    private Uuid $backupId;
    private Environment $environment;
    private string $nodeFqdn;
    private string $reason;
    private array $context;
    private DateTimeImmutable $occurredAt;

    /**
     * @param Uuid                $backupId     Correlates to BackupJob aggregate ID
     * @param Environment         $environment  Dev|Staging|Prod, etc.
     * @param string              $nodeFqdn     Host that initiated or executed the backup
     * @param string              $reason       Human-readable failure cause
     * @param array<string,mixed> $context      Additional non-PII diagnostics
     * @param DateTimeImmutable   $occurredAt   Moment the failure occurred, not when persisted
     */
    private function __construct(
        Uuid $backupId,
        Environment $environment,
        string $nodeFqdn,
        string $reason,
        array $context,
        DateTimeImmutable $occurredAt
    ) {
        if (trim($reason) === '') {
            throw new RuntimeException('Reason must not be empty');
        }

        $this->eventId     = Uuid::v4();
        $this->backupId    = $backupId;
        $this->environment = $environment;
        $this->nodeFqdn    = $nodeFqdn;
        $this->reason      = $reason;
        $this->context     = $context;
        $this->occurredAt  = $occurredAt;
    }

    /**
     * Factory helper that converts throwable into an event instance.
     *
     * @param Uuid        $backupId
     * @param Environment $environment
     * @param string      $nodeFqdn
     * @param \Throwable  $exception
     * @param array       $extraContext
     */
    public static function fromException(
        Uuid $backupId,
        Environment $environment,
        string $nodeFqdn,
        \Throwable $exception,
        array $extraContext = []
    ): self {
        $context = array_merge(
            [
                'exception'  => get_class($exception),
                'message'    => $exception->getMessage(),
                'code'       => $exception->getCode(),
                'stackTrace' => $exception->getTraceAsString(),
            ],
            $extraContext
        );

        return new self(
            $backupId,
            $environment,
            $nodeFqdn,
            $exception->getMessage(),
            $context,
            new DateTimeImmutable()
        );
    }

    /**
     * Reconstitute event from storage (e.g., event-store snapshot).
     *
     * @param array<string,mixed> $payload
     */
    public static function fromPayload(array $payload): self
    {
        foreach (['backupId', 'environment', 'nodeFqdn', 'reason', 'context', 'occurredAt'] as $key) {
            if (!array_key_exists($key, $payload)) {
                throw new RuntimeException("Missing key '{$key}' in event payload");
            }
        }

        return new self(
            Uuid::fromString($payload['backupId']),
            Environment::from($payload['environment']),
            $payload['nodeFqdn'],
            $payload['reason'],
            $payload['context'],
            new DateTimeImmutable($payload['occurredAt'])
        );
    }

    /* -----------------------
     *  DomainEventInterface
     * ---------------------*/

    public function eventId(): Uuid
    {
        return $this->eventId;
    }

    public function occurredAt(): DateTimeImmutable
    {
        return $this->occurredAt;
    }

    /**
     * @return array<string,mixed>
     */
    public function toPayload(): array
    {
        return [
            'schemaVersion' => self::SCHEMA_VERSION,
            'eventId'       => $this->eventId->toString(),
            'backupId'      => $this->backupId->toString(),
            'environment'   => $this->environment->value,
            'nodeFqdn'      => $this->nodeFqdn,
            'reason'        => $this->reason,
            'context'       => $this->context,
            'occurredAt'    => $this->occurredAt->format(DateTimeImmutable::ATOM),
        ];
    }

    /* -------------
     *  JsonSerializable
     * ------------- */

    /**
     * @return array<string,mixed>
     */
    public function jsonSerialize(): array
    {
        return $this->toPayload();
    }

    /* -------------
     *  Accessors
     * ----------- */

    public function backupId(): Uuid
    {
        return $this->backupId;
    }

    public function environment(): Environment
    {
        return $this->environment;
    }

    public function nodeFqdn(): string
    {
        return $this->nodeFqdn;
    }

    public function reason(): string
    {
        return $this->reason;
    }

    /**
     * @return array<string,mixed>
     */
    public function context(): array
    {
        return $this->context;
    }
}
```