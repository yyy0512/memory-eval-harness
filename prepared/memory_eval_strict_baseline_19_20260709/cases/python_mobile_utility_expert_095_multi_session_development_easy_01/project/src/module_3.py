```python
"""
PrismPocket – module_3.py
–––––––––––––––––––––––––
This module encapsulates the analytics pipeline responsible for transforming
raw PrismCard events into aggregate PaletteMetric, LocationMetric, and
MoodMetric entities. It demonstrates several architecture patterns embraced
by the project:

• Observer Pattern     – EventBus publishes PrismCard mutations
• Singleton Pattern    – AnalyticsProcessor guarantees single orchestrator
• Factory Pattern      – MetricFactory spawns concrete Metric objects
• Repository Pattern   – MetricsRepository persists aggregates
• Clean Architecture   – Domain entities remain framework-agnostic
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from abc import ABC, abstractmethod
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from typing import Any, Callable, Dict, Iterable, List, MutableMapping, Optional, Protocol

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

_LOGGER = logging.getLogger("prism_pocket.analytics")
_LOGGER.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter(
        "[%(levelname)s] %(asctime)s – %(name)s:%(lineno)d – %(message)s"
    )
)
_LOGGER.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Observer Pattern – lightweight in-process event bus
# --------------------------------------------------------------------------- #


class Event(Protocol):
    """Marker protocol for events."""


class EventBus:
    """
    Thread-safe publish/subscribe event bus.
    Observers receive weak references to avoid memory leaks.
    """

    _instance: "EventBus" = None
    _lock = threading.Lock()

    def __new__(cls) -> "EventBus":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._subscribers: Dict[
                        str, List[Callable[[Event], None]]
                    ] = defaultdict(list)
        return cls._instance

    def subscribe(self, event_name: str, callback: Callable[[Event], None]) -> None:
        _LOGGER.debug("Subscriber added for %s -> %s", event_name, callback)
        self._subscribers[event_name].append(callback)

    def unsubscribe(self, event_name: str, callback: Callable[[Event], None]) -> None:
        try:
            self._subscribers[event_name].remove(callback)
            _LOGGER.debug("Subscriber removed for %s -> %s", event_name, callback)
        except (KeyError, ValueError):
            _LOGGER.warning("Attempted to remove unknown subscriber.")

    def publish(self, event_name: str, event: Event) -> None:
        _LOGGER.debug("Publishing event %s: %s", event_name, event)
        for cb in list(self._subscribers.get(event_name, [])):
            try:
                cb(event)
            except Exception:  # broad; logging ensures no crash
                _LOGGER.exception("Error invoking subscriber for %s", event_name)


# --------------------------------------------------------------------------- #
# Domain entities
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PrismCard:
    """
    Pure domain entity (simplified).
    In production this lives in a dedicated domain module; reproduced here for
    completeness of the analytics pipeline sample.
    """

    card_id: str
    user_id: str
    dominant_color: str  # HEX
    mood_score: float  # –1 … +1
    latitude: float
    longitude: float
    created_at: float


@dataclass(frozen=True)
class PaletteMetric:
    palette_counter: Dict[str, int]
    last_updated: float


@dataclass(frozen=True)
class LocationMetric:
    hotspots: List[tuple[float, float]]
    last_updated: float


@dataclass(frozen=True)
class MoodMetric:
    average_mood: float
    last_updated: float


# --------------------------------------------------------------------------- #
# Metric Factory Pattern
# --------------------------------------------------------------------------- #


class MetricFactory:
    """Factory for creating metrics from card collections."""

    @staticmethod
    def create_palette_metric(cards: Iterable[PrismCard]) -> PaletteMetric:
        counter: Counter[str] = Counter(card.dominant_color for card in cards)
        metric = PaletteMetric(palette_counter=dict(counter), last_updated=time.time())
        _LOGGER.debug("Created PaletteMetric: %s", metric)
        return metric

    @staticmethod
    def create_location_metric(cards: Iterable[PrismCard]) -> LocationMetric:
        # For simplicity hotspots = top 3 most common (lat, lon) pairs
        counter: Counter[tuple[float, float]] = Counter(
            (card.latitude, card.longitude) for card in cards if card.latitude and card.longitude
        )
        hotspots = [latlon for latlon, _ in counter.most_common(3)]
        metric = LocationMetric(hotspots=hotspots, last_updated=time.time())
        _LOGGER.debug("Created LocationMetric: %s", metric)
        return metric

    @staticmethod
    def create_mood_metric(cards: Iterable[PrismCard]) -> MoodMetric:
        moods = [card.mood_score for card in cards if card.mood_score is not None]
        average = mean(moods) if moods else 0.0
        metric = MoodMetric(average_mood=average, last_updated=time.time())
        _LOGGER.debug("Created MoodMetric: %s", metric)
        return metric


# --------------------------------------------------------------------------- #
# Repository Pattern – persistence of metrics
# --------------------------------------------------------------------------- #


class MetricsRepository(ABC):
    """Abstract repository interface."""

    @abstractmethod
    def save_metrics(
        self,
        palette: PaletteMetric,
        location: LocationMetric,
        mood: MoodMetric,
    ) -> None:
        pass

    @abstractmethod
    def read_metrics(self) -> dict[str, Any]:
        pass


class SQLiteMetricsRepository(MetricsRepository):
    """
    SQLite-backed repository. Stores metrics as JSON blobs to minimize schema
    headaches. In a real application each metric might use dedicated tables for
    analytics queries; here we persist them wholesale for brevity.
    """

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metrics (
                    id TEXT PRIMARY KEY,
                    palette_json TEXT,
                    location_json TEXT,
                    mood_json TEXT,
                    updated_at REAL
                )
                """
            )
            _LOGGER.debug("Metrics table ensured.")

    @contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(self._db_path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def save_metrics(
        self, palette: PaletteMetric, location: LocationMetric, mood: MoodMetric
    ) -> None:
        record_id = "singleton"  # single row semantics
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO metrics (id, palette_json, location_json, mood_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    palette_json=excluded.palette_json,
                    location_json=excluded.location_json,
                    mood_json=excluded.mood_json,
                    updated_at=excluded.updated_at
                """,
                (
                    record_id,
                    json.dumps(palette.palette_counter),
                    json.dumps(location.hotspots),
                    json.dumps({"average": mood.average_mood}),
                    time.time(),
                ),
            )
            _LOGGER.info("Metrics persisted to SQLite.")

    def read_metrics(self) -> dict[str, Any]:
        with self._get_conn() as conn:
            cur = conn.execute("SELECT palette_json, location_json, mood_json FROM metrics WHERE id = 'singleton'")
            row = cur.fetchone()
            if not row:
                _LOGGER.warning("No metrics found in repository.")
                return {}
            palette_json, location_json, mood_json = row
            return {
                "palette_metric": json.loads(palette_json),
                "location_metric": json.loads(location_json),
                "mood_metric": json.loads(mood_json),
            }


class InMemoryMetricsRepository(MetricsRepository):
    """
    Simplest repository; useful for tests or when persistence is offloaded to
    remote sync.
    """

    def __init__(self):
        self._storage: dict[str, Any] = {}
        self._lock = threading.Lock()

    def save_metrics(
        self, palette: PaletteMetric, location: LocationMetric, mood: MoodMetric
    ) -> None:
        with self._lock:
            self._storage = {
                "palette_metric": palette,
                "location_metric": location,
                "mood_metric": mood,
            }
        _LOGGER.debug("Metrics persisted to memory.")

    def read_metrics(self) -> dict[str, Any]:
        with self._lock:
            return self._storage.copy()


# --------------------------------------------------------------------------- #
# Singleton AnalyticsProcessor
# --------------------------------------------------------------------------- #


class PrismCardCreatedEvent(Event):
    card: PrismCard

    def __init__(self, card: PrismCard) -> None:
        self.card = card


class AnalyticsProcessor:
    """
    Consumes PrismCardCreatedEvent, maintains rolling window of cards, and
    periodically flushes updated metrics to repository subscribers.
    """

    _instance: "AnalyticsProcessor" = None
    _lock = threading.Lock()

    WINDOW_SIZE = 1000  # number of cards retained for metrics computations
    PUBLISH_INTERVAL_SEC = 10.0

    def __new__(cls, repository: MetricsRepository | None = None) -> "AnalyticsProcessor":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self, repository: MetricsRepository | None = None) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._repository = repository or InMemoryMetricsRepository()
        self._cards: List[PrismCard] = []
        self._cards_lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None

        # Subscribe to PrismCard events via bus
        EventBus().subscribe("prism_card_created", self._on_prism_card_created)
        # Start periodic persistence
        self._schedule_flush()
        _LOGGER.info("AnalyticsProcessor initialized.")

    # --------------------------------------------------------------------- #
    # Event handling
    # --------------------------------------------------------------------- #

    def _on_prism_card_created(self, event: PrismCardCreatedEvent) -> None:
        _LOGGER.debug("Card received for analytics: %s", event.card)
        with self._cards_lock:
            self._cards.append(event.card)
            if len(self._cards) > self.WINDOW_SIZE:
                self._cards.pop(0)

    # --------------------------------------------------------------------- #
    # Flush / compute metrics
    # --------------------------------------------------------------------- #

    def _schedule_flush(self) -> None:
        self._timer = threading.Timer(self.PUBLISH_INTERVAL_SEC, self._flush_metrics)
        self._timer.daemon = True
        self._timer.start()

    def _flush_metrics(self) -> None:
        with self._cards_lock:
            snapshot = list(self._cards)
        if not snapshot:
            self._schedule_flush()
            return  # nothing to compute

        try:
            palette_metric = MetricFactory.create_palette_metric(snapshot)
            location_metric = MetricFactory.create_location_metric(snapshot)
            mood_metric = MetricFactory.create_mood_metric(snapshot)
            self._repository.save_metrics(
                palette=palette_metric, location=location_metric, mood=mood_metric
            )
            # Notify downstream observers that new metrics are available
            EventBus().publish(
                "analytics_metrics_updated",
                {
                    "palette": palette_metric,
                    "location": location_metric,
                    "mood": mood_metric,
                },
            )
        except Exception:
            _LOGGER.exception("Failed to flush analytics metrics.")
        finally:
            self._schedule_flush()

    # --------------------------------------------------------------------- #
    # Shutdown
    # --------------------------------------------------------------------- #

    def shutdown(self) -> None:
        if self._timer:
            self._timer.cancel()
        EventBus().unsubscribe("prism_card_created", self._on_prism_card_created)
        _LOGGER.info("AnalyticsProcessor shutdown.")


# --------------------------------------------------------------------------- #
# Convenience: API for external modules to publish cards
# --------------------------------------------------------------------------- #


def publish_prism_card(card_data: dict[str, Any]) -> None:
    """
    Helper that converts raw dict into PrismCard and publishes event.
    Used by infrastructure adapters that funnel data from native SDKs.
    """
    try:
        card = PrismCard(
            card_id=card_data.get("card_id", str(uuid.uuid4())),
            user_id=card_data["user_id"],
            dominant_color=card_data["dominant_color"],
            mood_score=float(card_data.get("mood_score", 0.0)),
            latitude=float(card_data.get("latitude", 0.0)),
            longitude=float(card_data.get("longitude", 0.0)),
            created_at=float(card_data.get("created_at", time.time())),
        )
    except (KeyError, ValueError, TypeError) as exc:
        _LOGGER.error("Invalid PrismCard data: %s", exc, exc_info=True)
        return

    EventBus().publish("prism_card_created", PrismCardCreatedEvent(card))
    _LOGGER.info("PrismCard published: %s", card)


# --------------------------------------------------------------------------- #
# Module sanity check: only executed during manual testing
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    # Spin up analytics with SQLite repository
    db_file = Path("./analytics_metrics.db")
    analytics = AnalyticsProcessor(SQLiteMetricsRepository(db_file))

    # Simulate card creation events
    sample_cards = [
        {
            "user_id": "u1",
            "dominant_color": "#FF5733",
            "mood_score": 0.8,
            "latitude": 40.7128,
            "longitude": -74.0060,
        },
        {
            "user_id": "u2",
            "dominant_color": "#33C1FF",
            "mood_score": -0.2,
            "latitude": 34.0522,
            "longitude": -118.2437,
        },
        {
            "user_id": "u1",
            "dominant_color": "#FF5733",
            "mood_score": 0.4,
            "latitude": 40.7128,
            "longitude": -74.0060,
        },
    ]

    for data in sample_cards:
        publish_prism_card(data)

    # Allow some time for scheduled flush
    time.sleep(12)

    # Inspect repository output
    print("Persisted metrics:", analytics._repository.read_metrics())

    analytics.shutdown()
```