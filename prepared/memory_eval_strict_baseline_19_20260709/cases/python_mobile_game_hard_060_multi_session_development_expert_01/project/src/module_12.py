```python
"""
QuestSmith – Productivity RPG Forge
Source file: src/module_12.py

This module implements the in-game Event Bus (Observer pattern) as well as a
light-weight Adaptive Difficulty engine that listens to quest-related events
and continuously tunes the game difficulty curve.

Both components are designed to be framework-agnostic; however, if Kivy is
available the bus will automatically use `Clock.schedule_once` to marshal
callbacks back onto the main/UI thread—critical for mobile GUI safety.
"""

from __future__ import annotations

import logging
import threading
import time
import weakref
from collections import deque
from dataclasses import dataclass, field
from enum import Enum, auto
from types import MethodType
from typing import (
    Any,
    Callable,
    Dict,
    Generic,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Type,
    TypeVar,
    Union,
    overload,
)

# -----------------------------------------------------------------------------
# Optional Kivy integration
# -----------------------------------------------------------------------------
try:
    # Kivy is present on device – marshal events back to the main thread.
    from kivy.clock import Clock  # type: ignore
except ImportError:  # pragma: no cover – desktop unit-tests
    Clock = None  # type: ignore

# -----------------------------------------------------------------------------
# Logging configuration
# -----------------------------------------------------------------------------
_logger = logging.getLogger("questsmith.eventbus")
_logger.addHandler(logging.NullHandler())

# -----------------------------------------------------------------------------
# Crash-reporting hook (injected by the surrounding app via factory)
# -----------------------------------------------------------------------------
class CrashReporter(Protocol):
    """Minimal interface expected from Crash Reporter adapters."""

    def capture_exception(self, exc: Exception, context: Optional[Dict[str, Any]] = None) -> None: ...


_crash_reporter: Optional[CrashReporter] = None


def register_crash_reporter(reporter: CrashReporter) -> None:
    """Dynamically injects the crash-reporter implementation (Factory pattern)."""
    global _crash_reporter
    _crash_reporter = reporter
    _logger.debug("Crash reporter registered: %s", reporter)


# -----------------------------------------------------------------------------
# Event system
# -----------------------------------------------------------------------------
_ET = TypeVar("_ET", bound="BaseEvent")
Callback = Callable[["_ET"], None]


class EventDispatchMode(Enum):
    IMMEDIATE = auto()
    QUEUED = auto()  # Delivered on next main-loop cycle (Kivy) or background thread.


@dataclass(slots=True)
class BaseEvent:
    """Base class for every Event flowing through the EventBus."""

    timestamp: float = field(default_factory=time.time)


@dataclass(slots=True)
class QuestCompletedEvent(BaseEvent):
    quest_id: str = ""
    user_id: str = ""
    xp_gained: int = 0
    materials_collected: int = 0
    difficulty: float = 1.0
    completion_time_sec: float = 0.0


@dataclass(slots=True)
class QuestFailedEvent(BaseEvent):
    quest_id: str = ""
    user_id: str = ""
    difficulty: float = 1.0
    fail_reason: str = ""
    time_spent_sec: float = 0.0


# -----------------------------------------------------------------------------
# EventBus (Observer pattern)
# -----------------------------------------------------------------------------
_SubscriberRef = Union[weakref.WeakMethod, weakref.ReferenceType]  # type: ignore


class SubscriptionHandle:
    """Disposable handle returned to callers for unsubscribing."""

    __slots__ = ("_bus_ref", "_event_cls", "_callback_id")

    def __init__(self, bus: "EventBus", event_cls: Type[BaseEvent], callback_id: int) -> None:
        self._bus_ref = weakref.ref(bus)
        self._event_cls = event_cls
        self._callback_id = callback_id

    def unsubscribe(self) -> None:
        bus = self._bus_ref()
        if bus is not None:
            bus._unsubscribe(self._event_cls, self._callback_id)


class EventBus:
    """
    Thread-safe, leak-safe Observer implementation supporting:

    • Weak references to listeners (prevents dangling UI leaks)
    • Delivery order via priority
    • Crash-safe dispatch with automatic exception capture
    • Optional async dispatch through Kivy or background thread
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry: MutableMapping[
            Type[BaseEvent], Dict[int, "EventBus._ListenerTuple"]
        ] = {}
        self._id_counter = 0

    # ---------------------------------------------------------------------
    # Internal data structures
    # ---------------------------------------------------------------------
    class _ListenerTuple:
        __slots__ = ("priority", "ref")

        def __init__(self, priority: int, ref: _SubscriberRef):
            self.priority = priority
            self.ref = ref

    # ---------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------
    def subscribe(
        self,
        event_cls: Type[_ET],
        callback: Callback[_ET],
        *,
        priority: int = 0,
        weak: bool = True,
    ) -> SubscriptionHandle:
        """
        Registers a listener for an event class (including subclasses).

        Arguments
        ---------
        event_cls:
            Event dataclass to listen for.
        callback:
            Callable receiving an event instance.
        priority:
            Higher priority callbacks run first.
        weak:
            Store listener by weak reference (recommended). Set to False only for
            long-lived system services.
        """
        with self._lock:
            self._id_counter += 1
            callback_id = self._id_counter

            if weak:
                if isinstance(callback, MethodType):
                    ref: _SubscriberRef = weakref.WeakMethod(callback)  # type: ignore[arg-type]
                else:
                    ref = weakref.ref(callback)  # type: ignore[arg-type]
            else:
                # Strong reference (rarely needed)
                ref = lambda: callback  # type: ignore[return-value]

            listeners = self._registry.setdefault(event_cls, {})
            listeners[callback_id] = self._ListenerTuple(priority=priority, ref=ref)

            _logger.debug(
                "Subscribed: %s -> %s (id=%s, weak=%s, priority=%s)",
                event_cls.__name__,
                callback,
                callback_id,
                weak,
                priority,
            )
            return SubscriptionHandle(self, event_cls, callback_id)

    # pylint: disable=protected-access
    def _unsubscribe(self, event_cls: Type[BaseEvent], callback_id: int) -> None:
        with self._lock:
            listeners = self._registry.get(event_cls)
            if listeners and callback_id in listeners:
                del listeners[callback_id]
                _logger.debug(
                    "Unsubscribed: %s (id=%s). Remaining: %s",
                    event_cls.__name__,
                    callback_id,
                    len(listeners),
                )
                if not listeners:
                    del self._registry[event_cls]

    # ---------------------------------------------------------------------
    # Dispatch helpers
    # ---------------------------------------------------------------------
    def publish(
        self,
        event: BaseEvent,
        mode: EventDispatchMode = EventDispatchMode.IMMEDIATE,
    ) -> None:
        """
        Publishes an event to all registered listeners. If `mode=QUEUED` the
        event is delivered asynchronously in a UI-safe manner (if Kivy exists).
        """
        if mode is EventDispatchMode.IMMEDIATE:
            self._dispatch(event)
        else:
            self._enqueue(event)

    def _enqueue(self, event: BaseEvent) -> None:
        """Schedules event delivery on the main/UI thread."""
        if Clock is not None:
            Clock.schedule_once(lambda *_: self._dispatch(event), 0)
        else:
            # Fallback: dispatch in a background worker to avoid blocking
            threading.Thread(target=self._dispatch, args=(event,), daemon=True).start()

    def _dispatch(self, event: BaseEvent) -> None:
        """Synchronously invokes listeners with proper ordering and safety."""
        # Snapshot listeners to reduce lock contention
        snapshot: List[Callable[[BaseEvent], None]] = []

        with self._lock:
            for event_cls, listeners in self._registry.items():
                if isinstance(event, event_cls):
                    for listener in listeners.values():
                        cb = listener.ref()
                        if cb is not None:
                            snapshot.append(cb)

            # Sort by priority (highest first), stable for identical priority
            snapshot.sort(
                key=lambda cbk: next(
                    (
                        l.priority
                        for ev_cls, lst in self._registry.items()
                        if isinstance(event, ev_cls)
                        for l in lst.values()
                        if l.ref() is cbk
                    ),
                    0,
                ),
                reverse=True,
            )

        # Deliver event outside lock
        for cb in snapshot:
            try:
                cb(event)  # type: ignore[arg-type]
            except Exception as exc:  # noqa: BLE001
                _logger.exception("Exception within event listener: %s", cb)
                if _crash_reporter:
                    _crash_reporter.capture_exception(
                        exc,
                        {
                            "callback": repr(cb),
                            "event": event.__class__.__name__,
                        },
                    )


# -----------------------------------------------------------------------------
# Analytics repository placeholder (Repository pattern)
# -----------------------------------------------------------------------------
class AnalyticsRepository(Protocol):
    """Interface for data persistence or remote analytics."""

    def log_event(self, name: str, payload: Dict[str, Any]) -> None: ...


class InMemoryAnalyticsRepository:
    """Simple analytics repository for unit-tests and offline mode."""

    def __init__(self) -> None:
        self._events: List[Dict[str, Any]] = []

    def log_event(self, name: str, payload: Dict[str, Any]) -> None:
        _logger.debug("Analytics log_event: %s, %s", name, payload)
        self._events.append({"name": name, "payload": payload, "ts": time.time()})

    # Utility for tests
    @property
    def events(self) -> List[Dict[str, Any]]:
        return list(self._events)


# -----------------------------------------------------------------------------
# Adaptive Difficulty Engine
# -----------------------------------------------------------------------------
class DifficultyAdjuster:
    """
    Listens for quest completion/failure events and maintains a rolling window
    of recent performance metrics. The exposed `difficulty_modifier` can be
    queried by Quest generators to adapt future quest scaling.

    The algorithm here is intentionally simplistic (Z-score on completion
    times) but demonstrates how such a service can be structured.
    """

    _WINDOW_SECONDS = 60 * 60 * 24 * 7  # 1 week of history

    def __init__(
        self,
        event_bus: EventBus,
        analytics_repo: AnalyticsRepository,
        *,
        sample_size: int = 64,
    ) -> None:
        self._bus = event_bus
        self._analytics = analytics_repo

        self._history: deque[QuestCompletedEvent] = deque(maxlen=sample_size)
        self._difficulty_modifier: float = 1.0
        self._lock = threading.Lock()

        # Subscribe for relevant events
        event_bus.subscribe(QuestCompletedEvent, self._on_quest_completed, weak=False)
        event_bus.subscribe(QuestFailedEvent, self._on_quest_failed, weak=False)

    # -----------------------------------------------------------------
    # Public interface
    # -----------------------------------------------------------------
    @property
    def difficulty_modifier(self) -> float:
        with self._lock:
            return self._difficulty_modifier

    # -----------------------------------------------------------------
    # Event handlers
    # -----------------------------------------------------------------
    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        with self._lock:
            self._trim_history()
            self._history.append(event)
            self._recalculate_modifier()

        self._analytics.log_event(
            "quest_completed",
            {
                "quest_id": event.quest_id,
                "user_id": event.user_id,
                "difficulty": event.difficulty,
                "modifier": self._difficulty_modifier,
            },
        )

    def _on_quest_failed(self, event: QuestFailedEvent) -> None:
        with self._lock:
            self._trim_history()
            # Treat failed quests as having an implicit difficulty overrun
            synthetic = QuestCompletedEvent(
                quest_id=event.quest_id,
                user_id=event.user_id,
                xp_gained=0,
                materials_collected=0,
                difficulty=event.difficulty * 1.1,  # penalty factor
                completion_time_sec=event.time_spent_sec,
            )
            self._history.append(synthetic)
            self._recalculate_modifier()

        self._analytics.log_event(
            "quest_failed",
            {
                "quest_id": event.quest_id,
                "user_id": event.user_id,
                "difficulty": event.difficulty,
                "modifier": self._difficulty_modifier,
                "reason": event.fail_reason,
            },
        )

    # -----------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------
    def _trim_history(self) -> None:
        cutoff = time.time() - self._WINDOW_SECONDS
        while self._history and self._history[0].timestamp < cutoff:
            self._history.popleft()

    def _recalculate_modifier(self) -> None:
        if not self._history:
            self._difficulty_modifier = 1.0
            return

        # Naïve algorithm: average the player-perceived difficulty ratio.
        avg_perceived_difficulty = sum(e.difficulty for e in self._history) / len(self._history)

        # Maintain modifier within sane bounds
        self._difficulty_modifier = max(0.5, min(2.0, avg_perceived_difficulty))
        _logger.debug(
            "Recalculated difficulty modifier: %.3f (history=%s)",
            self._difficulty_modifier,
            len(self._history),
        )


# -----------------------------------------------------------------------------
# Module utilities – a global bus instance for convenience
# -----------------------------------------------------------------------------
_global_bus: Optional[EventBus] = None
_global_lock = threading.Lock()


def get_global_event_bus() -> EventBus:
    """Returns (or creates) the singleton EventBus for app-wide usage."""
    global _global_bus
    with _global_lock:
        if _global_bus is None:
            _global_bus = EventBus()
            _logger.debug("Created global EventBus instance")
        return _global_bus


# -----------------------------------------------------------------------------
# Example initialisation (would typically be executed in App startup)
# -----------------------------------------------------------------------------
def _init_singletons_for_runtime() -> None:  # pragma: no cover
    bus = get_global_event_bus()
    analytics = InMemoryAnalyticsRepository()
    DifficultyAdjuster(bus, analytics_repo=analytics)
    _logger.info("DifficultyAdjuster initialised and listening")


# Automatically bootstrap when running as main for smoke testing
if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    _init_singletons_for_runtime()

    bus = get_global_event_bus()
    # Emit a few fake events
    bus.publish(
        QuestCompletedEvent(
            quest_id="Q1",
            user_id="u123",
            xp_gained=50,
            materials_collected=2,
            difficulty=1.0,
            completion_time_sec=300,
        )
    )
    bus.publish(
        QuestFailedEvent(
            quest_id="Q2",
            user_id="u123",
            difficulty=1.5,
            fail_reason="timeout",
            time_spent_sec=900,
        )
    )
    # Sleep briefly to allow async delivery on desktop fallback
    time.sleep(0.2)
```