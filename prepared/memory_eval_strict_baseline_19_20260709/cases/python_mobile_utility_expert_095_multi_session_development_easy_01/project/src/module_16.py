```python
"""
src/module_16.py

PrismPocket – Analytics & Creative-Prompt Engine
================================================

This module lives inside the *application* ring of Clean Architecture.
It consumes immutable domain entities (`PrismCard`, `PaletteMetric`,
etc.), aggregates real-time usage signals, and produces higher-order
analytics plus “creative prompt” suggestions that ViewModels can
expose to the UI layer.

Responsibilities
----------------
1.  Capture low-level events emitted from repositories / adapters.
2.  Compute rolling analytics (most-used palettes, mood scores, hotspots).
3.  Notify interested observers (e.g., HomeFeedViewModel, PromptBanner).
4.  Persist snapshots through a pluggable `AnalyticsSink` (cloud, disk).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from enum import Enum
from statistics import mean
from typing import Dict, Iterable, List, MutableMapping, Optional, Protocol, Tuple

# --------------------------------------------------------------------------- #
#                          Domain & Event Definitions                         #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCard:
    """Core domain entity encapsulating a captured artifact."""
    card_id: str
    creator_id: str
    dominant_palette: Tuple[str, ...]  # Hex colors e.g., ("#FFAA00", "#0033FF")
    mood_score: float  # Normalized –1.0 (sad) .. +1.0 (happy)
    latitude: float
    longitude: float
    created_at: float  # Unix timestamp (UTC)


class EventType(str, Enum):
    CARD_CREATED = "CARD_CREATED"
    CARD_EDITED = "CARD_EDITED"
    CARD_SHARED = "CARD_SHARED"


@dataclass(slots=True)
class CardEvent:
    """A lightweight, stream-friendly version of domain mutations."""
    event_type: EventType
    card: PrismCard
    occurred_at: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
#                        Observer / Observable Interfaces                     #
# --------------------------------------------------------------------------- #


class Observer(Protocol):
    """Consumer that reacts to analytics updates."""

    def on_analytics_update(self, snapshot: "AnalyticsSnapshot") -> None: ...


class Observable:
    """Thread-safe observable base class."""

    def __init__(self) -> None:
        self._observers: List[Observer] = []
        self._lock = threading.RLock()

    def subscribe(self, observer: Observer) -> None:
        with self._lock:
            if observer not in self._observers:
                self._observers.append(observer)

    def unsubscribe(self, observer: Observer) -> None:
        with self._lock:
            if observer in self._observers:
                self._observers.remove(observer)

    def _notify(self, snapshot: "AnalyticsSnapshot") -> None:
        with self._lock:
            # Shallow-copy to avoid side-effects if observers modify list.
            observers = self._observers[:]
        for obs in observers:
            try:
                obs.on_analytics_update(snapshot)
            except Exception:  # noqa: BLE001
                logging.exception("Observer %s crashed on analytics update", obs)


# --------------------------------------------------------------------------- #
#                          Analytics Snapshot Dataclass                       #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    palette: Tuple[str, ...]
    usage_count: int


@dataclass(frozen=True, slots=True)
class MoodMetric:
    average_mood: float
    sample_size: int


@dataclass(frozen=True, slots=True)
class HotspotMetric:
    location: Tuple[float, float]  # (lat, lon)
    card_count: int


@dataclass(frozen=True, slots=True)
class AnalyticsSnapshot:
    """Immutable snapshot distributed to observers."""
    generated_at: float
    palette_leaderboard: List[PaletteMetric]
    mood_metric: MoodMetric
    hotspot_leaderboard: List[HotspotMetric]


# --------------------------------------------------------------------------- #
#                             Sink (Persistence)                              #
# --------------------------------------------------------------------------- #


class AnalyticsSink(Protocol):
    """Pluggable persistence for snapshots."""

    def persist(self, snapshot: AnalyticsSnapshot) -> None: ...


class _InMemorySink:
    """Fallback sink used when no external sink has been provided."""
    _storage: List[AnalyticsSnapshot] = []

    def persist(self, snapshot: AnalyticsSnapshot) -> None:
        self._storage.append(snapshot)  # pragma: no cover


# --------------------------------------------------------------------------- #
#                        Metric Calculators & Factory                         #
# --------------------------------------------------------------------------- #


class MetricCalculator(Protocol):
    """Strategy for producing a specific metric."""

    def feed(self, event: CardEvent) -> None: ...

    def reset(self) -> None: ...

    def result(self) -> object: ...


class PaletteMetricCalculator(MetricCalculator):
    """Counts palette occurrences (top-N)."""

    def __init__(self, top_n: int = 5) -> None:
        self._counter: Counter[Tuple[str, ...]] = Counter()
        self._top_n = top_n

    def feed(self, event: CardEvent) -> None:
        if event.event_type != EventType.CARD_CREATED:
            return
        self._counter[event.card.dominant_palette] += 1

    def reset(self) -> None:
        self._counter.clear()

    def result(self) -> List[PaletteMetric]:
        return [
            PaletteMetric(palette=pal, usage_count=count)
            for pal, count in self._counter.most_common(self._top_n)
        ]


class MoodMetricCalculator(MetricCalculator):
    """Computes rolling average mood score."""

    def __init__(self) -> None:
        self._scores: List[float] = []

    def feed(self, event: CardEvent) -> None:
        if event.event_type == EventType.CARD_CREATED:
            self._scores.append(event.card.mood_score)

    def reset(self) -> None:
        self._scores.clear()

    def result(self) -> MoodMetric:
        try:
            avg = mean(self._scores)
        except (StatisticsError, ValueError):  # pragma: no cover
            avg = 0.0
        return MoodMetric(average_mood=avg, sample_size=len(self._scores))


class HotspotMetricCalculator(MetricCalculator):
    """Tallies most active geolocations (grid cell 0.1°)."""

    GRID = 0.1  # ~11 km lat grid, variable lon

    def __init__(self, top_n: int = 5) -> None:
        self._counter: Counter[Tuple[float, float]] = Counter()
        self._top_n = top_n

    @staticmethod
    def _bucket(lat: float, lon: float) -> Tuple[float, float]:
        lat_b = round(lat / HotspotMetricCalculator.GRID) * HotspotMetricCalculator.GRID
        lon_b = round(lon / HotspotMetricCalculator.GRID) * HotspotMetricCalculator.GRID
        return lat_b, lon_b

    def feed(self, event: CardEvent) -> None:
        if event.event_type == EventType.CARD_CREATED:
            bucket = self._bucket(event.card.latitude, event.card.longitude)
            self._counter[bucket] += 1

    def reset(self) -> None:
        self._counter.clear()

    def result(self) -> List[HotspotMetric]:
        return [
            HotspotMetric(location=loc, card_count=count)
            for loc, count in self._counter.most_common(self._top_n)
        ]


def calculator_factory() -> List[MetricCalculator]:
    """FactoryBootstrap for all calculators required by analytics."""
    return [
        PaletteMetricCalculator(),
        MoodMetricCalculator(),
        HotspotMetricCalculator(),
    ]


# --------------------------------------------------------------------------- #
#                           Analytics Manager (Singleton)                     #
# --------------------------------------------------------------------------- #


class AnalyticsManager(Observable):
    """
    High-level façade (thread-safe singleton).

    Usage
    -----
    >>> manager = AnalyticsManager.get()
    >>> manager.ingest(CardEvent(...))
    >>> manager.subscribe(my_viewmodel)
    """

    _INSTANCE: Optional["AnalyticsManager"] = None
    _INST_LOCK = threading.Lock()

    SNAPSHOT_INTERVAL_SEC = 15  # Publish cadence.

    def __init__(self, sink: Optional[AnalyticsSink] = None) -> None:  # noqa: D401
        super().__init__()
        self._sink = sink or _InMemorySink()
        self._calculators: List[MetricCalculator] = calculator_factory()

        # Thread setup for async ingestion & snapshot production.
        self._event_queue: "queue.Queue[CardEvent]" = queue.Queue()
        self._stop_flag = threading.Event()
        self._worker = threading.Thread(
            target=self._run,
            name="AnalyticsWorker",
            daemon=True,
        )
        self._worker.start()
        logging.debug("AnalyticsManager started with calculators: %s", self._calculators)

    # ---------------------------- Singleton Helpers ------------------------ #

    @classmethod
    def get(cls) -> "AnalyticsManager":
        with cls._INST_LOCK:
            if cls._INSTANCE is None:
                cls._INSTANCE = cls()
            return cls._INSTANCE

    # -------------------------- Public API Surface ------------------------- #

    def ingest(self, event: CardEvent) -> None:
        """Thread-safe, non-blocking ingestion of events."""
        try:
            self._event_queue.put_nowait(event)
        except queue.Full:  # pragma: no cover
            logging.warning("AnalyticsManager queue is full; event dropped.")

    def shutdown(self) -> None:
        """Graceful shutdown for tests or application exit."""
        self._stop_flag.set()
        self._worker.join(timeout=2)

    # ------------------------------- Worker -------------------------------- #

    def _run(self) -> None:
        last_snapshot = time.time()
        while not self._stop_flag.is_set():
            try:
                event = self._event_queue.get(timeout=0.5)
                for calc in self._calculators:
                    calc.feed(event)
            except queue.Empty:
                pass

            if time.time() - last_snapshot >= self.SNAPSHOT_INTERVAL_SEC:
                snapshot = self._create_snapshot()
                self._sink.persist(snapshot)
                self._notify(snapshot)
                last_snapshot = time.time()

    # ----------------------------- Snapshotting ---------------------------- #

    def _create_snapshot(self) -> AnalyticsSnapshot:
        palette_metrics = []
        mood_metric: Optional[MoodMetric] = None
        hotspot_metrics = []

        for calc in self._calculators:
            res = calc.result()
            if isinstance(calc, PaletteMetricCalculator):
                palette_metrics = res
            elif isinstance(calc, MoodMetricCalculator):
                mood_metric = res
            elif isinstance(calc, HotspotMetricCalculator):
                hotspot_metrics = res

        # Guard against None for mood_metric
        mood_metric = mood_metric or MoodMetric(average_mood=0.0, sample_size=0)

        snapshot = AnalyticsSnapshot(
            generated_at=time.time(),
            palette_leaderboard=palette_metrics,
            mood_metric=mood_metric,
            hotspot_leaderboard=hotspot_metrics,
        )

        # Reset calculators for next window to keep rolling metrics fresh.
        for calc in self._calculators:
            calc.reset()

        logging.debug("Generated analytics snapshot: %s", snapshot)
        return snapshot


# --------------------------------------------------------------------------- #
#                        Creative Prompt Suggestion Engine                    #
# --------------------------------------------------------------------------- #


class PromptSuggestionEngine(Observer):
    """
    Consumes analytics snapshots and generates human-readable prompts.

    ViewModels can subscribe to this engine to surface suggestions in UI
    components (e.g., daily banner).
    """

    _MOOD_THRESHOLD_HAPPY = 0.4
    _MOOD_THRESHOLD_SAD = -0.4

    def __init__(self) -> None:
        self._latest_prompt: Optional[str] = None
        AnalyticsManager.get().subscribe(self)

    # --------------------------- Observer Hook ----------------------------- #

    def on_analytics_update(self, snapshot: AnalyticsSnapshot) -> None:
        try:
            self._latest_prompt = self._build_prompt(snapshot)
            logging.info("New creative prompt: %s", self._latest_prompt)
        except Exception as exc:  # pragma: no cover
            logging.exception("Failed to build prompt: %s", exc)

    # --------------------------- Prompt Builder ---------------------------- #

    @property
    def latest_prompt(self) -> Optional[str]:
        return self._latest_prompt

    def _build_prompt(self, snap: AnalyticsSnapshot) -> str:
        parts: List[str] = []

        # Palette suggestion
        if snap.palette_leaderboard:
            top_palette = snap.palette_leaderboard[0].palette
            palette_str = ", ".join(top_palette)
            parts.append(f"Try remixing with today's hot colors: {palette_str}.")

        # Mood suggestion
        if snap.mood_metric.sample_size > 10:  # ensure statistical meaning
            mood_score = snap.mood_metric.average_mood
            if mood_score >= self._MOOD_THRESHOLD_HAPPY:
                parts.append("The community vibe is upbeat! Capture something celebratory.")
            elif mood_score <= self._MOOD_THRESHOLD_SAD:
                parts.append("Feeling mellow? A reflective doodle might resonate today.")

        # Hotspot suggestion
        if snap.hotspot_leaderboard:
            lat, lon = snap.hotspot_leaderboard[0].location
            parts.append(f"Nearby creators are active around {lat:.1f},{lon:.1f}. Go explore!")

        # Fallback
        if not parts:
            parts.append("Start a new PrismCard and let your creativity shine!")

        return " ".join(parts)


# --------------------------------------------------------------------------- #
#                             Module-Level Setup                              #
# --------------------------------------------------------------------------- #

# Initialize singleton and prompt engine at import time for app-wide reuse.
_analytics_manager = AnalyticsManager.get()
_prompt_engine = PromptSuggestionEngine()

__all__ = [
    "AnalyticsManager",
    "PromptSuggestionEngine",
    "PaletteMetric",
    "MoodMetric",
    "HotspotMetric",
    "AnalyticsSnapshot",
    "PrismCard",
    "CardEvent",
    "EventType",
]
```