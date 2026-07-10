```python
"""
QuestSmith – Event Bus (Observer Pattern)
=========================================

This module implements a light-weight, production-grade event bus that is used
throughout the QuestSmith code-base to propagate domain events (e.g. quest
completion, adaptive-difficulty adjustments, push-notification triggers, crash
reports, etc.) in a thread-safe and memory-safe way.

Key features
------------
• Observer pattern with automatic weak-reference management to avoid leaks  
• Thread-safe, re-entrant publish / subscribe operations (RLock based)  
• Supports both sync and async (coroutine) listeners transparently  
• Context manager to batch / delay events (transaction-style)  
• DeadEvent hook for analytics / debugging when an event has no subscribers  

Typical usage
-------------
>>> from src.module_30 import EventBus, BaseEvent
>>>
>>> class QuestCompleted(BaseEvent): ...
>>> bus = EventBus.get_global_bus()
>>> bus.subscribe(QuestCompleted, lambda e: print("GG!"))
>>> bus.publish(QuestCompleted(source="quest_engine", payload={"id": 42}))
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import weakref
from collections import defaultdict
from contextlib import contextmanager
from types import TracebackType
from typing import (
    Any,
    Callable,
    DefaultDict,
    Dict,
    Generic,
    Iterable,
    List,
    Optional,
    Protocol,
    Set,
    Tuple,
    Type,
    TypeVar,
    Union,
)

# --------------------------------------------------------------------------- #
# Type helpers
# --------------------------------------------------------------------------- #
T_evt = TypeVar("T_evt", bound="BaseEvent")
SyncListener = Callable[[T_evt], None]
AsyncListener = Callable[[T_evt], "asyncio.Future[Any]"]
AnyListener = Union[SyncListener[T_evt], AsyncListener[T_evt]]

_LOG = logging.getLogger("questsmith.eventbus")
_LOG.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Event primitives
# --------------------------------------------------------------------------- #


class BaseEvent:
    """
    All events dispatched through the EventBus should inherit from this class.

    Parameters
    ----------
    source:
        The subsystem / component where the event originated.
    payload:
        Additional data associated with the event.  Should only contain
        JSON-serialisable primitives to ease logging and analytics.
    """

    __slots__ = ("source", "payload", "_cancelled")

    def __init__(self, source: str, payload: Optional[Dict[str, Any]] = None) -> None:
        self.source: str = source
        self.payload: Dict[str, Any] = payload or {}
        self._cancelled: bool = False

    # --------------------------------------------------------------------- #
    # Life-cycle helpers
    # --------------------------------------------------------------------- #

    @property
    def cancelled(self) -> bool:
        """Whether subsequent listeners should receive the event."""
        return self._cancelled

    def cancel(self) -> None:
        """Mark the event as consumed; later listeners won’t be invoked."""
        self._cancelled = True

    # --------------------------------------------------------------------- #
    # Debugging helpers
    # --------------------------------------------------------------------- #

    def __repr__(self) -> str:  # pragma: no cover
        classname = self.__class__.__name__
        return f"{classname}(source={self.source!r}, payload={self.payload!r})"


class DeadEvent(BaseEvent):
    """
    Fired when a posted event has *no* listeners.

    Useful for analytics, debugging and ensuring coverage of important
    business events.
    """

    __slots__ = ("orphaned_event",)

    def __init__(self, orphaned_event: BaseEvent) -> None:
        super().__init__(source="event_bus.internal", payload={"type": type(orphaned_event).__name__})
        self.orphaned_event: BaseEvent = orphaned_event


# --------------------------------------------------------------------------- #
# Listener wrapper
# --------------------------------------------------------------------------- #


class _Listener(Generic[T_evt]):
    """
    Internal descriptor that wraps a subscriber to provide:

    • Weak reference (instance + func) to avoid leaks
    • Comparable / hashable so we can store in a set
    • Quick introspection whether it’s async
    """

    __slots__ = ("_ref", "_hash", "is_async")

    def __init__(self, func: AnyListener[T_evt]) -> None:
        # We need to support three cases:
        #   • Plain function
        #   • Bound method
        #   • functools.partial / callable object
        try:
            self._ref = weakref.WeakMethod(func)  # type: ignore[arg-type]
            self._hash = hash((self._ref(), func.__name__))  # type: ignore[attr-defined]
        except TypeError:
            # Not a method → fallback to weakref.ref
            self._ref = weakref.ref(func)
            self._hash = hash(func)

        self.is_async: bool = asyncio.iscoroutinefunction(func)  # type: ignore[arg-type]

    # --------------------------------------------------------------------- #
    # Callable proxy
    # --------------------------------------------------------------------- #

    def __call__(self, event: T_evt) -> Any:
        func = self._ref()
        if func is None:
            raise ReferenceError("Listener gone out of scope")
        return func(event)

    # --------------------------------------------------------------------- #
    # Hash / equality so we can easily `in` / remove listeners
    # --------------------------------------------------------------------- #

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, _Listener):
            return NotImplemented
        return self._hash == other._hash

    def __hash__(self) -> int:  # noqa: D401  (simple-function-name)
        return self._hash

    # --------------------------------------------------------------------- #
    # House-keeping
    # --------------------------------------------------------------------- #

    @property
    def alive(self) -> bool:
        """Return ``False`` if the referenced listener has been GC-ed."""
        return self._ref() is not None


# --------------------------------------------------------------------------- #
# EventBus
# --------------------------------------------------------------------------- #


class EventBus:
    """
    Thread-safe, weak-ref based Observer implementation.

    Raises
    ------
    ValueError
        If attempting to subscribe a non-callable.
    """

    # NOTE: We expose a *global* bus for convenience while still allowing
    #       clients to instantiate isolated buses for testing.
    _GLOBAL: Optional["EventBus"] = None
    _lock: threading.RLock

    # --------------------------------------------------------------------- #
    # Construction helpers
    # --------------------------------------------------------------------- #

    def __init__(self) -> None:
        self._listeners: DefaultDict[Type[BaseEvent], Set[_Listener[Any]]] = defaultdict(set)
        self._deferred_events: List[BaseEvent] = []
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # API (public)
    # --------------------------------------------------------------------- #

    # -- Subscription ------------------------------------------------------ #

    def subscribe(self, event_cls: Type[T_evt], listener: AnyListener[T_evt]) -> None:
        """
        Register a listener for a given event class (or subclass).

        Duplicate registrations are ignored.  Returns ``None`` on success.

        Notes
        -----
        • A weak reference is kept; when the listener is garbage-collected,
          it will silently disappear from the bus.
        """
        if not callable(listener):
            raise ValueError("Listener must be callable")

        wrapper = _Listener(listener)

        with self._lock:
            if wrapper in self._listeners[event_cls]:
                _LOG.debug("Ignoring duplicate listener for %s: %s", event_cls.__name__, listener)
                return
            self._listeners[event_cls].add(wrapper)
            _LOG.debug("Subscribed %s to %s", listener, event_cls.__name__)

    def unsubscribe(self, event_cls: Type[T_evt], listener: AnyListener[T_evt]) -> None:
        """
        Remove a previously subscribed listener.

        No-op if the listener was not registered.
        """
        wrapper = _Listener(listener)  # produce same hash
        with self._lock:
            self._listeners[event_cls].discard(wrapper)
            _LOG.debug("Unsubscribed %s from %s", listener, event_cls.__name__)

    # -- Publication ------------------------------------------------------- #

    def publish(self, event: BaseEvent) -> None:
        """
        Dispatch an event to all listeners (respecting inheritance).

        Async listeners are scheduled onto the current running event-loop,
        falling back to `asyncio.get_event_loop()` if necessary.

        Listeners added / removed during execution do *not* affect the
        iteration, ensuring deterministic delivery.
        """
        listeners = self._collect_listeners(type(event))
        if not listeners:
            # Nobody cared → fire DeadEvent for introspection
            if not isinstance(event, DeadEvent):
                self.publish(DeadEvent(event))
            return

        for listener in listeners:
            if event.cancelled:
                _LOG.debug("Event %s cancelled – stopping propagation.", event)
                break
            try:
                if listener.is_async:
                    self._dispatch_async(listener, event)  # type: ignore[arg-type]
                else:
                    listener(event)  # type: ignore[arg-type]
            except Exception:  # pragma: no cover
                _LOG.exception("Exception while notifying listener %s", listener)

    # -- Context manager: batch publishing --------------------------------- #

    @contextmanager
    def batch(self) -> "Iterable[None]":
        """
        Context manager that defers event propagation until *after* the
        enclosed block exits.  Useful to avoid UI thrashing when performing
        bulk updates inside the Repository layer, for example.

        Example
        -------
        >>> with bus.batch():
        >>>     for quest in updated_quests:
        >>>         bus.publish(QuestUpdated(...))
        """
        try:
            self._push_deferred_state()
            yield
        finally:
            self._flush_deferred_events()
            self._pop_deferred_state()

    # -- Diagnostics ------------------------------------------------------- #

    def active_listener_count(self) -> int:
        """Return the number of *alive* listeners registered."""
        with self._lock:
            return sum(1 for s in self._listeners.values() for lst in s if lst.alive)

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _collect_listeners(self, event_cls: Type[BaseEvent]) -> Tuple[_Listener[Any], ...]:
        """
        Collect all listeners registered for `event_cls` or any of its bases,
        pruning stale weak references on-the-fly.
        """
        with self._lock:
            result: Set[_Listener[Any]] = set()
            for cls, listeners in self._listeners.items():
                if issubclass(event_cls, cls):
                    # Filter out dead refs
                    living = {lst for lst in listeners if lst.alive}
                    if len(living) < len(listeners):
                        listeners.intersection_update(living)  # prune
                    result.update(living)
        return tuple(result)

    # -- Async dispatch ---------------------------------------------------- #

    def _dispatch_async(self, listener: _Listener[Any], event: BaseEvent) -> None:
        coro = listener(event)  # type: ignore[func-returns-value]
        if not inspect.isawaitable(coro):
            _LOG.warning(
                "Expected coroutine from async listener %s, got %r – executing synchronously.",
                listener,
                coro,
            )
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.get_event_loop()
        loop.create_task(coro)  # fire-and-forget

    # -- Deferred (batch mode) -------------------------------------------- #

    _DEFER_FLAG = threading.local()

    def _push_deferred_state(self) -> None:
        setattr(self._DEFER_FLAG, "active", True)

    def _pop_deferred_state(self) -> None:
        setattr(self._DEFER_FLAG, "active", False)

    def _is_batching(self) -> bool:
        return bool(getattr(self._DEFER_FLAG, "active", False))

    def _flush_deferred_events(self) -> None:
        if not self._deferred_events:
            return
        buffered = self._deferred_events[:]
        self._deferred_events.clear()
        for ev in buffered:
            self.publish(ev)

    # --------------------------------------------------------------------- #
    # Class-level helpers
    # --------------------------------------------------------------------- #

    @classmethod
    def get_global_bus(cls) -> "EventBus":
        """
        Return the singleton global event buses.  Lazily initialised.
        """
        if cls._GLOBAL is None:
            cls._GLOBAL = cls()
        return cls._GLOBAL

    # --------------------------------------------------------------------- #
    # Proxy static helpers for convenience
    # --------------------------------------------------------------------- #

    @staticmethod
    def subscribe_global(event_cls: Type[T_evt], listener: AnyListener[T_evt]) -> None:
        EventBus.get_global_bus().subscribe(event_cls, listener)

    @staticmethod
    def publish_global(event: BaseEvent) -> None:
        bus = EventBus.get_global_bus()
        if bus._is_batching():
            bus._deferred_events.append(event)
        else:
            bus.publish(event)


# --------------------------------------------------------------------------- #
# Decorators (sugar syntax)
# --------------------------------------------------------------------------- #


def subscriber(event_cls: Type[T_evt]) -> Callable[[AnyListener[T_evt]], AnyListener[T_evt]]:
    """
    Decorator that automatically subscribes the function to the global bus.

    Example
    -------
    >>> @subscriber(QuestCompleted)
    >>> def grant_loot(event): ...
    """

    def _decorator(func: AnyListener[T_evt]) -> AnyListener[T_evt]:
        EventBus.subscribe_global(event_cls, func)
        return func

    return _decorator


# --------------------------------------------------------------------------- #
# Built-in listener: dead event logger
# --------------------------------------------------------------------------- #


@subscriber(DeadEvent)
def _log_dead_event(event: DeadEvent) -> None:  # pragma: no cover
    _LOG.warning("DeadEvent – no listeners for %s", event.orphaned_event)


# --------------------------------------------------------------------------- #
# Self-test (only executed when run as a script)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    class Foo(BaseEvent):
        pass

    bus = EventBus.get_global_bus()

    @subscriber(Foo)
    async def async_listener(e: Foo):
        await asyncio.sleep(0.1)
        print("async:", e)

    @subscriber(Foo)
    def sync_listener(e: Foo):
        print("sync:", e)
        # Cancel to test propagation
        e.cancel()

    with bus.batch():
        for i in range(3):
            EventBus.publish_global(Foo(source="test", payload={"i": i}))

    # give async tasks time to finish
    asyncio.get_event_loop().run_until_complete(asyncio.sleep(0.2))
```