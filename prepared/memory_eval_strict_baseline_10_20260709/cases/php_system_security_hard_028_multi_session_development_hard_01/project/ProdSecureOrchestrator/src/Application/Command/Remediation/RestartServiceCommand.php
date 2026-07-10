```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Application\Command\Remediation;

use ProdSecureOrchestrator\Domain\Remediation\RemediationCommandInterface;
use ProdSecureOrchestrator\Domain\System\SystemManagerInterface;
use ProdSecureOrchestrator\Domain\Audit\AuditLoggerInterface;
use ProdSecureOrchestrator\Domain\Event\Remediation\RemediationFailedEvent;
use ProdSecureOrchestrator\Domain\Event\Remediation\RemediationSucceededEvent;
use Psr\EventDispatcher\EventDispatcherInterface;
use RuntimeException;
use Throwable;

/**
 * RestartServiceCommand
 *
 * A Command-Pattern object that performs a safe restart of a system service.
 * ────────────────────────────────────────────────────────────────────────────
 * • Captures pre-execution service status for rollback.
 * • Implements exponential back-off with decorrelated jitter.
 * • Emits domain events for success / failure.
 * • Generates an exhaustive audit trail.
 *
 * This class is intentionally side-effect free apart from the encapsulated
 * SystemManagerInterface dependency, making it suitable for unit testing
 * via mock objects.
 *
 * @package ProdSecureOrchestrator\Application\Command\Remediation
 */
class RestartServiceCommand implements RemediationCommandInterface
{
    /**
     * Maximum restart attempts before declaring failure.
     */
    private const MAX_ATTEMPTS  = 5;

    /**
     * Base delay (in milliseconds) for back-off algorithm.
     */
    private const BASE_DELAY_MS = 250;

    private string $serviceName;
    private SystemManagerInterface $systemManager;
    private AuditLoggerInterface $auditLogger;
    private EventDispatcherInterface $dispatcher;

    /**
     * Snapshot of the service’s status before we start mutating it.
     */
    private ?string $initialStatus = null;

    public function __construct(
        string $serviceName,
        SystemManagerInterface $systemManager,
        AuditLoggerInterface $auditLogger,
        EventDispatcherInterface $dispatcher
    ) {
        $this->serviceName   = trim($serviceName);
        $this->systemManager = $systemManager;
        $this->auditLogger   = $auditLogger;
        $this->dispatcher    = $dispatcher;
    }

    /**
     * Perform the restart operation.
     *
     * @throws RuntimeException When restart ultimately fails.
     */
    public function execute(): void
    {
        $this->validateServiceName();

        // Hold the original status for potential rollback.
        $this->initialStatus = $this->systemManager->status($this->serviceName);

        $this->auditLogger->info(sprintf(
            '[%s] Initiating service restart. Initial status: "%s".',
            $this,
            $this->initialStatus
        ));

        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; ++$attempt) {
            try {
                $this->systemManager->restart($this->serviceName);

                // Confirm service health.
                if ($this->systemManager->isActive($this->serviceName)) {
                    $this->auditLogger->info(sprintf(
                        '[%s] Service successfully restarted on attempt #%d.',
                        $this,
                        $attempt
                    ));

                    $this->dispatcher->dispatch(
                        new RemediationSucceededEvent($this->serviceName, self::class)
                    );

                    return; // Success!
                }

                $this->auditLogger->warning(sprintf(
                    '[%s] Restart attempt #%d completed but service is not active; retrying.',
                    $this,
                    $attempt
                ));
            } catch (Throwable $e) {
                // We treat any throwable the same—log and potentially retry.
                $this->auditLogger->error(sprintf(
                    '[%s] Exception during restart attempt #%d: %s',
                    $this,
                    $attempt,
                    $e->getMessage()
                ), ['exception' => $e]);
            }

            // Apply decorrelated jitter back-off before next attempt.
            usleep($this->computeDelayMs($attempt) * 1000);
        }

        // All retries exhausted—initiate rollback and escalate.
        $this->rollback();

        $this->dispatcher->dispatch(
            new RemediationFailedEvent($this->serviceName, self::class)
        );

        throw new RuntimeException(sprintf(
            '[%s] Failed to restart service after %d attempts.',
            $this,
            self::MAX_ATTEMPTS
        ));
    }

    /**
     * Undo the effects of execute() when it does not succeed.
     */
    public function rollback(): void
    {
        if ($this->initialStatus === null) {
            return; // No rollback possible.
        }

        try {
            switch ($this->initialStatus) {
                case SystemManagerInterface::STATUS_ACTIVE:
                    $this->systemManager->start($this->serviceName);
                    break;
                case SystemManagerInterface::STATUS_INACTIVE:
                case SystemManagerInterface::STATUS_FAILED:
                    $this->systemManager->stop($this->serviceName);
                    break;
            }

            $this->auditLogger->warning(sprintf(
                '[%s] Rollback executed. Service reverted to initial status "%s".',
                $this,
                $this->initialStatus
            ));
        } catch (Throwable $e) {
            $this->auditLogger->critical(sprintf(
                '[%s] Rollback failed: %s',
                $this,
                $e->getMessage()
            ), ['exception' => $e]);
        }
    }

    /**
     * Validate service name against a whitelist regex.
     */
    private function validateServiceName(): void
    {
        if ($this->serviceName === '') {
            throw new RuntimeException('Service name cannot be empty.');
        }

        if (!preg_match('/^[A-Za-z0-9_.@\-]+$/', $this->serviceName)) {
            throw new RuntimeException(sprintf(
                'Invalid service name "%s"; only [A-Za-z0-9_.@-] are allowed.',
                $this->serviceName
            ));
        }
    }

    /**
     * Compute back-off delay following the “decorrelated jitter” strategy.
     */
    private function computeDelayMs(int $attempt): int
    {
        $maxDelay = min(
            (1 << $attempt) * self::BASE_DELAY_MS,
            30_000 // 30-second ceiling.
        );

        return random_int(self::BASE_DELAY_MS, $maxDelay);
    }

    public function __toString(): string
    {
        return sprintf('%s<%s>', self::class, $this->serviceName);
    }
}
```