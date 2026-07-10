```python
"""
PrismPocket – Trend Analytics Core
----------------------------------

This module is responsible for transforming streams of PrismCard domain
objects into real-time, shareable analytics (a.k.a. “creative trends”).
It follows clean-architecture principles:

• Domain entities remain pure (dataclasses with no I/O).
• Aggregators sit in the domain-service layer.
• An in-process Observer bus decouples publishers from subscribers.
• A Factory selects the correct aggregator for each metric type.
• The TrendAnalyticsService is a thread-safe Singleton façade exposed
  to the outside world (repositories, view-models, etc.).

The design keeps the module framework-agnostic (usable on iOS/Android
via BeeWare/Kivy-iOS or similar runners) while being production-ready.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from enum import Enum, auto
from typing import Dict, Iterable, List, MutableMapping, Optional, Protocol, Set, Tuple

# --------------------------------------------------------------------------- #
#  Logging Configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)

# Mobile targets often pipe Python logs into native handlers.
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s – %(name)s – %(message)s")
)
logger.addHandler(_handler)


# --------------------------------------------------------------------------- #
#  Domain Entities
# --------------------------------------------------------------------------- #

@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Pure domain representation of a prism card.  
    NOTE: Media (photo/voice) is not stored here to keep memory footprint small.
    """
    card_id: str
    user_id: str
    palette: Tuple[str, ...]  # Hex colors e.g. ("#AABBCC", "#FF00FF")
    latitude: Optional[float]  # None when user disabled geo-tagging
    longitude: Optional[float]
    mood_score: float  # –1.0 (sad) … +1.0 (happy)
    created_at: datetime


@dataclass(slots=True)
class PaletteMetric:
    """Represents aggregate statistics for a color palette."""
    palette: Tuple[str, ...]
    occurrences: int
    last_seen: datetime


# --------------------------------------------------------------------------- #
#  Observer Pattern
# --------------------------------------------------------------------------- #

class EventType(str, Enum):
    """
    High-level event categories emitted by the analytics engine.
    """
    METRIC_UPDATED = "metric_updated"
    SNAPSHOT_READY = "snapshot_ready"


@dataclass(slots=True)
class Event:
    """
    Payload wrapper delivered on the observer bus.
    """
    type: EventType
    data: dict
    timestamp: float = time.time()


class Observer(Protocol):
    """
    Observer interface (duck-typed).
    """

    def on_event(self, event: Event) -> None:  # pragma: no cover
        ...


class _ThreadSafeObserverBus:
    """
    A very lightweight, in-process pub/sub mechanism.

    Subscriptions are keyed by event type. No effort is made to prevent
    slow observers from blocking; consumers should off-load expensive work.
    """

    _subscriptions: Dict[EventType, Set[Observer]]
    _lock: threading.RLock

    def __init__(self) -> None:
        self._subscriptions = defaultdict(set)
        self._lock = threading.RLock()

    def subscribe(self, event_type: EventType, observer: Observer) -> None:
        with self._lock:
            self._subscriptions[event_type].add(observer)
            logger.debug("Observer %s subscribed to %s", observer, event_type)

    def unsubscribe(self, event_type: EventType, observer: Observer) -> None:
        with self._lock:
            self._subscriptions[event_type].discard(observer)
            logger.debug("Observer %s unsubscribed from %s", observer, event_type)

    def publish(self, event: Event) -> None:
        with self._lock:
            observers = list(self._subscriptions.get(event.type, set()))
        logger.debug("Publishing %s to %d observers", event.type, len(observers))
        for observer in observers:
            try:
                observer.on_event(event)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Observer %s raised on event %s: %s", observer, event, exc)


# Exposed singleton instance
observer_bus = _ThreadSafeObserverBus()


# --------------------------------------------------------------------------- #
#  Aggregators
# --------------------------------------------------------------------------- #

class MetricType(Enum):
    """Type of metric we can aggregate."""
    PALETTE = auto()
    LOCATION = auto()
    MOOD = auto()


class AbstractAggregator(Protocol):
    """
    Strategy interface for all aggregators.
    """

    metric_type: MetricType

    def ingest(self, card: PrismCard) -> None:
        ...

    def snapshot(self) -> dict:
        """
        Return a JSON-serializable snapshot of the current metric state.
        Used by view-models or cloud synchronization.
        """
        ...


class PaletteTrendAggregator:
    """
    Live aggregator computing most-used color palettes.
    """

    metric_type = MetricType.PALETTE

    _palette_counter: Counter  # counts of palette occurrences
    _last_seen: MutableMapping[Tuple[str, ...], datetime]
    _lock: threading.RLock

    def __init__(self) -> None:
        self._palette_counter = Counter()
        self._last_seen = {}
        self._lock = threading.RLock()

    def ingest(self, card: PrismCard) -> None:
        palette = tuple(card.palette)
        with self._lock:
            self._palette_counter[palette] += 1
            self._last_seen[palette] = card.created_at
            logger.debug("Palette %s updated, count=%d", palette, self._palette_counter[palette])

    def snapshot(self, top_n: int = 5) -> dict:
        with self._lock:
            top_palettes = self._palette_counter.most_common(top_n)
            snapshot = [
                {
                    "palette": palette,
                    "occurrences": occ,
                    "last_seen": self._last_seen.get(palette).isoformat(),
                }
                for palette, occ in top_palettes
            ]
        logger.debug("Palette snapshot: %s", snapshot)
        return {"type": self.metric_type.name, "data": snapshot}


class LocationTrendAggregator:
    """
    Aggregates hotspot locations via simple grid bucketing
    (approx. 1km buckets using ~0.01° grid for simplicity).
    """

    metric_type = MetricType.LOCATION
    _bucket_counter: Counter
    _lock: threading.RLock

    GRID_SIZE_DEG = 0.01  # crude latitude/longitude bucket size

    def __init__(self) -> None:
        self._bucket_counter = Counter()
        self._lock = threading.RLock()

    @staticmethod
    def _bucket(lat: float, lng: float) -> Tuple[float, float]:
        return (
            round(lat / LocationTrendAggregator.GRID_SIZE_DEG) * LocationTrendAggregator.GRID_SIZE_DEG,
            round(lng / LocationTrendAggregator.GRID_SIZE_DEG) * LocationTrendAggregator.GRID_SIZE_DEG,
        )

    def ingest(self, card: PrismCard) -> None:
        if card.latitude is None or card.longitude is None:
            return
        bucket = self._bucket(card.latitude, card.longitude)
        with self._lock:
            self._bucket_counter[bucket] += 1
            logger.debug("Location bucket %s updated, count=%d", bucket, self._bucket_counter[bucket])

    def snapshot(self, top_n: int = 5) -> dict:
        with self._lock:
            top_locations = self._bucket_counter.most_common(top_n)
            snapshot = [
                {"lat": lat, "lng": lng, "occurrences": occ}
                for (lat, lng), occ in top_locations
            ]
        logger.debug("Location snapshot: %s", snapshot)
        return {"type": self.metric_type.name, "data": snapshot}


class MoodTrendAggregator:
    """
    Tracks average mood score and total samples.
    """

    metric_type = MetricType.MOOD
    _lock: threading.RLock
    _tot_mood: float
    _tot_samples: int

    def __init__(self) -> None:
        self._tot_mood = 0.0
        self._tot_samples = 0
        self._lock = threading.RLock()

    def ingest(self, card: PrismCard) -> None:
        with self._lock:
            self._tot_mood += card.mood_score
            self._tot_samples += 1
            logger.debug("Mood updated, total=%d, avg=%.3f", self._tot_samples, self.average_mood)

    @property
    def average_mood(self) -> float:
        return self._tot_mood / self._tot_samples if self._tot_samples else 0.0

    def snapshot(self) -> dict:
        with self._lock:
            snapshot = {
                "average_mood": self.average_mood,
                "samples": self._tot_samples,
            }
        logger.debug("Mood snapshot: %s", snapshot)
        return {"type": self.metric_type.name, "data": snapshot}


# --------------------------------------------------------------------------- #
#  Aggregator Factory
# --------------------------------------------------------------------------- #

class AggregatorFactory:
    """
    Maps metric types to their concrete aggregator implementations.
    """

    _registry: Dict[MetricType, AbstractAggregator] = {
        MetricType.PALETTE: PaletteTrendAggregator(),
        MetricType.LOCATION: LocationTrendAggregator(),
        MetricType.MOOD: MoodTrendAggregator(),
    }

    @classmethod
    def get(cls, metric_type: MetricType) -> AbstractAggregator:
        try:
            return cls._registry[metric_type]
        except KeyError as exc:
            raise ValueError(f"Unsupported metric type: {metric_type}") from exc


# --------------------------------------------------------------------------- #
#  Trend Analytics Service (Singleton)
# --------------------------------------------------------------------------- #

class TrendAnalyticsService:
    """
    Thread-safe façade orchestrating aggregators and dispatching events.
    """

    _instance: "TrendAnalyticsService" = None
    _lock = threading.Lock()

    _processed_card_ids: Set[str]
    _aggregators: Dict[MetricType, AbstractAggregator]

    def __init__(self) -> None:
        self._processed_card_ids = set()
        # clone registry to allow instance isolation in unit tests
        self._aggregators = dict(AggregatorFactory._registry)

    # ----------------------------- Singleton ----------------------------- #

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    # ------------------------------ API ---------------------------------- #

    def ingest_card(self, card: PrismCard) -> None:
        """
        Process a new PrismCard and update all metrics.

        Duplicate cards (same card_id) will be ignored.
        """
        if card.card_id in self._processed_card_ids:
            logger.debug("Card %s already processed; skipping.", card.card_id)
            return

        logger.info("Ingesting card %s", card.card_id)
        self._processed_card_ids.add(card.card_id)

        for aggregator in self._aggregators.values():
            try:
                aggregator.ingest(card)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Aggregator %s failed on card %s: %s", aggregator, card.card_id, exc)

        # Emit a metric update event (fine-grained updates could include metric type)
        observer_bus.publish(
            Event(
                type=EventType.METRIC_UPDATED,
                data={"card_id": card.card_id},
            )
        )

    def snapshot(self, metric_types: Optional[Iterable[MetricType]] = None) -> Dict[str, dict]:
        """
        Capture a snapshot for the given metrics (all by default).
        """
        metric_types = metric_types or self._aggregators.keys()
        result: Dict[str, dict] = {}
        for mtype in metric_types:
            aggregator = self._aggregators[mtype]
            result[mtype.name] = aggregator.snapshot()

        # Fire off "snapshot ready" event for live UI dashboards
        observer_bus.publish(
            Event(
                type=EventType.SNAPSHOT_READY,
                data={"metrics": list(metric_types)},
            )
        )
        logger.info("Snapshot ready for metrics %s", metric_types)
        return result


# --------------------------------------------------------------------------- #
#  Convenience Helper (used by adapters / repositories)
# --------------------------------------------------------------------------- #

analytics_service = TrendAnalyticsService()


def submit_card(
    *,
    card_id: str,
    user_id: str,
    palette: List[str],
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    mood_score: float = 0.0,
    created_at: Optional[datetime] = None,
) -> None:
    """
    Adapter-friendly function converting primitive data into domain entities.

    Example usage (e.g. inside a CameraAdapter):

        submit_card(
            card_id=uuid4().hex,
            user_id=current_user.id,
            palette=dominant_colors,
            latitude=gps.lat,
            longitude=gps.lng,
            mood_score=sentiment,
        )
    """
    created_at = created_at or datetime.utcnow()
    card = PrismCard(
        card_id=card_id,
        user_id=user_id,
        palette=tuple(palette),
        latitude=latitude,
        longitude=longitude,
        mood_score=mood_score,
        created_at=created_at,
    )
    analytics_service.ingest_card(card)


# --------------------------------------------------------------------------- #
#  Example Observer Implementation
# --------------------------------------------------------------------------- #

class DebugObserver:
    """
    Simple observer printing every event to the log.
    """

    def on_event(self, event: Event) -> None:
        logger.info("DebugObserver received %s: %s", event.type, event.data)


# Auto-register debug observer only when this module is executed as script
if __name__ == "__main__":
    observer_bus.subscribe(EventType.METRIC_UPDATED, DebugObserver())
    observer_bus.subscribe(EventType.SNAPSHOT_READY, DebugObserver())

    # Smoke test
    submit_card(
        card_id="card-123",
        user_id="user-42",
        palette=["#FF0000", "#00FF00"],
        latitude=48.8566,
        longitude=2.3522,
        mood_score=0.8,
    )
    time.sleep(0.2)
    snapshot = analytics_service.snapshot()
    logger.info("Snapshot produced: %s", snapshot)
```