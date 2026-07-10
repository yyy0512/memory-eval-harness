```python
"""
PrismPocket – Trend Analytics Engine
------------------------------------

This module implements a real-time trend analytics engine that observes the
application’s EventBus for newly-captured `PrismCard`s and periodically extracts
insights such as:

    • Most-used colour palettes over a sliding time-window
    • Average “mood score” of the last n cards
    • Hot-spot detection (geo clustering) – stubbed for brevity

Computed metrics are broadcast back onto the bus, cached locally so they can be
surfaced instantly on start-up, and synchronised with the cloud workspace when
connectivity is available.

The engine uses:

    • Observer pattern – lightweight in-process EventBus
    • Singleton – one analytics engine per process
    • AsyncIO – non-blocking background computation
    • ThreadPoolExecutor – off-loads CPU-heavy work when needed
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Type

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s")
)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Event system                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class BaseEvent:
    """Base class for all events published through the EventBus."""

    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class PrismCardAddedEvent(BaseEvent):
    """Event emitted when a new `PrismCard` is captured or synced in."""

    card_id: str
    colours: List[str]  # Hex codes
    mood_score: float  # –1.0 … +1.0
    location: Optional[tuple[float, float]] = None  # lat, lon


@dataclass(frozen=True)
class TrendComputedEvent(BaseEvent):
    """Event emitted after the TrendAnalyticsEngine computes new metrics."""

    top_palettes: List[str]
    average_mood: float
    sample_size: int


class EventBus:
    """Minimal in-memory Observer bus."""

    def __init__(self) -> None:
        self._subscribers: Dict[Type[BaseEvent], List[Callable[[BaseEvent], None]]] = {}
        self._lock = threading.Lock()

    def subscribe(
        self, event_type: Type[BaseEvent], handler: Callable[[BaseEvent], None]
    ) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)
            logger.debug("Subscribed handler %s to %s", handler, event_type.__name__)

    def unsubscribe(
        self, event_type: Type[BaseEvent], handler: Callable[[BaseEvent], None]
    ) -> None:
        with self._lock:
            handlers = self._subscribers.get(event_type, [])
            if handler in handlers:
                handlers.remove(handler)
                logger.debug(
                    "Unsubscribed handler %s from %s", handler, event_type.__name__
                )

    def publish(self, event: BaseEvent) -> None:
        with self._lock:
            handlers = list(self._subscribers.get(type(event), []))
        for handler in handlers:
            try:
                handler(event)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Event handler %s failed for event %s", handler, type(event).__name__
                )

    # Singleton instance for app-wide usage
    _instance: Optional["EventBus"] = None

    @classmethod
    def instance(cls) -> "EventBus":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance


# --------------------------------------------------------------------------- #
# Singleton meta-class                                                        #
# --------------------------------------------------------------------------- #


class SingletonMeta(type):
    """Thread-safe Singleton meta-class."""

    _instances: Dict[type, Any] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # type: ignore[override]
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# Trend Analytics Engine                                                      #
# --------------------------------------------------------------------------- #


class TrendAnalyticsEngine(metaclass=SingletonMeta):
    """
    Collects `PrismCardAddedEvent`s and periodically computes creative trends.

    Usage
    -----
    >>> engine = TrendAnalyticsEngine()
    >>> await engine.start()
    """

    _WINDOW_SIZE = 200  # cards
    _COMPUTE_INTERVAL = timedelta(seconds=30)
    _CACHE_FILE = Path.home() / ".prismpocket" / "trend_cache.json"

    def __init__(
        self,
        bus: EventBus | None = None,
        executor: ThreadPoolExecutor | None = None,
    ) -> None:
        self._bus = bus or EventBus.instance()
        self._cards: Deque[PrismCardAddedEvent] = deque(maxlen=self._WINDOW_SIZE)
        self._lock = asyncio.Lock()
        self._loop = asyncio.get_event_loop()
        self._executor = executor or ThreadPoolExecutor(
            max_workers=os.cpu_count() or 1, thread_name_prefix="TrendWorker"
        )
        self._task: Optional[asyncio.Task[None]] = None
        self._stopped = asyncio.Event()

        # Subscribe to feed
        self._bus.subscribe(PrismCardAddedEvent, self._on_card_added)

        # Load cached trends for instant availability
        try:
            self._load_cached_metrics()
        except Exception:  # noqa: BLE001
            logger.exception("Failed to load cached analytics")

    # ------------------------------ Public API ----------------------------- #

    async def start(self) -> None:
        """Starts the background trend computation task."""
        if self._task is None or self._task.done():
            self._stopped.clear()
            self._task = self._loop.create_task(self._background_worker())
            logger.info("TrendAnalyticsEngine started")

    async def stop(self) -> None:
        """Stops the background worker gracefully."""
        if self._task and not self._task.done():
            self._stopped.set()
            await self._task
            logger.info("TrendAnalyticsEngine stopped")

    def snapshot(self) -> Dict[str, Any]:
        """Takes a synchronous snapshot of current metrics."""
        palettes, mood = self._compute_metrics(list(self._cards))
        return {
            "top_palettes": palettes,
            "average_mood": mood,
            "sample_size": len(self._cards),
        }

    # -------------------------- Event Handlers ----------------------------- #

    def _on_card_added(self, event: PrismCardAddedEvent) -> None:
        """Observer callback – executes in publisher’s thread."""
        # AsyncIO interaction: put into loop’s queue
        self._loop.call_soon_threadsafe(self._append_card, event)

    def _append_card(self, event: PrismCardAddedEvent) -> None:
        # Called in event-loop context
        self._cards.append(event)

    # -------------------------- Background Worker -------------------------- #

    async def _background_worker(self) -> None:
        """Loop that periodically computes metrics."""
        next_run = datetime.utcnow() + self._COMPUTE_INTERVAL
        while not self._stopped.is_set():
            now = datetime.utcnow()
            delay = (next_run - now).total_seconds()
            if delay > 0:
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass  # expected
            if self._stopped.is_set():
                break

            next_run = datetime.utcnow() + self._COMPUTE_INTERVAL
            await self._compute_and_publish()

        # Persist before exit
        await self._persist_latest_metrics()

    # ----------------------- Metric Computation Logic ---------------------- #

    async def _compute_and_publish(self) -> None:
        # Copy deque snapshot under lock
        async with self._lock:
            cards = list(self._cards)

        if not cards:
            logger.debug("No cards captured yet – skipping metric computation")
            return

        # Off-load to thread pool for CPU scenery
        palettes, avg_mood = await self._loop.run_in_executor(
            self._executor, self._compute_metrics, cards
        )

        metric_event = TrendComputedEvent(
            top_palettes=palettes, average_mood=avg_mood, sample_size=len(cards)
        )

        # Publish trends to app
        self._bus.publish(metric_event)

        # Persist offline cache
        await self._persist_metrics(metric_event)

    @staticmethod
    def _compute_metrics(
        cards: List[PrismCardAddedEvent],
    ) -> tuple[List[str], float]:
        """
        Heavy-weight function that collates trends.

        Returns
        -------
        (top_palette_hexes, average_mood_score)
        """
        # Palette popularity
        palette_counter: Counter[str] = Counter()
        for e in cards:
            palette_counter.update(e.colours)

        top_palettes = [c for c, _ in palette_counter.most_common(5)]

        # Mood aggregation
        avg_mood = (
            sum(e.mood_score for e in cards) / len(cards) if cards else 0.0
        )

        return top_palettes, avg_mood

    # --------------------------- Persistence -------------------------------- #

    async def _persist_metrics(self, event: TrendComputedEvent) -> None:
        """Persists latest metrics to disk asynchronously."""
        data = {
            "timestamp": event.timestamp.isoformat(),
            "top_palettes": event.top_palettes,
            "average_mood": event.average_mood,
            "sample_size": event.sample_size,
        }
        await self._loop.run_in_executor(self._executor, self._write_cache_file, data)

    async def _persist_latest_metrics(self) -> None:
        """Persists snapshot on shutdown."""
        snapshot = self.snapshot()
        await self._loop.run_in_executor(self._executor, self._write_cache_file, snapshot)

    def _load_cached_metrics(self) -> None:
        """Synchronous start-up helper."""
        if self._CACHE_FILE.exists():
            with self._CACHE_FILE.open("r", encoding="utf-8") as fp:
                data = json.load(fp)
            logger.info(
                "Loaded cached metrics (sample=%s, ts=%s)",
                data.get("sample_size"),
                data.get("timestamp"),
            )
            event = TrendComputedEvent(
                top_palettes=data.get("top_palettes", []),
                average_mood=data.get("average_mood", 0.0),
                sample_size=data.get("sample_size", 0),
            )
            self._bus.publish(event)

    # ------------------------- Helper functions ----------------------------- #

    @classmethod
    def _write_cache_file(cls, data: Dict[str, Any]) -> None:
        cls._CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            with cls._CACHE_FILE.open("w", encoding="utf-8") as fp:
                json.dump(data, fp)
            logger.debug("Persisted analytics cache to %s", cls._CACHE_FILE)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to persist analytics cache to %s", cls._CACHE_FILE)

    # ----------------- Cloud Synchronisation (stubbed) ---------------------- #

    async def sync_with_cloud(self) -> None:  # pragma: no cover
        """
        Flushes computed metrics to remote analytics store.

        In a full implementation this would POST to the PrismPocket backend,
        retry with exponential back-off, and clear the local cache when
        confirmed. Here it’s stubbed to demonstrate structure only.
        """
        logger.debug("sync_with_cloud() called – not yet implemented.")


# --------------------------------------------------------------------------- #
# Convenience: auto-start engine when module is imported within an event loop #
# --------------------------------------------------------------------------- #

async def _auto_start() -> None:
    """Automatically starts the trend engine when inside an asyncio loop."""
    engine = TrendAnalyticsEngine()
    await engine.start()


def _detect_event_loop_and_start() -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # not inside event loop -> caller will start manually
    loop.create_task(_auto_start())


_detect_event_loop_and_start()
```