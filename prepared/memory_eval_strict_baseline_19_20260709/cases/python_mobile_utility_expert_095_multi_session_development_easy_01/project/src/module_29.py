```python
"""
PrismPocket – mobile_utility
src/module_29.py

This module houses a small but self-contained slice of the PrismPocket
analytics layer.  It demonstrates several architectural concepts that
appear throughout the wider code-base:

1. Domain Entities (PrismCard, PaletteMetric)
2. Observer Pattern via a process-wide EventBus (thread-safe Singleton)
3. AnalyticsEngine that ingests cards, crunches numbers, and publishes
   incremental results
4. Factory pattern (make_analytics_engine) decoupling composition
5. Robust logging / error handling suitable for production use

Nothing here depends on platform-specific APIs, so it can be shared by
iOS & Android builds without modification.
"""
from __future__ import annotations

import asyncio
import colorsys
import concurrent.futures
import logging
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from random import random
from statistics import mean
from typing import Callable, Dict, Iterable, List, MutableMapping, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #
logger = logging.getLogger("prism.analytics")
if not logger.handlers:
    # Avoid duplicate handlers in reload scenarios (e.g. during unit tests)
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s "
            "[%(name)s:%(lineno)d] %(message)s",
            "%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Domain entities (could be imported from prism.domain.* in real project)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PrismCard:
    """
    A distilled representation of a user capture.

    Attributes
    ----------
    id: str
        Globally unique identifier.
    author_id: str
        Owner of the card.
    color_palette: List[str]
        Up to five dominant colors, hex encoded (#RRGGBB).
    mood_vector: Tuple[float, float, float]
        Normalised sentiment scores (negative, neutral, positive). Sum≈1.0.
    created_ts: float
        Unix timestamp (seconds).
    """

    id: str
    author_id: str
    color_palette: Sequence[str]
    mood_vector: Tuple[float, float, float]
    created_ts: float = field(default_factory=time.time)

    # The real entity has many more fields (media blobs, annotations, etc.)


@dataclass
class PaletteMetric:
    """
    Aggregated trending information emitted by AnalyticsEngine.
    """

    timestamp: float
    top_colors: List[str]
    usage_counts: Dict[str, int]
    average_mood_score: float  # +1.0 = positive, 0 = neutral, -1.0 = negative


# --------------------------------------------------------------------------- #
# Observer: EventBus (Singleton, thread-safe)
# --------------------------------------------------------------------------- #


class _Singleton(type):
    """Simple Singleton metaclass."""

    _instances: Dict[type, "_Singleton"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class EventBus(metaclass=_Singleton):
    """
    A minimal, thread-safe pub/sub bus.

    Subscribers register a callback (sync or async) that expects one positional
    argument – the event payload.  Publishers broadcast arbitrary payloads.
    """

    def __init__(self) -> None:
        self._subscribers: "weakref.WeakSet[Callable[[object], None]]" = (
            __import__("weakref").WeakSet()
        )
        self._lock = threading.RLock()

    # Subscription API ------------------------------------------------------- #
    def subscribe(self, cb: Callable[[object], None]) -> None:
        with self._lock:
            self._subscribers.add(cb)
            logger.debug("Subscriber added (%s)", cb)

    def unsubscribe(self, cb: Callable[[object], None]) -> None:
        with self._lock:
            self._subscribers.discard(cb)
            logger.debug("Subscriber removed (%s)", cb)

    # Publishing ------------------------------------------------------------- #
    def publish(self, payload: object) -> None:
        """
        Synchronously broadcast payload to all subscribers.  Async subscribers
        will be scheduled via asyncio.create_task.
        """
        with self._lock:
            subscribers = list(self._subscribers)

        for cb in subscribers:
            try:
                if asyncio.iscoroutinefunction(cb):

                    async def _dispatch_async(coro_fn: Callable[[object], None]):
                        try:
                            await coro_fn(payload)
                        except Exception:
                            logger.exception("Async subscriber failed")

                    asyncio.get_event_loop().create_task(_dispatch_async(cb))  # type: ignore[arg-type]
                else:
                    cb(payload)
            except Exception:
                logger.exception("Subscriber %s raised", cb)


# --------------------------------------------------------------------------- #
# AnalyticsEngine
# --------------------------------------------------------------------------- #


class AnalyticsEngine:
    """
    Stateful processor generating palette & mood metrics in real-time.

    In production this would run in its own service coroutine and be fed
    through a repository stream.  Here we expose an imperative interface for
    brevity.
    """

    DEFAULT_WINDOW = 60 * 60 * 24  # 24h sliding window

    def __init__(
        self,
        bus: EventBus,
        executor: Optional[concurrent.futures.Executor] = None,
        sliding_window: int = DEFAULT_WINDOW,
    ) -> None:
        self._bus = bus
        self._window = sliding_window
        self._executor = executor or concurrent.futures.ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="analytics"
        )

        # Internal state protected by lock
        self._lock = threading.RLock()
        self._cards: Dict[str, PrismCard] = {}

    # --------------------------------------------------------------------- #
    # Ingestion
    # --------------------------------------------------------------------- #
    def ingest(self, card: PrismCard) -> None:
        """
        Accept a new PrismCard and schedule asynchronous metric update.
        """
        logger.debug("Ingesting card %s", card.id)
        with self._lock:
            self._cards[card.id] = card
            self._evict_old_locked()

        # Schedule heavy work out of the current thread
        self._executor.submit(self._recalculate_and_publish)

    # --------------------------------------------------------------------- #
    # Public Query Helpers
    # --------------------------------------------------------------------- #
    def get_trending_palette(self, top_n: int = 5) -> List[str]:
        with self._lock:
            palette_counter = Counter(
                clr for c in self._cards.values() for clr in c.color_palette
            )
        return [c for c, _ in palette_counter.most_common(top_n)]

    # --------------------------------------------------------------------- #
    # Internal
    # --------------------------------------------------------------------- #
    def _recalculate_and_publish(self) -> None:
        """
        Aggregates palette & mood stats then publishes a PaletteMetric event.
        """
        try:
            metric = self._build_metric()
            logger.info(
                "Publishing PaletteMetric: top_colors=%s avg_mood=%.2f",
                metric.top_colors,
                metric.average_mood_score,
            )
            self._bus.publish(metric)
        except Exception:
            logger.exception("Failed to compute/publish metric")

    def _build_metric(self) -> PaletteMetric:
        """
        (Potentially expensive) computation of aggregated metrics.
        """
        now = time.time()
        # Snap a consistent view of cards
        with self._lock:
            cards = list(self._cards.values())

        # Color trending --------------------------------------------------- #
        color_counter: Counter[str] = Counter(
            clr for c in cards for clr in c.color_palette
        )
        top_colors = [c for c, _ in color_counter.most_common(5)]

        # Mood ------------------------------------------------------------- #
        mood_scores = [self._vector_to_scalar(c.mood_vector) for c in cards]
        avg_mood = mean(mood_scores) if mood_scores else 0.0

        return PaletteMetric(
            timestamp=now,
            top_colors=top_colors,
            usage_counts=dict(color_counter),
            average_mood_score=avg_mood,
        )

    def _evict_old_locked(self) -> None:
        """
        Remove cards older than sliding window.
        Caller must hold self._lock.
        """
        threshold = time.time() - self._window
        stale = [cid for cid, c in self._cards.items() if c.created_ts < threshold]
        for cid in stale:
            self._cards.pop(cid, None)
        if stale:
            logger.debug("Evicted %d stale cards", len(stale))

    # --------------------------------------------------------------------- #
    # Static helpers
    # --------------------------------------------------------------------- #
    @staticmethod
    @lru_cache(maxsize=1024)
    def _vector_to_scalar(mood: Tuple[float, float, float]) -> float:
        """
        Convert 3-way mood vector to scalar in range [-1, +1].
        (positive - negative) ignoring neutral.
        """
        negative, neutral, positive = mood
        return positive - negative


# --------------------------------------------------------------------------- #
# Factory (Factory Pattern)
# --------------------------------------------------------------------------- #
def make_analytics_engine(bus: Optional[EventBus] = None) -> AnalyticsEngine:
    """
    Factory helper to instantiate AnalyticsEngine with default plumbing.
    """
    bus = bus or EventBus()
    engine = AnalyticsEngine(bus=bus)
    return engine


# --------------------------------------------------------------------------- #
# Example subscriber (would live elsewhere in real app)
# --------------------------------------------------------------------------- #
async def _async_logger(metric: PaletteMetric) -> None:
    # Simulate IO work
    await asyncio.sleep(0)
    logger.info("Async consumer received metric @ %.0f", metric.timestamp)


def _register_demo_subscriber(bus: EventBus) -> None:
    bus.subscribe(_async_logger)


# --------------------------------------------------------------------------- #
# Demo
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    """
    Rudimentary smoke test runnable via:

        $ python -m src.module_29

    It feeds random cards into the engine and prints metrics.  DO NOT ship
    this block into mobile builds; it is purely for local debugging.
    """
    import uuid
    import random

    async def _main() -> None:
        bus = EventBus()
        _register_demo_subscriber(bus)
        engine = make_analytics_engine(bus)

        def _rand_color() -> str:
            # Generate pastel-ish random colors
            h, s, v = random.random(), 0.6, 0.95
            r, g, b = colorsys.hsv_to_rgb(h, s, v)
            return f"#{int(r*255):02X}{int(g*255):02X}{int(b*255):02X}"

        for _ in range(50):
            card = PrismCard(
                id=str(uuid.uuid4()),
                author_id="demo",
                color_palette=[_rand_color() for _ in range(random.randint(1, 5))],
                mood_vector=(
                    random.random() * 0.5,
                    random.random() * 0.2,
                    random.random() * 0.5,
                ),
            )
            engine.ingest(card)
            await asyncio.sleep(0.05)

        # Let background tasks flush
        await asyncio.sleep(1.0)

    asyncio.run(_main())

```