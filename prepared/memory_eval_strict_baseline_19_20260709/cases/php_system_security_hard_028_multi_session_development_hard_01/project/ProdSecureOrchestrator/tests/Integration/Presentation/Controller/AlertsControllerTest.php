```php
<?php
declare(strict_types=1);

/**
 * ProdSecure Orchestrator
 *
 * @file   AlertsControllerTest.php
 * @date   2024-03-20
 *
 * Integration-level tests for the HTTP Alert Controller.
 *
 * These tests boot the Symfony kernel (test environment) and override
 * selected services so that we can assert against side-effects without
 * touching external resources (DB, Message-Bus, etc.).
 */

namespace ProdSecureOrchestrator\Tests\Integration\Presentation\Controller;

use DateTimeImmutable;
use PHPUnit\Framework\Assert;
use Prophecy\PhpUnit\ProphecyTrait;
use Symfony\Bundle\FrameworkBundle\KernelBrowser;
use Symfony\Bundle\FrameworkBundle\Test\WebTestCase;
use Symfony\Component\HttpFoundation\Response;
use ProdSecureOrchestrator\Domain\Alert\Alert;
use ProdSecureOrchestrator\Domain\Alert\AlertRepositoryInterface;
use ProdSecureOrchestrator\Application\Command\AcknowledgeAlertCommand;
use ProdSecureOrchestrator\Application\CommandBusInterface;

/**
 * @coversDefaultClass \ProdSecureOrchestrator\Presentation\Controller\AlertsController
 */
final class AlertsControllerTest extends WebTestCase
{
    use ProphecyTrait;

    private KernelBrowser $client;
    private InMemoryAlertRepository $alertRepository;
    private SpyCommandBus $commandBus;

    protected function setUp(): void
    {
        self::ensureKernelShutdown();
        $this->client          = self::createClient();
        $this->alertRepository = new InMemoryAlertRepository();
        $this->commandBus      = new SpyCommandBus();

        // Seed repository with two sample alerts
        $this->alertRepository->save(
            new Alert(
                'ALRT-0113',
                'critical',
                'Intrusion attempt detected on node edge-01',
                new DateTimeImmutable('-5 minutes'),
                false
            )
        );
        $this->alertRepository->save(
            new Alert(
                'ALRT-0114',
                'warning',
                'High CPU load on db-replica-04',
                new DateTimeImmutable('-2 minutes'),
                false
            )
        );

        // Override service definitions in the test container
        $container = self::getContainer();
        $container->set(AlertRepositoryInterface::class, $this->alertRepository);
        $container->set(CommandBusInterface::class,      $this->commandBus);
    }

    /**
     * Ensures the /alerts collection endpoint returns well-formed JSON
     * with the expected business fields and appropriate headers.
     */
    public function testListAlertsReturnsJsonAnd200(): void
    {
        $this->client->request('GET', '/api/v1/alerts?status=open');

        $response = $this->client->getResponse();

        Assert::assertSame(Response::HTTP_OK, $response->getStatusCode());
        Assert::assertTrue(
            $response->headers->contains('Content-Type', 'application/json'),
            'Response must be JSON'
        );

        $json = json_decode($response->getContent(), true, 512, JSON_THROW_ON_ERROR);

        Assert::assertIsArray($json);
        Assert::assertCount(2, $json);

        foreach ($json as $alert) {
            Assert::assertArrayHasKey('id',           $alert);
            Assert::assertArrayHasKey('severity',     $alert);
            Assert::assertArrayHasKey('message',      $alert);
            Assert::assertArrayHasKey('created_at',   $alert);
            Assert::assertArrayHasKey('acknowledged', $alert);
        }

        // Verify rate-limiting or caching headers are set by the
        // API Gateway layer so that clients can plan retries.
        Assert::assertTrue(
            $response->headers->has('X-RateLimit-Remaining'),
            'Missing X-RateLimit-Remaining header'
        );
    }

    /**
     * Happy-path scenario: acknowledge a single alert by ID.
     */
    public function testAcknowledgeAlertReturns204AndDispatchesCommand(): void
    {
        $alertId = 'ALRT-0113';

        $this->client->request('POST', sprintf('/api/v1/alerts/%s/ack', $alertId));

        $response = $this->client->getResponse();

        Assert::assertSame(Response::HTTP_NO_CONTENT, $response->getStatusCode());

        /** @var AcknowledgeAlertCommand|null $command */
        $command = $this->commandBus->lastDispatched();

        Assert::assertInstanceOf(AcknowledgeAlertCommand::class, $command);
        Assert::assertSame($alertId, $command->alertId);
    }

    /**
     * Edge-case: attempt to acknowledge a non-existing alert.
     */
    public function testAcknowledgeUnknownAlertReturns404(): void
    {
        $this->client->request('POST', '/api/v1/alerts/UNKNOWN/ack');

        $response = $this->client->getResponse();

        Assert::assertSame(Response::HTTP_NOT_FOUND, $response->getStatusCode());

        // Command Bus must not have received any command
        Assert::assertNull($this->commandBus->lastDispatched());
    }

    /**
     * Edge-case: invalid HTTP method payload (e.g. JSON instead of empty body).
     */
    public function testAcknowledgeAlertWithInvalidPayloadReturns400(): void
    {
        $this->client->request(
            'POST',
            '/api/v1/alerts/ALRT-0113/ack',
            [],
            [],
            ['CONTENT_TYPE' => 'application/json'],
            json_encode(['unexpected' => 'value'], JSON_THROW_ON_ERROR)
        );

        $response = $this->client->getResponse();

        Assert::assertSame(Response::HTTP_BAD_REQUEST, $response->getStatusCode());
        Assert::assertNull($this->commandBus->lastDispatched());
    }

    // ---------------------------------------------------------------------
    // Helper classes
    // ---------------------------------------------------------------------

    /**
     * A lightweight in-memory repository to fake DB persistence for tests.
     */
    private final class InMemoryAlertRepository implements AlertRepositoryInterface
    {
        /** @var array<string,Alert> */
        private array $storage = [];

        public function save(Alert $alert): void
        {
            $this->storage[$alert->getId()] = $alert;
        }

        public function find(string $id): ?Alert
        {
            return $this->storage[$id] ?? null;
        }

        /** @return Alert[] */
        public function findByStatus(string $status): array
        {
            return array_filter(
                $this->storage,
                static fn(Alert $alert): bool => $alert->isAcknowledged() === ($status !== 'open')
            );
        }
    }

    /**
     * A spy Command Bus to capture dispatched commands for assertion.
     */
    private final class SpyCommandBus implements CommandBusInterface
    {
        private ?object $lastDispatched = null;

        public function dispatch(object $command): void
        {
            $this->lastDispatched = $command;
        }

        public function lastDispatched(): ?object
        {
            return $this->lastDispatched;
        }
    }
}
```