```python
"""
PrismPocket – Event Bus (Observer + Singleton)

This module provides a production-ready, asyncio-driven event-bus that
implements the Observer pattern while persisting outbound events to an
on-device SQLite journal for guaranteed delivery when the device is
offline.  The bus is envisioned as the spinal cord connecting domain
repositories, view-models, and native adapters.

Design goals
------------
1. Singleton: A single, lazily-instantiated bus per process.
2. Back-pressure: asyncio.Queue with configurable capacity.
3. Persistence: Lightweight SQLite append-only log.
4. Resilience: Automatic replay of undelivered events on start-up and
   whenever connectivity is regained.
5. Type-safety: mypy-friendly Protocols and dataclasses.

Usage
-----
>>> bus = PrismEventBus()
>>> sub = bus.subscribe(MyObserver(), {EventType.CARD_CREATED})
>>> await bus.emit(PrismEvent(type=EventType.CARD_CREATED, payload={"id": "abc"}))
>>> sub.dispose()  # Unsubscribe
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum, auto
from pathlib import Path
from types import TracebackType
from typing import (
    Any,
    AsyncIterator,
    Dict,
    Iterable,
    Mapping,
    MutableMapping,
    Optional,
    Protocol,
    Set,
    Tuple,
    Type,
    Union,
    final,
    runtime_checkable,
)
from weakref import WeakSet

__all__: Tuple[str, ...] = (
    "EventType",
    "PrismEvent",
    "Observer",
    "Subscription",
    "PrismEventBus",
)

###############################################################################
# Logging
###############################################################################

logger = logging.getLogger("prism_pocket.event_bus")
logger.addHandler(logging.NullHandler())

###############################################################################
# Domain Event Definitions
###############################################################################


class EventType(Enum):
    """Domain-level events surfaced across application layers."""

    CARD_CREATED = auto()
    CARD_UPDATED = auto()
    CARD_DELETED = auto()
    SYNC_COMPLETED = auto()
    ANALYTICS_READY = auto()
    APP_FOREGROUNDED = auto()
    APP_BACKGROUNDED = auto()


@dataclass(frozen=True, slots=True)
class PrismEvent:
    """A serializable domain event."""

    type: EventType
    payload: Mapping[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    occurred_at: datetime = field(
        default_factory=lambda: datetime.now(tz=timezone.utc)
    )
    # The `delivered` flag is *not* part of equality/hash checks and is
    # included solely for persistence bookkeeping.
    delivered: bool = field(default=False, compare=False)


###############################################################################
# Observer Protocol & Subscription
###############################################################################

@runtime_checkable
class Observer(Protocol):
    """Observers must be awaitable callables or provide an async handler."""

    async def handle_event(self, event: PrismEvent) -> None:  # noqa: D401
        """
        Handle a `PrismEvent`.
        This coroutine must not block; heavy processing must be offloaded
        to background tasks or executors.
        """


class Subscription:
    """A disposable handle returned to observers when they subscribe."""

    __slots__ = ("_bus", "_observer")

    def __init__(self, bus: "PrismEventBus", observer: Observer) -> None:
        self._bus = bus
        self._observer = observer

    def dispose(self) -> None:
        """Unregister the underlying observer."""
        self._bus.unsubscribe(self._observer)

    # Convenience context-manager sugar
    def __enter__(self) -> "Subscription":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.dispose()


###############################################################################
# Event Bus (Singleton)
###############################################################################

_DEFAULT_QUEUE_CAPACITY = 1_024
_REPLAY_INTERVAL_SEC = 5


@final
class PrismEventBus:
    """
    A cross-layer, asyncio-powered event bus.

    Instantiation follows the Borg (monostate) pattern to guarantee that all
    instances share the same internal state *without* preventing GC in unit
    tests (unlike a hard Singleton metaclass).
    """

    _shared_state: MutableMapping[str, Any] = {}

    # --------------------------------------------------------------------- #
    # Init & Borg singleton wiring
    # --------------------------------------------------------------------- #

    def __init__(self, queue_capacity: int = _DEFAULT_QUEUE_CAPACITY) -> None:
        self.__dict__ = self._shared_state  # Borg magic

        if getattr(self, "_initialized", False):  # pragma: no cover
            return

        self._queue: asyncio.Queue[PrismEvent] = asyncio.Queue(queue_capacity)
        self._observers: Dict[
            Optional[EventType], "WeakSet[Observer]"
        ] = {}  # Key == None -> wildcard observers
        self._loop = asyncio.get_running_loop()
        self._db_path = _get_persistence_path()
        _init_sqlite_schema(self._db_path)
        self._dispatcher_task: Optional["asyncio.Task[None]"] = None
        self._replay_task: Optional["asyncio.Task[None]"] = None
        self._closed: bool = False

        # Fire up background workers
        self._start_background_tasks()

        self._initialized = True

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(
        self,
        observer: Observer,
        event_types: Optional[Iterable[EventType]] = None,
    ) -> Subscription:
        """
        Subscribe an observer to one or many event types.

        If `event_types` is `None`, the observer receives *all* events.
        """
        keyset: Set[Optional[EventType]] = (
            {None} if event_types is None else set(event_types)
        )
        for key in keyset:
            bucket = self._observers.setdefault(key, WeakSet())
            bucket.add(observer)
        logger.debug("Observer %s subscribed to %s", observer, keyset)
        return Subscription(self, observer)

    def unsubscribe(self, observer: Observer) -> None:
        """Unregister an observer from all topics."""
        removed = False
        for bucket in self._observers.values():
            if observer in bucket:
                bucket.discard(observer)
                removed = True
        if removed:
            logger.debug("Observer %s unsubscribed", observer)

    async def emit(self, event: PrismEvent) -> None:
        """
        Publish an event to the bus.

        The event is *persisted first*, then queued.  This guarantees that
        crashes between emit() and dispatch do not drop messages.
        """
        if self._closed:
            raise RuntimeError("Event bus has been closed.")
        _persist_event(self._db_path, event)
        await self._queue.put(event)
        logger.debug("Event queued: %s", event)

    async def close(self) -> None:
        """
        Gracefully shutdown the bus, flushing queues and cancelling tasks.
        """
        self._closed = True
        if self._dispatcher_task:
            await self._queue.join()  # Wait until all messages processed
            self._dispatcher_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._dispatcher_task

        if self._replay_task:
            self._replay_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._replay_task

    # --------------------------------------------------------------------- #
    # Internals – dispatcher & replay
    # --------------------------------------------------------------------- #

    def _start_background_tasks(self) -> None:
        self._dispatcher_task = self._loop.create_task(self._dispatcher())
        self._replay_task = self._loop.create_task(self._replay_worker())
        logger.debug("Background tasks started.")

    async def _dispatcher(self) -> None:  # noqa: C901
        """
        Continuously pull events off the queue and notify observers.

        This coroutine never exits unless cancelled from `close()`.
        """
        while True:
            event = await self._queue.get()
            logger.debug("Dispatching event: %s", event)

            # Snapshot the relevant observer set to avoid mutation during
            # iteration; wildcard observers receive all events.
            observers: Set[Observer] = set(
                self._observers.get(event.type, ())) | set(
                self._observers.get(None, ())
            )

            # Dispatch concurrently but with bounded fan-out.
            await self._notify_all(event, observers)

            # Mark as delivered in the journal.
            _mark_event_delivered(self._db_path, event.id)

            self._queue.task_done()

    async def _notify_all(
        self, event: PrismEvent, observers: Set[Observer]
    ) -> None:
        if not observers:
            logger.debug("No observers for event %s", event.type)
            return

        async def _safe_call(obs: Observer) -> None:
            try:
                await obs.handle_event(event)
            except Exception:  # pragma: no cover
                logger.exception("Observer %s crashed on %s", obs, event)

        await asyncio.gather(*(_safe_call(o) for o in observers))

    async def _replay_worker(self) -> None:
        """
        Periodically replay undelivered events from the SQLite journal.

        This ensures at-least-once delivery even after crashes or offline
        periods.
        """
        while True:
            undelivered = _load_undelivered_events(self._db_path)
            if undelivered:
                logger.info("Replaying %d undelivered events", len(undelivered))
            for event in undelivered:
                await self._queue.put(event)
            await asyncio.sleep(_REPLAY_INTERVAL_SEC)


###############################################################################
# Persistence helpers
###############################################################################

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS prism_event (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    delivered   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_delivered ON prism_event (delivered);
"""


def _get_persistence_path() -> Path:
    base_dir = Path.home() / ".prism_pocket"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir / "event_journal.sqlite3"


def _init_sqlite_schema(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(_SCHEMA_SQL)
    logger.debug("SQLite schema ensured at %s", path)


def _persist_event(path: Path, event: PrismEvent) -> None:
    with sqlite3.connect(path) as conn, conn:
        conn.execute(
            "INSERT OR IGNORE INTO prism_event "
            "(id, type, payload, occurred_at, delivered) "
            "VALUES (?, ?, ?, ?, 0)",
            (
                event.id,
                event.type.name,
                json.dumps(event.payload, default=_json_default),
                event.occurred_at.isoformat(),
            ),
        )
    logger.debug("Event persisted: %s", event.id)


def _mark_event_delivered(path: Path, event_id: str) -> None:
    with sqlite3.connect(path) as conn, conn:
        conn.execute(
            "UPDATE prism_event SET delivered=1 WHERE id=?",
            (event_id,),
        )


def _load_undelivered_events(path: Path) -> Tuple[PrismEvent, ...]:
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT id, type, payload, occurred_at FROM prism_event "
            "WHERE delivered=0 ORDER BY occurred_at ASC"
        ).fetchall()

    events: list[PrismEvent] = []
    for event_id, type_name, payload_json, ts in rows:
        try:
            event = PrismEvent(
                id=event_id,
                type=EventType[type_name],
                payload=json.loads(payload_json),
                occurred_at=datetime.fromisoformat(ts),
                delivered=False,
            )
            events.append(event)
        except Exception:  # Corrupt row; skip but log
            logger.exception("Failed to deserialize event row %s", event_id)
            _mark_event_delivered(path, event_id)
    return tuple(events)


def _json_default(obj: Any) -> Union[str, int, float]:
    """Fallback JSON serializer."""
    if isinstance(obj, Enum):
        return obj.name
    if isinstance(obj, (datetime,)):
        return obj.isoformat()
    return str(obj)


###############################################################################
# Convenience context manager
###############################################################################

@asynccontextmanager
async def open_bus(
    queue_capacity: int = _DEFAULT_QUEUE_CAPACITY,
) -> AsyncIterator[PrismEventBus]:
    """
    Async context manager that yields a bus and ensures graceful teardown.

    Useful in REPL sessions or ad-hoc scripts.

    Example
    -------
    >>> async with open_bus() as bus:
    ...     await bus.emit(PrismEvent(type=EventType.APP_FOREGROUNDED))
    """
    bus = PrismEventBus(queue_capacity)
    try:
        yield bus
    finally:
        await bus.close()


###############################################################################
# Example Observer implementation (optional)
###############################################################################

class _DiagnosticObserver:
    """
    Simple observer that logs all incoming events.
    Intended only for debugging and smoke testing.
    """

    async def handle_event(self, event: PrismEvent) -> None:
        logger.info("🎨 DiagnosticObserver received: %s", asdict(event))


# ------------------------------------------------------------------------- #
# When executed as a script, start a demo that emits a test event every 3 s.
# ------------------------------------------------------------------------- #

async def _demo() -> None:  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    async with open_bus() as bus:
        bus.subscribe(_DiagnosticObserver())  # wildcard listening
        idx = 0
        while idx < 5:  # emit 5 events then exit
            await bus.emit(
                PrismEvent(
                    type=EventType.CARD_CREATED,
                    payload={"demo_index": idx},
                )
            )
            idx += 1
            await asyncio.sleep(3)


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(_demo())
```