```php
#!/usr/bin/env php
<?php
/**
 * ProdSecure Orchestrator – Worker Entrypoint
 *
 * This executable boots the DI-container, wires all queue / event handlers
 * and starts a long–running worker that consumes jobs from the internal
 * work-queue.  It is designed to be invoked from systemd, supervisord or
 * Kubernetes CronJobs / Deployments.
 *
 * Usage:
 *   bin/run-worker.php [--queue=<name>] [--concurrency=<int>] [--once]
 *
 * Flags:
 *   --queue         Work-queue / routing-key to listen on    (default: default)
 *   --concurrency   Number of parallel child-workers         (default: 1)
 *   --once          Exit after processing a single message
 *
 * NOTE:
 *   This script purposefully contains a small subset of bootstrap logic so
 *   that it remains self-contained. In a real deployment the Worker class
 *   would live under src/ and be auto-loaded via Composer.
 */

declare(strict_types=1);

use Monolog\Handler\StreamHandler;
use Monolog\Logger;
use ProdSecure\Application\Queue\JobInterface;
use ProdSecure\Application\Queue\QueueConsumerInterface;
use ProdSecure\Application\Queue\Transport\RedisQueueConsumer;
use ProdSecure\Application\Queue\Transport\RabbitMqQueueConsumer;
use ProdSecure\Domain\Exception\UnhandledJobException;
use ProdSecure\Infrastructure\Env\DotEnv;

/** -----------------------------------------------------------------
 * Bootstrap
 * ----------------------------------------------------------------- */
$root = \dirname(__DIR__);                                // project root
$autoload = $root . '/vendor/autoload.php';
if (!\file_exists($autoload)) {
    \fwrite(STDERR, "ERROR: Composer autoloader not found. Did you run `composer install`?\n");
    exit(1);
}
require_once $autoload;

/**
 * Load environment variables (if the component is installed).
 * Do not fail if vlucas/phpdotenv is missing – the container may inject envs.
 */
try {
    if (\class_exists(DotEnv::class) && \file_exists($root.'/.env')) {
        (new DotEnv())->boot($root.'/.env');
    }
} catch (\Throwable $e) {
    \fwrite(STDERR, "WARNING: Unable to load .env – ".$e->getMessage()."\n");
}

/** -----------------------------------------------------------------
 * CLI-Arguments
 * ----------------------------------------------------------------- */
[$queue, $concurrency, $runOnce] = (static function (): array {
    $queue       = 'default';
    $concurrency = 1;
    $runOnce     = false;

    $args = \array_slice($_SERVER['argv'], 1);
    foreach ($args as $arg) {
        if (\preg_match('/^--queue=(.+)$/', $arg, $m)) {
            $queue = $m[1];
        } elseif (\preg_match('/^--concurrency=(\d+)$/', $arg, $m)) {
            $concurrency = (int) $m[1];
            if ($concurrency < 1) {
                throw new InvalidArgumentException('--concurrency must be >= 1');
            }
        } elseif ($arg === '--once') {
            $runOnce = true;
        } else {
            throw new InvalidArgumentException("Unknown flag: $arg");
        }
    }

    return [$queue, $concurrency, $runOnce];
})();

/** -----------------------------------------------------------------
 * Logger
 * ----------------------------------------------------------------- */
$logger = new Logger('worker');
$logger->pushHandler(new StreamHandler('php://stdout', Logger::INFO));

/** -----------------------------------------------------------------
 * Queue Consumer Factory
 * ----------------------------------------------------------------- */
$queueConsumer = (static function (string $queue, Logger $logger): QueueConsumerInterface {
    $backend = \getenv('PS_QUEUE_BACKEND') ?: 'redis';   // redis | rabbitmq

    switch ($backend) {
        case 'redis':
            return new RedisQueueConsumer(
                dsn:   \getenv('PS_REDIS_DSN') ?: 'redis://127.0.0.1:6379',
                queue: $queue,
                logger: $logger
            );

        case 'rabbitmq':
            return new RabbitMqQueueConsumer(
                dsn:   \getenv('PS_RMQ_DSN') ?: 'amqp://guest:guest@127.0.0.1:5672',
                queue: $queue,
                logger: $logger
            );

        default:
            throw new RuntimeException("Unsupported queue backend: {$backend}");
    }
})($queue, $logger);

/** -----------------------------------------------------------------
 * Worker Supervisor
 * ----------------------------------------------------------------- */
$supervisor = new class ($queueConsumer, $logger, $concurrency, $runOnce) {

    private QueueConsumerInterface $consumer;
    private Logger                 $logger;
    private int                    $concurrency;
    private bool                   $runOnce;
    private bool                   $running = true;
    private array                  $children = [];

    public function __construct(
        QueueConsumerInterface $consumer,
        Logger                 $logger,
        int                    $concurrency,
        bool                   $runOnce = false
    ) {
        if (!\function_exists('pcntl_fork')) {
            throw new RuntimeException('pcntl extension is required for concurrency > 1');
        }

        $this->consumer     = $consumer;
        $this->logger       = $logger;
        $this->concurrency  = $concurrency;
        $this->runOnce      = $runOnce;

        $this->registerSignalHandlers();
    }

    public function run(): void
    {
        $this->logger->info('Supervisor starting', [
            'queue'       => $this->consumer->getQueueName(),
            'concurrency' => $this->concurrency,
            'backend'     => $this->consumer::class,
        ]);

        for ($i = 0; $i < $this->concurrency; $i++) {
            $this->spawnWorker();
        }

        // Supervisor loop: reap workers and respawn if they exited unexpectedly
        while ($this->running) {
            $pid = pcntl_wait($status, WNOHANG);
            if ($pid > 0 && isset($this->children[$pid])) {
                unset($this->children[$pid]);
                if ($this->running) {
                    $this->logger->warning("Worker {$pid} exited – respawning");
                    $this->spawnWorker();
                }
            }
            usleep(200_000); // 0.2s
        }

        $this->logger->info('Supervisor shutting down');
    }

    /* ----------------------------------------------------------
     * Internal Helpers
     * ---------------------------------------------------------- */

    private function spawnWorker(): void
    {
        $pid = pcntl_fork();
        if ($pid === -1) {
            throw new RuntimeException('Unable to fork worker');
        }

        if ($pid) { // parent
            $this->children[$pid] = true;
            return;
        }

        // child-process
        $this->runWorkerLoop();
        exit(0);
    }

    private function runWorkerLoop(): void
    {
        $workerId = getmypid();
        $this->logger->info("Worker {$workerId} booted");

        while ($this->running) {
            try {
                $job = $this->consumer->dequeue(3); // timeout seconds
                if ($job === null) {
                    continue;
                }

                $this->handleJob($job);

                if ($this->runOnce) {
                    $this->running = false;
                }
            } catch (UnhandledJobException $e) {
                $this->logger->error('Unhandled Job – burying', ['reason' => $e->getMessage()]);
                $this->consumer->bury($e->getJob());
            } catch (\Throwable $e) {
                $this->logger->critical('Fatal error', ['exception' => $e]);
                // Avoid tight crash loops
                usleep(500_000);
            }
        }

        $this->logger->info("Worker {$workerId} exiting");
    }

    private function handleJob(JobInterface $job): void
    {
        $this->logger->info('Processing job', ['type' => $job::class, 'id' => $job->getUuid()]);

        // --------------------------------------------------
        // Chain-Of-Responsibility to resolve appropriate handler
        // --------------------------------------------------
        $handler = $this->resolveHandler($job);
        if ($handler === null) {
            throw new UnhandledJobException("No handler registered for {$job::class}", $job);
        }

        $handler->handle($job);
        $this->consumer->ack($job);

        $this->logger->info('Job completed', ['id' => $job->getUuid()]);
    }

    private function resolveHandler(JobInterface $job): ?object
    {
        // In production we ask the DI-container; here we fall back to a simple map
        static $map = [
            'ProdSecure\\Application\\Job\\ScanFilesystemJob'
                => 'ProdSecure\\Application\\Handler\\ScanFilesystemHandler',
            'ProdSecure\\Application\\Job\\SendAlertJob'
                => 'ProdSecure\\Application\\Handler\\SendAlertHandler',
        ];

        $class = $job::class;
        if (!isset($map[$class]) || !\class_exists($map[$class])) {
            return null;
        }

        return new $map[$class](); // naive – container would inject deps
    }

    /* ----------------------------------------------------------
     * Signal Handling
     * ---------------------------------------------------------- */

    private function registerSignalHandlers(): void
    {
        pcntl_async_signals(true);

        $stop = function (int $signal): void {
            $this->running = false;
            $this->logger->info("Received signal {$signal}; stopping gracefully");

            // Forward signal to children
            foreach (\array_keys($this->children) as $pid) {
                posix_kill($pid, $signal);
            }
        };

        pcntl_signal(SIGTERM, $stop);
        pcntl_signal(SIGINT,  $stop);
        pcntl_signal(SIGCHLD, SIG_IGN);
    }
};

try {
    $supervisor->run();
} catch (\Throwable $e) {
    $logger->critical('Worker bootstrap failed', ['exception' => $e]);
    exit(1);
}

////////////////////////////////////////////////////////////////////////////////
//                      INTERFACES / STUB IMPLEMENTATIONS                     //
////////////////////////////////////////////////////////////////////////////////
namespace ProdSecure\Application\Queue {
    use Monolog\Logger;

    interface JobInterface
    {
        public function getUuid(): string;
        public function getPayload(): array;
    }

    interface QueueConsumerInterface
    {
        public function dequeue(int $timeoutSeconds): ?JobInterface;
        public function ack(JobInterface $job): void;
        public function bury(JobInterface $job): void;
        public function getQueueName(): string;
    }
}

namespace ProdSecure\Domain\Exception {
    use ProdSecure\Application\Queue\JobInterface;

    class UnhandledJobException extends \RuntimeException
    {
        private JobInterface $job;

        public function __construct(string $message, JobInterface $job)
        {
            parent::__construct($message);
            $this->job = $job;
        }

        public function getJob(): JobInterface
        {
            return $this->job;
        }
    }
}

namespace ProdSecure\Infrastructure\Env {
    /**
     * Lightweight wrapper around vlucas/phpdotenv for optional dependency.
     */
    final class DotEnv
    {
        public function boot(string $path): void
        {
            if (\class_exists(\Dotenv\Dotenv::class)) {
                $dotenv = \Dotenv\Dotenv::createImmutable(\dirname($path));
                $dotenv->load();
            }
        }
    }
}

namespace ProdSecure\Application\Queue\Transport {
    use Monolog\Logger;
    use ProdSecure\Application\Queue\JobInterface;
    use ProdSecure\Application\Queue\QueueConsumerInterface;

    /**
     * Very small placeholder implementations. Real transports would integrate
     * with php-amqplib / predis etc.  These are *functional* but not suitable
     * for production use.  They exist merely so run-worker.php remains runnable.
     */
    final class RedisQueueConsumer implements QueueConsumerInterface
    {
        private string $queue;
        private \Redis $redis;
        private Logger $logger;

        public function __construct(string $dsn, string $queue, Logger $logger)
        {
            $this->queue  = $queue;
            $this->logger = $logger;

            $this->redis = new \Redis();
            $this->redis->connect(parse_url($dsn, PHP_URL_HOST) ?: '127.0.0.1');
        }

        public function dequeue(int $timeoutSeconds): ?JobInterface
        {
            [$queue, $payload] = $this->redis->brPop([$this->queue], $timeoutSeconds) ?: [null, null];

            if ($payload === null) {
                return null;
            }

            return new class ($payload) implements JobInterface {
                private string $uuid;
                private array  $payload;
                public function __construct(string $payload)
                {
                    $data          = json_decode($payload, true) ?? [];
                    $this->uuid    = $data['uuid']   ?? bin2hex(random_bytes(16));
                    $this->payload = $data['payload'] ?? [];
                }
                public function getUuid(): string   { return $this->uuid; }
                public function getPayload(): array { return $this->payload; }
            };
        }

        public function ack(JobInterface $job): void { /* redis lists auto-pop. */ }
        public function bury(JobInterface $job): void { $this->logger->warning('Bury not supported on Redis'); }
        public function getQueueName(): string { return $this->queue; }
    }

    final class RabbitMqQueueConsumer implements QueueConsumerInterface
    {
        private \PhpAmqpLib\Connection\AMQPStreamConnection $conn;
        private \PhpAmqpLib\Channel\AMQPChannel             $channel;
        private string                                      $queue;
        private Logger                                      $logger;

        public function __construct(string $dsn, string $queue, Logger $logger)
        {
            if (!\class_exists(\PhpAmqpLib\Connection\AMQPStreamConnection::class)) {
                throw new \RuntimeException('php-amqplib/php-amqplib is required for RabbitMQ backend');
            }

            $this->logger = $logger;
            $this->queue  = $queue;

            $url  = parse_url($dsn);
            $host = $url['host'] ?? 'localhost';
            $port = $url['port'] ?? 5672;
            $user = $url['user'] ?? 'guest';
            $pass = $url['pass'] ?? 'guest';

            $this->conn    = new \PhpAmqpLib\Connection\AMQPStreamConnection($host, $port, $user, $pass);
            $this->channel = $this->conn->channel();
            $this->channel->queue_declare($queue, false, true, false, false);
        }

        public function dequeue(int $timeoutSeconds): ?JobInterface
        {
            $msg = $this->channel->basic_get($this->queue);
            if ($msg === null) {
                sleep($timeoutSeconds);
                return null;
            }

            return new class ($msg) implements JobInterface {
                private string $uuid;
                private array  $payload;
                private \PhpAmqpLib\Message\AMQPMessage $msg;
                public function __construct(\PhpAmqpLib\Message\AMQPMessage $msg)
                {
                    $this->msg     = $msg;
                    $data          = json_decode($msg->body, true) ?? [];
                    $this->uuid    = $data['uuid']   ?? bin2hex(random_bytes(16));
                    $this->payload = $data['payload'] ?? [];
                }
                public function getUuid(): string   { return $this->uuid; }
                public function getPayload(): array { return $this->payload; }
                public function getAmqpMessage(): \PhpAmqpLib\Message\AMQPMessage { return $this->msg; }
            };
        }

        public function ack(JobInterface $job): void
        {
            if (\method_exists($job, 'getAmqpMessage')) {
                $job->getAmqpMessage()->ack();
            }
        }

        public function bury(JobInterface $job): void
        {
            // Re-queue with "x-death" header or move to dead-letter exchange
            $this->logger->warning('Bury not implemented for RabbitMQ');
        }

        public function getQueueName(): string { return $this->queue; }
    }
}
```