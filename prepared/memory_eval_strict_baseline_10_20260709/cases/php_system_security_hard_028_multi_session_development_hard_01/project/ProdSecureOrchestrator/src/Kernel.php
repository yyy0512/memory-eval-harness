<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator;

use Closure;
use DateTimeZone;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Class Kernel
 *
 * The heart of the ProdSecure Orchestrator bootstrap process.
 * Responsibilities:
 * - Bootstraps the dependency-injection container
 * - Registers service providers & plugins
 * - Exposes application-wide configuration
 * - Handles graceful shutdown & uncaught exceptions
 *
 * NOTE:
 *      Although the Kernel favours PSR-11 & PSR-3 abstractions, it ships with
 *      lightweight fallback implementations to remain completely stand-alone
 *      during early bootstrap. External implementations (e.g. league/container,
 *      monolog/monolog) will automatically override these stubs once their
 *      ServiceProviders are registered.
 *
 * @package ProdSecureOrchestrator
 */
final class Kernel
{
    /** @var string Application semantic version (injected during CI pipeline) */
    public const VERSION = '1.3.0';

    /** @var bool */
    private bool $booted = false;

    /** @var string Absolute project root path */
    private string $rootPath;

    /** @var string The active environment (e.g. prod, staging, dev, test) */
    private string $environment;

    /** @var bool Flag whether application is in debug mode */
    private bool $debug;

    /** @var ContainerInterface */
    private ContainerInterface $container;

    /** @var ServiceProviderInterface[] */
    private array $providers = [];

    /**
     * @param string|null $environment
     * @param bool        $debug
     */
    public function __construct(?string $environment = null, bool $debug = false)
    {
        $this->rootPath    = dirname(__DIR__, 1);
        $this->environment = $environment ?? ($_SERVER['APP_ENV'] ?? 'prod');
        $this->debug       = $debug;

        // Minimal container so we can log early exceptions
        $this->container = new class() implements ContainerInterface {
            private array $entries = [];

            public function get(string $id)
            {
                if (!$this->has($id)) {
                    throw new class(sprintf('Identifier "%s" is not defined.', $id)) extends \RuntimeException implements \Psr\Container\NotFoundExceptionInterface {};
                }

                $entry = $this->entries[$id];

                return ($entry instanceof Closure) ? $entry($this) : $entry;
            }

            public function has(string $id): bool
            {
                return array_key_exists($id, $this->entries);
            }

            public function set(string $id, $concrete): void
            {
                $this->entries[$id] = $concrete;
            }
        };

        // Register a null logger to avoid “logger not found” segfaults during early boot.
        $this->container->set(LoggerInterface::class, new class() implements LoggerInterface {
            public function emergency($message, array $context = []) {}
            public function alert($message, array $context = []) {}
            public function critical($message, array $context = []) {}
            public function error($message, array $context = []) {}
            public function warning($message, array $context = []) {}
            public function notice($message, array $context = []) {}
            public function info($message, array $context = []) {}
            public function debug($message, array $context = []) {}
            public function log($level, $message, array $context = []) {}
        });
    }

    /**
     * Boots the Kernel.
     *
     * Idempotent: subsequent invocations are ignored.
     *
     * @throws Throwable
     */
    public function boot(): void
    {
        if ($this->booted) {
            return;
        }

        // Set sane PHP settings
        date_default_timezone_set(
            getenv('APP_TIMEZONE') ?: (ini_get('date.timezone') ?: (new DateTimeZone('UTC'))->getName())
        );

        // ---------------------------------------------------------
        // 1. Load environment variables (.env) as early as possible
        // ---------------------------------------------------------
        if (class_exists(\Symfony\Component\Dotenv\Dotenv::class)) {
            $dotenv = new \Symfony\Component\Dotenv\Dotenv();
            $envFile = $this->rootPath . '/.env';
            if (is_readable($envFile)) {
                $dotenv->load($envFile);
            }
        }

        // ---------------------------------------------------------
        // 2. Register Core Service Providers
        // ---------------------------------------------------------
        $this->registerServiceProvider(new Provider\ConfigServiceProvider($this->rootPath, $this->environment));
        $this->registerServiceProvider(new Provider\LoggingServiceProvider($this->debug));
        $this->registerServiceProvider(new Provider\EventDispatcherServiceProvider());
        $this->registerServiceProvider(new Provider\CommandBusServiceProvider());
        $this->registerServiceProvider(new Provider\ServiceMeshProvider());

        // Allow user-defined providers to be declared in config/providers.php
        $config = $this->container->get('config');

        foreach ((array) ($config['app']['providers'] ?? []) as $providerClass) {
            if (class_exists($providerClass)) {
                $this->registerServiceProvider(new $providerClass());
            }
        }

        // ---------------------------------------------------------
        // 3. Boot providers (dependency graph already constructed)
        // ---------------------------------------------------------
        foreach ($this->providers as $provider) {
            $provider->boot($this->container);
        }

        // ---------------------------------------------------------
        // 4. Global error handling
        // ---------------------------------------------------------
        $this->registerErrorHandling();

        $this->booted = true;

        $this->container->get(LoggerInterface::class)
            ->info(sprintf('ProdSecure Orchestrator booted. env=%s debug=%s v%s',
                $this->environment,
                $this->debug ? 'true' : 'false',
                self::VERSION
            ));
    }

    /**
     * Registers a service provider & immediately invokes its `register()` method.
     *
     * @param ServiceProviderInterface $provider
     */
    public function registerServiceProvider(ServiceProviderInterface $provider): void
    {
        $provider->register($this->container);
        $this->providers[] = $provider;
    }

    /**
     * Returns the PSR-11 container.
     *
     * @return ContainerInterface
     */
    public function getContainer(): ContainerInterface
    {
        return $this->container;
    }

    /**
     * Discovers mesh-enabled micro-services and binds them to the container.
     *
     * To avoid blocking the bootstrap sequence, discovery runs async if an
     * event loop (e.g. ReactPHP) is available, otherwise it performs a fast,
     * synchronous HTTP query to the ServiceRegistry.
     */
    public function discoverServices(): void
    {
        try {
            /** @var ServiceMesh\DiscoveryInterface $discovery */
            $discovery = $this->container->get(ServiceMesh\DiscoveryInterface::class);
            $services  = $discovery->discover();

            foreach ($services as $service) {
                $this->container->set(
                    sprintf('service.%s', $service->getName()),
                    fn () => $service
                );
            }

            $this->container->get(LoggerInterface::class)
                ->debug(sprintf('Service discovery complete: %d services registered.', count($services)));
        } catch (Throwable $e) {
            $this->container->get(LoggerInterface::class)
                ->error('Service discovery failed: ' . $e->getMessage(), ['exception' => $e]);
        }
    }

    /**
     * Gracefully shuts down the application, ensuring all queued messages /
     * telemetry is flushed before exit.
     */
    public function shutdown(int $exitCode = 0): void
    {
        if (!$this->booted) {
            return;
        }

        foreach (array_reverse($this->providers) as $provider) {
            if (method_exists($provider, 'shutdown')) {
                $provider->shutdown($this->container);
            }
        }

        if ($this->container->has(LoggerInterface::class)) {
            $this->container->get(LoggerInterface::class)->info('ProdSecure Orchestrator shutdown.');
        }

        $this->booted = false;

        exit($exitCode);
    }

    /**
     * Registers global error & exception handlers that map to the logger & the
     * central EventDispatcher so that fatal errors can still be analysed by
     * SecOps teams.
     *
     * If debugging is enabled, a pretty error page is emitted.
     */
    private function registerErrorHandling(): void
    {
        $logger = $this->container->get(LoggerInterface::class);
        $debug  = $this->debug;

        set_error_handler(static function (int $severity, string $message, string $file, int $line) use ($logger, $debug): bool {
            $logger->error($message, compact('severity', 'file', 'line'));

            if ($debug) {
                fprintf(STDERR, "%s in %s:%d\n", $message, $file, $line);
            }

            // Convert to Exception so it can be handled by the exception handler
            throw new \ErrorException($message, 0, $severity, $file, $line);
        });

        set_exception_handler(static function (Throwable $e) use ($logger, $debug): void {
            $logger->critical($e->getMessage(), ['exception' => $e]);

            if ($debug) {
                fprintf(STDERR, "Uncaught exception: %s\nTrace:\n%s\n", $e->getMessage(), $e->getTraceAsString());
            }

            http_response_code(500);

            // Emit a minimal JSON error payload for API clients
            if (PHP_SAPI !== 'cli') {
                header('Content-Type: application/json');
                echo json_encode([
                    'error'   => 'internal_server_error',
                    'message' => $debug ? $e->getMessage() : 'Unexpected error.',
                ]);
            }
        });

        register_shutdown_function(static function () use ($logger, $debug): void {
            if ($error = error_get_last()) {
                $logger->critical('Fatal error', $error);

                if ($debug && PHP_SAPI === 'cli') {
                    fprintf(
                        STDERR,
                        "Fatal error: %s in %s on line %d\n",
                        $error['message'],
                        $error['file'],
                        $error['line']
                    );
                }
            }
        });
    }
}

/**
 * Very small subset of what a real ServiceProvider would look like.  The
 * concrete provider implementations live in the `Provider\` namespace.
 */
interface ServiceProviderInterface
{
    /**
     * Register bindings within the container.
     */
    public function register(ContainerInterface $container): void;

    /**
     * Optional: boot after all providers were registered & container resolved.
     */
    public function boot(ContainerInterface $container): void;
}

