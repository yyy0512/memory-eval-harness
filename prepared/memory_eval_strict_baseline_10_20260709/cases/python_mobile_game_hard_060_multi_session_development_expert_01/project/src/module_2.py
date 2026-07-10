```python
"""
src/module_2.py

QuestSmith – Productivity RPG Forge
-----------------------------------
Observer/Event-Bus implementation used across the entire mobile code-base.
Keeps UI widgets, analytics engine, notification service, etc. in sync by
broadcasting domain events in a decoupled fashion.

Highlights
~~~~~~~~~~
* Weak-reference subscription to avoid memory leaks in Kivy’s dynamic scene-graph
* Optional one-shot & async delivery
* Automatic exception capture via injected CrashReporter factory
* Context-manager & decorator helpers for ergonomic usage
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import sys
import types
import weakref
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from functools import wraps
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Generic,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Tuple,
    Type,
    TypeVar,
    Union,
    overload,
)

# ------------------------------------------------------------------------------
# Crash-reporting integration (Factory Pattern)
# ------------------------------------------------------------------------------

class CrashReporterProtocol(Protocol):
    """Minimal surface expected from crash-reporting providers."""

    def capture_exception(self, exc: BaseException, *, context: Optional[dict] = None) -> None: ...


class _NoOpCrashReporter:
    """Default fallback when no provider is configured."""

    def capture_exception(self, exc: BaseException, *, context: Optional[dict] = None) -> None:  # noqa: D401
        logging.getLogger(__name__).debug("CrashReporter not configured, swallowed: %s", exc, exc_info=exc)


# Will be overwritten by the platform adapter at bootstrap time.
_crash_reporter: CrashReporterProtocol = _NoOpCrashReporter()


def set_crash_reporter(provider: CrashReporterProtocol) -> None:
    """Inject a concrete crash reporter at run-time.

    Should be called once from the platform bootstrap.
    """
    global _crash_reporter
    _crash_reporter = provider


# ------------------------------------------------------------------------------
# Domain events
# ------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class DomainEvent:
    """Base-class for strongly-typed domain events."""
    timestamp: datetime = datetime.utcnow()


class QuestState(Enum):
    """Finite-state machine for quest lifecycle."""
    PENDING = auto()
    ACTIVE = auto()
    COMPLETED = auto()
    FAILED = auto()
    ARCHIVED = auto()


@dataclass(frozen=True, slots=True)
class QuestStatusChanged(DomainEvent):
    quest_id: str
    old_state: QuestState
    new_state: QuestState
    gained_xp: int = 0
    gained_currency: int = 0


@dataclass(frozen=True, slots=True)
class UserAuthenticated(DomainEvent):
    user_id: str
    using_biometric: bool


@dataclass(frozen=True, slots=True)
class PushNotificationRequested(DomainEvent):
    user_id: str
    title: str
    message: str
    scheduled_time: Optional[datetime] = None


# ------------------------------------------------------------------------------
# Event Bus (Observer Pattern)
# ------------------------------------------------------------------------------

T = TypeVar("T", bound=DomainEvent)
ListenerFn = Callable[[T], Union[None, Awaitable[None]]]


class _Listener(Generic[T]):
    """Internal helper representing a single listener registration."""

    __slots__ = ("event_type", "_fn_ref", "run_async", "once")

    def __init__(self, event_type: Type[T], fn: ListenerFn[T], *, run_async: bool, once: bool, weak: bool) -> None:
        self.event_type: Type[T] = event_type
        self.run_async: bool = run_async
        self.once: bool = once
        # Store weak or strong reference
        if weak:
            self._fn_ref = weakref.WeakMethod(fn) if inspect.ismethod(fn) else weakref.ref(fn)  # type: ignore[arg-type]
        else:
            self._fn_ref = lambda: fn  # type: ignore[return-value]

    def get(self) -> Optional[ListenerFn[T]]:
        return self._fn_ref()


class EventBus:
    """Central publish/subscribe hub with lightweight semantics suitable for mobile."""

    _listeners: MutableMapping[Type[DomainEvent], List[_Listener]]

    def __init__(self, *, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        self._listeners = {}
        self._loop = loop or asyncio.get_event_loop()
        self._logger = logging.getLogger(self.__class__.__name__)

    # ---- Subscription API ----------------------------------------------------

    def subscribe(
        self,
        event_type: Type[T],
        listener: ListenerFn[T],
        *,
        weak: bool = True,
        run_async: bool = False,
        once: bool = False,
    ) -> None:
        """Register a listener for *event_type*.

        Params
        ------
        event_type:
            Dataclass deriving from DomainEvent.
        listener:
            Callable receiving an instance of `event_type`. May be async.
        weak:
            Store a weak reference. Recommended for instance methods in Kivy widgets.
        run_async:
            Deliver event via `asyncio.create_task`, returning immediately.
        once:
            Deregister automatically after first invocation.
        """
        if not issubclass(event_type, DomainEvent):
            raise TypeError("event_type must subclass DomainEvent")

        if event_type not in self._listeners:
            self._listeners[event_type] = []

        # Prevent duplicate registration of same (event_type, listener)
        if any(l.get() is listener for l in self._listeners[event_type]):
            self._logger.debug("Listener already registered, skipping: %s", listener)
            return

        self._listeners[event_type].append(_Listener(event_type, listener, run_async=run_async, once=once, weak=weak))
        self._logger.debug("Subscribed %s to %s", listener, event_type.__name__)

    def unsubscribe(self, event_type: Type[T], listener: ListenerFn[T]) -> None:
        """Remove a previously registered listener."""
        if event_type not in self._listeners:
            return
        self._listeners[event_type] = [l for l in self._listeners[event_type] if l.get() is not listener]
        self._logger.debug("Unsubscribed %s from %s", listener, event_type.__name__)

    def clear(self) -> None:
        """Remove ALL listeners from the bus—primarily for test isolation."""
        self._listeners.clear()
        self._logger.debug("Cleared all listeners")

    # ---- Publishing API ------------------------------------------------------

    def publish(self, event: DomainEvent) -> None:
        """Synchronously/Asynchronously dispatch an event to interested listeners."""
        listeners = list(self._listeners.get(type(event), []))  # Copy to avoid mutation during iteration
        to_remove: List[_Listener] = []

        for wrapper in listeners:
            fn = wrapper.get()
            if fn is None:
                to_remove.append(wrapper)  # Auto-cleanup GC’ed weakref
                continue

            try:
                if wrapper.run_async or asyncio.iscoroutinefunction(fn):
                    # Schedule coroutine on configured loop
                    self._loop.create_task(self._safe_invoke_async(fn, event))
                else:
                    fn(event)  # type: ignore[arg-type]
            except Exception as exc:  # noqa: BLE001
                _crash_reporter.capture_exception(exc, context={"event": repr(event), "listener": repr(fn)})
                self._logger.exception("Error while dispatching %s to %s", event, fn)

            if wrapper.once:
                to_remove.append(wrapper)

        # Remove zombie or one-shot listeners
        for wrapper in to_remove:
            self._listeners[type(event)].remove(wrapper)

    async def _safe_invoke_async(self, fn: ListenerFn[T], event: DomainEvent) -> None:
        """Wrap coroutine invocation with error capture."""
        try:
            await fn(event)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001
            _crash_reporter.capture_exception(exc, context={"event": repr(event), "listener": repr(fn)})
            self._logger.exception("Async listener crashed: %s", fn)

    # ---- Convenience helpers -------------------------------------------------

    @contextmanager
    def temporary_subscription(
        self,
        event_type: Type[T],
        listener: ListenerFn[T],
        *,
        weak: bool = True,
        run_async: bool = False,
    ) -> Iterable[None]:
        """Context-manager that subscribes for the duration of the `with` block."""
        self.subscribe(event_type, listener, weak=weak, run_async=run_async)
        try:
            yield
        finally:
            self.unsubscribe(event_type, listener)

    def listener(
        self,
        *event_types: Type[DomainEvent],
        weak: bool = True,
        run_async: bool = False,
        once: bool = False,
    ) -> Callable[[ListenerFn[Any]], ListenerFn[Any]]:
        """Decorator for effortless registration.

        Example
        -------
        >>> @global_bus.listener(QuestStatusChanged)
        ... def on_quest_update(event: QuestStatusChanged): ...
        """

        def decorator(fn: ListenerFn[Any]) -> ListenerFn[Any]:
            for event_t in event_types:
                self.subscribe(event_t, fn, weak=weak, run_async=run_async, once=once)
            return fn

        return decorator


# ------------------------------------------------------------------------------
# Global app-wide bus instance
# ------------------------------------------------------------------------------

global_bus = EventBus()

# ------------------------------------------------------------------------------
# Example usage during bootstrap (will be removed by optimizer in final build)
# ------------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG, stream=sys.stdout)

    # ------------------------------------------------------------------
    # 1️⃣  Inject a dummy crash reporter
    # ------------------------------------------------------------------
    class _PrintCrashReporter:  # noqa: D401
        def capture_exception(self, exc: BaseException, *, context: Optional[dict] = None) -> None:
            print("🚨 Crash captured:", exc, "CTX:", context)

    set_crash_reporter(_PrintCrashReporter())

    # ------------------------------------------------------------------
    # 2️⃣  Register sample listeners
    # ------------------------------------------------------------------
    @global_bus.listener(QuestStatusChanged)
    def log_quest_change(evt: QuestStatusChanged) -> None:
        print(f"[SYNC] Quest {evt.quest_id} moved to {evt.new_state.name}")

    @global_bus.listener(QuestStatusChanged, run_async=True)
    async def async_listener(evt: QuestStatusChanged) -> None:
        await asyncio.sleep(0.1)
        print(f"[ASYNC] XP gained: {evt.gained_xp}")

    # ------------------------------------------------------------------
    # 3️⃣  Fire test event
    # ------------------------------------------------------------------
    global_bus.publish(
        QuestStatusChanged(
            quest_id="slay-the-beast",
            old_state=QuestState.ACTIVE,
            new_state=QuestState.COMPLETED,
            gained_xp=50,
            gained_currency=10,
        )
    )

    # Keep loop alive long enough for async delivery
    asyncio.get_event_loop().run_until_complete(asyncio.sleep(0.2))
```