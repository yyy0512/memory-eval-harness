```python
"""
src/module_59.py

PrismPocket – Analytics & Prompt Generation Core
================================================

This module encapsulates the real-time analytics engine that powers data-driven
creative prompts inside PrismPocket.  It implements:

1. AnalyticsEngine (Singleton + Observer) – Streams card events, aggregates
   metrics, and notifies interested observers (e.g., view-models, cloud sync)
2. PaletteMetric – Dataclass capturing color-usage statistics
3. LocationMetric – Dataclass capturing geospatial hotspots
4. MoodMetric – Dataclass capturing text / sentiment trends
5. PromptFactory – Generates on-the-fly artistic prompts from latest metrics

While the wider project provides concrete entities (PrismCard, Palette,
Location, etc.) and an event bus, this module purposefully remains *pure* and
unit-testable.  Platform-specific adapters inject card events via the public
`AnalyticsEngine.ingest_card()` API.

Design patterns showcased:
    • Singleton            – Guarantees a single analytics engine instance
    • Observer             – Allows observers to react to metric updates
    • Factory              – Decouples prompt generation logic
    • Repository (minimal) – Abstracts persistence of historic metrics

Author: PrismPocket Core Team
License: MIT
"""

from __future__ import annotations

import colorsys
import random
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import islice
from typing import Callable, Deque, Dict, List, Protocol, Tuple

###############################################################################
# Type aliases & Protocols
###############################################################################

HexColor = str  # e.g. "#ff5733"


class PrismCard(Protocol):
    """
    Minimal PrismCard interface required by this module.  The concrete
    implementation lives in the `domain` package.
    """

    id: str
    created_at: datetime
    colors: List[HexColor]           # Extracted dominant colors
    latitude: float | None
    longitude: float | None
    text: str | None                 # Raw text (for sentiment & tags)
    mood_score: float | None         # Range [-1, 1]

    # The real class exposes far more, but we only need these attributes.


class MetricRepository(Protocol):
    """
    Gateway for persisting analytics snapshots.  Concrete implementation may
    write to SQLite, Realm, or remote Firestore.
    """

    def save_palette_metric(self, metric: "PaletteMetric") -> None:
        ...

    def save_location_metric(self, metric: "LocationMetric") -> None:
        ...

    def save_mood_metric(self, metric: "MoodMetric") -> None:
        ...


Observer = Callable[["AnalyticsSnapshot"], None]

###############################################################################
# Data classes
###############################################################################


@dataclass(slots=True)
class PaletteMetric:
    dominant_color: HexColor
    count: int
    generated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True)
class LocationMetric:
    lat: float
    lon: float
    count: int
    generated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True)
class MoodMetric:
    average_mood: float
    sample_size: int
    generated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(slots=True)
class AnalyticsSnapshot:
    palette: List[PaletteMetric]
    locations: List[LocationMetric]
    mood: MoodMetric | None
    generated_at: datetime = field(default_factory=datetime.utcnow)


###############################################################################
# Singleton Meta
###############################################################################


class _SingletonMeta(type):
    """Thread-safe Singleton metaclass."""

    _instances: Dict[type, "AnalyticsEngine"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


###############################################################################
# Analytics Engine
###############################################################################


class AnalyticsEngine(metaclass=_SingletonMeta):
    """
    Orchestrates metric aggregation. Consumers should retrieve the global
    instance via `AnalyticsEngine()` (same as calling a constructor).
    """

    # Defaults for sliding-window analysis
    _WINDOW: timedelta = timedelta(hours=6)
    _MAX_QUEUE: int = 10_000

    def __init__(self) -> None:
        self._cards: Deque[PrismCard] = deque(maxlen=self._MAX_QUEUE)
        self._observers: List[Observer] = []
        self._repo: MetricRepository | None = None
        self._lock = threading.RLock()
        self._dispatcher_thread = threading.Thread(
            target=self._dispatch_loop, name="analytics-dispatcher", daemon=True
        )
        self._dispatch_event = threading.Event()
        self._stop_event = threading.Event()
        self._dispatcher_thread.start()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def configure_repository(self, repo: MetricRepository) -> None:
        """Inject a concrete repository for persistence (optional)."""
        self._repo = repo

    def ingest_card(self, card: PrismCard) -> None:
        """
        Accept a PrismCard for analysis.  Non-blocking; heavy processing is
        delegated to background thread.
        """
        with self._lock:
            self._cards.append(card)
            # Wake dispatcher
            self._dispatch_event.set()

    def register(self, observer: Observer) -> None:
        """Subscribe to metric snapshot updates."""
        with self._lock:
            self._observers.append(observer)

    def unregister(self, observer: Observer) -> None:
        """Unsubscribe from metric snapshot updates."""
        with self._lock:
            try:
                self._observers.remove(observer)
            except ValueError:
                pass

    def shutdown(self) -> None:
        """Gracefully terminate background dispatcher."""
        self._stop_event.set()
        self._dispatch_event.set()
        self._dispatcher_thread.join(timeout=5)

    # --------------------------------------------------------------------- #
    # Internal
    # --------------------------------------------------------------------- #

    def _dispatch_loop(self) -> None:
        """
        Runs in dedicated thread, debouncing heavy aggregation work to avoid
        main-thread jank.  Processes queue whenever _dispatch_event is set,
        but no more frequently than every 2 seconds.
        """
        MIN_INTERVAL = 2.0  # seconds
        last_processed: float = 0.0

        while not self._stop_event.is_set():
            self._dispatch_event.wait(timeout=1)
            now = time.time()

            if now - last_processed < MIN_INTERVAL:
                continue  # debounce

            self._dispatch_event.clear()
            snapshot = self._compute_snapshot()
            if snapshot is not None:
                self._notify_observers(snapshot)
            last_processed = now

    def _compute_snapshot(self) -> AnalyticsSnapshot | None:
        """Compute metrics for cards within sliding analysis window."""
        cutoff = datetime.utcnow() - self._WINDOW

        with self._lock:
            # Remove stale cards
            while self._cards and self._cards[0].created_at < cutoff:
                self._cards.popleft()

            if not self._cards:
                return None  # Nothing to report

            # Palette analysis
            color_counter: Counter[HexColor] = Counter(
                color.lower()
                for card in self._cards
                for color in (card.colors or [])
                if color
            )

            palette_metrics = [
                PaletteMetric(dominant_color=c, count=n)
                for c, n in color_counter.most_common(5)
            ]

            # Location analysis
            loc_counter: Counter[Tuple[float, float]] = Counter(
                (
                    round(card.latitude or 0.0, 3),
                    round(card.longitude or 0.0, 3),
                )
                for card in self._cards
                if card.latitude is not None and card.longitude is not None
            )

            location_metrics = [
                LocationMetric(lat=lat, lon=lon, count=n)
                for (lat, lon), n in loc_counter.most_common(5)
            ]

            # Mood analysis
            mood_scores = [card.mood_score for card in self._cards if card.mood_score is not None]
            mood_metric: MoodMetric | None = None
            if mood_scores:
                average_mood = sum(mood_scores) / len(mood_scores)
                mood_metric = MoodMetric(average_mood=average_mood, sample_size=len(mood_scores))

            snapshot = AnalyticsSnapshot(
                palette=palette_metrics,
                locations=location_metrics,
                mood=mood_metric,
            )

        # Persistence (fire and forget)
        self._persist_snapshot(snapshot)
        return snapshot

    def _persist_snapshot(self, snapshot: AnalyticsSnapshot) -> None:
        """Persist metrics for future offline or cloud use."""
        if not self._repo:
            return
        try:
            for pm in snapshot.palette:
                self._repo.save_palette_metric(pm)
            for lm in snapshot.locations:
                self._repo.save_location_metric(lm)
            if snapshot.mood:
                self._repo.save_mood_metric(snapshot.mood)
        except Exception as exc:  # noqa: BLE001
            # Fail-closed: log and continue (logger configured globally)
            import logging

            logging.getLogger(__name__).exception("Failed to persist snapshot: %s", exc)

    def _notify_observers(self, snapshot: AnalyticsSnapshot) -> None:
        """Invoke callbacks safely."""
        with self._lock:
            observers = list(self._observers)

        for observer in observers:
            try:
                observer(snapshot)
            except Exception as exc:  # noqa: BLE001
                import logging

                logging.getLogger(__name__).warning("Observer error: %s", exc)


###############################################################################
# Prompt Factory
###############################################################################


class PromptFactory:
    """
    High-level factory that translates analytics snapshots into short creative
    prompts.  Stateless by design; callers pass in metrics directly.
    """

    _COLOR_TEMPLATES = [
        "Explore the warmth of {color} in your next card.",
        "Try blending {color} with contrasting hues!",
        "Let {color} be the hero shade of your story.",
    ]

    _LOCATION_TEMPLATES = [
        "Looks like {city} is trending—capture its vibes.",
        "Bring the spirit of {city} into a new prism card.",
        "Show us a fresh angle from {city}.",
    ]

    _MOOD_TEMPLATES = [
        "Channel this {mood} energy into a visual burst!",
        "Your cards feel {mood}. Keep the flow going.",
        "Contrast the current {mood} streak with a twist.",
    ]

    @classmethod
    def generate_prompt(cls, snapshot: AnalyticsSnapshot) -> str:
        """
        Generate a single human-readable prompt based on priority:
        mood > palette > location.  Falls back to a generic suggestion.
        """
        if snapshot.mood and snapshot.mood.sample_size >= 5:
            mood_word = cls._mood_word(snapshot.mood.average_mood)
            template = random.choice(cls._MOOD_TEMPLATES)
            return template.format(mood=mood_word)

        if snapshot.palette:
            color_hex = snapshot.palette[0].dominant_color
            color_name = cls._hex_to_simple_name(color_hex)
            template = random.choice(cls._COLOR_TEMPLATES)
            return template.format(color=color_name)

        if snapshot.locations:
            lat, lon = snapshot.locations[0].lat, snapshot.locations[0].lon
            city = cls._reverse_geocode(lat, lon)
            template = random.choice(cls._LOCATION_TEMPLATES)
            return template.format(city=city)

        return "Capture something new to keep the creative spark alive!"

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _mood_word(score: float) -> str:
        if score > 0.5:
            return "upbeat"
        if score > 0.1:
            return "positive"
        if score >= -0.1:
            return "balanced"
        if score >= -0.5:
            return "pensive"
        return "melancholic"

    @staticmethod
    def _hex_to_simple_name(hex_color: HexColor) -> str:
        """
        Converts a dominant hex color into a human-friendly name by converting
        to HLS and mapping hue to a coarse bucket.
        """
        hex_color = hex_color.lstrip("#")
        if len(hex_color) != 6:
            return "color"

        r, g, b = (int(hex_color[i : i + 2], 16) / 255 for i in (0, 2, 4))
        h, l, s = colorsys.rgb_to_hls(r, g, b)

        hue_deg = h * 360
        if s < 0.1:
            return "gray"
        match hue_deg:
            case deg if deg < 15 or deg >= 345:
                return "red"
            case deg if deg < 45:
                return "orange"
            case deg if deg < 75:
                return "yellow"
            case deg if deg < 150:
                return "green"
            case deg if deg < 210:
                return "cyan"
            case deg if deg < 270:
                return "blue"
            case deg if deg < 330:
                return "purple"
            case _:
                return "color"

    @staticmethod
    def _reverse_geocode(lat: float, lon: float) -> str:
        """
        Lightweight reverse-geocode stub.  Real implementation would hit a
        geocoding service or use offline maps.  We bucket lat/lon to a
        pseudo-city name for demonstration.
        """
        # Simple quadrant names (for demo)
        if lat >= 0 and lon >= 0:
            return "North-East Hub"
        if lat >= 0 and lon < 0:
            return "North-West Hub"
        if lat < 0 and lon >= 0:
            return "South-East Hub"
        return "South-West Hub"


###############################################################################
# Quick demo / self-test (executed only when run directly)
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    import logging
    from random import randint

    logging.basicConfig(level=logging.INFO)

    # --- Mock implementations ------------------------------------------------ #

    class InMemoryRepo:  # noqa: D101
        def __init__(self) -> None:
            self.palette: List[PaletteMetric] = []
            self.locations: List[LocationMetric] = []
            self.moods: List[MoodMetric] = []

        def save_palette_metric(self, metric: PaletteMetric) -> None:
            self.palette.append(metric)

        def save_location_metric(self, metric: LocationMetric) -> None:
            self.locations.append(metric)

        def save_mood_metric(self, metric: MoodMetric) -> None:
            self.moods.append(metric)

    class MockCard:  # noqa: D101
        def __init__(
            self,
            colors: List[HexColor],
            lat: float | None,
            lon: float | None,
            mood: float | None,
        ) -> None:
            self.id = f"card-{randint(1000, 9999)}"
            self.created_at = datetime.utcnow()
            self.colors = colors
            self.latitude = lat
            self.longitude = lon
            self.text = None
            self.mood_score = mood

    # --- Setup engine -------------------------------------------------------- #

    engine = AnalyticsEngine()
    engine.configure_repository(InMemoryRepo())

    def observer(snapshot: AnalyticsSnapshot) -> None:  # noqa: D401
        prompt = PromptFactory.generate_prompt(snapshot)
        logging.info("New prompt: %s", prompt)

    engine.register(observer)

    # --- Feed mock data ------------------------------------------------------ #
    for _i in range(30):
        card = MockCard(
            colors=[f"#{randint(0, 0xFFFFFF):06x}" for _ in range(3)],
            lat=random.choice([37.7749, -33.8688, None]),
            lon=random.choice([-122.4194, 151.2093, None]),
            mood=random.choice([0.8, -0.2, 0.1, None]),
        )
        engine.ingest_card(card)
        time.sleep(0.1)

    # Allow background thread to flush
    time.sleep(3)
    engine.shutdown()
```