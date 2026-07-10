<?php

declare(strict_types=1);

namespace ProdSecureOrchestrator\Presentation\Controller;

use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\Routing\Annotation\Route;
use ProdSecureOrchestrator\Domain\Alert\Model\Alert;
use ProdSecureOrchestrator\Domain\Alert\Query\AlertQueryInterface;
use ProdSecureOrchestrator\Domain\Alert\Command\AlertCommandInterface;
use ProdSecureOrchestrator\Domain\Remediation\Command\Bus\RemediationCommandBusInterface;
use ProdSecureOrchestrator\Domain\Remediation\Command\RemediateAlertCommand;
use ProdSecureOrchestrator\Domain\Shared\Exception\RecordNotFoundException;
use ProdSecureOrchestrator\Domain\Shared\Exception\ValidationException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * AlertsController
 *
 * Presentation-layer controller responsible for dealing with alert life-cycle
 * activities (query, acknowledge, remediate, stream).  The controller is intentionally
 * kept thin; all heavy lifting is delegated to domain services / command bus.
 *
 * Routes are declared using attribute syntax for modern Symfony versions (5.2+).
 *
 * @author     ProdSecure
 * @copyright  Copyright (c) 2024
 */
#[Route('/api/alerts')]
final class AlertsController
{
    private AlertQueryInterface            $alertQuery;
    private AlertCommandInterface          $alertCommand;
    private RemediationCommandBusInterface $commandBus;
    private LoggerInterface                $logger;

    public function __construct(
        AlertQueryInterface            $alertQuery,
        AlertCommandInterface          $alertCommand,
        RemediationCommandBusInterface $commandBus,
        LoggerInterface                $logger
    ) {
        $this->alertQuery  = $alertQuery;
        $this->alertCommand = $alertCommand;
        $this->commandBus   = $commandBus;
        $this->logger       = $logger;
    }

    /**
     * Returns paginated list of alerts.
     */
    #[Route('', name: 'alerts_list', methods: ['GET'])]
    public function list(Request $request): JsonResponse
    {
        $page    = max(1, (int) $request->query->get('page', 1));
        $limit   = min(100, max(1, (int) $request->query->get('limit', 25)));
        $filters = [
            'severity' => $request->query->get('severity'),
            'status'   => $request->query->get('status'),
            'source'   => $request->query->get('source'),
            'search'   => $request->query->get('q'),
        ];

        $pager = $this->alertQuery->search($filters, $page, $limit);

        return new JsonResponse(
            [
                'data' => array_map(static fn(Alert $a) => $a->toArray(), iterator_to_array($pager)),
                'meta' => [
                    'page'       => $page,
                    'limit'      => $limit,
                    'total'      => $pager->count(),
                    'totalPages' => (int) ceil($pager->count() / $limit),
                    'filters'    => array_filter($filters),
                ],
            ],
            JsonResponse::HTTP_OK
        );
    }

    /**
     * Fetch a single alert by ID.
     */
    #[Route('/{id}', name: 'alerts_show', methods: ['GET'])]
    public function show(string $id): JsonResponse
    {
        try {
            $alert = $this->alertQuery->getById($id);
        } catch (RecordNotFoundException $e) {
            throw new NotFoundHttpException("Alert '{$id}' not found.");
        }

        return new JsonResponse(
            $alert->toArray(verbose: true),
            JsonResponse::HTTP_OK
        );
    }

    /**
     * Acknowledge an alert.
     *
     * POST /api/alerts/{id}/ack
     * Body (JSON):
     * {
     *   "comment": "Investigating...",
     *   "expiresIn": 3600 // seconds, optional
     * }
     */
    #[Route('/{id}/ack', name: 'alerts_ack', methods: ['POST'])]
    public function acknowledge(string $id, Request $request): JsonResponse
    {
        $payload = json_decode($request->getContent(), true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new BadRequestHttpException('Invalid JSON payload.');
        }

        $comment   = $payload['comment'] ?? '';
        $expiresIn = isset($payload['expiresIn']) ? (int) $payload['expiresIn'] : null;

        try {
            $alert = $this->alertCommand->acknowledge(
                alertId: $id,
                userId: (string) $request->getSession()?->get('user_id', 'system'),
                comment: $comment,
                expiresIn: $expiresIn
            );
        } catch (RecordNotFoundException) {
            throw new NotFoundHttpException("Alert '{$id}' not found.");
        } catch (ValidationException $e) {
            throw new UnprocessableEntityHttpException($e->getMessage());
        }

        // Hook for audit logging
        $this->logger->info('Alert acknowledged.', ['alertId' => $id]);

        return new JsonResponse(
            $alert->toArray(verbose: true),
            JsonResponse::HTTP_OK
        );
    }

    /**
     * Kick off a remediation flow for a specific alert using the command bus.
     *
     * POST /api/alerts/{id}/remediate
     * Body (JSON):
     * {
     *   "strategyKey": "auto-patch-vulnerability",
     *   "dryRun": true
     * }
     */
    #[Route('/{id}/remediate', name: 'alerts_remediate', methods: ['POST'])]
    public function remediate(string $id, Request $request): JsonResponse
    {
        $payload = json_decode($request->getContent(), true, flags: JSON_THROW_ON_ERROR);

        $command = new RemediateAlertCommand(
            alertId:      $id,
            strategyKey:  (string) ($payload['strategyKey'] ?? 'auto'),
            userId:       (string) $request->getSession()?->get('user_id', 'system'),
            dryRun:       (bool)   ($payload['dryRun']    ?? false)
        );

        try {
            $jobId = $this->commandBus->dispatch($command);
        } catch (RecordNotFoundException) {
            throw new NotFoundHttpException("Alert '{$id}' not found.");
        } catch (ValidationException $e) {
            throw new UnprocessableEntityHttpException($e->getMessage());
        }

        $this->logger->notice(
            'Remediation command dispatched.',
            ['alertId' => $id, 'remediationJobId' => $jobId]
        );

        return new JsonResponse(
            ['jobId' => $jobId],
            JsonResponse::HTTP_ACCEPTED
        );
    }

    /**
     * Server-Sent Event stream for live alerts feed.
     * Keeps the connection open and pushes events as they occur.
     *
     * NOTE: Production code would employ an event bus (e.g. Redis Pub/Sub, Kafka, Mercure)—
     * this simplified example polls the domain every second.
     */
    #[Route('/stream', name: 'alerts_stream', methods: ['GET'])]
    public function stream(Request $request): StreamedResponse
    {
        $lastEventId = $request->headers->get('Last-Event-ID');

        $response = new StreamedResponse(function () use ($lastEventId) {
            // Recommended: Disable PHP output buffering
            if (function_exists('apache_setenv')) {
                @apache_setenv('no-gzip', '1');
            }
            @ini_set('output_buffering', 'off');
            @ini_set('zlib.output_compression', '0');

            // Send initial retry value so clients know how long to wait before reconnect
            echo "retry: 3000\n";

            $cursor = $lastEventId ? (int) $lastEventId : null;

            while (connection_status() === CONNECTION_NORMAL) {
                $alerts = $this->alertQuery->stream($cursor);

                foreach ($alerts as $alert) {
                    $cursor = $alert->getSequence(); // monotonic sequence number

                    echo "id: {$cursor}\n";
                    echo 'event: alert' . "\n";
                    echo 'data: ' . json_encode($alert->toArray()) . "\n\n";
                }

                // flush output buffers so the client receives the events
                @ob_flush();
                @flush();

                // Simple backoff to keep CPU usage low.  Replace with event-driven pattern in prod.
                sleep(1);
            }
        });

        $response->headers->set('Content-Type', 'text/event-stream');
        $response->headers->set('Cache-Control', 'no-cache, no-store, must-revalidate');
        $response->headers->set('X-Accel-Buffering', 'no'); // Disable buffering on Nginx

        return $response;
    }
}
