```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\Command\Remediation;

use ProdSecureOrchestrator\Domain\Event\Security\IpBlockedEvent;
use ProdSecureOrchestrator\Domain\Exception\FirewallException;
use ProdSecureOrchestrator\Domain\Firewall\FirewallManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;
use Symfony\Component\Validator\Constraints as Assert;
use Symfony\Component\Validator\Validator\ValidatorInterface;

/**
 * Command that encapsulates the intent to block a single IP address.
 *
 * The object is:
 *   • Immutable  – once created its state never changes.
 *   • Serializable – can be safely JSON-encoded for queue transport.
 *   • Validatable – Symfony\Validator attributes are provided.
 *
 * Typical usage flow
 *   $bus->dispatch(new BlockIpCommand('10.0.0.42', 'Port-scan detected'));
 */
final class BlockIpCommand
{
    #[Assert\NotBlank]
    #[Assert\Ip]
    private string $ipAddress;

    #[Assert\Length(max: 255)]
    private ?string $reason;

    #[Assert\Positive]
    private ?int $ttlSeconds;

    #[Assert\NotBlank]
    #[Assert\Length(max: 64)]
    private string $triggeredBy;

    private \DateTimeImmutable $timestamp;

    /**
     * @throws \InvalidArgumentException When an invalid IP or TTL is supplied.
     */
    public function __construct(
        string $ipAddress,
        ?string $reason = null,
        ?int $ttlSeconds = null,
        string $triggeredBy = 'system'
    ) {
        // Fail-fast validation before the command even leaves the layer.
        if (!\filter_var($ipAddress, FILTER_VALIDATE_IP)) {
            throw new \InvalidArgumentException(
                sprintf('"%s" is not a valid IPv4/IPv6 address.', $ipAddress)
            );
        }

        if ($ttlSeconds !== null && $ttlSeconds <= 0) {
            throw new \InvalidArgumentException('TTL must be NULL or a positive integer.');
        }

        $this->ipAddress   = $ipAddress;
        $this->reason      = $reason ?? 'Suspicious activity detected';
        $this->ttlSeconds  = $ttlSeconds;
        $this->triggeredBy = $triggeredBy;
        $this->timestamp   = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
    }

    /* -----------------------------------------------------------------
     |  Value Object – public getters
     | -----------------------------------------------------------------*/
    public function getIpAddress(): string
    {
        return $this->ipAddress;
    }

    public function getReason(): string
    {
        return $this->reason;
    }

    public function getTtlSeconds(): ?int
    {
        return $this->ttlSeconds;
    }

    public function getTriggeredBy(): string
    {
        return $this->triggeredBy;
    }

    public function getTimestamp(): \DateTimeImmutable
    {
        return $this->timestamp;
    }

    /* -----------------------------------------------------------------
     |  (De)serialization helpers
     | -----------------------------------------------------------------*/
    /**
     * @return array<string, scalar|null>
     */
    public function toArray(): array
    {
        return [
            'ipAddress'   => $this->ipAddress,
            'reason'      => $this->reason,
            'ttlSeconds'  => $this->ttlSeconds,
            'triggeredBy' => $this->triggeredBy,
            'timestamp'   => $this->timestamp->format(DATE_ATOM),
        ];
    }

    /**
     * @param array<string, scalar|null> $payload
     */
    public static function fromArray(array $payload): self
    {
        $required = ['ipAddress', 'reason', 'ttlSeconds', 'triggeredBy', 'timestamp'];
        foreach ($required as $key) {
            if (!\array_key_exists($key, $payload)) {
                throw new \InvalidArgumentException(
                    sprintf('Missing "%s" when hydrating %s.', $key, self::class)
                );
            }
        }

        $self = new self(
            (string) $payload['ipAddress'],
            $payload['reason'] !== null ? (string) $payload['reason'] : null,
            $payload['ttlSeconds'] !== null ? (int) $payload['ttlSeconds'] : null,
            (string) $payload['triggeredBy'],
        );

        // Overwrite the generated timestamp to preserve the original one.
        $self->timestamp = new \DateTimeImmutable((string) $payload['timestamp']);

        return $self;
    }
}

/* ========================================================================
 |  Command Handler
 |=======================================================================*/

/**
 * Handles a BlockIpCommand by delegating to the FirewallManager service layer.
 *
 * The class is intentionally defined in the same file to keep the example
 * self-contained, though in production each class would typically reside in
 * its own file.
 */
final class BlockIpCommandHandler
{
    public function __construct(
        private readonly FirewallManagerInterface $firewallManager,
        private readonly LoggerInterface $logger,
        private readonly EventDispatcherInterface $dispatcher,
        private readonly ValidatorInterface $validator,
    ) {
    }

    /**
     * Symfony Messenger invokes __invoke() when the message arrives.
     *
     * @throws CommandExecutionException When the firewall action fails.
     */
    public function __invoke(BlockIpCommand $command): void
    {
        // Deep validation using Symfony\Validator.
        $violations = $this->validator->validate($command);
        if (\count($violations) > 0) {
            $this->logger->warning(
                'BlockIpCommand validation failed.',
                ['violations' => (string) $violations]
            );

            throw new CommandExecutionException(
                'BlockIpCommand validation failed: ' . (string) $violations
            );
        }

        try {
            $this->firewallManager->block(
                ip:        $command->getIpAddress(),
                ttl:       $command->getTtlSeconds(),
                reason:    $command->getReason(),
                triggered: $command->getTriggeredBy(),
            );
        } catch (FirewallException $e) {
            $this->logger->error(
                sprintf('Firewall rejected IP block for %s: %s', $command->getIpAddress(), $e->getMessage()),
                ['exception' => $e],
            );

            throw new CommandExecutionException(
                sprintf('Unable to block IP %s.', $command->getIpAddress()),
                0,
                $e
            );
        }

        // Inform the rest of the system that a block occurred.
        $event = new IpBlockedEvent(
            ipAddress:   $command->getIpAddress(),
            reason:      $command->getReason(),
            triggeredBy: $command->getTriggeredBy(),
            ttlSeconds:  $command->getTtlSeconds(),
            timestamp:   $command->getTimestamp(),
        );

        $this->dispatcher->dispatch($event, IpBlockedEvent::NAME);
        $this->logger->info('IP address blocked.', $command->toArray());
    }
}

/* ========================================================================
 |  Supporting Exception
 |=======================================================================*/

/**
 * Generic wrapper around any failure that occurs during execution of a
 * remediation command. Distinct from domain exceptions like FirewallException.
 */
class CommandExecutionException extends \RuntimeException
{
}
```