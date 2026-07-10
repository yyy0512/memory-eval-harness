```python
"""
QuestSmith – Event System & Persistence Layer
---------------------------------------------

This module provides a production–ready implementation of a **thread-safe
observer/event-bus with persistent event logging**.  It demonstrates three of
the architectural patterns used across the QuestSmith code-base:

1. Observer Pattern   – loosely‐coupled, in-process publish/subscribe.
2. Repository Pattern – pluggable persistence for event journaling (SQLite).
3. Factory  Pattern   – late binding of repository implementation.

The public API is intentionally minimal so that it can be imported almost
anywhere in the application without creating circular dependencies.

Typical usage
~~~~~~~~~~~~~
>>> from src.module_7 import (
...     EventBus, QuestStatusChangeEvent, event_listener, RepositoryFactory
... )
...
>>> # wire up a persistent repository (mobile uses a WAL-backed SQLite db)
>>> EventBus.set_repository(RepositoryFactory.sqlite('~/questsmith.db'))
>>> bus = EventBus.get_default()
>>>
>>> @event_listener(QuestStatusChangeEvent)  # decorator syntactic sugar
... def on_quest_update(evt: QuestStatusChangeEvent):
...     print("Quest", evt.quest_id, "is now", evt.new_status)
...
>>> bus.publish(QuestStatusChangeEvent('abc-123', new_status='COMPLETED'))
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Type, TypeVar

try:
    # Kivy is available on the mobile build; desktop unit-tests may not install it.
    from kivy.clock import Clock  # type: ignore
except ImportError:  # pragma: no cover
    # Fallback shim for environments without Kivy
    class _FakeClock:  # noqa: D401
        @staticmethod
        def schedule_once(func, _dt=0):
            func(0)

    Clock = _FakeClock()  # type: ignore

LOGGER = logging.getLogger("questsmith.event_bus")
LOGGER.addHandler(logging.NullHandler())

T_Event = TypeVar("T_Event", bound="BaseEvent")
Listener = Callable[[T_Event], None]


# ------------------------------------------------------------------------------
# Domain Events
# ------------------------------------------------------------------------------


@dataclass(slots=True, frozen=True)
class BaseEvent:
    """
    Base-class for domain events flowing through the EventBus.

    Each event gets an RFC-4122 v4 id and millisecond-precision timestamp
    when instantiated, allowing for accurate offline journaling/replay.
    """

    # Generated server-side if we ever send events over the wire
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    # Epoch milliseconds
    ts: int = field(default_factory=lambda: int(time.time() * 1_000))

    def type_name(self) -> str:
        """
        Returns the canonical dotted path used as the *topic* on the EventBus.
        """
        return f"{self.__class__.__module__}.{self.__class__.__qualname__}"


@dataclass(slots=True, frozen=True)
class QuestStatusChangeEvent(BaseEvent):
    """
    Raised whenever a quest transitions from one state to another (e.g.,
    ACTIVE -> COMPLETED, FAILED -> RETRY, etc.).
    """

    quest_id: str
    new_status: str
    previous_status: Optional[str] = None


# ------------------------------------------------------------------------------
# Repository Pattern – pluggable persistence
# ------------------------------------------------------------------------------


class EventRepository(ABC):
    """
    Defines a minimal contract for writing events.  Reading/replaying is **not**
    required by the mobile app and can be added later without breaking changes.
    """

    @abstractmethod
    def save(self, evt: BaseEvent) -> None:  # pragma: no cover
        """
        Persist the supplied event atomically or raise an exception.
        """


class SQLiteEventRepository(EventRepository):
    """
    Naïve but reliable SQLite-based implementation.  The database is opened in
    `check_same_thread=False` mode so that the EventBus can use a global
    instance across any thread that publishes.
    """

    _DDL: str = """
        CREATE TABLE IF NOT EXISTS events (
            event_id       TEXT PRIMARY KEY,
            ts             INTEGER NOT NULL,
            type_name      TEXT NOT NULL,
            payload        TEXT NOT NULL
        );
    """

    def __init__(self, path: str | os.PathLike, use_wal: bool = True) -> None:
        self._path = Path(path).expanduser().resolve()
        self._conn = sqlite3.connect(
            self._path, check_same_thread=False, isolation_level=None
        )  # autocommit
        self._conn.execute(self._DDL)
        if use_wal:
            # WAL improves concurrency on mobile devices
            self._conn.execute("PRAGMA journal_mode=WAL;")

        self._lock = threading.RLock()
        LOGGER.debug("SQLiteEventRepository initialised at %s", self._path)

    @contextmanager
    def _cursor(self) -> sqlite3.Cursor:  # pragma: no cover
        """
        Context-managed cursor that rolls back on error.
        """
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    def save(self, evt: BaseEvent) -> None:
        payload = json.dumps(asdict(evt), ensure_ascii=False)
        with self._cursor() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO events(event_id, ts, type_name, payload) "
                "VALUES (?, ?, ?, ?);",
                (evt.event_id, evt.ts, evt.type_name(), payload),
            )
        LOGGER.debug("Persisted event %s to SQLite", evt.event_id)


class RepositoryFactory:
    """
    Provides a simple, compile-time configurable factory for repositories.
    Approaches that rely on reflection or config files are avoided to keep the
    mobile build small and secure.
    """

    @staticmethod
    def sqlite(path: str | os.PathLike, *, use_wal: bool = True) -> EventRepository:
        return SQLiteEventRepository(path, use_wal=use_wal)


# ------------------------------------------------------------------------------
# Observer Pattern – thread-safe event bus
# ------------------------------------------------------------------------------


class EventBus:
    """
    Thread-safe, in-process publish/subscribe with optional event persistence and
    delivery on the Kivy main loop.

    The EventBus is intentionally *not* a singleton to retain testability, but a
    convenience class-method `get_default()` is provided.
    """

    _default_instance: Optional["EventBus"] = None
    _default_lock = threading.Lock()

    def __init__(
        self,
        repository: Optional[EventRepository] = None,
        *,
        dispatch_in_ui_thread: bool = True,
    ) -> None:
        self._listeners: Dict[str, List[Listener]] = {}
        self._listeners_lock = threading.RLock()
        self._repository = repository
        self._dispatch_in_ui_thread = dispatch_in_ui_thread
        LOGGER.debug("EventBus created (repo=%s)", type(repository).__name__)

    # ..........................................................................
    # Public API
    # ..........................................................................

    @classmethod
    def set_repository(cls, repo: EventRepository) -> None:
        """
        Assigns (or replaces) the repository for the **default** EventBus.
        """
        LOGGER.debug("Default EventBus repository set to %s", type(repo).__name__)
        cls.get_default()._repository = repo

    @classmethod
    def get_default(cls) -> "EventBus":
        """
        Lazily creates and returns a process-wide EventBus instance.
        """
        if cls._default_instance is None:
            with cls._default_lock:
                if cls._default_instance is None:
                    cls._default_instance = cls()
        return cls._default_instance

    def subscribe(self, event_cls: Type[T_Event], listener: Listener[T_Event]) -> None:
        """
        Registers a callable to receive all events whose type is exactly
        `event_cls`. Duplicate registration is ignored.
        """
        topic = f"{event_cls.__module__}.{event_cls.__qualname__}"
        with self._listeners_lock:
            self._listeners.setdefault(topic, [])
            if listener not in self._listeners[topic]:
                self._listeners[topic].append(listener)
                LOGGER.debug("Listener %s subscribed to %s", listener, topic)

    def unsubscribe(
        self, event_cls: Type[T_Event], listener: Listener[T_Event]
    ) -> None:
        """
        Removes the callable from the subscription list.  Noop if it wasn't
        registered.
        """
        topic = f"{event_cls.__module__}.{event_cls.__qualname__}"
        with self._listeners_lock:
            try:
                self._listeners.get(topic, []).remove(listener)
                LOGGER.debug("Listener %s unsubscribed from %s", listener, topic)
            except ValueError:
                pass  # not subscribed – silently ignore

    def publish(self, evt: T_Event) -> None:
        """
        Publishes an event to all interested listeners **and** persists it via
        the configured repository (if any).  Persistence happens first to avoid
        event loss should a listener crash.
        """
        if self._repository is not None:
            try:
                self._repository.save(evt)
            except Exception:  # pragma: no cover
                LOGGER.exception("Failed to persist event %s", evt.type_name())

        # Snapshot listener list to avoid locking during delivery
        listeners = self._listeners_for(evt)
        if not listeners:
            return

        LOGGER.debug(
            "Dispatching event %s (%d listener%s)",
            evt.type_name(),
            len(listeners),
            "s" if len(listeners) != 1 else "",
        )

        if self._dispatch_in_ui_thread:
            # Kivy requires UI interactions to happen on its main thread
            Clock.schedule_once(lambda _dt: self._deliver(evt, listeners), 0)
        else:
            self._deliver(evt, listeners)

    # ..........................................................................
    # Internals
    # ..........................................................................

    def _listeners_for(self, evt: BaseEvent) -> List[Listener]:
        with self._listeners_lock:
            # Shallow copy to protect against modification during iteration
            return list(self._listeners.get(evt.type_name(), []))

    @staticmethod
    def _deliver(evt: BaseEvent, listeners: List[Listener]) -> None:
        """
        Delivers the event to each listener, protecting the bus against
        uncaught exceptions in consumer code so that one faulty listener does
        not break the chain.
        """
        for listener in listeners:
            try:
                listener(evt)  # type: ignore[arg-type]
            except Exception:  # pragma: no cover
                LOGGER.exception(
                    "Unhandled exception in listener %s for %s",
                    listener,
                    evt.type_name(),
                )


# ------------------------------------------------------------------------------
# Convenience decorator for compile-time safety
# ------------------------------------------------------------------------------


def event_listener(event_cls: Type[T_Event]) -> Callable[[Listener[T_Event]], Listener[T_Event]]:
    """
    Decorator that automatically subscribes the decorated function to the
    default EventBus and returns the original function unmodified.

    Example
    -------
    >>> @event_listener(QuestStatusChangeEvent)
    ... def handler(evt): ...
    """

    def decorator(func: Listener[T_Event]) -> Listener[T_Event]:
        EventBus.get_default().subscribe(event_cls, func)
        return func

    return decorator
```