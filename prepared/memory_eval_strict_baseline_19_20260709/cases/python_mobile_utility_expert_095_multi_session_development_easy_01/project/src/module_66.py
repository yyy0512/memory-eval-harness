```python
"""
module_66.py
============

Palette analytics & trend-surfacing pipeline for PrismPocket.

This module implements a small, in-process analytics engine that watches
`PrismCard` creation / mutation events and emits aggregate palette metrics
(e.g. trending colours, palette usage frequency, mood score) every N seconds.

The code showcases:
    • Observer pattern (EventBus singleton) for low-latency in-app streaming
    • Asynchronous background processing so heavy computation never blocks UI
    • Clean-architecture friendly abstractions (repository & ports)
    • Production-grade logging, typing, and defensive error handling
"""

from __future__ import annotations

import asyncio
import logging
import random
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import (
    Any,
    Callable,
    Coroutine,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Sequence,
    Tuple,
)

# --------------------------------------------------------------------------- #
# Typing helpers
# --------------------------------------------------------------------------- #

RGB = Tuple[int, int, int]  # e.g. (255, 0, 102)

Palette = Sequence[RGB]
MetricPayload = Dict[str, Any]

# --------------------------------------------------------------------------- #
# Domain-layer minimal stubs (would normally live elsewhere)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCard:
    """Snapshot of a creative unit in PrismPocket."""

    guid: str
    created_at: datetime
    dominant_palette: Palette  # resolved server-side or by ColourAnalyzer
    mood_score: float  # −1.0 (sad/dark) … 1.0 (happy/bright)


class PrismCardRepositoryPort(Protocol):
    """
    Clean-architecture port that retrieves PrismCards.

    This interface is fulfilled by data sources such as LocalDBRepository or
    RemoteSyncRepository.  We depend on abstraction, not implementation.
    """

    async def fetch_between(
        self, start: datetime, end: datetime
    ) -> List[PrismCard]: ...


# --------------------------------------------------------------------------- #
# Observer / EventBus
# --------------------------------------------------------------------------- #


class EventBus:
    """
    Simple singleton event bus.

    Subscribers register callbacks for specific topics and receive messages
    in the order they were published.  All handlers are awaited; slow handlers
    should off-load heavy work to executor pools.
    """

    _instance: Optional["EventBus"] = None

    def __init__(self) -> None:
        if self.__class__._instance is not None:
            raise RuntimeError("EventBus is a singleton – use EventBus.current()")
        self._subscribers: MutableMapping[str, List[Callable[[Any], Coroutine]]] = defaultdict(list)
        self._logger = logging.getLogger(self.__class__.__name__)

    @classmethod
    def current(cls) -> "EventBus":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def subscribe(self, topic: str, handler: Callable[[Any], Coroutine]) -> None:
        """Register an async handler for a topic."""
        if not asyncio.iscoroutinefunction(handler):
            raise ValueError("Handler must be coroutine function")
        self._logger.debug("Subscribing handler %s to topic %s", handler, topic)
        self._subscribers[topic].append(handler)

    async def publish(self, topic: str, payload: Any) -> None:
        """Publish a message and await all handlers."""
        handlers = self._subscribers.get(topic, [])
        if not handlers:
            self._logger.debug("No subscribers for topic %s", topic)
            return

        self._logger.debug("Publishing to %d handler(s) on topic %s", len(handlers), topic)
        for handler in handlers:
            try:
                await handler(payload)
            except Exception as exc:  # noqa: BLE001
                self._logger.exception("Handler %s failed on topic %s: %s", handler, topic, exc)


# --------------------------------------------------------------------------- #
# Analytics Engine
# --------------------------------------------------------------------------- #


class PaletteTrendAnalyzer:
    """
    Continuously computes palette trends from PrismCards.

    The analyzer slides a time-window across recent cards to surface the
    most popular colours, average mood, and palette diversity index.  It
    publishes a dict payload on EventBus topic ``analytics.palette.update``.
    """

    # Window settings (could be user-configurable)
    WINDOW: timedelta = timedelta(hours=6)
    SAMPLE_INTERVAL: float = 60.0  # seconds

    TOPIC_METRIC_OUT = "analytics.palette.update"

    def __init__(self, repo: PrismCardRepositoryPort, bus: EventBus | None = None) -> None:
        self._repo = repo
        self._bus = bus or EventBus.current()
        self._logger = logging.getLogger(self.__class__.__name__)
        self._task: Optional[asyncio.Task[None]] = None

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """Launch background task (idempotent)."""
        if self._task and not self._task.done():
            return
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._run(), name="PaletteTrendAnalyzerTask")
        self._logger.info("PaletteTrendAnalyzer started")

    def stop(self) -> None:
        """Cancel background task."""
        if self._task:
            self._task.cancel()
            self._logger.info("PaletteTrendAnalyzer stopped")

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    async def _run(self) -> None:
        """Periodic sampling coroutine."""
        while True:
            try:
                await self._compute_and_publish()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._logger.exception("Uncaught error during analytics loop: %s", exc)
            await asyncio.sleep(self.SAMPLE_INTERVAL)

    async def _compute_and_publish(self) -> None:
        """Pull recent cards and compute analytics."""
        now = datetime.utcnow()
        window_start = now - self.WINDOW

        self._logger.debug("Fetching cards between %s and %s", window_start, now)
        cards = await self._repo.fetch_between(window_start, now)

        if not cards:
            self._logger.debug("No cards in analytics window – skipping publish")
            return

        metric = self._build_metric(cards)
        self._logger.debug("Publishing palette metric: %s", metric)
        await self._bus.publish(self.TOPIC_METRIC_OUT, metric)

    # ------------------------------------------------------------------ #
    # Pure functions
    # ------------------------------------------------------------------ #

    @staticmethod
    def _build_metric(cards: Iterable[PrismCard]) -> MetricPayload:
        """Aggregate palette/mood statistics."""
        palette_counter: Counter[RGB] = Counter()
        mood_scores: List[float] = []

        # Flatten colours for histogram
        for card in cards:
            palette_counter.update(card.dominant_palette)
            mood_scores.append(card.mood_score)

        total_colours = sum(palette_counter.values())

        # Guard against zero division
        if total_colours == 0:
            raise ValueError("PaletteCounter is empty – at least one colour expected")

        top_n = 6
        top_colours = palette_counter.most_common(top_n)

        diversity_index = PaletteTrendAnalyzer._shannon_entropy(palette_counter)

        return {
            "timestamp": datetime.utcnow().isoformat(),
            "total_cards": len(list(cards)),
            "top_colours": [
                {
                    "rgb": colour,
                    "frequency": freq,
                    "percentage": round(freq / total_colours, 3),
                    "hex": PaletteTrendAnalyzer._rgb_to_hex(colour),
                }
                for colour, freq in top_colours
            ],
            "average_mood": round(statistics.fmean(mood_scores), 3),
            "diversity": round(diversity_index, 3),
        }

    @staticmethod
    def _rgb_to_hex(rgb: RGB) -> str:
        """Convert (r, g, b) → #RRGGBB."""
        return "#{:02X}{:02X}{:02X}".format(*rgb)

    @staticmethod
    def _shannon_entropy(counter: Counter[RGB]) -> float:
        """Compute Shannon entropy of colour distribution (0 = no diversity)."""
        import math

        total = sum(counter.values())
        probs = (freq / total for freq in counter.values())
        return -sum(p * math.log2(p) for p in probs if p > 0)


# --------------------------------------------------------------------------- #
# Fallback in-memory repository (DEV / unit-test only)
# --------------------------------------------------------------------------- #


class InMemoryPrismCardRepository(PrismCardRepositoryPort):
    """A simple repository seeded with randomly generated cards."""

    def __init__(self, seed: int | None = None) -> None:
        self._rng = random.Random(seed)
        self._cards: List[PrismCard] = []
        self._logger = logging.getLogger(self.__class__.__name__)

        # Pre-seed with 200 random cards within the last 24h
        now = datetime.utcnow()
        for _ in range(200):
            delta = timedelta(seconds=self._rng.randint(0, 86_400))
            self._cards.append(self._make_random_card(now - delta))

    async def fetch_between(self, start: datetime, end: datetime) -> List[PrismCard]:
        await asyncio.sleep(0)  # simulate async boundary
        return [c for c in self._cards if start <= c.created_at <= end]

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def _make_random_card(self, created_at: datetime) -> PrismCard:
        """Generate a pseudo-random card for demo purposes."""
        palette = [self._rand_colour() for _ in range(self._rng.randint(2, 5))]
        mood = self._rng.uniform(-1, 1)
        guid = f"card_{self._rng.getrandbits(48):012x}"
        return PrismCard(guid=guid, created_at=created_at, dominant_palette=palette, mood_score=mood)

    def _rand_colour(self) -> RGB:
        return tuple(self._rng.randint(0, 255) for _ in range(3))  # type: ignore[return-value]


# --------------------------------------------------------------------------- #
# Demo Harness (only executed when module is run stand-alone)
# --------------------------------------------------------------------------- #

async def _demo() -> None:
    """
    Mini demo that spins up the analyzer and prints metric updates for 2 minutes.

    Intended for local testing:
        python -m src.module_66
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-8s | %(name)s: %(message)s",
    )

    repo = InMemoryPrismCardRepository(seed=42)
    bus = EventBus.current()
    analyzer = PaletteTrendAnalyzer(repo, bus)
    analyzer.start()

    async def printer(payload: MetricPayload) -> None:
        logging.info("🔥 Palette Metric: %s", payload)

    bus.subscribe(PaletteTrendAnalyzer.TOPIC_METRIC_OUT, printer)

    await asyncio.sleep(120)
    analyzer.stop()


if __name__ == "__main__":
    try:
        asyncio.run(_demo())
    except KeyboardInterrupt:
        print("Exiting demo.")
```