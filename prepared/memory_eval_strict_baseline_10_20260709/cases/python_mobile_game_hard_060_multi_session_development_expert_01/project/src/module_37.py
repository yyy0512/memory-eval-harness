```python
"""
QuestSmith – Productivity RPG Forge
-----------------------------------
module_37.py
Core Observer/Event-Bus implementation used across the application to propagate
domain events (quest updates, analytics pings, push-notification triggers, …).

Key design points
-----------------
* Thread-safe, non-blocking publication (leverages a background worker + Kivy’s
  `Clock` for main-thread callbacks when available).
* Weak-referenced subscribers to avoid memory leaks when view-models/widgets
  get destroyed.
* Back-pressure aware: bounded queue with graceful degradation + telemetry via
  crash-reporter integration.
* `@event_subscriber` decorator for declarative subscription.
"""

from __future__ import annotations

import enum
import functools
import logging
import queue
import threading
import time
import types
import weakref
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Optional Kivy integration (QuestSmith is a Kivy app, but allow CLI fallback)
# --------------------------------------------------------------------------- #
try:
    from kivy.clock import Clock  # type: ignore
except Exception:  # pragma: no cover – Kivy not installed in all environments
    Clock = None  # type: ignore

# --------------------------------------------------------------------------- #
# Optional crash reporter (plugged via Factory-Pattern in bootstrap stage)
# --------------------------------------------------------------------------- #
try:
    from crash_reporting import CrashReporter  # type: ignore
except Exception:  # pragma: no cover
    class _NoOpReporter:  # pylint: disable=too-few-public-methods
        def capture_exception(self, exc: BaseException) -> None:  # noqa: D401
            logging.getLogger(__name__).debug(
                "CrashReporter unavailable, swallowed: %s", exc
            )

    CrashReporter = _NoOpReporter()  # type: ignore

# --------------------------------------------------------------------------- #
# Logging                                                                       
# --------------------------------------------------------------------------- #
_LOG = logging.getLogger("questsmith.event_bus")
_LOG.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
# Event system                                                                  
# --------------------------------------------------------------------------- #
class EventTopic(str, enum.Enum):
    """
    Pre-defined system topics. Game modules may extend by subclassing or by
    just using arbitrary strings (the bus accepts any hashable topic).
    """

    QUEST_UPDATED = "quest.updated"
    QUEST_COMPLETED = "quest.completed"
    USER_AUTHENTICATED = "user.authenticated"
    ANALYTICS_FLUSH = "analytics.flush"
    APP_FOREGROUNDED = "app.foregrounded"
    APP_BACKGROUNDED = "app.backgrounded"


@dataclass(frozen=True, slots=True)
class Event:
    """
    Immutable event representation.

    Attributes
    ----------
    topic: str | EventTopic
        Categorisation of the event (namespaced dotted string).
    payload: Any
        Arbitrary data associated with the event.
    ts: float
        Epoch timestamp in seconds when the event was created.
    """

    topic: str | EventTopic
    payload: Any = None
    ts: float = time.time()


Subscriber = Callable[[Event], None]


# --------------------------------------------------------------------------- #
# EventBus implementation                                                       
# --------------------------------------------------------------------------- #
class EventBus:  # pylint: disable=too-many-instance-attributes
    """
    Thread-safe observable event bus.

    Example
    -------
    >>> bus = EventBus()
    >>> @bus.subscriber(EventTopic.QUEST_COMPLETED)
    ... def on_complete(evt):
    ...     print(f"Quest finished → rewards={evt.payload}")
    ...
    >>> bus.publish(Event(EventTopic.QUEST_COMPLETED, {'xp': 100}))
    """

    _DEFAULT_QUEUE_SIZE = 1 << 10  # 1024

    # Singleton pattern – single shared bus per process
    _instance_lock = threading.Lock()
    _instance: Optional["EventBus"] = None

    # --------------------------------------------------------------------- #
    # Construction                                                           #
    # --------------------------------------------------------------------- #
    def __new__(cls, *args, **kwargs):  # noqa: D401
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self, queue_size: int = _DEFAULT_QUEUE_SIZE) -> None:
        if getattr(self, "_initialised", False):
            return  # Already initialised (singleton)
        self._initialised = True

        self._queue: queue.Queue[Event] = queue.Queue(maxsize=queue_size)
        self._topics: Dict[str, List[Tuple[weakref.ref[Subscriber], bool]]] = {}
        self._lock = threading.RLock()

        self._worker_thread = threading.Thread(
            target=self._worker, name="EventBusWorker", daemon=True
        )
        self._stop_event = threading.Event()
        self._worker_thread.start()

        _LOG.debug("EventBus initialised with queue_size=%s", queue_size)

    # --------------------------------------------------------------------- #
    # Subscription management                                               #
    # --------------------------------------------------------------------- #
    def subscribe(
        self, topic: str | EventTopic, callback: Subscriber, once: bool = False
    ) -> None:
        """
        Subscribe to a topic. Callback receives the `Event`.

        Parameters
        ----------
        topic: str | EventTopic
            Identifier of events to listen for.
        callback: Callable[[Event], None]
            Listener function.
        once: bool
            If ``True`` the listener is auto-unsubscribed after first call.
        """
        with self._lock:
            cb_ref: weakref.ref[Subscriber]
            if isinstance(callback, types.MethodType):
                cb_ref = weakref.WeakMethod(callback)  # type: ignore[arg-type]
            else:
                cb_ref = weakref.ref(callback)
            self._topics.setdefault(str(topic), []).append((cb_ref, once))
        _LOG.debug("Subscriber added: %s → %s (once=%s)", topic, callback, once)

    def unsubscribe(self, topic: str | EventTopic, callback: Subscriber) -> None:
        """Remove a previously registered subscriber."""
        with self._lock:
            listeners = self._topics.get(str(topic), [])
            self._topics[str(topic)] = [
                pair for pair in listeners if pair[0]() is not callback
            ]
        _LOG.debug("Subscriber removed: %s → %s", topic, callback)

    def subscriber(
        self, topic: str | EventTopic, *, once: bool = False
    ) -> Callable[[Subscriber], Subscriber]:
        """
        Decorator to mark functions as event listeners.

        Example
        -------
        >>> @bus.subscriber("custom.event")
        ... def handler(evt):
        ...     ...
        """

        def decorator(func: Subscriber) -> Subscriber:  # type: ignore[override]
            self.subscribe(topic, func, once=once)
            return func

        return decorator

    # --------------------------------------------------------------------- #
    # Publication                                                            #
    # --------------------------------------------------------------------- #
    def publish(self, event: Event) -> None:
        """
        Publish an event asynchronously. If the queue is full the event is
        dropped and logged to crash-reporter to prevent deadlocks in UI thread.
        """
        try:
            self._queue.put_nowait(event)
            _LOG.debug("Enqueued event: %s", event)
        except queue.Full as exc:
            _LOG.error("EventBus queue full. Dropping event: %s", event)
            if CrashReporter:
                CrashReporter.capture_exception(exc)

    # --------------------------------------------------------------------- #
    # Internal worker thread                                                #
    # --------------------------------------------------------------------- #
    def _worker(self) -> None:  # noqa: D401
        _LOG.debug("EventBus worker thread started")
        while not self._stop_event.is_set():
            try:
                event: Event = self._queue.get(timeout=0.5)
                self._dispatch(event)
            except queue.Empty:
                continue
            except Exception as exc:  # pragma: no cover
                _LOG.exception("Unhandled exception in EventBus worker: %s", exc)
                if CrashReporter:
                    CrashReporter.capture_exception(exc)

    # --------------------------------------------------------------------- #
    # Dispatching                                                           #
    # --------------------------------------------------------------------- #
    def _dispatch(self, event: Event) -> None:
        topic = str(event.topic)
        with self._lock:
            listeners = list(self._topics.get(topic, []))  # Copy for concurrency

        for cb_ref, once in listeners:
            callback = cb_ref()
            if callback is None:
                # Listener has been GC-d
                self._cleanup(topic, cb_ref)
                continue

            dispatch_fn = functools.partial(self._safe_invoke, callback, event)

            if Clock is not None:
                # Ensure callbacks land on Kivy’s main thread for UI safety
                Clock.schedule_once(lambda *_: dispatch_fn(), 0)
            else:
                # Non-Kivy context (unit-tests/CLI): run in worker thread
                dispatch_fn()

            if once:
                self.unsubscribe(topic, callback)

    def _safe_invoke(self, callback: Subscriber, event: Event) -> None:
        try:
            callback(event)
        except Exception as exc:  # pragma: no cover
            _LOG.exception("Error in event subscriber %s: %s", callback, exc)
            if CrashReporter:
                CrashReporter.capture_exception(exc)

    def _cleanup(self, topic: str, cb_ref: weakref.ref[Subscriber]) -> None:
        with self._lock:
            listeners = self._topics.get(topic, [])
            self._topics[topic] = [pair for pair in listeners if pair[0] is not cb_ref]
        _LOG.debug("Cleaned up dead subscriber for topic %s", topic)

    # --------------------------------------------------------------------- #
    # Shutdown                                                              #
    # --------------------------------------------------------------------- #
    def shutdown(self) -> None:
        """Stop the worker thread gracefully (used in test/teardown)."""
        self._stop_event.set()
        self._worker_thread.join(timeout=2.0)
        _LOG.debug("EventBus worker terminated")


# --------------------------------------------------------------------------- #
# Convenience global bus instance                                             
# --------------------------------------------------------------------------- #
GLOBAL_EVENT_BUS = EventBus()

# --------------------------------------------------------------------------- #
# Helper decorator (module-level for ease-of-use)                             
# --------------------------------------------------------------------------- #
def event_subscriber(
    topic: str | EventTopic, *, once: bool = False
) -> Callable[[Subscriber], Subscriber]:
    """
    Module-level shortcut to subscribe to global bus.

    Example
    -------
    >>> @event_subscriber(EventTopic.APP_FOREGROUNDED)
    ... def _on_foreground(evt):
    ...     ...
    """
    return GLOBAL_EVENT_BUS.subscriber(topic, once=once)


# --------------------------------------------------------------------------- #
# Example usage when executed directly                                        
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    @event_subscriber(EventTopic.QUEST_UPDATED)
    def _debug_listener(evt: Event) -> None:
        print(f"[{evt.ts:.3f}] EVENT → {evt.topic}: {evt.payload}")

    GLOBAL_EVENT_BUS.publish(Event(EventTopic.QUEST_UPDATED, {"id": 42, "progress": 0.7}))
    time.sleep(0.1)  # Allow worker thread to dispatch before exit
```