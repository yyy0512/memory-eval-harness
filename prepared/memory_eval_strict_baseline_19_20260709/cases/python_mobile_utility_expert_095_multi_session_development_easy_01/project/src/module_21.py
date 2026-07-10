```python
"""
src/module_21.py
---------------------------------
Palette & mood-centric analytics module for PrismPocket.

This module wires together the Observer and Repository patterns to
incrementally aggregate palette-usage metrics every time a PrismCard is
created or remixed.  Metrics are stored locally (SQLite) first and can be
later synced by another adapter layer (not part of this file).

Usage
-----
>>> from module_21 import get_analytics_aggregator, EventType, Event
>>> bus = get_analytics_aggregator().bus        # global event bus
>>> card_event = Event(
...     type=EventType.PRISM_CARD_SAVED,
...     payload={
...        "palette": ["#FF0000", "#00FF00", "#0000FF"],
...        "mood": 0.87,
...        "creator_id": "user-123"
...     }
... )
>>> bus.emit(card_event)  # metric is now persisted
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from datetime import datetime
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Sequence
from uuid import uuid4

# ──────────────────────────────────────────────
# Logging configuration
# ──────────────────────────────────────────────
_logger = logging.getLogger("prism_pocket.analytics")
_logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s")
)
_logger.addHandler(_handler)


# ──────────────────────────────────────────────
# Domain Models
# ──────────────────────────────────────────────
class EventType(Enum):
    """Supported event types broadcast across the Observer bus."""

    PRISM_CARD_SAVED = auto()
    PRISM_CARD_REMIXED = auto()
    # ...other event types can be added here


class Event:
    """
    Value object representing an emitted event.

    Attributes
    ----------
    id : str
        Unique identifier for the event to make debugging easier.
    type : EventType
        Enumeration of event category.
    created_at : float
        Unix timestamp (seconds) when event was emitted.
    payload : Dict[str, Any]
        Arbitrary JSON-serialisable data attached to the event.
    """

    __slots__ = ("id", "type", "created_at", "payload")

    def __init__(self, type: EventType, payload: Dict[str, Any]):
        self.id: str = str(uuid4())
        self.type: EventType = type
        self.created_at: float = time.time()
        self.payload = payload

    # For debug/print
    def __repr__(self) -> str:  # pragma: no cover
        return f"<Event {self.type.name} ({self.id})>"


class PaletteMetric:
    """
    Data class capturing palette usage and mood score.

    This entity lives in the Domain layer, free of any storage concerns.
    """

    __slots__ = ("id", "timestamp", "palette", "mood_score", "creator_id")

    def __init__(
        self,
        palette: Sequence[str],
        mood_score: float,
        creator_id: str,
        *,
        id: Optional[str] = None,
        timestamp: Optional[float] = None,
    ):
        # Validate inputs defensively
        if not palette:
            raise ValueError("palette cannot be empty")

        self.id = id or str(uuid4())
        self.timestamp = timestamp or time.time()
        self.palette: List[str] = list(palette)
        self.mood_score: float = float(mood_score)
        self.creator_id = creator_id

    # Provide a serialisable representation for quick JSON dumps
    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "palette": self.palette,
            "mood_score": self.mood_score,
            "creator_id": self.creator_id,
        }

    def __repr__(self) -> str:  # pragma: no cover
        return f"<PaletteMetric {self.id} mood={self.mood_score:.2f}>"


# ──────────────────────────────────────────────
# Observer Pattern: Event Bus
# ──────────────────────────────────────────────
class _Subscriber(Protocol):
    """Callable signature for subscribers."""

    def __call__(self, event: Event) -> None: ...


class EventBus:
    """
    A simple, thread-safe Observer bus implementation.

    Subscribers are callables that receive the fired Event instance.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[EventType, List[_Subscriber]] = {}
        self._lock = threading.RLock()

    # Subscription control ----------------------------------------------------
    def subscribe(self, event_type: EventType, callback: _Subscriber) -> None:
        with self._lock:
            _logger.debug("Subscribing %s to %s", callback, event_type)
            self._subscribers.setdefault(event_type, []).append(callback)

    def unsubscribe(self, event_type: EventType, callback: _Subscriber) -> None:
        with self._lock:
            callbacks = self._subscribers.get(event_type, [])
            if callback in callbacks:
                _logger.debug("Unsubscribing %s from %s", callback, event_type)
                callbacks.remove(callback)

    # Event emission ----------------------------------------------------------
    def emit(self, event: Event) -> None:
        _logger.debug(
            "Emitting event %s to %d subscribers",
            event,
            len(self._subscribers.get(event.type, [])),
        )
        # Clone list to allow safe modification during iteration
        callbacks = list(self._subscribers.get(event.type, []))
        for callback in callbacks:
            try:
                callback(event)
            except Exception:  # pragma: no cover
                _logger.exception("Subscriber %s crashed on event %s", callback, event)


# ──────────────────────────────────────────────
# Repository Pattern: Storage Abstraction
# ──────────────────────────────────────────────
class MetricRepository(ABC):
    """Port for saving & retrieving PaletteMetric aggregate snapshots."""

    @abstractmethod
    def save(self, metric: PaletteMetric) -> None: ...

    @abstractmethod
    def fetch_all(self) -> Iterable[PaletteMetric]: ...

    @abstractmethod
    def fetch_since(self, ts: float) -> Iterable[PaletteMetric]: ...


class SQLiteMetricRepository(MetricRepository):
    """
    SQLite-backed repository for PaletteMetric entities.

    Uses a single table `palette_metrics`.  Each metric row is stored as a
    JSON blob to keep the schema flexible and forward-compatible.
    """

    _CREATE_SQL = """
    CREATE TABLE IF NOT EXISTS palette_metrics (
        id TEXT PRIMARY KEY,
        ts REAL NOT NULL,
        payload TEXT NOT NULL
    )
    """

    _INSERT_SQL = """
    INSERT OR REPLACE INTO palette_metrics (id, ts, payload)
    VALUES (?, ?, ?)
    """

    _SELECT_ALL_SQL = """
    SELECT payload FROM palette_metrics ORDER BY ts ASC
    """

    _SELECT_SINCE_SQL = """
    SELECT payload FROM palette_metrics WHERE ts >= ? ORDER BY ts ASC
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        # Ensure directory exists
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._ensure_schema()

    # Internal helpers --------------------------------------------------------
    def _ensure_schema(self) -> None:
        with self._conn:
            self._conn.execute(self._CREATE_SQL)
        _logger.debug("Database schema ensured at %s", self._db_path)

    @staticmethod
    def _row_to_metric(row: sqlite3.Row) -> PaletteMetric:
        payload = json.loads(row["payload"])
        return PaletteMetric(
            id=payload["id"],
            timestamp=payload["timestamp"],
            palette=payload["palette"],
            mood_score=payload["mood_score"],
            creator_id=payload["creator_id"],
        )

    # MetricRepository interface ---------------------------------------------
    def save(self, metric: PaletteMetric) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                self._INSERT_SQL,
                (metric.id, metric.timestamp, json.dumps(metric.as_dict())),
            )
        _logger.debug("Metric %s persisted", metric.id)

    def fetch_all(self) -> Iterable[PaletteMetric]:
        with self._lock, self._conn:
            rows = self._conn.execute(self._SELECT_ALL_SQL).fetchall()
        return [self._row_to_metric(r) for r in rows]

    def fetch_since(self, ts: float) -> Iterable[PaletteMetric]:
        with self._lock, self._conn:
            rows = self._conn.execute(self._SELECT_SINCE_SQL, (ts,)).fetchall()
        return [self._row_to_metric(r) for r in rows]


# ──────────────────────────────────────────────
# Singleton Aggregator (Domain Service)
# ──────────────────────────────────────────────
class PaletteAnalyticsAggregator:
    """
    Singleton domain service listening to EventBus and persisting metrics.

    The aggregator is intentionally minimal; it transforms an Event payload
    into a PaletteMetric and delegates persistence to the repository.
    """

    _instance: Optional["PaletteAnalyticsAggregator"] = None
    _lock = threading.Lock()

    def __init__(self, repository: MetricRepository, bus: EventBus) -> None:
        self._repo = repository
        self.bus = bus
        # Subscribe once
        self.bus.subscribe(EventType.PRISM_CARD_SAVED, self._on_prism_card_saved)
        self.bus.subscribe(EventType.PRISM_CARD_REMIXED, self._on_prism_card_saved)
        _logger.info("PaletteAnalyticsAggregator initialised and subscribed")

    # Singleton access --------------------------------------------------------
    @classmethod
    def get_instance(
        cls,
        *,
        db_path: Path | str | None = None,
    ) -> "PaletteAnalyticsAggregator":
        with cls._lock:
            if cls._instance is None:
                # Determine database location
                data_dir = (
                    Path(db_path).expanduser()
                    if db_path is not None
                    else Path.home() / ".prism_pocket" / "data"
                )
                repository = SQLiteMetricRepository(data_dir / "analytics.db")
                bus = EventBus()
                cls._instance = cls(repository, bus)
            return cls._instance

    # --------------------------------------------------------------------- #
    # Event handlers
    # --------------------------------------------------------------------- #
    def _on_prism_card_saved(self, event: Event) -> None:
        """
        Event handler for both 'saved' and 'remixed' PrismCard events.
        Extracts palette + mood_score, then persists a PaletteMetric.
        """
        try:
            payload = event.payload
            palette = payload.get("palette", [])
            mood_score = payload.get("mood", 0.0)
            creator_id = payload.get("creator_id", "unknown")

            metric = PaletteMetric(
                palette=palette,
                mood_score=mood_score,
                creator_id=creator_id,
            )
            self._repo.save(metric)
            _logger.info(
                "PaletteMetric recorded: palette=%s mood=%.2f",
                metric.palette,
                metric.mood_score,
            )
        except Exception:
            # Crash reporting hook could forward to Sentry/Firebase etc.
            _logger.exception("Failed to handle PrismCard event: %s", event)

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def export_metrics(self, since: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """
        Export metrics since a given datetime (UTC).

        Returns a list of dicts that can be directly serialised to JSON.
        """
        ts = since.timestamp() if since else 0.0
        metrics = list(self._repo.fetch_since(ts))
        return [m.as_dict() for m in metrics]

    def compute_palette_popularity(self, top_k: int = 5) -> List[tuple[str, int]]:
        """
        Compute the most frequent colors across all saved metrics.

        Parameters
        ----------
        top_k : int
            Number of top colors to return.

        Returns
        -------
        List[Tuple[str, int]]
            (hex_color, count) sorted by descending frequency.
        """
        counts: Dict[str, int] = {}
        for m in self._repo.fetch_all():
            for c in m.palette:
                counts[c] = counts.get(c, 0) + 1

        # Sort by frequency
        sorted_pairs = sorted(counts.items(), key=lambda t: t[1], reverse=True)
        return sorted_pairs[:top_k]


# ──────────────────────────────────────────────
# Convenience façade
# ──────────────────────────────────────────────
def get_analytics_aggregator() -> PaletteAnalyticsAggregator:
    """
    Global accessor for the singleton AnalyticsAggregator.

    This indirection keeps callers unaware of repository or bus specifics.
    """
    return PaletteAnalyticsAggregator.get_instance()
```