```python
"""
PrismPocket – Trend Analytics Module
====================================

File:        src/module_34.py
Description: Provides real-time creative-trend analytics for PrismPocket.
             The module consumes PrismCard entities emitted by repositories
             and produces an AnalyticsReport object that is dispatched to
             subscribers via a lightweight Observer bus.

Key Features
------------
• Dominant colour-palette extraction (with LRU-cached Pillow helper)
• Geo-hotspot clustering with adjustable precision
• Heuristic mood-score derivation from text metadata
• Concurrent analytics pipeline (ThreadPoolExecutor)
• Singleton service façade + Observable pattern for decoupled delivery
"""

from __future__ import annotations

import logging
import math
import os
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

try:
    from PIL import Image  # Pillow (optional hard dependency)
except ModuleNotFoundError:  # pragma: no cover
    Image = None  # type: ignore

# ──────────────────────────────────────────────────────────────────────────────
# Logging configuration
# ──────────────────────────────────────────────────────────────────────────────
logger = logging.getLogger(__name__)
_logger_handler = logging.StreamHandler()
_logger_handler.setFormatter(logging.Formatter("%(levelname)s - %(name)s: %(message)s"))
logger.addHandler(_logger_handler)
logger.setLevel(logging.INFO)

# ──────────────────────────────────────────────────────────────────────────────
# Data Contracts
# ──────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GeoPoint:
    latitude: float
    longitude: float

    def rounded(self, precision: int = 2) -> "GeoPoint":
        """Round coordinates for coarse clustering."""
        return GeoPoint(
            latitude=round(self.latitude, precision),
            longitude=round(self.longitude, precision),
        )


@dataclass(frozen=True)
class PrismCard:
    """
    Reduced representation of the Domain entity.
    In production this would be imported from `prism.domain.entities`.
    """

    id: str
    file_path: Optional[str] = None  # Path to image / audio, etc.
    text: Optional[str] = None
    location: Optional[GeoPoint] = None
    mood_hint: Optional[float] = None  # Pre-computed on device (-1 … 1)


@dataclass
class PaletteMetric:
    palette: Tuple[str, ...]  # Hex colours
    usage_count: int = 0


@dataclass
class AnalyticsReport:
    palette_metrics: List[PaletteMetric] = field(default_factory=list)
    hotspots: Dict[GeoPoint, int] = field(default_factory=dict)
    mood_score: float = 0.0


# ──────────────────────────────────────────────────────────────────────────────
# Observable Event Bus
# ──────────────────────────────────────────────────────────────────────────────


class _EventBus:
    """
    Thread-safe, ultra-light Observable implementation.
    Subscribers receive AnalyticsReport instances.
    """

    def __init__(self) -> None:
        self._subscribers: MutableMapping[int, Callable[[AnalyticsReport], None]] = {}
        self._lock = threading.RLock()

    def subscribe(self, callback: Callable[[AnalyticsReport], None]) -> int:
        """
        Register a callback. Returns a token for later unsubscription.
        """
        token = id(callback)
        with self._lock:
            self._subscribers[token] = callback
            logger.debug("Subscriber %s registered.", token)
        return token

    def unsubscribe(self, token: int) -> None:
        with self._lock:
            self._subscribers.pop(token, None)
            logger.debug("Subscriber %s removed.", token)

    def publish(self, report: AnalyticsReport) -> None:
        with self._lock:
            subscribers = list(self._subscribers.values())
        logger.debug("Publishing report to %d subscribers.", len(subscribers))
        for callback in subscribers:
            try:
                callback(report)
            except Exception:  # pragma: no cover
                logger.exception("Subscriber callback failed.")


# ──────────────────────────────────────────────────────────────────────────────
# Singleton MetaClass
# ──────────────────────────────────────────────────────────────────────────────


class _Singleton(type):
    _instances: Dict[type, object] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# ──────────────────────────────────────────────────────────────────────────────
# Trend Analytics Service
# ──────────────────────────────────────────────────────────────────────────────


class TrendAnalyticsService(metaclass=_Singleton):
    """
    Facade for PrismPocket analytics.

    Usage
    -----
    service = TrendAnalyticsService()
    token = service.event_bus.subscribe(lambda report: ...)
    service.process_async(cards)
    """

    _MAX_WORKERS = 4

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=self._MAX_WORKERS, thread_name_prefix="analytics")
        self._event_bus = _EventBus()

    # ----------------------------------------------------------------------
    # Public API
    # ----------------------------------------------------------------------

    @property
    def event_bus(self) -> _EventBus:
        return self._event_bus

    def process_async(self, cards: Sequence[PrismCard]) -> Future[AnalyticsReport]:
        """
        Submit an asynchronous analytics job.

        Returns a Future that resolves to AnalyticsReport.
        Listeners registered with `event_bus` will receive the report too.
        """
        logger.info("Submitting analytics job for %d cards.", len(cards))
        future = self._executor.submit(self._process_internal, list(cards))
        future.add_done_callback(self._publish_callback)
        return future

    # ----------------------------------------------------------------------
    # Internal
    # ----------------------------------------------------------------------

    @staticmethod
    def _publish_callback(fut: Future[AnalyticsReport]) -> None:
        try:
            report = fut.result()
        except Exception:  # pragma: no cover
            logger.exception("Analytics job failed.")
            return
        service = TrendAnalyticsService()
        service.event_bus.publish(report)

    @classmethod
    def _process_internal(cls, cards: List[PrismCard]) -> AnalyticsReport:
        logger.debug("Starting synchronous analytics pipeline.")
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                "palette": executor.submit(cls._analyse_palette, cards),
                "hotspots": executor.submit(cls._analyse_hotspots, cards),
                "mood": executor.submit(cls._analyse_mood, cards),
            }
            report = AnalyticsReport()
            report.palette_metrics = futures["palette"].result()
            report.hotspots = futures["hotspots"].result()
            report.mood_score = futures["mood"].result()

        logger.info(
            "Analytics pipeline completed: %d palettes, %d hotspots, mood=%0.3f",
            len(report.palette_metrics),
            len(report.hotspots),
            report.mood_score,
        )
        return report

    # ----------------------------------------------------------------------
    # Analytics helpers
    # ----------------------------------------------------------------------

    @staticmethod
    def _analyse_palette(cards: Sequence[PrismCard], top_n: int = 5) -> List[PaletteMetric]:
        if Image is None:
            logger.warning("Pillow not available; skipping palette analysis.")
            return []

        colour_counter: Counter[Tuple[str, ...]] = Counter()
        for card in cards:
            if card.file_path and os.path.isfile(card.file_path):
                try:
                    palette = _extract_palette_cached(card.file_path)
                    colour_counter[palette] += 1
                except Exception:  # pragma: no cover
                    logger.debug("Palette extraction failed for %s", card.file_path, exc_info=True)
        common = colour_counter.most_common(top_n)
        metrics = [PaletteMetric(palette=p, usage_count=c) for p, c in common]
        logger.debug("Palette analysis found %d unique palettes.", len(colour_counter))
        return metrics

    @staticmethod
    def _analyse_hotspots(cards: Sequence[PrismCard], precision: int = 2) -> Dict[GeoPoint, int]:
        hotspot_map: Dict[GeoPoint, int] = defaultdict(int)
        for card in cards:
            if card.location:
                rounded = card.location.rounded(precision=precision)
                hotspot_map[rounded] += 1
        logger.debug("Hotspot analysis produced %d clusters.", len(hotspot_map))
        return dict(hotspot_map)

    @staticmethod
    def _analyse_mood(cards: Sequence[PrismCard]) -> float:
        scores: List[float] = []
        for card in cards:
            if card.mood_hint is not None:
                scores.append(card.mood_hint)
            elif card.text:
                scores.append(_heuristic_sentiment(card.text))
        if not scores:
            logger.debug("No mood data available.")
            return 0.0

        # Weighted average with simple logistic scaling
        raw_avg = sum(scores) / len(scores)
        mood_score = 1 / (1 + math.exp(-raw_avg)) * 2 - 1  # Map to [-1, 1]
        logger.debug("Mood analysis generated score=%0.3f from %d items.", mood_score, len(scores))
        return mood_score


# ──────────────────────────────────────────────────────────────────────────────
# Utility Functions
# ──────────────────────────────────────────────────────────────────────────────


@lru_cache(maxsize=512)
def _extract_palette_cached(file_path: str, k: int = 5) -> Tuple[str, ...]:
    """
    Return dominant palette as tuple of hex colour strings.

    The implementation uses Pillow’s `getcolors` then k-means fallback.
    Results are cached to avoid redundant disk I/O.
    """
    if Image is None:  # pragma: no cover
        raise RuntimeError("Pillow not installed")

    with Image.open(file_path) as img:
        img = img.convert("RGB")
        result = img.getcolors(maxcolors=1024 * 1024)
        if result:
            # Sort by occurrence
            colours = sorted(result, key=lambda r: r[0], reverse=True)[:k]
            palette = tuple(_rgb_to_hex(rgb) for _, rgb in colours)
            logger.debug("Palette extracted via getcolors: %s", palette)
            return palette

        # Fallback: simple downsample + histogram
        small = img.resize((100, 100))
        histogram = small.histogram()
        r, g, b = histogram[0:256], histogram[256:512], histogram[512:768]
        popular = sorted(range(256), key=lambda i: r[i] + g[i] + b[i], reverse=True)[:k]
        palette = tuple(_rgb_to_hex((i, i, i)) for i in popular)
        logger.debug("Palette extracted via histogram: %s", palette)
        return palette


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def _heuristic_sentiment(text: str) -> float:
    """
    Micro-sentiment heuristic: returns mood score in range [-1, 1].
    """
    POSITIVE = {"love", "great", "awesome", "happy", "joy", "yay"}
    NEGATIVE = {"sad", "bad", "terrible", "angry", "hate", "ugh"}

    tokens = {t.lower().strip(".,!?") for t in text.split()}
    pos_hits = len(tokens & POSITIVE)
    neg_hits = len(tokens & NEGATIVE)

    if pos_hits == neg_hits == 0:
        return 0.0
    score = (pos_hits - neg_hits) / (pos_hits + neg_hits)
    logger.debug("Heuristic sentiment: %s → %0.2f", text, score)
    return score
```