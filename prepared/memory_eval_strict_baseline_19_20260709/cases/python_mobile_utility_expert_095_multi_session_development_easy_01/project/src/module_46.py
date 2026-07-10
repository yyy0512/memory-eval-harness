```python
"""
PrismPocket – module_46.py
==========================

Real-time analytics aggregation and prompt-generation engine.

This module ingests `PrismCard` domain objects as they stream in from
repositories.  It accumulates lightweight, in-memory statistics that surface
creative trends (top colours, palette popularity, geographic hotspots, mood)
and pushes `TrendMetrics` snapshots over an Observer bus.  A small prompt
factory turns these metrics into playful, human-readable suggestions that
can be surfaced by the UI layer.

The code purposefully avoids heavyweight scientific libraries to remain
mobile-friendly.  All heavy models run in the cloud worker tier; the mobile
tier only needs quick heuristics for instantly responsive feedback.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import random
import threading
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from statistics import mean
from typing import Callable, Deque, Dict, Iterable, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #
logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)

# A NullHandler allows library use without configuring root logging.
if not logger.handlers:
    logger.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
# Domain primitives                                                           #
# --------------------------------------------------------------------------- #
class ContentType(str, enum.Enum):
    """Enumeration of PrismCard captures."""
    TEXT = "text"
    PHOTO = "photo"
    VOICE = "voice"
    GEOTAG = "geotag"
    SKETCH = "sketch"


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    A _very_ trimmed-down representation of the domain entity.

    Only the analytics-relevant bits are represented here to keep this module
    decoupled from the full data layer.
    """
    id: str
    user_id: str
    timestamp: datetime
    colors: Tuple[str, ...]  # Hex colours, e.g. ("#FFAA12", "#1100EE")
    location: Optional[Tuple[float, float]]  # (lat, lon) or None when absent
    mood_score: Optional[int]  # 1-5 scale, None when unknown
    content_type: ContentType


# --------------------------------------------------------------------------- #
# Observer Bus (very lightweight)                                             #
# --------------------------------------------------------------------------- #
TrendListener = Callable[["TrendMetrics"], None]


class MetricsBus:
    """
    Thread-safe Observer bus.

    Subscribers register callbacks that will be invoked synchronously from
    the publishing thread.  Keep callbacks lightweight and offload blocking
    tasks.
    """

    _lock = threading.Lock()

    def __init__(self) -> None:
        self._subscribers: List[TrendListener] = []

    def subscribe(self, listener: TrendListener) -> None:
        with self._lock:
            if listener not in self._subscribers:
                self._subscribers.append(listener)
                logger.debug("Listener %s subscribed", listener)

    def unsubscribe(self, listener: TrendListener) -> None:
        with self._lock:
            try:
                self._subscribers.remove(listener)
                logger.debug("Listener %s unsubscribed", listener)
            except ValueError:
                pass  # idempotent

    def publish(self, snapshot: "TrendMetrics") -> None:
        with self._lock:
            subscribers = list(self._subscribers)

        for listener in subscribers:
            # We swallow all exceptions so that one bad consumer does not
            # break the chain; they are logged for diagnostics.
            try:
                listener(snapshot)
            except Exception:  # noqa: BLE001
                logger.exception("Uncaught exception in metrics listener")


# --------------------------------------------------------------------------- #
# Statistics dataclass                                                        #
# --------------------------------------------------------------------------- #
@dataclass(slots=True, frozen=True)
class TrendMetrics:
    """Immutable snapshot of analytics insights."""
    generated_at: datetime
    top_colors: List[str]
    top_palettes: List[Tuple[str, ...]]
    hotspot_locations: List[Tuple[float, float]]
    average_mood: Optional[float]


# --------------------------------------------------------------------------- #
# Analytics Aggregator (Singleton)                                            #
# --------------------------------------------------------------------------- #
class AnalyticsAggregator:
    """
    Central accumulator producing real-time `TrendMetrics`.

    Implementation notes
    --------------------
    • Uses `Counter` for frequency statistics.
    • Keeps bounded deques to prevent unbounded memory usage.
    • Gathers raw events quickly; heavier work executed in background task.
    """

    _instance: "AnalyticsAggregator" | None = None
    _singleton_lock = threading.Lock()

    # Tunables
    _HISTORY_WINDOW = timedelta(minutes=30)  # Only cards inside this window
    _MAX_DEQUE_SIZE = 5_000
    _GRID_SIZE_DEG = 0.1  # Coarse geo grid for hotspot detection
    _TOP_N = 5

    def __new__(cls) -> "AnalyticsAggregator":  # noqa: D401
        with cls._singleton_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init_singleton()
        return cls._instance

    # --------------------------------------------------------------------- #
    # Initialisation                                                        #
    # --------------------------------------------------------------------- #
    def _init_singleton(self) -> None:
        # Raw event store
        self._cards: Deque[PrismCard] = deque(maxlen=self._MAX_DEQUE_SIZE)

        # Derived counters
        self._color_counter: Counter[str] = Counter()
        self._palette_counter: Counter[Tuple[str, ...]] = Counter()
        self._location_counter: Counter[Tuple[float, float]] = Counter()
        self._mood_scores: List[int] = []

        # Thread-safety primitives
        self._lock = threading.RLock()

        # Observer bus
        self._bus = MetricsBus()

        # Async scheduling
        self._loop = asyncio.get_event_loop_policy().get_event_loop()
        self._broadcast_task: Optional[asyncio.Task[None]] = None

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #
    def register_listener(self, listener: TrendListener) -> None:
        """Subscribe to metric snapshots."""
        self._bus.subscribe(listener)

    def unregister_listener(self, listener: TrendListener) -> None:
        """Unsubscribe from metric snapshots."""
        self._bus.unsubscribe(listener)

    def process_card(self, card: PrismCard) -> None:
        """
        Ingest a single `PrismCard` event.

        Fast path: only cheap operations under lock.
        """
        if card is None:
            raise ValueError("card must not be None")

        with self._lock:
            self._cards.append(card)

            # --- Colour stats
            self._color_counter.update(card.colors)
            self._palette_counter.update([card.colors])

            # --- Location stats
            if card.location:
                grid_id = self._to_grid(*card.location)
                self._location_counter.update([grid_id])

            # --- Mood stats
            if card.mood_score:
                self._mood_scores.append(card.mood_score)

        logger.debug("Processed PrismCard %s", card.id)

    def start_auto_flush(self, interval_seconds: float = 5.0) -> None:
        """
        Start background task that periodically broadcasts `TrendMetrics`.
        """
        if self._broadcast_task and not self._broadcast_task.done():
            logger.debug("Auto flush already running")
            return

        async def _auto_flush() -> None:
            logger.info("Analytics auto-flush started (interval %.1fs)",
                        interval_seconds)
            while True:
                try:
                    snapshot = self._build_snapshot()
                    self._bus.publish(snapshot)
                except Exception:  # noqa: BLE001
                    logger.exception("Failed to build or publish snapshot")
                await asyncio.sleep(interval_seconds)

        self._broadcast_task = self._loop.create_task(_auto_flush())

    # --------------------------------------------------------------------- #
    # Internal calculations                                                 #
    # --------------------------------------------------------------------- #
    def _build_snapshot(self) -> TrendMetrics:
        with self._lock:
            self._prune_expired()

            top_colors = [c for c, _ in self._color_counter.most_common(self._TOP_N)]
            top_palettes = [p for p, _ in self._palette_counter.most_common(self._TOP_N)]
            hotspots = [loc for loc, _ in self._location_counter.most_common(self._TOP_N)]
            avg_mood = mean(self._mood_scores) if self._mood_scores else None

            snapshot = TrendMetrics(
                generated_at=datetime.utcnow(),
                top_colors=top_colors,
                top_palettes=top_palettes,
                hotspot_locations=hotspots,
                average_mood=avg_mood,
            )
            logger.debug("Snapshot generated: %s", snapshot)
            return snapshot

    # --------------------------------------------------------------------- #
    # Utility                                                               #
    # --------------------------------------------------------------------- #
    def _prune_expired(self) -> None:
        """
        Remove data that falls outside the time window.

        This ensures stats feel _live_ and memory stays bounded.
        """
        cutoff = datetime.utcnow() - self._HISTORY_WINDOW
        removed_cards: List[PrismCard] = []

        # Because we use a deque, expired cards should be at the left.
        while self._cards and self._cards[0].timestamp < cutoff:
            removed_cards.append(self._cards.popleft())

        if not removed_cards:
            return  # Fast exit

        # Recompute counters cheaply
        self._rebuild_counters(list(self._cards))
        logger.debug("Pruned %d expired cards", len(removed_cards))

    def _rebuild_counters(self, cards: Iterable[PrismCard]) -> None:
        """Expensive full rebuild of counters; called only when we prune."""
        self._color_counter.clear()
        self._palette_counter.clear()
        self._location_counter.clear()
        self._mood_scores.clear()

        for card in cards:
            self._color_counter.update(card.colors)
            self._palette_counter.update([card.colors])

            if card.location:
                self._location_counter.update([self._to_grid(*card.location)])

            if card.mood_score:
                self._mood_scores.append(card.mood_score)

    @classmethod
    def _to_grid(cls, lat: float, lon: float) -> Tuple[float, float]:
        """Coarsen latitude/longitude to a grid cell."""
        g = cls._GRID_SIZE_DEG
        return (round(lat / g) * g, round(lon / g) * g)


# --------------------------------------------------------------------------- #
# Artistic Prompt Factory                                                     #
# --------------------------------------------------------------------------- #
class PromptFactory:
    """
    Generates playful, context-aware creative prompts from `TrendMetrics`.

    This engine is intentionally heuristic—heavier AI lives server-side.
    """

    _GENERIC_PROMPTS = [
        "Layer a complementary colour splash!",
        "Try a gradient background for your next card.",
        "Experiment with negative space and see how it feels.",
        "Add a handwritten note overlay.",
        "Use a sticker that captures your current mood.",
    ]

    @classmethod
    def make_prompt(cls, metrics: TrendMetrics) -> str:
        """
        Turn `TrendMetrics` into a single human-readable suggestion.
        """
        if not metrics.top_colors and not metrics.hotspot_locations:
            return random.choice(cls._GENERIC_PROMPTS)

        prompt_parts: List[str] = []

        # Colour-centric prompt
        if metrics.top_colors:
            color = random.choice(metrics.top_colors)
            prompt_parts.append(
                f"Your community is vibing with {color}. "
                "Why not weave it into your next Prism?"
            )

        # Geolocation prompt
        if metrics.hotspot_locations:
            lat, lon = random.choice(metrics.hotspot_locations)
            prompt_parts.append(
                f"Cards from around {lat:.1f}°, {lon:.1f}° are trending—"
                "capture a snippet if you're nearby!"
            )

        # Mood prompt
        if metrics.average_mood is not None:
            mood_word = cls._mood_label(metrics.average_mood)
            prompt_parts.append(
                f"Overall mood feels {mood_word}. "
                "Match the vibe or flip it with a bold twist."
            )

        # Final composition
        return " ".join(prompt_parts)

    @staticmethod
    def _mood_label(score: float) -> str:
        if score >= 4:
            return "upbeat"
        if score >= 3:
            return "chill"
        if score >= 2:
            return "pensive"
        return "moody"


# --------------------------------------------------------------------------- #
# Example façade API (for quick integration)                                  #
# --------------------------------------------------------------------------- #
_aggregator: AnalyticsAggregator = AnalyticsAggregator()


def ingest_prism_card(card: PrismCard) -> None:
    """
    Convenience wrapper to feed cards into the global aggregator.
    """
    _aggregator.process_card(card)


def start_metrics_stream(
    listener: TrendListener, interval_seconds: float | int = 5
) -> None:
    """
    Kick off a periodic metrics stream to the provided listener.
    """
    _aggregator.register_listener(listener)
    _aggregator.start_auto_flush(float(interval_seconds))


# --------------------------------------------------------------------------- #
# Stand-alone demonstration (executed when run as script)                     #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    logging.basicConfig(
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        level=logging.DEBUG,
    )

    # Dummy listener that prints prompt on every snapshot
    def _print_prompt(metrics: TrendMetrics) -> None:
        print("Prompt:", PromptFactory.make_prompt(metrics))

    start_metrics_stream(_print_prompt, interval_seconds=3)

    # Simulate random card ingestion
    async def _simulate_ingest() -> None:
        user_id = "demoUser"
        while True:
            card = PrismCard(
                id=str(random.randint(1000, 9999)),
                user_id=user_id,
                timestamp=datetime.utcnow(),
                colors=tuple(random.sample(
                    ["#FF5733", "#33FFCE", "#FF33A8", "#335BFF", "#FFBD33"], k=2)
                ),
                location=(random.uniform(-90, 90), random.uniform(-180, 180)),
                mood_score=random.randint(1, 5),
                content_type=random.choice(list(ContentType)),
            )
            ingest_prism_card(card)
            await asyncio.sleep(random.uniform(0.2, 1.0))

    asyncio.get_event_loop().run_until_complete(_simulate_ingest())
```