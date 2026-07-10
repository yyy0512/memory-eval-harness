```php
<?php

declare(strict_types=1);

/**
 * ProdSecure Orchestrator — Service Configuration
 *
 * This file wires the Dependency Injection container using Symfony’s PHP-DSL.
 * It exposes all core services needed by the DevSecOps command-center:
 *  – Service-mesh discovery
 *  – Event pipeline (Chain of Responsibility)
 *  – Command bus (Command Pattern)
 *  – Token-based auth
 *  – Structured logging
 *
 * @see https://symfony.com/doc/current/service_container.html
 */

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use function Symfony\Component\DependencyInjection\Loader\Configurator\service;

use ProdSecureOrchestrator\Application\Command\Bus\RemediationCommandBus;
use ProdSecureOrchestrator\Application\Command\Handler\RollbackCommandHandler;
use ProdSecureOrchestrator\Application\Discovery\ServiceMeshRegistry;
use ProdSecureOrchestrator\Application\Event\EventPipeline;
use ProdSecureOrchestrator\Application\Event\Handler\AlertEventHandler;
use ProdSecureOrchestrator\Application\Event\Handler\BackupFailureEventHandler;
use ProdSecureOrchestrator\Application\Event\Handler\CpuSpikeEventHandler;
use ProdSecureOrchestrator\Application\Event\Middleware\AuditMiddleware;
use ProdSecureOrchestrator\Application\Event\Middleware\ThrottleMiddleware;
use ProdSecureOrchestrator\Application\Security\TokenAuthenticator;
use ProdSecureOrchestrator\Infrastructure\Http\Middleware\RequestTracingMiddleware;
use ProdSecureOrchestrator\Infrastructure\Logging\MonologChannelFactory;

return function (ContainerConfigurator $configurator): void {
    /**
     * ------------------------------------------------------------------
     *  Shared Defaults
     * ------------------------------------------------------------------
     */
    $services = $configurator->services()
        ->defaults()
            ->autowire()      // Resolves constructor arguments automatically
            ->autoconfigure() // Adds standard Symfony tags (e.g. event subscribers)
            ->bind('$projectRoot', '%kernel.project_dir%');

    /**
     * ------------------------------------------------------------------
     *  PSR-3 Logging Channels
     * ------------------------------------------------------------------
     */
    $services
        ->set('prodsecure.logger.secops', LoggerInterface::class)
            ->factory([MonologChannelFactory::class, 'create'])
            ->arg('$channelName', 'secops')
            ->public(); // allows legacy factories to fetch channel manually

    /**
     * ------------------------------------------------------------------
     *  Service Mesh & Discovery
     * ------------------------------------------------------------------
     */
    $services
        ->set(ServiceMeshRegistry::class)
            ->public() // used directly by CLI tooling / cron-jobs
            ->arg('$cacheTtl', '%env(int:SERVICE_MESH_CACHE_TTL)%')
            ->arg('$logger', service('prodsecure.logger.secops'));

    /**
     * ------------------------------------------------------------------
     *  Authentication / Authorization
     * ------------------------------------------------------------------
     */
    $services
        ->set(TokenAuthenticator::class)
            ->arg('$secret', '%env(string:AUTH_TOKEN_SECRET)%')
            ->arg('$logger', service('prodsecure.logger.secops'))
            ->tag('kernel.event_subscriber'); // hooks into request lifecycle

    /**
     * ------------------------------------------------------------------
     *  Chain-Of-Responsibility Event Pipeline
     * ------------------------------------------------------------------
     */
    $services
        ->set(EventPipeline::class)
            ->arg('$logger', service('prodsecure.logger.secops'))
            ->call('addMiddleware', [service(AuditMiddleware::class)])
            ->call('addMiddleware', [service(ThrottleMiddleware::class)])
            ->call('addHandler', [service(AlertEventHandler::class)])
            ->call('addHandler', [service(BackupFailureEventHandler::class)])
            ->call('addHandler', [service(CpuSpikeEventHandler::class)])
            ->public(); // consumed by WebSocket push-daemon

    /**
     * ------------------------------------------------------------------
     *  HTTP / API Middleware
     * ------------------------------------------------------------------
     */
    $services
        ->set(RequestTracingMiddleware::class)
            ->arg('$logger', service('prodsecure.logger.secops'))
            ->tag('kernel.middleware');

    /**
     * ------------------------------------------------------------------
     *  Command Pattern Bus
     * ------------------------------------------------------------------
     */
    $services
        ->set(RemediationCommandBus::class)
            ->arg('$logger', service('prodsecure.logger.secops'))
            ->call('registerHandler', ['rollback', service(RollbackCommandHandler::class)])
            ->public();

    /**
     * ------------------------------------------------------------------
     *  Pipeline Middleware
     * ------------------------------------------------------------------
     */
    $services
        ->set(ThrottleMiddleware::class)
            ->arg('$maxThroughput', '%env(int:EVENT_PIPELINE_MAX_TPS)%')
            ->arg('$logger', service('prodsecure.logger.secops'));

    $services
        ->set(AuditMiddleware::class)
            ->arg('$auditTrailPath', '%kernel.logs_dir%/audit.log')
            ->arg('$logger', service('prodsecure.logger.secops'));

    /**
     * ------------------------------------------------------------------
     *  Auto-loading for Handlers
     * ------------------------------------------------------------------
     */
    $services
        ->load('ProdSecureOrchestrator\\Application\\Event\\Handler\\', '../../src/Application/Event/Handler/')
            ->tag('prodsecure.event_handler');

    $services
        ->load('ProdSecureOrchestrator\\Application\\Command\\Handler\\', '../../src/Application/Command/Handler/')
            ->tag('prodsecure.command_handler');
};
```