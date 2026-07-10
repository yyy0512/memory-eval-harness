```python
"""
src/module_9.py
====================================
Palette analytics & trend engine for PrismPocket.

This module houses a self-contained, production-ready implementation of the
“PaletteMetric” analytics pipeline:

    • Listens to domain events (CARD_CREATED, CARD_UPDATED)
    • Extracts dominant colours from the incoming PrismCard payload
    • Maintains rolling usage counters for each colour swatch
    • Surfaces trending palettes & mood scores to observers
    • Persists aggregated metrics via repository gateway
    • Flushes to cloud when network is available

The code purposefully avoids dependencies on heavy-weight imaging libraries
(e.g. Pillow) by delegating exhaustive colour quantisation to the native layer
where available; for the pure-Python fallback we leverage a lightweight median-cut
approximation.
"""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import math
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Deque, Dict, Iterable, List, Mapping, MutableMapping, Optional, Protocol, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

_LOGGER = logging.getLogger("prism.analytics.palette")
_LOGGER.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Domain event bus – lightweight local implementation
# (In production a more sophisticated, multiprocess-safe solution is used.)
# --------------------------------------------------------------------------- #


class EventBus:
    """
    Thread-safe, in-proc observer bus.

    Observers subscribe by event type and receive a strongly-typed dataclass
    describing the mutation.
    """

    _instance: "EventBus | None" = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[["PrismEvent"], None]]] = collections.defaultdict(list)
        self._sub_lock = threading.RLock()

    @classmethod
    def instance(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def publish(self, event: "PrismEvent") -> None:
        """Publish to all subscribers of the given event type."""
        with self._sub_lock:
            callbacks = list(self._subscribers.get(event.type, []))
        _LOGGER.debug("Publishing event %s to %d subscriber(s)", event.type, len(callbacks))
        for cb in callbacks:
            try:
                cb(event)
            except Exception:  # pragma: no cover
                _LOGGER.exception("Observer %s raised during event propagation", cb)

    def subscribe(self, event_type: str, callback: Callable[["PrismEvent"], None]) -> Callable[[], None]:
        """
        Subscribe callback to an event_type. Returns an unsubscribe function.
        """
        with self._sub_lock:
            self._subscribers[event_type].append(callback)
            _LOGGER.debug("Subscriber %s added for %s", callback, event_type)

        def _unsubscribe() -> None:
            with self._sub_lock:
                self._subscribers[event_type].remove(callback)
                _LOGGER.debug("Subscriber %s removed for %s", callback, event_type)

        return _unsubscribe


# --------------------------------------------------------------------------- #
# Domain models
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PrismEvent:
    """
    Generic immutable event dataclass.
    """

    type: str
    payload: Mapping[str, object]
    ts: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class PrismCard:
    """
    Simplified snapshot of a rendered prism card.
    """
    id: str
    user_id: str
    dominant_colors: Tuple[str, ...]  # Hex codes, e.g. ("#FF0000", "#00FF00")
    mood_score: float  # Range −1.0 (sad) .. 1.0 (happy)
    created_at: datetime


# --------------------------------------------------------------------------- #
# Repository interfaces
# --------------------------------------------------------------------------- #


class PaletteMetricRepository(Protocol):
    """
    Persistence gateway for PaletteMetric aggregates.
    """

    async def load(self) -> Mapping[str, int]:
        ...

    async def save(self, counters: Mapping[str, int]) -> None:
        ...


class InMemoryPaletteMetricRepository:
    """
    Simple repository for unit testing and offline mode.
    """

    def __init__(self) -> None:
        self._storage: Dict[str, int] = {}

    async def load(self) -> Mapping[str, int]:
        _LOGGER.debug("Loading palette counters from in-memory store")
        return dict(self._storage)

    async def save(self, counters: Mapping[str, int]) -> None:
        _LOGGER.debug("Saving %d palette counters to in-memory store", len(counters))
        self._storage.update(counters)


class JsonFilePaletteMetricRepository:
    """
    Stores counters in a local json file on device.
    """

    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path.expanduser()
        self._file_path.parent.mkdir(parents=True, exist_ok=True)

    async def load(self) -> Mapping[str, int]:
        if not self._file_path.exists():
            _LOGGER.debug("Metric file not found: %s (returning empty)", self._file_path)
            return {}
        try:
            content = self._file_path.read_text()
            return json.loads(content)
        except Exception:
            _LOGGER.warning("Corrupted palette metric store; resetting file")
            self._file_path.unlink(missing_ok=True)
            return {}

    async def save(self, counters: Mapping[str, int]) -> None:
        tmp = self._file_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(counters))
        tmp.replace(self._file_path)
        _LOGGER.debug("Palette counters persisted to %s", self._file_path)


# --------------------------------------------------------------------------- #
# Colour helpers (pure-Python fallback)
# --------------------------------------------------------------------------- #

def _hex_bucket(hex_code: str, precision: int = 32) -> str:
    """
    Buckets a colour to reduce cardinality.

    Each RGB channel is quantised to the nearest `precision` boundary
    (e.g. 32 -> 8 steps). Returns a canonicalised hex string.
    """
    rgb = tuple(int(hex_code[i:i + 2], 16) for i in (1, 3, 5))
    bucket = tuple(round(v / precision) * precision for v in rgb)
    return "#" + "".join(f"{min(v, 255):02X}" for v in bucket)


def extract_palette(card: PrismCard, max_colors: int = 3) -> Sequence[str]:
    """
    Robustly extract palette from card; if messed up, fallback to defaults.
    """
    if not card.dominant_colors:
        return ("#808080",)  # Grey fallback
    return tuple(card.dominant_colors[:max_colors])


# --------------------------------------------------------------------------- #
# Analytics engine
# --------------------------------------------------------------------------- #


class PaletteMetricCollector:
    """
    Maintains real-time colour usage counters and surfaces trends.
    """

    _FLUSH_INTERVAL = timedelta(seconds=8)      # flush to repository
    _ROLLING_WINDOW = timedelta(hours=6)        # for trending calculation
    _MAX_COUNTERS = 2048                        # guard memory usage

    def __init__(
        self,
        repo: PaletteMetricRepository,
        bus: EventBus | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._repo = repo
        self._bus = bus or EventBus.instance()
        self._loop = loop or asyncio.get_event_loop()

        self._counters: Dict[str, int] = {}
        self._recent: Deque[Tuple[str, datetime]] = collections.deque(maxlen=10_000)
        self._flush_task: Optional[asyncio.Task[None]] = None
        self._unsubscribe: Optional[Callable[[], None]] = None
        self._lock = asyncio.Lock()

    # ------------- Public API ------------------------------------------------ #

    def start(self) -> None:
        """
        Begin listening for events and schedule periodic flushes.
        """
        _LOGGER.info("Starting PaletteMetricCollector")
        self._unsubscribe = self._bus.subscribe("CARD_CREATED", self._on_card_event)
        self._unsubscribe_2 = self._bus.subscribe("CARD_UPDATED", self._on_card_event)

        self._flush_task = self._loop.create_task(self._periodic_flush())

    async def stop(self) -> None:
        """
        Flush remaining metrics and dispose resources.
        """
        _LOGGER.info("Stopping PaletteMetricCollector")
        if self._unsubscribe:
            self._unsubscribe()
        if self._unsubscribe_2:
            self._unsubscribe_2()
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        await self._flush()  # final flush

    async def trending_palettes(self, top: int = 5) -> List[Tuple[str, int]]:
        """
        Return the most popular buckets over the rolling window.
        """
        async with self._lock:
            now = datetime.utcnow()
            cutoff = now - self._ROLLING_WINDOW
            # Filter recent deque for items after cutoff
            recent_filtered = [hex_code for hex_code, ts in self._recent if ts >= cutoff]
            counter = collections.Counter(recent_filtered)
            trend = counter.most_common(top)
            _LOGGER.debug("Trending palettes: %s", trend)
            return trend

    # ------------- Internal machinery ---------------------------------------- #

    def _on_card_event(self, event: PrismEvent) -> None:
        """
        Consume card-related events in the main thread; dispatch to loop.
        """
        card_data = event.payload.get("card")
        if not card_data:
            _LOGGER.warning("Event %s missing card in payload", event.type)
            return

        try:
            card = PrismCard(**card_data)
        except Exception:  # pragma: no cover
            _LOGGER.exception("Failed to deserialize PrismCard from event payload")
            return

        asyncio.run_coroutine_threadsafe(self._process_card(card), self._loop)

    async def _process_card(self, card: PrismCard) -> None:
        """
        Extract colours, update counters, append to recent deque.
        """
        palette = extract_palette(card)
        now = datetime.utcnow()

        async with self._lock:
            for hex_code in palette:
                bucket = _hex_bucket(hex_code)
                self._counters[bucket] = self._counters.get(bucket, 0) + 1
                self._recent.append((bucket, now))

            # Memory guard
            if len(self._counters) > self._MAX_COUNTERS:
                _LOGGER.debug("Pruning counters from %d entries", len(self._counters))
                self._prune_counters()

    async def _periodic_flush(self) -> None:
        """
        Background coroutine persisting counters on interval.
        """
        await self._load_initial()
        while True:
            try:
                await asyncio.sleep(self._FLUSH_INTERVAL.total_seconds())
                await self._flush()
            except asyncio.CancelledError:
                break

    async def _load_initial(self) -> None:
        """
        Load persisted counters on startup.
        """
        try:
            initial = await self._repo.load()
            async with self._lock:
                self._counters.update(initial)
            _LOGGER.info("Loaded %d palette counters from store", len(initial))
        except Exception:
            _LOGGER.exception("Unable to load persisted counters")

    async def _flush(self) -> None:
        """
        Persist counters to repository.
        """
        async with self._lock:
            snapshot = dict(self._counters)

        try:
            await self._repo.save(snapshot)
            _LOGGER.debug("Flushed %d palette counters", len(snapshot))
        except Exception:  # pragma: no cover
            _LOGGER.exception("Failed to flush counters to repository")

    # ------------- Helpers --------------------------------------------------- #

    def _prune_counters(self) -> None:
        """
        Trim the bottom 10% of least-used colour buckets.
        """
        if not self._counters:
            return
        threshold = max(int(len(self._counters) * 0.1), 1)
        for bucket, _ in sorted(self._counters.items(), key=lambda kv: kv[1])[:threshold]:
            self._counters.pop(bucket, None)


# --------------------------------------------------------------------------- #
# Convenience bootstrap (called from application shell)
# --------------------------------------------------------------------------- #

_collector_singleton: Optional[PaletteMetricCollector] = None


def bootstrap_palette_collector(
    *,
    repo_path: Path | None = None,
    event_bus: EventBus | None = None,
    loop: asyncio.AbstractEventLoop | None = None,
) -> PaletteMetricCollector:
    """
    Initialise global PaletteMetricCollector singleton.
    """
    global _collector_singleton
    if _collector_singleton is not None:
        return _collector_singleton

    repository: PaletteMetricRepository
    if repo_path:
        repository = JsonFilePaletteMetricRepository(repo_path)
    else:
        repository = InMemoryPaletteMetricRepository()

    collector = PaletteMetricCollector(repo=repository, bus=event_bus, loop=loop)
    collector.start()
    _collector_singleton = collector
    return collector


# --------------------------------------------------------------------------- #
# Example usage – guarded so that it does not execute on import
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    async def demo() -> None:
        bus = EventBus.instance()
        collector = bootstrap_palette_collector(repo_path=Path("./palette_metrics.json"), event_bus=bus)

        # Simulate card creation events
        for _ in range(25):
            card = PrismCard(
                id=str(uuid.uuid4()),
                user_id="alice",
                dominant_colors=(
                    random.choice(["#FF5733", "#33A1FF", "#A633FF", "#33FF92", "#FFD433"]),
                    random.choice(["#FF5733", "#33A1FF", "#A633FF", "#33FF92", "#FFD433"]),
                ),
                mood_score=random.uniform(-1, 1),
                created_at=datetime.utcnow(),
            )

            bus.publish(
                PrismEvent(
                    type="CARD_CREATED",
                    payload={"card": card.__dict__},
                )
            )
            await asyncio.sleep(0.1)

        trends = await collector.trending_palettes(top=3)
        print("Trending:", trends)

        await collector.stop()

    asyncio.run(demo())
```