```python
"""
QuestSmith – Productivity RPG Forge
-----------------------------------

module_38.py
~~~~~~~~~~~~
Centralized Observer-based event bus that propagates domain events
(e.g. quest status changes, auth events) to interested subscribers.
Implements:

    • EventType        – Strongly-typed list of domain events
    • Event            – Immutable event value object
    • EventObserver    – Protocol describing observer contract
    • CrashReporter    – Abstract integration point for crash reporting
    • EventBus         – Thread-safe, weak-referenced pub/sub hub
    • subscribe()      – Convenience decorator for functional observers

The implementation is intentionally framework-agnostic and can be used
from Kivy view-models, repositories, or adapters alike.

Patterns Demonstrated:
    Repository Pattern   – Decouples persistence from models (used elsewhere)
    Observer  Pattern    – Publish/subscribe via EventBus
    Factory   Pattern    – CrashReporter factory injection
"""

from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
import weakref
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum, auto
from types import TracebackType
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Set,
    Tuple,
)

__all__ = [
    "EventType",
    "Event",
    "EventObserver",
    "CrashReporter",
    "NullCrashReporter",
    "EventBus",
    "subscribe",
]

_LOGGER = logging.getLogger("questsmith.eventbus")
_LOGGER.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
# Event Definitions
# --------------------------------------------------------------------------- #
class EventType(Enum):
    """Enumerates every domain event emitted by the core game engine."""

    # Quest lifecycle
    QUEST_CREATED = auto()
    QUEST_UPDATED = auto()
    QUEST_COMPLETED = auto()
    QUEST_FAILED = auto()
    QUEST_EXPIRED = auto()

    # User authentication
    USER_AUTHENTICATED = auto()
    USER_LOGGED_OUT = auto()

    # Social & competitive
    FRIEND_SCORE_SURPASSED = auto()
    LEADERBOARD_UPDATED = auto()

    # Application state
    APP_RESUMED = auto()
    APP_PAUSED = auto()
    APP_TERMINATING = auto()

    # Analytics
    DIFFICULTY_ADJUSTED = auto()


@dataclass(frozen=True, slots=True)
class Event:
    """
    Value object representing an event raised by the game logic.

    Attributes
    ----------
    id : str
        Globally unique identifier for tracing.
    type : EventType
        The event's semantic type.
    payload : Dict[str, Any]
        Arbitrary metadata describing the event context.
    timestamp : float
        Seconds since epoch. Auto-populated if omitted.
    """

    type: EventType
    payload: Dict[str, Any]
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)

    def __post_init__(self) -> None:  # noqa: D401
        # Ensure payload is immutable-ish at runtime to discourage mutation.
        object.__setattr__(self, "payload", dict(self.payload))


# --------------------------------------------------------------------------- #
# Observer Contract
# --------------------------------------------------------------------------- #
class EventObserver(Protocol):
    """Contract that observers must fulfil."""

    def on_event(self, event: Event) -> None:  # noqa: D401
        """Handle an event published by the EventBus."""
        ...


# --------------------------------------------------------------------------- #
# Crash-reporting abstraction
# --------------------------------------------------------------------------- #
class CrashReporter(ABC):
    """Abstract crash reporter injected via factory to avoid hard dependency."""

    @abstractmethod
    def report_exception(
        self,
        exc_type: type[BaseException],
        exc_value: BaseException,
        tb: Optional[TracebackType],
        context: Optional[dict] = None,
    ) -> None:  # pragma: no cover
        """Persist a captured exception to an external service."""


class NullCrashReporter(CrashReporter):
    """No-op crash reporter used when none is configured."""

    def report_exception(
        self,
        exc_type: type[BaseException],
        exc_value: BaseException,
        tb: Optional[TracebackType],
        context: Optional[dict] = None,
    ) -> None:
        _LOGGER.debug("Skipping crash-report, NullCrashReporter active.", exc_info=False)


# --------------------------------------------------------------------------- #
# EventBus
# --------------------------------------------------------------------------- #
class EventBus:
    """
    Thread-safe publish/subscribe hub.

    Features
    --------
    • Non-blocking – Dispatches on background thread.
    • Weak refs    – Prevents memory leaks when views are destroyed.
    • Safe         – Exceptions caught and delegated to CrashReporter.
    """

    _instance: Optional["EventBus"] = None
    _singleton_lock = threading.Lock()

    def __init__(
        self,
        crash_reporter: Optional[CrashReporter] = None,
        queue_size: int = 2048,
        name: str = "questsmith.eventbus",
    ) -> None:
        self._name = name
        self._subscribers: MutableMapping[
            EventType, Set[weakref.ReferenceType[EventObserver]]
        ] = {}
        self._queue: "queue.Queue[Event]" = queue.Queue(maxsize=queue_size)
        self._dispatcher = threading.Thread(
            target=self._dispatch_loop,
            name=f"{name}-dispatcher",
            daemon=True,
        )
        self._stop_event = threading.Event()
        self._lock = threading.RLock()
        self._crash_reporter = crash_reporter or NullCrashReporter()
        self._dispatcher.start()
        _LOGGER.debug("EventBus '%s' instantiated.", self._name)

    # ----------------------------- Singleton helpers ------------------------ #
    @classmethod
    def get_global(cls) -> "EventBus":
        """Retrieve singleton instance used across application."""
        with cls._singleton_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # ----------------------------- Subscription API ------------------------ #
    def subscribe(self, observer: EventObserver, *event_types: EventType) -> None:
        """
        Register an observer for one or more event types.

        If no event type is given, the observer is subscribed to *all* events.
        """
        if not isinstance(observer, EventObserver.__mro__[1]):  # cheap duck-type check
            # At runtime verify presence of callable attribute to avoid mis-usage.
            if not callable(getattr(observer, "on_event", None)):
                raise TypeError(
                    "Observer must implement an 'on_event(self, event: Event)' method."
                )

        with self._lock:
            if not event_types:
                # Subscribe to everything
                event_types = tuple(EventType)
            for et in event_types:
                self._subscribers.setdefault(et, set()).add(
                    weakref.ref(observer, self._make_finalize_callback(et))
                )
                _LOGGER.debug(
                    "Observer %s subscribed to %s.",
                    observer,
                    et,
                )

    def unsubscribe(self, observer: EventObserver, *event_types: EventType) -> None:
        """Remove observer from specific or all event subscriptions."""
        with self._lock:
            targets = event_types or tuple(EventType)
            for et in targets:
                refs = self._subscribers.get(et)
                if not refs:
                    continue
                for ref in list(refs):
                    if ref() is observer or ref() is None:
                        refs.discard(ref)
                if not refs:
                    self._subscribers.pop(et, None)
                _LOGGER.debug("Observer %s unsubscribed from %s.", observer, et)

    # ----------------------------- Publishing API -------------------------- #
    def publish(self, event: Event | EventType, **payload: Any) -> None:
        """
        Publish an Event or quickly create one by passing EventType and kwargs.

        Example
        -------
        bus.publish(EventType.QUEST_COMPLETED, quest_id=42, xp=100)
        """
        if isinstance(event, Event):
            evt = event
        else:
            evt = Event(type=event, payload=payload)
        try:
            self._queue.put_nowait(evt)
            _LOGGER.debug("Queued event %s", evt)
        except queue.Full:
            _LOGGER.warning("Event queue full; dropping event %s", evt)

    # ----------------------------- Lifecycle -------------------------------- #
    def shutdown(self, timeout: float | None = 2.0) -> None:
        """Flush queue and stop background dispatcher gracefully."""
        if self._stop_event.is_set():
            return
        _LOGGER.info("Shutting down EventBus '%s'...", self._name)
        self._stop_event.set()
        self._dispatcher.join(timeout=timeout)
        self._flush()
        _LOGGER.info("EventBus '%s' terminated.", self._name)

    # ----------------------------- Internals -------------------------------- #
    def _flush(self) -> None:
        """Synchronously dispatch all remaining events (best-effort)."""
        while not self._queue.empty():
            try:
                event = self._queue.get_nowait()
            except queue.Empty:
                break
            self._notify(event)

    def _dispatch_loop(self) -> None:  # pragma: no cover
        while not self._stop_event.is_set():
            try:
                event = self._queue.get(timeout=0.5)
                self._notify(event)
            except queue.Empty:
                continue

    def _notify(self, event: Event) -> None:
        observers: List[Tuple[weakref.ReferenceType[EventObserver], EventObserver]] = []
        with self._lock:
            # Clone to avoid holding lock while executing callbacks
            for ref in self._subscribers.get(event.type, set()):
                obj = ref()
                if obj is None:
                    continue
                observers.append((ref, obj))

        for ref, observer in observers:
            try:
                observer.on_event(event)
                _LOGGER.debug(
                    "Observer %s handled event %s.", observer.__class__.__name__, event
                )
            except Exception as exc:  # pragma: no cover
                _LOGGER.error(
                    "Uncaught observer error in %s for event %s: %s",
                    observer,
                    event,
                    exc,
                    exc_info=True,
                )
                self._crash_reporter.report_exception(
                    type(exc), exc, exc.__traceback__, context={"event": event}
                )

    def _make_finalize_callback(
        self, event_type: EventType
    ) -> Callable[[weakref.ReferenceType[EventObserver]], None]:
        """Return callback removing dead weakref from subscription set."""

        def _finalizer(ref: weakref.ReferenceType[EventObserver]) -> None:
            with self._lock:
                refs = self._subscribers.get(event_type)
                if refs:
                    refs.discard(ref)
                    if not refs:
                        self._subscribers.pop(event_type, None)
                _LOGGER.debug(
                    "Observer garbage-collected; removed dead reference for %s.", event_type
                )

        return _finalizer


# --------------------------------------------------------------------------- #
# Decorator for functional observers
# --------------------------------------------------------------------------- #
def subscribe(*event_types: EventType) -> Callable[[Callable[[Event], Any]], Callable]:
    """
    Decorator turning a simple function into an EventBus observer.

    Usage
    -----
    @subscribe(EventType.QUEST_COMPLETED)
    def announce_completion(event: Event):
        ...
    """

    def decorator(func: Callable[[Event], Any]) -> Callable[[Event], Any]:
        class _FuncObserver:
            __slots__ = ("_func",)

            def __init__(self, f: Callable[[Event], Any]) -> None:
                self._func = f

            def on_event(self, event: Event) -> None:
                self._func(event)

            def __repr__(self) -> str:  # pragma: no cover
                return f"<FunctionObserver {self._func.__name__}>"

        observer = _FuncObserver(func)
        EventBus.get_global().subscribe(observer, *event_types)
        return func

    return decorator
```