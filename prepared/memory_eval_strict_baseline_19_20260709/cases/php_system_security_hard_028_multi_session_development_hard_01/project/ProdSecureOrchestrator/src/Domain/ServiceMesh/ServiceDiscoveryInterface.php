```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\ServiceMesh;

use ProdSecureOrchestrator\Domain\ServiceMesh\DTO\DiscoveryFilter;
use ProdSecureOrchestrator\Domain\ServiceMesh\DTO\ServiceDescriptor;
use ProdSecureOrchestrator\Domain\ServiceMesh\DTO\ServiceInstance;
use ProdSecureOrchestrator\Domain\ServiceMesh\Exception\ServiceDiscoveryException;
use ProdSecureOrchestrator\Domain\ServiceMesh\Watch\WatchHandleInterface;
use Psr\Http\Message\UriInterface;

/**
 * ServiceDiscoveryInterface
 *
 * Contract for the Service-Mesh discovery component used by ProdSecure Orchestrator.
 *
 * Implementations MAY back onto systems such as Consul, Etcd, Eureka, or custom
 * registries.  All interactions with the discovery backend MUST be abstracted
 * through this interface so the domain layer stays infrastructure-agnostic.
 *
 * Design requirements:
 *  • Idempotent: duplicate calls MUST NOT corrupt state
 *  • Resilient: network partitioning SHOULD be handled gracefully
 *  • Observable: SHOULD emit metrics/traces for each operation
 *  • Concurrency-safe: usable from fibers/threads without race-conditions
 */
interface ServiceDiscoveryInterface
{
    /**
     * Registers (or heart-beats) a service instance.
     *
     * @param ServiceDescriptor $descriptor  Contains metadata such as name, version,
     *                                       host, port, tags and health endpoint.
     *
     * @throws ServiceDiscoveryException      If the backend rejects the request
     *                                       or consensus cannot be reached.
     */
    public function register(ServiceDescriptor $descriptor): void;

    /**
     * Removes an existing service instance from the registry.
     *
     * @param string $serviceId               The unique identifier returned by
     *                                       register().
     *
     * @throws ServiceDiscoveryException      If the service cannot be removed
     *                                       or is unknown to the backend.
     */
    public function deregister(string $serviceId): void;

    /**
     * Returns (possibly filtered) service instances.
     *
     * @param string               $serviceName The logical name (e.g. "backup-api").
     * @param DiscoveryFilter|null $filter      Optional filter to narrow results.
     *
     * @return ServiceInstance[]                List of discovered instances
     *
     * @throws ServiceDiscoveryException        On backend communication failure
     *                                         or other unrecoverable errors.
     */
    public function discover(string $serviceName, ?DiscoveryFilter $filter = null): array;

    /**
     * Subscribes to changes in the service topology.
     *
     * @param string               $serviceName The logical service name.
     * @param callable             $onChange    Callback that receives an
     *                                          up-to-date array of ServiceInstance
     *                                          and MUST return void.
     * @param DiscoveryFilter|null $filter      Optional filter (same semantics
     *                                          as discover()).
     *
     * @return WatchHandleInterface             A handle to cancel the watch.
     *
     * @throws ServiceDiscoveryException        If the subscription cannot be
     *                                          established.
     */
    public function watch(
        string $serviceName,
        callable $onChange,
        ?DiscoveryFilter $filter = null
    ): WatchHandleInterface;

    /**
     * Returns only *healthy* instances of the service.
     *
     * @param string               $serviceName
     * @param DiscoveryFilter|null $filter
     *
     * @return ServiceInstance[]
     *
     * @throws ServiceDiscoveryException
     */
    public function getHealthyInstances(string $serviceName, ?DiscoveryFilter $filter = null): array;

    /**
     * Resolves a service into a concrete, connectable URI.
     * Implementations MAY perform client-side load balancing and return
     * different URIs for subsequent invocations.
     *
     * @param string               $serviceName
     * @param DiscoveryFilter|null $filter
     *
     * @return UriInterface
     *
     * @throws ServiceDiscoveryException       If no suitable instance is found.
     */
    public function resolveUri(string $serviceName, ?DiscoveryFilter $filter = null): UriInterface;
}
```