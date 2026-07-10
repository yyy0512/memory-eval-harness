```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Unit\Domain\EventProcessing\Handlers;

use Domain\EventProcessing\Contracts\EventHandlerInterface;
use Domain\EventProcessing\Contracts\RateLimiterInterface;
use Domain\EventProcessing\DTO\Event;
use Domain\EventProcessing\DTO\HandlerResponse;
use Domain\EventProcessing\Handlers\ThrottlingHandler;
use PHPUnit\Framework\TestCase;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * @covers \Domain\EventProcessing\Handlers\ThrottlingHandler
 *
 * The ThrottlingHandler is responsible for ensuring that noisy or malicious
 * event sources do not overwhelm the rest of the Event-Processing chain.
 *
 * It relies on a RateLimiter implementation (backed by Redis or another
 * distributed store in production) and MUST:
 *  - Delegate to the next handler when the rate-limit is NOT exceeded
 *  - Short-circuit the chain with a THROTTLED status when the limit is hit
 *  - Gracefully degrade (and log an error) when the rate-limiter backend
 *    itself becomes unavailable
 */
final class ThrottlingHandlerTest extends TestCase
{
    // ---------------------------------------------------------------------
    // Happy Path
    // ---------------------------------------------------------------------

    public function test_it_passes_the_event_down_the_chain_when_not_throttled(): void
    {
        /** Arrange ***********************************************************************/

        $event = $this->createMock(Event::class);
        $event->method('getSourceId')->willReturn('host-01');

        $rateLimiter = $this->createMock(RateLimiterInterface::class);
        $rateLimiter
            ->expects(self::once())
            ->method('allows')
            ->with('host-01')
            ->willReturn(true);

        $logger = $this->createMock(LoggerInterface::class);
        $logger->expects(self::never())->method('warning');

        $expectedResponse = new HandlerResponse(HandlerResponse::STATUS_PASSED);

        $nextHandler = $this->createMock(EventHandlerInterface::class);
        $nextHandler
            ->expects(self::once())
            ->method('handle')
            ->with($event)
            ->willReturn($expectedResponse);

        $sut = new ThrottlingHandler($rateLimiter, $logger, $nextHandler);

        /** Act ***************************************************************************/

        $actual = $sut->handle($event);

        /** Assert ************************************************************************/

        self::assertSame($expectedResponse, $actual, 'Event should bubble down untouched.');
    }

    // ---------------------------------------------------------------------
    // Throttled Path
    // ---------------------------------------------------------------------

    public function test_it_throttles_and_logs_when_the_rate_limit_is_exceeded(): void
    {
        /** Arrange ***********************************************************************/

        $event = $this->createMock(Event::class);
        $event->method('getSourceId')->willReturn('host-02');

        $rateLimiter = $this->createMock(RateLimiterInterface::class);
        $rateLimiter
            ->expects(self::once())
            ->method('allows')
            ->with('host-02')
            ->willReturn(false);

        $logger = $this->createMock(LoggerInterface::class);
        $logger
            ->expects(self::once())
            ->method('warning')
            ->with(
                $this->stringContains('Throttled event'),
                $this->arrayHasKey('source_id')
            );

        $nextHandler = $this->createMock(EventHandlerInterface::class);
        $nextHandler->expects(self::never())->method('handle');

        $sut = new ThrottlingHandler($rateLimiter, $logger, $nextHandler);

        /** Act ***************************************************************************/

        $response = $sut->handle($event);

        /** Assert ************************************************************************/

        self::assertSame(HandlerResponse::STATUS_THROTTLED, $response->getStatus());
        self::assertFalse($response->shouldContinue(), 'Chain MUST short-circuit when throttled.');
    }

    // ---------------------------------------------------------------------
    // Failure of the Rate-Limiter backend
    // ---------------------------------------------------------------------

    public function test_it_logs_the_error_and_continues_when_the_rate_limiter_fails(): void
    {
        /** Arrange ***********************************************************************/

        $event = $this->createMock(Event::class);
        $event->method('getSourceId')->willReturn('host-03');

        $rateLimiter = $this->createMock(RateLimiterInterface::class);
        $rateLimiter
            ->expects(self::once())
            ->method('allows')
            ->willThrowException(new RuntimeException('Redis is down'));

        $logger = $this->createMock(LoggerInterface::class);
        $logger
            ->expects(self::once())
            ->method('error')
            ->with(
                $this->stringContains('Rate limiter failure'),
                $this->arrayHasKey('exception')
            );

        $expectedResponse = new HandlerResponse(HandlerResponse::STATUS_PASSED);

        $nextHandler = $this->createMock(EventHandlerInterface::class);
        $nextHandler
            ->expects(self::once())
            ->method('handle')
            ->with($event)
            ->willReturn($expectedResponse);

        $sut = new ThrottlingHandler($rateLimiter, $logger, $nextHandler);

        /** Act ***************************************************************************/

        $actual = $sut->handle($event);

        /** Assert ************************************************************************/

        self::assertSame($expectedResponse, $actual);
    }

    // ---------------------------------------------------------------------
    // Stress / Data-Provider-Driven Test
    // ---------------------------------------------------------------------

    /**
     * @dataProvider burstEventsDataProvider
     */
    public function test_handling_of_burst_traffic(string $sourceId, bool $isThrottled): void
    {
        /** Arrange ***********************************************************************/

        $event = $this->createMock(Event::class);
        $event->method('getSourceId')->willReturn($sourceId);

        $rateLimiter = $this->createMock(RateLimiterInterface::class);
        $rateLimiter->method('allows')->willReturn(!$isThrottled);

        $logger = $this->createMock(LoggerInterface::class);

        $nextHandler = $this->createMock(EventHandlerInterface::class);

        if ($isThrottled) {
            $logger->expects(self::once())->method('warning');
            $nextHandler->expects(self::never())->method('handle');
        } else {
            $logger->expects(self::never())->method('warning');
            $nextHandler
                ->expects(self::once())
                ->method('handle')
                ->with($event)
                ->willReturn(new HandlerResponse(HandlerResponse::STATUS_PASSED));
        }

        $sut = new ThrottlingHandler($rateLimiter, $logger, $nextHandler);

        /** Act ***************************************************************************/

        $response = $sut->handle($event);

        /** Assert ************************************************************************/

        self::assertSame(
            $isThrottled ? HandlerResponse::STATUS_THROTTLED : HandlerResponse::STATUS_PASSED,
            $response->getStatus()
        );
    }

    /**
     * Provides a mixture of throttled and clean events to simulate burst traffic.
     */
    public function burstEventsDataProvider(): array
    {
        return [
            ['burst-host-A', false],
            ['burst-host-B', true],
            ['burst-host-C', false],
        ];
    }
}

```