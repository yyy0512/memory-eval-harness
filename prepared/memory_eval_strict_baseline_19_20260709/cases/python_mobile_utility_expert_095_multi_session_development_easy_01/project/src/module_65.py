```python
"""
PrismPocket – Analytics Engine
──────────────────────────────
src/module_65.py

This module houses a self-contained, production-quality analytics engine that
consumes a live stream of PrismCards and surfaces creative trends such as
    • most-used color palettes
    • hotspot geolocations
    • aggregated mood scores

The implementation purposefully sticks to the Clean Architecture philosophy by
keeping the domain entities pure and communicating through protocol-based
boundaries (Repository, Observer, Factory).  The engine is fully asynchronous
so it can run inside a Trio/AnyIO event-loop or a native asyncio loop used by
our mobile runtime.

Author : PrismPocket Core Team
License: MIT
"""
from __future__ import annotations

import asyncio
import logging
import random
import statistics
import sys
import time
from abc import ABC, abstractmethod
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from itertools import islice
from typing import (
    AsyncIterator,
    Deque,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Tuple,
    Union,
)

# --------------------------------------------------------------------------- #
#                           Logger configuration                              #
# --------------------------------------------------------------------------- #
logger = logging.getLogger("prism.analytics")
handler = logging.StreamHandler(stream=sys.stdout)
formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
#                              Domain entities                                #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Color:
    """Simple RGBA hex representation. Immutable by design."""

    value: str  # e.g. "#FF8800"

    def __post_init__(self) -> None:
        if not self.value.startswith("#") or len(self.value) not in {7, 9}:
            raise ValueError(f"Invalid hex color: {self.value}")


@dataclass(frozen=True)
class GeoPoint:
    latitude: float
    longitude: float

    def grid_cell(self, precision: int = 3) -> Tuple[int, int]:
        """
        Returns a discrete grid cell identifier used for hotspot analysis.
        precision=3 corresponds roughly to ~110m sq. granularity.
        """
        lat_cell = int(self.latitude * (10**precision))
        lon_cell = int(self.longitude * (10**precision))
        return lat_cell, lon_cell


@dataclass(frozen=True)
class PrismCard:
    card_id: str
    user_id: str
    captured_at: datetime
    colors: Tuple[Color, ...]
    location: Optional[GeoPoint]
    mood_score: Optional[float]  # -1.0 (sad) … +1.0 (happy)

    def age_seconds(self) -> float:
        return (datetime.now(timezone.utc) - self.captured_at).total_seconds()


# --------------------------------------------------------------------------- #
#                           Analytics value objects                           #
# --------------------------------------------------------------------------- #
@dataclass
class PaletteMetric:
    palette: Tuple[str, ...]
    count: int


@dataclass
class HotspotMetric:
    grid_cell: Tuple[int, int]
    density: int


@dataclass
class MoodMetric:
    mean_mood: float
    sample_size: int


@dataclass
class AnalyticsSnapshot:
    """
    Immutable bag of analytics calculated at a fixed point in time.
    """

    generated_at: datetime
    top_palettes: List[PaletteMetric] = field(default_factory=list)
    hotspots: List[HotspotMetric] = field(default_factory=list)
    mood: Optional[MoodMetric] = None


# --------------------------------------------------------------------------- #
#                              Repo & Observer                                #
# --------------------------------------------------------------------------- #
class PrismCardRepository(Protocol):
    """
    Repository abstraction for PrismCard persistence/streaming.
    Implementations can back onto SQLite, Cloud Firestore, REST, etc.
    """

    async def save(self, card: PrismCard) -> None: ...

    async def stream(self) -> AsyncIterator[PrismCard]:
        """
        Yields PrismCards in chronological order.  Implementations SHOULD ensure
        that duplicate cards are not emitted.
        """
        ...


class AnalyticsObserver(Protocol):
    async def update(self, snapshot: AnalyticsSnapshot) -> None: ...


# -------------------------------- Repository -------------------------------- #
class InMemoryPrismCardRepository:
    """
    Reference in-memory repo.
    NOT for production but handy for unit-tests / local prototyping.
    """

    def __init__(self) -> None:
        self._cards: Deque[PrismCard] = deque()
        self._new_card_event = asyncio.Event()

    async def save(self, card: PrismCard) -> None:
        logger.debug("Saving card %s", card.card_id)
        self._cards.append(card)
        self._new_card_event.set()

    async def stream(self) -> AsyncIterator[PrismCard]:
        """
        Infinite async generator that waits for new data.
        """
        read_cursor = 0
        while True:
            while read_cursor < len(self._cards):
                yield self._cards[read_cursor]
                read_cursor += 1
            # Wait until new cards appear
            self._new_card_event.clear()
            await self._new_card_event.wait()


# --------------------------------------------------------------------------- #
#                            Business logic / Engine                          #
# --------------------------------------------------------------------------- #
class SlidingWindowCounter:
    """
    Time-decaying counter for trend analytics.
    Keeps events in a deque along with their timestamp and discards those that
    fall outside the defined window.
    """

    def __init__(self, window: timedelta) -> None:
        self._window: timedelta = window
        self._events: Deque[Tuple[Union[str, Tuple[int, int]], float]] = deque()

    def add(self, key: Union[str, Tuple[int, int]]) -> None:
        now_ts = time.time()
        self._events.append((key, now_ts))
        self._purge(now_ts)

    def most_common(self, n: int) -> List[Tuple[Union[str, Tuple[int, int]], int]]:
        self._purge(time.time())
        counter = Counter(key for key, _ in self._events)
        return counter.most_common(n)

    def average(self) -> Optional[float]:
        self._purge(time.time())
        if not self._events:
            return None
        # interpret key as a float when possible
        values = [float(key) for key, _ in self._events if isinstance(key, (float, int))]
        return statistics.mean(values) if values else None

    def _purge(self, now_ts: float) -> None:
        cutoff = now_ts - self._window.total_seconds()
        while self._events and self._events[0][1] < cutoff:
            self._events.popleft()


class _AnalyticsEngineSingleton(type):
    """
    Metaclass to enforce singleton semantics at runtime.
    """

    _instances: Dict[type, "AnalyticsEngine"] = {}

    def __call__(cls, *args, **kwargs):  # type: ignore
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class AnalyticsEngine(metaclass=_AnalyticsEngineSingleton):
    """
    Consumes PrismCards from a repository and periodically emits analytics
    snapshots to registered observers.
    """

    SNAPSHOT_INTERVAL = timedelta(seconds=15)
    WINDOW = timedelta(minutes=30)
    TOP_N = 5

    def __init__(self, repository: PrismCardRepository) -> None:
        # sliding windows
        self._palette_counter = SlidingWindowCounter(self.WINDOW)
        self._hotspot_counter = SlidingWindowCounter(self.WINDOW)
        self._mood_counter = SlidingWindowCounter(self.WINDOW)

        # admin
        self._repository = repository
        self._observers: List[AnalyticsObserver] = []
        self._lock = asyncio.Lock()
        self._running = False

    # ------------------------------ Observer API ---------------------------- #
    async def register(self, observer: AnalyticsObserver) -> None:
        async with self._lock:
            if observer not in self._observers:
                logger.debug("Registering observer %s", observer)
                self._observers.append(observer)

    async def unregister(self, observer: AnalyticsObserver) -> None:
        async with self._lock:
            if observer in self._observers:
                logger.debug("Unregistering observer %s", observer)
                self._observers.remove(observer)

    async def _notify(self, snapshot: AnalyticsSnapshot) -> None:
        async with self._lock:
            tasks = [
                asyncio.create_task(obs.update(snapshot), name=f"notify:{obs}")
                for obs in self._observers
            ]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    # ----------------------------- Processing loop ------------------------- #
    async def run_forever(self) -> None:
        if self._running:
            raise RuntimeError("AnalyticsEngine is already running")
        self._running = True
        logger.info("Analytics engine started")

        last_snapshot_ts: float = 0
        try:
            async for card in self._repository.stream():
                self._ingest_card(card)
                now_ts = time.time()
                if now_ts - last_snapshot_ts >= self.SNAPSHOT_INTERVAL.total_seconds():
                    snapshot = self._build_snapshot()
                    # fire and forget, we don't want to block ingestion
                    asyncio.create_task(self._notify(snapshot))
                    last_snapshot_ts = now_ts
        except asyncio.CancelledError:
            logger.warning("Analytics engine cancelled – shutting down")
            raise
        finally:
            self._running = False

    # ------------------------------ Internal -------------------------------- #
    def _ingest_card(self, card: PrismCard) -> None:
        logger.debug("Ingesting card %s", card.card_id)

        # Track palettes (we store up to first 4 colors as key)
        palette_key = tuple(c.value for c in islice(card.colors, 4))
        self._palette_counter.add(palette_key)

        # Track geolocation hotspot
        if card.location:
            cell = card.location.grid_cell()
            self._hotspot_counter.add(cell)

        # Track mood
        if card.mood_score is not None:
            self._mood_counter.add(card.mood_score)

    def _build_snapshot(self) -> AnalyticsSnapshot:
        logger.debug("Building analytics snapshot")
        top_palettes_raw = self._palette_counter.most_common(self.TOP_N)
        palette_metrics = [
            PaletteMetric(palette=k, count=v) for k, v in top_palettes_raw
        ]

        hotspots_raw = self._hotspot_counter.most_common(self.TOP_N)
        hotspot_metrics = [HotspotMetric(grid_cell=k, density=v) for k, v in hotspots_raw]

        mean_mood = self._mood_counter.average()
        mood_metric = (
            MoodMetric(mean_mood, sample_size=len(self._mood_counter._events))
            if mean_mood is not None
            else None
        )

        snapshot = AnalyticsSnapshot(
            generated_at=datetime.now(timezone.utc),
            top_palettes=palette_metrics,
            hotspots=hotspot_metrics,
            mood=mood_metric,
        )
        logger.info("New analytics snapshot: %s", snapshot)
        return snapshot


# --------------------------------------------------------------------------- #
#                       Factory & Convenience helpers                         #
# --------------------------------------------------------------------------- #
class AnalyticsEngineFactory:
    """
    Producer for AnalyticsEngine instances.  Ensures we don't accidentally
    violate the singleton contract when wiring with DI containers.
    """

    @classmethod
    def create_default(cls) -> AnalyticsEngine:
        repo = InMemoryPrismCardRepository()
        return AnalyticsEngine(repository=repo)

    @classmethod
    def create_with_repo(cls, repository: PrismCardRepository) -> AnalyticsEngine:
        return AnalyticsEngine(repository=repository)


# --------------------------------------------------------------------------- #
#                            Example CLI harness                              #
# --------------------------------------------------------------------------- #
# The snippet below is *not* used by the mobile app but provides a quick way
# to observe analytics behaviour when the module is executed directly.
# Run `python -m src.module_65` to watch the logs.
# --------------------------------------------------------------------------- #
class _StdoutObserver(AnalyticsObserver):
    async def update(self, snapshot: AnalyticsSnapshot) -> None:
        print(f"\n=== SNAPSHOT @ {snapshot.generated_at.isoformat()} ===")
        print(
            f"Top palettes: {[mp.palette for mp in snapshot.top_palettes]} "
            f"(counts: {[mp.count for mp in snapshot.top_palettes]})"
        )
        print(
            f"Hotspots: {[hm.grid_cell for hm in snapshot.hotspots]} "
            f"(density: {[hm.density for hm in snapshot.hotspots]})"
        )
        if snapshot.mood:
            print(
                f"Mood avg: {snapshot.mood.mean_mood:.3f} "
                f"(n={snapshot.mood.sample_size})"
            )
        print("============================================\n")


async def _emit_random_cards(repo: InMemoryPrismCardRepository) -> None:
    """
    Background task that pumps pseudo-random PrismCards into the repository.
    Emulates camera captures from various geolocations & vibes.
    """
    colors_pool = ["#FF8800", "#33AAFF", "#55FF55", "#FF55FF", "#FFFF00", "#000000"]
    moods = [-0.5, -0.1, 0.0, 0.4, 0.8]
    lat_base, lon_base = 37.7749, -122.4194  # San-Francisco

    while True:
        card = PrismCard(
            card_id=f"demo_{int(time.time() * 1000)}",
            user_id="demo_user",
            captured_at=datetime.now(timezone.utc),
            colors=tuple(Color(random.choice(colors_pool)) for _ in range(4)),
            location=GeoPoint(
                latitude=lat_base + random.uniform(-0.01, 0.01),
                longitude=lon_base + random.uniform(-0.01, 0.01),
            ),
            mood_score=random.choice(moods),
        )
        await repo.save(card)
        await asyncio.sleep(random.uniform(0.3, 1.2))


async def _demo_main() -> None:
    repo = InMemoryPrismCardRepository()
    engine = AnalyticsEngineFactory.create_with_repo(repo)
    observer = _StdoutObserver()
    await engine.register(observer)

    producer = asyncio.create_task(_emit_random_cards(repo), name="producer")
    consumer = asyncio.create_task(engine.run_forever(), name="consumer")

    await asyncio.sleep(60)  # Run for 1 minute
    producer.cancel()
    consumer.cancel()
    await asyncio.gather(producer, consumer, return_exceptions=True)


if __name__ == "__main__":  # pragma: no cover
    try:
        asyncio.run(_demo_main())
    except KeyboardInterrupt:
        pass
```