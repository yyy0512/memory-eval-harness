```python
"""
PrismPocket – Palette Analytics Engine
======================================

This module hosts the PaletteAnalyticsEngine responsible for extracting,
aggregating, and surfacing color–centric insights from user–generated
PrismCards.  It lives in the infrastructure ring (Clean Architecture)
and communicates exclusively with domain entities.

Design patterns employed
------------------------
* Singleton            – one analytics engine for the entire runtime
* Observer             – downstream components subscribe to live metrics
* Factory              – `PaletteMetricFactory` instantiates metrics
* Repository           – engine stores metrics in `_MetricRepository`
"""

from __future__ import annotations

import itertools
import json
import logging
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from statistics import mean
from typing import Callable, Deque, Dict, List, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# NOTE: the host application configures root handlers; fall back otherwise.
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("[%(levelname)s] %(name)s: %(message)s")
    )
    logger.addHandler(handler)


# --------------------------------------------------------------------------- #
# Domain Stubs                                                                #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class PrismCard:
    """
    Minimal stub of a domain entity.  In production this is provided by the
    `domain` or `entities` layer and imported here.  Only the attributes
    required for analytics are repeated.
    """
    card_id: str
    palette: List[str]            # HEX colors (e.g. '#FFAA00')
    created_at: float             # UNIX timestamp in seconds
    latitude: float | None = None
    longitude: float | None = None


@dataclass(frozen=True)
class PaletteMetric:
    dominant_color: str           # HEX
    palette_hash: str             # Unique hash (for quick comparison)
    popularity_score: float       # 0..1 scaled score
    mood_score: float             # -1 (sad / dark) .. 1 (bright / happy)
    card_count: int               # Absolute card count backing the metric
    last_updated: float = field(default_factory=time.time)

    def to_json(self) -> str:
        return json.dumps(self.__dict__, separators=(",", ":"))


# --------------------------------------------------------------------------- #
# Utility Functions                                                           #
# --------------------------------------------------------------------------- #

def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """
    Convert a hex color to an (R, G, B) tuple.
    """
    if not isinstance(hex_color, str) or not hex_color.startswith("#") or len(hex_color) != 7:
        raise ValueError(f"Invalid HEX color: {hex_color}")
    try:
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
    except ValueError as err:  # pragma: no cover
        raise ValueError(f"Invalid HEX color: {hex_color}") from err
    return r, g, b


def _brightness(rgb: Tuple[int, int, int]) -> float:
    """
    Simple luminance approximation (perceived brightness).
    """
    r, g, b = rgb
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255.0


def _mood_score(palette: Sequence[str]) -> float:
    """
    Derive a mood score from a palette.  Purely heuristic:
    average brightness re–scaled to [-1, 1].
    """
    brightness_values = [_brightness(_hex_to_rgb(c)) for c in palette]
    scaled = mean(brightness_values) * 2 - 1     # 0..1  →  -1..1
    logger.debug("Calculated mood_score=%s from palette=%s", scaled, palette)
    return scaled


def _hash_palette(colors: Sequence[str]) -> str:
    """
    Deterministic hash for a palette (order–independent).
    """
    return "_".join(sorted(colors)).lower()


# --------------------------------------------------------------------------- #
# Repository (in–memory)                                                      #
# --------------------------------------------------------------------------- #

class _MetricRepository:
    """
    Extremely lightweight repository to store palette metrics in–memory.
    Thread–safe via internal lock.
    """

    def __init__(self, window_seconds: int = 60 * 60 * 24) -> None:
        self._lock = threading.RLock()
        self._window = window_seconds
        self._cards: Deque[PrismCard] = deque()             # sliding window
        self._counter: Counter[str] = Counter()             # palette_hash -> count

    # ------------------ public API ------------------ #

    def add_card(self, card: PrismCard) -> None:
        with self._lock:
            logger.debug("Adding card_id=%s palette=%s", card.card_id, card.palette)
            self._cards.append(card)
            self._counter[_hash_palette(card.palette)] += 1
            self._expire()

    def snapshot(self) -> Tuple[Counter[str], int]:
        """
        Return a snapshot (copy) of internal counter + total cards (for scaling).
        """
        with self._lock:
            counter_copy = self._counter.copy()
            total_cards = len(self._cards)
        logger.debug("Snapshot counter=%s total_cards=%d", counter_copy, total_cards)
        return counter_copy, total_cards

    # ------------------ private helpers ------------------ #

    def _expire(self) -> None:
        """
        Remove cards older than `window_seconds` to maintain sliding window.
        """
        now = time.time()
        while self._cards and now - self._cards[0].created_at > self._window:
            old_card = self._cards.popleft()
            palette_hash = _hash_palette(old_card.palette)
            self._counter[palette_hash] -= 1
            if self._counter[palette_hash] <= 0:
                del self._counter[palette_hash]
            logger.debug("Expired card_id=%s", old_card.card_id)


# --------------------------------------------------------------------------- #
# Factory                                                                     #
# --------------------------------------------------------------------------- #

class PaletteMetricFactory:
    """
    Creates PaletteMetric objects from frequency data.
    """

    @staticmethod
    def build(palette_hash: str, count: int, total: int) -> PaletteMetric:
        colors = palette_hash.split("_")
        dominant = PaletteMetricFactory._dominant_color(colors)
        popularity = count / total if total else 0.0
        mood = _mood_score(colors)
        metric = PaletteMetric(
            dominant_color=dominant,
            palette_hash=palette_hash,
            popularity_score=round(popularity, 4),
            mood_score=round(mood, 4),
            card_count=count,
        )
        logger.debug("Built PaletteMetric=%s", metric)
        return metric

    @staticmethod
    def _dominant_color(colors: Sequence[str]) -> str:
        """
        Dominant color = color with highest brightness contrast (heuristic).
        """
        ranked = sorted(
            colors,
            key=lambda c: _brightness(_hex_to_rgb(c)),
            reverse=True,
        )
        return ranked[0] if ranked else "#000000"


# --------------------------------------------------------------------------- #
# Observer support                                                            #
# --------------------------------------------------------------------------- #

ObserverCallback = Callable[[str, Dict], None]  # event_type, payload


class _ObserverBus:
    """Very small observer pub–sub implementation."""

    def __init__(self) -> None:
        self._subscribers: List[ObserverCallback] = []
        self._lock = threading.Lock()

    def register(self, callback: ObserverCallback) -> None:
        with self._lock:
            if callback not in self._subscribers:
                self._subscribers.append(callback)
                logger.debug("Registered observer=%s", callback)

    def unregister(self, callback: ObserverCallback) -> None:
        with self._lock:
            self._subscribers = [cb for cb in self._subscribers if cb != callback]
            logger.debug("Unregistered observer=%s", callback)

    def notify(self, event_type: str, payload: Dict) -> None:
        with self._lock:
            subs = list(self._subscribers)
        logger.debug("Notifying %d observers event=%s", len(subs), event_type)
        for cb in subs:
            try:
                cb(event_type, payload)
            except Exception:  # pragma: no cover -- observers must not crash engine
                logger.exception("Observer callback failed: %s", cb)


# --------------------------------------------------------------------------- #
# Singleton meta                                                              #
# --------------------------------------------------------------------------- #

class _SingletonMeta(type):
    _instances: Dict[type, "_SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        # Double–checked locking for thread–safe singleton.
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:
                    logger.debug("Creating singleton instance for %s", cls.__name__)
                    instance = super().__call__(*args, **kwargs)
                    cls._instances[cls] = instance
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# Public Engine                                                               #
# --------------------------------------------------------------------------- #

class PaletteAnalyticsEngine(metaclass=_SingletonMeta):
    """
    High–level service to ingest PrismCards and expose trending palettes.
    """

    _OBS_EVENT_METRIC_UPDATE = "palette_metric_update"

    def __init__(self, window_seconds: int = 60 * 60 * 24) -> None:
        self._repo = _MetricRepository(window_seconds=window_seconds)
        self._bus = _ObserverBus()

        # background lock for trend computation
        self._compute_lock = threading.Lock()

    # ---------------- API: ingestion ---------------- #

    def ingest_card(self, card: PrismCard) -> None:
        """
        Store a new card and recompute trend metrics.
        """
        logger.info("Ingesting card_id=%s", card.card_id)
        try:
            self._validate_card(card)
        except ValueError:
            logger.warning("Discarding invalid card_id=%s", card.card_id)
            return

        self._repo.add_card(card)
        metrics = self._compute_trending()
        self._bus.notify(self._OBS_EVENT_METRIC_UPDATE, {"metrics": metrics})

    # ---------------- API: observers ---------------- #

    def register_observer(self, callback: ObserverCallback) -> None:
        self._bus.register(callback)

    def unregister_observer(self, callback: ObserverCallback) -> None:
        self._bus.unregister(callback)

    # ---------------- API: query ---------------- #

    def get_trending_palettes(self, top_n: int = 10) -> List[PaletteMetric]:
        """
        Returns the cached trending palettes (recomputed on last ingestion).
        """
        metrics = self._compute_trending()
        return metrics[:top_n]

    # ---------------- private helpers ---------------- #

    @staticmethod
    def _validate_card(card: PrismCard) -> None:
        if not card.palette:
            raise ValueError("Palette cannot be empty")
        for color in card.palette:
            _hex_to_rgb(color)  # will raise on invalid hex

    def _compute_trending(self) -> List[PaletteMetric]:
        """
        Heavy–weight computation – compute trending metrics in a thread–safe
        manner but without blocking ingestion for too long.
        """
        if not self._compute_lock.acquire(blocking=False):
            logger.debug("Trend computation already running – skip")
            return []
        try:
            counter, total = self._repo.snapshot()
            sorted_palettes = counter.most_common()
            metrics = [
                PaletteMetricFactory.build(hash_, cnt, total)
                for hash_, cnt in sorted_palettes
            ]
            logger.debug("Computed %d palette metrics", len(metrics))
            return metrics
        finally:
            self._compute_lock.release()


# --------------------------------------------------------------------------- #
# Demo code (executed when run as script)                                     #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    import random
    import string

    engine = PaletteAnalyticsEngine(window_seconds=30)  # 30-second window

    def debug_observer(event, payload):
        logger.info("OBSERVER event=%s payload_size=%d", event, len(payload["metrics"]))

    engine.register_observer(debug_observer)

    def random_hex() -> str:
        return "#" + "".join(random.choice("0123456789ABCDEF") for _ in range(6))

    for idx in range(25):
        card = PrismCard(
            card_id="".join(random.choice(string.ascii_letters) for _ in range(8)),
            palette=[random_hex() for _ in range(random.randint(3, 5))],
            created_at=time.time() - random.randint(0, 20),
        )
        engine.ingest_card(card)
        time.sleep(0.2)

    trending = engine.get_trending_palettes(5)
    print("\nTop 5 trending palettes:")
    for metric in trending:
        print(metric.to_json())
```