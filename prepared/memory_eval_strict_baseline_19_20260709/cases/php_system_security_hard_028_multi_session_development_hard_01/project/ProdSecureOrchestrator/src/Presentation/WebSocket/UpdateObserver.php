<?php

declare(strict_types=1);

namespace ProdSecure\Orchestrator\Presentation\WebSocket;

use ProdSecure\Orchestrator\Application\Contracts\ViewModel\RealtimeUpdatableInterface;
use ProdSecure\Orchestrator\Infrastructure\WebSocket\ConnectionRegistryInterface;
use ProdSecure\Orchestrator\Infrastructure\WebSocket\Exception\WebSocketDeliveryException;
use ProdSecure\Orchestrator\Shared\Instrumentation\Metrics\MetricCounterInterface;
use Psr\Log\LoggerInterface;
use Ramsey\Uuid\UuidInterface;
use SplObserver;
use SplSubject;
use Symfony\Component\Serializer\SerializerInterface;

/**
 * UpdateObserver
 *
 * Bridges backend ViewModel updates to all active WebSocket clients.
 * Implements the Observer pattern through SplObserver so that any
 * real-time capable ViewModel can notify UI widgets with zero coupling.
 *
 * This class is instantiated by the Dependency Injection container and
 * registered as a global observer in the bootstrap phase (see
 * AppServiceProvider::registerRealtimeObservers()).
 */
final class UpdateObserver implements SplObserver
{
    /**
     * The maximum number of consecutive failed deliveries before a
     * WebSocket connection is forcefully closed.
     */
    private const MAX_FAILURES = 3;

    private ConnectionRegistryInterface $connectionRegistry;
    private SerializerInterface $serializer;
    private LoggerInterface $logger;
    private MetricCounterInterface $metricCounter;

    /**
     * Contains the number of consecutive failures for each connection.
     *
     * @var array<string,int>  // connectionId => failures
     */
    private array $deliveryFailures = [];

    public function __construct(
        ConnectionRegistryInterface $connectionRegistry,
        SerializerInterface $serializer,
        LoggerInterface $logger,
        MetricCounterInterface $metricCounter
    ) {
        $this->connectionRegistry = $connectionRegistry;
        $this->serializer         = $serializer;
        $this->logger             = $logger;
        $this->metricCounter      = $metricCounter;
    }

    /**
     * Receives an update from any observed subject.
     *
     * @throws \RuntimeException When the subject is not the expected type
     */
    public function update(SplSubject $subject): void
    {
        if (!$subject instanceof RealtimeUpdatableInterface) {
            $message = sprintf(
                'UpdateObserver can observe only RealtimeUpdatableInterface. `%s` given.',
                get_class($subject)
            );

            $this->logger->error($message);

            throw new \RuntimeException($message);
        }

        // Serialize payload
        $payload   = $subject->getRealtimePayload();
        $topicName = $subject->getRealtimeTopic();

        $encodedPayload = $this->serializer->serialize(
            [
                'topic'   => $topicName,
                'payload' => $payload,
                'ts'      => (new \DateTimeImmutable())->format('c'),
            ],
            'json'
        );

        $this->dispatchToConnections($topicName, $encodedPayload);
    }

    /**
     * Iterates through all active WebSocket connections that are subscribed
     * to the topic and pushes the update.
     */
    private function dispatchToConnections(string $topic, string $message): void
    {
        $connections = $this->connectionRegistry->connectionsForTopic($topic);

        foreach ($connections as $connection) {
            try {
                $connection->send($message);

                // Reset failure count upon success
                unset($this->deliveryFailures[$this->id($connection)]);

                $this->metricCounter->increment('websocket.outgoing_messages');
            } catch (WebSocketDeliveryException | \Throwable $e) {
                $this->handleFailedDelivery($connection, $e);
            }
        }
    }

    /**
     * Handles errors that occurred while sending a message to the client.
     */
    private function handleFailedDelivery(object $connection, \Throwable $e): void
    {
        $connectionId = $this->id($connection);

        $this->deliveryFailures[$connectionId] = ($this->deliveryFailures[$connectionId] ?? 0) + 1;

        $this->logger->warning(
            sprintf(
                'Unable to deliver WebSocket message (attempt %d/%d) to connection `%s`: %s',
                $this->deliveryFailures[$connectionId],
                self::MAX_FAILURES,
                $connectionId,
                $e->getMessage()
            ),
            ['exception' => $e]
        );

        $this->metricCounter->increment('websocket.delivery_failures');

        if ($this->deliveryFailures[$connectionId] >= self::MAX_FAILURES) {
            // Close connection and release resources
            $this->logger->notice(
                sprintf(
                    'Closing WebSocket connection `%s` after exceeding max delivery failures.',
                    $connectionId
                )
            );

            $this->connectionRegistry->close($connection);

            unset($this->deliveryFailures[$connectionId]);

            $this->metricCounter->increment('websocket.connections_closed_due_to_failures');
        }
    }

    /**
     * Resolves an identifier for the connection. The ConnectionRegistry
     * guarantees that each connection object implements __toString() or
     * provides an id() method returning a UUID.
     */
    private function id(object $connection): string
    {
        if (method_exists($connection, 'id')) {
            $id = $connection->id();

            if ($id instanceof UuidInterface) {
                return $id->toString();
            }

            return (string) $id;
        }

        if (method_exists($connection, '__toString')) {
            return (string) $connection;
        }

        // Fallback to spl_object_hash
        return spl_object_hash($connection);
    }
}