```python
"""
src/module_61.py
PrismPocket – Mobile Utility
-------------------------------------------------
A thread–safe, async–aware Observer bus that streams domain
events (PrismEvent) from repositories to view-models.  The bus
is responsible for:

• Subscription management (fine-grained by event type)
• Offline queuing of network-sensitive events
• Transparent replay when connectivity is restored
• Support for both synchronous and asynchronous observers
• Persistence of the queue in a lightweight SQLite store

The implementation purposefully avoids any framework-specific
dependencies so that it can run unchanged on iOS, Android and
desktop Python environments.

Usage example
-------------
>>> from module_61 import PrismEventBus, PrismEvent, PrismEventType
>>>
>>> bus = PrismEventBus()
>>>
>>> class Logger:
...     def update(self, event):            # sync observer
...         print("SYNC:", event)
...
...     async def aupdate(self, event):     # async observer
...         print("ASYNC:", event)
...
>>> logger = Logger()
>>> bus.subscribe(logger, {PrismEventType.CARD_CREATED})
>>>
>>> bus.publish(
...     PrismEvent(event_type=PrismEventType.CARD_CREATED,
...                payload={'id': 'abc123'},
...                requires_network=True)
... )

Whenever `bus.network_online` flips from False to True, queued
events are flushed automatically.
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Any, Dict, Iterable, MutableMapping, Optional, Protocol, Set

######################################################################
# Domain primitives
######################################################################


class PrismEventType(Enum):
    """Enumerates all domain-level events that can flow through the bus."""

    CARD_CREATED = auto()
    CARD_UPDATED = auto()
    CARD_DELETED = auto()
    SYNC_COMPLETED = auto()
    ANALYTIC_DATA_READY = auto()
    NETWORK_STATUS_CHANGED = auto()
    USER_LOGGED_IN = auto()


@dataclass(frozen=True)
class PrismEvent:
    """
    Immutable event object emitted by *repositories* and consumed by
    *view-models* or other observers.
    """

    event_type: PrismEventType
    payload: Dict[str, Any]
    timestamp: float = field(default_factory=time.time)
    correlation_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    requires_network: bool = False

    # -----------------------------------------------------------------
    # (De)serialization helpers
    # -----------------------------------------------------------------
    def to_json(self) -> str:
        """Return a JSON representation suitable for persistence."""
        return json.dumps(
            asdict(self),
            default=str,  # ensures bytes, datetime, etc. do not break
            separators=(",", ":"),
        )

    @staticmethod
    def from_json(data: str) -> "PrismEvent":
        """Re-hydrate an event from its JSON form."""
        mapping = json.loads(data)
        mapping["event_type"] = PrismEventType[mapping["event_type"]]
        return PrismEvent(**mapping)


######################################################################
# Observer protocols – for static type-checking only
######################################################################


class SyncObserver(Protocol):
    """Synchronous observer contract."""

    def update(self, event: PrismEvent) -> None: ...


class AsyncObserver(Protocol):
    """Asynchronous observer contract."""

    async def aupdate(self, event: PrismEvent) -> None: ...


######################################################################
# SQLite-backed queue for offline events
######################################################################


class _EventQueueRepository:
    """
    Lightweight event queue backed by SQLite.  Only a single table is
    needed because events are self-describing JSON blobs.
    """

    _DB_FILE = Path(os.getenv("PRISM_DB_PATH", Path.home() / ".prism_event_queue.db"))
    _DDL = """
    CREATE TABLE IF NOT EXISTS event_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        json_blob   TEXT NOT NULL
    );
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self._DB_FILE, check_same_thread=False)
        self._conn.execute(self._DDL)
        self._conn.commit()

    def enqueue(self, event: PrismEvent) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO event_queue (json_blob) VALUES (?)", (event.to_json(),)
            )

    def dequeue_all(self) -> Iterable[PrismEvent]:
        with self._lock, self._conn:
            cursor = self._conn.execute("SELECT id, json_blob FROM event_queue")
            rows = cursor.fetchall()
            ids_to_delete = []
            events = []
            for row_id, blob in rows:
                try:
                    events.append(PrismEvent.from_json(blob))
                    ids_to_delete.append((row_id,))
                except Exception:
                    # Corrupted row; delete it to avoid infinite loops
                    ids_to_delete.append((row_id,))
            self._conn.executemany("DELETE FROM event_queue WHERE id = ?", ids_to_delete)
            self._conn.commit()
            return events

    def close(self) -> None:
        with self._lock:
            self._conn.close()


######################################################################
# Singleton metaclass for the bus
######################################################################


class _SingletonMeta(type):
    """Thread-safe singleton base."""

    _instances: Dict[type, "PrismEventBus"] = {}
    _meta_lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        with cls._meta_lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)
                cls._instances[cls] = instance
        return cls._instances[cls]


######################################################################
# Event bus implementation
######################################################################


class PrismEventBus(metaclass=_SingletonMeta):
    """
    Central event dispatcher (Singleton).  Acts as the “Observable” in
    the Observer pattern.  Consumers can be either synchronous or
    asynchronous; the bus will do the right thing for each.
    """

    # ---------------------------------------------------------------
    # Construction & state
    # ---------------------------------------------------------------
    def __init__(self) -> None:
        self._sync_registry: MutableMapping[PrismEventType, Set[SyncObserver]] = {}
        self._async_registry: MutableMapping[PrismEventType, Set[AsyncObserver]] = {}
        self._generic_sync: Set[SyncObserver] = set()
        self._generic_async: Set[AsyncObserver] = set()

        self._queue_repo = _EventQueueRepository()

        self._lock = threading.RLock()
        self._network_online: bool = True

        # Async loop detection (for mobile, there’s usually one)
        self._loop = self._ensure_event_loop()

    # ---------------------------------------------------------------
    # Subscription management
    # ---------------------------------------------------------------
    def subscribe(
        self,
        observer: SyncObserver | AsyncObserver,
        event_types: Optional[Set[PrismEventType]] = None,
    ) -> None:
        """
        Register an observer.  If `event_types` is None, the observer
        will receive *all* events (catch-all subscription).
        """
        with self._lock:
            if asyncio.iscoroutinefunction(getattr(observer, "aupdate", None)):
                self._add_observer(observer, event_types, async_=True)
            elif callable(getattr(observer, "update", None)):
                self._add_observer(observer, event_types, async_=False)
            else:
                raise TypeError(
                    "Observer must implement `update` or async `aupdate` method."
                )

    def unsubscribe(
        self,
        observer: SyncObserver | AsyncObserver,
        event_types: Optional[Set[PrismEventType]] = None,
    ) -> None:
        """
        Unregister an observer, either from specific event types or
        completely.
        """
        with self._lock:
            registries = (
                (self._sync_registry, self._generic_sync),
                (self._async_registry, self._generic_async),
            )
            for registry, generic in registries:
                if event_types is None:
                    generic.discard(observer)  # remove from generic set
                    for obs_set in registry.values():
                        obs_set.discard(observer)
                else:
                    for et in event_types:
                        registry.get(et, set()).discard(observer)

    # ---------------------------------------------------------------
    # Publishing
    # ---------------------------------------------------------------
    def publish(self, event: PrismEvent) -> None:
        """
        Dispatch an event to all relevant observers OR queue it if
        the device is offline and the event requires network.
        """
        if event.requires_network and not self.network_online:
            self._queue_repo.enqueue(event)
            return

        # Dispatch asynchronously to avoid blocking producer thread
        asyncio.run_coroutine_threadsafe(
            self._notify_observers(event), loop=self._loop
        )

    # ---------------------------------------------------------------
    # Properties
    # ---------------------------------------------------------------
    @property
    def network_online(self) -> bool:
        """Current connectivity flag."""
        return self._network_online

    @network_online.setter
    def network_online(self, value: bool) -> None:
        if value != self._network_online:
            self._network_online = value
            # Emit a system event about the change
            self.publish(
                PrismEvent(
                    event_type=PrismEventType.NETWORK_STATUS_CHANGED,
                    payload={"online": value},
                    requires_network=False,
                )
            )
            if value:  # We just came back online.  Flush queue.
                for queued_event in self._queue_repo.dequeue_all():
                    self.publish(queued_event)

    # ---------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------
    def _add_observer(
        self,
        observer: SyncObserver | AsyncObserver,
        event_types: Optional[Set[PrismEventType]],
        *,
        async_: bool,
    ) -> None:
        """Housekeeping robot for `subscribe`."""
        target_registry = (
            self._async_registry if async_ else self._sync_registry
        )  # type: ignore[assignment]

        if event_types is None:  # catch-all
            target_generic = self._generic_async if async_ else self._generic_sync
            target_generic.add(observer)  # type: ignore[arg-type]
            return

        for et in event_types:
            target_registry.setdefault(et, set()).add(observer)  # type: ignore[arg-type]

    async def _notify_observers(self, event: PrismEvent) -> None:
        """
        Fan-out an event to:

        1. Generic observers (subscribed to all event types)
        2. Observers subscribed to the specific event_type
        """
        sync_targets: Set[SyncObserver] = set(self._generic_sync)
        sync_targets |= self._sync_registry.get(event.event_type, set())

        async_targets: Set[AsyncObserver] = set(self._generic_async)
        async_targets |= self._async_registry.get(event.event_type, set())

        # Notify synchronous observers (in executor to avoid blocking)
        loop = asyncio.get_event_loop()
        for obs in sync_targets:
            await loop.run_in_executor(None, self._safe_call, obs.update, event)

        # Notify asynchronous observers concurrently
        await asyncio.gather(
            *[self._safe_acall(obs.aupdate, event) for obs in async_targets],
            return_exceptions=True,
        )

    @staticmethod
    def _safe_call(fn, *args, **kwargs) -> None:
        """Wrap observer calls with blanket error handling."""
        try:
            fn(*args, **kwargs)
        except Exception as exc:  # pragma: no cover – log framework hook
            # Placeholder for crash-reporting integration
            print(f"[PrismEventBus] Observer error (sync): {exc}")

    @staticmethod
    async def _safe_acall(fn, *args, **kwargs) -> None:
        """Async version of `_safe_call`."""
        try:
            await fn(*args, **kwargs)
        except Exception as exc:
            print(f"[PrismEventBus] Observer error (async): {exc}")

    # ---------------------------------------------------------------
    # Event loop bootstrap
    # ---------------------------------------------------------------
    @staticmethod
    def _ensure_event_loop() -> asyncio.AbstractEventLoop:
        """
        Android / iOS embedding frameworks often do not run the main
        interpreter thread in an event loop.  This utility creates a
        *dedicated* loop in a background thread if necessary.
        """
        try:
            loop = asyncio.get_running_loop()
            return loop
        except RuntimeError:
            # No running loop – spawn one in a daemon thread
            loop = asyncio.new_event_loop()
            threading.Thread(
                target=loop.run_forever, daemon=True, name="PrismEventLoop"
            ).start()
            return loop

    # ---------------------------------------------------------------
    # Tear-down (useful for unit tests)
    # ---------------------------------------------------------------
    def close(self) -> None:
        """Shutdown the bus and its resources."""
        self._queue_repo.close()
        # Do NOT stop the event loop because other modules might use it.


######################################################################
# Convenience functions – public API
######################################################################

# Default singleton instance exported for ergonomic imports.
default_bus = PrismEventBus()

__all__ = [
    "PrismEventBus",
    "default_bus",
    "PrismEvent",
    "PrismEventType",
]
```
