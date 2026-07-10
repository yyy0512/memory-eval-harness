```python
"""
src/module_10.py

PrismPocket – Analytics & Trend Surface Engine
----------------------------------------------
This module houses the core, platform-agnostic analytics pipeline that powers
the “creative trends” surfaces inside PrismPocket.  The engine subscribes to
card-level mutations published by repositories and continuously updates a small
set of cached metrics (palette popularity, hotspot locations, and mood score
distribution).  View-models consume the derived metrics via an async iterator
or direct observer callbacks.

Patterns employed:
    * Observer Pattern   – EventBus → AnalyticsEngine
    * Singleton          – AnalyticsEngine (single process-wide instance)
    * Factory Pattern    – AnalyzerFactory produces concrete IAnalyzer units
    * Repository Pattern – AnalyticsEngine is agnostic of storage back-ends
    * Clean Architecture – Pure domain entities (PrismCard) live in this ring
"""
from __future__ import annotations

import asyncio
import collections
import logging
import math
import random
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import wraps
from typing import (
    Any,
    AsyncIterator,
    Callable,
    DefaultDict,
    Dict,
    Iterable,
    List,
    Optional,
    Set,
    Tuple,
    Union,
)
import uuid

# Sentinel for optional 3rd-party libs that are not mandatory
try:
    from PIL import Image  # pragma: no cover
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

###############################################################################
# Logging Setup
###############################################################################

logger = logging.getLogger("prism.analytics")
if not logger.handlers:
    # Attach default console handler when module is executed stand-alone
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

###############################################################################
# Domain: PrismCard
###############################################################################


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Immutable domain entity representing a single capture.
    """
    id: str
    user_id: str
    media_type: str  # e.g. "text", "photo", "voice", "geo"
    created_at: datetime
    color_palette: Tuple[str, ...] = field(default_factory=tuple)  # HEX strings
    location: Optional[Tuple[float, float]] = None  # (lat, lon)
    mood_score: Optional[float] = None  # -1.0 (sad) ↔ +1.0 (happy)
    metadata: Dict[str, Any] = field(default_factory=dict)


###############################################################################
# Event Bus (Observer Pattern)
###############################################################################


@dataclass(frozen=True)
class CardEvent:
    """
    Wrapper event published by repositories whenever a card is created or
    updated.
    """
    card: PrismCard
    action: str  # 'created', 'updated', 'deleted'
    timestamp: float = field(default_factory=lambda: time.time())


class Observer(ABC):
    @abstractmethod
    def on_next(self, event: CardEvent) -> None: ...


class EventBus:
    """
    Thread-safe, in-memory publish/subscribe bus for CardEvent messages.
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        self._observers: Set[Observer] = set()

    # Singleton accessor
    @classmethod
    def instance(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # Publisher API ──────────────────────────────────────────────────────────

    def publish(self, event: CardEvent) -> None:
        for obs in list(self._observers):
            try:
                obs.on_next(event)
            except Exception as exc:  # pragma: no cover
                logger.error("Observer %s raised: %s", obs, exc, exc_info=exc)

    # Subscriber API ─────────────────────────────────────────────────────────

    def subscribe(self, observer: Observer) -> Callable[[], None]:
        self._observers.add(observer)
        logger.debug("Observer subscribed: %s", observer)

        def unsubscribe() -> None:
            self._observers.discard(observer)
            logger.debug("Observer unsubscribed: %s", observer)

        return unsubscribe


###############################################################################
# Analyzer Interfaces
###############################################################################


class IAnalyzer(ABC):
    """
    An analyzer ingests CardEvent stream & mutates its internal state to derive
    a particular trend metric.
    """

    @property
    @abstractmethod
    def name(self) -> str: ...

    @abstractmethod
    def consume(self, event: CardEvent) -> None:
        """
        Update internal state based on the incoming event.
        """

    @abstractmethod
    def snapshot(self) -> Dict[str, Any]:
        """
        Return an immutable snapshot of the current metric.
        """


###############################################################################
# Concrete Analyzers
###############################################################################


class PaletteAnalyzer(IAnalyzer):
    """
    Tracks frequency of HEX colors across all cards and maintains the top N
    palette colors.
    """

    TOP_N = 8

    def __init__(self) -> None:
        self._counter: DefaultDict[str, int] = collections.defaultdict(int)

    @property
    def name(self) -> str:
        return "palette"

    def consume(self, event: CardEvent) -> None:
        if event.action == "deleted":
            # Deletions are ignored until server supports tombstone diffing
            return

        for hex_color in event.card.color_palette:
            if not hex_color.startswith("#") or len(hex_color) not in (4, 7):
                continue  # Skip malformed
            self._counter[hex_color.lower()] += 1

    def snapshot(self) -> Dict[str, Any]:
        most_common = sorted(
            self._counter.items(),
            key=lambda kv: kv[1],
            reverse=True,
        )[: self.TOP_N]
        return {"top_colors": [{"hex": k, "count": v} for k, v in most_common]}


class HotspotAnalyzer(IAnalyzer):
    """
    Aggregates geotagged cards into lat/lon buckets (~10km grid) and surfaces
    hotspots sorted by activity.
    """

    GRID_SIZE_DEG = 0.1  # approx 11.1km at equator

    def __init__(self) -> None:
        self._grid_counter: DefaultDict[Tuple[int, int], int] = (
            collections.defaultdict(int)
        )

    @property
    def name(self) -> str:
        return "hotspots"

    def _grid_key(self, lat: float, lon: float) -> Tuple[int, int]:
        return (int(lat / self.GRID_SIZE_DEG), int(lon / self.GRID_SIZE_DEG))

    def consume(self, event: CardEvent) -> None:
        if event.action == "deleted" or not event.card.location:
            return
        lat, lon = event.card.location
        key = self._grid_key(lat, lon)
        self._grid_counter[key] += 1

    def snapshot(self) -> Dict[str, Any]:
        sorted_cells = sorted(
            self._grid_counter.items(),
            key=lambda kv: kv[1],
            reverse=True,
        )[:10]
        hotspots = [
            {
                "lat": k[0] * self.GRID_SIZE_DEG,
                "lon": k[1] * self.GRID_SIZE_DEG,
                "count": v,
            }
            for k, v in sorted_cells
        ]
        return {"hotspots": hotspots}


class MoodAnalyzer(IAnalyzer):
    """
    Computes rolling average mood score.
    """

    WINDOW_SIZE = 200  # cards

    def __init__(self) -> None:
        self._recent: collections.deque[float] = collections.deque(maxlen=self.WINDOW_SIZE)

    @property
    def name(self) -> str:
        return "mood"

    def consume(self, event: CardEvent) -> None:
        if event.action == "deleted":
            return
        if event.card.mood_score is not None:
            self._recent.append(event.card.mood_score)

    def snapshot(self) -> Dict[str, Any]:
        if not self._recent:
            return {"average_mood": None}
        avg = sum(self._recent) / len(self._recent)
        return {"average_mood": round(avg, 3)}


###############################################################################
# Analyzer Factory  (Factory Pattern)
###############################################################################


class AnalyzerFactory:
    """
    Creates pre-configured analyzer instances.  Can be extended via the
    `register` decorator.
    """

    _registry: Dict[str, Callable[[], IAnalyzer]] = {}

    @classmethod
    def register(cls, key: str) -> Callable[[Callable[[], IAnalyzer]], Callable[[], IAnalyzer]]:
        def decorator(constructor: Callable[[], IAnalyzer]) -> Callable[[], IAnalyzer]:
            if key in cls._registry:
                raise KeyError(f"Analyzer '{key}' is already registered.")
            cls._registry[key] = constructor
            return constructor

        return decorator

    @classmethod
    def create_all(cls) -> List[IAnalyzer]:
        return [ctor() for ctor in cls._registry.values()]


# Register analyzers
AnalyzerFactory.register("palette")(PaletteAnalyzer)
AnalyzerFactory.register("hotspots")(HotspotAnalyzer)
AnalyzerFactory.register("mood")(MoodAnalyzer)


###############################################################################
# Analytics Engine (Singleton, Observer)
###############################################################################


def synchronized(fn: Callable[..., Any]) -> Callable[..., Any]:
    """
    Method decorator providing thread-level synchronization.
    """
    lock = threading.RLock()

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with lock:
            return fn(*args, **kwargs)

    return wrapper


class AnalyticsEngine(Observer):
    """
    Consumes card events and maintains derived metrics in-memory for quick
    retrieval.  Offers both pull (snapshot()) and push (async stream) APIs.

    Usage:
        engine = AnalyticsEngine.instance()
    """

    _instance: Optional["AnalyticsEngine"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        if AnalyticsEngine._instance is not None:
            raise RuntimeError(
                "Use AnalyticsEngine.instance() instead of direct construction."
            )
        self._analyzers: List[IAnalyzer] = AnalyzerFactory.create_all()
        self._bus = EventBus.instance()
        self._bus.subscribe(self)
        self._async_listeners: Set[asyncio.Queue[Dict[str, Any]]] = set()
        logger.info("AnalyticsEngine initialized with %d analyzers.", len(self._analyzers))

    # Singleton accessor
    @classmethod
    def instance(cls) -> "AnalyticsEngine":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # Observer.on_next
    @synchronized
    def on_next(self, event: CardEvent) -> None:
        logger.debug("Processing CardEvent: %s – %s", event.action, event.card.id)
        for analyzer in self._analyzers:
            analyzer.consume(event)
        # Notify async listeners non-blocking
        if self._async_listeners:
            snapshot = self.snapshot()
            for queue in self._async_listeners:
                try:
                    queue.put_nowait(snapshot)
                except asyncio.QueueFull:  # pragma: no cover
                    logger.warning("Listener queue full – dropping metrics update.")

    # Public API  ─────────────────────────────────────────────────────────────

    @synchronized
    def snapshot(self) -> Dict[str, Any]:
        """
        Merge analyzer snapshots into a single dict.
        """
        merged: Dict[str, Any] = {}
        for analyzer in self._analyzers:
            merged[analyzer.name] = analyzer.snapshot()
        merged["updated_at"] = datetime.now(timezone.utc).isoformat()
        return merged

    async def stream(self) -> AsyncIterator[Dict[str, Any]]:
        """
        Async generator that yields metric snapshots whenever the underlying
        analyzers emit a change.
        """
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=3)
        self._async_listeners.add(queue)
        logger.debug("Async listener subscribed (%d total).", len(self._async_listeners))
        try:
            # Immediately yield current snapshot
            yield self.snapshot()
            while True:
                data = await queue.get()
                yield data
        finally:
            self._async_listeners.discard(queue)
            logger.debug("Async listener unsubscribed (%d remaining).", len(self._async_listeners))


###############################################################################
# Example: Simulated Event Source  (only executed when run directly)
###############################################################################


def _simulate_event_stream(total: int = 100) -> None:  # pragma: no cover
    """
    Fire a synthetic stream of CardEvents for local testing / demo.
    """
    demo_user = str(uuid.uuid4())
    for idx in range(total):
        card = PrismCard(
            id=str(uuid.uuid4()),
            user_id=demo_user,
            media_type=random.choice(["text", "photo", "voice", "geo"]),
            created_at=datetime.now(timezone.utc),
            color_palette=tuple(
                f"#{random.randint(0, 0xFFFFFF):06x}" for _ in range(random.randint(1, 5))
            ),
            location=(
                (37.7 + random.random() * 0.1, -122.4 + random.random() * 0.1)
                if random.random() < 0.7
                else None
            ),
            mood_score=random.uniform(-1.0, 1.0),
        )
        event = CardEvent(card=card, action="created")
        EventBus.instance().publish(event)
        time.sleep(0.05)  # slowish so humans can observe log output


async def _print_metrics_live(duration: int = 5) -> None:  # pragma: no cover
    engine = AnalyticsEngine.instance()
    async for metrics in engine.stream():
        logger.info("Snapshot: %s", metrics)
        await asyncio.sleep(0.25)
        if duration and time.time() - _start_time > duration:
            break


if __name__ == "__main__":  # pragma: no cover
    # Quick demo when the module is executed directly
    _start_time = time.time()
    threading.Thread(target=_simulate_event_stream, daemon=True).start()
    asyncio.run(_print_metrics_live(duration=6))
```