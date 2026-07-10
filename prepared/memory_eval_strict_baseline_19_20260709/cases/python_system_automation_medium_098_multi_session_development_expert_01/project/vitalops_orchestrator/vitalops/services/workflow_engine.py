```python
"""
vitalops.services.workflow_engine
---------------------------------

The WorkflowEngine is the beating heart of the VitalOps Orchestrator.  It
executes and tracks declarative “workflows” that automate remediation and
deployment tasks across the hospital’s private cloud.  The engine is fully
asynchronous, event–driven, and integrates with the shared Event-Bus so that
other subsystems (alerting, dashboards, auditors) can observe lifecycle
changes in near-real-time.

Key design goals
~~~~~~~~~~~~~~~~
* Robustness – every exception is caught, logged, and surfaced through events.
* Observability – granular status updates are emitted for HIPAA-compliant
  auditing and troubleshooting.
* Extensibility – new workflow types or custom step-executors can be registered
  at runtime without modifying this module.

Typical workflow lifecycle
~~~~~~~~~~~~~~~~~~~~~~~~~~
1. register_workflow() saves a new WorkflowDefinition in the persistent store.
2. start() transitions a *pending* workflow into *running* state and schedules
   its coroutine on the event-loop.
3. _run_workflow() iterates over the workflow’s steps, delegating each to a
   StepExecutor instance and emitting events (StepStarted, StepFinished, etc.).
4. Completion or failure is persisted and an Event is broadcast.
"""

from __future__ import annotations

import asyncio
import logging
import random
import signal
import sys
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional

# --------------------------------------------------------------------------- #
# Third-party / in-house dependencies.  Imports are wrapped in try/except so
# the module remains importable in isolation (useful for type-checking or unit
# testing without the full project env).  These “stub” symbols should never
# execute in production – they are replaced by the real packages at runtime.
# --------------------------------------------------------------------------- #

try:  # pragma: no cover – provide real types if available
    from vitalops.eventing import EventBus, Event
    from vitalops.models.workflow import (
        WorkflowDefinition,
        WorkflowExecution,
        WorkflowStatus,
        WorkflowStep,
    )
    from vitalops.services.store import WorkflowStore
    from vitalops.services.executors import StepExecutor
except ModuleNotFoundError:  # pragma: no cover – stubs for mypy/pytest
    class Event:  # type: ignore
        """Minimal Event stub used during unit-tests."""

        def __init__(self, name: str, payload: Mapping[str, object] | None = None) -> None:
            self.name = name
            self.payload = payload or {}

    class EventBus:  # type: ignore
        def __init__(self) -> None:
            self._subscribers: MutableMapping[str, List[Callable[[Event], None]]] = {}

        def publish(self, event: Event) -> None:
            for fn in self._subscribers.get(event.name, []):
                fn(event)

        def subscribe(self, event_name: str, callback: Callable[[Event], None]) -> None:
            self._subscribers.setdefault(event_name, []).append(callback)

    class WorkflowStatus:  # type: ignore
        PENDING = "PENDING"
        RUNNING = "RUNNING"
        SUCCEEDED = "SUCCEEDED"
        FAILED = "FAILED"
        CANCELLED = "CANCELLED"
        RETRYING = "RETRYING"

    @dataclass
    class WorkflowStep:  # type: ignore
        name: str
        parameters: Dict[str, object] = field(default_factory=dict)

    @dataclass
    class WorkflowDefinition:  # type: ignore
        workflow_id: uuid.UUID
        name: str
        steps: List[WorkflowStep]
        created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @dataclass
    class WorkflowExecution:  # type: ignore
        definition: WorkflowDefinition
        status: str
        current_step_index: int = 0
        started_at: Optional[datetime] = None
        finished_at: Optional[datetime] = None
        last_error: Optional[str] = None

    class WorkflowStore:  # type: ignore
        """In-memory fallback store."""

        def __init__(self) -> None:
            self._definitions: Dict[uuid.UUID, WorkflowDefinition] = {}
            self._executions: Dict[uuid.UUID, WorkflowExecution] = {}

        # Definition I/O
        async def save_definition(self, definition: WorkflowDefinition) -> None:
            self._definitions[definition.workflow_id] = definition

        async def get_definition(self, workflow_id: uuid.UUID) -> WorkflowDefinition:
            return self._definitions[workflow_id]

        # Execution I/O
        async def save_execution(self, execution: WorkflowExecution) -> None:
            self._executions[execution.definition.workflow_id] = execution

        async def get_execution(self, workflow_id: uuid.UUID) -> WorkflowExecution:
            return self._executions[workflow_id]

    class StepExecutor:  # type: ignore
        """Very naive step executor."""

        def __init__(self, step: WorkflowStep) -> None:
            self.step = step

        async def execute(self) -> None:  # noqa: D401
            await asyncio.sleep(random.uniform(0.05, 0.25))


# --------------------------------------------------------------------------- #
# Logger configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
if not logger.handlers:
    # Attach default handler if library user hasn’t configured logging
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s | %(levelname)5s | %(name)s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


class WorkflowEngine:
    """
    Coordinate the lifecycle of WorkflowExecutions.

    The engine can be run as a long-lived service (tied to an asyncio event-loop)
    or instantiated ad-hoc in synchronous code via .run_sync().
    """

    _DEFAULT_RETRY_LIMIT = 3
    _RETRY_BACKOFF_BASE_SECONDS = 2.0

    def __init__(
        self,
        *,
        event_bus: EventBus,
        store: WorkflowStore,
        executor_factory: Callable[[WorkflowStep], StepExecutor] | None = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._event_bus = event_bus
        self._store = store
        self._loop = loop or asyncio.get_event_loop()

        # Factory is DI-friendly; default implementation instantiates StepExecutor
        self._executor_factory = executor_factory or (lambda step: StepExecutor(step))

        # running_tasks[workflow_id] -> asyncio.Task
        self._running_tasks: Dict[uuid.UUID, asyncio.Task[None]] = {}

        # Graceful shutdown flag toggled by signal handler
        self._shutting_down = asyncio.Event()

        # Handle SIGTERM/SIGINT so k8s and sysd bring-down flows cancel politely
        self._install_signal_handlers()

    # --------------------------------------------------------------------- #
    # Public methods
    # --------------------------------------------------------------------- #

    async def register_workflow(self, definition: WorkflowDefinition) -> None:
        """Persist a new WorkflowDefinition so it can be scheduled later."""
        await self._store.save_definition(definition)
        logger.info("Registered workflow %s – %s", definition.workflow_id, definition.name)
        self._event_bus.publish(Event("WorkflowRegistered", {"workflow_id": str(definition.workflow_id)}))

    async def start(self, workflow_id: uuid.UUID) -> None:
        """
        Start (or resume) execution of the workflow identified by *workflow_id*.

        Raises
        ------
        RuntimeError
            If the workflow is already running.
        """
        if workflow_id in self._running_tasks:
            raise RuntimeError(f"Workflow {workflow_id} is already running")

        definition = await self._store.get_definition(workflow_id)
        execution = WorkflowExecution(
            definition=definition,
            status=WorkflowStatus.PENDING,
            current_step_index=0,
        )
        await self._store.save_execution(execution)

        task = self._loop.create_task(self._run_workflow(execution), name=f"workflow:{workflow_id}")
        self._running_tasks[workflow_id] = task
        task.add_done_callback(self._handle_task_completion)

        logger.info("Workflow %s started", workflow_id)

    async def cancel(self, workflow_id: uuid.UUID) -> None:
        """Request cancellation of a running workflow."""
        task = self._running_tasks.get(workflow_id)
        if task is None:
            logger.warning("Attempted to cancel non-running workflow %s", workflow_id)
            return

        logger.info("Cancelling workflow %s …", workflow_id)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task  # ensure cancellation is propagated / awaited

    async def shutdown(self) -> None:
        """
        Gracefully shutdown the engine.

        Any running workflows are cancelled and awaited.  Can be called from
        callback contexts (e.g., signal handler) or from normal control flow.
        """
        logger.info("WorkflowEngine shutting down (active=%d)…", len(self._running_tasks))
        self._shutting_down.set()

        # Cancel any running tasks
        for workflow_id, task in list(self._running_tasks.items()):
            logger.debug("Cancelling task for workflow %s", workflow_id)
            task.cancel()

        # Await their completion
        if self._running_tasks:
            await asyncio.gather(*self._running_tasks.values(), return_exceptions=True)

        logger.info("WorkflowEngine shutdown complete")

    # --------------------------------------------------------------------- #
    # Private helpers
    # --------------------------------------------------------------------- #

    async def _run_workflow(self, execution: WorkflowExecution) -> None:
        workflow_id = execution.definition.workflow_id
        self._event_bus.publish(
            Event(
                "WorkflowStarted",
                payload={"workflow_id": str(workflow_id), "name": execution.definition.name},
            )
        )

        # Transition → RUNNING
        execution.status = WorkflowStatus.RUNNING
        execution.started_at = datetime.now(timezone.utc)
        await self._store.save_execution(execution)

        for idx, step in enumerate(execution.definition.steps):
            # If cancel signal was triggered during previous await:
            if self._shutting_down.is_set():
                logger.info("Engine shutdown requested – aborting workflow %s", workflow_id)
                raise asyncio.CancelledError()

            execution.current_step_index = idx
            retry_count = 0

            while retry_count <= self._DEFAULT_RETRY_LIMIT:
                try:
                    await self._execute_step(workflow_id, step, idx)
                    break  # success → next step
                except asyncio.CancelledError:
                    # Bubble up – respecting cooperative cancellation
                    raise
                except Exception as exc:  # noqa: BLE001
                    retry_count += 1
                    logger.exception(
                        "Step %s (attempt %d/%d) failed for workflow %s",
                        step.name,
                        retry_count,
                        self._DEFAULT_RETRY_LIMIT,
                        workflow_id,
                    )

                    # Persist RETRYING status
                    execution.status = WorkflowStatus.RETRYING
                    execution.last_error = str(exc)
                    await self._store.save_execution(execution)

                    if retry_count > self._DEFAULT_RETRY_LIMIT:
                        execution.status = WorkflowStatus.FAILED
                        execution.finished_at = datetime.now(timezone.utc)
                        await self._store.save_execution(execution)
                        self._event_bus.publish(
                            Event(
                                "WorkflowFailed",
                                {
                                    "workflow_id": str(workflow_id),
                                    "step": step.name,
                                    "error": str(exc),
                                },
                            )
                        )
                        logger.error("Workflow %s failed – giving up", workflow_id)
                        return

                    # Exponential backoff with jitter
                    backoff = self._RETRY_BACKOFF_BASE_SECONDS * 2 ** (retry_count - 1)
                    backoff *= random.uniform(0.75, 1.25)
                    await asyncio.sleep(backoff)

        # SUCCESS
        execution.status = WorkflowStatus.SUCCEEDED
        execution.finished_at = datetime.now(timezone.utc)
        await self._store.save_execution(execution)
        self._event_bus.publish(Event("WorkflowSucceeded", {"workflow_id": str(workflow_id)}))
        logger.info("Workflow %s finished successfully", workflow_id)

    async def _execute_step(self, workflow_id: uuid.UUID, step: WorkflowStep, step_index: int) -> None:
        """Helper that delegates the work to a StepExecutor instance."""
        self._event_bus.publish(
            Event(
                "StepStarted",
                payload={
                    "workflow_id": str(workflow_id),
                    "step_index": step_index,
                    "step_name": step.name,
                },
            )
        )

        start_time = time.perf_counter()
        executor = self._executor_factory(step)
        await executor.execute()
        elapsed = time.perf_counter() - start_time

        self._event_bus.publish(
            Event(
                "StepFinished",
                payload={
                    "workflow_id": str(workflow_id),
                    "step_index": step_index,
                    "step_name": step.name,
                    "elapsed_seconds": elapsed,
                },
            )
        )
        logger.debug(
            "Workflow %s – step %d (%s) completed in %.3fs",
            workflow_id,
            step_index,
            step.name,
            elapsed,
        )

    def _handle_task_completion(self, task: "asyncio.Task[None]") -> None:
        """
        Callback registered on every workflow task.

        Removes the task from the _running_tasks registry and logs unhandled
        exceptions (if any).
        """
        workflow_id = uuid.UUID(task.get_name().split(":", 1)[1])
        self._running_tasks.pop(workflow_id, None)

        with suppress(asyncio.CancelledError):
            err = task.exception()  # noqa: PERF203 – intentionally outside “if task.done()”
            if err:
                logger.error(
                    "Workflow %s terminated with exception: %s: %s",
                    workflow_id,
                    err.__class__.__name__,
                    err,
                )
            else:
                logger.debug("Workflow %s task completed normally", workflow_id)

    # ------------------------------------------------------------------ #
    # Signal handling
    # ------------------------------------------------------------------ #

    def _install_signal_handlers(self) -> None:
        """Hook SIGINT/SIGTERM to initiate async shutdown."""

        def _handler(signame: str) -> None:  # noqa: D401
            logger.warning("Received %s – initiating graceful shutdown …", signame)
            self._loop.create_task(self.shutdown())

        for sig in (signal.SIGINT, signal.SIGTERM):
            with suppress(NotImplementedError):
                self._loop.add_signal_handler(sig, lambda s=sig: _handler(sig.name))

    # ------------------------------------------------------------------ #
    # Convenience synchronous wrapper
    # ------------------------------------------------------------------ #

    def run_sync(self, coro: Awaitable[None]) -> None:
        """
        Execute an async coroutine in a fresh event-loop.

        Meant for “one-off” CLI invocations such as:
        >>> WorkflowEngine(...).run_sync(engine.start(workflow_id))
        """
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro)
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()


# --------------------------------------------------------------------------- #
# Usage example (only executed if run as a script – *never* in production)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    async def _demo() -> None:
        bus = EventBus()
        store = WorkflowStore()
        engine = WorkflowEngine(event_bus=bus, store=store)

        # Subscribe to all events so we can watch them scroll by
        bus.subscribe("*", lambda e: print(f"EVENT » {e.name} {e.payload}"))  # type: ignore[arg-type]

        # Create a simple workflow with three no-op steps
        definition = WorkflowDefinition(
            workflow_id=uuid.uuid4(),
            name="demo-workflow",
            steps=[WorkflowStep(name=f"step-{i}") for i in range(3)],
        )
        await engine.register_workflow(definition)
        await engine.start(definition.workflow_id)

        # Wait for completion
        await asyncio.sleep(2)
        await engine.shutdown()

    logging.basicConfig(level=logging.DEBUG)
    asyncio.run(_demo())
```