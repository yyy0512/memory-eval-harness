```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Unit\Application\Command;

use DateTimeImmutable;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use ProdSecureOrchestrator\Application\Command\BlockIpCommand;
use ProdSecureOrchestrator\Application\Command\Handler\BlockIpCommandHandler;
use ProdSecureOrchestrator\Domain\Security\AuditTrail\AuditTrailRepositoryInterface;
use ProdSecureOrchestrator\Domain\Security\Firewall\Exception\InvalidIpAddressException;
use ProdSecureOrchestrator\Domain\Security\Firewall\FirewallAdapterInterface;

/**
 * @covers \ProdSecureOrchestrator\Application\Command\BlockIpCommand
 * @covers \ProdSecureOrchestrator\Application\Command\Handler\BlockIpCommandHandler
 *
 * The BlockIpCommand is part of the Command Pattern layer that encapsulates
 * a remediation action. This test-suite validates both the value-object
 * semantics of the command itself and the collaboration contract between the
 * command handler and its domain services (firewall adapter + audit trail).
 */
final class BlockIpCommandTest extends TestCase
{
    /**
     * Ensures that the value object carries and returns its data as-is.
     */
    public function testCommandInstantiationSetsProperties(): void
    {
        $ip        = '203.0.113.17';
        $reason    = 'Port-scan detected';
        $actor     = 'IDS';
        $timestamp = new DateTimeImmutable('2023-11-11 11:11:11');

        $command = new BlockIpCommand($ip, $reason, $actor, $timestamp);

        self::assertSame($ip,        $command->ip());
        self::assertSame($reason,    $command->reason());
        self::assertSame($actor,     $command->actor());
        self::assertSame($timestamp, $command->occurredOn());
    }

    /**
     * Happy-path: the handler must forward the call to the firewall adapter
     * and persist an audit-trail entry. We use PHPUnit mocks to assert
     * interaction boundaries rather than implementation details.
     */
    public function testHandlerBlocksIpAndCreatesAuditTrail(): void
    {
        $ip     = '198.51.100.42';
        $reason = 'Brute-force SSH login';
        $actor  = 'fail2ban';

        // Firewall shall receive exactly one block() call with canonical args.
        $firewall = $this->createMock(FirewallAdapterInterface::class);
        $firewall->expects(self::once())
                 ->method('block')
                 ->with($ip, $reason, $actor)
                 ->willReturn(true);

        // Audit repository must receive one record() call with entry object.
        $auditRepo = $this->createMock(AuditTrailRepositoryInterface::class);
        $auditRepo->expects(self::once())
                  ->method('record')
                  ->with(self::callback(
                      static function (object $entry) use ($ip, $reason, $actor): bool {
                          // We do a minimal structural check to keep the test
                          // decoupled from the concrete AuditTrailEntry class.
                          return method_exists($entry, 'ip')
                              && method_exists($entry, 'reason')
                              && method_exists($entry, 'actor')
                              && $entry->ip()     === $ip
                              && $entry->reason() === $reason
                              && $entry->actor()  === $actor;
                      }
                  ));

        $logger = $this->createMock(LoggerInterface::class); // no expectations

        $handler = new BlockIpCommandHandler($firewall, $auditRepo, $logger);
        $handler(new BlockIpCommand($ip, $reason, $actor));

        // If an exception is thrown, PHPUnit will mark the test as failed.
        $this->addToAssertionCount(1); // Explicitly mark that we reached here
    }

    /**
     * The command must guard against malformed IP addresses at the earliest
     * point of entry to avoid undefined behavior deeper in the stack.
     */
    public function testInvalidIpAddressThrowsException(): void
    {
        $this->expectException(InvalidIpAddressException::class);
        new BlockIpCommand('999.999.999.999', 'N/A', 'unit-test');
    }
}

```