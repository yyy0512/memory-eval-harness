```python
"""
module_35.py
PrismPocket (mobile_utility) – Analytics & Observer Infrastructure

This module implements the color-palette analytics pipeline for PrismPocket.
It wires together:

1. A lightweight, thread-safe Observer/Event bus
2. A PaletteAnalyticsEngine (Singleton) that listens for PrismCard mutations
3. Domain entities (PrismCard, PaletteMetric, AnalyticsEvent)
4. Factory helpers to bootstrap the analytics layer from the application shell

The code adheres to Clean Architecture and demonstrated patterns:
Observer, Singleton, Repository (stub), and Factory.
"""

from __future__ import annotations

import datetime as _dt
import logging
import threading
import uuid
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set

__all__ = [
    "PrismCard",
    "PaletteMetric",
    "AnalyticsEvent",
    "EventType",
    "EventBus",
    "PaletteAnalyticsEngine",
    "AnalyticsFactory",
    "CardRepository",  # Stubbed local storage repository
]

###############################################################################
# Logging Configuration
###############################################################################

LOGGER_NAME = "prism_pocket.analytics"
logger = logging.getLogger(LOGGER_NAME)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)

###############################################################################
# Domain Entities
###############################################################################


class MediaType(str, Enum):
    TEXT = "text"
    PHOTO = "photo"
    AUDIO = "audio"
    GEO = "geotag"


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Core domain entity representing a creative capture inside PrismPocket.
    """

    card_id: str
    media_type: MediaType
    content_ref: str  # e.g. URI, file path, or in-memory key
    palette: List[str]  # List of HEX colors extracted at capture time
    created_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    """
    Aggregated color metric derived from one or more PrismCards.
    """

    dominant_color: str
    palette_size: int
    card_id: str
    computed_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )


@dataclass(frozen=True, slots=True)
class AnalyticsEvent:
    """
    Envelope pushed on the EventBus whenever a new PaletteMetric is produced.
    """

    metric: PaletteMetric
    trend_score: float  # 0-1 normalized value indicating current popularity


###############################################################################
# Observer / Event system
###############################################################################


class EventType(str, Enum):
    """
    Enumerates well-known event channels within the analytics layer.
    """

    CARD_MUTATION = "CARD_MUTATION"
    METRIC_COMPUTED = "METRIC_COMPUTED"
    TREND_UPDATED = "TREND_UPDATED"
    ERROR = "ERROR"


Callback = Callable[[EventType, Any], None]


class ObserverError(RuntimeError):
    """Raised when event publication fails."""


class EventBus:
    """
    Thread-safe Observer bus with pub/sub semantics.

    Subscribers receive events on the same thread that publishes the event.
    If long-running work is required, subscribers must delegate to background
    workers to avoid blocking the bus.
    """

    _lock: threading.RLock
    _subscribers: Dict[EventType, Set[Callback]]

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers = {evt: set() for evt in EventType}

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: EventType, callback: Callback) -> None:
        """
        Register a callback for a given event type.

        The callback must accept exactly two parameters:
            (event_type: EventType, payload: Any)
        """
        with self._lock:
            self._subscribers[event_type].add(callback)
            logger.debug("Subscriber %s attached to %s", callback, event_type)

    def unsubscribe(self, event_type: EventType, callback: Callback) -> None:
        """Detach a callback from the specified event channel."""
        with self._lock:
            self._subscribers[event_type].discard(callback)
            logger.debug("Subscriber %s detached from %s", callback, event_type)

    def publish(self, event_type: EventType, payload: Any) -> None:
        """
        Emit an event to all listeners. Non-critical exceptions raised by
        subscribers are caught and logged to avoid disrupting the bus.
        """
        with self._lock:
            subscribers = list(self._subscribers[event_type])

        logger.debug(
            "Publishing event %s to %d subscriber(s)", event_type, len(subscribers)
        )

        for cb in subscribers:
            try:
                cb(event_type, payload)
            except Exception as exc:  # pylint: disable=broad-except
                logger.error(
                    "Subscriber %s raised during %s: %s", cb, event_type.value, exc
                )
                # Forward the error to interested observers
                self._publish_internal_error(exc)

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    def _publish_internal_error(self, exc: Exception) -> None:
        """Internal helper to broadcast Observer errors."""
        with self._lock:
            subs = list(self._subscribers[EventType.ERROR])
        for cb in subs:
            try:
                cb(EventType.ERROR, exc)
            except Exception:  # pragma: no cover
                # Swallow exceptions raised while handling ObserverError
                logger.debug("Error subscriber %s failed", cb, exc_info=True)


###############################################################################
# Analytics Engine (Singleton)
###############################################################################


class SingletonMeta(type):
    """
    Thread-safe Singleton metaclass implementing double-checked locking.
    """

    _instances: Dict[type, "SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # noqa: D401,N802
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:
                    instance = super().__call__(*args, **kwargs)  # type: ignore
                    cls._instances[cls] = instance
        return cls._instances[cls]


class PaletteAnalyticsEngine(metaclass=SingletonMeta):
    """
    Consumes PrismCard events and produces PaletteMetrics + trend analysis.

    This object is intentionally decoupled from UI and platform concerns; it
    may be invoked by schedulers, workers, or background tasks without direct
    user interaction.
    """

    _TREND_WINDOW: int = 250  # Number of latest metrics considered 'recent'

    __slots__ = (
        "_bus",
        "_lock",
        "_metric_history",
        "_color_counter",
    )

    def __init__(self, bus: EventBus) -> None:
        self._bus: EventBus = bus
        self._lock: threading.RLock = threading.RLock()
        self._metric_history: List[PaletteMetric] = []
        self._color_counter: Counter[str] = Counter()

        # Subscribe to card mutations
        self._bus.subscribe(EventType.CARD_MUTATION, self._on_card_mutation)
        logger.info("PaletteAnalyticsEngine initialized and listening for cards")

    # ------------------------------------------------------------------ #
    # Event handlers
    # ------------------------------------------------------------------ #

    def _on_card_mutation(self, _: EventType, card: PrismCard) -> None:
        """Triggered each time a PrismCard is created or updated."""
        try:
            metric = self._compute_metric(card)
            self._register_metric(metric)
            self._publish_metric(metric)
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Metric computation failed")
            self._bus.publish(EventType.ERROR, exc)

    # ------------------------------------------------------------------ #
    # Metric computation & trend logic
    # ------------------------------------------------------------------ #

    def _compute_metric(self, card: PrismCard) -> PaletteMetric:
        """
        Basic algorithm: pick the most frequent color in the card palette as
        the dominant color. In case of tie, pick the earliest color.
        """
        logger.debug("Computing metric for card %s", card.card_id)
        counts = Counter(card.palette)
        dominant, _ = counts.most_common(1)[0]
        metric = PaletteMetric(
            dominant_color=dominant,
            palette_size=len(card.palette),
            card_id=card.card_id,
        )
        logger.debug("Metric computed: %s", metric)
        return metric

    def _register_metric(self, metric: PaletteMetric) -> None:
        """Store metric and update rolling color trends."""
        with self._lock:
            self._metric_history.append(metric)
            self._color_counter[metric.dominant_color] += 1

            # Maintain window size
            if len(self._metric_history) > self._TREND_WINDOW:
                old_metric = self._metric_history.pop(0)
                self._color_counter[old_metric.dominant_color] -= 1

        logger.debug("Metric registered. History size=%d", len(self._metric_history))

    def _trend_score(self, color: str) -> float:
        """
        Compute a normalized trend score for a given color
        within the rolling window [0, 1].
        """
        with self._lock:
            total = sum(self._color_counter.values())
            if total == 0:
                return 0.0
            return self._color_counter[color] / total

    # ------------------------------------------------------------------ #
    # Publication helpers
    # ------------------------------------------------------------------ #

    def _publish_metric(self, metric: PaletteMetric) -> None:
        """Publish PaletteMetric & trend update to observers."""
        score = self._trend_score(metric.dominant_color)
        evt = AnalyticsEvent(metric=metric, trend_score=score)
        logger.debug("Publishing metric event: %s", evt)
        self._bus.publish(EventType.METRIC_COMPUTED, evt)

        # Optionally emit a separate TREND_UPDATED event for UI dashboards
        trend_payload = {
            "dominant_color": metric.dominant_color,
            "score": score,
            "timestamp": metric.computed_at,
        }
        self._bus.publish(EventType.TREND_UPDATED, trend_payload)


###############################################################################
# Repository Stub (Local Storage Layer)
###############################################################################


class CardRepository:
    """
    A minimal in-memory implementation showcasing the Repository pattern.

    Real production code would implement persistence (SQLite, CoreData, etc.)
    and conflict resolution. The repository acts as a Source of Truth: any
    mutation triggers an EventBus notification.
    """

    __slots__ = ("_bus", "_storage", "_lock")

    def __init__(self, bus: EventBus) -> None:
        self._bus: EventBus = bus
        self._storage: Dict[str, PrismCard] = {}
        self._lock: threading.Lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # CRUD API
    # ------------------------------------------------------------------ #

    def save(self, card: PrismCard) -> None:
        """Insert or update a PrismCard, broadcasting a mutation."""
        with self._lock:
            self._storage[card.card_id] = card
        logger.info("Card %s persisted", card.card_id)
        self._bus.publish(EventType.CARD_MUTATION, card)

    def get(self, card_id: str) -> Optional[PrismCard]:
        with self._lock:
            return self._storage.get(card_id)

    def all(self) -> List[PrismCard]:
        with self._lock:
            return list(self._storage.values())

    def delete(self, card_id: str) -> None:
        with self._lock:
            if card_id in self._storage:
                card = self._storage.pop(card_id)
                logger.info("Card %s deleted", card_id)
                self._bus.publish(EventType.CARD_MUTATION, card)


###############################################################################
# Factory Helpers
###############################################################################


class AnalyticsFactory:
    """
    Bootstraps the analytics subsystem and returns configured components.
    """

    @staticmethod
    def create_bus() -> EventBus:
        return EventBus()

    @staticmethod
    def create_repository(bus: EventBus) -> CardRepository:
        return CardRepository(bus)

    @staticmethod
    def create_analytics_engine(bus: EventBus) -> PaletteAnalyticsEngine:
        return PaletteAnalyticsEngine(bus)


###############################################################################
# Example Usage (Would normally live in integration tests or app boot files)
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    # This block is strictly for manual testing and debug sessions.
    bus = AnalyticsFactory.create_bus()
    repo = AnalyticsFactory.create_repository(bus)
    engine = AnalyticsFactory.create_analytics_engine(bus)

    def print_metric(_: EventType, evt: AnalyticsEvent) -> None:
        logger.info(
            "Dominant color %s – trend score %.2f",
            evt.metric.dominant_color,
            evt.trend_score,
        )

    bus.subscribe(EventType.METRIC_COMPUTED, print_metric)

    # Simulate a few cards
    for i in range(5):
        card = PrismCard(
            card_id=str(uuid.uuid4()),
            media_type=MediaType.PHOTO,
            content_ref=f"/tmp/photo_{i}.jpg",
            palette=["#FF0000", "#00FF00", "#0000FF", "#FF0000"],
        )
        repo.save(card)
```