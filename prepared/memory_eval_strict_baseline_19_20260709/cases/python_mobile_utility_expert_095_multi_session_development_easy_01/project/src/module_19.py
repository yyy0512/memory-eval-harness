```python
"""
src/module_19.py

Palette analytics & trend-surfacing engine for PrismPocket.

This module lives in the Domain layer (pure Python, no framework /
platform concerns).  It leverages a thread-safe Observer bus to emit
PaletteMetric events that may be consumed by higher-level View-Models
or the cloud sync worker.

The implementation purposefully avoids UI & persistence dependencies
so that it can be unit-tested in isolation.
"""

from __future__ import annotations

import colorsys
import itertools
import logging
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Deque, List, MutableMapping, Tuple
from uuid import uuid4
import weakref

# --------------------------------------------------------------------------- #
# Fallback / forward declarations
# --------------------------------------------------------------------------- #

try:
    # Try the *real* domain entity first.
    from domain.models import PrismCard  # type: ignore
except (ImportError, ModuleNotFoundError):
    # Fall back to a lightweight stub so this module remains importable
    @dataclass(slots=True, frozen=True)
    class PrismCard:  # pragma: no cover
        """
        Extremely thin stub that mirrors the public interface of the actual
        domain.models.PrismCard class.  It should only be used when running
        unit tests for this module in isolation.
        """

        id: str
        palette: List[str]  # Hex color strings (e.g. "#FF0000")
        created_at: datetime = datetime.utcnow()


# --------------------------------------------------------------------------- #
# Public dataclasses
# --------------------------------------------------------------------------- #

@dataclass(slots=True, frozen=True)
class PaletteMetric:
    """
    Aggregate analytics point produced whenever the PaletteMetricAnalyzer
    determines that color trends have shifted meaningfully.
    """

    metric_id: str
    generated_at: datetime
    top_palette: Tuple[str, ...]  # Most frequently used colors (hex)
    diversity_score: float        # 0.0 – 1.0, higher == more unique colors
    mood_score: float             # –1.0 (“dark”) → 1.0 (“bright”)

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric_id": self.metric_id,
            "generated_at": self.generated_at.isoformat(),
            "top_palette": list(self.top_palette),
            "diversity_score": self.diversity_score,
            "mood_score": self.mood_score,
        }


# --------------------------------------------------------------------------- #
# Observer / Event-bus implementation
# --------------------------------------------------------------------------- #

_Observer = Callable[[PaletteMetric], None]


class _ObservableBus:
    """
    Minimal, thread-safe observer bus.  Observers are stored as weak
    references so they do **not** prolong the lifetime of subscribers.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._observers: "weakref.WeakSet[_Observer]" = weakref.WeakSet()

    def subscribe(self, fn: _Observer) -> None:
        with self._lock:
            self._observers.add(fn)
            logging.debug("Observer %s subscribed", fn)

    def unsubscribe(self, fn: _Observer) -> None:
        with self._lock:
            self._observers.discard(fn)
            logging.debug("Observer %s unsubscribed", fn)

    def notify(self, metric: PaletteMetric) -> None:
        with self._lock:
            # Copy to safeguard against mutations during iteration.
            observers = list(self._observers)
        for fn in observers:
            try:
                fn(metric)
            except Exception:
                logging.exception("Observer %s failed while handling metric %s", fn, metric.metric_id)


# --------------------------------------------------------------------------- #
# Singleton metaclass
# --------------------------------------------------------------------------- #

class _SingletonMeta(type):
    _instances: MutableMapping[type, "PaletteMetricAnalyzer"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # noqa: D401 (single-line docstring)
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# Core analytics engine
# --------------------------------------------------------------------------- #

class PaletteMetricAnalyzer(metaclass=_SingletonMeta):
    """
    Consumes a stream of PrismCard entities and produces PaletteMetric
    snapshots whenever a   configurable threshold is crossed.
    """

    WINDOW = timedelta(hours=24)   # Only analyze cards from the last N hours
    SAMPLE_SIZE = 200             # Minimum cards required to produce metric
    TOP_K = 8                     # Number of top colors surfaced

    def __init__(self) -> None:
        self._recent_cards: Deque[PrismCard] = deque()
        self._event_bus = _ObservableBus()
        self._lock = threading.RLock()
        self._last_generated_at: datetime | None = None

        logging.debug("%s initialised", self.__class__.__name__)

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def ingest(self, card: PrismCard) -> None:
        """
        Thread-safe entry-point called by the Repository whenever a new
        PrismCard is persisted locally or received from the cloud.
        """
        if not card.palette:
            return  # Nothing to analyze

        with self._lock:
            self._recent_cards.append(card)
            self._purge_outdated()

            logging.debug("Ingested PrismCard %s (%d colors). Recent queue=%d",
                          card.id, len(card.palette), len(self._recent_cards))

            if self._is_ready():
                metric = self._generate_metric()
                self._event_bus.notify(metric)

    def subscribe(self, fn: _Observer) -> None:
        """Receive PaletteMetric updates."""
        self._event_bus.subscribe(fn)

    def unsubscribe(self, fn: _Observer) -> None:
        self._event_bus.unsubscribe(fn)

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _purge_outdated(self) -> None:
        threshold = datetime.utcnow() - self.WINDOW
        while self._recent_cards and self._recent_cards[0].created_at < threshold:
            removed = self._recent_cards.popleft()
            logging.debug("Purged outdated PrismCard %s (created_at=%s)", removed.id, removed.created_at)

    def _is_ready(self) -> bool:
        """
        Returns True if we have gathered enough data and at least
        ten minutes have elapsed since the last metric.
        """
        if len(self._recent_cards) < self.SAMPLE_SIZE:
            return False

        if self._last_generated_at is None:
            return True

        return (datetime.utcnow() - self._last_generated_at) > timedelta(minutes=10)

    # ------------------------------------------------------------------ #
    # Metric computation
    # ------------------------------------------------------------------ #

    def _generate_metric(self) -> PaletteMetric:
        """
        Compute diversity & mood metrics from the current sliding window
        of PrismCards.  This method must ONLY be executed while holding
        self._lock.
        """
        assert self._recent_cards  # nosec

        # Flatten all palettes into a single counter
        color_counter: Counter[str] = Counter(
            c.lower()
            for card in self._recent_cards
            for c in card.palette
        )
        logging.debug("Color counter generated with %d unique entries", len(color_counter))

        # Top palette colors
        top_palette = tuple(color for color, _ in color_counter.most_common(self.TOP_K))

        diversity_score = self._calc_diversity(color_counter)
        mood_score = self._calc_mood(color_counter)

        metric = PaletteMetric(
            metric_id=str(uuid4()),
            generated_at=datetime.utcnow(),
            top_palette=top_palette,
            diversity_score=diversity_score,
            mood_score=mood_score,
        )

        self._last_generated_at = metric.generated_at

        logging.info("Generated PaletteMetric %s: %s", metric.metric_id, metric.to_dict())
        return metric

    @staticmethod
    def _calc_diversity(counter: Counter[str]) -> float:
        """
        Shannon entropy normalized to [0,1].
        """
        if not counter:
            return 0.0

        total = sum(counter.values())
        entropy = -sum((n / total) * _safe_log2(n / total) for n in counter.values())
        max_entropy = _safe_log2(len(counter))
        return entropy / max_entropy if max_entropy else 0.0

    @staticmethod
    def _calc_mood(counter: Counter[str]) -> float:
        """
        Heuristic “mood” score biased toward brightness.

        Returns:
            –1.0 (dark/desaturated) → 1.0 (bright/vibrant)
        """
        if not counter:
            return 0.0

        weighted_sum = 0.0
        total = sum(counter.values())

        for hex_color, freq in counter.items():
            r, g, b = _hex_to_rgb(hex_color)
            _, _, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
            weighted_sum += v * freq

        return (weighted_sum / total) * 2 - 1  # Normalize to [-1, 1]


# --------------------------------------------------------------------------- #
# Utility helpers
# --------------------------------------------------------------------------- #

def _safe_log2(x: float) -> float:
    import math
    return math.log2(x) if x > 0 else 0.0


_HEX_CACHE: dict[str, Tuple[int, int, int]] = {}
_HEX_LOCK = threading.Lock()


def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """
    Convert #RRGGBB color to an (r, g, b) tuple. Values are cached because the
    same colors appear frequently across different cards.
    """
    hex_color = hex_color.lstrip("#").lower()
    with _HEX_LOCK:
        if hex_color in _HEX_CACHE:
            return _HEX_CACHE[hex_color]

        if len(hex_color) != 6 or not all(c in "0123456789abcdef" for c in hex_color):
            raise ValueError(f"Invalid HEX color: {hex_color!r}")

        rgb = tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))  # noqa: E203
        _HEX_CACHE[hex_color] = rgb
        return rgb


# --------------------------------------------------------------------------- #
# Example usage (can be deleted in production)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG, style="{", format="{levelname:8s} | {message}")

    analyzer = PaletteMetricAnalyzer()

    def printer(metric: PaletteMetric) -> None:
        print("==> New metric:", metric.to_dict())

    analyzer.subscribe(printer)

    # Generate synthetic cards for a quick demo
    import random

    COLORS = ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
              "#111111", "#222222", "#aaaaaa", "#bbbbbb", "#cccccc"]

    for _ in range(PaletteMetricAnalyzer.SAMPLE_SIZE + 5):
        card = PrismCard(
            id=str(uuid4()),
            palette=random.sample(COLORS, k=random.randint(1, 5)),
            created_at=datetime.utcnow() - timedelta(minutes=random.randint(0, 60 * 23)),
        )
        analyzer.ingest(card)
        time.sleep(0.01)  # Simulate staggered ingestion
```