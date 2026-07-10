```python
"""
src/module_30.py
================

Color-centric analytics engine and suggestion subsystem for PrismPocket.

This module sits in the Domain/Service ring and is deliberately UI-agnostic.
It exposes an observable `AnalyticsEngine` singleton that streams palette
metrics and creative prompt suggestions whenever PrismCards enter or mutate
inside the Repository layer.

Patterns used
-------------
• Singleton (via metaclass)          – guarantees one analytics engine.
• Observer                           – engine emits events to interested VMs.
• Factory                            – `PromptFactory` builds dynamic prompts.
• Repository                         – `CardRepository` facade for persistence.

The implementation purposefully avoids any mobile or cloud SDK calls; those
concerns are handled by platform-specific adapters elsewhere in the code base.
"""

from __future__ import annotations

import colorsys
import itertools
import logging
import random
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from statistics import mean
from typing import Callable, Dict, Iterable, List, MutableSequence, Sequence, Set, Tuple

# ------------------------------------------------------------------------------
# Stub dependencies – actual implementations live in sibling modules
# ------------------------------------------------------------------------------

class CrashReporter:
    """Minimal crash reporter façade."""
    @staticmethod
    def report(exc: Exception, context: str | None = None) -> None:
        logging.error("CrashReporter – %s: %s", context or "unlabelled", exc, exc_info=True)


# ------------------------------------------------------------------------------
# Domain entities
# ------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class PrismCard:
    """Core domain entity representing a creative capture."""
    card_id: str
    user_id: str
    created_at: datetime
    rgb_pixels: Sequence[Tuple[int, int, int]]   # Raw pixel sample (down-scaled)
    mood_score: float | None = None              # Optional user-entered mood

    # Additional metadata fields live elsewhere.


@dataclass(slots=True)
class PaletteMetric:
    """Aggregated analytics for a single card."""
    card_id: str
    dominant_hex: str
    palette_hex: List[str]
    saturation: float
    lightness: float
    mood_score: float | None
    processed_at: datetime = field(default_factory=datetime.utcnow)


# ------------------------------------------------------------------------------
# Utility functions
# ------------------------------------------------------------------------------

def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def _hex_to_hsl(hex_color: str) -> Tuple[float, float, float]:
    """Convert HEX to HSL in range [0,1] for S and L."""
    hex_color = hex_color.lstrip("#")
    r, g, b = (int(hex_color[i : i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    # Convert H from 0..1 to degrees 0..360 for readability
    return h * 360, s, l


def _bucket_colors(pixels: Iterable[Tuple[int, int, int]], bucket_size: int = 16) -> Counter[Tuple[int, int, int]]:
    """
    Buckets colors to reduce noise.
    For example, bucket_size=16 means RGB components snap to nearest multiple of 16.
    """
    snap = lambda x: int(round(x / bucket_size) * bucket_size)
    buckets: Counter[Tuple[int, int, int]] = Counter()
    for r, g, b in pixels:
        buckets[(snap(r), snap(g), snap(b))] += 1
    return buckets


def extract_palette(pixels: Sequence[Tuple[int, int, int]], top_n: int = 5) -> List[str]:
    """
    Very light-weight palette extraction that avoids heavy ML libs.

    1. Quantise pixels into coarse buckets.
    2. Pick top N most common buckets.
    """
    buckets = _bucket_colors(pixels)
    most_common = buckets.most_common(top_n)
    return [_rgb_to_hex(rgb) for rgb, _ in most_common]


# ------------------------------------------------------------------------------
# Repository layer (simplified)
# ------------------------------------------------------------------------------

class CardRepository:
    """
    Naïve in-memory repository that would be swapped out via an adapter.
    Thread-safe for concurrent VM/worker access.
    """

    def __init__(self) -> None:
        self._cards: Dict[str, PrismCard] = {}
        self._lock = threading.RLock()

    def upsert(self, card: PrismCard) -> None:
        with self._lock:
            self._cards[card.card_id] = card

    def get_all(self) -> List[PrismCard]:
        with self._lock:
            return list(self._cards.values())

    def fetch(self, card_id: str) -> PrismCard | None:
        with self._lock:
            return self._cards.get(card_id)


# ------------------------------------------------------------------------------
# Observer pattern infra
# ------------------------------------------------------------------------------

Observer = Callable[[PaletteMetric], None]


class Observable:
    """
    Thread-safe observable mixin.
    """

    def __init__(self) -> None:
        self._observers: Set[Observer] = set()
        self._obs_lock = threading.RLock()

    def subscribe(self, observer: Observer) -> None:
        with self._obs_lock:
            self._observers.add(observer)

    def unsubscribe(self, observer: Observer) -> None:
        with self._obs_lock:
            self._observers.discard(observer)

    def _notify(self, metric: PaletteMetric) -> None:
        with self._obs_lock:
            for observer in self._observers.copy():
                try:
                    observer(metric)
                except Exception as exc:  # pragma: no cover
                    CrashReporter.report(exc, context="Observer callback failed")


# ------------------------------------------------------------------------------
# Singleton metaclass
# ------------------------------------------------------------------------------

class _SingletonMeta(type):
    _instances: Dict[type, "AnalyticsEngine"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# ------------------------------------------------------------------------------
# Analytics engine
# ------------------------------------------------------------------------------

class AnalyticsEngine(Observable, metaclass=_SingletonMeta):
    """
    Central analytics engine. Acts as a background worker that processes cards,
    emits `PaletteMetric` events, and maintains running aggregates that can be
    queried by ViewModels (e.g., trend screens).
    """

    def __init__(self, repository: CardRepository | None = None) -> None:
        Observable.__init__(self)
        self._repo: CardRepository = repository or CardRepository()
        self._aggregated_palette_count: Counter[str] = Counter()
        self._mood_scores: List[float] = []
        self._running = False
        self._thread: threading.Thread | None = None
        self._sleep_interval_sec = 2.0

    # ---- public API --------------------------------------------------------

    def attach_repository(self, repo: CardRepository) -> None:
        self._repo = repo

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, name="AnalyticsEngine", daemon=True)
        self._thread.start()
        logging.info("AnalyticsEngine started")

    def stop(self) -> None:
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)

    def trending_palette(self, top_n: int = 3) -> List[str]:
        """Return the hex codes of the most encountered colors across all cards."""
        return [color for color, _ in self._aggregated_palette_count.most_common(top_n)]

    def average_mood(self) -> float | None:
        """Return global mood average if available."""
        return mean(self._mood_scores) if self._mood_scores else None

    # ---- internal ----------------------------------------------------------

    def _run_loop(self) -> None:
        processed: Set[str] = set()
        while self._running:
            try:
                new_cards = [c for c in self._repo.get_all() if c.card_id not in processed]
                for card in new_cards:
                    metric = self._process_card(card)
                    processed.add(card.card_id)
                    self._notify(metric)
            except Exception as exc:  # pragma: no cover
                CrashReporter.report(exc, context="AnalyticsEngine loop")
            time.sleep(self._sleep_interval_sec)

    def _process_card(self, card: PrismCard) -> PaletteMetric:
        palette = extract_palette(card.rgb_pixels)
        dominant = palette[0] if palette else "#000000"

        # Update aggregates
        self._aggregated_palette_count.update(palette)
        if card.mood_score is not None:
            self._mood_scores.append(card.mood_score)

        # Compute avg saturation/lightness for descriptor strings
        hsl_values = [_hex_to_hsl(hex_color) for hex_color in palette]
        saturation = mean(s for _, s, _ in hsl_values) if hsl_values else 0
        lightness = mean(l for _, _, l in hsl_values) if hsl_values else 0

        metric = PaletteMetric(
            card_id=card.card_id,
            dominant_hex=dominant,
            palette_hex=palette,
            saturation=saturation,
            lightness=lightness,
            mood_score=card.mood_score,
        )
        logging.debug("AnalyticsEngine metric produced: %s", metric)
        return metric


# ------------------------------------------------------------------------------
# Creative Prompt Factory
# ------------------------------------------------------------------------------

class PromptFactory:
    """
    Generates contextual creative prompts derived from analytics data.
    Example usages include: ViewModels asking for 'next prompt' or suggestions
    for social challenge cards.
    """

    _adjectives = [
        "dreamy",
        "vivid",
        "bold",
        "nostalgic",
        "whimsical",
        "soothing",
        "electric",
        "sun-kissed",
    ]

    _subjects = [
        "cityscape",
        "portrait",
        "memory lane",
        "quiet morning",
        "night sky",
        "hidden pattern",
        "reflections",
        "tiny moment",
    ]

    def __init__(self, engine: AnalyticsEngine | None = None) -> None:
        self._engine = engine or AnalyticsEngine()

    def next_prompt(self) -> str:
        """
        Craft a prompt informed by trending palette and global mood.
        Example: "Capture a dreamy night sky with shades of #FF5733 and #FFC300"
        """
        trending = self._engine.trending_palette()
        mood_avg = self._engine.average_mood()

        adjective = random.choice(self._adjectives)
        subject = random.choice(self._subjects)

        if mood_avg is not None:
            adjective = self._mood_to_adjective(mood_avg, adjective)

        palette_snippet = " & ".join(trending[:2]) if trending else "your favorite hues"
        prompt = f"Capture a {adjective} {subject} with shades of {palette_snippet}"
        logging.debug("PromptFactory produced prompt: %s", prompt)
        return prompt

    # ----------------------------------------------------------------------

    @staticmethod
    def _mood_to_adjective(mood_score: float, fallback: str) -> str:
        if mood_score > 0.7:
            return "uplifting"
        if mood_score < 0.3:
            return "moody"
        return fallback


# ------------------------------------------------------------------------------
# Example usage (would normally live in unit tests or other modules)
# ------------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO)

    # Build repository and seed with fake cards
    repo = CardRepository()
    for i in range(10):
        pixels = [
            (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255))
            for _ in range(250)
        ]
        card = PrismCard(
            card_id=f"CARD-{i}",
            user_id="user_demo",
            created_at=datetime.utcnow(),
            rgb_pixels=pixels,
            mood_score=random.random(),
        )
        repo.upsert(card)

    # Spin up the analytics engine
    engine = AnalyticsEngine()
    engine.attach_repository(repo)
    engine.start()

    # Subscribe to live metrics
    def on_metric(metric: PaletteMetric) -> None:
        logging.info("Observer got metric for %s with dominant %s", metric.card_id, metric.dominant_hex)

    engine.subscribe(on_metric)

    # Wait for processing then build a prompt
    time.sleep(4)
    prompt_factory = PromptFactory(engine)
    print(prompt_factory.next_prompt())

    engine.stop()
```