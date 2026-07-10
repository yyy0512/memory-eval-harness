```php
<?php
/**
 * ProdSecure Orchestrator – Test Bootstrap
 *
 * This file is executed before every PHPUnit run and prepares the testing
 * environment by:
 *   • Registering Composer’s autoloader
 *   • Loading environment variables from `.env.test` / `.env`
 *   • Configuring error handling & timezone
 *   • Bootstrapping a lightweight PSR-11 container with test doubles
 *   • Exposing global helper functions (`testContainer()`, `testLogger()`)
 *
 * Keep the bootstrap framework-agnostic so that other tooling (php-stan,
 * infection, etc.) can reuse it.
 *
 * @author    ProdSecure
 * @copyright 2024
 * @license   MIT
 */

declare(strict_types=1);

/* -------------------------------------------------------------------------
 | Autoloader
 * ----------------------------------------------------------------------- */
require_once dirname(__DIR__) . '/vendor/autoload.php';

/* -------------------------------------------------------------------------
 | Imports
 * ----------------------------------------------------------------------- */
use Dotenv\Dotenv;
use Monolog\Handler\StreamHandler;
use Monolog\Logger;
use PDO;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

/* -------------------------------------------------------------------------
 | Constants
 * ----------------------------------------------------------------------- */
const PROJECT_ROOT = __DIR__ . '/..';
const TESTS_ROOT   = __DIR__;
const VAR_PATH     = PROJECT_ROOT . '/var';

/* -------------------------------------------------------------------------
 | Error Handling & Timezone
 * ----------------------------------------------------------------------- */
date_default_timezone_set('UTC');
error_reporting(E_ALL);
ini_set('display_errors', '1');

/* -------------------------------------------------------------------------
 | Environment (.env / .env.test)
 * ----------------------------------------------------------------------- */
if (class_exists(Dotenv::class)) {
    $envFile = file_exists(PROJECT_ROOT . '/.env.test') ? '.env.test' : '.env';
    Dotenv::createImmutable(PROJECT_ROOT, $envFile)->safeLoad();
}

$_ENV['APP_ENV']   = $_ENV['APP_ENV']   ?? 'test';
$_ENV['LOG_LEVEL'] = $_ENV['LOG_LEVEL'] ?? Logger::DEBUG;

/* -------------------------------------------------------------------------
 | Verify safe environment – abort when executed outside testing context
 * ----------------------------------------------------------------------- */
if (! in_array($_ENV['APP_ENV'], ['test', 'testing', 'ci'], true)) {
    fwrite(STDERR, "Unsafe environment '{$ _ENV['APP_ENV'] }' – aborting test bootstrap." . PHP_EOL);
    exit(1);
}

/* -------------------------------------------------------------------------
 | Ensure writable var/ directories
 * ----------------------------------------------------------------------- */
@mkdir(VAR_PATH . '/cache', 0775, true);
@mkdir(VAR_PATH . '/log',   0775, true);

/* -------------------------------------------------------------------------
 | Test-Scope Dependency Injection Container
 * ----------------------------------------------------------------------- */
/**
 * Returns a fresh, lightweight PSR-11 container configured for tests.
 *
 * @return ContainerInterface
 */
$GLOBALS['__pso_container_init'] = static function (): ContainerInterface {
    /** @var class-string<ContainerInterface> $anonymous */
    $anonymous = new class implements ContainerInterface {

        /** @var array<string, mixed> */
        private array $entries = [];

        public function __construct()
        {
            /* -------------------------------------------------------------
             | Logger (Monolog – writes to var/log/unit-tests.log)
             * ----------------------------------------------------------- */
            $logger = new Logger('pso-test');
            $logger->pushHandler(
                new StreamHandler(
                    VAR_PATH . '/log/unit-tests.log',
                    (int)($_ENV['LOG_LEVEL'] ?? Logger::DEBUG)
                )
            );
            $this->entries[LoggerInterface::class] = $logger;

            /* -------------------------------------------------------------
             | In-Memory SQLite (lightweight for repository tests)
             * ----------------------------------------------------------- */
            $pdo = new PDO('sqlite::memory:');
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->entries[PDO::class] = $pdo;

            /* -------------------------------------------------------------
             | Faker (optional – only if package present)
             * ----------------------------------------------------------- */
            if (class_exists('Faker\Factory')) {
                $this->entries['faker'] = Faker\Factory::create();
            }
        }

        /* -----------------------  PSR-11  ----------------------------- */

        public function get(string $id): mixed
        {
            if (! $this->has($id)) {
                throw new RuntimeException("Service '{$id}' not found in test container.");
            }
            return $this->entries[$id];
        }

        public function has(string $id): bool
        {
            return array_key_exists($id, $this->entries);
        }

        /* ---------------------------------------------------------------
         | Helper to override services from within a test case
         * ------------------------------------------------------------- */
        public function set(string $id, mixed $service): void
        {
            $this->entries[$id] = $service;
        }
    };

    return $anonymous;
};

$GLOBALS['container'] = ($GLOBALS['__pso_container_init'])();

/* -------------------------------------------------------------------------
 | Global Convenience Helpers
 * ----------------------------------------------------------------------- */

/**
 * Returns the shared PSO test container.
 */
function testContainer(): ContainerInterface
{
    return $GLOBALS['container'];
}

/**
 * Shortcut for retrieving the Monolog test logger.
 */
function testLogger(): LoggerInterface
{
    return testContainer()->get(LoggerInterface::class);
}

/**
 * Rebuilds the container from scratch – useful when you need a pristine
 * PDO connection between tests.
 */
function refreshContainer(): void
{
    $builder            = $GLOBALS['__pso_container_init'];
    $GLOBALS['container'] = $builder();
}

/* -------------------------------------------------------------------------
 | Database Schema (optional)
 * ----------------------------------------------------------------------- */
$schemaPath = PROJECT_ROOT . '/database/schema.sql';
if (file_exists($schemaPath)) {
    $sql = file_get_contents($schemaPath);
    if ($sql !== false && trim($sql) !== '') {
        testContainer()->get(PDO::class)->exec($sql);
    }
}

/* -------------------------------------------------------------------------
 | Ready!
 * ----------------------------------------------------------------------- */
return true;
```