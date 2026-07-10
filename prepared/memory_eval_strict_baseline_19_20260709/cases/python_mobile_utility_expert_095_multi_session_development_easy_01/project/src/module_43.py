```python
"""
PrismPocket: module_43.py
-------------------------------------------------
Analytics event pipeline (offline-aware, observer-friendly).

This module centralises the generation, persistence, and delivery of analytics
events produced by the mobile clients.  It combines several architecture
patterns used throughout the PrismPocket code-base:

1. Singleton:
   `PersistentQueue` guarantees a single instance of the on-device
   event queue backed by SQLite.

2. Factory Pattern:
   `AnalyticsDispatcherFactory` allows swap-in of a mock dispatcher for
   tests or a different transport (e.g. gRPC vs. REST).

3. Observer Pattern:
   Any component interested in the lifecycle of analytics events can
   register an `AnalyticsObserver`.

The code is intentionally platform-agnostic (pure Python) and can therefore be
executed unchanged under both iOS (via Pyto/PySide) and Android (via BeeWare/
Chaquopy).  All I/O is non-blocking thanks to asyncio + httpx.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import sys
import time
import uuid
import weakref
from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, Iterable, List, Optional, Protocol, Sequence, Set, Type

import httpx
from platformdirs import user_data_dir

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG if __debug__ else logging.INFO)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(
    logging.Formatter("[%(levelname)s] %(name)s :: %(message)s")
)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class AnalyticsEvent:
    """
    Immutable representation of a domain-level analytics event.
    """

    name: str
    payload: Dict[str, Any]
    version: str = "1.0"
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    ts_epoch_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_json(self) -> str:
        """Serialise the event to JSON (ASCII safe)."""
        return json.dumps(asdict(self), ensure_ascii=True, separators=(",", ":"))


# --------------------------------------------------------------------------- #
# Persistence layer (Singleton)
# --------------------------------------------------------------------------- #


class PersistentQueue:  # noqa: WPS110
    """
    Durable FIFO queue backed by SQLite.

    Guarantees exactly-once append semantics; removal occurs only after the
    consumer (dispatcher) explicitly acknowledges delivery.
    """

    _INSTANCE: Optional["PersistentQueue"] = None
    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS event_queue (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        body TEXT NOT NULL
    );
    """

    def __new__(cls, db_path: Optional[Path] = None):  # noqa: D401
        if cls._INSTANCE is None:
            cls._INSTANCE = super().__new__(cls)
            cls._INSTANCE._initialise(db_path)
        return cls._INSTANCE

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def enqueue(self, event: AnalyticsEvent) -> None:
        logger.debug("Enqueuing event %s", event.event_id)
        with self._conn:
            self._conn.execute(
                "INSERT OR IGNORE INTO event_queue (id, created_at, body) VALUES (?, ?, ?)",
                (event.event_id, event.ts_epoch_ms, event.to_json()),
            )

    def peek_batch(self, limit: int = 50) -> List[AnalyticsEvent]:
        cur = self._conn.cursor()
        cur.execute(
            "SELECT body FROM event_queue ORDER BY created_at ASC LIMIT ?", (limit,)
        )
        rows = cur.fetchall()
        logger.debug("Peeked %d events from queue", len(rows))
        return [AnalyticsEvent(**json.loads(row[0])) for row in rows]

    def delete_events(self, ids: Sequence[str]) -> None:
        if not ids:
            return
        logger.debug("Deleting %d events from queue", len(ids))
        with self._conn:
            self._conn.executemany(
                "DELETE FROM event_queue WHERE id = ?", [(evt_id,) for evt_id in ids]
            )

    @property
    def size(self) -> int:
        cur = self._conn.cursor()
        cur.execute("SELECT COUNT(*) FROM event_queue")
        count: int = cur.fetchone()[0]
        return count

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    def _initialise(self, db_path: Optional[Path]) -> None:
        if db_path is None:
            db_path = Path(user_data_dir("PrismPocket", "PrismLabs")) / "analytics.sqlite"
        logger.debug("Initialising PersistentQueue at %s", db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            db_path.as_posix(),
            detect_types=sqlite3.PARSE_DECLTYPES,
            check_same_thread=False,
        )
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute(self._SCHEMA)
        self._conn.commit()


# --------------------------------------------------------------------------- #
# Observer Pattern
# --------------------------------------------------------------------------- #


class AnalyticsObserver(Protocol):
    """
    Observer interface that components can implement to get notified
    of analytics event status changes.
    """

    async def on_events_dispatched(self, events: Sequence[AnalyticsEvent]) -> None: ...


# --------------------------------------------------------------------------- #
# Dispatcher
# --------------------------------------------------------------------------- #


class AnalyticsDispatcher:
    """
    Asynchronous dispatcher that flushes queued events to the cloud endpoint.

    Key responsibilities:
    * Throttle network usage via batching and backoffs
    * Notify registered observers after successful dispatch
    * Persist events in case of transient network failures
    """

    _BATCH_SIZE = 50
    _POST_ENDPOINT = "https://api.prismpocket.app/v1/telemetry/events"

    def __init__(
        self,
        queue: PersistentQueue,
        http_client: Optional[httpx.AsyncClient] = None,
        retry_backoff: float = 5.0,
    ) -> None:
        self._queue = queue
        self._http = http_client or httpx.AsyncClient(timeout=10)
        self._retry_backoff = retry_backoff
        self._observers: Set[weakref.ReferenceType[AnalyticsObserver]] = set()
        self._is_running = False
        self._loop_task: Optional[asyncio.Task[None]] = None

    # --------------------------------------------------------------------- #
    # Observer management
    # --------------------------------------------------------------------- #

    def register(self, observer: AnalyticsObserver) -> None:
        logger.debug("Registering analytics observer %s", observer)
        self._observers.add(weakref.ref(observer))

    def unregister(self, observer: AnalyticsObserver) -> None:
        logger.debug("Unregistering analytics observer %s", observer)
        self._observers = {ref for ref in self._observers if ref() is not observer}

    async def _notify(self, events: Sequence[AnalyticsEvent]) -> None:
        dead: List[weakref.ReferenceType[AnalyticsObserver]] = []
        for ref in self._observers:
            obs = ref()
            if obs is None:
                dead.append(ref)
            else:
                try:
                    await obs.on_events_dispatched(events)
                except Exception:  # pragma: no cover
                    logger.exception("Observer %s failed during callback", obs)
        self._observers.difference_update(dead)

    # --------------------------------------------------------------------- #
    # Lifecycle
    # --------------------------------------------------------------------- #

    def start(self) -> None:
        if not self._is_running:
            logger.info("Starting analytics dispatcher loop")
            self._is_running = True
            self._loop_task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if not self._is_running:
            return
        logger.info("Stopping analytics dispatcher loop")
        self._is_running = False
        if self._loop_task:  # pragma: no cover
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        await self._http.aclose()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def track_event(self, event: AnalyticsEvent) -> None:
        self._queue.enqueue(event)

    # --------------------------------------------------------------------- #
    # Internal loop
    # --------------------------------------------------------------------- #

    async def _run_loop(self) -> None:  # noqa: C901
        backoff = self._retry_backoff
        while self._is_running:
            batch = self._queue.peek_batch(self._BATCH_SIZE)
            if not batch:
                await asyncio.sleep(1)
                continue

            payload = [asdict(evt) for evt in batch]
            logger.debug("Dispatching batch of %d events", len(batch))
            try:
                response = await self._http.post(
                    self._POST_ENDPOINT, json=payload, timeout=10
                )
            except (httpx.NetworkError, httpx.TimeoutException) as exc:
                logger.warning(
                    "Network error while sending analytics: %s. Backing off %.1fs",
                    exc,
                    backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)  # Cap backoff at 1 min
                continue
            except Exception:  # pragma: no cover
                logger.exception("Unexpected error while sending analytics")
                await asyncio.sleep(backoff)
                continue

            if 200 <= response.status_code < 300:
                ids = [evt.event_id for evt in batch]
                self._queue.delete_events(ids)
                await self._notify(batch)
                backoff = self._retry_backoff  # Reset backoff on success
                logger.debug("Successfully dispatched %d events", len(batch))
            else:
                logger.warning(
                    "Server responded with %s; will retry after %.1fs",
                    response.status_code,
                    backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    # --------------------------------------------------------------------- #
    # Context manager helpers
    # --------------------------------------------------------------------- #

    async def __aenter__(self) -> "AnalyticsDispatcher":
        self.start()
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> bool:
        await self.stop()
        return False  # propagate exception if any


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #


class AnalyticsDispatcherFactory:
    """
    Factory for obtaining an AnalyticsDispatcher with environment-specific
    configuration.  This makes it easy to create a test-double or to inject
    custom HTTP clients (e.g., with proxy settings).
    """

    @staticmethod
    def create(
        *,
        offline: bool = False,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> AnalyticsDispatcher:
        queue = PersistentQueue()
        if offline:
            # Local testing – do not hit remote endpoint
            http_client = http_client or httpx.AsyncClient(
                transport=httpx.MockTransport(lambda request: httpx.Response(204))
            )
        dispatcher = AnalyticsDispatcher(queue, http_client=http_client)
        return dispatcher


# --------------------------------------------------------------------------- #
# Example usage (only executed when running this file directly)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    async def _demo() -> None:
        dispatcher = AnalyticsDispatcherFactory.create(offline=True)

        # Simulate event ingestion
        dispatcher.track_event(
            AnalyticsEvent(
                name="card_created",
                payload={"palette": ["#FF00FF", "#00FFFF"], "mood": "vibrant"},
            )
        )

        async with dispatcher:
            # Keep the loop running for a short while to demonstrate dispatch
            await asyncio.sleep(2)

        print("Remaining events in queue:", dispatcher._queue.size)

    asyncio.run(_demo())

```