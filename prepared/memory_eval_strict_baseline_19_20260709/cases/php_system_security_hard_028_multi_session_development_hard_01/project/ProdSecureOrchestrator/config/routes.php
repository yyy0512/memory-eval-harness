```php
<?php
/**
 * ProdSecure Orchestrator — Route Definitions
 *
 * This configuration file maps HTTP endpoints to controller
 * actions. Every controller referenced here is resolved through the
 * IoC container and must implement
 * SystemSecurity\Core\Contracts\ControllerInterface.
 *
 * Global conventions:
 *  - All /api routes are versioned.
 *  - Authenticated routes enforce JWT / mTLS auth and are rate-limited.
 *  - All state-changing operations are protected with CSRF and audited.
 */

declare(strict_types=1);

use SystemSecurity\Core\Routing\Router;
use SystemSecurity\Core\Routing\RouteGroup;
use SystemSecurity\Core\Http\Middleware\{
    AuthMiddleware,
    CsrfMiddleware,
    RateLimitMiddleware,
    JsonBodyParserMiddleware,
    AuditLogMiddleware
};

return static function (Router $router): void {

    // ---------------------------------------------------------------------
    // Public Routes
    // ---------------------------------------------------------------------

    // Simple health probe consumed by Kubernetes liveness/readiness checks.
    $router->add('GET', '/healthz', 'SystemSecurity\\App\\Controllers\\SystemHealthController@ping');

    // Limited application metadata.
    $router->add('GET', '/about', 'SystemSecurity\\App\\Controllers\\SystemHealthController@about');


    // ---------------------------------------------------------------------
    // Webhook Routes
    // ---------------------------------------------------------------------
    // Accepts external callbacks (GitHub, Slack, PagerDuty). Requires a
    // pre-shared CSRF token to prevent replay attacks.
    $router->group('/webhook/{token:[A-Fa-f0-9]{40}}', function (RouteGroup $group): void {
        $group->middleware([
            CsrfMiddleware::class,
            AuditLogMiddleware::class,
        ]);

        $group->add('POST', '', 'SystemSecurity\\App\\Controllers\\WebhookController@handle');
    });


    // ---------------------------------------------------------------------
    // Protected API v1 Routes
    // ---------------------------------------------------------------------
    $router->group('/api/v1', function (RouteGroup $group): void {

        // Apply global middlewares to every route in this group.
        $group->middleware([
            AuthMiddleware::class,          // JWT / mTLS required
            RateLimitMiddleware::class,     // Adaptive throttling
            JsonBodyParserMiddleware::class,
            AuditLogMiddleware::class,      // Creates immutable audit trail
        ]);

        // ------------------------------- ALERTING -------------------------
        $group->add('GET',    '/alerts',             'SystemSecurity\\App\\Controllers\\AlertController@index');
        $group->add('POST',   '/alerts',             'SystemSecurity\\App\\Controllers\\AlertController@store');
        $group->add('GET',    '/alerts/{id:[0-9]+}', 'SystemSecurity\\App\\Controllers\\AlertController@show');
        $group->add('PUT',    '/alerts/{id:[0-9]+}', 'SystemSecurity\\App\\Controllers\\AlertController@update');
        $group->add('DELETE', '/alerts/{id:[0-9]+}', 'SystemSecurity\\App\\Controllers\\AlertController@destroy');
        // Bulk actions (acknowledge, escalate, suppress, etc.)
        $group->add('POST',   '/alerts/actions/bulk', 'SystemSecurity\\App\\Controllers\\AlertController@bulkAction');

        // ----------------------- PERFORMANCE METRICS ----------------------
        $group->add('GET', '/metrics',                                     'SystemSecurity\\App\\Controllers\\MetricController@index');
        $group->add('GET', '/metrics/{nodeId:[A-Za-z0-9\\-]+}',            'SystemSecurity\\App\\Controllers\\MetricController@show');
        $group->add('GET', '/metrics/{nodeId:[A-Za-z0-9\\-]+}/stream',     'SystemSecurity\\App\\Controllers\\MetricController@streamSse');

        // --------------------- BACKUP & RECOVERY --------------------------
        $group->add('GET',    '/backups',                                           'SystemSecurity\\App\\Controllers\\BackupController@index');
        $group->add('POST',   '/backups',                                           'SystemSecurity\\App\\Controllers\\BackupController@create');
        $group->add('GET',    '/backups/{backupId:[A-Fa-f0-9\\-]{36}}',             'SystemSecurity\\App\\Controllers\\BackupController@show');
        $group->add('POST',   '/backups/{backupId:[A-Fa-f0-9\\-]{36}}/restore',     'SystemSecurity\\App\\Controllers\\BackupController@restore');
        $group->add('DELETE', '/backups/{backupId:[A-Fa-f0-9\\-]{36}}',             'SystemSecurity\\App\\Controllers\\BackupController@destroy');

        // ------------------ DEPLOYMENT AUTOMATION -------------------------
        $group->add('GET',  '/deployments',                                                'SystemSecurity\\App\\Controllers\\DeploymentController@index');
        $group->add('POST', '/deployments',                                                'SystemSecurity\\App\\Controllers\\DeploymentController@trigger');
        $group->add('GET',  '/deployments/{deploymentId:[A-Fa-f0-9\\-]{36}}',              'SystemSecurity\\App\\Controllers\\DeploymentController@show');
        $group->add('GET',  '/deployments/{deploymentId:[A-Fa-f0-9\\-]{36}}/logs',         'SystemSecurity\\App\\Controllers\\DeploymentController@logs');
        $group->add('POST', '/deployments/{deploymentId:[A-Fa-f0-9\\-]{36}}/promote',      'SystemSecurity\\App\\Controllers\\DeploymentController@promote');
        $group->add('POST', '/deployments/{deploymentId:[A-Fa-f0-9\\-]{36}}/rollback',     'SystemSecurity\\App\\Controllers\\DeploymentController@rollback');

        // ------------------------ LOAD BALANCING -------------------------
        $group->add('GET',     '/load-balancers',                                   'SystemSecurity\\App\\Controllers\\LoadBalancerController@index');
        $group->add('POST',    '/load-balancers',                                   'SystemSecurity\\App\\Controllers\\LoadBalancerController@create');
        $group->add('GET',     '/load-balancers/{lbId:[A-Fa-f0-9\\-]{36}}',         'SystemSecurity\\App\\Controllers\\LoadBalancerController@show');
        $group->add('PUT',     '/load-balancers/{lbId:[A-Fa-f0-9\\-]{36}}',         'SystemSecurity\\App\\Controllers\\LoadBalancerController@update');
        $group->add('DELETE',  '/load-balancers/{lbId:[A-Fa-f0-9\\-]{36}}',         'SystemSecurity\\App\\Controllers\\LoadBalancerController@destroy');

        // ---------------------- SYSTEM MONITORING -------------------------
        $group->add('GET', '/systems',                                          'SystemSecurity\\App\\Controllers\\SystemController@index');
        $group->add('GET', '/systems/{systemId:[A-Fa-f0-9\\-]{36}}',            'SystemSecurity\\App\\Controllers\\SystemController@show');
        $group->add('GET', '/systems/{systemId:[A-Fa-f0-9\\-]{36}}/topology',   'SystemSecurity\\App\\Controllers\\SystemController@topology');

        // ----------------------- LOG AGGREGATION --------------------------
        $group->add('GET', '/logs',                        'SystemSecurity\\App\\Controllers\\LogController@index');
        $group->add('GET', '/logs/search',                 'SystemSecurity\\App\\Controllers\\LogController@search');
        $group->add('GET', '/logs/{streamId:[0-9]+}/tail', 'SystemSecurity\\App\\Controllers\\LogController@tail');
    });


    // ---------------------------------------------------------------------
    // Fallback — 404 Not Found
    // ---------------------------------------------------------------------
    // Must be the last route to avoid shadowing previous definitions.
    $router->addFallback('SystemSecurity\\App\\Controllers\\ErrorController@notFound');
};
```