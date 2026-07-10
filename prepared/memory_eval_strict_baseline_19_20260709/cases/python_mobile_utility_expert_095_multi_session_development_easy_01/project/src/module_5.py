"""
PrismPocket - module_5.py
~~~~~~~~~~~~~~~~~~~~~~~~~

This module contains production–ready infrastructure that powers
PrismPocket’s runtime event streaming and on–device analytics
aggregation.

Key responsibilities:

• PrismEventBus (Singleton) – Thread–safe Observer bus that allows any
  component (CameraAdapter, Repository, ViewModel, …) to publish domain
  events and subscribe to them in a decoupled fashion.

• AnalyticsAggregator – A long–lived background service that consumes
  PrismCard–related events, derives palette / location metrics, and
  persists them through an AnalyticsRepository abstraction.

• LocalAnalyticsRepository – Lightweight, file-based SQLite
  implementation that provides durable storage when offline while
  remaining fully testable.

• AnalyticsFactory – Simple factory helper that wires the above pieces
  together depending on runtime configuration.

This code purposefully relies only on the Python standard library so it
can execute in any mobile runtime (via tools such as BeeWare or
Chaquopy) without additional wheels.  Where platform-specific features
(camera, biometrics, …) are required, adapters in other layers will
publish their respective events to this bus.

Copyright © 2024 PrismPocket
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
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Protocol, Sequence, Tuple

# -----------------------------------------------------------------------------
# Logging configuration
# -----------------------------------------------------------------------------
LOGGER_NAME = "prism_pocket.analytics"
logger = logging.getLogger(LOGGER_NAME)
logger.setLevel(logging.DEBUG)
# Handlers can be replaced / augmented by host application
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s (%(threadName)s) %(name)s: %(message)s")
    )
    logger.addHandler(_handler)

# -----------------------------------------------------------------------------
# Event bus definitions
# -----------------------------------------------------------------------------


class PrismEventType(Enum):
    """Domain-level event types used across the PrismPocket application."""

    CARD_CREATED = auto()
    CARD_EDITED = auto()
    CARD_DELETED = auto()
    # Additional event types can be added here as the product evolves.


@dataclass(frozen=True, slots=True)
class PrismEvent:
    """Immutable container representing an event flowing through the bus."""

    type: PrismEventType
    payload: Mapping[str, Any]
    timestamp: float = time.time()


Observer = Callable[[PrismEvent], None]


class PrismEventBus:
    """Thread-safe, Singleton event bus implementing the Observer pattern."""

    _instance: Optional["PrismEventBus"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        if PrismEventBus._instance is not None:
            raise RuntimeError("Use PrismEventBus.instance() to access the singleton.")

        self._observers: Dict[PrismEventType, List[Observer]] = {}
        self._queue: "queue.Queue[PrismEvent]" = queue.Queue()
        self._dispatcher_thread = threading.Thread(
            target=self._dispatch_loop,
            name="PrismEventDispatcher",
            daemon=True,
        )
        self._dispatcher_thread.start()
        logger.debug("PrismEventBus initialized and dispatcher thread started.")

    # ------------------------------------------------------------------
    # Singleton access
    # ------------------------------------------------------------------
    @classmethod
    def instance(cls) -> "PrismEventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    # ------------------------------------------------------------------
    # Observer API
    # ------------------------------------------------------------------
    def register(self, event_type: PrismEventType, observer: Observer) -> None:
        """Register an observer for a specific event type."""
        with self._lock:
            self._observers.setdefault(event_type, []).append(observer)
            logger.debug("Observer %s registered for event_type=%s", observer, event_type)

    def unregister(self, event_type: PrismEventType, observer: Observer) -> None:
        """Remove an observer from a specific event type."""
        with self._lock:
            observers = self._observers.get(event_type)
            if observers and observer in observers:
                observers.remove(observer)
                logger.debug("Observer %s unregistered from event_type=%s", observer, event_type)

    # ------------------------------------------------------------------
    # Publishing API
    # ------------------------------------------------------------------
    def publish(self, event: PrismEvent) -> None:
        """Publish an event asynchronously."""
        self._queue.put(event)
        logger.debug("Event queued for publishing: %s", event)

    # ------------------------------------------------------------------
    # Internal dispatcher
    # ------------------------------------------------------------------
    def _dispatch_loop(self) -> None:
        while True:
            try:
                event = self._queue.get()
                logger.debug("Dispatching event: %s", event)
                observers_snapshot: Sequence[Observer]
                with self._lock:
                    observers_snapshot = list(self._observers.get(event.type, []))
                for observer in observers_snapshot:
                    try:
                        observer(event)
                    except Exception as exc:  # pylint: disable=broad-except
                        logger.exception(
                            "Error while notifying observer=%s for event=%s: %s",
                            observer,
                            event,
                            exc,
                        )
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Unhandled exception in dispatcher loop: %s", exc)

    # ------------------------------------------------------------------
    # Shutdown hook (optional)
    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        """Gracefully stop the dispatcher thread (best-effort)."""
        logger.info("Shutting down PrismEventBus…")
        self._dispatcher_thread.join(timeout=0.5)


# -----------------------------------------------------------------------------
# Domain entities for analytics
# -----------------------------------------------------------------------------


@dataclass(slots=True)
class ColorPalette:
    """Snapshot of a card’s top-n dominant colors (stored as hex strings)."""

    hex_codes: Tuple[str, ...]


@dataclass(slots=True)
class PaletteMetric:
    palette: ColorPalette
    count: int


@dataclass(slots=True)
class LocationMetric:
    latitude: float
    longitude: float
    count: int


# -----------------------------------------------------------------------------
# Analytics Repository abstraction
# -----------------------------------------------------------------------------


class AnalyticsRepository(Protocol):  # pragma: no cover
    """Port for persisting aggregated analytics."""

    # Palette metrics --------------------------------------------------
    def upsert_palette_metric(self, palette: ColorPalette) -> None:
        ...

    def top_palettes(self, limit: int = 10) -> List[PaletteMetric]:
        ...

    # Location metrics -------------------------------------------------
    def upsert_location_metric(self, latitude: float, longitude: float) -> None:
        ...

    def hotspot_locations(self, limit: int = 10) -> List[LocationMetric]:
        ...


# -----------------------------------------------------------------------------
# Local SQLite implementation
# -----------------------------------------------------------------------------


class LocalAnalyticsRepository(AnalyticsRepository):
    """SQLite-based repository that stores aggregated analytics on device."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS palette_metric (
        hex_codes TEXT PRIMARY KEY,
        count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location_metric (
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (lat, lon)
    );
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path.expanduser().resolve()
        self._conn_lock = threading.Lock()
        self._ensure_db()

    def _ensure_db(self) -> None:
        with self._get_connection() as conn:
            conn.executescript(self.SCHEMA)
        logger.debug("SQLite schema ensured at %s", self._db_path)

    @contextmanager
    def _get_connection(self) -> Iterable[sqlite3.Connection]:
        with self._conn_lock:
            conn = sqlite3.connect(
                self._db_path, detect_types=sqlite3.PARSE_DECLTYPES, isolation_level=None
            )
            try:
                yield conn
            finally:
                conn.close()

    # Palette methods --------------------------------------------------
    def upsert_palette_metric(self, palette: ColorPalette) -> None:
        hex_codes_json = json.dumps(list(palette.hex_codes), separators=(",", ":"))
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO palette_metric (hex_codes, count)
                VALUES (?, 1)
                ON CONFLICT(hex_codes) DO UPDATE SET
                    count = count + 1
                """,
                (hex_codes_json,),
            )
        logger.debug("Palette metric upserted: %s", palette.hex_codes)

    def top_palettes(self, limit: int = 10) -> List[PaletteMetric]:
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT hex_codes, count FROM palette_metric
                ORDER BY count DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        result = [
            PaletteMetric(
                palette=ColorPalette(tuple(json.loads(hex_codes))), count=count
            )
            for hex_codes, count in rows
        ]
        logger.debug("Top palettes retrieved: %s", result)
        return result

    # Location methods -------------------------------------------------
    def upsert_location_metric(self, latitude: float, longitude: float) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO location_metric (lat, lon, count)
                VALUES (?, ?, 1)
                ON CONFLICT(lat, lon) DO UPDATE SET
                    count = count + 1
                """,
                (latitude, longitude),
            )
        logger.debug("Location metric upserted: (%f, %f)", latitude, longitude)

    def hotspot_locations(self, limit: int = 10) -> List[LocationMetric]:
        with self._get_connection() as conn:
            rows = conn.execute(
                """
                SELECT lat, lon, count FROM location_metric
                ORDER BY count DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        result = [LocationMetric(latitude=lat, longitude=lon, count=count) for lat, lon, count in rows]
        logger.debug("Hotspot locations retrieved: %s", result)
        return result


# -----------------------------------------------------------------------------
# Analytics Aggregator service
# -----------------------------------------------------------------------------


class AnalyticsAggregator(threading.Thread):
    """
    Background thread that transforms PrismEvents into aggregated metrics
    and persists them via an AnalyticsRepository instance.
    """

    _STOP_SENTINEL = object()

    def __init__(
        self,
        repository: AnalyticsRepository,
        bus: PrismEventBus | None = None,
        *,
        batch_size: int = 32,
        flush_interval: float = 5.0,
    ) -> None:
        super().__init__(name="AnalyticsAggregator", daemon=True)
        self._repository = repository
        self._bus = bus or PrismEventBus.instance()
        self._batch_size = batch_size
        self._flush_interval = flush_interval
        self._queue: "queue.Queue[PrismEvent | object]" = queue.Queue(maxsize=256)

        # Caches for counting before flush ---------------------------------
        self._palette_counts: MutableMapping[Tuple[str, ...], int] = {}
        self._location_counts: MutableMapping[Tuple[float, float], int] = {}

        # Register observer -------------------------------------------------
        self._bus.register(PrismEventType.CARD_CREATED, self._on_event)
        self._bus.register(PrismEventType.CARD_EDITED, self._on_event)

    # ------------------------------------------------------------------
    # Observer callback
    # ------------------------------------------------------------------
    def _on_event(self, event: PrismEvent) -> None:
        """
        Called by PrismEventBus for each relevant event; quickly off-loads
        for processing to avoid blocking the dispatcher.
        """
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            logger.warning("AnalyticsAggregator queue is full; dropping event=%s", event)

    # ------------------------------------------------------------------
    # Thread main loop
    # ------------------------------------------------------------------
    def run(self) -> None:  # noqa: D401
        logger.info("AnalyticsAggregator started.")
        last_flush = time.monotonic()

        while True:
            try:
                # Wait for next item or timeout for periodic flush
                timeout = max(0.0, self._flush_interval - (time.monotonic() - last_flush))
                item = self._queue.get(timeout=timeout)
                if item is self._STOP_SENTINEL:
                    logger.info("AnalyticsAggregator received STOP signal.")
                    break
                self._process_event(item)  # type: ignore[arg-type]
            except queue.Empty:
                # Periodic flush triggered
                pass

            now = time.monotonic()
            if now - last_flush >= self._flush_interval or self._batch_ready():
                self._flush()
                last_flush = now

        # Final flush before exit
        self._flush()
        logger.info("AnalyticsAggregator terminated.")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def stop(self) -> None:
        """Signals the background thread to finish and flush remaining data."""
        self._queue.put(self._STOP_SENTINEL)
        self.join(timeout=1.0)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _batch_ready(self) -> bool:
        return (
            sum(self._palette_counts.values()) + sum(self._location_counts.values())
            >= self._batch_size
        )

    def _process_event(self, event: PrismEvent) -> None:
        logger.debug("Processing event in aggregator: %s", event)
        payload = event.payload

        # Palette extraction --------------------------------------------
        palette_hexes: Optional[Sequence[str]] = payload.get("dominant_palette")
        if palette_hexes:
            key = tuple(sorted(palette_hexes))
            self._palette_counts[key] = self._palette_counts.get(key, 0) + 1
            logger.debug("Palette count incremented for key=%s", key)

        # Location extraction -------------------------------------------
        lat = payload.get("latitude")
        lon = payload.get("longitude")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            loc_key = (float(lat), float(lon))
            self._location_counts[loc_key] = self._location_counts.get(loc_key, 0) + 1
            logger.debug("Location count incremented for key=%s", loc_key)

    def _flush(self) -> None:
        """Flush in-memory counts to the repository."""
        if not (self._palette_counts or self._location_counts):
            return  # Nothing to flush

        logger.debug(
            "Flushing analytics: %d palettes, %d locations",
            len(self._palette_counts),
            len(self._location_counts),
        )

        # Palette flush -------------------------------------------------
        for palette_key, occurrences in list(self._palette_counts.items()):
            palette = ColorPalette(hex_codes=palette_key)
            for _ in range(occurrences):
                self._repository.upsert_palette_metric(palette)
            del self._palette_counts[palette_key]

        # Location flush ------------------------------------------------
        for loc_key, occurrences in list(self._location_counts.items()):
            lat, lon = loc_key
            for _ in range(occurrences):
                self._repository.upsert_location_metric(lat, lon)
            del self._location_counts[loc_key]


# -----------------------------------------------------------------------------
# Factory helper
# -----------------------------------------------------------------------------


class AnalyticsFactory:
    """Factory utilities for creating analytics components."""

    DEFAULT_DB_FILE = Path.home() / ".prism_pocket" / "analytics.db"

    @staticmethod
    def create_repository(db_path: Optional[Path] = None) -> AnalyticsRepository:
        """Return a LocalAnalyticsRepository pointing to the given path."""
        db_path = db_path or AnalyticsFactory.DEFAULT_DB_FILE
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return LocalAnalyticsRepository(db_path=db_path)

    @staticmethod
    def create_aggregator(
        repository: Optional[AnalyticsRepository] = None,
        bus: Optional[PrismEventBus] = None,
    ) -> AnalyticsAggregator:
        """Wire a fully-configured AnalyticsAggregator."""
        repository = repository or AnalyticsFactory.create_repository()
        aggregator = AnalyticsAggregator(repository=repository, bus=bus)
        aggregator.start()
        return aggregator


# -----------------------------------------------------------------------------
# Example usage (can be removed / adapted when integrated by host app)
# -----------------------------------------------------------------------------
if __name__ == "__main__":
    # Demonstration of event flow and analytics flush.
    bus = PrismEventBus.instance()
    repo = AnalyticsFactory.create_repository()
    aggregator = AnalyticsFactory.create_aggregator(repository=repo, bus=bus)

    try:
        # Simulate random card creations
        import random

        for _ in range(25):
            event = PrismEvent(
                type=PrismEventType.CARD_CREATED,
                payload={
                    "dominant_palette": [f"#{random.randint(0, 0xFFFFFF):06X}" for _ in range(3)],
                    "latitude": random.uniform(-90, 90),
                    "longitude": random.uniform(-180, 180),
                },
            )
            bus.publish(event)
            time.sleep(0.05)

        # Allow aggregator to flush
        time.sleep(2)

        # Print out results
        logger.info("Top palettes: %s", repo.top_palettes(limit=5))
        logger.info("Hotspot locations: %s", repo.hotspot_locations(limit=5))
    finally:
        aggregator.stop()
        bus.shutdown()
