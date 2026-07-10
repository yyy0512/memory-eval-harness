```python
"""
src/module_72.py

PrismPocket – Trend Analytics Engine
====================================

This module contains a production-ready implementation of the in-app analytics
service that mines PrismCards for creative insights (trending palettes,
location hotspots, mood score, etc.) and publishes the distilled metrics over
the project-wide Observer bus so that UI view-models can react in real-time.

The service is deliberately platform-agnostic and depends only on interfaces
defined in the domain layer.  Mobile-specific code (Room database on Android,
CloudKit on iOS) must be injected via the repository and adapter boundaries.

Architecture patterns used:
    * Singleton                – Ensures a single analytics engine per process
    * Factory Pattern          – Pluggable metric calculator registry
    * Observer Pattern         – Streams analytics to interested subscribers
    * Repository Pattern       – Abstracts data access for PrismCards
"""

from __future__ import annotations

import itertools
import logging
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from typing import Callable, Dict, Iterable, List, Optional, Protocol, Tuple

# ──────────────────────────────────────────────────────────────────────────────
# Logging configuration
# ──────────────────────────────────────────────────────────────────────────────

_LOGGER = logging.getLogger("prism_pocket.analytics")
if not _LOGGER.handlers:
    # Avoid duplicate handlers when reloading modules in development
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(levelname)s] %(name)s :: %(message)s")
    )
    _LOGGER.addHandler(_handler)
    _LOGGER.setLevel(logging.INFO)

# ──────────────────────────────────────────────────────────────────────────────
# Domain stubs (These would live elsewhere in the real code-base)
# ──────────────────────────────────────────────────────────────────────────────


@dataclass(slots=True, frozen=True)
class Color:
    """RGB color (0-255)."""

    r: int
    g: int
    b: int

    def to_hex(self) -> str:
        return "#{:02X}{:02X}{:02X}".format(self.r, self.g, self.b)


@dataclass(slots=True, frozen=True)
class Location:
    latitude: float
    longitude: float


@dataclass(slots=True, frozen=True)
class PrismCard:
    card_id: str
    user_id: str
    created_at: float  # epoch seconds
    mood_score: float  # ‑1..1 sentiment score
    dominant_colors: Tuple[Color, ...]
    location: Optional[Location] = None
    # Other rich-media properties omitted for brevity


# Repository boundary (implemented in infrastructure layer)


class PrismCardRepository(Protocol):
    """Interface to query persisted PrismCards."""

    def fetch_all(self) -> Iterable[PrismCard]:
        ...


# Observer bus – extremely trimmed down to reduce dependencies


class ObserverBus:
    """Thread-safe pub/sub event bus."""

    _subscribers: Dict[str, List[Callable[[object], None]]]

    def __init__(self) -> None:
        self._subscribers = defaultdict(list)
        self._lock = threading.RLock()

    def subscribe(self, event_name: str, callback: Callable[[object], None]) -> None:
        with self._lock:
            self._subscribers[event_name].append(callback)
            _LOGGER.debug("ObserverBus: subscribed '%s' (%s)", event_name, callback)

    def unsubscribe(
        self, event_name: str, callback: Callable[[object], None]
    ) -> None:
        with self._lock:
            if callback in self._subscribers.get(event_name, []):
                self._subscribers[event_name].remove(callback)
                _LOGGER.debug("ObserverBus: unsubscribed '%s' (%s)", event_name, callback)

    def publish(self, event_name: str, payload: object) -> None:
        with self._lock:
            subscribers = list(self._subscribers.get(event_name, []))
        for cb in subscribers:
            try:
                cb(payload)
            except Exception as exc:  # pylint: disable=broad-exception-caught
                _LOGGER.exception("Error in event subscriber '%s': %s", event_name, exc)


# ──────────────────────────────────────────────────────────────────────────────
# Metric data models
# ──────────────────────────────────────────────────────────────────────────────


@dataclass(slots=True, frozen=True)
class PaletteMetric:
    hex_code: str
    frequency: int  # occurrences across all cards


@dataclass(slots=True, frozen=True)
class HotspotMetric:
    location: Location
    count: int


@dataclass(slots=True, frozen=True)
class MoodMetric:
    average_mood: float  # range ‑1..1
    sample_size: int


@dataclass(slots=True, frozen=True)
class AnalyticsSnapshot:
    generated_at: float
    palettes: Tuple[PaletteMetric, ...]
    hotspots: Tuple[HotspotMetric, ...]
    mood: MoodMetric


# ──────────────────────────────────────────────────────────────────────────────
# Metric Calculators (Factory pattern)
# ──────────────────────────────────────────────────────────────────────────────


class MetricCalculator(Protocol):
    """Strategy interface for producing metrics."""

    def __call__(self, cards: Iterable[PrismCard]) -> object:
        ...


class PaletteCalculator:
    TOP_N = 5

    def __call__(self, cards: Iterable[PrismCard]) -> Tuple[PaletteMetric, ...]:
        counter: Counter[str] = Counter()
        for card in cards:
            for color in card.dominant_colors:
                counter[color.to_hex()] += 1

        top = counter.most_common(self.TOP_N)
        result = tuple(PaletteMetric(hex_code=c, frequency=freq) for c, freq in top)
        _LOGGER.debug("PaletteCalculator: calculated %s", result)
        return result


class HotspotCalculator:
    DISTANCE_THRESHOLD_KM = 2.0
    TOP_N = 3

    @staticmethod
    def _haversine_km(loc1: Location, loc2: Location) -> float:
        """Calculate great-circle distance between two points (approx)."""
        from math import radians, cos, sin, asin, sqrt

        lon1, lat1, lon2, lat2 = map(
            radians, [loc1.longitude, loc1.latitude, loc2.longitude, loc2.latitude]
        )
        dlon = lon2 - lon1
        dlat = lat2 - lat1
        a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        c = 2 * asin(sqrt(a))
        km = 6371 * c  # Earth radius in km
        return km

    def __call__(self, cards: Iterable[PrismCard]) -> Tuple[HotspotMetric, ...]:
        # Quick & dirty clustering by proximity
        clusters: List[List[PrismCard]] = []
        for card in cards:
            if card.location is None:
                continue
            placed = False
            for cluster in clusters:
                if self._haversine_km(
                    card.location, cluster[0].location  # type: ignore[arg-type]
                ) <= self.DISTANCE_THRESHOLD_KM:
                    cluster.append(card)
                    placed = True
                    break
            if not placed:
                clusters.append([card])

        cluster_counts = sorted(
            ((cluster[0].location, len(cluster)) for cluster in clusters),
            key=lambda x: x[1],
            reverse=True,
        )[: self.TOP_N]

        result = tuple(HotspotMetric(location=loc, count=count) for loc, count in cluster_counts)
        _LOGGER.debug("HotspotCalculator: calculated %s", result)
        return result


class MoodCalculator:
    def __call__(self, cards: Iterable[PrismCard]) -> MoodMetric:
        moods = [card.mood_score for card in cards]
        result = MoodMetric(
            average_mood=mean(moods) if moods else 0.0, sample_size=len(moods)
        )
        _LOGGER.debug("MoodCalculator: calculated %s", result)
        return result


# ──────────────────────────────────────────────────────────────────────────────
# Trend Analytics Engine (Singleton)
# ──────────────────────────────────────────────────────────────────────────────


class TrendAnalyticsService:
    """
    Singleton service that crunches PrismCards via pluggable calculators and
    broadcasts AnalyticsSnapshot events to the Observer bus.

    Usage
    -----
    >>> service = TrendAnalyticsService.get_instance(repo, bus)
    >>> service.refresh_async()
    """

    _instance: Optional["TrendAnalyticsService"] = None
    _instance_lock = threading.Lock()

    REFRESH_EVENT = "analytics.snapshot"

    def __init__(
        self,
        card_repository: PrismCardRepository,
        observer_bus: ObserverBus,
        max_workers: int = 3,
    ) -> None:
        self._repo = card_repository
        self._bus = observer_bus
        self._calc_registry: Dict[str, MetricCalculator] = {
            "palettes": PaletteCalculator(),
            "hotspots": HotspotCalculator(),
            "mood": MoodCalculator(),
        }
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="analytics-worker",
        )
        self._lock = threading.RLock()
        self._latest_snapshot: Optional[AnalyticsSnapshot] = None
        _LOGGER.info("TrendAnalyticsService initialised")

    # ────────────────────────── Singleton helpers ───────────────────────────

    @classmethod
    def get_instance(
        cls,
        card_repository: PrismCardRepository | None = None,
        observer_bus: ObserverBus | None = None,
    ) -> "TrendAnalyticsService":
        """
        Thread-safe singleton accessor.  The first call must provide repository
        and observer arguments; subsequent calls can omit them.
        """
        if cls._instance is None:
            if card_repository is None or observer_bus is None:
                raise ValueError(
                    "First TrendAnalyticsService.get_instance() call requires "
                    "`card_repository` and `observer_bus`"
                )
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls(card_repository, observer_bus)
        return cls._instance

    # ───────────────────────────── API methods ──────────────────────────────

    def refresh_async(self) -> Future[AnalyticsSnapshot]:
        """
        Kick off background refresh.  Returns a Future so callers can await or
        ignore.  Completion publishes a snapshot event on the Observer bus.

        Raises:
            RuntimeError: If the executor has been shut down.
        """
        if self._executor._shutdown:  # type: ignore[attr-defined]
            raise RuntimeError("Analytics executor shut down")
        _LOGGER.info("Scheduling analytics refresh")
        return self._executor.submit(self._refresh)

    def latest_snapshot(self) -> Optional[AnalyticsSnapshot]:
        """Return the most recently generated snapshot (may be None)."""
        with self._lock:
            return self._latest_snapshot

    def shutdown(self, wait: bool = True) -> None:
        """Cleanly terminate the background executor pool."""
        _LOGGER.info("Shutting down TrendAnalyticsService")
        self._executor.shutdown(wait=wait)

    # ─────────────────────────── Internal logic ─────────────────────────────

    def _refresh(self) -> AnalyticsSnapshot:
        start = time.perf_counter()
        cards = list(self._repo.fetch_all())
        _LOGGER.debug("Fetched %d PrismCards for analytics", len(cards))

        # Compute each metric in parallel workers
        calc_tasks: Dict[str, Future[object]] = {}
        for name, calc in self._calc_registry.items():
            future = self._executor.submit(calc, cards)
            calc_tasks[name] = future

        results: Dict[str, object] = {}
        for name, future in calc_tasks.items():
            try:
                results[name] = future.result(timeout=15)  # seconds
            except Exception as exc:  # pylint: disable=broad-exception-caught
                _LOGGER.exception("Metric '%s' failed: %s", name, exc)
                results[name] = ()

        snapshot = AnalyticsSnapshot(
            generated_at=time.time(),
            palettes=tuple(results.get("palettes", ())),  # type: ignore[arg-type]
            hotspots=tuple(results.get("hotspots", ())),  # type: ignore[arg-type]
            mood=results.get("mood", MoodMetric(0, 0)),  # type: ignore[arg-type]
        )

        with self._lock:
            self._latest_snapshot = snapshot

        # Broadcast
        self._bus.publish(self.REFRESH_EVENT, snapshot)
        elapsed = (time.perf_counter() - start) * 1000
        _LOGGER.info("Analytics refresh complete in %.1f ms", elapsed)
        return snapshot


# ──────────────────────────────────────────────────────────────────────────────
# Example (would be in separate test or CLI file)
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # ----------------------- Mock repository for demo ------------------------
    class InMemoryCardRepo:
        def __init__(self, cards: Iterable[PrismCard]) -> None:
            self._cards = list(cards)

        def fetch_all(self) -> Iterable[PrismCard]:
            return iter(self._cards)

    # Create some fake cards
    import random

    def _random_color() -> Color:
        return Color(*(random.randint(0, 255) for _ in range(3)))

    def _random_location() -> Location:
        return Location(
            latitude=37.7 + random.random() * 0.1, longitude=-122.4 + random.random() * 0.1
        )

    fake_cards = [
        PrismCard(
            card_id=f"card_{i}",
            user_id="demo",
            created_at=time.time() - random.randint(0, 10000),
            mood_score=random.uniform(-1, 1),
            dominant_colors=tuple(_random_color() for _ in range(3)),
            location=_random_location() if i % 3 else None,
        )
        for i in range(50)
    ]

    repo = InMemoryCardRepo(fake_cards)
    bus = ObserverBus()

    def _on_snapshot(snapshot: AnalyticsSnapshot) -> None:
        print(">>> New snapshot:", snapshot)

    bus.subscribe(TrendAnalyticsService.REFRESH_EVENT, _on_snapshot)

    svc = TrendAnalyticsService.get_instance(repo, bus)
    future_snap = svc.refresh_async()
    # Block for demo purposes
    print("Snapshot result:", future_snap.result(timeout=10))
    svc.shutdown()
```