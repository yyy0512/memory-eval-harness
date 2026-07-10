```python
"""
vitalops_orchestrator.vitalops.core.eventing
===========================================

Core event-driven plumbing for the VitalOps Orchestrator.

This module provides:

* A lightweight, asyncio-compatible EventBus for intra-process messaging
* Pluggable middleware (Chain-of-Responsibility) applied around every event
* Subscription management implementing the Observer pattern
* HIPAA-compliant audit logging, correlation-id propagation, and basic metrics

It is intentionally framework-agnostic so that ViewModels, CLIs, and sidecar
controllers can all rely on the exact same eventing semantics.

Author: VitalOps Engineering
"""

from __future__ import annotations

import asyncio
import contextvars
import datetime as _dt
import inspect
import logging
import sys
import types
import uuid
from dataclasses import dataclass, field
from heapq import heappush, heappop
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Sequence,
    Tuple,
    Type,
    Union,
)

logger = logging.getLogger("vitalops.eventing")
logger.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
#                       Correlation / Trace Context                           #
# --------------------------------------------------------------------------- #

_correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "correlation_id", default=""
)
_causation_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "causation_id", default=""
)


def current_correlation_id() -> str:
    """Return the correlation-id of the currently executing event (if any)."""
    return _correlation_id.get()


def current_causation_id() -> str:
    """Return the causation-id (parent event id) if available."""
    return _causation_id.get()


# --------------------------------------------------------------------------- #
#                                 Event Model                                 #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class BaseEvent:
    """Domain-agnostic envelope shared by all events."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    occurred_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.utcnow().replace(tzinfo=_dt.timezone.utc)
    )
    correlation_id: str = field(default_factory=current_correlation_id)
    causation_id: str = field(default_factory=current_causation_id)
    source: str = "vitalops"  # e.g., 'performance-coordinator', 'ui', etc.

    @property
    def event_type(self) -> str:
        return type(self).__name__


EventHandler = Callable[[BaseEvent], Union[Awaitable[None], None]]


class Middleware(Protocol):
    """Chain-of-responsibility hook executed around every event."""

    async def before_dispatch(self, event: BaseEvent) -> None:  # noqa: D401
        """Executed before handlers are invoked."""
        ...

    async def after_dispatch(self, event: BaseEvent) -> None:
        """Executed after all handlers have completed."""
        ...

    async def on_error(self, event: BaseEvent, exc: BaseException) -> None:
        """Executed if a handler raises an exception."""
        ...


# --------------------------------------------------------------------------- #
#                            Subscription Management                          #
# --------------------------------------------------------------------------- #


class _Subscription:
    """
    Disposable subscription token returned to callers of EventBus.subscribe().
    """

    __slots__ = ("event_type", "handler", "predicate", "priority")

    def __init__(
        self,
        event_type: Type[BaseEvent],
        handler: EventHandler,
        predicate: Optional[Callable[[BaseEvent], bool]],
        priority: int,
    ) -> None:
        self.event_type = event_type
        self.handler = handler
        self.predicate = predicate
        self.priority = priority

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<Subscription {self.handler.__qualname__} "
            f"for {self.event_type.__name__}>"
        )


# --------------------------------------------------------------------------- #
#                                Event Bus                                    #
# --------------------------------------------------------------------------- #


class EventBus:
    """
    In-process Pub/Sub hub that supports:

    * asyncio coroutine & sync function handlers
    * Prioritized, predicate-filtered subscriptions
    * Middleware pipeline (before/after/on_error)
    * Automatic propagation of correlation/causation ids
    """

    def __init__(self, *, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        self._loop = loop or asyncio.get_event_loop()
        self._subscriptions: Dict[Type[BaseEvent], List[Tuple[int, int, _Subscription]]] = (  # noqa: E501
            {}
        )
        self._middlewares: List[Middleware] = []
        self._counter = 0  # ensures FIFO ordering for same priority

    # --------------------------------------------------------------------- #
    #                        Subscription APIs                               #
    # --------------------------------------------------------------------- #

    def subscribe(
        self,
        event_type: Type[BaseEvent],
        handler: EventHandler,
        *,
        predicate: Optional[Callable[[BaseEvent], bool]] = None,
        priority: int = 0,
    ) -> _Subscription:
        """
        Register a handler for `event_type`.

        Args:
            event_type:  Specific subclass of BaseEvent.
            handler:     Callable receiving the event.
            predicate:   Optional boolean filter executed before handler.
            priority:    Lower number == higher priority (processed first).
        """
        if not inspect.iscoroutinefunction(handler) and not callable(handler):
            raise TypeError(
                "handler must be an async or sync callable (function/method)"
            )

        sub = _Subscription(event_type, handler, predicate, priority)
        bucket = self._subscriptions.setdefault(event_type, [])
        # Use a heap queue for efficient priority retrieval.
        heappush(bucket, (priority, self._counter, sub))
        self._counter += 1
        logger.debug(
            "Subscribed %s to %s (priority=%d)", handler.__qualname__, event_type, priority
        )
        return sub

    def unsubscribe(self, subscription: _Subscription) -> None:
        """Remove a previously registered subscription."""
        bucket = self._subscriptions.get(subscription.event_type)
        if not bucket:
            return
        try:
            bucket.remove((subscription.priority, 0, subscription))  # type: ignore[arg-type]  # noqa: E501
            # Re-heapify after removal.
            heap = []
            for prio, idx, sub in bucket:
                heappush(heap, (prio, idx, sub))
            self._subscriptions[subscription.event_type] = heap
            logger.debug("Unsubscribed %s", subscription)
        except ValueError:
            logger.debug("Unsubscribe called on unknown subscription: %s", subscription)

    # --------------------------------------------------------------------- #
    #                          Middleware APIs                               #
    # --------------------------------------------------------------------- #

    def add_middleware(self, middleware: Middleware) -> None:
        self._middlewares.append(middleware)
        logger.debug("Middleware added: %s", middleware.__class__.__name__)

    # --------------------------------------------------------------------- #
    #                              Publishing                               #
    # --------------------------------------------------------------------- #

    async def publish(self, event: BaseEvent) -> None:
        """
        Dispatch event to all interested handlers.

        This method must be awaited.  A convenience `emit` wrapper is provided
        for fire-and-forget semantics.
        """
        event.correlation_id or _correlation_id.set(str(uuid.uuid4()))
        _causation_id.set(event.id)  # subsequent events are children of this one

        await self._run_middlewares("before_dispatch", event)
        errors: List[BaseException] = []

        for sub in self._iter_subscriptions_for(event):
            if sub.predicate and not sub.predicate(event):
                continue
            try:
                result = sub.handler(event)
                if inspect.isawaitable(result):
                    await result
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
                await self._run_middlewares("on_error", event, exc)
                # Continue dispatching but log.
                logger.exception(
                    "Error in event handler %s for %s: %s",
                    sub.handler.__qualname__,
                    event.event_type,
                    exc,
                )

        await self._run_middlewares("after_dispatch", event)

        # Fail fast by re-raising first exception (maintains stack trace).
        if errors:
            raise errors[0]

    def emit(self, event: BaseEvent) -> None:
        """
        Fire-and-forget helper; schedules :py:meth:`publish` with `asyncio.create_task`.

        Any unhandled exceptions inside handlers are captured and logged.
        """
        async def _safe_publish() -> None:
            try:
                await self.publish(event)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Unhandled exception during publish: %s", exc)

        self._loop.create_task(_safe_publish())

    # --------------------------------------------------------------------- #
    #                           Internal Helpers                             #
    # --------------------------------------------------------------------- #

    async def _run_middlewares(
        self,
        method: str,
        event: BaseEvent,
        exc: Optional[BaseException] = None,
    ) -> None:
        """Execute middleware method (`before_dispatch`, etc.)."""
        for mw in self._middlewares:
            cb: Optional[Callable[..., Awaitable[None]]] = getattr(mw, method, None)
            if cb is None:
                continue
            try:
                if exc is None:
                    await cb(event)  # type: ignore[arg-type]
                else:
                    await cb(event, exc)  # type: ignore[arg-type]
            except Exception:  # pragma: no cover
                logger.exception(
                    "Middleware %s.%s failed", mw.__class__.__name__, method
                )

    def _iter_subscriptions_for(
        self, event: BaseEvent
    ) -> Iterable[_Subscription]:
        """Yield subscriptions for the concrete type (no polymorphic lookup)."""
        bucket = self._subscriptions.get(type(event), [])
        # Iterate in priority order (heap guarantees ascending sort).
        for _, _, sub in sorted(bucket):
            yield sub


# --------------------------------------------------------------------------- #
#                         Default Middleware Implementations                  #
# --------------------------------------------------------------------------- #


class AuditMiddleware:
    """
    HIPAA-compliant audit logger that records minimal PHI-free metadata.

    Production deployment would forward these records to a SECURE,
    immutable log store such as AWS QLDB or Hashicorp Vault.
    """

    async def before_dispatch(self, event: BaseEvent) -> None:
        logger.info(
            "AUDIT-LOG | event=%s | id=%s | correlation=%s | time=%s",
            event.event_type,
            event.id,
            event.correlation_id,
            event.occurred_at.isoformat(),
        )


class MetricsMiddleware:
    """Simple in-memory Prometheus-style counter for event frequency."""

    _counter: Dict[str, int] = {}

    async def after_dispatch(self, event: BaseEvent) -> None:
        self._counter[event.event_type] = self._counter.get(event.event_type, 0) + 1

    @classmethod
    def snapshot(cls) -> Dict[str, int]:
        return dict(cls._counter)


# --------------------------------------------------------------------------- #
#                             Convenience Helpers                             #
# --------------------------------------------------------------------------- #

_default_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """Return a process-global EventBus (lazy-loaded singleton)."""
    global _default_bus
    if _default_bus is None:
        _default_bus = EventBus()
        _default_bus.add_middleware(AuditMiddleware())
        _default_bus.add_middleware(MetricsMiddleware())
    return _default_bus


def subscribe(
    event_type: Type[BaseEvent],
    handler: EventHandler,
    *,
    predicate: Optional[Callable[[BaseEvent], bool]] = None,
    priority: int = 0,
) -> _Subscription:
    """
    Convenience wrapper that registers a handler on the global EventBus.
    """
    return get_event_bus().subscribe(
        event_type, handler, predicate=predicate, priority=priority
    )


def publish(event: BaseEvent) -> None:
    """Emit an event via the global EventBus (fire-and-forget)."""
    get_event_bus().emit(event)


# --------------------------------------------------------------------------- #
#                            Example Event Types                              #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PacsLatencyAlert(BaseEvent):
    """Domain event emitted when PACS latency breaches SLA."""

    hostname: str = ""
    latency_ms: float = 0.0
    threshold_ms: float = 0.0


@dataclass(frozen=True, slots=True)
class SepsisPredictionServiceDegraded(BaseEvent):
    """Domain event indicating that the sepsis prediction micro-service is unhealthy."""

    container_id: str = ""
    error_rate: float = 0.0


# --------------------------------------------------------------------------- #
#                            Self-Test / Demo                                 #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        stream=sys.stderr,
    )

    bus = get_event_bus()

    async def handle_pacs(alert: PacsLatencyAlert) -> None:
        print(
            f"[HANDLER] PACS latency {alert.latency_ms} ms "
            f"(threshold {alert.threshold_ms} ms) on {alert.hostname}"
        )

    subscribe(PacsLatencyAlert, handle_pacs)

    # Simulate an asynchronous event flow.
    async def _demo() -> None:
        publish(
            PacsLatencyAlert(
                hostname="radiology-svc-01", latency_ms=2100, threshold_ms=1500
            )
        )
        await asyncio.sleep(0.1)  # give fire-and-forget tasks time to run
        print("Metrics snapshot:", MetricsMiddleware.snapshot())

    asyncio.run(_demo())
```