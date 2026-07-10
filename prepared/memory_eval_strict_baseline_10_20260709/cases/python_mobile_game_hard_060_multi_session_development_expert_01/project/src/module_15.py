```python
"""
QuestSmith – module_15
======================

This module provides a thread-safe Observer/Event-Bus implementation used across
the QuestSmith mobile application.  Game logic, view-models, and platform
adapters communicate exclusively through events so that the MVVM, Repository,
Factory, and Adapter layers remain decoupled.

The EventBus implemented here is production-grade:

    • Typing-safe, thanks to Python 3.10+ type-hints
    • Thread-safe with re-entrant locks
    • Leak-free through the use of weak references
    • Supports pause/resume and context-manager muting
    • Wild-card subscriptions (“*”) for global listeners
    • Robust error isolation; one bad listener never kills the bus
    • Minimal external deps; only stdlib + `typing_extensions` for older Py’s

Listeners for push-notifications and analytics are included as realistic
examples; they depend on factories (`PlatformFactory`) supplied by other modules
at runtime.  If those factories are not yet initialised, graceful degradation
(“no-op”) occurs without raising exceptions.

This module is **self-contained** and safe to import even when executed in a
desktop test-harness without Kivy or mobile-only libraries installed.
"""

from __future__ import annotations

import functools
import logging
import threading
import traceback
import weakref
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum, auto
from types import TracebackType
from typing import Any, Callable, Dict, List, MutableMapping, MutableSequence, Optional, Set, Type

try:
    # `Literal` is only in typing for 3.8+; fallback for older py3.7 in some CI
    from typing import Literal
except ImportError:  # pragma: no cover
    from typing_extensions import Literal  # type: ignore

__all__ = [
    "EventType",
    "Event",
    "EventBus",
    "event_listener",
    "NotificationSchedulerListener",
    "AnalyticsListener",
]

LOGGER = logging.getLogger("QuestSmith.EventBus")


# --------------------------------------------------------------------------- #
#  Event definitions                                                          #
# --------------------------------------------------------------------------- #
class EventType(Enum):
    """
    Enumerates all high-level events exchanged within QuestSmith.

    NOTE: Keep this list small and generic—embed granular details inside the
    `data` attribute of `Event` rather than exploding this enum.
    """

    QUEST_CREATED = auto()
    QUEST_UPDATED = auto()
    QUEST_COMPLETED = auto()
    QUEST_DELETED = auto()

    USER_LEVEL_UP = auto()
    USER_LOGIN = auto()
    USER_LOGOUT = auto()

    # Wild-card delivery is supported via literal '*'
    # Add new events ABOVE this comment to maintain auto() ordering.


@dataclass(slots=True)
class Event:
    """Container for an event emitted on the bus."""

    type: EventType
    """
    The domain event type.
    """

    data: Dict[str, Any]
    """
    Arbitrary JSON-serialisable payload associated with the event.
    """

    source: str | None = None
    """
    Optional subsystem identifier (e.g., 'QuestRepository', 'UI.QuestCard').
    """

    def __post_init__(self) -> None:
        if not isinstance(self.data, dict):
            raise TypeError("`data` must be a dictionary")


# --------------------------------------------------------------------------- #
#  EventBus implementation                                                    #
# --------------------------------------------------------------------------- #
ListenerFn = Callable[[Event], None]


class _WeakCallback:
    """
    Wrapper around callables stored as weak references so bound-methods do not
    create reference cycles and anonymous lambdas still work.

    Implementation details:
        • Functions are stored via `weakref.ref`
        • Bound methods are stored via `weakref.WeakMethod`
        • Objects supporting `__call__` are treated as methods
    """

    __slots__ = ("_ref", "_hash")

    def __init__(self, fn: ListenerFn) -> None:
        if hasattr(fn, "__self__"):  # bound method
            self._ref = weakref.WeakMethod(fn)  # type: ignore[arg-type]
        else:
            self._ref = weakref.ref(fn)  # type: ignore[arg-type]
        self._hash = hash(fn)

    # Hashable—so we can add to sets
    def __hash__(self) -> int:
        return self._hash

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, _WeakCallback):
            return NotImplemented
        return self._hash == other._hash

    def alive(self) -> bool:
        return self._ref() is not None

    def __call__(self) -> Optional[ListenerFn]:
        return self._ref()


class EventBus:
    """
    Thread-safe Observer/Event-Bus used application-wide.

    Subscribe either programmatically::

        bus = EventBus.get_global()
        bus.subscribe(EventType.QUEST_COMPLETED, my_callback)

    or via decorator syntax::

        @event_listener(EventType.QUEST_COMPLETED)
        def handle_quest_completion(event: Event): ...

    You may also subscribe to all events using the sentinel `"*"`.
    """

    _GLOBAL_INSTANCE: "EventBus" | None = None
    _LOCK_INSTANCE = threading.Lock()

    def __init__(self) -> None:
        self._subscriptions: MutableMapping[
            EventType | Literal["*"], Set[_WeakCallback]
        ] = {}
        self._bus_lock = threading.RLock()

        # Re-entrancy guard for .pause()/resume() and mute context-manager
        self._paused = False
        self._pending: MutableSequence[Event] = []

        LOGGER.debug("EventBus initialised")

    # --------------------------------------------------------------------- #
    #  Singleton helpers                                                    #
    # --------------------------------------------------------------------- #
    @classmethod
    def get_global(cls) -> "EventBus":
        with cls._LOCK_INSTANCE:
            if cls._GLOBAL_INSTANCE is None:
                cls._GLOBAL_INSTANCE = cls()
                LOGGER.debug("Global EventBus instance created")
            return cls._GLOBAL_INSTANCE

    # --------------------------------------------------------------------- #
    #  Subscription management                                              #
    # --------------------------------------------------------------------- #
    def subscribe(
        self, event_type: EventType | Literal["*"], callback: ListenerFn
    ) -> None:
        """
        Register a callback for the given event type.

        The callback will receive exactly one positional argument: `Event`.
        """
        if not callable(callback):
            raise TypeError("callback must be callable")

        with self._bus_lock:
            cb = _WeakCallback(callback)
            if event_type not in self._subscriptions:
                self._subscriptions[event_type] = set()
            self._subscriptions[event_type].add(cb)
            LOGGER.debug("Subscribe: %s to %s", callback, event_type)

    def unsubscribe(
        self, event_type: EventType | Literal["*"], callback: ListenerFn
    ) -> None:
        """
        Remove a previously registered callback.
        """
        with self._bus_lock:
            callbacks = self._subscriptions.get(event_type, set())
            callbacks.discard(_WeakCallback(callback))
            LOGGER.debug("Unsubscribe: %s from %s", callback, event_type)

    # --------------------------------------------------------------------- #
    #  Publishing                                                           #
    # --------------------------------------------------------------------- #
    def publish(self, event: Event) -> None:
        """
        Broadcast an event to all listeners.  If any listener raises an
        exception, the stack trace is logged but propagation continues.
        """
        with self._bus_lock:
            if self._paused:
                LOGGER.debug("Bus paused – queueing event %s", event)
                self._pending.append(event)
                return

            listeners: List[_WeakCallback] = []
            listeners.extend(self._subscriptions.get(event.type, set()))
            listeners.extend(self._subscriptions.get("*", set()))

            # Clean up dead references
            listeners = [cb for cb in listeners if cb.alive()]

        # Dispatch outside the lock to prevent cascading deadlocks
        for weak_cb in listeners:
            cb = weak_cb()
            if cb is None:
                continue  # Object was GC'd
            try:
                cb(event)
            except Exception:  # pragma: no cover
                LOGGER.error(
                    "Unhandled exception in listener %s for event %s\n%s",
                    cb,
                    event,
                    traceback.format_exc(),
                )

    # --------------------------------------------------------------------- #
    #  Pause / Resume                                                       #
    # --------------------------------------------------------------------- #
    def pause(self) -> None:
        """
        Temporarily pause delivery of events.  Incoming events will be queued.

        Useful when performing bulk operations (e.g., DB migrations) where you
        don't want intermediate events to cascade into UI updates or network
        calls.  `resume()` flushes the queue.
        """
        with self._bus_lock:
            self._paused = True
            LOGGER.debug("EventBus paused")

    def resume(self, flush: bool = True) -> None:
        """
        Resume event delivery.

        If `flush` is True (default), all queued events are delivered in FIFO
        order; otherwise they are discarded.
        """
        with self._bus_lock:
            self._paused = False
            pending = list(self._pending) if flush else []
            self._pending.clear()

        LOGGER.debug("EventBus resumed. Flush=%s, pending=%d", flush, len(pending))
        for event in pending:
            self.publish(event)

    @contextmanager
    def muted(self, flush: bool = True):
        """
        Context-manager variant of pause/resume.

        Example::

            bus = EventBus.get_global()
            with bus.muted(flush=False):
                ...  # events published in here are discarded
        """
        self.pause()
        try:
            yield
        finally:
            self.resume(flush=flush)

    # --------------------------------------------------------------------- #
    #  Debugging helpers                                                    #
    # --------------------------------------------------------------------- #
    def get_subscribers_snapshot(
        self,
    ) -> Dict[EventType | Literal["*"], List[str]]:
        """
        Return a serialisable snapshot useful for debugging.

        The snapshot maps event_type → list of `repr(callback)`.
        """
        with self._bus_lock:
            snapshot: Dict[EventType | Literal["*"], List[str]] = {}
            for k, v in self._subscriptions.items():
                snapshot[k] = [repr(cb()) for cb in v if cb.alive()]
            return snapshot


# --------------------------------------------------------------------------- #
#  Decorator for concise subscription                                        #
# --------------------------------------------------------------------------- #
def event_listener(event_type: EventType | Literal["*"]):
    """
    Decorator that auto-registers the function or bound method to the global
    `EventBus` on import.

    Usage::

        @event_listener(EventType.USER_LEVEL_UP)
        def congratulate(event: Event): ...

    NOTE: Because registration happens at import time, combining this decorator
    with unit tests that reload modules may result in duplicate callbacks.  In
    such cases, prefer manual subscription.
    """

    def decorator(fn: ListenerFn) -> ListenerFn:
        EventBus.get_global().subscribe(event_type, fn)
        LOGGER.debug("Auto-subscribed %s via decorator for %s", fn, event_type)
        return fn

    return decorator


# --------------------------------------------------------------------------- #
#  Built-in listeners                                                         #
# --------------------------------------------------------------------------- #
class NotificationSchedulerListener:
    """
    Listens for quest-related events and schedules local push-notifications
    using a platform adapter provided by `PlatformFactory.get_notification_api`.
    """

    def __init__(self, platform_factory: "PlatformFactory"):
        self._notification_api = platform_factory.get_notification_api()
        bus = EventBus.get_global()
        bus.subscribe(EventType.QUEST_COMPLETED, self._on_quest_completed)
        LOGGER.info("%s initialised", self.__class__.__name__)

    # ------------------------------------------------------------------ #
    #  Callbacks                                                         #
    # ------------------------------------------------------------------ #
    def _on_quest_completed(self, event: Event) -> None:
        """When a quest completes, notify the user’s guildmates."""
        quest_name = event.data.get("name", "A Quest")
        guild_id = event.data.get("guild_id")
        if not guild_id:
            LOGGER.debug("Quest completed outside a guild – skipping push.")
            return

        try:
            self._notification_api.send_group_notification(
                group_id=guild_id,
                title="Quest Completed!",
                message=f"{quest_name} has been conquered! 🎉",
            )
            LOGGER.debug("Push-notification dispatched for quest %s", quest_name)
        except Exception as exc:  # pragma: no cover
            LOGGER.error("Failed to send notification: %s", exc)


class AnalyticsListener:
    """
    Captures all events and forwards them to an analytics pipeline.

    The real implementation could batch events and upload them periodically,
    but here we simply forward immediately for brevity.
    """

    def __init__(self, analytics_client: "AnalyticsClient"):
        self._analytics = analytics_client
        EventBus.get_global().subscribe("*", self._track_event)
        LOGGER.info("%s initialised", self.__class__.__name__)

    # ------------------------------------------------------------------ #
    #  Callbacks                                                         #
    # ------------------------------------------------------------------ #
    def _track_event(self, event: Event) -> None:
        """Serialize and push event to analytics service."""
        try:
            self._analytics.capture(
                user_id=event.data.get("user_id"),
                event_name=event.type.name,
                properties=event.data,
                source=event.source,
            )
            LOGGER.debug("Analytics event captured: %s", event.type)
        except Exception:  # pragma: no cover
            LOGGER.warning("Analytics capture failed for event %s", event.type)


# --------------------------------------------------------------------------- #
#  Guards & test harness                                                     #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    # Quick manual test when running this module directly.
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)-8s %(name)s:%(lineno)d | %(message)s",
    )

    bus = EventBus.get_global()

    @event_listener(EventType.QUEST_CREATED)
    def echo(event: Event):
        print(f"[ECHO] Event received => {event}")

    # Publish a test event
    test_event = Event(
        type=EventType.QUEST_CREATED,
        data={"quest_id": "abc123", "name": "Build EventBus"},
        source="test-harness",
    )
    bus.publish(test_event)

    # Demonstrate pause/resume
    bus.pause()
    bus.publish(Event(EventType.QUEST_DELETED, data={"quest_id": "xyz"}))
    print("Events muted; quest deleted published but not delivered")
    bus.resume()

    # Snapshot debug
    print("Subscriptions snapshot:", bus.get_subscribers_snapshot())
```