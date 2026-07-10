```python
"""
PrismPocket – Color Palette & Hot-Spot Analytics
================================================

This module hosts the “real-time analytics engine” that turns a fire-hose of
`PrismCard` mutations into digestible, actionable metrics such as:

* Top-N dominant color palettes (rolling time-window)
* Geo hot-spots (heatmap buckets)
* Mood score trending (exponential moving average)

Implementation Notes
--------------------
* Clean-Architecture ring: **Domain → Services / Interactors**
* Design patterns: Observer (event-bus), Singleton, Repository, Factory
* Concurrency: asyncio background consumer
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from threading import RLock
from types import TracebackType
from typing import (
    Any,
    AsyncIterator,
    Dict,
    Iterable,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Tuple,
    Type,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


# --------------------------------------------------------------------------- #
#                               Domain Objects                                #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class GeoPoint:
    """Light-weight geo coordinate."""
    lat: float
    lon: float


@dataclass(frozen=True)
class PrismCardSnapshot:
    """
    Snapshot of a PrismCard at mutation time.

    Only analytics-relevant fields are kept to avoid tight coupling with the
    full domain model.
    """
    card_id: str
    user_id: str
    created_at: datetime
    dominant_hex_colors: Tuple[str, ...]  # e.g. ("#FFDC00", "#FF4136")
    geo_point: Optional[GeoPoint] = None
    mood_score: Optional[float] = None  # ‑1 … 1


# --------------------------------------------------------------------------- #
#                               Event Bus (Pub/Sub)                           #
# --------------------------------------------------------------------------- #

class _EventChannel:
    """A single async queue with fan-out semantics."""
    __slots__ = ("_queue", "_subscribers", "_lock")

    def __init__(self) -> None:
        self._queue: "asyncio.Queue[PrismCardSnapshot]" = asyncio.Queue()
        self._subscribers: List[asyncio.Queue[PrismCardSnapshot]] = []
        self._lock = RLock()

    def publish(self, snapshot: PrismCardSnapshot) -> None:
        """Publish a snapshot to all subscribers."""
        with self._lock:
            logger.debug("Publishing snapshot %s", snapshot.card_id)
            self._queue.put_nowait(snapshot)

    async def subscribe(self) -> AsyncIterator["asyncio.Queue[PrismCardSnapshot]"]:
        """
        Async context manager returning a personal queue that will receive a
        *copy* of every future event until exit.
        """
        personal_queue: "asyncio.Queue[PrismCardSnapshot]" = asyncio.Queue()
        with self._lock:
            self._subscribers.append(personal_queue)

        try:
            yield personal_queue
        finally:
            with contextlib.suppress(ValueError):
                with self._lock:
                    self._subscribers.remove(personal_queue)

    async def _fan_out(self) -> None:
        """Background task: takes from hub queue and distributes to subs."""
        while True:
            snapshot = await self._queue.get()
            with self._lock:
                subs = list(self._subscribers)  # shallow copy
            for q in subs:
                # Do not block – drop event if queue is full (back-pressure).
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(snapshot)
            self._queue.task_done()


class EventBus(metaclass=type):
    """
    Singleton asynchronous event-bus for PrismCardSnapshot mutations.
    """
    _channel: Optional[_EventChannel] = None
    _task: Optional[asyncio.Task[None]] = None
    _lock = RLock()

    @classmethod
    def channel(cls) -> _EventChannel:
        with cls._lock:
            if cls._channel is None:
                cls._channel = _EventChannel()
                cls._task = asyncio.create_task(cls._channel._fan_out())
            return cls._channel

    @classmethod
    def publish(cls, snapshot: PrismCardSnapshot) -> None:
        cls.channel().publish(snapshot)

    @classmethod
    async def subscribe(cls) -> AsyncIterator["asyncio.Queue[PrismCardSnapshot]"]:
        async for q in cls.channel().subscribe():
            yield q


# --------------------------------------------------------------------------- #
#                      Rolling Window & Analytics Utilities                   #
# --------------------------------------------------------------------------- #

@dataclass
class _TimedValue:
    timestamp: float
    data: Any


class _RollingWindow:
    """
    Generic time-based rolling window retaining data points inside
    `[now - window_size, now]`.
    """
    def __init__(self, window_size: timedelta) -> None:
        self._window_size = window_size
        self._values: List[_TimedValue] = []
        self._lock = RLock()

    def append(self, value: Any) -> None:
        with self._lock:
            now = time.time()
            self._values.append(_TimedValue(now, value))
            self._expire(now)

    def items(self) -> List[Any]:
        with self._lock:
            now = time.time()
            self._expire(now)
            return [tv.data for tv in self._values]

    def _expire(self, now: float) -> None:
        cutoff = now - self._window_size.total_seconds()
        while self._values and self._values[0].timestamp < cutoff:
            self._values.pop(0)


# --------------------------------------------------------------------------- #
#                       Analytics Repository / DTOs                           #
# --------------------------------------------------------------------------- #

ColorPalette = Tuple[str, ...]  # alias for readability

@dataclass
class AnalyticsSnapshot:
    top_palettes: List[Tuple[ColorPalette, int]]
    geo_heatmap: Dict[Tuple[int, int], int]
    mood_average: Optional[float]
    generated_at: datetime = field(default_factory=datetime.utcnow)


class AnalyticsRepository:
    """
    Thread-safe in-memory analytics repository with subscription hooks.

    Could be swapped for a persistent store via Adapter pattern.
    """
    def __init__(self) -> None:
        self._snapshot: Optional[AnalyticsSnapshot] = None
        self._lock = RLock()
        self._subscribers: List[asyncio.Queue[AnalyticsSnapshot]] = []

    def publish(self, snapshot: AnalyticsSnapshot) -> None:
        with self._lock:
            self._snapshot = snapshot
            logger.debug("Analytics snapshot published at %s", snapshot.generated_at)
            subscribers = list(self._subscribers)
        for q in subscribers:
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(snapshot)

    def latest(self) -> Optional[AnalyticsSnapshot]:
        with self._lock:
            return self._snapshot

    async def stream(self) -> AsyncIterator[AnalyticsSnapshot]:
        """
        Subscribe to a live stream of analytics snapshots.
        """
        q: "asyncio.Queue[AnalyticsSnapshot]" = asyncio.Queue(maxsize=5)
        with self._lock:
            self._subscribers.append(q)

        try:
            while True:
                yield await q.get()
        finally:
            with contextlib.suppress(ValueError):
                with self._lock:
                    self._subscribers.remove(q)


# --------------------------------------------------------------------------- #
#                         Analytics Aggregator Service                        #
# --------------------------------------------------------------------------- #

class AnalyticsAggregator:
    """
    Consumes PrismCardSnapshot events and periodically emits
    AnalyticsSnapshot objects to sub-systems (e.g. UI layer, push prompts).
    """

    GEO_BUCKET_SIZE_DEG = 0.25  # ~28km bucket

    def __init__(
        self,
        window: timedelta = timedelta(hours=6),
        top_n: int = 8,
        repository: Optional[AnalyticsRepository] = None,
    ) -> None:
        self._window = _RollingWindow(window_size=window)
        self._top_n = top_n
        self._repo = repository or AnalyticsRepository()
        self._running: Optional[asyncio.Task[None]] = None
        self._lock = RLock()

    # - - - Public API - - -

    def start(self) -> None:
        """Spin up background consumer (idempotent)."""
        with self._lock:
            if self._running is None or self._running.done():
                self._running = asyncio.create_task(self._run())

    def stop(self) -> None:
        """Request graceful shutdown (fire-and-forget)."""
        with self._lock:
            if self._running and not self._running.done():
                self._running.cancel()

    async def wait_closed(self) -> None:
        """Await termination (useful in unit tests)."""
        with contextlib.suppress(asyncio.CancelledError):
            if self._running:
                await self._running

    # - - - Core Logic - - -

    async def _run(self) -> None:
        """
        Main loop: listen to event-bus, update rolling window, and emit
        snapshots on an interval.
        """
        snapshot_task = asyncio.create_task(self._emit_loop())
        async for queue in EventBus.subscribe():
            async for card in self._drain_queue(queue):
                self._window.append(card)
        # Should never exit; if subscription stops, cancel emit loop
        snapshot_task.cancel()

    async def _emit_loop(self) -> None:
        """Emit analytics snapshots every `interval` seconds."""
        INTERVAL = 30  # seconds
        while True:
            await asyncio.sleep(INTERVAL)
            analytics = self._compute_snapshot()
            self._repo.publish(analytics)

    async def _drain_queue(
        self, q: "asyncio.Queue[PrismCardSnapshot]"
    ) -> AsyncIterator[PrismCardSnapshot]:
        """Helper that yields events from personal queue forever."""
        while True:
            yield await q.get()

    # - - - Data Crunching - - -

    def _compute_snapshot(self) -> AnalyticsSnapshot:
        cards: List[PrismCardSnapshot] = self._window.items()

        # Top palettes
        palette_counter: Counter[ColorPalette] = Counter(
            tuple(card.dominant_hex_colors) for card in cards if card.dominant_hex_colors
        )
        top_palettes = palette_counter.most_common(self._top_n)

        # Geo heatmap buckets
        heat_buckets: MutableMapping[Tuple[int, int], int] = defaultdict(int)
        for card in cards:
            gp = card.geo_point
            if not gp:
                continue
            lat_bucket = int(gp.lat / self.GEO_BUCKET_SIZE_DEG)
            lon_bucket = int(gp.lon / self.GEO_BUCKET_SIZE_DEG)
            heat_buckets[(lat_bucket, lon_bucket)] += 1

        # Mood moving average
        moods: List[float] = [card.mood_score for card in cards if card.mood_score is not None]
        mood_avg = sum(moods) / len(moods) if moods else None

        snapshot = AnalyticsSnapshot(
            top_palettes=top_palettes,
            geo_heatmap=dict(heat_buckets),
            mood_average=mood_avg,
        )
        logger.info(
            "Analytics snapshot created: %d cards, %d palettes, %d buckets",
            len(cards),
            len(top_palettes),
            len(heat_buckets),
        )
        return snapshot


# --------------------------------------------------------------------------- #
#                               Factory Helpers                               #
# --------------------------------------------------------------------------- #

class AnalyticsFactory:
    """
    Central place to wire analytics dependencies. Down the road, DI containers
    or configuration frameworks can hook in here without touching call-sites.
    """

    _instance: Optional[AnalyticsAggregator] = None
    _lock = RLock()

    @classmethod
    def get_aggregator(cls) -> AnalyticsAggregator:
        with cls._lock:
            if cls._instance is None:
                cls._instance = AnalyticsAggregator()
                cls._instance.start()
            return cls._instance

    @classmethod
    async def shutdown(cls) -> None:
        with cls._lock:
            inst = cls._instance
            cls._instance = None
        if inst:
            inst.stop()
            await inst.wait_closed()


# --------------------------------------------------------------------------- #
#                              Quick Smoke Test                               #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    import random
    from uuid import uuid4

    async def _demo():
        aggregator = AnalyticsFactory.get_aggregator()

        async def producer():
            for _ in range(200):
                EventBus.publish(
                    PrismCardSnapshot(
                        card_id=str(uuid4()),
                        user_id="demo",
                        created_at=datetime.utcnow(),
                        dominant_hex_colors=tuple(
                            random.choices(
                                [
                                    "#FF4136",
                                    "#0074D9",
                                    "#2ECC40",
                                    "#FFDC00",
                                    "#B10DC9",
                                    "#AAAAAA",
                                ],
                                k=3,
                            )
                        ),
                        geo_point=GeoPoint(
                            lat=random.uniform(-90, 90),
                            lon=random.uniform(-180, 180),
                        ),
                        mood_score=random.uniform(-1, 1),
                    )
                )
                await asyncio.sleep(0.05)  # 20 events/sec

        async def consumer():
            repo = aggregator._repo
            async for snap in repo.stream():
                logger.info(
                    "Top palette: %s | Buckets: %d | Avg mood: %s",
                    snap.top_palettes[:1],
                    len(snap.geo_heatmap),
                    f"{snap.mood_average:.2f}" if snap.mood_average else "n/a",
                )

        await asyncio.gather(producer(), consumer())

    try:
        asyncio.run(_demo())
    finally:
        asyncio.run(AnalyticsFactory.shutdown())
```