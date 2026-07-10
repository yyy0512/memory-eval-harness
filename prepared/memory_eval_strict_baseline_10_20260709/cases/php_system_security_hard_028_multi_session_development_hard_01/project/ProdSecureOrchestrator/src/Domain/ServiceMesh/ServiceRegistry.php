```php
<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Domain\ServiceMesh;

use DateInterval;
use DateTimeImmutable;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Symfony\Contracts\EventDispatcher\EventDispatcherInterface;

/**
 * ServiceRegistry
 *
 * Centralised in-memory registry that keeps track of all Service Mesh
 * resources running in the ProdSecure Orchestrator ecosystem.
 *
 * Responsibilities
 *  - Service discovery (CRUD style)
 *  - Health-check TTL verification
 *  - Basic round-robin load-balancing via nextHop()
 *  - Event dispatching to keep ViewModels synchronised in real-time
 *
 * This class is intentionally stateless *towards* the outside world yet
 * internally stateful. Persistency or multi-node replication is expected
 * to be handled by an upper infrastructure layer (e.g., Redis, Consul).
 */
final class ServiceRegistry
{
    /**
     * @var array<string,ServiceDescriptor> Map<serviceId, ServiceDescriptor>
     */
    private array $services = [];

    /**
     * @var array<string,int> Map<serviceType, roundRobinPointer>
     */
    private array $roundRobinPointers = [];

    private EventDispatcherInterface $dispatcher;
    private LoggerInterface $logger;
    private int $defaultTtlSeconds;

    public function __construct(
        EventDispatcherInterface $dispatcher,
        LoggerInterface $logger,
        int $defaultTtlSeconds = 30
    ) {
        $this->dispatcher        = $dispatcher;
        $this->logger            = $logger;
        $this->defaultTtlSeconds = $defaultTtlSeconds;
    }

    /**
     * Register a new service in the mesh.
     *
     * @throws ServiceAlreadyRegisteredException
     */
    public function register(ServiceDescriptor $descriptor): void
    {
        if (isset($this->services[$descriptor->getId()])) {
            throw new ServiceAlreadyRegisteredException(
                sprintf('Service "%s" already registered.', $descriptor->getId())
            );
        }

        $this->services[$descriptor->getId()] = $descriptor;
        $this->logger->info(
            'Service registered',
            ['serviceId' => $descriptor->getId(), 'type' => $descriptor->getType()]
        );

        $this->dispatcher->dispatch(
            new ServiceRegisteredEvent($descriptor),
            ServiceRegisteredEvent::NAME
        );
    }

    /**
     * Deregister an existing service.
     *
     * @throws ServiceNotFoundException
     */
    public function deregister(string $serviceId): void
    {
        $descriptor = $this->get($serviceId); // throws when not found
        unset($this->services[$serviceId]);

        $this->logger->info('Service deregistered', ['serviceId' => $serviceId]);

        $this->dispatcher->dispatch(
            new ServiceDeregisteredEvent($descriptor),
            ServiceDeregisteredEvent::NAME
        );
    }

    /**
     * Update a service heartbeat to avoid it being considered stale.
     *
     * @throws ServiceNotFoundException
     */
    public function heartbeat(string $serviceId, ?DateTimeImmutable $at = null): void
    {
        $descriptor = $this->get($serviceId);
        $this->services[$serviceId] = $descriptor->withHeartbeat($at ?? new DateTimeImmutable());

        $this->logger->debug('Heartbeat accepted', ['serviceId' => $serviceId]);
    }

    /**
     * Retrieve a service descriptor.
     *
     * @throws ServiceNotFoundException
     */
    public function get(string $serviceId): ServiceDescriptor
    {
        if (!isset($this->services[$serviceId])) {
            throw new ServiceNotFoundException(sprintf('Service "%s" not found.', $serviceId));
        }

        return $this->services[$serviceId];
    }

    /**
     * List all healthy services, optionally filtered by type or metadata tags.
     *
     * @param string|null $type  Filter by concrete service type.
     * @param array<string,string>|null $tags  Metadata tag filters (AND-joined).
     *
     * @return ServiceDescriptor[]
     */
    public function list(?string $type = null, ?array $tags = null): array
    {
        return array_values(
            array_filter(
                $this->services,
                function (ServiceDescriptor $descriptor) use ($type, $tags): bool {
                    if (!$descriptor->isHealthy($this->defaultTtlSeconds)) {
                        return false;
                    }
                    if ($type !== null && $descriptor->getType() !== $type) {
                        return false;
                    }

                    if ($tags !== null) {
                        foreach ($tags as $k => $v) {
                            if ($descriptor->getMetadata()[$k] ?? null !== $v) {
                                return false;
                            }
                        }
                    }

                    return true;
                }
            )
        );
    }

    /**
     * Select the next available hop for a given service type using a simple
     * round-robin algorithm.
     *
     * @param string $type Service type name (e.g., "alerting", "metrics")
     *
     * @throws ServiceUnhealthyException When no healthy instance exists.
     */
    public function nextHop(string $type): ServiceDescriptor
    {
        $healthy = $this->list($type);

        if ($healthy === []) {
            throw new ServiceUnhealthyException(
                sprintf('No healthy service of type "%s" available.', $type)
            );
        }

        // Initialise pointer if absent
        if (!isset($this->roundRobinPointers[$type])) {
            $this->roundRobinPointers[$type] = 0;
        }

        $ptr = $this->roundRobinPointers[$type] % count($healthy);
        $this->roundRobinPointers[$type]++;

        return $healthy[$ptr];
    }

    /**
     * Internal sweeper to remove unhealthy services.
     * Intended to be run from a cron/scheduler every few seconds.
     */
    public function pruneStale(): int
    {
        $now       = new DateTimeImmutable();
        $threshold = $now->sub(new DateInterval(sprintf('PT%dS', $this->defaultTtlSeconds)));

        $removed = 0;
        foreach ($this->services as $id => $descriptor) {
            if ($descriptor->getLastHeartbeat() < $threshold) {
                $this->deregister($id);
                $removed++;
            }
        }

        return $removed;
    }
}

/**
 * Value-object representing a service instance.
 *
 * Immutable by design—any state change returns a new instance.
 */
final class ServiceDescriptor
{
    private string $id;
    private string $type;
    private string $uri;

    /** @var array<string,string> */
    private array $metadata;

    private DateTimeImmutable $lastHeartbeat;

    /**
     * @param array<string,string> $metadata
     */
    public function __construct(
        string $id,
        string $type,
        string $uri,
        array $metadata = [],
        ?DateTimeImmutable $lastHeartbeat = null
    ) {
        $this->id            = $id;
        $this->type          = $type;
        $this->uri           = $uri;
        $this->metadata      = $metadata;
        $this->lastHeartbeat = $lastHeartbeat ?? new DateTimeImmutable();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function getType(): string
    {
        return $this->type;
    }

    public function getUri(): string
    {
        return $this->uri;
    }

    /**
     * @return array<string,string>
     */
    public function getMetadata(): array
    {
        return $this->metadata;
    }

    public function getLastHeartbeat(): DateTimeImmutable
    {
        return $this->lastHeartbeat;
    }

    /**
     * Verify whether the service is considered healthy relative to a TTL.
     */
    public function isHealthy(int $ttlSeconds): bool
    {
        $threshold = (new DateTimeImmutable())
            ->sub(new DateInterval(sprintf('PT%dS', $ttlSeconds)));

        return $this->lastHeartbeat >= $threshold;
    }

    /**
     * Return a copy with an updated heartbeat.
     */
    public function withHeartbeat(DateTimeImmutable $when): self
    {
        return new self(
            $this->id,
            $this->type,
            $this->uri,
            $this->metadata,
            $when
        );
    }
}

/* ===========================================================
 * Domain Events – Observer Pattern
 * ===========================================================
 */

abstract class AbstractServiceRegistryEvent
{
    protected ServiceDescriptor $descriptor;

    public function __construct(ServiceDescriptor $descriptor)
    {
        $this->descriptor = $descriptor;
    }

    public function getDescriptor(): ServiceDescriptor
    {
        return $this->descriptor;
    }
}

final class ServiceRegisteredEvent extends AbstractServiceRegistryEvent
{
    public const NAME = 'service.registered';
}

final class ServiceDeregisteredEvent extends AbstractServiceRegistryEvent
{
    public const NAME = 'service.deregistered';
}

/* ===========================================================
 * Exceptions
 * ===========================================================
 */

class ServiceRegistryException extends RuntimeException
{
}

class ServiceAlreadyRegisteredException extends ServiceRegistryException
{
}

class ServiceNotFoundException extends ServiceRegistryException
{
}

class ServiceUnhealthyException extends ServiceRegistryException
{
}
```