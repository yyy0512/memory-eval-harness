```python
"""
module_77.py

PrismPocket – Trending Analytics Engine
---------------------------------------

This module houses the “TrendingAnalyticsService”, a core domain–level component
that listens to `PrismCard` creation / mutation events and produces real-time
trend metrics such as:

    • Most-used color palettes (hex triplets)
    • Average “mood” score for the last N cards
    • Card creation velocity (cards / minute)

The service is intentionally *framework-agnostic* (does not import UIKit /
AndroidX) and can therefore run in shared Python on both iOS & Android or in a
serverless cloud function.

Patterns showcased:
    • Observer Pattern (lightweight EventBus)
    • Singleton (TrendingAnalyticsService)
    • Clean Architecture separation (pure domain logic)

Author: PrismPocket Team
"""

from __future__ import annotations

import asyncio
import collections
import dataclasses
import datetime as _dt
import logging
import os
import random
import threading
import time
from enum import Enum
from secrets import token_hex
from typing import (
    Any,
    AsyncGenerator,
    Awaitable,
    Callable,
    DefaultDict,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Sequence,
    Tuple,
)

try:
    from PIL import Image
except ImportError:  # Pillow is optional; analytics degrades gracefully.
    Image = None  # type: ignore

logger = logging.getLogger("prism.analytics")
_logger_handler = logging.StreamHandler()
_logger_handler.setFormatter(
    logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")
)
logger.addHandler(_logger_handler)
logger.setLevel(os.getenv("PRISM_LOG_LEVEL", "INFO").upper())

# --------------------------------------------------------------------------- #
# Observer Bus (simplified, thread-safe)                                      #
# --------------------------------------------------------------------------- #


class _Event(Protocol):
    """Protocol that every event must satisfy."""

    @property
    def timestamp(self) -> float:
        ...


class EventBus:
    """
    Very small, in-process pub/sub message bus.

    Implemented as a threadsafe Singleton so that shared libraries can tap into
    the same process-level dispatcher without DI/IoC plumbing.
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "EventBus":  # pragma: no cover
        with EventBus._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: DefaultDict[
                    str, List[Callable[[_Event], None]]
                ] = collections.defaultdict(list)
            return cls._instance

    def subscribe(self, event_name: str, callback: Callable[[_Event], None]) -> None:
        logger.debug("Subscribing %s to event '%s'", callback, event_name)
        self._subscribers[event_name].append(callback)

    def publish(self, event_name: str, event: _Event) -> None:
        logger.debug("Publishing event '%s' >> %s", event_name, event)
        for cb in self._subscribers[event_name]:
            try:
                cb(event)
            except Exception:  # pragma: no cover
                logger.exception("Unhandled exception in subscriber %s", cb)


# --------------------------------------------------------------------------- #
# Domain models                                                               #
# --------------------------------------------------------------------------- #


class Mood(Enum):
    SERENE = 1
    ENERGETIC = 2
    MELANCHOLY = 3
    NEUTRAL = 4

    @classmethod
    def random(cls) -> "Mood":
        return random.choice(list(cls))


@dataclasses.dataclass(frozen=True)
class PrismCard:
    """
    Pure domain entity representing a piece of captured content.
    """

    uuid: str
    created_at: _dt.datetime
    dominant_colors: Tuple[str, ...]  # Hex codes (e.g. "#ff00ff")
    mood: Mood

    @classmethod
    def create_mock(
        cls,
        colors: Optional[Tuple[str, ...]] = None,
        mood: Optional[Mood] = None,
    ) -> "PrismCard":
        """Convenience factory for tests / demos."""
        if colors is None:
            colors = tuple(random_hex() for _ in range(random.randint(1, 4)))
        if mood is None:
            mood = Mood.random()
        return cls(uuid=token_hex(8), created_at=_dt.datetime.utcnow(), dominant_colors=colors, mood=mood)


@dataclasses.dataclass(frozen=True)
class CardCreatedEvent:
    card: PrismCard
    _ts: float = dataclasses.field(default_factory=time.time)

    @property
    def timestamp(self) -> float:
        return self._ts


# --------------------------------------------------------------------------- #
# Metric containers                                                           #
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(frozen=True)
class PaletteMetric:
    color_hex: str
    usage_count: int
    last_seen: _dt.datetime


@dataclasses.dataclass
class TrendingSnapshot:
    palettes: List[PaletteMetric]
    avg_mood: Optional[float]  # Map enumeration to float for scoring.
    velocity_per_min: float
    generated_at: _dt.datetime


# --------------------------------------------------------------------------- #
# Color analytics helpers                                                     #
# --------------------------------------------------------------------------- #


def normalize_hex(value: str) -> str:
    """Normalize hex codes to the form '#rrggbb' lowercase."""
    value = value.strip().lower()
    if not value.startswith("#"):
        value = "#" + value
    if len(value) == 4:  # shorthand '#abc' -> '#aabbcc'
        value = "#" + "".join(c * 2 for c in value[1:])
    return value


def extract_dominant_colors(image_path: str, num_colors: int = 3) -> Tuple[str, ...]:
    """
    Attempt to extract *rough* dominant colors from an image using Pillow.
    Falls back to random placeholder colors if Pillow not available.

    Returns:
        Tuple of unique HEX strings sorted by luminance.
    """
    if Image is None:
        logger.warning("Pillow unavailable; using placeholder colors")
        return tuple(random_hex() for _ in range(num_colors))

    try:
        with Image.open(image_path) as img:
            # Use Pillow's built-in getcolors (with a limit) for simplicity.
            img = img.convert("RGB")
            colors = img.getcolors(maxcolors=1024)  # (count, (r, g, b))
            if not colors:
                raise ValueError("No colors found in image")
            # Sort by count descending, take top N.
            dominant = sorted(colors, key=lambda c: c[0], reverse=True)[:num_colors]
            hexes = [rgb_to_hex(*rgb) for _, rgb in dominant]
            logger.debug("Extracted colors %s from %s", hexes, image_path)
            return tuple(hexes)
    except Exception as exc:  # pragma: no cover
        logger.exception("Failed to extract colors: %s", exc)
        return tuple(random_hex() for _ in range(num_colors))


def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def random_hex() -> str:
    """Generate a random pastel-ish colour for placeholder usage."""
    r = random.randint(100, 255)
    g = random.randint(100, 255)
    b = random.randint(100, 255)
    return rgb_to_hex(r, g, b)


# --------------------------------------------------------------------------- #
# Trending Analytics Service                                                  #
# --------------------------------------------------------------------------- #


class TrendingAnalyticsService:
    """
    Singleton service that maintains sliding-window statistics for recent cards.

    It subscribes to the EventBus, accumulates data in-memory, and periodically
    emits a `TrendingSnapshot`. Consumers (UI ViewModels, cloud sync routines)
    can `await` snapshots via the async generator `stream_snapshots`.
    """

    WINDOW_SEC = 5 * 60  # 5 minutes
    _instance: Optional["TrendingAnalyticsService"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "TrendingAnalyticsService":  # pragma: no cover
        with TrendingAnalyticsService._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init_state()
            return cls._instance

    # --------------------------- Initialization --------------------------- #

    def _init_state(self) -> None:
        self._events: List[CardCreatedEvent] = []
        self._palette_counter: collections.Counter[str] = collections.Counter()
        self._avg_mood: float = 0.0
        self._snapshot_listeners: List[asyncio.Queue[TrendingSnapshot]] = []

        # Register with EventBus
        EventBus().subscribe("card.created", self._on_card_created)

        # Async task for snapshot generation
        self._loop = asyncio.get_event_loop()
        self._stop_event = threading.Event()
        self._bg_thread = threading.Thread(
            target=self._run_background_loop, name="TrendingAnalyticsLoop", daemon=True
        )
        self._bg_thread.start()
        logger.info("TrendingAnalyticsService started")

    # --------------------------- Event Invocations ------------------------ #

    def _on_card_created(self, event: CardCreatedEvent) -> None:
        logger.debug("Processing CardCreatedEvent %s", event.card.uuid)
        self._events.append(event)
        for color in event.card.dominant_colors:
            self._palette_counter[normalize_hex(color)] += 1

        # Online moving average mood score
        total_n = len(self._events)
        self._avg_mood = ((self._avg_mood * (total_n - 1)) + event.card.mood.value) / total_n

    # ------------------------- Snapshot Generation ------------------------ #

    async def stream_snapshots(self, *, every_sec: int = 30) -> AsyncGenerator[TrendingSnapshot, None]:
        """
        Async generator that yields TrendingSnapshot every `every_sec` seconds.
        Each consumer gets its own queue to decouple backpressure.
        """
        queue: asyncio.Queue[TrendingSnapshot] = asyncio.Queue(maxsize=3)
        self._snapshot_listeners.append(queue)

        try:
            # Immediately push the first snapshot
            queue.put_nowait(self._compute_snapshot())
            while True:
                yield await queue.get()
        finally:
            self._snapshot_listeners.remove(queue)

    def _run_background_loop(self) -> None:  # pragma: no cover (sync method)
        asyncio.set_event_loop(asyncio.new_event_loop())
        loop = asyncio.get_event_loop()
        loop.run_until_complete(self._snapshot_pump())
        loop.close()

    async def _snapshot_pump(self) -> None:
        """
        Background coroutine that ticks every 30 seconds and dispatches snapshot.
        """
        while not self._stop_event.is_set():
            await asyncio.sleep(30)
            snapshot = self._compute_snapshot()
            for q in list(self._snapshot_listeners):
                if q.full():
                    try:
                        q.get_nowait()  # Discard old snapshot if consumer is slow
                    except asyncio.QueueEmpty:  # pragma: no cover
                        pass
                q.put_nowait(snapshot)

    # ------------------------- Core Aggregation --------------------------- #

    def _compute_snapshot(self) -> TrendingSnapshot:
        now = _dt.datetime.utcnow()
        # Purge events outside window
        cutoff_ts = time.time() - self.WINDOW_SEC
        while self._events and self._events[0].timestamp < cutoff_ts:
            expired = self._events.pop(0)
            for color in expired.card.dominant_colors:
                self._palette_counter[normalize_hex(color)] -= 1
            # Remove zero / negative counts
            self._palette_counter += collections.Counter()  # clean negatives

        # Build PaletteMetric list
        palettes = [
            PaletteMetric(color_hex=hex_code, usage_count=count, last_seen=now)
            for hex_code, count in self._palette_counter.most_common(10)
            if count > 0
        ]

        # Card velocity calculation
        time_span_min = self.WINDOW_SEC / 60
        velocity = len(self._events) / time_span_min

        snapshot = TrendingSnapshot(
            palettes=palettes,
            avg_mood=round(self._avg_mood, 2) if self._events else None,
            velocity_per_min=velocity,
            generated_at=now,
        )
        logger.debug("Generated TrendingSnapshot: %s", snapshot)
        return snapshot

    # ------------------------- Lifecycle Mgmt ----------------------------- #

    def stop(self) -> None:
        """Gracefully shutdown the background thread (only in unit tests)."""
        self._stop_event.set()
        logger.info("Stopping TrendingAnalyticsService...")


# --------------------------------------------------------------------------- #
# Convenience facade for module consumers                                     #
# --------------------------------------------------------------------------- #


def get_trending_service() -> TrendingAnalyticsService:
    """
    Global accessor used by presentation-layer ViewModels.

    Example:
        trending = get_trending_service()
        async for snapshot in trending.stream_snapshots():
            render(snapshot)
    """
    return TrendingAnalyticsService()


# --------------------------------------------------------------------------- #
# Manual test / demonstration                                                 #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    async def main() -> None:
        svc = get_trending_service()

        bus = EventBus()

        # Simulate 20 new cards
        for _ in range(20):
            card = PrismCard.create_mock()
            bus.publish("card.created", CardCreatedEvent(card))
            await asyncio.sleep(random.uniform(0.1, 0.5))

        # Listen to snapshots
        async for snap in svc.stream_snapshots(every_sec=5):
            logger.info("Snapshot: palettes=%s mood=%.2f velocity=%.2f/min", snap.palettes, snap.avg_mood, snap.velocity_per_min)

    asyncio.run(main())
```