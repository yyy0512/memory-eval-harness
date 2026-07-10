```python
"""
module_70.py
PrismPocket – Palette analytics, trend extraction, and suggestion engine.

This module is responsible for:
1. Receiving PrismCard color events from the Observer bus.
2. Persisting palette statistics in a repository.
3. Detecting significant color-usage trends (a “hot palette”).
4. Publishing TrendSignal objects back onto the Observer bus.
5. Generating creative suggestions based on detected trends.

Patterns utilised
-----------------
* Singleton           – `AnalyticsEngine` guarantees a single process-wide instance.
* Factory             – `SuggestionFactory` constructs suggestion payloads.
* Repository          – `PaletteMetricRepository` manages persistence of metrics.
* Observer (light)    – `EventBus` enables decoupled pub/sub.
* Clean Architecture  – Domain entities remain pure (`PrismCard`, `TrendSignal`).

This file is self-contained and can be imported without the rest of the app,
while still demonstrating realistic, production-quality code.

Author: PrismPocket Core Team
"""

from __future__ import annotations

import asyncio
import logging
import random
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from types import TracebackType
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Protocol,
    Set,
    Type,
    Union,
)

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

LOGGER = logging.getLogger("prism_pocket.analytics")
handler = logging.StreamHandler(stream=sys.stderr)
handler.setFormatter(
    logging.Formatter(
        fmt="%(asctime)s │ %(levelname)-8s │ %(name)s │ %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
)
LOGGER.addHandler(handler)
LOGGER.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Domain entities                                                             #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    A user-generated creative card consisting of multiple swatches.

    Attributes
    ----------
    card_id: Unique identifier for the card
    colors: List of hex color strings (e.g., '#FFEE00')
    captured_at: UTC timestamp of capture
    """

    card_id: str
    colors: List[str]
    captured_at: datetime


@dataclass(frozen=True, slots=True)
class TrendSignal:
    """
    Event describing a newly detected palette trend.

    Attributes
    ----------
    palette: Tuple of dominant colors that define the trend.
    trend_score: Normalised score [0,1].
    detected_at: UTC timestamp.
    """

    palette: tuple[str, ...]
    trend_score: float
    detected_at: datetime = field(default_factory=datetime.utcnow)


# --------------------------------------------------------------------------- #
# Observer / Event Bus                                                        #
# --------------------------------------------------------------------------- #


Listener = Callable[[Any], Awaitable[None]]


class EventBus:
    """
    A lightweight asynchronous pub/sub bus.

    Unlike third-party libraries, this implementation avoids extra
    dependencies and is suitable for the mobile runtime environment.
    """

    _instance: Optional["EventBus"] = None
    _lock = asyncio.Lock()

    def __init__(self) -> None:
        self._topics: MutableMapping[type, Set[Listener]] = defaultdict(set)

    # Singleton access
    @classmethod
    async def instance(cls) -> "EventBus":
        async with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    async def publish(self, event: Any) -> None:
        """
        Broadcast an event to every subscribed listener for its type hierarchy.

        Listeners are executed concurrently; failure of one does not affect
        others.
        """
        tasks: List[Coroutine[Any, Any, None]] = []
        for subscribed_type, listeners in self._topics.items():
            if isinstance(event, subscribed_type):
                tasks.extend(listener(event) for listener in listeners)

        if not tasks:
            LOGGER.debug("No listeners for event type %s", type(event).__name__)
            return

        LOGGER.debug("Publishing %s to %d listeners", type(event).__name__, len(tasks))
        await asyncio.gather(*tasks, return_exceptions=True)

    async def subscribe(self, event_type: type, listener: Listener) -> None:
        """
        Register a listener for a specific event type.
        """
        if not asyncio.iscoroutinefunction(listener):
            raise TypeError("Listener must be an async function")
        self._topics[event_type].add(listener)
        LOGGER.debug(
            "Listener %s subscribed to %s", listener.__qualname__, event_type.__name__
        )

    async def unsubscribe(self, event_type: type, listener: Listener) -> None:
        self._topics[event_type].discard(listener)
        LOGGER.debug(
            "Listener %s unsubscribed from %s", listener.__qualname__, event_type.__name__
        )


# --------------------------------------------------------------------------- #
# Repository                                                                  #
# --------------------------------------------------------------------------- #


class PaletteMetricRepository:
    """
    Persist palette usage counts and provide analytical queries.

    The default implementation is in-memory. In production builds this class
    can be swapped via DI for SQLite / CoreData / Room database backends.
    """

    def __init__(self) -> None:
        self._color_counter: Counter[str] = Counter()
        self._card_counter: int = 0
        self._latest_seen: Optional[datetime] = None
        self._lock = asyncio.Lock()

    async def record_card(self, card: PrismCard) -> None:
        """
        Ingest card colors into the repository.
        """
        async with self._lock:
            self._card_counter += 1
            self._color_counter.update(c.lower() for c in card.colors)
            self._latest_seen = card.captured_at
            LOGGER.debug(
                "Recorded card %s with %d colors. Total cards: %d",
                card.card_id,
                len(card.colors),
                self._card_counter,
            )

    async def top_palettes(self, top_n: int = 5) -> List[tuple[str, int]]:
        """
        Return the most common individual colors.
        """
        async with self._lock:
            return self._color_counter.most_common(top_n)

    async def total_cards(self) -> int:
        async with self._lock:
            return self._card_counter

    async def snapshot(self) -> Mapping[str, int]:
        async with self._lock:
            return dict(self._color_counter)


# --------------------------------------------------------------------------- #
# Suggestion Factory                                                          #
# --------------------------------------------------------------------------- #


class SuggestionFactory:
    """
    Build a friendly suggestion string based on TrendSignal.
    """

    @staticmethod
    def build(signal: TrendSignal) -> str:
        palette_preview = ", ".join(signal.palette)
        return (
            f"🎨 New hot palette detected! ({palette_preview})\n"
            f"Try remixing your next card with these colors. "
            f"Trend score: {signal.trend_score:.2f}"
        )


# --------------------------------------------------------------------------- #
# Analytics Engine (Singleton)                                                #
# --------------------------------------------------------------------------- #


class AnalyticsEngine:
    """
    High-level orchestration for receiving cards, updating metrics,
    detecting trends, and emitting events.

    Usage
    -----
        engine = await AnalyticsEngine.instance()
        await engine.start()  # Starts the background task.
    """

    _instance: Optional["AnalyticsEngine"] = None
    _lock = asyncio.Lock()

    TREND_WINDOW: timedelta = timedelta(hours=1)
    COLOR_THRESHOLD: int = 25  # min occurrences to qualify as trending
    SCORE_SMOOTHING: float = 0.2

    def __init__(
        self,
        *,
        repository: PaletteMetricRepository,
        bus: EventBus,
    ) -> None:
        self._repo = repository
        self._bus = bus
        self._bg_task: Optional[asyncio.Task[None]] = None
        self._running = asyncio.Event()
        self._trend_scores: Dict[tuple[str, ...], float] = {}

    # Singleton access
    @classmethod
    async def instance(cls) -> "AnalyticsEngine":
        async with cls._lock:
            if cls._instance is None:
                repo = PaletteMetricRepository()
                bus = await EventBus.instance()
                cls._instance = cls(repository=repo, bus=bus)
        return cls._instance

    # Public API ----------------------------------------------------------------

    async def start(self) -> None:
        """
        Subscribes to card events and kicks off analytics loop.

        Idempotent – safe to call multiple times.
        """
        if self._running.is_set():
            LOGGER.debug("AnalyticsEngine is already running.")
            return

        await self._bus.subscribe(PrismCard, self._on_card)
        self._running.set()
        self._bg_task = asyncio.create_task(self._trend_worker(), name="trend-worker")
        LOGGER.info("AnalyticsEngine started.")

    async def stop(self) -> None:
        """
        Gracefully stop analytics processing and background tasks.
        """
        if not self._running.is_set():
            return
        self._running.clear()
        await self._bus.unsubscribe(PrismCard, self._on_card)
        if self._bg_task:
            self._bg_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._bg_task
        LOGGER.info("AnalyticsEngine stopped.")

    # Internal callbacks --------------------------------------------------------

    async def _on_card(self, card: PrismCard) -> None:
        """
        Callback executed for every new PrismCard event.
        """
        try:
            await self._repo.record_card(card)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            LOGGER.exception("Failed to record card %s: %s", card.card_id, exc)

    async def _trend_worker(self) -> None:
        """
        Periodically checks repository for trends.
        """
        try:
            while self._running.is_set():
                await self._detect_trends()
                await asyncio.sleep(15)  # run every 15 seconds
        except asyncio.CancelledError:
            LOGGER.debug("Trend worker cancelled – shutting down.")

    async def _detect_trends(self) -> None:
        """
        Compute trend scores based on current repository state.
        """
        snapshot = await self._repo.snapshot()
        if not snapshot:
            return

        # Step 1: Determine most frequent colors
        top_colors = Counter(snapshot).most_common(5)
        palette, counts = zip(*top_colors)  # type: ignore[misc]
        total_occurrences = sum(counts)
        LOGGER.debug("Top colors: %s (total occurrences: %d)", palette, total_occurrences)

        # Step 2: Basic threshold check
        if total_occurrences < self.COLOR_THRESHOLD:
            LOGGER.debug("Occurrence threshold not met (%d required).", self.COLOR_THRESHOLD)
            return

        # Step 3: Trend score calculation with smoothing
        trending_palette = tuple(palette)
        raw_score = min(total_occurrences / (self.COLOR_THRESHOLD * 2), 1.0)
        prev_score = self._trend_scores.get(trending_palette, raw_score)
        smoothed_score = (self.SCORE_SMOOTHING * raw_score) + (
            (1 - self.SCORE_SMOOTHING) * prev_score
        )
        self._trend_scores[trending_palette] = smoothed_score

        LOGGER.debug(
            "Trend score for %s – raw: %.2f, prev: %.2f, smooth: %.2f",
            trending_palette,
            raw_score,
            prev_score,
            smoothed_score,
        )

        # Step 4: Emit event if score rises above threshold or new palette
        if smoothed_score >= 0.7 and (
            smoothed_score - prev_score >= 0.1 or prev_score < 0.7
        ):
            signal = TrendSignal(
                palette=trending_palette, trend_score=round(smoothed_score, 3)
            )
            LOGGER.info("Trend detected! %s", signal)
            await self._bus.publish(signal)


# --------------------------------------------------------------------------- #
# Example integration (for manual testing)                                    #
# --------------------------------------------------------------------------- #

# The following code block is only executed when running this module directly.
# In production, the engine would be imported and managed by the application
# bootstrapper. This section illustrates a minimal in-process event loop
# demonstration and can be removed without impacting core functionality.

if __name__ == "__main__":
    import contextlib
    import uuid

    async def demo() -> None:
        bus = await EventBus.instance()
        engine = await AnalyticsEngine.instance()

        # Subscribe to TrendSignals to print suggestions
        async def on_trend(signal: TrendSignal) -> None:
            suggestion = SuggestionFactory.build(signal)
            LOGGER.warning("SUGGESTION ─▶\n%s", suggestion)

        await bus.subscribe(TrendSignal, on_trend)

        # Start the engine
        await engine.start()

        colors_pool = [
            "#FF5733",
            "#33C1FF",
            "#FFBD33",
            "#8D33FF",
            "#33FF57",
            "#FF33A6",
        ]

        async def push_random_cards() -> None:
            for _ in range(120):
                # Simulate a bursty traffic pattern
                await asyncio.sleep(random.uniform(0.05, 0.25))
                card = PrismCard(
                    card_id=str(uuid.uuid4()),
                    colors=random.choices(colors_pool, k=random.randint(1, 4)),
                    captured_at=datetime.utcnow(),
                )
                await bus.publish(card)

        await push_random_cards()
        await asyncio.sleep(30)  # Allow background detection to run
        await engine.stop()

    try:
        asyncio.run(demo())
    except KeyboardInterrupt:
        pass
```