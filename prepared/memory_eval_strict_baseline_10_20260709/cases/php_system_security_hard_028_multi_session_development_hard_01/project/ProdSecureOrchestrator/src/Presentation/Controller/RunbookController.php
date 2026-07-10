<?php
declare(strict_types=1);

namespace ProdSecureOrchestrator\Presentation\Controller;

use ProdSecureOrchestrator\Application\Command\ExecuteRunbookCommand;
use ProdSecureOrchestrator\Application\Command\ScheduleRunbookCommand;
use ProdSecureOrchestrator\Application\DTO\RunbookFilter;
use ProdSecureOrchestrator\Domain\Exception\RunbookNotFoundException;
use ProdSecureOrchestrator\Domain\Exception\RunbookValidationException;
use ProdSecureOrchestrator\Domain\Model\RunbookId;
use ProdSecureOrchestrator\Domain\Repository\RunbookRepositoryInterface;
use ProdSecureOrchestrator\Infrastructure\Bus\CommandBusInterface;
use ProdSecureOrchestrator\Infrastructure\Http\HttpStatus;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Annotation\Route;
use Symfony\Contracts\Serializer\SerializerInterface;

/**
 * REST-style controller that exposes Runbook-related endpoints.
 *
 * Responsibilities:
 *  • Validate & transform HTTP input
 *  • Delegate business-logic to Application layer (Command/Query)
 *  • Translate domain exceptions to meaningful HTTP responses
 *
 * All routes are prefixed with /api/runbooks (see routing.yaml).
 *
 * Example:
 *   GET    /api/runbooks?search=backup&page=2&limit=10
 *   POST   /api/runbooks/{id}/execute
 *   POST   /api/runbooks/{id}/schedule
 *
 * MVVM note:
 *   This controller only orchestrates. The actual mutable state
 *   lives in ViewModel via WebSockets / SSE.
 */
final class RunbookController
{
    private RunbookRepositoryInterface $runbookRepository;
    private CommandBusInterface        $commandBus;
    private LoggerInterface            $logger;
    private SerializerInterface        $serializer;

    public function __construct(
        RunbookRepositoryInterface $runbookRepository,
        CommandBusInterface        $commandBus,
        LoggerInterface            $logger,
        SerializerInterface        $serializer
    ) {
        $this->runbookRepository = $runbookRepository;
        $this->commandBus        = $commandBus;
        $this->logger            = $logger;
        $this->serializer        = $serializer;
    }

    /**
     * Returns a paginated collection of Runbooks that match search criteria.
     *
     * @Route("/api/runbooks", name="runbook_index", methods={"GET"})
     */
    public function index(Request $request): JsonResponse
    {
        $filter = RunbookFilter::fromHttpQuery($request->query->all());

        $runbooks = $this->runbookRepository->findByFilter($filter);
        $payload  = $this->serializer->normalize($runbooks, 'json', ['groups' => ['runbook:list']]);

        return new JsonResponse($payload, HttpStatus::OK);
    }

    /**
     * Retrieves a specific Runbook by ID.
     *
     * @Route("/api/runbooks/{id}", name="runbook_show", methods={"GET"})
     */
    public function show(string $id): JsonResponse
    {
        try {
            $runbook = $this->runbookRepository->get(RunbookId::fromString($id));
        } catch (RunbookNotFoundException $e) {
            return $this->error($e->getMessage(), HttpStatus::NOT_FOUND);
        }

        $payload = $this->serializer->normalize($runbook, 'json', ['groups' => ['runbook:detail']]);

        return new JsonResponse($payload, HttpStatus::OK);
    }

    /**
     * Immediately executes a Runbook.
     *
     * @Route("/api/runbooks/{id}/execute", name="runbook_execute", methods={"POST"})
     */
    public function execute(string $id, Request $request): JsonResponse
    {
        try {
            $runbookId = RunbookId::fromString($id);
            $command   = new ExecuteRunbookCommand(
                $runbookId,
                $request->request->all() // runtime parameters
            );

            $executionId = $this->commandBus->dispatch($command);
        } catch (RunbookNotFoundException $e) {
            return $this->error($e->getMessage(), HttpStatus::NOT_FOUND);
        } catch (RunbookValidationException $e) {
            return $this->error($e->getMessage(), HttpStatus::BAD_REQUEST, $e->getErrors());
        } catch (\Throwable $e) {
            $this->logger->error('Runbook execution failed', ['id' => $id, 'exception' => $e]);

            return $this->error('Unable to execute runbook at this time.', HttpStatus::INTERNAL_SERVER_ERROR);
        }

        return new JsonResponse(
            ['message' => 'Runbook execution started', 'executionId' => (string) $executionId],
            HttpStatus::ACCEPTED
        );
    }

    /**
     * Schedules a Runbook for later execution.
     *
     * @Route("/api/runbooks/{id}/schedule", name="runbook_schedule", methods={"POST"})
     */
    public function schedule(string $id, Request $request): JsonResponse
    {
        $scheduleAt = $request->request->get('schedule_at'); // ISO-8601 string

        try {
            $runbookId = RunbookId::fromString($id);
            $command   = new ScheduleRunbookCommand($runbookId, new \DateTimeImmutable($scheduleAt));

            $scheduleId = $this->commandBus->dispatch($command);
        } catch (\Exception $e) {
            return $this->error($e->getMessage(), HttpStatus::BAD_REQUEST);
        }

        return new JsonResponse(
            ['message' => 'Runbook scheduled', 'scheduleId' => (string) $scheduleId],
            HttpStatus::CREATED
        );
    }

    // -----------------------------------------------
    // Internal helpers
    // -----------------------------------------------

    /**
     * Creates a standardized error JSON response.
     *
     * @param array<string, mixed>|null $meta
     */
    private function error(string $message, int $status, ?array $meta = null): JsonResponse
    {
        $payload = ['error' => $message];

        if ($meta !== null) {
            $payload['meta'] = $meta;
        }

        return new JsonResponse($payload, $status);
    }
}
