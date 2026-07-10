```python
"""
QuestSmith – Productivity RPG Forge
Module: src/module_39.py

This module implements a thread-safe, Observer-pattern driven Event-Bus that
connects the core game logic with platform-specific adapters such as push
notifications, analytics, and crash reporting.  It is designed to be
memory-leak-safe (weak references), asyncio-friendly, and resilient to listener
failures (optional crash-reporting hook).

The bus is used project-wide and therefore provides a fast singleton accessor
`get_event_bus()` while still allowing sandboxed instances for testability.

Example
-------
>>> from src import module_39 as bus_mod
>>> event_bus = bus_mod.get_event_bus()
>>>
>>> @bus_mod.event_listener(bus_mod.QuestCompletedEvent)
... def congratulate(event):
...     print(f"Congrats on quest {event.quest_id}!")
...
>>> event_bus.publish(bus_mod.QuestCompletedEvent(quest_id="slay-dragon"))
Congrats on quest slay-dragon!
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
import types
import weakref
from collections import defaultdict
from dataclasses import dataclass, field
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Set,
    Tuple,
    Type,
    TypeVar,
    Union,
    overload,
)

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #
logger = logging.getLogger("questsmith.eventbus")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Public Event definitions
# --------------------------------------------------------------------------- #


@dataclass(slots=True, frozen=True)
class BaseEvent:
    """Base class for all events travelling through the EventBus."""

    timestamp: float = field(default_factory=time.time)


@dataclass(slots=True, frozen=True)
class QuestCompletedEvent(BaseEvent):
    quest_id: str
    user_id: str | None = None
    reward_xp: int = 0
    reward_gold: int = 0


@dataclass(slots=True, frozen=True)
class QuestFailedEvent(BaseEvent):
    quest_id: str
    user_id: str | None = None
    penalty_hp: int = 0


@dataclass(slots=True, frozen=True)
class UserAuthenticatedEvent(BaseEvent):
    user_id: str
    method: str  # e.g. 'biometric', 'password', 'magic_link'


@dataclass(slots=True, frozen=True)
class LocationEnteredEvent(BaseEvent):
    place_id: str
    latitude: float
    longitude: float


# A generic type for events
E = TypeVar("E", bound=BaseEvent)

# --------------------------------------------------------------------------- #
# Crash reporter interface
# --------------------------------------------------------------------------- #


class CrashReporter(Protocol):
    """
    Loose protocol for dependency-injection of any crash-reporting facility
    (e.g. Sentry, Firebase Crashes) compatible with QuestSmith.
    """

    def capture_exception(self, exc: BaseException, context: Optional[dict] = None) -> None: ...


# --------------------------------------------------------------------------- #
# EventBus implementation
# --------------------------------------------------------------------------- #


class _ListenerTuple(typing.NamedTuple):
    priority: int
    ref: "weakref.ReferenceType[Callable[[Any], Any]]"
    once: bool


class EventBus:
    """
    Thread-safe, weak-referenced Observable EventBus.

    Listeners may be synchronous or asynchronous callables.  Asynchronous
    listeners (i.e. coroutines) are automatically scheduled on the provided
    asyncio event-loop, defaulting to `asyncio.get_event_loop()`.

    The publish/subscribe model uses event-class matching (including subclass
    checks) for fast dispatching while retaining Pythonic flexibility.
    """

    _lock: threading.RLock
    _subscribers: Dict[Type[BaseEvent], List[_ListenerTuple]]

    def __init__(
        self,
        *,
        crash_reporter: CrashReporter | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._subscribers = defaultdict(list)
        self._suppressed: Set[Type[BaseEvent]] = set()
        self._crash_reporter = crash_reporter
        self._loop = loop or asyncio.get_event_loop()

    # --------------------------------------------------------------------- #
    # Subscription
    # --------------------------------------------------------------------- #

    def subscribe(
        self,
        event_cls: Type[E],
        listener: Callable[[E], Union[Awaitable[None], None]],
        *,
        weak: bool = True,
        priority: int = 0,
        once: bool = False,
    ) -> None:
        """
        Subscribe *listener* to *event_cls*.

        Parameters
        ----------
        weak:
            If True (default), a weak reference to the listener is kept so that
            it can be garbage-collected naturally.
        priority:
            Higher priority listeners are executed first.
        once:
            Listener is automatically unsubscribed after handling one event.
        """
        if not callable(listener):
            raise TypeError("listener must be callable")

        with self._lock:
            ref: weakref.ReferenceType
            if weak:
                if isinstance(listener, types.MethodType):
                    ref = weakref.WeakMethod(listener)  # type: ignore[arg-type]
                else:
                    ref = weakref.ref(listener)  # type: ignore[arg-type]
            else:
                # keep strong reference by referencing the object itself
                ref = lambda: listener  # type: ignore[assignment]
            self._subscribers[event_cls].append(
                _ListenerTuple(priority=priority, ref=ref, once=once)
            )
            # Keep list ordered by priority (highest first)
            self._subscribers[event_cls].sort(key=lambda t: -t.priority)
            logger.debug(
                "Subscribed %s to %s(priority=%s, once=%s)",
                listener,
                event_cls.__name__,
                priority,
                once,
            )

    def unsubscribe(
        self,
        event_cls: Type[E],
        listener: Callable[[E], Union[Awaitable[None], None]],
    ) -> None:
        """Remove *listener* from *event_cls* subscription."""
        with self._lock:
            lst = self._subscribers.get(event_cls)
            if not lst:
                return
            before = len(lst)
            self._subscribers[event_cls] = [
                t for t in lst if t.ref() is not listener
            ]
            after = len(self._subscribers[event_cls])
            logger.debug(
                "Unsubscribed %s from %s (removed=%d)",
                listener,
                event_cls.__name__,
                before - after,
            )

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #

    def publish(self, event: E) -> None:
        """
        Publish *event* to all subscribed listeners.

        Exceptions thrown by listeners are caught and sent to the configured
        crash reporter (if any).  Publishing continues for remaining listeners.
        """
        if type(event) in self._suppressed:
            logger.debug("Event %s suppressed", event)
            return

        listeners: List[_ListenerTuple] = []

        with self._lock:
            # Gather direct subscribers
            listeners.extend(self._subscribers.get(type(event), []))

            # Support subclass dispatch (e.g., BaseEvent)
            for base_cls, subs in self._subscribers.items():
                if base_cls is type(event):
                    continue
                if issubclass(type(event), base_cls):
                    listeners.extend(subs)

        # Iterate copy -> no lock while executing potentially slow callbacks
        for listener_tuple in list(listeners):
            func = listener_tuple.ref()
            if func is None:  # dead weak ref
                self._purge_dead_ref(listener_tuple)
                continue

            try:
                result = func(event)  # type: ignore[arg-type]
                if asyncio.iscoroutine(result):
                    self._loop.create_task(
                        self._safe_await(result, func=func, event=event)
                    )
            except Exception as exc:  # noqa: BLE001
                self._handle_exception(exc, func, event)

            # Auto-detach `once` listeners
            if listener_tuple.once:
                self.unsubscribe(type(event), func)

    async def _safe_await(
        self,
        coro: Coroutine[Any, Any, Any],
        *,
        func: Callable[..., Any],
        event: BaseEvent,
    ) -> None:
        """Await coroutine and handle any raised exception safely."""
        try:
            await coro
        except Exception as exc:  # noqa: BLE001
            self._handle_exception(exc, func, event)

    # --------------------------------------------------------------------- #
    # Utilities
    # --------------------------------------------------------------------- #

    def _handle_exception(
        self,
        exc: BaseException,
        func: Callable[..., Any],
        event: BaseEvent,
    ) -> None:
        logger.error(
            "Error in listener %s for event %s: %s",
            func,
            event,
            exc,
            exc_info=exc,
        )
        if self._crash_reporter:
            try:
                self._crash_reporter.capture_exception(
                    exc,
                    context={"listener": repr(func), "event": repr(event)},
                )
            except Exception:  # noqa: BLE001
                # Avoid infinite loop if crash reporter crashes
                logger.exception("Crash reporter failed to capture exception")

    def _purge_dead_ref(self, listener_tuple: _ListenerTuple) -> None:
        """Remove dead weak reference from all subscription lists."""
        with self._lock:
            for lst in self._subscribers.values():
                if listener_tuple in lst and listener_tuple.ref() is None:
                    lst.remove(listener_tuple)

    # --------------------------------------------------------------------- #
    # Context manager helpers
    # --------------------------------------------------------------------- #

    def suppress(self, *event_classes: Type[BaseEvent]) -> "EventSuppression":
        """
        Context-manager that temporarily suppresses given *event_classes*.

        Example
        -------
        >>> with event_bus.suppress(QuestCompletedEvent):
        ...     expensive_operation()
        """
        return EventSuppression(self, event_classes)


class EventSuppression:
    """Internal helper for EventBus.suppress()."""

    def __init__(
        self,
        bus: EventBus,
        event_classes: Iterable[Type[BaseEvent]],
    ) -> None:
        self._bus = bus
        self._event_classes: Set[Type[BaseEvent]] = set(event_classes)

    def __enter__(self) -> "EventSuppression":
        self._bus._suppressed.update(self._event_classes)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:  # noqa: D401
        self._bus._suppressed.difference_update(self._event_classes)
        # propagate exceptions
        return False


# --------------------------------------------------------------------------- #
# Decorator helpers
# --------------------------------------------------------------------------- #


def event_listener(
    event_cls: Type[E],
    *,
    priority: int = 0,
    once: bool = False,
    weak: bool = True,
) -> Callable[[Callable[[E], Union[Awaitable[None], None]]], Callable[[E], Any]]:
    """
    Decorator shorthand to auto-subscribe a function or method to the global
    EventBus on import time.
    """

    def decorator(func: Callable[[E], Union[Awaitable[None], None]]) -> Callable[[E], Any]:
        _GLOBAL_BUS.subscribe(
            event_cls, func, weak=weak, priority=priority, once=once
        )
        return func

    return decorator


# --------------------------------------------------------------------------- #
# Singleton accessor
# --------------------------------------------------------------------------- #

_GLOBAL_BUS: EventBus = EventBus()


def get_event_bus() -> EventBus:
    """
    Return the process-wide default EventBus.

    Although a global instance can be considered an anti-pattern, in a mobile
    monolith like QuestSmith it is still pragmatic: all feature modules share
    one bus for performance and low memory usage.  For unit tests, create your
    own `EventBus()` instance instead of using this one.
    """
    return _GLOBAL_BUS


# --------------------------------------------------------------------------- #
# Convenience integration helpers
# --------------------------------------------------------------------------- #

def integrate_crash_reporter(reporter: CrashReporter) -> None:
    """
    Attach a *reporter* (conforming to `CrashReporter`) globally.

    Should be called once during bootstrap right after the reporter factory has
    been resolved, e.g.:

    >>> from src import module_39
    >>> reporter = factories.get_crash_reporter()
    >>> module_39.integrate_crash_reporter(reporter)
    """
    if not isinstance(reporter, CrashReporter.__mro__[0]):  # pragma: no cover
        # Protocols can't be used with isinstance, but we keep runtime check
        # for duck-typing compatibility.
        missing = [
            meth for meth in ("capture_exception",)
            if not hasattr(reporter, meth)
        ]
        if missing:
            raise TypeError(f"Reporter missing methods: {missing}")

    _GLOBAL_BUS._crash_reporter = reporter
    logger.info("Crash reporter %s integrated with EventBus", reporter)


# --------------------------------------------------------------------------- #
# Debug & demonstration
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    # Simple showcase when running as script
    logging.basicConfig(level=logging.DEBUG)

    @event_listener(QuestCompletedEvent, priority=10)
    def announce(event: QuestCompletedEvent) -> None:
        print(f"🎉 Quest {event.quest_id} completed! Reward XP={event.reward_xp}")

    async def main() -> None:
        # Async listener
        @event_listener(QuestCompletedEvent)
        async def analytics_track(event: QuestCompletedEvent) -> None:
            await asyncio.sleep(0.1)  # mimic IO
            print(f"[analytics] tracked quest {event.quest_id}")

        bus = get_event_bus()
        bus.publish(QuestCompletedEvent(quest_id="craft-sword", user_id="u123", reward_xp=50))

    asyncio.run(main())
```