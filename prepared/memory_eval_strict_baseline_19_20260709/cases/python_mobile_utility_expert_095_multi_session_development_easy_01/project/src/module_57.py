```python
"""
src/module_57.py

PrismPocket – Event Stream Bus
==============================

This module implements a production-ready, asynchronous Event Bus that ties
together PrismPocket’s inner “domain” layer with presentation and platform
adapters.  The bus is responsible for:

1. Broadcasting `PrismEvent` objects to interested subscribers (Observer pattern)
2. Persisting events to a durable offline queue when connectivity is lost
3. Replaying queued events once connectivity is restored
4. Recording crashes that arise from subscriber callbacks
5. Emitting analytic breadcrumbs to the in-app metrics service

The implementation purposefully keeps third-party dependencies to a minimum so
that the core can be shipped within the mobile bundle without heavy wheels.

Author: PrismPocket Core Team
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import TracebackType
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Iterable,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Set,
    Tuple,
    Type,
    Union,
)

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism.event_bus")
handler = logging.StreamHandler()
formatter = logging.Formatter(
    "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"
)
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Exception types
# --------------------------------------------------------------------------- #


class EventBusError(RuntimeError):
    """Base class for EventBus exceptions."""


class SubscriberError(EventBusError):
    """Raised when a subscriber raises an unhandled exception."""

    def __init__(
        self,
        subscriber: str,
        event_id: str,
        original_exc: BaseException,
        tb: Optional[TracebackType] = None,
    ) -> None:
        super().__init__(f"Subscriber {subscriber} failed on event {event_id}")
        self.subscriber = subscriber
        self.event_id = event_id
        self.original_exc = original_exc
        self.__traceback__ = tb

    def __str__(self) -> str:  # pragma: no cover
        return (
            f"{super().__str__()} "
            f"({type(self.original_exc).__name__}: {self.original_exc})"
        )


# --------------------------------------------------------------------------- #
# Domain event definitions
# --------------------------------------------------------------------------- #

JsonDict = Dict[str, Any]

# Declared inline for brevity; in a larger codebase, this Enum lives elsewhere.
class EventType(str):
    """Canonical event names dispatched from repositories."""

    CARD_CREATED = "CARD_CREATED"
    CARD_UPDATED = "CARD_UPDATED"
    CARD_DELETED = "CARD_DELETED"
    PALETTE_METRIC = "PALETTE_METRIC"
    REMIX_APPLIED = "REMIX_APPLIED"
    SYNC_SUCCEEDED = "SYNC_SUCCEEDED"
    SYNC_FAILED = "SYNC_FAILED"
    # Add more as required.


@dataclass(frozen=True, slots=True)
class PrismEvent:
    """
    Immutable dataclass describing an event emitted by the domain layer.
    """

    id: str
    type: EventType
    timestamp_ms: int
    payload: JsonDict = field(default_factory=dict)
    meta: JsonDict = field(default_factory=dict)

    # --------------------------------------------------------------------- #
    # Convenience methods
    # --------------------------------------------------------------------- #

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), ensure_ascii=False)

    @staticmethod
    def from_json(data: str) -> "PrismEvent":
        raw = json.loads(data)
        return PrismEvent(**raw)  # type: ignore[arg-type]


class EventFactory:
    """
    Factory for creating events with consistent metadata.  Having a dedicated
    factory makes it trivial to extend event enrichment in the future.
    """

    @staticmethod
    def create(
        event_type: EventType,
        payload: Optional[Mapping[str, Any]] = None,
        *,
        meta: Optional[Mapping[str, Any]] = None,
    ) -> PrismEvent:
        return PrismEvent(
            id=str(uuid.uuid4()),
            type=event_type,
            timestamp_ms=int(time.time() * 1000),
            payload=dict(payload or {}),
            meta=dict(meta or {}),
        )


# --------------------------------------------------------------------------- #
# Repository Pattern – local SQLite queue
# --------------------------------------------------------------------------- #


class _SQLiteConnection(sqlite3.Connection):
    """Typed alias to satisfy mypy/linters."""


class EventLogRepository:
    """
    A lightweight, embedded SQLite repository that stores events that must be
    replayed later when the device regains connectivity.
    """

    _SCHEMA = """
        CREATE TABLE IF NOT EXISTS prism_event_log (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            payload TEXT NOT NULL,
            meta TEXT NOT NULL,
            published INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_published ON prism_event_log (published);
    """

    def __init__(self, db_path: Union[str, Path]) -> None:
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = self._init_db()
        logger.debug("EventLogRepository initialised at %s", self._path)

        # Thread-safety guards for repository mutation from UI / background
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def add(self, event: PrismEvent) -> None:
        with self._locked():
            self._conn.execute(
                """
                INSERT OR IGNORE INTO prism_event_log (
                    id, type, timestamp_ms, payload, meta, published
                ) VALUES (?, ?, ?, ?, ?, 0)
                """,
                (
                    event.id,
                    event.type,
                    event.timestamp_ms,
                    json.dumps(event.payload, separators=(",", ":")),
                    json.dumps(event.meta, separators=(",", ":")),
                ),
            )
            self._conn.commit()
            logger.debug("Event %s persisted to local queue", event.id)

    def mark_published(self, ids: Iterable[str]) -> None:
        id_list = list(ids)
        if not id_list:
            return
        with self._locked():
            self._conn.executemany(
                "UPDATE prism_event_log SET published = 1 WHERE id = ?",
                ((eid,) for eid in id_list),
            )
            self._conn.commit()
            logger.debug("Marked %d events as published", len(id_list))

    def pending_events(self, limit: int | None = None) -> List[PrismEvent]:
        sql = "SELECT id, type, timestamp_ms, payload, meta FROM prism_event_log WHERE published = 0 ORDER BY timestamp_ms"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        with self._locked():
            cur = self._conn.execute(sql)
            rows = cur.fetchall()

        events: List[PrismEvent] = []
        for row in rows:
            payload = json.loads(row[3])
            meta = json.loads(row[4])
            events.append(
                PrismEvent(
                    id=row[0],
                    type=row[1],
                    timestamp_ms=row[2],
                    payload=payload,
                    meta=meta,
                )
            )
        logger.debug("Fetched %d pending events", len(events))
        return events

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _init_db(self) -> _SQLiteConnection:
        conn = sqlite3.connect(
            str(self._path),
            isolation_level=None,  # autocommit mode
            check_same_thread=False,  # allow access across threads
        )
        # Use WAL for concurrent reads/writes
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.executescript(self._SCHEMA)
        return conn  # type: ignore[return-value]

    def _locked(self):  # context manager
        return self._lock


# --------------------------------------------------------------------------- #
# Crash-reporting stub
# --------------------------------------------------------------------------- #


class CrashReporter:
    """
    Adapter stub for the app’s crash-reporting service (e.g. Sentry, Firebase
    Crashlytics).  Here we only log locally to keep the dependency tree thin.
    """

    @staticmethod
    def capture_exception(exc: BaseException) -> None:
        logger.error("Captured exception: %s", exc, exc_info=exc)


# --------------------------------------------------------------------------- #
# Networking stub
# --------------------------------------------------------------------------- #


def has_network_connectivity() -> bool:
    """
    Platform adapter that detects network reachability.
    In production this consults platform APIs; here, always `True`.
    """
    # TODO: replace with platform-specific implementation
    return True


# --------------------------------------------------------------------------- #
# Observer Pattern – central Event Bus (Singleton)
# --------------------------------------------------------------------------- #


Subscriber = Callable[[PrismEvent], Union[Awaitable[None], None]]


class EventBus:
    """
    Thread-safe, asyncio-compatible Event Bus.

    Usage:
    ------
        bus = EventBus.instance()
        bus.subscribe(EventType.CARD_CREATED, handle_created_event)
        await bus.publish(EventFactory.create(EventType.CARD_CREATED, {...}))
    """

    _instance: Optional["EventBus"] = None
    _instance_lock = threading.Lock()  # Guard lazy singleton creation

    # --------------------------------------------------------------------- #
    # Singleton interface
    # --------------------------------------------------------------------- #

    @classmethod
    def instance(cls) -> "EventBus":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # --------------------------------------------------------------------- #
    # Construction
    # --------------------------------------------------------------------- #

    def __init__(self) -> None:
        if EventBus._instance is not None:
            raise RuntimeError("Use EventBus.instance() to access singleton.")

        self._subscribers: MutableMapping[EventType, Set[Subscriber]] = {}
        self._loop: asyncio.AbstractEventLoop = asyncio.get_event_loop()
        # Queue for asynchronous dispatch
        self._dispatch_queue: asyncio.Queue[PrismEvent] = asyncio.Queue()
        # Local persistence
        data_dir = Path.home() / ".prism_pocket"
        data_dir.mkdir(exist_ok=True)
        self._repository = EventLogRepository(data_dir / "events.sqlite3")

        # Start background task only when running inside an event loop
        if self._loop.is_running():
            self._bg_task = self._loop.create_task(self._run_dispatcher())
        else:
            # Defer background task creation; user must call bootstrap_async
            self._bg_task = None

        logger.info("EventBus initialised")

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: EventType, handler: Subscriber) -> None:
        """
        Register a callback (sync or async) for a given event type.
        """
        self._subscribers.setdefault(event_type, set()).add(handler)
        logger.debug("Subscriber %s registered for %s", handler, event_type)

    def unsubscribe(self, event_type: EventType, handler: Subscriber) -> None:
        self._subscribers.get(event_type, set()).discard(handler)
        logger.debug("Subscriber %s removed from %s", handler, event_type)

    async def publish(self, event: PrismEvent, *, persist: bool = True) -> None:
        """
        Public entry-point to push an event into the bus.  Events are first
        persisted locally (unless disabled) and then enqueued for async dispatch.
        """
        if persist:
            self._repository.add(event)

        await self._dispatch_queue.put(event)
        logger.debug("Event %s enqueued for dispatch", event.id)

    def bootstrap_async(self) -> None:
        """
        Initialise background dispatcher from synchronous context.
        """
        if self._loop.is_running():
            return  # Already running within loop
        self._loop.run_until_complete(self._run_startup_tasks())

    # ------------------------------------------------------------------ #
    # Background tasks
    # ------------------------------------------------------------------ #

    async def _run_startup_tasks(self) -> None:
        if self._bg_task is None:
            self._bg_task = self._loop.create_task(self._run_dispatcher())
        await asyncio.sleep(0)  # Yield control

    async def _run_dispatcher(self) -> None:
        """
        The long-living consumer coroutine that reads events from the internal
        queue, delivers them to subscribers, and optionally replays offline
        events when a connection is available.
        """
        logger.debug("Dispatcher task started")
        while True:
            try:
                # First, attempt to replay queued events if wifi/cellular is back
                if has_network_connectivity():
                    await self._flush_offline_queue()

                event = await self._dispatch_queue.get()
                await self._deliver(event)

            except asyncio.CancelledError:
                logger.info("Dispatcher task cancelled")
                break
            except Exception as exc:  # pragma: no cover
                CrashReporter.capture_exception(exc)
                await asyncio.sleep(1)  # back-off to avoid tight error loops

    # ------------------------------------------------------------------ #
    # Delivery helpers
    # ------------------------------------------------------------------ #

    async def _deliver(self, event: PrismEvent) -> None:
        """Fan-out delivery to all subscribers of `event.type`."""
        subscribers = self._subscribers.get(event.type, set()).copy()
        if not subscribers:
            # Uninteresting for current runtime, mark as processed & exit.
            self._repository.mark_published([event.id])
            logger.debug("No subscribers for %s; skipping", event.type)
            return

        tasks: List[Awaitable[None]] = []
        for subscriber in subscribers:
            coro = self._invoke_subscriber(subscriber, event)
            tasks.append(coro)

        # Wait for all subscribers without failing fast; capture errors
        results = await asyncio.gather(*tasks, return_exceptions=True)
        failed_ids: List[str] = []
        for subscriber, res in zip(subscribers, results):
            if isinstance(res, BaseException):
                failed_ids.append(subscriber.__name__)
                CrashReporter.capture_exception(
                    SubscriberError(
                        subscriber=subscriber.__name__,
                        event_id=event.id,
                        original_exc=res,
                        tb=res.__traceback__,
                    )
                )
        if not failed_ids:
            self._repository.mark_published([event.id])

    async def _invoke_subscriber(
        self,
        subscriber: Subscriber,
        event: PrismEvent,
    ) -> None:
        """
        Wrap sync / async subscriber invocation into a coroutine.
        """
        try:
            res = subscriber(event)
            if asyncio.iscoroutine(res):
                await res
        except Exception as exc:
            # Propagate upwards for aggregated error handling
            raise exc

    async def _flush_offline_queue(self) -> None:
        """
        Replay all events persisted in the local queue that were not yet
        delivered to subscribers (e.g., generated while offline).
        """
        pending = self._repository.pending_events(limit=1000)
        if not pending:
            return

        logger.info("Replaying %d offline events", len(pending))
        for event in pending:
            # We *do not* persist again; mark_published will be called later.
            await self._dispatch_queue.put(event)

    # ------------------------------------------------------------------ #
    # Context manager helpers
    # ------------------------------------------------------------------ #

    def __enter__(self) -> "EventBus":
        self.bootstrap_async()
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        if self._bg_task and not self._bg_task.done():
            self._bg_task.cancel()


# --------------------------------------------------------------------------- #
# Example usage (would normally reside in separate modules)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    """
    Quick-n-dirty demo: run `python -m src.module_57` to see the bus in action.

    A proper test suite would simulate async loop conditions; we avoid that
    here to keep the file self-contained.
    """

    async def demo() -> None:
        bus = EventBus.instance()

        async def print_card_created(event: PrismEvent) -> None:
            logger.info("Received event: %s", event.to_json())

        bus.subscribe(EventType.CARD_CREATED, print_card_created)

        # Fire off a few dummy events
        for i in range(3):
            ev = EventFactory.create(
                EventType.CARD_CREATED,
                payload={"index": i, "title": f"Card #{i}"},
            )
            await bus.publish(ev)
            await asyncio.sleep(0.1)

        # Give dispatcher time to process
        await asyncio.sleep(1)

    asyncio.run(demo())
```