```php
<?php
/**
 * ProdSecure Orchestrator – Event Pipeline Configuration
 *
 * This configuration file describes how runtime events are processed by the
 * Chain-of-Responsibility orchestrator. The PipelineFactory consumes this file,
 * builds an optimized handler graph, and injects it into the Service Mesh so
 * that any micro-service can dispatch events without tight coupling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT:
 * 1. DO NOT store secrets here. Read them from the environment or a vault.
 * 2. Any change requires either: `php artisan cache:clear` or a worker reboot.
 * 3. Keep the “fallback” pipeline lightweight—every unmapped event goes there.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @package   ProdSecureOrchestrator
 * @author    Security Engineering
 * @copyright Copyright (c) ProdSecure
 * @license   MIT
 */

declare(strict_types=1);

use ProdSecure\Component\Event\Enum\Decision;
use ProdSecure\Component\Strategy\{
    AuditTrailStrategy,
    AutoRemediationStrategy,
    NotificationStrategy,
    RateLimitStrategy,
    SeverityEnrichmentStrategy,
    SlaBreachStrategy
};

return [

    /*
    |--------------------------------------------------------------------------
    | Global Pipeline Options
    |--------------------------------------------------------------------------
    */
    'options' => [

        // Hard limit on how many Strategy instances a single event may traverse
        // to safeguard against recursion & mis-configuration.
        'max_depth'              => (int) getenv('PSO_PIPELINE_MAX_DEPTH')        ?: 32,

        // Should the compiled pipeline be cached to disk? Recommended for prod.
        'enable_caching'         => (bool) getenv('PSO_PIPELINE_CACHE')           ?: true,

        // Universal rate-limit applied BEFORE channel evaluation (0 = unlimited)
        'global_rate_limit_rpm'  => (int) getenv('PSO_PIPELINE_GLOBAL_RPM')       ?: 0,
    ],

    /*
    |--------------------------------------------------------------------------
    | Channel-specific Pipelines
    |--------------------------------------------------------------------------
    | The array keys map to “channels”—logical groupings of event classes.
    | Each channel holds an ordered list of Strategy definitions:
    |
    |   [
    |       'class'   => Strategy FQCN,
    |       'method'  => 'handle',     // optional, defaults to __invoke
    |       'enabled' => true,         // boolean
    |       'options' => [],           // passed to Strategy constructor
    |       'on'      => [],           // Decisions required to reach this stage
    |   ]
    |
    */
    'channels' => [

        /*
        |------------------------------------------------------------------------
        | Security Alerts
        |------------------------------------------------------------------------
        */
        'security_alert' => [

            [
                'class'   => SeverityEnrichmentStrategy::class,
                'method'  => '__invoke',
                'enabled' => true,
                'options' => [
                    // External CVSS feed for contextual severity mapping
                    'cvss_feed_url' => getenv('PSO_CVSS_FEED')
                        ?: 'https://nvd.nist.gov/feeds/json/cve/1.1/',
                ],
                'on'      => [], // always run
            ],

            [
                'class'   => RateLimitStrategy::class,
                'enabled' => true,
                'options' => [
                    // Tenant-scoped RPM limit for alert floods
                    'rpm' => (int) getenv('PSO_ALERT_RPM') ?: 250,
                ],
                'on' => [],
            ],

            [
                'class'   => SlaBreachStrategy::class,
                'enabled' => true,
                'options' => [
                    'sla_map' => [
                        // seconds to escalate by severity
                        'critical' => 120,
                        'high'     => 600,
                    ],
                ],
                'on' => [],
            ],

            [
                'class'   => AutoRemediationStrategy::class,
                'enabled' => (bool) getenv('PSO_AUTO_REMEDIATE_ALERTS') ?: false,
                'options' => [
                    'playbooks_path' => dirname(__DIR__) . '/playbooks/security',
                ],
                // Only trigger when previous stage said “CONTINUE”
                'on' => [Decision::CONTINUE],
            ],

            [
                'class'   => AuditTrailStrategy::class,
                'enabled' => true,
                'options' => [
                    'storage' => 'database',
                    'table'   => 'security_event_audit',
                ],
                'on' => [Decision::CONTINUE, Decision::STOP],
            ],

            [
                'class'   => NotificationStrategy::class,
                'enabled' => true,
                'options' => [
                    'channels' => ['slack', 'email', 'pagerduty'],
                    'template' => 'alerts/security_default.twig',
                ],
                'on' => [Decision::ESCALATE],
            ],
        ],

        /*
        |------------------------------------------------------------------------
        | Backup & Recovery Jobs
        |------------------------------------------------------------------------
        */
        'backup_job' => [

            [
                'class'   => RateLimitStrategy::class,
                'enabled' => true,
                'options' => ['rpm' => 60],
                'on'      => [],
            ],

            [
                'class'   => AutoRemediationStrategy::class,
                'enabled' => true,
                'options' => [
                    'playbooks_path' => dirname(__DIR__) . '/playbooks/backup',
                ],
                // Only run when a backup explicitly FAILED
                'on' => [Decision::FAILURE],
            ],

            [
                'class'   => AuditTrailStrategy::class,
                'enabled' => true,
                'options' => [
                    'storage' => 'file',
                    'path'    => '/var/log/prodsecure/backup_audit.log',
                ],
                'on' => [],
            ],
        ],

        /*
        |------------------------------------------------------------------------
        | Performance Metrics
        |------------------------------------------------------------------------
        */
        'performance_metric' => [

            [
                'class'   => RateLimitStrategy::class,
                'enabled' => true,
                'options' => ['rpm' => 1200],
                'on'      => [],
            ],

            [
                'class'   => SlaBreachStrategy::class,
                'enabled' => true,
                'options' => [
                    // Metric-specific SLA thresholds (seconds)
                    'sla_map' => [
                        'latency_avg' => 300,
                    ],
                ],
                'on' => [],
            ],

            [
                'class'   => NotificationStrategy::class,
                'enabled' => true,
                'options' => [
                    'channels' => ['slack'],
                    'template' => 'metrics/perf_sla_breach.twig',
                ],
                'on' => [Decision::ESCALATE],
            ],
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Fallback Pipeline
    |--------------------------------------------------------------------------
    | Executed for any event not recognised by a dedicated channel.
    */
    'fallback' => [

        [
            'class'   => RateLimitStrategy::class,
            'enabled' => true,
            'options' => ['rpm' => 5000],
            'on'      => [],
        ],

        [
            'class'   => AuditTrailStrategy::class,
            'enabled' => true,
            'options' => [
                'storage' => 'database',
                'table'   => 'generic_event_audit',
            ],
            'on' => [],
        ],
    ],
];
```