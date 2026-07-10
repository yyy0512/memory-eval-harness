```python
"""
src/module_47.py
PrismPocket – Prism Analytics & Telemetry Pipeline

This module provides a production-ready implementation of the analytics /
telemetry layer used by PrismPocket.  It demonstrates several of the design
patterns described in the project documentation:

• Repository Pattern –  EventRepository persists events locally in SQLite.
• Adapter Pattern     –  RemoteAnalyticsAPI bridges to the cloud-side API.
• Observer Pattern    –  Observable allows view-models and widgets to react to
                          new metrics in real time.
• Singleton           –  PrismAnalyticsManager is process-wide unique.
• Factory Pattern     –  get_analytics_manager() is the canonical entry point.

The code is self-contained but intentionally extensible, so additional event
types or alternate back-ends can be added with minimal refactoring.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import closing, contextmanager
from dataclasses import dataclass, field, asdict
from pathlib import Path
from queue import Queue, Empty
from typing import Dict, List, Optional, Protocol

import requests  # Third-party dep; assumed available in mobile runtime.

###############################################################################
# Configuration
###############################################################################

DEFAULT_DB_PATH = Path.home() / ".prism_pocket" / "analytics.sqlite"
FLUSH_INTERVAL_SECONDS = 5
REMOTE_TIMEOUT_SECONDS = 10
REMOTE_ENDPOINT = "https://api.prismpocket.io/v1/analytics/bulk"

###############################################################################
# Logging
###############################################################################

logger = logging.getLogger("prism.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
)
logger.addHandler(_handler)


###############################################################################
# Crash Reporting (very lightweight stub)
###############################################################################

class CrashReporter:
    """Simple crash reporter that delegates to a remote service."""

    _endpoint = "https://crash.prismpocket.io/report"

    @staticmethod
    def capture(exc: BaseException) -> None:
        """Send a crash report for an uncaught exception."""
        try:
            logger.debug("Sending crash report to remote service…")
            requests.post(
                CrashReporter._endpoint,
                json={"message": str(exc), "type": exc.__class__.__name__},
                timeout=5,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Failed to send crash report: %s", e)


###############################################################################
# Domain Models
###############################################################################

@dataclass(frozen=True)
class PrismEvent:
    """Base class for all events sent to the analytics system."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str = field(default="")
    timestamp: float = field(default_factory=time.time)
    event_type: str = field(init=False)

    def to_payload(self) -> Dict:
        """Serialize the event to a JSON-serializable dict."""
        return asdict(self)


@dataclass(frozen=True)
class CardCreateEvent(PrismEvent):
    """Event dispatched when a new PrismCard is created."""

    card_id: str = field(default="")
    dominant_color: str = field(default="#FFFFFF")
    location: Optional[str] = None  # Optional geohash / coordinates.

    def __post_init__(self) -> None:
        object.__setattr__(self, "event_type", "card_created")


@dataclass(frozen=True)
class CardRemixEvent(PrismEvent):
    """Event dispatched when a PrismCard is remixed."""

    card_id: str = field(default="")
    palette_applied: List[str] = field(default_factory=list)
    mood_score: float = 0.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "event_type", "card_remixed")


###############################################################################
# Repository Pattern – SQLite Event Store
###############################################################################

class EventRepository:
    """SQLite-backed repository for analytics events."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH) -> None:
        self._db_path = db_path
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        logger.debug("Ensuring analytics table exists...")
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    event_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    processed INTEGER DEFAULT 0
                );
                """
            )
            conn.commit()

    @contextmanager
    def _get_connection(self) -> sqlite3.Connection:  # pragma: no cover
        conn = sqlite3.connect(self._db_path)
        try:
            yield conn
        finally:
            conn.close()

    def insert(self, event: PrismEvent) -> None:
        logger.debug("Persisting event %s…", event.id)
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO events (
                    id, user_id, timestamp, event_type, payload, processed
                ) VALUES (?, ?, ?, ?, ?, 0);
                """,
                (
                    event.id,
                    event.user_id,
                    event.timestamp,
                    event.event_type,
                    json.dumps(event.to_payload()),
                ),
            )
            conn.commit()

    def fetch_unprocessed(self, limit: int = 100) -> List[Dict]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT id, payload FROM events WHERE processed = 0 LIMIT ?;",
                (limit,),
            ).fetchall()

        events = [{"id": row[0], **json.loads(row[1])} for row in rows]
        logger.debug("Fetched %d unprocessed events.", len(events))
        return events

    def mark_processed(self, event_ids: List[str]) -> None:
        if not event_ids:
            return
        with self._get_connection() as conn:
            conn.executemany(
                "UPDATE events SET processed = 1 WHERE id = ?;",
                [(eid,) for eid in event_ids],
            )
            conn.commit()
        logger.debug("Marked %d events as processed.", len(event_ids))


###############################################################################
# Adapter Pattern – Remote Analytics API
###############################################################################

class RemoteAnalyticsAPI:
    """HTTP adapter responsible for sending batched events to the cloud."""

    _session = requests.Session()

    @classmethod
    def send_batch(cls, batch: List[Dict]) -> None:
        if not batch:
            return
        logger.info("Uploading %d analytics events…", len(batch))
        try:
            response = cls._session.post(
                REMOTE_ENDPOINT,
                json={"events": batch},
                timeout=REMOTE_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            logger.debug("Events uploaded successfully.")
        except requests.RequestException as exc:
            logger.error("Failed to upload analytics events: %s", exc)
            raise


###############################################################################
# Observer Pattern – Lightweight Observable
###############################################################################

class Observer(Protocol):
    def update(self, metrics: Dict) -> None:  # pragma: no cover
        ...


class Observable:
    """Mix-in that manages a list of observers."""

    def __init__(self) -> None:
        self._observers: List[Observer] = []

    def subscribe(self, observer: Observer) -> None:
        if observer not in self._observers:
            self._observers.append(observer)

    def unsubscribe(self, observer: Observer) -> None:
        if observer in self._observers:
            self._observers.remove(observer)

    def _notify_observers(self, metrics: Dict) -> None:
        for observer in self._observers:
            try:
                observer.update(metrics)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Observer error: %s", exc)
                CrashReporter.capture(exc)


###############################################################################
# Analytics Processor
###############################################################################

class AnalyticsProcessor:
    """
    Converts raw events into higher-level metrics expected by the UI and
    recommendation engine.
    """

    @staticmethod
    def compute_metrics(events: List[Dict]) -> Dict:
        # Example: compute most used dominant_color and average mood_score.
        color_counter: Dict[str, int] = {}
        mood_scores: List[float] = []

        for event in events:
            etype = event.get("event_type")
            if etype == "card_created":
                color = event.get("dominant_color", "#FFFFFF")
                color_counter[color] = color_counter.get(color, 0) + 1
            elif etype == "card_remixed":
                mood_scores.append(float(event.get("mood_score", 0.0)))

        most_used_palette = (
            max(color_counter, key=color_counter.get) if color_counter else None
        )
        avg_mood = (
            sum(mood_scores) / len(mood_scores) if mood_scores else 0.0
        )

        metrics = {
            "most_used_color": most_used_palette,
            "average_mood_score": round(avg_mood, 2),
            "timestamp": time.time(),
        }
        logger.debug("Computed metrics: %s", metrics)
        return metrics


###############################################################################
# Singleton Meta-class
###############################################################################

class _Singleton(type):
    _instances: Dict = {}

    def __call__(cls, *args, **kwargs):  # noqa: D401
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


###############################################################################
# Prism Analytics Manager – Public Entry Point
###############################################################################

class PrismAnalyticsManager(Observable, metaclass=_Singleton):
    """
    Central orchestrator for event capture, storage, processing, and upload.
    Exposes a thread-safe API for the rest of the application.
    """

    def __init__(self, repository: Optional[EventRepository] = None) -> None:
        super().__init__()
        self._repository = repository or EventRepository()
        self._in_memory_queue: Queue[PrismEvent] = Queue()
        self._bg_thread = threading.Thread(
            target=self._worker_loop, name="PrismAnalyticsWorker", daemon=True
        )
        self._stop_event = threading.Event()
        self._bg_thread.start()

    # --------------------------------------------------------------------- API

    def track_event(self, event: PrismEvent) -> None:
        """Add an event to the analytics pipeline."""
        logger.debug("Queueing event %s (%s)", event.id, event.event_type)
        self._in_memory_queue.put(event)

    def shutdown(self, flush: bool = True) -> None:
        """Shut down background worker and optionally flush pending events."""
        if flush:
            logger.info("Flushing outstanding analytics events before shutdown…")
            self._flush_queue(block=True)
            self._flush_repository()
        self._stop_event.set()
        self._bg_thread.join(timeout=2)
        logger.debug("Analytics manager shutdown complete.")

    # ------------------------------------------------------------- Background

    def _worker_loop(self) -> None:  # pragma: no cover
        logger.debug("Analytics worker thread started.")
        last_flush = time.time()
        while not self._stop_event.is_set():
            try:
                self._flush_queue(block=False)
                if time.time() - last_flush >= FLUSH_INTERVAL_SECONDS:
                    self._flush_repository()
                    last_flush = time.time()
            except Exception as exc:  # noqa: BLE001
                logger.error("Analytics worker error: %s", exc)
                CrashReporter.capture(exc)
            time.sleep(0.3)

    def _flush_queue(self, block: bool) -> None:
        """
        Move events from the in-memory queue to persistent storage.  This allows
        fast non-blocking tracking on the UI thread while guaranteeing that no
        data is lost on app termination.
        """
        while True:
            try:
                event = self._in_memory_queue.get(block=block, timeout=1 if block else 0)
            except Empty:
                break
            else:
                self._repository.insert(event)
                self._in_memory_queue.task_done()

    def _flush_repository(self) -> None:
        """
        Retrieve unprocessed events, upload them, compute metrics, and mark
        them as processed.
        """
        events = self._repository.fetch_unprocessed()
        if not events:
            return

        # Upload to remote service.
        try:
            RemoteAnalyticsAPI.send_batch(events)
        except Exception:  # noqa: BLE001
            # Don't mark processed; we'll retry later.
            return

        # Compute local metrics & notify observers.
        metrics = AnalyticsProcessor.compute_metrics(events)
        self._notify_observers(metrics)

        # Mark events as processed only after successful upload & processing.
        event_ids = [e["id"] for e in events]
        self._repository.mark_processed(event_ids)


###############################################################################
# Factory
###############################################################################

_analytics_manager: Optional[PrismAnalyticsManager] = None
_factory_lock = threading.Lock()


def get_analytics_manager() -> PrismAnalyticsManager:
    """
    Preferred mechanism for acquiring the PrismAnalyticsManager. Ensures that
    only one instance is ever created even across edge cases like
    module-reloading during hot-swap development on desktop.
    """
    global _analytics_manager  # noqa: PLW0603
    with _factory_lock:
        if _analytics_manager is None:
            _analytics_manager = PrismAnalyticsManager()
    return _analytics_manager


###############################################################################
# Example Observer Implementation (for completeness)
###############################################################################

class LoggingObserver(Observer):
    """Observer that logs metrics to the console."""

    def update(self, metrics: Dict) -> None:
        logger.info("Realtime metrics updated: %s", metrics)


###############################################################################
# Self-test (only executed when run directly, never in production build)
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    manager = get_analytics_manager()
    manager.subscribe(LoggingObserver())

    # Simulate events.
    manager.track_event(
        CardCreateEvent(
            user_id="user123",
            card_id="cardA",
            dominant_color="#FF5722",
            location="47.6205,-122.3493",
        )
    )
    manager.track_event(
        CardRemixEvent(
            user_id="user123",
            card_id="cardA",
            palette_applied=["#FF5722", "#4CAF50", "#03A9F4"],
            mood_score=0.87,
        )
    )

    # Allow background worker to process.
    time.sleep(8)
    manager.shutdown()
```