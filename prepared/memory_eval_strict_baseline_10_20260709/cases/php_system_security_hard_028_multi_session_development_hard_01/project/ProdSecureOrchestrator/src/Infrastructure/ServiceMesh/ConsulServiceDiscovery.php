```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Infrastructure\ServiceMesh;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;
use RuntimeException;
use Throwable;

/**
 * Exception wrapper that represents any error returned by Consul or the HTTP client.
 */
class ConsulException extends RuntimeException
{
}

/**
 * Value-object that describes a service instance to (de)register in Consul.
 */
final class ServiceDefinition
{
    public function __construct(
        public readonly string $name,
        public readonly string $id,
        public readonly string $address,
        public readonly int    $port,
        public readonly array  $tags = [],
        public readonly array  $meta = [],
        public readonly ?string $healthCheckHttp = null,
        public readonly ?int    $healthCheckInterval = 10, // seconds
    ) {
    }
}

/**
 * Basic contract every Service-Mesh discovery adapter must fulfil.
 */
interface ServiceDiscoveryInterface
{
    /**
     * Register a service instance in Consul’s agent catalogue.
     *
     * @throws ConsulException When Consul rejects the request.
     */
    public function registerService(ServiceDefinition $service): void;

    /**
     * Deregister a service instance from Consul.
     *
     * @throws ConsulException When Consul rejects the request.
     */
    public function deregisterService(string $serviceId): void;

    /**
     * Returns a list of healthy instances for the given service name.
     *
     * @param string[] $tags Optional tag filters.
     *
     * @return array<int, array<string, mixed>> Raw Consul response decoded as an array.
     *
     * @throws ConsulException When Consul rejects the request or the response is malformed.
     */
    public function getHealthyInstances(string $serviceName, array $tags = []): array;

    /**
     * Performs a blocking watch on the service. The supplied callback is triggered
     * every time Consul’s index changes (i.e. something about the service changed).
     *
     * NOTE: This method is synchronous/blocking and runs an infinite loop.
     *
     * @param callable         $onChange    Receives the raw array returned by Consul.
     * @param list<string>     $tags        Optional tag filters.
     * @param int<1, 900>      $waitSeconds How long Consul should hold the request open.
     *
     * @throws ConsulException On unexpected HTTP errors.
     */
    public function watchService(
        string $serviceName,
        callable $onChange,
        array $tags = [],
        int $waitSeconds = 300
    ): void;
}

/**
 * Production-grade Consul implementation of the ServiceDiscoveryInterface.
 *
 * This adapter is intentionally thin and stateless. All heavy-lifting (caching,
 * retries, circuit-breaking) should be delegated to higher-level decorators.
 */
class ConsulServiceDiscovery implements ServiceDiscoveryInterface
{
    private const DEFAULT_WAIT_TIME = 300; // seconds
    private const MIN_WAIT_TIME     = 1;

    private readonly string $agentBaseUrl;
    private readonly string $healthBaseUrl;

    public function __construct(
        private readonly ClientInterface $httpClient,
        private readonly LoggerInterface $logger,
        string $consulAddress = 'http://127.0.0.1:8500',
        private readonly string $apiVersion = 'v1',
        private readonly ?string $aclToken = null,
    ) {
        $consulAddress     = rtrim($consulAddress, '/');
        $this->agentBaseUrl  = sprintf('%s/%s/agent/service',  $consulAddress, $this->apiVersion);
        $this->healthBaseUrl = sprintf('%s/%s/health/service', $consulAddress, $this->apiVersion);
    }

    /*──────────────────────────── ServiceRegistration ───────────────────────────*/

    public function registerService(ServiceDefinition $service): void
    {
        $payload = [
            'Name'    => $service->name,
            'ID'      => $service->id,
            'Address' => $service->address,
            'Port'    => $service->port,
            'Tags'    => $service->tags,
            'Meta'    => $service->meta,
        ];

        if ($service->healthCheckHttp !== null) {
            $payload['Check'] = [
                'HTTP'     => $service->healthCheckHttp,
                'Interval' => "{$service->healthCheckInterval}s",
            ];
        }

        $this->logger->debug('Registering service in Consul', ['payload' => $payload]);

        $this->safeRequest('PUT', "{$this->agentBaseUrl}/register", [
            'json' => $payload,
        ]);
    }

    public function deregisterService(string $serviceId): void
    {
        $this->logger->debug('Deregistering service from Consul', ['serviceId' => $serviceId]);

        $this->safeRequest('PUT', "{$this->agentBaseUrl}/deregister/{$serviceId}");
    }

    /*──────────────────────────── HealthDiscovery ───────────────────────────────*/

    public function getHealthyInstances(string $serviceName, array $tags = []): array
    {
        $query = [
            'passing' => 'true',
        ];

        if ($tags !== []) {
            $query['filter'] = $this->buildTagFilter($tags);
        }

        $response = $this->safeRequest('GET', "{$this->healthBaseUrl}/{$serviceName}", [
            'query' => $query,
        ]);

        /** @var array<int, array<string, mixed>> $decoded */
        $decoded = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);

        return $decoded;
    }

    public function watchService(
        string $serviceName,
        callable $onChange,
        array $tags = [],
        int $waitSeconds = self::DEFAULT_WAIT_TIME,
    ): void {
        $waitSeconds = max(self::MIN_WAIT_TIME, min($waitSeconds, 900));

        $index = '0';

        // Endless loop – caller is responsible for executing within a worker that can be killed.
        while (true) {
            $query = [
                'passing' => 'true',
                'index'   => $index,
                'wait'    => "{$waitSeconds}s",
            ];

            if ($tags !== []) {
                $query['filter'] = $this->buildTagFilter($tags);
            }

            $this->logger->debug('Starting Consul blocking query', [
                'service'     => $serviceName,
                'query'       => $query,
            ]);

            try {
                $response = $this->safeRequest('GET', "{$this->healthBaseUrl}/{$serviceName}", [
                    'query' => $query,
                    // Bump timeout slightly above waitSeconds to prevent premature abort.
                    'timeout' => $waitSeconds + 5,
                ]);
            } catch (ConsulException $e) {
                // Most network glitches should not crash the watcher.
                $this->logger->warning(
                    'Consul watch aborted – backing off and retrying',
                    ['exception' => $e]
                );
                sleep(1);
                continue;
            }

            $newIndex = $response->getHeaderLine('X-Consul-Index');

            if ($newIndex !== '' && $newIndex !== $index) {
                $index = $newIndex;

                /** @var array<int, array<string, mixed>> $decoded */
                $decoded = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);

                $this->logger->debug('Detected change in Consul service catalogue', [
                    'service' => $serviceName,
                    'index'   => $index,
                    'count'   => count($decoded),
                ]);

                // Fire user-supplied callback – swallow exceptions to keep the watcher alive.
                try {
                    $onChange($decoded);
                } catch (Throwable $callbackError) {
                    $this->logger->error(
                        'Exception thrown by Consul watch callback',
                        ['exception' => $callbackError]
                    );
                }
            }
        }
    }

    /*──────────────────────────── Internals ─────────────────────────────────────*/

    /**
     * Wrapper that executes an HTTP request and normalises errors into ConsulException.
     *
     * @param array<string,mixed> $options Guzzle request options.
     *
     * @throws ConsulException
     */
    private function safeRequest(string $method, string $uri, array $options = []): ResponseInterface
    {
        // Inject ACL token header if necessary.
        $options['headers']['Content-Type'] = 'application/json';
        if ($this->aclToken !== null) {
            $options['headers']['X-Consul-Token'] = $this->aclToken;
        }

        try {
            /** @var Response $response */
            $response = $this->httpClient->request($method, $uri, $options);
        } catch (GuzzleException $e) {
            $this->logger->error('HTTP request to Consul failed', [
                'method'  => $method,
                'uri'     => $uri,
                'options' => $options,
                'error'   => $e->getMessage(),
            ]);

            throw new ConsulException(
                sprintf('Error while contacting Consul: %s', $e->getMessage()),
                (int) $e->getCode(),
                $e
            );
        }

        $status = $response->getStatusCode();
        if ($status >= 400) {
            $body = (string) $response->getBody();

            $this->logger->error('Consul returned an error response', [
                'status' => $status,
                'body'   => $body,
            ]);

            throw new ConsulException(
                sprintf('Consul responded with HTTP %d: %s', $status, $body),
                $status
            );
        }

        return $response;
    }

    /**
     * Builds a Consul filter expression from a list of tags.
     */
    private function buildTagFilter(array $tags): string
    {
        $escaped = array_map(
            static fn (string $tag): string => sprintf('Service.Tags contains "%s"', addslashes($tag)),
            $tags
        );

        return implode(' and ', $escaped);
    }
}
```