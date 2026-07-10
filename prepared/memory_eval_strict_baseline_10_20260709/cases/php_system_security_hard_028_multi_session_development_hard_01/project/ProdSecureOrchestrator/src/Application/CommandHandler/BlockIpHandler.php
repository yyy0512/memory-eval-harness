<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\CommandHandler;

use DateTimeImmutable;
use Exception;
use InvalidArgumentException;
use ProdSecureOrchestrator\Application\Command\BlockIpCommand;
use ProdSecureOrchestrator\Application\CommandHandler\Contracts\CommandHandlerInterface;
use ProdSecureOrchestrator\Domain\Audit\AuditLoggerInterface;
use ProdSecureOrchestrator\Domain\Event\EventBusInterface;
use ProdSecureOrchestrator\Domain\Event\Security\IpBlockedEvent;
use ProdSecureOrchestrator\Domain\Exception\FirewallOperationException;
use ProdSecureOrchestrator\Domain\Security\Firewall\FirewallManagerInterface;
use Psr\Log\LoggerInterface;
use Symfony\Component\RateLimiter\LimiterStateInterface;
use Symfony\Component\RateLimiter\RateLimiterFactory;
use Symfony\Component\RateLimiter\RateLimiterInterface;
use Throwable;

/**
 * Handles the BlockIpCommand.
 *
 * Responsibilities:
 *  - Validate incoming command data
 *  - Throttle excessive requests (rate-limiting)
 *  - Delegate firewall operations
 *  - Persist audit logs
 *  - Broadcast domain events
 *  - Provide detailed error handling & logging
 *
 * The handler is designed to be stateless, reusable, and thread-safe.
 *
 * @author  ProdSecure Engineering
 * @license Proprietary
 */
final class BlockIpHandler implements CommandHandlerInterface
{
    private FirewallManagerInterface $firewallManager;
    private AuditLoggerInterface     $auditLogger;
    private EventBusInterface        $eventBus;
    private LoggerInterface          $logger;
    private RateLimiterInterface     $rateLimiter;

    public function __construct(
        FirewallManagerInterface $firewallManager,
        AuditLoggerInterface $auditLogger,
        EventBusInterface $eventBus,
        LoggerInterface $logger,
        RateLimiterFactory $rateLimiterFactory
    ) {
        $this->firewallManager = $firewallManager;
        $this->auditLogger     = $auditLogger;
        $this->eventBus        = $eventBus;
        $this->logger          = $logger;

        /**
         * We create a dedicated rate-limiter bucket for this handler.
         *  - id: "block-ip-handler"
         *  - limit: 10 calls per minute (configurable via DI)
         */
        $this->rateLimiter = $rateLimiterFactory->create('block-ip-handler');
    }

    /**
     * Execute the command.
     *
     * @throws FirewallOperationException   When the firewall driver fails
     * @throws InvalidArgumentException     When the command contains invalid data
     */
    public function __invoke(BlockIpCommand $command): void
    {
        $startTime = microtime(true);

        // 1. Validate command.
        $this->assertValid($command);

        // 2. Rate-limit.
        $limiterState = $this->consumeRateLimit();
        if (!$limiterState->isAccepted()) {
            $this->logger->warning(
                'Rate-limit exceeded when attempting to block IP.',
                [
                    'ip'       => $command->getIpAddress(),
                    'limit'    => $limiterState->getLimit(),
                    'retryIn'  => $limiterState->getRetryAfter()->getTimestamp(),
                    'triggeredBy' => $command->getTriggeredBy(),
                ]
            );

            // Early exit – do not process further to protect underlying resources.
            return;
        }

        // 3. Execute firewall action.
        try {
            $this->firewallManager->blockIp(
                $command->getIpAddress(),
                $command->getTtl(),
                $command->getReason()
            );
        } catch (Throwable $e) {
            $this->logger->error(
                'Failed to block IP on firewall.',
                [
                    'ip'        => $command->getIpAddress(),
                    'reason'    => $command->getReason(),
                    'ttl'       => $command->getTtl(),
                    'exception' => $e,
                ]
            );

            throw new FirewallOperationException(
                sprintf('Unable to block IP [%s] – %s', $command->getIpAddress(), $e->getMessage()),
                previous: $e
            );
        }

        // 4. Audit log.
        $this->auditLogger->log(
            'security.ip.blocked',
            [
                'ip'        => $command->getIpAddress(),
                'reason'    => $command->getReason(),
                'ttl'       => $command->getTtl(),
                'user'      => $command->getTriggeredBy(),
                'timestamp' => new DateTimeImmutable(),
            ]
        );

        // 5. Dispatch domain event.
        $this->eventBus->dispatch(
            new IpBlockedEvent(
                $command->getIpAddress(),
                $command->getReason(),
                $command->getTtl(),
                $command->getTriggeredBy()
            )
        );

        $this->logger->info(
            'IP blocked successfully.',
            [
                'ip'        => $command->getIpAddress(),
                'duration'  => round((microtime(true) - $startTime) * 1000, 2) . 'ms',
                'triggeredBy' => $command->getTriggeredBy(),
            ]
        );
    }

    /**
     * Validate command fields.
     *
     * @throws InvalidArgumentException
     */
    private function assertValid(BlockIpCommand $command): void
    {
        if (!filter_var($command->getIpAddress(), FILTER_VALIDATE_IP)) {
            throw new InvalidArgumentException(sprintf(
                'Invalid IP address supplied: "%s".',
                $command->getIpAddress()
            ));
        }

        if ($command->getTtl() < 0) {
            throw new InvalidArgumentException('TTL must be a positive integer number of seconds.');
        }
    }

    /**
     * Consume one token from the rate-limiter and return the limiter state.
     */
    private function consumeRateLimit(): LimiterStateInterface
    {
        return $this->rateLimiter->consume();
    }
}