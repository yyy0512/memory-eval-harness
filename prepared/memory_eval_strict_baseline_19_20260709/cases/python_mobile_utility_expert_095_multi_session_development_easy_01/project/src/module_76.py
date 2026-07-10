```python
"""
PrismPocket – module_76
=======================

Analytics Hub: Color Palette Metrics
------------------------------------
This module listens to PrismCard–related events flowing through the global
Observer bus, extracts color-palette statistics, persists them locally, and
periodically syncs the data to the cloud analytics endpoint.

Architecture patterns employed:
    • Singleton (EventBus)
    • Observer (EventBus subscription)
    • Repository (CardAnalyticsRepository)
    • Factory (AnalyticsComponentFactory)
    • Adapter (HTTPAdapter wraps `requests`)
"""

from __future__ import annotations

import json
import logging
import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:
    # `requests` is ubiquitous but may be stripped in some mobile builds;
    # fall back gracefully if unavailable.
    import requests
except ModuleNotFoundError:  # pragma: no cover
    requests = None  # type: ignore

# Configure root logger for module demo purposes
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Observer Bus – lightweight pub-sub system
# --------------------------------------------------------------------------- #


class _SingletonMeta(type):
    """A threadsafe Singleton metaclass."""

    _instances: Dict[type, Any] = {}
    _lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any) -> Any:
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class EventBus(metaclass=_SingletonMeta):
    """Process-wide event bus using the Observer pattern."""

    def __init__(self) -> None:
        self._subscribers: Dict["PrismEventType", List[Callable[["PrismEvent"], None]]] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_type: "PrismEventType", callback: Callable[["PrismEvent"], None]) -> None:
        logger.debug("Subscribing to event %s -> %s", event_type, callback)
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(callback)

    def publish(self, event: "PrismEvent") -> None:
        logger.debug("Publishing event %s", event)
        with self._lock:
            callbacks = list(self._subscribers.get(event.type, []))
        for cb in callbacks:
            try:
                cb(event)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Event callback crashed: %s", cb)


# --------------------------------------------------------------------------- #
# Domain Events
# --------------------------------------------------------------------------- #


class PrismEventType(Enum):
    """Domain-level events for PrismCard lifecycle."""

    CARD_CREATED = auto()
    CARD_UPDATED = auto()
    CARD_DELETED = auto()


@dataclass(frozen=True, slots=True)
class PrismEvent:
    """Generic event wrapper."""

    type: PrismEventType
    payload: Dict[str, Any]  # Should contain at least `card_id`


# --------------------------------------------------------------------------- #
# Repository Pattern – local persistence of analytics
# --------------------------------------------------------------------------- #


class CardAnalyticsRepository:
    """
    SQLite-backed repository responsible for storing palette metrics extracted
    from PrismCards before they are synced to the cloud.
    """

    _SCHEMA_VERSION = 1
    _DDL = """
        CREATE TABLE IF NOT EXISTS palette_metrics (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            card_id       TEXT    NOT NULL,
            metric_json   TEXT    NOT NULL,
            synced        INTEGER NOT NULL DEFAULT 0,
            created_ts    REAL    NOT NULL DEFAULT (strftime('%s','now'))
        );
        PRAGMA user_version = {schema_version};
    """.format(
        schema_version=_SCHEMA_VERSION
    )

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path.expanduser().resolve()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._prepare_schema()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def insert_metric(self, card_id: str, metric: Dict[str, Any]) -> None:
        logger.debug("Inserting metric for card %s", card_id)
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO palette_metrics (card_id, metric_json) VALUES (?, ?)",
                (card_id, json.dumps(metric)),
            )

    def unsynced_metrics(self, limit: int = 50) -> List[Dict[str, Any]]:
        logger.debug("Fetching up to %d unsynced metrics", limit)
        with self._get_conn() as conn:
            cur = conn.execute(
                "SELECT id, card_id, metric_json FROM palette_metrics WHERE synced = 0 ORDER BY id LIMIT ?",
                (limit,),
            )
            rows = cur.fetchall()
        return [
            {"row_id": rid, "card_id": cid, "metric": json.loads(metric_json)} for rid, cid, metric_json in rows
        ]

    def mark_as_synced(self, row_ids: List[int]) -> None:
        if not row_ids:
            return
        logger.debug("Marking %d metrics as synced", len(row_ids))
        with self._get_conn() as conn:
            conn.execute(
                "UPDATE palette_metrics SET synced = 1 WHERE id IN (%s)"
                % ",".join("?" * len(row_ids)),
                row_ids,
            )

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _prepare_schema(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(self._DDL)

    @contextmanager
    def _get_conn(self) -> "sqlite3.Connection":
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# HTTP Adapter – isolates third-party library from core logic
# --------------------------------------------------------------------------- #


class HTTPAdapter:
    """
    Thin wrapper around `requests` (or any future replacement) to decouple
    third-party dependencies from business logic. Facilitates unit-testing.
    """

    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        if requests is None:
            raise RuntimeError("The 'requests' library is required but not installed.")

    def post(self, endpoint: str, payload: Dict[str, Any]) -> None:
        url = f"{self._base_url}/{endpoint.lstrip('/')}"
        logger.debug("POST %s -> %s", url, payload)
        resp = requests.post(url, json=payload, timeout=self._timeout)
        if not resp.ok:
            logger.error("Failed POST %s (%s): %s", url, resp.status_code, resp.text)
            resp.raise_for_status()


# --------------------------------------------------------------------------- #
# Analytics Service – extract palette metrics from incoming events
# --------------------------------------------------------------------------- #


class ColorPaletteAnalyticsService:
    """
    Subscribes to PrismCard events and calculates simple palette metrics.
    For brevity, this implementation uses a naïve extraction stub instead
    of full-blown image analysis.
    """

    def __init__(self, repository: CardAnalyticsRepository):
        self._repo = repository
        EventBus().subscribe(PrismEventType.CARD_CREATED, self._on_card_event)
        EventBus().subscribe(PrismEventType.CARD_UPDATED, self._on_card_event)

    # --------------------------------------------------------------------- #
    # Event handlers
    # --------------------------------------------------------------------- #

    def _on_card_event(self, event: PrismEvent) -> None:
        logger.debug("Processing card event for analytics: %s", event)
        card_id = event.payload["card_id"]
        color_hexes: List[str] = event.payload.get("dominant_colors", [])
        metric = self._compute_color_metrics(color_hexes)
        self._repo.insert_metric(card_id, metric)

    # --------------------------------------------------------------------- #
    # Metric computation
    # --------------------------------------------------------------------- #

    @staticmethod
    def _compute_color_metrics(colors: List[str]) -> Dict[str, Any]:
        """
        Convert a list of HEX colors to basic statistics—counts and hue buckets.
        Real implementation would involve color clustering algorithms.
        """
        logger.debug("Computing palette metrics from colors: %s", colors)
        total = len(colors) or 1  # Avoid division by zero
        histogram: Dict[str, int] = {}
        for hex_code in colors:
            hue_bucket = ColorPaletteAnalyticsService._hex_to_hue_bucket(hex_code)
            histogram[hue_bucket] = histogram.get(hue_bucket, 0) + 1
        return {
            "total_colors": len(colors),
            "hue_distribution": {bucket: count / total for bucket, count in histogram.items()},
        }

    @staticmethod
    def _hex_to_hue_bucket(hex_color: str) -> str:
        """
        Bucketize hue roughly into 6 sectors:
        red, yellow, green, cyan, blue, magenta.
        """
        try:
            r, g, b = (
                int(hex_color[1:3], 16),
                int(hex_color[3:5], 16),
                int(hex_color[5:7], 16),
            )
        except (ValueError, IndexError):
            logger.debug("Invalid HEX color encountered: %s", hex_color)
            return "unknown"

        # Calculate hue in degrees (simplified)
        mx = max(r, g, b)
        mn = min(r, g, b)
        if mx == mn:
            return "gray"
        if mx == r:
            hue = (60 * ((g - b) / (mx - mn))) % 360
        elif mx == g:
            hue = (60 * ((b - r) / (mx - mn)) + 120) % 360
        else:
            hue = (60 * ((r - g) / (mx - mn)) + 240) % 360

        sector = int(hue // 60)
        return ["red", "yellow", "green", "cyan", "blue", "magenta"][sector]


# --------------------------------------------------------------------------- #
# Sync Worker – background thread pushing metrics to the cloud
# --------------------------------------------------------------------------- #


class MetricSyncWorker(threading.Thread):
    """Continuously syncs unsent metrics using exponential backoff."""

    _STOP_SENTINEL = object()

    def __init__(
        self,
        repository: CardAnalyticsRepository,
        http_adapter: HTTPAdapter,
        poll_interval: float = 15.0,
        backoff_factor: float = 2.0,
        max_backoff: float = 600.0,
    ):
        super().__init__(name="MetricSyncWorker", daemon=True)
        self._repository = repository
        self._http_adapter = http_adapter
        self._poll_interval = poll_interval
        self._backoff_factor = backoff_factor
        self._max_backoff = max_backoff
        self._jobs: "queue.Queue[object]" = queue.Queue()
        self._stop_event = threading.Event()

    # --------------------------------------------------------------------- #
    # Public control methods
    # --------------------------------------------------------------------- #

    def stop(self) -> None:
        logger.info("Stopping MetricSyncWorker…")
        self._stop_event.set()
        self._jobs.put(self._STOP_SENTINEL)
        self.join()

    # --------------------------------------------------------------------- #
    # Thread loop
    # --------------------------------------------------------------------- #

    def run(self) -> None:
        logger.info("MetricSyncWorker started.")
        backoff = self._poll_interval

        while not self._stop_event.is_set():
            try:
                # Process job queue (immediate wake-up via sentinel)
                try:
                    job = self._jobs.get(timeout=backoff)
                    if job is self._STOP_SENTINEL:
                        break
                except queue.Empty:
                    pass  # timed out – continue to sync cycle

                unsynced = self._repository.unsynced_metrics()
                if unsynced:
                    self._flush_to_remote(unsynced)
                    backoff = self._poll_interval  # Reset backoff on success
                else:
                    backoff = self._poll_interval  # no pending data, normal sleep
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Metric sync error: %s", exc)
                backoff = min(backoff * self._backoff_factor, self._max_backoff)
                logger.info("Backing off for %.1f seconds", backoff)

        logger.info("MetricSyncWorker stopped.")

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _flush_to_remote(self, rows: List[Dict[str, Any]]) -> None:
        payload = [row["metric"] for row in rows]
        logger.debug("Flushing %d metrics to cloud.", len(rows))
        self._http_adapter.post("/analytics/palette/batch", payload)
        # Only mark as synced if post does not raise
        self._repository.mark_as_synced([row["row_id"] for row in rows])


# --------------------------------------------------------------------------- #
# Component Factory – bootstrap API for the rest of the app
# --------------------------------------------------------------------------- #


class AnalyticsComponentFactory:
    """
    Provides a one-liner to bootstrap the entire analytics subsystem from
    application entry-point or DI container.
    """

    @staticmethod
    def create_and_start(
        db_path: Path,
        analytics_base_url: str,
        poll_interval: float = 15.0,
    ) -> "AnalyticsContext":
        repository = CardAnalyticsRepository(db_path=db_path)
        http_adapter = HTTPAdapter(analytics_base_url)
        ColorPaletteAnalyticsService(repository)  # register to EventBus
        worker = MetricSyncWorker(
            repository=repository,
            http_adapter=http_adapter,
            poll_interval=poll_interval,
        )
        worker.start()
        return AnalyticsContext(repository=repository, worker=worker)


@dataclass
class AnalyticsContext:
    """Keeps references to running analytics components for lifecycle mgmt."""
    repository: CardAnalyticsRepository
    worker: MetricSyncWorker

    def shutdown(self) -> None:
        logger.info("Shutting down analytics context…")
        self.worker.stop()


# --------------------------------------------------------------------------- #
# Development stub – runs only when executed directly
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    # Bootstrapping demo
    ctx = AnalyticsComponentFactory.create_and_start(
        db_path=Path("~/.prism_pocket/analytics.db"),
        analytics_base_url="https://api.prismpocket.example.com",
        poll_interval=5.0,
    )

    # Simulate incoming events
    bus = EventBus()
    bus.publish(
        PrismEvent(
            type=PrismEventType.CARD_CREATED,
            payload={
                "card_id": "card-123",
                "dominant_colors": ["#FF0000", "#FF8800", "#00FF00", "#0000FF"],
            },
        )
    )

    try:
        # Keep main thread alive for a short demo
        time.sleep(20)
    finally:
        ctx.shutdown()
```