<?php
declare(strict_types=1);

/**
 * ProdSecure Orchestrator
 * -----------------------
 * CommandBus.php
 *
 * The CommandBus is at the heart of the Command Pattern implementation.  It is responsible
 * for locating a CommandHandler for a given Command, marshalling the Command through a
 * configurable middleware pipeline (Chain-of-Responsibility), and optionally delegating
 * asynchronous Commands to a queue transport.
 *
 * © 2024  SecureSoft Inc.
 */

namespace ProdSecureOrchestrator\Application;

use Closure;
use ProdSecureOrchestrator\Domain\Command\CommandInterface;
use ProdSecureOrchestrator\Domain\Command\CommandHandlerInterface;
use ProdSecureOrchestrator\Domain\Command\Middleware\MiddlewareInterface;
use ProdSecureOrchestrator\Domain\Command\Middleware\TransactionMiddleware;
use ProdSecureOrchestrator\Domain\Exception\CommandHandlerNotFoundException;
use ProdSecureOrchestrator\Domain\Exception\CommandDispatchException;
use ProdSecureOrchestrator\Infrastructure\Logging\LoggerInterface;
use ProdSecureOrchestrator\Infrastructure\Messaging\Queue\AsyncCommandQueueInterface;
use RuntimeException;
use Throwable;

/**
 * Class CommandBus
 *
 * Example usage:
 *   $bus = new CommandBus($logger, $queue);
 *   $bus->addMiddleware(new ValidationMiddleware());
 *   $bus->registerHandler(CreateBackupCommand::class, $createBackupHandler);
 *   $bus->dispatch(new CreateBackupCommand($params));
 */
final class CommandBus
{
    /**
     * @var array<class-string<CommandInterface>, CommandHandlerInterface>
     */
    private array $handlers = [];

    /**
     * @var list<MiddlewareInterface>
     */
    private array $middlewareStack = [];

    /**
     * @param LoggerInterface                 $logger
     * @param AsyncCommandQueueInterface|null $asyncQueue
     */
    public function __construct(
        private readonly LoggerInterface $logger,
        private readonly ?AsyncCommandQueueInterface $asyncQueue = null,
    ) {
        /**
         * Enforce at least a transaction middleware so that
         * every command is executed atomically by default.
         */
        $this->middlewareStack[] = new TransactionMiddleware($logger);
    }

    /**
     * Registers a CommandHandler for a specific Command class.
     *
     * @param class-string<CommandInterface> $commandClass
     */
    public function registerHandler(string $commandClass, CommandHandlerInterface $handler): void
    {
        $this->handlers[$commandClass] = $handler;
        $this->logger->debug(
            '[CommandBus] Registered handler {handler} for command {command}',
            ['handler' => $handler::class, 'command' => $commandClass],
        );
    }

    /**
     * Appends a Middleware instance to the pipeline.
     */
    public function addMiddleware(MiddlewareInterface $middleware): void
    {
        $this->middlewareStack[] = $middleware;
        $this->logger->debug('[CommandBus] Added middleware {mw}', ['mw' => $middleware::class]);
    }

    /**
     * Dispatches a Command either synchronously or asynchronously, depending on
     * whether the Command implements SupportsAsyncInterface **and** an AsyncQueue
     * has been configured.
     *
     * @throws CommandHandlerNotFoundException
     * @throws CommandDispatchException
     * @return mixed
     */
    public function dispatch(CommandInterface $command): mixed
    {
        $this->logger->info('[CommandBus] Dispatching command {command}', ['command' => $command::class]);

        // If command is flagged as async and we have a queue driver ‑ push it
        if ($command instanceof CommandInterface\SupportsAsyncInterface && $command->shouldQueue()) {
            if ($this->asyncQueue === null) {
                $message = sprintf(
                    'Command %s requires asynchronous execution, but no AsyncCommandQueue configured.',
                    $command::class,
                );
                $this->logger->error($message);
                throw new CommandDispatchException($message);
            }

            $this->asyncQueue->enqueue($command);
            $this->logger->notice(
                '[CommandBus] Dispatched {command} to async queue {queue}',
                ['command' => $command::class, 'queue' => $this->asyncQueue::class],
            );

            return null; // No immediate result
        }

        $handler = $this->resolveHandler($command);

        // Build the execution chain
        $execution = $this->createExecutionChain($handler);
        try {
            return $execution($command);
        } catch (Throwable $e) {
            $this->logger->critical(
                '[CommandBus] Exception while handling {command}: {exception}',
                ['command' => $command::class, 'exception' => $e->getMessage()],
            );

            if ($e instanceof CommandDispatchException) {
                throw $e;
            }

            throw new CommandDispatchException(
                sprintf('Exception thrown while executing command %s.', $command::class),
                previous: $e,
            );
        }
    }

    /**
     * Resolves the CommandHandler responsible for a given Command.
     *
     * @throws CommandHandlerNotFoundException
     */
    private function resolveHandler(CommandInterface $command): CommandHandlerInterface
    {
        $commandClass = $command::class;

        if (!isset($this->handlers[$commandClass])) {
            $this->logger->error(
                '[CommandBus] No handler registered for command {command}',
                ['command' => $commandClass],
            );
            throw new CommandHandlerNotFoundException($commandClass);
        }

        return $this->handlers[$commandClass];
    }

    /**
     * Wrap the Handler with the middleware stack.
     *
     * @return Closure(CommandInterface): mixed
     */
    private function createExecutionChain(CommandHandlerInterface $handler): Closure
    {
        $next = static function (CommandInterface $command) use ($handler): mixed {
            return $handler->handle($command);
        };

        /**
         * Middlewares are executed in LIFO order: last added, first executed
         */
        $stack = array_reverse($this->middlewareStack);
        foreach ($stack as $middleware) {
            $next = static function (CommandInterface $command) use ($middleware, $next): mixed {
                return $middleware->process($command, $next);
            };
        }

        return $next;
    }
}

