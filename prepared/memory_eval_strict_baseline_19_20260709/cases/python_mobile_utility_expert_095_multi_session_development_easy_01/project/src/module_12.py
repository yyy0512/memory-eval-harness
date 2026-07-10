```python
"""
PrismPocket – Event Stream & Analytics Module
=============================================

module_12.py centralises the application-wide asynchronous Observer bus,
an offline persistence queue and a lightweight analytics subscriber that
aggregates colour-palette metrics for newly created / modified prism cards.

Patterns demonstrated
---------------------
• Singleton – EventBus guarantees a single dispatcher per process
• Observer  – Async pub-sub with fine-grained event type filtering
• Repository – OfflineQueueRepository persists events when offline
• Factory    – EventFactory re-hydrates DomainEvent objects from JSON
• MVVM hook  – View-models can subscribe to EventBus for real-time updates

The module is intentionally self-contained so that it can be vendored into
both the mobile clients and the server-side worker stack without requiring
the full source tree.
"""

from __future__ import annotations

import asyncio
import dataclasses
import datetime as _dt
import json
import logging
import pathlib
import sqlite3
import threading
import types
import uuid
from collections import Counter
from contextlib import contextmanager
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    DefaultDict,
    Dict,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Set,
    Type,
    TypeVar,
)

# ---------------------------------------------------------------------------#
# Logging configuration
# ---------------------------------------------------------------------------#
_LOGGER = logging.getLogger("prism_pocket.event_bus")
if not _LOGGER.hasHandlers():
    # Default configuration for standalone execution
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(levelname)s: %(message)s")


# ---------------------------------------------------------------------------#
# Domain Events
# ---------------------------------------------------------------------------#
@dataclasses.dataclass(frozen=True, slots=True)
class DomainEvent:
    """
    Base class for all domain events travelling through the bus.
    """

    id: str
    created_at: str

    def to_json(self) -> str:
        return json.dumps(
            {
                "id": self.id,
                "created_at": self.created_at,
                "type": self.__class__.__name__,
                "payload": dataclasses.asdict(self),
            }
        )


@dataclasses.dataclass(frozen=True, slots=True)
class PrismCardCreated(DomainEvent):
    card_id: str
    user_id: str
    dominant_hex_colour: str
    palette: List[str]


@dataclasses.dataclass(frozen=True, slots=True)
class PrismCardUpdated(DomainEvent):
    card_id: str
    user_id: str
    changed_fields: List[str]
    dominant_hex_colour: str
    palette: List[str]


@dataclasses.dataclass(frozen=True, slots=True)
class RemixSessionStarted(DomainEvent):
    session_id: str
    card_id: str
    user_id: str


# ---------------------------------------------------------------------------#
# Event Factory
# ---------------------------------------------------------------------------#
_T = TypeVar("_T", bound=DomainEvent)


class EventFactory:
    """
    Dedicated factory to re-hydrate DomainEvent objects from a serialised
    representation. Keeps deserialisation logic in one place.
    """

    _registry: Dict[str, Type[DomainEvent]] = {
        cls.__name__: cls
        for cls in (
            PrismCardCreated,
            PrismCardUpdated,
            RemixSessionStarted,
        )
    }

    @classmethod
    def from_json(cls, raw: str) -> DomainEvent:
        data = json.loads(raw)
        event_type = data.get("type")
        payload: Mapping[str, Any] = data.get("payload", {})

        if event_type not in cls._registry:
            raise ValueError(f"Unknown event type '{event_type}'")

        event_cls = cls._registry[event_type]
        return event_cls(**payload)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------#
# Event Bus (Singleton)
# ---------------------------------------------------------------------------#
Subscriber = Callable[[DomainEvent], Awaitable[None]]


class EventBus:
    """
    Thread-safe, asyncio-driven pub-sub bus. Observers may subscribe to one or
    multiple DomainEvent subclasses. Event dispatching is non-blocking.
    """

    _instance: "EventBus" | None = None
    _lock = threading.Lock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    # ------------------------- Public API -------------------------#
    def __init__(self) -> None:
        if hasattr(self, "_initialized"):
            return  # prevent reinitialisation via Singleton
        self._initialized = True

        self._loop = asyncio.get_event_loop()
        self._incoming: "asyncio.Queue[DomainEvent]" = asyncio.Queue()
        self._dispatch_task: Optional[asyncio.Task[None]] = None

        # mapping of event_type -> set(subscriber_coroutine)
        self._subscribers: DefaultDict[
            Type[DomainEvent], Set[Subscriber]
        ] = defaultdict_set()  # noqa: F821

        _LOGGER.debug("EventBus initialised")

    def start(self) -> None:
        """Start the background dispatcher coroutine."""
        if self._dispatch_task is None or self._dispatch_task.done():
            self._dispatch_task = self._loop.create_task(self._dispatcher())
            _LOGGER.info("EventBus dispatcher started")

    def stop(self) -> None:
        """Shutdown the dispatcher gracefully."""
        if self._dispatch_task and not self._dispatch_task.done():
            self._dispatch_task.cancel()
            _LOGGER.info("EventBus dispatcher stopped")

    def subscribe(self, event_type: Type[_T], callback: Subscriber) -> None:
        """
        Subscribe a coroutine callback to a particular DomainEvent subclass.

        Usage:
            async def on_card_created(ev: PrismCardCreated): ...
            EventBus().subscribe(PrismCardCreated, on_card_created)
        """
        if not asyncio.iscoroutinefunction(callback):
            raise TypeError("Subscriber callback must be an async coroutine")
        self._subscribers[event_type].add(callback)
        _LOGGER.debug("Subscriber %s registered for %s", callback, event_type.__name__)

    def unsubscribe(self, event_type: Type[_T], callback: Subscriber) -> None:
        self._subscribers[event_type].discard(callback)
        _LOGGER.debug("Subscriber %s unregistered from %s", callback, event_type.__name__)

    async def publish(self, event: DomainEvent) -> None:
        """Publish an event into the queue (non-blocking)."""
        await self._incoming.put(event)
        _LOGGER.debug("Event queued: %s", event)

    # ---------------------- Internal machinery --------------------#
    async def _dispatcher(self) -> None:
        while True:
            try:
                event = await self._incoming.get()
                await self._notify_subscribers(event)
            except asyncio.CancelledError:
                break
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Error during event dispatch")

    async def _notify_subscribers(self, event: DomainEvent) -> None:
        """
        Fan-out to all interested subscribers. Use gather to run in
        parallel but limit with return_exceptions=True so that 1 bad
        subscriber does not stop the bus.
        """
        tasks: List[Awaitable[Any]] = []
        for etype, subs in self._subscribers.items():
            if isinstance(event, etype):
                for sub in subs:
                    tasks.append(sub(event))

        if not tasks:
            _LOGGER.debug("No subscribers for event %s", type(event).__name__)
            return

        await asyncio.gather(*tasks, return_exceptions=True)


# ---------------------------------------------------------------------------#
# Offline Queue Repository
# ---------------------------------------------------------------------------#
class OfflineQueueRepository:
    """
    Persist events locally (SQLite) when the user is offline so they can be
    replayed later. Thread-safe — connection is confined to a single thread.
    """

    _DB_FILE = pathlib.Path.home() / ".prism_pocket" / "event_queue.db"

    def __init__(self) -> None:
        self._DB_FILE.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._DB_FILE, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS queued_events (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                type TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        self._conn.commit()
        self._lock = threading.Lock()
        _LOGGER.debug("OfflineQueueRepository ready at %s", self._DB_FILE)

    def enqueue(self, event: DomainEvent) -> None:
        """Store event for later replay."""
        with self._lock:
            self._conn.execute(
                """
                INSERT OR IGNORE INTO queued_events (id, created_at, type, payload)
                VALUES (?, ?, ?, ?)
                """,
                (event.id, event.created_at, type(event).__name__, event.to_json()),
            )
            self._conn.commit()
            _LOGGER.info("Event %s enqueued offline", event.id)

    def dequeue_all(self) -> List[DomainEvent]:
        """Return and delete all queued events in FIFO order."""
        with self._lock:
            cursor = self._conn.execute(
                "SELECT payload FROM queued_events ORDER BY created_at ASC"
            )
            rows = cursor.fetchall()
            self._conn.execute("DELETE FROM queued_events")
            self._conn.commit()

        events = []
        for (raw_json,) in rows:
            try:
                events.append(EventFactory.from_json(raw_json))
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Failed to rehydrate event from JSON: %s", raw_json)
        _LOGGER.info("Dequeued %d offline events", len(events))
        return events

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# ---------------------------------------------------------------------------#
# Colour Palette Analytics Aggregator
# ---------------------------------------------------------------------------#
class PaletteMetricAggregator:
    """
    Lightweight subscriber that aggregates most-used colours in real time. The
    results can be pulled by the analytics engine or any interested ViewModel.
    """

    def __init__(self, bus: EventBus) -> None:
        self._counter: Counter[str] = Counter()
        self._bus = bus

        # Subscribe to card creation / update
        bus.subscribe(PrismCardCreated, self._on_card_change)
        bus.subscribe(PrismCardUpdated, self._on_card_change)

    async def _on_card_change(self, event: DomainEvent) -> None:  # noqa: D401
        """
        Handle PrismCardCreated / PrismCardUpdated. Runs on the event loop.
        """
        if isinstance(event, (PrismCardCreated, PrismCardUpdated)):
            _LOGGER.debug("PaletteMetricAggregator received %s", event)
            self._counter.update(event.palette)
            top_three = self._counter.most_common(3)
            # In a real implementation, we'd push this to a remote analytics service.
            _LOGGER.info("Top 3 colours so far: %s", top_three)

    # Expose metrics
    def most_common(self, n: int = 5) -> List[tuple[str, int]]:
        return self._counter.most_common(n)


# ---------------------------------------------------------------------------#
# Bootstrap helpers
# ---------------------------------------------------------------------------#
@contextmanager
def bootstrap_event_system() -> (
    Coroutine[None, None, None]
):  # pragma: no cover – used for runtime side-effects
    """
    Context manager that initialises EventBus, OfflineQueueRepository and
    PaletteMetricAggregator. Attempts to replay any offline events.
    """
    bus = EventBus()
    offline_repo = OfflineQueueRepository()
    aggregator = PaletteMetricAggregator(bus)

    # Start event dispatcher
    bus.start()

    # Replay offline events
    async def _replay() -> None:
        for ev in offline_repo.dequeue_all():
            await bus.publish(ev)

    try:
        # Ensure replay is run on loop
        asyncio.get_event_loop().run_until_complete(_replay())
        yield  # execution returns to caller
    finally:
        bus.stop()
        offline_repo.close()
        # aggregator cleanup not needed — GC handles


# ---------------------------------------------------------------------------#
# Utility functions
# ---------------------------------------------------------------------------#
def _generate_event_id() -> str:
    return uuid.uuid4().hex


def _timestamp() -> str:
    return _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def defaultdict_set() -> DefaultDict[Type[DomainEvent], Set[Subscriber]]:
    from collections import defaultdict

    return defaultdict(set)


# ---------------------------------------------------------------------------#
# Self-test (debug run)
# ---------------------------------------------------------------------------#
if __name__ == "__main__":
    """
    Quick manual test:
    python -m src.module_12
    """
    import random
    import sys

    async def demo() -> None:
        bus = EventBus()

        # example subscriber
        async def print_event(ev: DomainEvent) -> None:
            _LOGGER.info("print_event subscriber saw: %s", ev)

        bus.subscribe(PrismCardCreated, print_event)

        # publish some events
        for _ in range(5):
            palette = [f"#{random.randint(0, 0xFFFFFF):06x}" for _ in range(3)]
            ev = PrismCardCreated(
                id=_generate_event_id(),
                created_at=_timestamp(),
                card_id=_generate_event_id(),
                user_id="demo_user",
                dominant_hex_colour=palette[0],
                palette=palette,
            )
            await bus.publish(ev)

        # Give the dispatcher time to flush
        await asyncio.sleep(1)

    with bootstrap_event_system():
        try:
            asyncio.run(demo())
        except KeyboardInterrupt:
            sys.exit(0)
```