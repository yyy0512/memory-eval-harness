```python
"""
src/module_8.py
QuestSmith – Productivity RPG Forge
-----------------------------------

Event-bus implementation used across the application to broadcast domain
events (e.g., quest status changes, sync progress, push-notification
requests).  The bus is designed around the Observer Pattern and is fully
thread-safe.  It falls back to Python’s standard library when platform
packages (Kivy, Crashlytics, etc.) are unavailable so the core game logic
remains pure-Python and easy to test.

The bus supports:

* Strongly-typed events via `dataclasses`.
* Weakly-referenced observers to prevent memory leaks on mobile devices.
* Background dispatch thread so producers never block.
* Automatic marshaling of callbacks onto Kivy’s main/UI thread when Kivy
  is available; otherwise events are handled synchronously in the
  dispatch loop.
* Simple decorator-based subscription API: `@event_bus.subscribe(Event)`.
* Graceful degradation if the crash-reporting adapter is missing.

This module has zero hard runtime dependencies outside the standard
library. Optional integrations are resolved lazily to keep the game
monolith lean.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
import types
import weakref
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Generic, Iterable, Optional, Set, Type, TypeVar

# -----------------------------------------------------------------------------
# Optional / platform-specific imports
# -----------------------------------------------------------------------------
try:
    # Kivy is present in production (mobile build) but not necessarily in CI.
    from kivy.clock import Clock

    _MAIN_THREAD_MARSHAL: Optional[Callable[[Callable[..., Any]], None]] = Clock.schedule_once
except Exception:  # pragma: no cover – for environments without Kivy
    Clock = None
    _MAIN_THREAD_MARSHAL = None

# -----------------------------------------------------------------------------
# Crash-reporting adapter (Factory Pattern)
# -----------------------------------------------------------------------------
class CrashReporterAdapter:
    """
    Abstract crash reporter; concrete implementation is injected at runtime by
    a factory so this module never directly depends on a third-party SDK.
    """

    def capture_exception(self, exc: BaseException, **context: Any) -> None:  # noqa: D401
        """
        Persist exception to remote crash-reporting backend.

        Parameters
        ----------
        exc:
            The exception object.
        context:
            Arbitrary contextual data to help debugging.
        """
        raise NotImplementedError


# Global holder; may be swapped out by the DI container at startup.
_CRASH_REPORTER: Optional[CrashReporterAdapter] = None


def set_crash_reporter(reporter: CrashReporterAdapter) -> None:  # noqa: D401
    """
    Inject concrete crash reporter at runtime.

    Should be called exactly once during app bootstrap.
    """
    global _CRASH_REPORTER
    _CRASH_REPORTER = reporter


# -----------------------------------------------------------------------------
# Event declaration
# -----------------------------------------------------------------------------
T = TypeVar("T", bound="GameEvent")


@dataclass(frozen=True, slots=True)
class GameEvent:
    """
    Base class for *all* domain events.

    Subclasses should be small, immutable data holders.
    """

    timestamp: datetime = datetime.utcnow()


@dataclass(frozen=True, slots=True)
class QuestCompletedEvent(GameEvent):
    """Emitted when a quest is marked as completed."""

    quest_id: str
    xp_gained: int
    gold_gained: int


@dataclass(frozen=True, slots=True)
class QuestFailedEvent(GameEvent):
    """Emitted when a quest is failed or expired."""

    quest_id: str
    penalty: int


# -----------------------------------------------------------------------------
# Observer / Subscription registry
# -----------------------------------------------------------------------------
ObserverFn = Callable[[T], None]
_EVENT_REGISTRY: Dict[Type[GameEvent], Set[weakref.ReferenceType[Callable]]] = {}
_OBSERVER_LOCK = threading.RLock()

# Queue is *unbounded* on purpose – quest generation is low volume
# but we still want to avoid blocking producers.
_EVENT_QUEUE: "queue.Queue[GameEvent]" = queue.Queue()

# Dispatch control flag
_STOP_DISPATCH = object()


def _logger() -> logging.Logger:  # Lazy logger to avoid import re-ordering issues
    return logging.getLogger("questsmith.event_bus")


# -----------------------------------------------------------------------------
# Core API
# -----------------------------------------------------------------------------
class EventBus:
    """
    Thread-safe, non-blocking event bus.

    A singleton instance is exposed at the bottom of the file as
    `event_bus` to simplify imports.

    Usage
    -----
        @event_bus.subscribe(QuestCompletedEvent)
        def on_quest_complete(event: QuestCompletedEvent):
            ...

        event_bus.publish(QuestCompletedEvent(quest_id="abc", xp_gained=42, gold_gained=10))
    """

    def __init__(self) -> None:
        self._dispatch_thread = threading.Thread(
            target=self._dispatch_loop,
            name="QuestSmithEventBus",
            daemon=True,
        )
        self._dispatch_thread.start()
        self._suspend_count = 0
        self._suspend_lock = threading.Lock()

    # ----------------------------------------------------------------------
    # Public interface
    # ----------------------------------------------------------------------
    def publish(self, event: GameEvent) -> None:
        """
        Push an event onto the asynchronous queue.

        Producing threads are *never* blocked – enqueue operation is nearly O(1).
        """
        _EVENT_QUEUE.put(event)
        _logger().debug("Published event %s", event)

    def subscribe(
        self,
        event_cls: Type[T],
    ) -> Callable[[ObserverFn[T]], ObserverFn[T]]:
        """
        Decorator-based subscription.

        Example
        -------
            @event_bus.subscribe(QuestCompletedEvent)
            def on_complete(event):
                ...

        Returns the original function so the decorator is transparent for tests.
        """

        def _decorator(fn: ObserverFn[T]) -> ObserverFn[T]:
            self.add_listener(event_cls, fn)
            return fn

        return _decorator

    def add_listener(self, event_cls: Type[T], observer: ObserverFn[T]) -> None:
        """
        Low-level method; use `subscribe` decorator when possible.
        """
        if not callable(observer):
            raise TypeError("Observer must be callable")

        with _OBSERVER_LOCK:
            registry = _EVENT_REGISTRY.setdefault(event_cls, set())
            registry.add(weakref.ref(observer))
            _logger().debug(
                "Registered observer %s for event %s", observer.__qualname__, event_cls.__name__
            )

    def remove_listener(self, event_cls: Type[T], observer: ObserverFn[T]) -> None:
        """
        Unregister an observer.

        Safe-to-call even if the observer or event class is missing.
        """
        with _OBSERVER_LOCK:
            refs = _EVENT_REGISTRY.get(event_cls, set())
            to_remove: Iterable[weakref.ReferenceType[Callable]] = [
                r for r in refs if r() is observer
            ]
            for ref in to_remove:
                refs.discard(ref)
            _logger().debug(
                "Unregistered observer %s from event %s", observer.__qualname__, event_cls.__name__
            )

    @contextmanager
    def suspend_dispatch(self) -> Iterable[None]:
        """
        Context manager to temporarily suspend event delivery.

        Example
        -------
            with event_bus.suspend_dispatch():
                ... # bulk database operation
                ...
            # events are delivered *after* the `with` block
        """
        with self._suspend_lock:
            self._suspend_count += 1
        try:
            yield
        finally:
            with self._suspend_lock:
                self._suspend_count -= 1
                if self._suspend_count == 0:
                    _EVENT_QUEUE.put(None)  # sentinel; resumes loop

    def shutdown(self, timeout: float = 3.0) -> None:
        """
        Stop dispatch thread politely—used by automated tests.

        Parameters
        ----------
        timeout:
            Seconds to wait before giving up on thread join.
        """
        _EVENT_QUEUE.put(_STOP_DISPATCH)
        self._dispatch_thread.join(timeout=timeout)

    # ----------------------------------------------------------------------
    # Internal
    # ----------------------------------------------------------------------
    @staticmethod
    def _dispatch_to_ui_thread(fn: Callable[..., Any], *args: Any) -> None:
        """
        Forward callback to Kivy’s main thread if available; else call directly.
        """
        # Kivy's Clock.schedule_once expects a 2-arg callable: (dt)
        if _MAIN_THREAD_MARSHAL is not None:
            _MAIN_THREAD_MARSHAL(lambda _dt: fn(*args))
        else:
            fn(*args)

    def _dispatch_loop(self) -> None:
        """
        Blocking loop that consumes `_EVENT_QUEUE` and notifies observers.

        Runs in *one* daemon thread per process.
        """
        while True:
            try:
                event = _EVENT_QUEUE.get()
                if event is _STOP_DISPATCH:
                    _logger().info("Stopping event-dispatch thread")
                    return

                # Handle resume sentinel
                if event is None:
                    continue

                with self._suspend_lock:
                    if self._suspend_count > 0:
                        # Re-queue and sleep briefly to avoid tight loop
                        _EVENT_QUEUE.put(event)
                        time.sleep(0.05)
                        continue

                # Snapshot observers to minimize lock contention
                observers_snapshot: "Set[weakref.ReferenceType[Callable]]"
                with _OBSERVER_LOCK:
                    observers_snapshot = set(_EVENT_REGISTRY.get(type(event), set()))

                for ref in list(observers_snapshot):
                    observer = ref()
                    if observer is None:
                        # Dead weakref – cleanup lazily
                        with _OBSERVER_LOCK:
                            observers_snapshot.discard(ref)
                        continue

                    # Dispatch
                    try:
                        self._dispatch_to_ui_thread(observer, event)
                        _logger().debug(
                            "Dispatched %s to %s",
                            type(event).__name__,
                            observer.__qualname__,
                        )
                    except Exception as exc:  # pragma: no cover
                        _logger().exception(
                            "Unhandled exception in observer %s", observer.__qualname__
                        )
                        if _CRASH_REPORTER:
                            _CRASH_REPORTER.capture_exception(
                                exc,
                                observer=observer.__qualname__,
                                event=repr(event),
                            )
            except Exception as exc:  # pragma: no cover – unexpected error in dispatch loop
                _logger().exception("Critical error in event-dispatch loop")
                if _CRASH_REPORTER:
                    _CRASH_REPORTER.capture_exception(exc, stage="dispatch_loop")

    # ----------------------------------------------------------------------
    # Magic dunder methods
    # ----------------------------------------------------------------------
    def __call__(self, event: GameEvent) -> None:
        """Alias for `publish` to enable functional style."""
        self.publish(event)


# -----------------------------------------------------------------------------
# Singleton instance exported to the rest of the code base
# -----------------------------------------------------------------------------
event_bus = EventBus()  # pragma: public API


# -----------------------------------------------------------------------------
# Configure module-level logger
# -----------------------------------------------------------------------------
def _configure_logging() -> None:
    """
    Install default handler in case the application has not configured
    logging yet.  Ensures that early startup errors don’t get swallowed.
    """
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="[%(levelname)s] %(asctime)s %(name)s – %(message)s",
            datefmt="%H:%M:%S",
        )


_configure_logging()
```