<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Tests\Integration\ServiceMesh;

use PHPUnit\Framework\TestCase;
use ProdSecureOrchestrator\ServiceMesh\ServiceRegistry;
use ProdSecureOrchestrator\ServiceMesh\Driver\ServiceDiscoveryDriverInterface;
use ProdSecureOrchestrator\ServiceMesh\Exception\ServiceNotFoundException;
use Psr\Log\NullLogger;
use Symfony\Component\Cache\Adapter\ArrayAdapter;

/**
 * Integration-level tests for the ServiceRegistry abstraction that is responsible
 * for interacting with the underlying service-mesh control-plane (Consul, etcd, …
 * via ServiceDiscoveryDriverInterface), while providing local caching, automatic
 * health-check refreshing, and circuit-breaker semantics.
 *
 * NOTE: These tests purposefully make use of an in-memory StubDriver in order to
 * exercise the higher-level orchestration logic of the ServiceRegistry without
 * requiring an actual Consul / etcd instance to be running inside the CI
 * pipeline. The goal is to verify that the registry persists, caches, and
 * invalidates data correctly, and that error paths are surfaced as exceptions.
 *
 * When a real control-plane is available, this test-case can be subclassed and
 * the {@see createDriver()} factory can be overridden to supply a concrete
 * implementation that talks to the live environment.
 *
 * @covers \ProdSecureOrchestrator\ServiceMesh\ServiceRegistry
 */
final class ServiceRegistryTest extends TestCase
{
    private const DEFAULT_TTL = 5; // seconds

    private ServiceRegistry $registry;
    private InstrumentedStubDriver $driver;

    protected function setUp(): void
    {
        parent::setUp();

        $this->driver   = new InstrumentedStubDriver();
        $this->registry = new ServiceRegistry(
            driver: $this->driver,
            cache:  new ArrayAdapter(),
            logger: new NullLogger(),
            ttl:    self::DEFAULT_TTL
        );
    }

    /**
     * Ensures that a service registered through the Registry can be discovered
     * immediately and that the result set is cached locally until the TTL
     * expires.
     */
    public function testRegisterAndDiscoverCachesResults(): void
    {
        // Arrange
        $serviceId1 = $this->registry->register(
            serviceName: 'alerting',
            host:        '10.10.0.5',
            port:        9000,
            meta:        ['version' => '1.2.3']
        );

        // Act ‑ first discovery hits the driver
        $result1 = $this->registry->discover('alerting');

        // Assert
        self::assertCount(1, $result1);
        self::assertSame('10.10.0.5', $result1[0]['host']);
        self::assertSame(1, $this->driver->getDiscoverCallCount());

        // Act ‑ second discovery must be served from cache
        $result2 = $this->registry->discover('alerting');

        // Assert
        self::assertSame($result1, $result2, 'Cached result must be identical.');
        self::assertSame(
            1,
            $this->driver->getDiscoverCallCount(),
            'Driver should not be hit when value is cached.'
        );

        // Clean-up
        $this->registry->deregister($serviceId1);
    }

    /**
     * Verifies that deregistering a service invalidates the cached discovery
     * entry, forcing the next discover() call to go to the driver.
     */
    public function testDeregisterInvalidatesCache(): void
    {
        $serviceId = $this->registry->register(
            serviceName: 'metrics',
            host:        '10.10.0.25',
            port:        9100
        );

        $this->registry->discover('metrics');
        self::assertSame(1, $this->driver->getDiscoverCallCount());

        // Act ‑ remove the node
        $this->registry->deregister($serviceId);

        // Calling discover() after deregister should raise an exception because
        // the service no longer exists.
        $this->expectException(ServiceNotFoundException::class);
        $this->registry->discover('metrics');
    }

    /**
     * Shows that the registry throws a ServiceNotFoundException when the driver
     * reports that no instances are available.
     */
    public function testDiscoveringUnknownServiceThrowsException(): void
    {
        $this->expectException(ServiceNotFoundException::class);
        $this->registry->discover('non-existent');
    }

    /**
     * Confirms that when the driver throws any low-level exception, the
     * Registry converts it into a user-facing ServiceNotFoundException so that
     * callers do not have to know about driver specifics.
     */
    public function testDriverErrorIsSurfacedAsServiceNotFoundException(): void
    {
        $this->driver->simulateFailure(true);

        $this->expectException(ServiceNotFoundException::class);
        $this->registry->discover('alerting');
    }
}

/**
 * An instrumented stub that mimics the behaviour of a service discovery driver
 * (e.g. Consul or etcd) entirely in memory. It is intentionally stateful so we
 * can validate caching and invalidation logic inside ServiceRegistry.
 */
final class InstrumentedStubDriver implements ServiceDiscoveryDriverInterface
{
    /** @var array<string, array<int, array{serviceId:string,host:string,port:int,meta:array<string,mixed>}>> */
    private array $services = [];

    /** @var array<string, int> */
    private array $discoverHits = [];

    private bool $shouldFail = false;

    public function simulateFailure(bool $toggle = true): void
    {
        $this->shouldFail = $toggle;
    }

    public function getDiscoverCallCount(string $serviceName = 'metrics'): int
    {
        // Using string key 'metrics' as default keeps BC with previous asserts.
        return $this->discoverHits[$serviceName] ?? 0;
    }

    // ---------------------------------------------------------------------
    //  ServiceDiscoveryDriverInterface implementation
    // ---------------------------------------------------------------------

    public function register(
        string $serviceName,
        string $host,
        int    $port,
        array  $meta = []
    ): string {
        $serviceId                           = sprintf('%s-%s:%d-%d', $serviceName, $host, $port, microtime(true) * 1000);
        $this->services[$serviceName][]      = [
            'serviceId' => $serviceId,
            'host'      => $host,
            'port'      => $port,
            'meta'      => $meta,
        ];

        return $serviceId;
    }

    /**
     * @return list<array{serviceId:string,host:string,port:int,meta:array<string,mixed>}>
     */
    public function discover(string $serviceName): array
    {
        if ($this->shouldFail) {
            throw new \RuntimeException('Simulated driver failure.');
        }

        $this->discoverHits[$serviceName] = ($this->discoverHits[$serviceName] ?? 0) + 1;

        return $this->services[$serviceName] ?? [];
    }

    public function deregister(string $serviceId): void
    {
        foreach ($this->services as $serviceName => $instances) {
            foreach ($instances as $idx => $instance) {
                if ($instance['serviceId'] === $serviceId) {
                    unset($this->services[$serviceName][$idx]);
                    return;
                }
            }
        }

        throw new \RuntimeException(sprintf('Service ID "%s" not found for deregistration.', $serviceId));
    }

    public function refresh(string $serviceId): void
    {
        // For the purposes of these integration tests, a refresh() call merely
        // checks that the service exists.
        foreach ($this->services as $instances) {
            foreach ($instances as $instance) {
                if ($instance['serviceId'] === $serviceId) {
                    return;
                }
            }
        }

        throw new \RuntimeException(sprintf('Service ID "%s" not found during refresh.', $serviceId));
    }
}