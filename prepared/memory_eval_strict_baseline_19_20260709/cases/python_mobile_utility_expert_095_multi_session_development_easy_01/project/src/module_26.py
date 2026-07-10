"""
src/module_26.py

PrismPocket – PrismAnalyticsService
-----------------------------------
A production-quality analytics pipeline that fits PrismPocket’s Clean
Architecture guidelines while remaining self-contained for this example.

Responsibilities
================
1. Capture analytics events produced by domain layers.
2. Persist events locally (SQLite) for offline durability.
3. Stream events to presentation layer via an observer bus.
4. Flush events to a platform-specific backend adapter.
5. Report unexpected errors to CrashReporter.

Patterns Demonstrated
=====================
• Singleton (PrismAnalyticsService, EventBus)
• Observer (EventBus ➜ subscribers)
• Factory (AnalyticsAdapterFactory)
• Repository (AnalyticsEventRepository)
• Adapter (AnalyticsAdapter subclasses)

The module is intentionally dependency-light; external SDK calls are mocked
behind adapters so that importing this file will not fail in isolation.
"""

from __future__ import annotations

import abc
import asyncio
import json
import logging
import os
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, MutableMapping, Optional, Protocol

# -----------------------------------------------------------------------------
# Configuration / Constants
# -----------------------------------------------------------------------------

DATABASE_PATH = Path.home() / ".prism_pocket" / "analytics.db"
FLUSH_INTERVAL_SEC = 10  # background flush cadence
BATCH_SIZE = 25          # events per upload request
EVENT_TTL_DAYS = 30      # purge local events older than this
LOGGER = logging.getLogger("prism.analytics")
LOGGER.setLevel(logging.INFO)


# -----------------------------------------------------------------------------
# Crash Reporting Stub (Adapter pattern simplified)
# -----------------------------------------------------------------------------

class CrashReporter:
    """
    Thin wrapper around a crash reporting SDK.  Replaces the real SDK in this
    stand-alone example but preserves the public surface.
    """

    @staticmethod
    def record_exception(exc: Exception) -> None:
        LOGGER.error("CrashReporter captured exception:", exc_info=exc)


# -----------------------------------------------------------------------------
# Domain / DTO layer
# -----------------------------------------------------------------------------

@dataclass(slots=True)
class AnalyticsEvent:
    """
    An immutable representation of an analytics event ready for persistence
    or transport to the backend.
    """
    event_id: str
    name: str
    payload: Dict[str, Any]
    ts_epoch_ms: int = field(default_factory=lambda: int(time.time() * 1_000))

    @classmethod
    def create(cls, name: str, payload: Optional[Dict[str, Any]] = None) -> "AnalyticsEvent":
        return cls(
            event_id=str(uuid.uuid4()),
            name=name,
            payload=payload or {}
        )


# -----------------------------------------------------------------------------
# Observer pattern for in-app live analytics (e.g., heatmaps on remix canvas)
# -----------------------------------------------------------------------------

class AnalyticsEventObserver(Protocol):
    def on_analytics_event(self, event: AnalyticsEvent) -> None: ...


class _EventBusSingleton:
    """
    Thread-safe, lightweight observer bus for broadcasting AnalyticsEvents to
    interested layers (live dashboards, debug overlays, etc.).
    """
    _instance_lock = threading.Lock()
    _instance: Optional["_EventBusSingleton"] = None

    def __init__(self) -> None:
        self._subscribers: List[AnalyticsEventObserver] = []
        self._lock = threading.RLock()

    @classmethod
    def instance(cls) -> "_EventBusSingleton":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def subscribe(self, observer: AnalyticsEventObserver) -> None:
        with self._lock:
            if observer not in self._subscribers:
                self._subscribers.append(observer)
                LOGGER.debug("Observer %s subscribed", observer)

    def unsubscribe(self, observer: AnalyticsEventObserver) -> None:
        with self._lock:
            if observer in self._subscribers:
                self._subscribers.remove(observer)
                LOGGER.debug("Observer %s unsubscribed", observer)

    def publish(self, event: AnalyticsEvent) -> None:
        with self._lock:
            for observer in list(self._subscribers):  # copy to avoid mutation during iteration
                try:
                    observer.on_analytics_event(event)
                except Exception as exc:  # noqa
                    CrashReporter.record_exception(exc)
                    LOGGER.warning("Observer %s failed to handle event %s", observer, event.name)


# Expose a singleton facade
EventBus = _EventBusSingleton.instance()

# -----------------------------------------------------------------------------
# Local persistence (Repository pattern)
# -----------------------------------------------------------------------------

class AnalyticsEventRepository:
    """
    Thin SQLite repository responsible for persisting analytics events for
    offline durability as well as marking them delivered.
    """

    _DDL = """
    CREATE TABLE IF NOT EXISTS analytics_events (
        event_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts_epoch_ms INTEGER NOT NULL,
        delivered INTEGER DEFAULT 0
    );
    """

    def __init__(self, db_path: Path = DATABASE_PATH) -> None:
        self._db_path = db_path
        self._ensure_database()

    # -- Private helpers ------------------------------------------------------

    def _ensure_database(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._get_connection() as conn:
            conn.executescript(self._DDL)
            conn.commit()

    @contextmanager
    def _get_connection(self) -> Iterable[sqlite3.Connection]:
        conn = sqlite3.connect(self._db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    # -- Public API -----------------------------------------------------------

    def add_event(self, event: AnalyticsEvent) -> None:
        LOGGER.debug("Persisting event %s", event.event_id)
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO analytics_events (event_id, name, payload, ts_epoch_ms, delivered)
                VALUES (:event_id, :name, :payload, :ts_epoch_ms, 0)
                """,
                {
                    "event_id": event.event_id,
                    "name": event.name,
                    "payload": json.dumps(event.payload),
                    "ts_epoch_ms": event.ts_epoch_ms,
                },
            )
            conn.commit()

    def pending_events(self, limit: int) -> List[AnalyticsEvent]:
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                SELECT event_id, name, payload, ts_epoch_ms FROM analytics_events
                WHERE delivered = 0 ORDER BY ts_epoch_ms ASC LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()

        return [
            AnalyticsEvent(
                event_id=row["event_id"],
                name=row["name"],
                payload=json.loads(row["payload"]),
                ts_epoch_ms=row["ts_epoch_ms"],
            )
            for row in rows
        ]

    def mark_delivered(self, event_ids: Iterable[str]) -> None:
        ids = list(event_ids)
        if not ids:
            return
        with self._get_connection() as conn:
            conn.executemany(
                "UPDATE analytics_events SET delivered = 1 WHERE event_id = ?",
                [(eid,) for eid in ids],
            )
            conn.commit()
            LOGGER.debug("Marked %d events delivered", len(ids))

    def purge_old(self, ttl_days: int = EVENT_TTL_DAYS) -> None:
        cutoff_ms = int((datetime.utcnow() - timedelta(days=ttl_days)).timestamp() * 1_000)
        with self._get_connection() as conn:
            cur = conn.execute(
                "DELETE FROM analytics_events WHERE ts_epoch_ms < ?", (cutoff_ms,)
            )
            conn.commit()
            LOGGER.debug("Purged %d stale events", cur.rowcount)


# -----------------------------------------------------------------------------
# Adapter layer – backend / third-party analytics
# -----------------------------------------------------------------------------

class AnalyticsAdapter(abc.ABC):
    """
    Abstract adapter that bridges generic events to a concrete analytics SDK
    (Firebase, Segment, Mixpanel, etc.).
    """

    @abc.abstractmethod
    async def send_events(self, events: List[AnalyticsEvent]) -> None: ...


class FirebaseAnalyticsAdapter(AnalyticsAdapter):
    async def send_events(self, events: List[AnalyticsEvent]) -> None:
        # Mocking async transport with sleep; integrate Firebase SDK here.
        await asyncio.sleep(0.1)
        LOGGER.info("FirebaseAnalyticsAdapter uploaded %d events", len(events))


class AppleAnalyticsAdapter(AnalyticsAdapter):
    async def send_events(self, events: List[AnalyticsEvent]) -> None:
        await asyncio.sleep(0.1)
        LOGGER.info("AppleAnalyticsAdapter uploaded %d events", len(events))


class _NullAnalyticsAdapter(AnalyticsAdapter):
    async def send_events(self, events: List[AnalyticsEvent]) -> None:
        LOGGER.debug("Null adapter discarding %d events (dev mode)", len(events))


class AnalyticsAdapterFactory:
    """
    Chooses a platform-specific adapter at runtime. This simplified example
    uses sys.platform, but the real implementation may rely on Kivy or
    BeeWare’s platform APIs.
    """

    @staticmethod
    def create() -> AnalyticsAdapter:
        platform = sys.platform.lower()
        LOGGER.debug("Selecting analytics adapter for platform %s", platform)

        if platform.startswith("linux") or platform.startswith("win"):
            # Assume Firebase for Android/Linux dev
            return FirebaseAnalyticsAdapter()
        if platform.startswith("darwin"):
            # iOS & macOS share the same identifier under CPython
            return AppleAnalyticsAdapter()
        return _NullAnalyticsAdapter()


# -----------------------------------------------------------------------------
# Singleton service orchestrating the pieces
# -----------------------------------------------------------------------------

class PrismAnalyticsService:
    """
    Orchestrates event capture, local storage, bus broadcasting and periodic
    backend flushes.
    """
    _instance: Optional["PrismAnalyticsService"] = None
    _instance_lock = threading.Lock()

    def __init__(
        self,
        *,
        repository: Optional[AnalyticsEventRepository] = None,
        adapter: Optional[AnalyticsAdapter] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._repo = repository or AnalyticsEventRepository()
        self._adapter = adapter or AnalyticsAdapterFactory.create()

        # Use explicit event loop for better testability.
        self._loop = loop or asyncio.get_event_loop()

        # Background flush task control
        self._shutdown_event = threading.Event()
        self._bg_thread = threading.Thread(
            name="PrismAnalyticsFlush",
            target=self._run_background_flush,
            daemon=True,
        )
        self._bg_thread.start()

    # --------------------------------------------------------------------- #
    # Singleton access                                                      #
    # --------------------------------------------------------------------- #
    @classmethod
    def instance(cls) -> "PrismAnalyticsService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def track_event(self, name: str, payload: Optional[MutableMapping[str, Any]] = None) -> None:
        """
        Entry point for application code.  Persists the event, emits on the
        in-memory bus, and (eventually) sends to backend.
        """
        payload_copy = dict(payload) if payload else {}
        # Augment payload with runtime context for richer analytics
        payload_copy.setdefault("sdk_version", "1.0.0")
        payload_copy.setdefault("module", __name__)

        event = AnalyticsEvent.create(name=name, payload=payload_copy)
        try:
            self._repo.add_event(event)
            EventBus.publish(event)
        except Exception as exc:  # noqa
            CrashReporter.record_exception(exc)

    def shutdown(self) -> None:
        """
        Flush outstanding events and stop background thread. Should be called
        when the application layer is about to terminate (e.g., `onPause`).
        """
        LOGGER.info("Shutting down PrismAnalyticsService...")
        self._shutdown_event.set()
        self._bg_thread.join(timeout=5)
        if self._bg_thread.is_alive():
            LOGGER.warning("Background flush thread did not terminate cleanly")

    # --------------------------------------------------------------------- #
    # Private helpers                                                       #
    # --------------------------------------------------------------------- #

    def _run_background_flush(self) -> None:
        asyncio.set_event_loop(asyncio.new_event_loop())
        loop = asyncio.get_event_loop()
        loop.create_task(self._flush_periodically())
        try:
            loop.run_forever()
        finally:
            loop.close()

    async def _flush_periodically(self) -> None:
        while not self._shutdown_event.is_set():
            try:
                await self._flush_once()
            except Exception as exc:  # noqa
                CrashReporter.record_exception(exc)
            await asyncio.sleep(FLUSH_INTERVAL_SEC)

    async def _flush_once(self) -> None:
        events = self._repo.pending_events(limit=BATCH_SIZE)
        if not events:
            return

        LOGGER.debug("Flushing %d analytics events", len(events))
        try:
            await self._adapter.send_events(events)
            self._repo.mark_delivered(event.event_id for event in events)
            self._repo.purge_old()
        except Exception as exc:  # noqa
            # Do not mark delivered on failure; they will retry later.
            CrashReporter.record_exception(exc)

    # --------------------------------------------------------------------- #
    # Context-manager sugar                                                 #
    # --------------------------------------------------------------------- #

    def __enter__(self) -> "PrismAnalyticsService":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:  # type: ignore
        self.shutdown()


# -----------------------------------------------------------------------------
# Example usage guard
# -----------------------------------------------------------------------------

if __name__ == "__main__":
    """
    An illustrative usage pattern.  In practice, the service would be accessed
    via PrismAnalyticsService.instance() throughout the codebase.
    """
    logging.basicConfig(level=logging.DEBUG)

    service = PrismAnalyticsService.instance()
    try:
        service.track_event("prism_card_created", {"palette": "sunset", "mood": "vibrant"})
        service.track_event("user_signed_in", {"method": "google"})
        # Keep main thread alive briefly to demonstrate flush
        time.sleep(15)
    finally:
        service.shutdown()
        LOGGER.info("Demo complete.")
