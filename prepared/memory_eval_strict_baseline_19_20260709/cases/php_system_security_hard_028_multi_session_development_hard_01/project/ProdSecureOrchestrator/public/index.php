```php
<?php

declare(strict_types=1);

/**
 * ProdSecure Orchestrator – HTTP Front-Controller
 *
 * This file is the single gateway for every HTTP request that enters the
 * ProdSecure Orchestrator platform.  It is responsible for:
 *
 *   1) Bootstrapping the runtime (autoload, env, error handling, DI container)
 *   2) Delegating the current request to the application kernel
 *   3) Emitting a PSR-7–compatible response back to the client
 *
 * Adheres to PSR-1/12 (coding-style), PSR-4 (autoloading), PSR-7 (HTTP
 * messages), PSR-11 (container), and PSR-15 (HTTP handlers) conventions.
 *
 * @copyright  © ProdSecure
 * @license    Proprietary
 * @author     
 */

use Dotenv\Dotenv;
use Monolog\Logger;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use ProdSecureOrchestrator\Core\Bootstrap\ApplicationKernel;
use ProdSecureOrchestrator\Core\Bootstrap\Exception\Http\HttpExceptionInterface;
use ProdSecureOrchestrator\Core\Bootstrap\Exception\Http\NotFoundHttpException;
use ProdSecureOrchestrator\Core\Http\ResponseEmitter;
use ProdSecureOrchestrator\Core\Logging\LoggerFactory;
use ProdSecureOrchestrator\Core\Runtime\WhoopsExceptionHandler;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;

const PSO_START_TS = microtime(true);

// -----------------------------------------------------------------------------
//  1.  Composer autoloader
// -----------------------------------------------------------------------------
$autoloadFile = dirname(__DIR__) . '/vendor/autoload.php';

if (!is_readable($autoloadFile)) {
    http_response_code(500);
    echo 'Autoloader not found.  Execute "composer install" before running '
       . 'the ProdSecure Orchestrator.';
    exit(1);
}

require $autoloadFile;

// -----------------------------------------------------------------------------
//  2.  Environment (.env) & configuration
// -----------------------------------------------------------------------------
$rootPath = dirname(__DIR__);
if (is_readable($rootPath . '/.env')) {
    Dotenv::createImmutable($rootPath)->safeLoad();
}

// Fallback defaults
$_ENV['APP_ENV']   ??= 'prod';
$_ENV['APP_DEBUG'] ??= ($_ENV['APP_ENV'] !== 'prod') ? '1' : '0';

$debugEnabled = filter_var($_ENV['APP_DEBUG'], FILTER_VALIDATE_BOOL);

// -----------------------------------------------------------------------------
//  3.  Global error / exception handling
// -----------------------------------------------------------------------------
if ($debugEnabled) {
    (new WhoopsExceptionHandler())->register();
} else {
    // Fallback handler – log but do not expose stack traces.
    set_exception_handler(static function (Throwable $e): void {
        error_log((string) $e);
        http_response_code(500);
        echo 'Internal Server Error';
    });
}

// -----------------------------------------------------------------------------
//  4.  Dependency-injection container & application kernel
// -----------------------------------------------------------------------------
/** @var LoggerInterface $logger */
$logger = LoggerFactory::build(
    level: $_ENV['LOG_LEVEL'] ?? Logger::INFO,
    channel: 'front-controller'
);

$kernel = new ApplicationKernel(
    appEnv : $_ENV['APP_ENV'],
    isDebug: $debugEnabled,
    logger : $logger
);

$kernel->boot();

// -----------------------------------------------------------------------------
//  5.  Construct PSR-7 request from PHP super-globals
// -----------------------------------------------------------------------------
$psr17Factory = new Psr17Factory();
$creator      = new ServerRequestCreator(
    $psr17Factory, // ServerRequestFactory
    $psr17Factory, // UriFactory
    $psr17Factory, // UploadedFileFactory
    $psr17Factory  // StreamFactory
);

/** @var ServerRequestInterface $request */
$request = $creator->fromGlobals();

// -----------------------------------------------------------------------------
//  6.  Handle the request – route & dispatch
// -----------------------------------------------------------------------------
try {
    $response = $kernel->handle($request);
} catch (NotFoundHttpException $e) {
    // 404 – resource not found
    $response = $e->toPsr7Response();
} catch (HttpExceptionInterface $e) {
    // Any other HTTP-aware exception (4xx/5xx)
    $response = $e->toPsr7Response();
} catch (Throwable $e) {
    // Unhandled edge-case – fail gracefully
    if ($debugEnabled) {
        throw $e; // Let Whoops or PHP output full stack-trace
    }

    $logger->error('Unhandled exception bubbled up to front-controller.', [
        'exception' => $e,
    ]);

    $response = $psr17Factory->createResponse(500, 'Internal Server Error');
    $response->getBody()->write('Internal Server Error');
}

// -----------------------------------------------------------------------------
//  7.  Security hardening – default response headers
// -----------------------------------------------------------------------------
if (!$response->hasHeader('X-Content-Type-Options')) {
    $response = $response->withHeader('X-Content-Type-Options', 'nosniff');
}
if (!$response->hasHeader('X-Frame-Options')) {
    $response = $response->withHeader('X-Frame-Options', 'SAMEORIGIN');
}
if (!$response->hasHeader('Referrer-Policy')) {
    $response = $response->withHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// -----------------------------------------------------------------------------
//  8.  Emit the response to the client
// -----------------------------------------------------------------------------
$responseEmitter = new ResponseEmitter();
$responseEmitter->emit($response);

// -----------------------------------------------------------------------------
//  9.  Terminate – perform post-response cleanup
// -----------------------------------------------------------------------------
$kernel->terminate($request, $response);
```