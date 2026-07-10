```python
"""
vitalops_orchestrator.vitalops.coordinators.recovery
===================================================

Implements the RecoveryCoordinator responsible for orchestrating
backup and disaster-recovery workflows when clinical micro-services
become unhealthy or when a scheduled maintenance window begins.

The coordinator subscribes to the central event-bus, evaluates incoming
alerts against compliance policies, and dispatches the appropriate
recovery strategy (e.g., container restart, data-snapshot restore,
or full blue/green service fail-over).

This module purposefully *does not* implement concrete recovery
strategies—those live inside the `vitalops.executors.*` namespace.
Instead, it coordinates them and provides robust bookkeeping,
auditing, and fault-tolerance around their execution so that the rest
of the system can remain declarative and policy-driven.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Set,
)

###############################################################################
# Interfaces – loosely-coupled contracts to decouple the coordinator from
# concrete infrastructure or domain logic.  Only the *protocols* are defined
# here so the orchestrator can import this file without circular dependencies.
###############################################################################


class Event(Protocol):
    """A basic application-level event that circulates on the event bus."""

    @property
    def name(self) -> str: ...

    @property
    def payload(self) -> Dict[str, Any]: ...

    @property
    def timestamp(self) -> datetime: ...


class EventBus(Protocol):
    """Subset of functionality required by the coordinator."""

    def subscribe(self, topic: str, handler: Callable[[Event], Awaitable[None]]) -> None: ...

    def publish(self, topic: str, event: Event) -> None: ...


class RecoveryExecutor(Protocol):
    """
    Executes a specific recovery strategy.  Executors *must* be idempotent
    and re-entrant because the coordinator may invoke them multiple times
    if duplicate alerts surface while a workflow is already in progress.
    """

    async def execute(self, context: "RecoveryContext") -> None: ...


class AuditLogger(Protocol):
    """HIPAA-compliant audit logger."""

    def info(self, message: str, **kwargs: Any) -> None: ...

    def error(self, message: str, **kwargs: Any) -> None: ...

    def critical(self, message: str, **kwargs: Any) -> None: ...


class ServiceRegistry(Protocol):
    """Service discovery and metadata registry."""

    def resolve_executor(self, service_name: str, strategy: "RecoveryStrategy") -> RecoveryExecutor: ...


###############################################################################
# Coordinator Implementation
###############################################################################


class RecoveryStrategy(str, Enum):
    """Enumeration of high-level recovery strategies."""

    RESTART_CONTAINERS = "restart_containers"
    RESTORE_SNAPSHOT = "restore_snapshot"
    FAILOVER = "failover"


@dataclass(frozen=True)
class RecoveryContext:
    """
    Bundles all relevant metadata for a single recovery workflow so the
    executor has a rich, immutable context to operate upon.
    """

    workflow_id: str
    service_name: str
    strategy: RecoveryStrategy
    triggering_event: Event
    hospital_id: str
    sla_deadline: datetime
    metadata: Dict[str, Any] = field(default_factory=dict)


class RecoveryCoordinator:
    """
    The central coordinator for backup and recovery workflows.
    Subscribes to orchestrator events and delegates work to strategy-specific
    executors obtained from the service-registry.
    """

    # Guard against execution storms
    _DUPLICATE_WINDOW: timedelta = timedelta(seconds=120)

    def __init__(
        self,
        *,
        event_bus: EventBus,
        service_registry: ServiceRegistry,
        audit_logger: AuditLogger,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._event_bus = event_bus
        self._service_registry = service_registry
        self._audit_logger = audit_logger
        self._loop = loop or asyncio.get_event_loop()

        # Track workflows already in progress (per service & strategy)
        self._in_flight: MutableMapping[str, Set[RecoveryStrategy]] = defaultdict(set)
        # Track recently completed workflows to avoid duplication
        self._recent_workflows: MutableMapping[str, datetime] = {}

        # Subscribe to event topics of interest
        for topic in (
            "SERVICE_CRITICAL",
            "SCHEDULED_BACKUP_WINDOW",
            "AUTOMATED_FAILOVER_TRIGGERED",
        ):
            self._event_bus.subscribe(topic, self._handle_event)

        self._audit_logger.info(
            "RecoveryCoordinator initialized and event subscriptions registered"
        )

    # --------------------------------------------------------------------- #
    # Event Handling
    # --------------------------------------------------------------------- #

    async def _handle_event(self, event: Event) -> None:
        """
        Central event handler that inspects an event and decides whether a
        recovery workflow must be orchestrated.
        """
        self._audit_logger.info(
            "RecoveryCoordinator received event",
            event_name=event.name,
            timestamp=str(event.timestamp),
        )

        try:
            service_name: str = event.payload["service_name"]
            hospital_id: str = event.payload["hospital_id"]
        except KeyError as exc:
            self._audit_logger.error(
                "Non-conforming event received; missing attribute",
                missing=str(exc),
                raw_event=event.payload,
            )
            return

        strategy = self._map_event_to_strategy(event_name=event.name)

        if strategy is None:
            # Not a recoverable event
            return

        ctx = self._build_context(
            service_name=service_name,
            hospital_id=hospital_id,
            strategy=strategy,
            triggering_event=event,
        )

        # Debounce duplicate workflows
        if not self._can_dispatch(ctx):
            self._audit_logger.info(
                "Duplicate recovery suppressed",
                workflow_id=ctx.workflow_id,
                service=ctx.service_name,
                strategy=ctx.strategy.value,
            )
            return

        await self._dispatch(ctx)

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _map_event_to_strategy(self, *, event_name: str) -> Optional[RecoveryStrategy]:
        """Maps event names to high-level recovery strategies."""
        if event_name == "SERVICE_CRITICAL":
            return RecoveryStrategy.RESTART_CONTAINERS
        if event_name == "SCHEDULED_BACKUP_WINDOW":
            return RecoveryStrategy.RESTORE_SNAPSHOT
        if event_name == "AUTOMATED_FAILOVER_TRIGGERED":
            return RecoveryStrategy.FAILOVER
        return None

    def _build_context(
        self,
        *,
        service_name: str,
        hospital_id: str,
        strategy: RecoveryStrategy,
        triggering_event: Event,
    ) -> RecoveryContext:
        """Factory for RecoveryContext."""
        workflow_id = str(uuid.uuid4())
        sla_deadline = datetime.utcnow() + timedelta(minutes=15)
        ctx = RecoveryContext(
            workflow_id=workflow_id,
            service_name=service_name,
            strategy=strategy,
            triggering_event=triggering_event,
            hospital_id=hospital_id,
            sla_deadline=sla_deadline,
        )
        return ctx

    def _can_dispatch(self, ctx: RecoveryContext) -> bool:
        """
        Determines whether a workflow for `(service, strategy)` is already in
        flight or has recently completed. Avoids duplicate execution storms.
        """
        key = f"{ctx.service_name}:{ctx.strategy.value}"
        now = datetime.utcnow()

        # Recent completion check
        last_ts = self._recent_workflows.get(key)
        if last_ts and now - last_ts < self._DUPLICATE_WINDOW:
            return False

        # In-flight check
        if ctx.strategy in self._in_flight.get(ctx.service_name, set()):
            return False
        return True

    async def _dispatch(self, ctx: RecoveryContext) -> None:
        """Delegates execution to the concrete recovery executor."""
        self._audit_logger.info(
            "Dispatching recovery workflow",
            workflow_id=ctx.workflow_id,
            service=ctx.service_name,
            strategy=ctx.strategy.value,
        )
        # Mark as in-flight
        self._in_flight[ctx.service_name].add(ctx.strategy)

        executor: RecoveryExecutor
        try:
            executor = self._service_registry.resolve_executor(
                ctx.service_name, ctx.strategy
            )
        except Exception as exc:  # Broad catch because registry is infra-level
            self._audit_logger.error(
                "Could not resolve recovery executor",
                service=ctx.service_name,
                strategy=ctx.strategy.value,
                error=str(exc),
            )
            # Remove in-flight marker so future attempts may retry
            with suppress(KeyError):
                self._in_flight[ctx.service_name].remove(ctx.strategy)
            return

        # Execute the workflow in a background task to keep event-loop responsive
        async def _run_and_record() -> None:
            try:
                await executor.execute(ctx)
            except Exception as exc:
                self._audit_logger.critical(
                    "Recovery workflow failed",
                    workflow_id=ctx.workflow_id,
                    service=ctx.service_name,
                    strategy=ctx.strategy.value,
                    error=str(exc),
                )
            finally:
                # Update bookkeeping
                with suppress(KeyError):
                    self._in_flight[ctx.service_name].remove(ctx.strategy)
                self._recent_workflows[
                    f"{ctx.service_name}:{ctx.strategy.value}"
                ] = datetime.utcnow()
                self._audit_logger.info(
                    "Recovery workflow completed (success or failure)",
                    workflow_id=ctx.workflow_id,
                    service=ctx.service_name,
                    strategy=ctx.strategy.value,
                )

        self._loop.create_task(_run_and_record())


###############################################################################
# Convenience factory – helps avoid long DI wiring in the outer application.
###############################################################################

def create_default_recovery_coordinator(
    *,
    event_bus: EventBus,
    service_registry: ServiceRegistry,
    audit_logger: Optional[AuditLogger] = None,
) -> RecoveryCoordinator:
    """
    Creates a fully-initialized coordinator with sane defaults and robust
    logging.  The factory is intentionally kept at the bottom of the module
    to shield importers from the implementation details above.
    """
    audit_logger = audit_logger or _get_default_audit_logger()
    return RecoveryCoordinator(
        event_bus=event_bus, service_registry=service_registry, audit_logger=audit_logger
    )


def _get_default_audit_logger() -> AuditLogger:
    """
    Returns a structured logger that satisfies the AuditLogger protocol.
    Falls back to Python’s built-in `logging` if no advanced logging
    framework (e.g., structlog or loguru) is available.
    """

    class _StdLibAuditLogger:  # pragma: no cover – trivial wrapper
        def __init__(self) -> None:
            self._log = logging.getLogger("vitalops.audit.recovery")
            handler = logging.StreamHandler()
            formatter = logging.Formatter(
                "%(asctime)s %(levelname)s [%(name)s] %(message)s"
            )
            handler.setFormatter(formatter)
            self._log.addHandler(handler)
            self._log.setLevel(logging.INFO)

        def info(self, message: str, **kwargs: Any) -> None:
            self._log.info(f"{message} | {kwargs}")

        def error(self, message: str, **kwargs: Any) -> None:
            self._log.error(f"{message} | {kwargs}")

        def critical(self, message: str, **kwargs: Any) -> None:
            self._log.critical(f"{message} | {kwargs}")

    return _StdLibAuditLogger()
```