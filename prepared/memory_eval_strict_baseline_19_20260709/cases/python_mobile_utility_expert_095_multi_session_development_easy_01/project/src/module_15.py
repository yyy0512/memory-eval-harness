```python
"""
PrismPocket – module_15.py
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Real-time creative-trend analytics and prompt generation.

This module hosts the production-grade implementation of PrismPocket’s
in-process analytics engine.  The engine listens for domain events
(`CardSavedEvent`, `CardDeletedEvent`, …) published on the Observer bus,
keeps lightweight in-memory aggregates up-to-date, and exposes query/
projection helpers to the View-Model layer (MVVM).

It deliberately avoids any GUI / OS coupling and is therefore located well
inside the “domain service” ring of our Clean Architecture stack.

Author  : PrismPocket Dev Team
Created : 2024-06-05
"""

from __future__ import annotations

import itertools
import logging
import math
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from statistics import mean
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    # numpy provides a *massive* speed-up for color computations.
    # Gracefully degrade if unavailable (e.g., when size footprint matters).
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore


# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s in %(name)s: %(message)s")
)
logger.addHandler(_handler)
logger.propagate = False

# --------------------------------------------------------------------------- #
# Domain models – *simplified* extracts
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class RGBColor:
    """Simple 24-bit RGB color."""

    r: int
    g: int
    b: int

    def distance(self, other: "RGBColor") -> float:
        """Euclidian distance in RGB space."""
        return math.sqrt(
            ((self.r - other.r) ** 2)
            + ((self.g - other.g) ** 2)
            + ((self.b - other.b) ** 2)
        )

    def to_tuple(self) -> Tuple[int, int, int]:
        return self.r, self.g, self.b


@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float


@dataclass(frozen=True)
class PrismCard:
    """Minimal representation needed by the analytics engine."""

    card_id: str
    user_id: str
    created_at: float  # epoch
    dominant_color: RGBColor
    mood_score: float  # ‑1.0 (sad) … +1.0 (joy)
    location: Optional[GeoPoint] = None


# --------------------------------------------------------------------------- #
# Observer infrastructure (very lightweight)
# --------------------------------------------------------------------------- #


class Observer:
    def notify(self, event: "Event") -> None:  # noqa: D401 – One-liner style
        """Receive domain event."""


class Observable:
    """Thread-safe event bus for *local* process-scope observers."""

    def __init__(self) -> None:
        self._observers: List[Observer] = []
        self._lock = threading.RLock()

    # Registration ----------------------------------------------------------- #
    def subscribe(self, observer: Observer) -> None:
        with self._lock:
            self._observers.append(observer)

    def unsubscribe(self, observer: Observer) -> None:
        with self._lock:
            self._observers.remove(observer)

    # Dispatch --------------------------------------------------------------- #
    def publish(self, event: "Event") -> None:
        with self._lock:
            for ob in list(self._observers):
                try:
                    ob.notify(event)
                except Exception:  # noqa: BLE001
                    logger.exception("Observer %s threw inside notify()", ob)


# A singleton bus instance used by adapters to bubble events upward
LOCAL_EVENT_BUS = Observable()

# --------------------------------------------------------------------------- #
# Domain events
# --------------------------------------------------------------------------- #


class Event:  # pragma: no cover – base marker
    pass


@dataclass(frozen=True)
class CardSavedEvent(Event):
    card: PrismCard


@dataclass(frozen=True)
class CardDeletedEvent(Event):
    card_id: str
    user_id: str


# --------------------------------------------------------------------------- #
# Analytics output DTOs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PaletteMetric:
    rgb: RGBColor
    count: int


@dataclass(frozen=True)
class HotspotMetric:
    location: GeoPoint
    count: int


@dataclass(frozen=True)
class TrendInsight:
    """Aggregate snapshot exported to other layers (read-only)."""

    total_cards: int
    top_colors: List[PaletteMetric]
    hotspot_locations: List[HotspotMetric]
    avg_mood_score: float
    timestamp: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
# Core analytics engine
# --------------------------------------------------------------------------- #


class _AnalyticsEngine(Observer):
    """
    Internal implementation – exposed via `AnalyticsEngine.instance()`.

    The class is intentionally *not* thread-safe across methods; a single
    background worker thread processes all events sequentially to guarantee
    eventual consistency while avoiding fine-grained locks.
    """

    _MAX_COLOR_BUCKETS = 8
    _COLOR_DISTANCE_THR = 32.0  # Rough clustering threshold in RGB space
    _MAX_HOTSPOTS = 5
    _EARTH_RADIUS_KM = 6371.0

    def __init__(self) -> None:
        self._queue: "queue.Queue[Event]" = self._build_queue()
        self._state = _AnalyticsState()
        self._worker = threading.Thread(
            target=self._event_loop, name="AnalyticsWorker", daemon=True
        )
        self._stop_ev = threading.Event()

        # Register with local event bus
        LOCAL_EVENT_BUS.subscribe(self)  # type: ignore[arg-type]
        self._worker.start()
        logger.info("Analytics engine up & running.")

    # --------------------------------------------------------------------- #
    # Observer interface
    # --------------------------------------------------------------------- #
    def notify(self, event: Event) -> None:  # noqa: D401
        self._queue.put(event, block=False)

    # --------------------------------------------------------------------- #
    # State query (public API)
    # --------------------------------------------------------------------- #
    def get_insights(self) -> TrendInsight:
        """Return a defensive copy of the current aggregate."""
        return self._state.snapshot()

    def generate_prompts(self) -> List[str]:
        """
        Generate creative prompt suggestions based on the latest trend
        insights – intentionally *stateless* relative to external actors.
        """
        insights = self._state.snapshot()

        prompts: List[str] = []
        if insights.top_colors:
            rgb = insights.top_colors[0].rgb
            prompts.append(
                f"Create a card inspired by the color RGB{rgb.to_tuple()}."
            )

        if insights.hotspot_locations:
            loc = insights.hotspot_locations[0].location
            prompts.append(
                f"Share a memory near Latitude {loc.lat:.2f}, "
                f"Longitude {loc.lon:.2f}."
            )

        if insights.avg_mood_score < -0.25:
            prompts.append("Try sketching something uplifting in warm tones!")
        elif insights.avg_mood_score > 0.25:
            prompts.append("Channel your positive vibe into a bold doodle!")

        if not prompts:
            prompts.append("Capture today's spark of creativity in any form.")

        return prompts

    # --------------------------------------------------------------------- #
    # Internal helpers – worker loop
    # --------------------------------------------------------------------- #
    def _event_loop(self) -> None:
        while not self._stop_ev.is_set():
            try:
                ev = self._queue.get(timeout=0.2)
            except Exception:
                continue  # Idle loop

            try:
                self._handle_event(ev)
            except Exception:  # noqa: BLE001
                logger.exception("Error processing event: %s", ev)

    def _handle_event(self, event: Event) -> None:
        if isinstance(event, CardSavedEvent):
            self._state.add_card(event.card)
            logger.debug("CardSaved processed: %s", event.card.card_id)
        elif isinstance(event, CardDeletedEvent):
            self._state.remove_card(event.card_id, event.user_id)
            logger.debug("CardDeleted processed: %s", event.card_id)
        else:  # noqa: RET505 – keep explicit for forward safety
            logger.warning("Unrecognized event type: %s", type(event).__name__)

    # --------------------------------------------------------------------- #
    # Shutdown (for tests / app exit)
    # --------------------------------------------------------------------- #
    def shutdown(self, timeout: float = 3.0) -> None:
        self._stop_ev.set()
        self._worker.join(timeout)
        LOCAL_EVENT_BUS.unsubscribe(self)
        logger.info("Analytics engine stopped.")

    # --------------------------------------------------------------------- #
    # Factory utilities
    # --------------------------------------------------------------------- #
    @staticmethod
    def _build_queue() -> "queue.Queue[Event]":
        import queue

        return queue.Queue(maxsize=1_024)


class AnalyticsEngine:
    """
    Facade + Singleton accessor.

    Usage:
        engine = AnalyticsEngine.instance()
        insights = engine.get_insights()
    """

    _instance: Optional[_AnalyticsEngine] = None
    _lock = threading.Lock()

    @classmethod
    def instance(cls) -> _AnalyticsEngine:
        with cls._lock:
            if cls._instance is None:
                cls._instance = _AnalyticsEngine()
            return cls._instance

    @classmethod
    def shutdown(cls) -> None:
        with cls._lock:
            if cls._instance:
                cls._instance.shutdown()
            cls._instance = None


# --------------------------------------------------------------------------- #
# Internal mutable state – extracted into its own class for clarity
# --------------------------------------------------------------------------- #


class _AnalyticsState:
    __slots__ = (
        "_cards_by_id",
        "_lock",
        "_color_counter",
        "_location_counter",
        "_mood_accumulator",
    )

    def __init__(self) -> None:
        self._cards_by_id: Dict[str, PrismCard] = {}
        self._color_counter: Counter[Tuple[int, int, int]] = Counter()
        self._location_counter: Counter[Tuple[int, int]] = Counter()
        self._mood_accumulator: List[float] = []
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Card mutations
    # --------------------------------------------------------------------- #
    def add_card(self, card: PrismCard) -> None:
        with self._lock:
            if card.card_id in self._cards_by_id:
                # Update scenario – remove old contributions first
                self._remove_card_locked(card.card_id)

            self._cards_by_id[card.card_id] = card
            self._color_counter[card.dominant_color.to_tuple()] += 1
            if card.location:
                key = (round(card.location.lat, 2), round(card.location.lon, 2))
                self._location_counter[key] += 1
            self._mood_accumulator.append(card.mood_score)

    def remove_card(self, card_id: str, user_id: str) -> None:
        with self._lock:
            self._remove_card_locked(card_id)

    # Internal
    def _remove_card_locked(self, card_id: str) -> None:
        card = self._cards_by_id.pop(card_id, None)
        if not card:
            return

        self._color_counter[card.dominant_color.to_tuple()] -= 1
        if card.location:
            key = (round(card.location.lat, 2), round(card.location.lon, 2))
            self._location_counter[key] -= 1
            if self._location_counter[key] <= 0:
                self._location_counter.pop(key, None)

        try:
            self._mood_accumulator.remove(card.mood_score)
        except ValueError:
            # Should never occur, but keep in sync defensively
            logger.debug("Mood score not found during removal.")

    # --------------------------------------------------------------------- #
    # Snapshot & metrics
    # --------------------------------------------------------------------- #
    def snapshot(self) -> TrendInsight:
        with self._lock:
            total_cards = len(self._cards_by_id)
            avg_mood = mean(self._mood_accumulator) if self._mood_accumulator else 0.0

            top_colors = self._reduce_colors(self._color_counter, max_items=8)
            hotspot_locations = self._top_locations(self._location_counter, max_items=5)

            return TrendInsight(
                total_cards=total_cards,
                top_colors=top_colors,
                hotspot_locations=hotspot_locations,
                avg_mood_score=avg_mood,
            )

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    def _reduce_colors(
        self, counter: Counter[Tuple[int, int, int]], *, max_items: int
    ) -> List[PaletteMetric]:
        """
        Clusters similar colors into buckets to avoid near-duplicate entries.
        """
        # Step 1: Sort by frequency
        sorted_colors = sorted(counter.items(), key=lambda kv: kv[1], reverse=True)
        buckets: List[Tuple[RGBColor, int]] = []

        # Step 2: Greedy clustering
        for color_tuple, count in sorted_colors:
            color = RGBColor(*color_tuple)
            for idx, (centroid, c_count) in enumerate(buckets):
                if color.distance(centroid) <= _AnalyticsEngine._COLOR_DISTANCE_THR:
                    # Merge into bucket
                    new_count = c_count + count
                    new_centroid = self._interpolate_color(
                        centroid, color, weight=count / new_count
                    )
                    buckets[idx] = (new_centroid, new_count)
                    break
            else:
                buckets.append((color, count))

        # Step 3: Take most-populated buckets
        buckets.sort(key=lambda item: item[1], reverse=True)
        return [
            PaletteMetric(rgb=centroid, count=c_count)
            for centroid, c_count in buckets[:max_items]
        ]

    @staticmethod
    def _interpolate_color(c1: RGBColor, c2: RGBColor, *, weight: float) -> RGBColor:
        inv = 1.0 - weight
        return RGBColor(
            r=int(c1.r * inv + c2.r * weight),
            g=int(c1.g * inv + c2.g * weight),
            b=int(c1.b * inv + c2.b * weight),
        )

    def _top_locations(
        self,
        counter: Counter[Tuple[int, int]],
        *,
        max_items: int,
    ) -> List[HotspotMetric]:
        most_common = counter.most_common(max_items)
        return [
            HotspotMetric(location=GeoPoint(lat=t[0], lon=t[1]), count=cnt)
            for t, cnt in most_common
        ]


# --------------------------------------------------------------------------- #
# Dev / Smoke test
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    import random
    import uuid

    logging.basicConfig(level=logging.DEBUG)

    engine = AnalyticsEngine.instance()

    palette = [
        RGBColor(255, 0, 0),
        RGBColor(250, 10, 10),
        RGBColor(0, 255, 0),
        RGBColor(0, 0, 255),
        RGBColor(255, 255, 0),
    ]
    user_id = "debug_user"

    # Simulate random cards
    for _ in range(50):
        card = PrismCard(
            card_id=str(uuid.uuid4()),
            user_id=user_id,
            created_at=time.time(),
            dominant_color=random.choice(palette),
            mood_score=random.uniform(-1.0, 1.0),
            location=GeoPoint(
                lat=37.77 + random.uniform(-0.1, 0.1),
                lon=-122.42 + random.uniform(-0.1, 0.1),
            ),
        )
        LOCAL_EVENT_BUS.publish(CardSavedEvent(card))

    time.sleep(1)

    insight = engine.get_insights()
    logger.info("Insight snapshot: %s", insight)

    prompts = engine.generate_prompts()
    logger.info("Prompts: %s", prompts)

    # Clean shutdown
    AnalyticsEngine.shutdown()
```