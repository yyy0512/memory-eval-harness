<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Unit\Domain\EventProcessing;

use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use ProdSecureOrchestrator\Domain\Event\EventInterface;
use ProdSecureOrchestrator\Domain\Event\GenericEvent;
use ProdSecureOrchestrator\Domain\EventProcessing\EventPipeline;
use ProdSecureOrchestrator\Domain\EventProcessing\Exception\EventDroppedException;
use ProdSecureOrchestrator\Domain\EventProcessing\Handler\EscalationHandler;
use ProdSecureOrchestrator\Domain\EventProcessing\Handler\EventHandlerInterface;
use ProdSecureOrchestrator\Domain\EventProcessing\Handler\ThrottlingHandler;
use ProdSecureOrchestrator\Domain\ValueObject\TenantId;

/**
 * @covers \ProdSecureOrchestrator\Domain\EventProcessing\EventPipeline
 *
 * The EventPipeline is the heart of the Chain-of-Responsibility implementation.
 * A single event is routed through a customizable list of EventHandlerInterface
 * implementations. Each handler may mutate the event, short-circuit the chain,
 * or raise domain exceptions. The pipeline is *state-less* by design so that
 * the same instance can be reused across requests without accidental leakage
 * of contextual data between tenants.
 *
 * This test suite validates:
 *   – Correct sequential invocation of handlers
 *   – Early exit when a handler signals throttling or dropping
 *   – Guaranteed no-op behaviour after exceptions (idempotency)
 *   – Isolation between multiple pipeline invocations
 */
final class EventPipelineTest extends TestCase
{
    /** @var MockObject&EventHandlerInterface */
    private $firstHandler;

    /** @var MockObject&EventHandlerInterface */
    private $secondHandler;

    /** @var MockObject&EventHandlerInterface */
    private $terminalHandler;

    /** @var EventPipeline */
    private EventPipeline $pipeline;

    protected function setUp(): void
    {
        parent::setUp();

        // Create handler mocks
        $this->firstHandler    = $this->createMock(EventHandlerInterface::class);
        $this->secondHandler   = $this->createMock(EventHandlerInterface::class);
        $this->terminalHandler = $this->createMock(EventHandlerInterface::class);

        // System-under-test
        $this->pipeline = new EventPipeline(
            $this->firstHandler,
            $this->secondHandler,
            $this->terminalHandler
        );
    }

    public function test_event_passes_through_all_handlers_in_order(): void
    {
        $tenant = TenantId::generate();
        $event  = new GenericEvent($tenant, 'CPU_SPIKE', ['load' => 97.5]);

        // Expectations
        $this->firstHandler
            ->expects(self::once())
            ->method('handle')
            ->with($event)
            ->willReturnCallback(static function (EventInterface $evt): EventInterface {
                // Enrich event — pretend we add extra context
                $evt->addContext('enriched', true);
                return $evt;
            });

        $this->secondHandler
            ->expects(self::once())
            ->method('handle')
            ->with($event)
            ->willReturnCallback(static function (EventInterface $evt): EventInterface {
                // No change, simply pass through
                return $evt;
            });

        $this->terminalHandler
            ->expects(self::once())
            ->method('handle')
            ->with($event)
            ->willReturn($event);

        $processedEvent = $this->pipeline->process($event);

        self::assertSame($event, $processedEvent);
        self::assertTrue($processedEvent->getContext('enriched'));
    }

    public function test_pipeline_stops_when_handler_drops_event(): void
    {
        $tenancyEvent = new GenericEvent(TenantId::generate(), 'REDIS_DOWN');

        // First handler decides to drop the event entirely
        $this->firstHandler
            ->expects(self::once())
            ->method('handle')
            ->willThrowException(new EventDroppedException('Unit-test forced drop'));

        // Downstream handlers MUST NOT be invoked
        $this->secondHandler->expects(self::never())->method('handle');
        $this->terminalHandler->expects(self::never())->method('handle');

        $this->expectException(EventDroppedException::class);

        $this->pipeline->process($tenancyEvent);
    }

    public function test_pipeline_short_circuits_on_throttling_handler(): void
    {
        $evt = new GenericEvent(TenantId::generate(), 'CPU_SPIKE');

        // Mock a dedicated throttling handler
        /** @var MockObject&ThrottlingHandler $throttlingHandler */
        $throttlingHandler = $this->createMock(ThrottlingHandler::class);

        $throttlingHandler
            ->expects(self::once())
            ->method('handle')
            ->with($evt)
            ->willReturnCallback(static function (EventInterface $event): EventInterface {
                // Tag event as throttled. Convention: returns same event but marks header.
                $event->addContext('throttled', true);
                return $event;
            });

        $this->secondHandler->expects(self::never())->method('handle');
        $this->terminalHandler->expects(self::never())->method('handle');

        $pipeline = new EventPipeline(
            $throttlingHandler,
            $this->secondHandler,
            $this->terminalHandler
        );

        $result = $pipeline->process($evt);

        self::assertTrue($result->getContext('throttled'));
    }

    public function test_escalation_handler_wraps_event_with_metadata(): void
    {
        $evt            = new GenericEvent(TenantId::generate(), 'BACKUP_FAILURE');
        $escalationNote = 'Critical nightly backup failure ‑ escalate to on-call';

        /** @var MockObject&EscalationHandler $escalationHandler */
        $escalationHandler = $this->createMock(EscalationHandler::class);

        $escalationHandler
            ->expects(self::once())
            ->method('handle')
            ->with($evt)
            ->willReturnCallback(static function (EventInterface $event) use ($escalationNote): EventInterface {
                $event->addContext('escalated', true);
                $event->addContext('note', $escalationNote);
                return $event;
            });

        // Terminal must still execute so downstream listeners are notified
        $this->terminalHandler
            ->expects(self::once())
            ->method('handle')
            ->willReturn($evt);

        $pipeline = new EventPipeline(
            $escalationHandler,
            $this->terminalHandler
        );

        $processed = $pipeline->process($evt);

        self::assertTrue($processed->getContext('escalated'));
        self::assertSame($escalationNote, $processed->getContext('note'));
    }

    public function test_pipeline_can_be_reused_for_multiple_calls_without_state_leakage(): void
    {
        $evt1 = new GenericEvent(TenantId::generate(), 'HTTP_500');
        $evt2 = new GenericEvent(TenantId::generate(), 'DISK_SPACE_LOW');

        // Reset handler mocks for fresh expectations
        $this->firstHandler->expects(self::exactly(2))
            ->method('handle')
            ->willReturnCallback(static function (EventInterface $event): EventInterface {
                // No persistent modifications
                return $event;
            });

        $this->secondHandler->expects(self::exactly(2))
            ->method('handle')
            ->willReturnCallback(static function (EventInterface $event): EventInterface {
                return $event;
            });

        $this->terminalHandler->expects(self::exactly(2))
            ->method('handle')
            ->willReturnCallback(static function (EventInterface $event): EventInterface {
                return $event;
            });

        $result1 = $this->pipeline->process($evt1);
        $result2 = $this->pipeline->process($evt2);

        self::assertSame($evt1, $result1);
        self::assertSame($evt2, $result2);
        self::assertFalse($result1->hasContext('escalated'));
        self::assertFalse($result2->hasContext('escalated'));
    }
}