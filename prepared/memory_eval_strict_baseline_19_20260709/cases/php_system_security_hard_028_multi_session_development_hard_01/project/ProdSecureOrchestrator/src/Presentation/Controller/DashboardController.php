```php
<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Presentation\Controller;

use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Server\RequestHandlerInterface;
use ProdSecureOrchestrator\Application\Query\Dashboard\GetDashboardSnapshotQuery;
use ProdSecureOrchestrator\Application\Query\QueryBusInterface;
use ProdSecureOrchestrator\Application\Command\Dashboard\TriggerRemediationCommand;
use ProdSecureOrchestrator\Application\Command\CommandBusInterface;
use ProdSecureOrchestrator\Infrastructure\Monitoring\TelemetryInterface;
use ProdSecureOrchestrator\Shared\Exception\DomainException;
use ProdSecureOrchestrator\Shared\ValueObject\Uuid;
use Throwable;

/**
 * DashboardController
 *
 * Exposes read and write endpoints related to the dashboard.  In the MVVM
 * nomenclature this controller acts as the glue between HTTP traffic and
 * the ViewModel layer—delegating reads to the QueryBus (CQRS) and writes
 * to the CommandBus.
 */
final class DashboardController implements RequestHandlerInterface
{
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    public function __construct(
        private readonly QueryBusInterface       $queryBus,
        private readonly CommandBusInterface     $commandBus,
        private readonly ResponseFactoryInterface $responseFactory,
        private readonly TelemetryInterface      $telemetry
    ) {
    }

    /**
     * {@inheritdoc}
     *
     * The controller supports two verbs for the /dashboard endpoint:
     *   GET  - returns a snapshot of aggregated dashboard data
     *   POST - triggers a remediation command for a specific dashboard event
     *
     * Routing is expected to narrow down to this handler only for the
     * /dashboard path.  Further disambiguation happens based on the HTTP verb.
     */
    public function handle(Request $request): ResponseInterface
    {
        try {
            return match ($request->getMethod()) {
                'GET'  => $this->handleSnapshot($request),
                'POST' => $this->handleRemediation($request),
                default => $this->errorResponse(
                    405,
                    sprintf('HTTP method "%s" not allowed.', $request->getMethod())
                ),
            };
        } catch (DomainException $e) {
            $this->telemetry->recordException($e);
            return $this->errorResponse(409, $e->getMessage());
        } catch (Throwable $e) {
            $this->telemetry->recordException($e);
            return $this->errorResponse(500, 'Unexpected server error.');
        }
    }

    /**
     * GET /dashboard
     *
     * Retrieves the real-time snapshot used to render the operator dashboard.
     */
    private function handleSnapshot(Request $request): ResponseInterface
    {
        // Example: optional filter (team, environment, etc.) passed as query param.
        $envFilter = $request->getQueryParams()['environment'] ?? null;

        $snapshotDto = $this->queryBus->ask(
            new GetDashboardSnapshotQuery(
                environment: $envFilter,
                userId: $this->extractUserId($request)
            )
        );

        return $this->jsonResponse(200, $snapshotDto);
    }

    /**
     * POST /dashboard
     *
     * Triggers an automated remediation workflow for a given dashboard event.
     * Expected JSON body:
     *  {
     *      "event_id" : "uuid",
     *      "action"   : "restart_container" | "scale_out" | ...
     *  }
     */
    private function handleRemediation(Request $request): ResponseInterface
    {
        $payload = $this->parseJson($request);

        foreach (['event_id', 'action'] as $required) {
            if (!isset($payload[$required])) {
                return $this->errorResponse(400, sprintf('Missing field "%s".', $required));
            }
        }

        $command = new TriggerRemediationCommand(
            eventId: Uuid::fromString($payload['event_id']),
            action:  $payload['action'],
            userId:  $this->extractUserId($request)
        );

        $this->commandBus->dispatch($command);

        return $this->jsonResponse(
            202,
            [
                'status'     => 'queued',
                'remediation_id' => $command->remediationId()->toString(),
            ]
        );
    }

    // ------------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------------

    /**
     * Generates a JSON response with proper headers.
     */
    private function jsonResponse(int $status, mixed $data): ResponseInterface
    {
        $response = $this->responseFactory->createResponse($status)
            ->withHeader('Content-Type', 'application/json');

        $response->getBody()->write(json_encode($data, self::JSON_FLAGS));

        return $response;
    }

    /**
     * Generates a standardized error response in JSON format.
     */
    private function errorResponse(int $status, string $message): ResponseInterface
    {
        return $this->jsonResponse(
            $status,
            [
                'error'   => true,
                'message' => $message,
            ]
        );
    }

    /**
     * Parses JSON body into an associative array.
     *
     * @throws DomainException when invalid JSON supplied
     */
    private function parseJson(Request $request): array
    {
        $raw = (string) $request->getBody();
        $decoded = json_decode($raw, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new DomainException('Malformed JSON payload.');
        }

        return $decoded ?? [];
    }

    /**
     * Extracts the authenticated user's UUID from the request attributes.
     * In production the middleware pipeline is expected to populate
     * the 'user_id' attribute after token validation.
     */
    private function extractUserId(Request $request): Uuid
    {
        $id = $request->getAttribute('user_id');

        if (!$id instanceof Uuid) {
            throw new DomainException('Unauthenticated request.');
        }

        return $id;
    }
}
```