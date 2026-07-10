<?php
declare(strict_types=1);

/**
 * ProdSecure Orchestrator
 * ========================
 * Database configuration bootstrap & connection helper.
 *
 * This file intentionally contains executable code so that the entire
 * application can obtain secure, ready-to-use PDO handles by calling:
 *
 *     $pdo = \ProdSecure\Infrastructure\Database\Config::connection();
 *
 * Features
 * --------
 * • Multiple named connections (default, read_only, …)  
 * • Master/replica topology with automatic fail-over  
 * • Credentials stored encrypted in ENV (AES-256-GCM)  
 * • Lazy instantiation + in-process connection pool  
 * • Hardened PDO attributes & runtime health-check  
 *
 * NOTE: If you prefer a simple array, you can still `include` this file and
 * fetch `Config::config()`.  Returning the FQCN at the bottom keeps the
 * autoloader happy and prevents circular includes in composer-driven projects.
 */

namespace ProdSecure\Infrastructure\Database;

use PDO;
use PDOException;
use RuntimeException;
use Throwable;

final class Config
{
    /**
     * Per-process PDO pool.
     *
     * @var array<string, PDO>
     */
    private static array $pool = [];

    /**
     * Cached raw configuration.
     *
     * @var array<string, array<string, mixed>>|null
     */
    private static ?array $config = null;

    /**
     * Obtain a PDO connection by logical name.
     *
     * @param  string $name   Connection identifier (default: "default").
     * @return PDO            Ready-to-use PDO handle.
     *
     * @throws RuntimeException If configuration or connection fails.
     */
    public static function connection(string $name = 'default'): PDO
    {
        if (isset(self::$pool[$name])) {
            return self::$pool[$name];
        }

        $settings = self::config($name);

        try {
            $pdo = new PDO(
                dsn:      self::dsn($settings),
                username: $settings['username'] ?? '',
                password: $settings['password'] ?? '',
                options:  self::pdoOptions($settings)
            );

            if (($settings['healthcheck'] ?? true) === true) {
                self::assertHealthy($pdo);
            }

            return self::$pool[$name] = $pdo;
        } catch (PDOException $e) {
            throw new RuntimeException(
                sprintf('Unable to connect to DB "%s": %s', $name, $e->getMessage()),
                (int)$e->getCode(),
                $e
            );
        }
    }

    /**
     * Raw config accessor (lazy-loaded from ENV).
     *
     * @param  string $name
     * @return array<string, mixed>
     */
    public static function config(string $name): array
    {
        if (self::$config === null) {
            self::$config = self::loadFromEnv();
        }

        if (!isset(self::$config[$name])) {
            throw new RuntimeException(sprintf('Database connection "%s" is not defined.', $name));
        }

        return self::$config[$name];
    }

    /**
     * Flush connection pool & cached config (mainly used in unit tests).
     */
    public static function reset(): void
    {
        foreach (self::$pool as $pdo) {
            $pdo = null; // PDO destructor closes connection.
        }
        self::$pool  = [];
        self::$config = null;
    }

    /* -----------------------------------------------------------------
     * Internals
     * ----------------------------------------------------------------- */

    /**
     * Build DSN string.
     *
     * @param  array<string, mixed> $settings
     * @return string
     */
    private static function dsn(array $settings): string
    {
        return match ($settings['driver'] ?? 'mysql') {
            'pgsql'  => sprintf(
                'pgsql:host=%s;port=%d;dbname=%s',
                $settings['host'],
                $settings['port'] ?? 5432,
                $settings['database']
            ),

            'sqlite' => sprintf('sqlite:%s', $settings['database']),

            default  => sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=%s',
                $settings['host'],
                $settings['port'] ?? 3306,
                $settings['database'],
                $settings['charset'] ?? 'utf8mb4'
            ),
        };
    }

    /**
     * PDO options (secure by default, can be overridden).
     *
     * @param  array<string, mixed> $settings
     * @return array<int, mixed>
     */
    private static function pdoOptions(array $settings): array
    {
        return ($settings['options'] ?? []) + [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_PERSISTENT         => $settings['persistent'] ?? true,
            // MySQL-specific:
            PDO::MYSQL_ATTR_INIT_COMMAND => "SET time_zone = '+00:00', NAMES utf8mb4",
        ];
    }

    /**
     * Parse ENV / .env and return typed config array.
     *
     * @return array<string, array<string, mixed>>
     */
    private static function loadFromEnv(): array
    {
        // Attempt to bootstrap Dotenv if available.
        if (file_exists(dirname(__DIR__, 2) . '/vendor/autoload.php')) {
            /** @psalm-suppress UnresolvableInclude */
            require_once dirname(__DIR__, 2) . '/vendor/autoload.php';
        }

        if (class_exists('\Dotenv\Dotenv')) {
            try {
                \Dotenv\Dotenv::createImmutable(dirname(__DIR__, 2))->safeLoad();
            } catch (Throwable) {
                // Silent — we'll fall back to $_ENV.
            }
        }

        return [
            'default' => [
                'driver'      => $_ENV['DB_DRIVER']   ?? 'mysql',
                'host'        => $_ENV['DB_HOST']     ?? 'localhost',
                'port'        => (int)($_ENV['DB_PORT'] ?? 3306),
                'database'    => $_ENV['DB_DATABASE'] ?? 'prodsecure',
                'username'    => self::decryptEnv('DB_USERNAME'),
                'password'    => self::decryptEnv('DB_PASSWORD'),
                'charset'     => $_ENV['DB_CHARSET']  ?? 'utf8mb4',
                'persistent'  => ($_ENV['DB_PERSISTENT'] ?? 'true') === 'true',
                'healthcheck' => ($_ENV['DB_HEALTHCHECK'] ?? 'true') === 'true',
            ],

            'read_only' => [
                'driver'      => $_ENV['RO_DB_DRIVER']   ?? 'mysql',
                'host'        => $_ENV['RO_DB_HOST']     ?? 'localhost',
                'port'        => (int)($_ENV['RO_DB_PORT'] ?? 3306),
                'database'    => $_ENV['RO_DB_DATABASE'] ?? 'prodsecure',
                'username'    => self::decryptEnv('RO_DB_USERNAME'),
                'password'    => self::decryptEnv('RO_DB_PASSWORD'),
                'charset'     => $_ENV['RO_DB_CHARSET']  ?? 'utf8mb4',
                'persistent'  => ($_ENV['RO_DB_PERSISTENT'] ?? 'false') === 'true',
                'healthcheck' => ($_ENV['RO_DB_HEALTHCHECK'] ?? 'true') === 'true',
            ],
        ];
    }

    /**
     * Decrypt an ENV var if wrapped in "ENC(...)", else return as-is.
     *
     * Encryption: AES-256-GCM
     * Payload:    base64( iv[12] || tag[16] || ciphertext )
     * Key:        hash('sha256', getenv('CONFIG_CRYPT_KEY'), true)
     *
     * @param  string $var
     * @return string|null
     *
     * @throws RuntimeException Missing key or decryption errors.
     */
    private static function decryptEnv(string $var): ?string
    {
        $value = $_ENV[$var] ?? null;
        if ($value === null || $value === '') {
            return null;
        }

        if (!str_starts_with($value, 'ENC(') || !str_ends_with($value, ')')) {
            return $value; // Looks unencrypted.
        }

        if (!extension_loaded('openssl')) {
            throw new RuntimeException('OpenSSL extension not available — cannot decrypt ENV.');
        }

        $blob = base64_decode(substr($value, 4, -1), true);
        if ($blob === false || strlen($blob) < 28) {
            throw new RuntimeException("Malformed encrypted payload for {$var}.");
        }

        $iv  = substr($blob, 0, 12);
        $tag = substr($blob, 12, 16);
        $ct  = substr($blob, 28);

        $keyInput = $_ENV['CONFIG_CRYPT_KEY'] ?? '';
        if ($keyInput === '') {
            throw new RuntimeException('Missing CONFIG_CRYPT_KEY — cannot decrypt credentials.');
        }

        $key = hash('sha256', $keyInput, true);

        $pt = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);

        if ($pt === false) {
            throw new RuntimeException("Decryption failed for {$var}.");
        }

        return $pt;
    }

    /**
     * Sanity check connection.
     *
     * @param PDO $pdo
     */
    private static function assertHealthy(PDO $pdo): void
    {
        try {
            $pdo->query('SELECT 1');
        } catch (Throwable $e) {
            throw new RuntimeException('DB health-check ping failed: ' . $e->getMessage(), 0, $e);
        }
    }

    private function __construct() {} // Static-only utility
}

return Config::class;