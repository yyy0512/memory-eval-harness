```python
"""
src/module_33.py
================

Real-time analytics and prompt-generation engine for PrismPocket.

This module listens to domain events published by the global ObserverBus,
derives creative trends (e.g. most-used color palettes, hotspot locations,
and crowd mood) and emits artistic prompts that can be displayed by the
UI or stored in the cloud workspace.

The implementation purposefully avoids any mobile-specific APIs and keeps
all domain logic testable and platform-agnostic, in line with PrismPocket’s
Clean Architecture.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import statistics
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from random import choice, randint
from typing import Callable, Dict, Iterable, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Fallback definitions for external interfaces to keep the file runnable
# during local development and CI. These will be monkey-patched at runtime
# by the actual application bootstrap code.
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

try:
    # Real modules in the full project should shadow these.
    from observer_bus import ObserverBus  # type: ignore
except Exception:  # pragma: no cover – dev/CI placeholder
    class _EphemeralBus:
        """Minimal stub that supports subscribe() and publish()."""

        def __init__(self) -> None:
            self._subscribers: List[Callable] = []

        def subscribe(self, callback: Callable) -> None:
            self._subscribers.append(callback)

        def publish(self, event: object) -> None:
            for cb in list(self._subscribers):
                try:
                    cb(event)
                except Exception:  # pragma: no cover
                    logger.exception("Observer callback failed")

    ObserverBus = _EphemeralBus()  # type: ignore


try:
    from repository import TrendRepository  # type: ignore
except Exception:  # pragma: no cover
    class TrendRepository:  # type: ignore
        """In-memory development stub."""

        def __init__(self) -> None:
            self._storage: Dict[str, object] = {}

        async def save_trend(self, key: str, value: object) -> None:  # noqa: D401
            self._storage[key] = value

        async def fetch_trend(self, key: str) -> Optional[object]:  # noqa: D401
            return self._storage.get(key)


# --------------------------------------------------------------------------- #
# Domain stubs – used only for type-checking in isolation.
# Actual implementations live in the domain layer of the project.
# --------------------------------------------------------------------------- #

# Palette is represented as a tuple of six-digit RGB hex strings, e.g. ("#FFAA00", ...)
Palette = Tuple[str, ...]

# Geolocation as (latitude, longitude)
GeoPoint = Tuple[float, float]


@dataclass(frozen=True, slots=True)
class PrismCard:
    id: str
    palette: Palette
    location: Optional[GeoPoint]
    mood_score: float  # –1.0 (negative) to 1.0 (positive)
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True, slots=True)
class CardCreatedEvent:
    card: PrismCard
    timestamp: float = field(default_factory=time.time)


@dataclass(frozen=True, slots=True)
class CardUpdatedEvent:
    before: PrismCard
    after: PrismCard
    timestamp: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
# Singleton meta class
# --------------------------------------------------------------------------- #

class _Singleton(type):
    _instances: Dict[type, "RealTimeAnalyticsEngine"] = {}

    def __call__(cls, *args, **kwargs):  # noqa: D401
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)  # type: ignore[arg-type]
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# Analytics Engine
# --------------------------------------------------------------------------- #

_WindowSizeSec = 60 * 60 * 6  # 6-hour rolling window for trend computation


class RealTimeAnalyticsEngine(metaclass=_Singleton):
    """
    Central aggregate that consumes card events and updates analytical metrics.

    Thread-safe and coroutine-friendly: ingestion happens on the Observer
    callback thread while heavy calculations are offloaded to an asyncio loop.
    """

    def __init__(
        self,
        bus: ObserverBus = ObserverBus,  # type: ignore[valid-type]
        repository: TrendRepository = TrendRepository(),  # type: ignore[valid-type]
    ) -> None:
        self._bus = bus
        self._repo = repository
        self._lock = threading.RLock()

        # Raw event storage (rolling window)
        self._palette_counter: Counter[Palette] = Counter()
        self._locations: List[GeoPoint] = []
        self._mood_scores: List[float] = []

        self._event_buffer: List[CardCreatedEvent | CardUpdatedEvent] = []

        # Start ingestion loop
        self._loop = asyncio.get_event_loop()
        self._queue: asyncio.Queue[CardCreatedEvent | CardUpdatedEvent] = asyncio.Queue()

        # Subscribe to bus
        self._bus.subscribe(self._on_event)

        # Kick off background coroutine
        self._loop.create_task(self._async_ingest())

        logger.info("RealTimeAnalyticsEngine initialized and subscribed")

    # --------------------------------------------------------------------- #
    # Observer callback
    # --------------------------------------------------------------------- #

    def _on_event(self, event: object) -> None:
        """Push relevant events into the async queue."""
        if isinstance(event, (CardCreatedEvent, CardUpdatedEvent)):
            try:
                self._queue.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover
                logger.warning("Analytics queue full; dropping event")

    # --------------------------------------------------------------------- #
    # Async ingestion
    # --------------------------------------------------------------------- #

    async def _async_ingest(self) -> None:
        """Continuously consume events and update metrics."""
        while True:
            event = await self._queue.get()
            with contextlib.suppress(Exception):
                self._digest_event(event)
            self._queue.task_done()

            # Periodically persist trends (non-blocking)
            if randint(0, 50) == 0:  # ~2% chance per event
                await self._persist_trends()

    # --------------------------------------------------------------------- #
    # Event processing
    # --------------------------------------------------------------------- #

    def _digest_event(self, event: CardCreatedEvent | CardUpdatedEvent) -> None:
        """Update counters in a threadsafe way."""
        with self._lock:
            if isinstance(event, CardCreatedEvent):
                self._ingest_card(event.card)
            elif isinstance(event, CardUpdatedEvent):
                # Update requires removal of old data then ingestion of new
                self._un_ingest_card(event.before)
                self._ingest_card(event.after)
            self._trim_window()

    def _ingest_card(self, card: PrismCard) -> None:
        self._palette_counter[card.palette] += 1

        if card.location:
            self._locations.append(card.location)

        self._mood_scores.append(card.mood_score)
        self._event_buffer.append(
            CardCreatedEvent(card=card, timestamp=card.created_at.timestamp())
        )

    def _un_ingest_card(self, card: PrismCard) -> None:
        # Safe decrement
        if self._palette_counter[card.palette] > 0:
            self._palette_counter[card.palette] -= 1

        if card.location and card.location in self._locations:
            self._locations.remove(card.location)

        with contextlib.suppress(ValueError):
            self._mood_scores.remove(card.mood_score)

    def _trim_window(self) -> None:
        """Remove data older than the rolling window length."""
        cutoff = time.time() - _WindowSizeSec
        filtered_events = [e for e in self._event_buffer if e.timestamp >= cutoff]
        if len(filtered_events) != len(self._event_buffer):
            # Rebuild storage from scratch for accuracy
            self._palette_counter.clear()
            self._locations.clear()
            self._mood_scores.clear()

            for e in filtered_events:
                self._ingest_card(e.card)  # type: ignore[attr-defined]
            self._event_buffer = filtered_events

    # --------------------------------------------------------------------- #
    # Trend getters
    # --------------------------------------------------------------------- #

    def most_common_palette(self) -> Optional[Palette]:
        with self._lock:
            palette, _ = self._palette_counter.most_common(1)[0] if self._palette_counter else (None, 0)
            return palette

    def hotspot_location(self) -> Optional[GeoPoint]:
        with self._lock:
            if not self._locations:
                return None
            latitudes = [lat for lat, _ in self._locations]
            longitudes = [lng for _, lng in self._locations]
            return statistics.mean(latitudes), statistics.mean(longitudes)

    def average_mood(self) -> Optional[float]:
        with self._lock:
            return statistics.fmean(self._mood_scores) if self._mood_scores else None

    async def _persist_trends(self) -> None:
        """Persist current trends for long-term analytics."""
        try:
            palette = self.most_common_palette()
            hotspot = self.hotspot_location()
            mood = self.average_mood()

            await asyncio.gather(
                self._repo.save_trend("top_palette", palette),
                self._repo.save_trend("hotspot", hotspot),
                self._repo.save_trend("avg_mood", mood),
            )
            logger.debug("Persisted analytics trends")
        except Exception:  # pragma: no cover
            logger.exception("Failed to persist trends")

    # --------------------------------------------------------------------- #
    # Prompt generation
    # --------------------------------------------------------------------- #

    async def generate_prompt(self) -> str:
        """
        Craft an artistic prompt based on the latest trends.

        Examples:
            "Feeling the ocean blues? Snap something turquoise around you!"
            "Mood is soaring high—share a bright yellow moment."
        """
        palette = self.most_common_palette()
        mood = self.average_mood()

        prompt = PromptFactory.create(palette=palette, mood=mood)
        return prompt


# --------------------------------------------------------------------------- #
# Prompt Factory
# --------------------------------------------------------------------------- #

class PromptFactory:
    """Factory for building user-facing creative prompts."""

    _color_adjectives = {
        "#FF0000": "fiery red",
        "#00FF00": "lively green",
        "#0000FF": "deep blue",
        "#FFFF00": "bright yellow",
        "#FF00FF": "vibrant magenta",
        "#00FFFF": "cool cyan",
    }

    _mood_templates: Dict[str, List[str]] = {
        "positive": [
            "Mood is soaring high—share a {} moment!",
            "Everyone's feeling upbeat. Capture something {}.",
        ],
        "neutral": [
            "Keep the creativity flowing – maybe add a hint of {} today.",
            "Steady vibes around. How about snapping something {}?",
        ],
        "negative": [
            "Need a pick-me-up? Seek out something {}.",
            "Let's brighten the day. Find a {} scene and share it!",
        ],
    }

    @classmethod
    def create(
        cls,
        *,
        palette: Optional[Palette],
        mood: Optional[float],
    ) -> str:
        """Return a prompt string tailored to the supplied context."""
        adjective = cls._pick_color_adjective(palette)
        mood_category = cls._categorize_mood(mood)
        template = choice(cls._mood_templates[mood_category])
        return template.format(adjective)

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    @classmethod
    def _pick_color_adjective(cls, palette: Optional[Palette]) -> str:
        if not palette:
            return "colorful"

        # Choose the most vibrant color within palette that we have an adjective for
        for color in palette:
            if color in cls._color_adjectives:
                return cls._color_adjectives[color]

        # Default fallback
        return "eye-catching"

    @staticmethod
    def _categorize_mood(mood: Optional[float]) -> str:
        if mood is None:
            return "neutral"
        if mood > 0.25:
            return "positive"
        if mood < -0.25:
            return "negative"
        return "neutral"


# --------------------------------------------------------------------------- #
# CLI entry-point for local testing
# --------------------------------------------------------------------------- #

def _bootstrap_demo() -> None:  # pragma: no cover
    """Run a tiny demo when launched as a script."""
    engine = RealTimeAnalyticsEngine()

    # Publish some random events
    now = datetime.utcnow()

    def _mk_card(idx: int) -> PrismCard:
        palettes: List[Palette] = [
            ("#FF0000", "#00FF00", "#0000FF"),
            ("#FFFF00", "#FF00FF", "#00FFFF"),
            ("#123456", "#654321", "#FEDCBA"),
        ]
        return PrismCard(
            id=f"card_{idx}",
            palette=choice(palettes),
            location=(randint(-90, 90) + randint(0, 99) / 100, randint(-180, 180) + randint(0, 99) / 100),
            mood_score=choice([-0.8, -0.2, 0.0, 0.3, 0.9]),
            created_at=now - timedelta(minutes=randint(0, 360)),
        )

    for i in range(50):
        ObserverBus.publish(CardCreatedEvent(card=_mk_card(i)))  # type: ignore[attr-defined]

    # Allow async tasks to process
    async def _print_prompt():
        await asyncio.sleep(0.1)
        prompt = await engine.generate_prompt()
        print(f"Generated prompt: {prompt}")

    engine._loop.run_until_complete(_print_prompt())


if __name__ == "__main__":  # pragma: no cover
    _bootstrap_demo()
```