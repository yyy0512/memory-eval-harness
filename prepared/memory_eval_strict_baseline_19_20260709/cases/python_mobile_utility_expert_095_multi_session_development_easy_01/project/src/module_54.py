```python
"""
src/module_54.py

Palette-trend analytics and observer dispatch for PrismPocket.

This module is situated in the outer “analytics” circle of PrismPocket’s Clean
Architecture.  It listens to mutations in the PrismCard repository, performs
palette extraction & trend scoring, and publishes `TrendSnapshot` objects onto
the Observer bus for the View-Model layer to render.

Design patterns employed
------------------------
• Singleton            – `PaletteTrendAnalyzer` is globally unique
• Factory              – `AnalyzerFactory` isolates analyzer instantiation
• Observer             – `EventBus` broadcasts `AnalyticsEvent`s
• Repository           – Analyzer consumes `PrismCardRepository` (domain)

Author: PrismPocket Analytics Team
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import random
import statistics
import threading
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# STUBS / SLIM ADAPTERS – replaced with concrete implementations at runtime   #
# --------------------------------------------------------------------------- #

class EventBus:
    """
    Minimal Observer bus until real bus is injected at runtime.
    """
    def __init__(self) -> None:
        self._listeners: Dict[str, List] = {}

    def register(self, event_type: str, callback) -> None:
        self._listeners.setdefault(event_type, []).append(callback)

    def dispatch(self, event_type: str, payload) -> None:
        for cb in self._listeners.get(event_type, []):
            try:
                cb(payload)
            except Exception:  # pragma: no cover
                logging.exception("Listener %s failed on event %s", cb, event_type)


class PrismCard:
    """
    Highly-simplified domain entity for color-analytics purposes.
    """
    def __init__(
        self,
        card_id: str,
        dominant_colors: Sequence[str],
        created_at: Optional[_dt.datetime] = None,
    ) -> None:
        self.card_id = card_id
        self.dominant_colors = dominant_colors  # list of HEX strings
        self.created_at = created_at or _dt.datetime.utcnow()


class PrismCardRepository:
    """
    Repository stub returning PrismCard collections.  The real implementation
    injects local-storage and sync adapters.
    """
    def __init__(self) -> None:
        self._cards: Dict[str, PrismCard] = {}

    def add(self, card: PrismCard) -> None:
        self._cards[card.card_id] = card

    def all(self) -> Iterable[PrismCard]:
        return self._cards.values()

    def subscribe(self, callback) -> None:  # mocked domain-events subscription
        pass


# --------------------------------------------------------------------------- #
# DOMAIN MODELS                                                               #
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class PaletteMetric:
    hex_color: str          # canonical HEX (#RRGGBB)
    usage_count: int
    mood_score: float       # ‑1.0 (“sad”) … 1.0 (“happy”)


@dataclass
class TrendSnapshot:
    """
    Immutable snapshot broadcast to view models.
    """
    generated_at: _dt.datetime
    top_palette: List[PaletteMetric] = field(default_factory=list)
    trending_up: List[str] = field(default_factory=list)  # HEX colors
    trending_down: List[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# INTERNAL UTILITIES                                                          #
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism.analytics.palette")
logger.setLevel(logging.INFO)


def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """
    Convert #RRGGBB → (r, g, b). Accepts 3 or 6-digit HEX.
    """
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = "".join(c * 2 for c in hex_color)
    if len(hex_color) != 6:
        raise ValueError(f"Invalid HEX color: {hex_color}")
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def _euclidean_distance(c1: Tuple[int, int, int], c2: Tuple[int, int, int]) -> float:
    return sum((a - b) ** 2 for a, b in zip(c1, c2)) ** 0.5


def _cluster_palette(
    colors: Iterable[str], tolerance: float = 30.0
) -> Dict[str, List[str]]:
    """
    Simple agglomerative clustering based on Euclidean distance in RGB space.
    Groups visually similar colors (within `tolerance`) under the first
    encountered exemplar.
    """
    clusters: Dict[str, List[str]] = {}
    for color in colors:
        rgb = _hex_to_rgb(color)
        matched_exemplar: Optional[str] = None
        for exemplar in clusters:
            if _euclidean_distance(rgb, _hex_to_rgb(exemplar)) <= tolerance:
                matched_exemplar = exemplar
                break
        if matched_exemplar:
            clusters[matched_exemplar].append(color)
        else:
            clusters[color] = [color]
    return clusters


def _compute_mood_score(hex_color: str) -> float:
    """
    Naïve heuristic that maps hue to “mood”. Cool colors negative, warm positive.
    """
    r, g, b = _hex_to_rgb(hex_color)
    # Convert to naive hue angle.
    min_c, max_c = min(r, g, b), max(r, g, b)
    if max_c == min_c:
        hue = 0
    elif max_c == r:
        hue = ((g - b) / (max_c - min_c)) % 6
    elif max_c == g:
        hue = (b - r) / (max_c - min_c) + 2
    else:
        hue = (r - g) / (max_c - min_c) + 4
    hue_deg = 60 * hue
    # Map hue to mood score linearly: 0deg (red) → 1, 180deg (cyan) → -1
    score = 1.0 - (hue_deg % 360) / 180.0
    return round(max(-1.0, min(1.0, score)), 3)


# --------------------------------------------------------------------------- #
# SINGLETON METACLASS                                                         #
# --------------------------------------------------------------------------- #

class _SingletonMeta(type):
    _instances: Dict = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        # Double-checked locking
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:
                    logger.debug("Instantiating singleton %s", cls.__name__)
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# CORE ANALYZER IMPLEMENTATION                                                #
# --------------------------------------------------------------------------- #

class PaletteTrendAnalyzer(metaclass=_SingletonMeta):
    """
    Consumes PrismCards and produces palette-trend analytics.  The heavy lifting
    runs in a background task at a configurable cadence to keep UI responsive.
    """

    WINDOW_SIZE = 50  # how many latest cards to observe
    BROADCAST_EVENT = "analytics.palette.trend"

    def __init__(
        self,
        *,
        repository: PrismCardRepository,
        bus: EventBus,
        interval_sec: int = 30,
    ) -> None:
        self._repo = repository
        self._bus = bus
        self._interval = interval_sec
        self._latest_cards: Deque[PrismCard] = deque(maxlen=self.WINDOW_SIZE)
        self._task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()

        # Kick off async loop
        asyncio.get_event_loop().create_task(self._bootstrap())

    # ------------------------------------------------------------------ #
    # Public control surface                                             #
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """
        Start periodic analytics if not already running.
        Thread-safe idempotent.
        """
        if self._task and not self._task.done():
            return
        logger.info("Starting PaletteTrendAnalyzer: every %ss", self._interval)
        self._task = asyncio.get_event_loop().create_task(self._run_loop())

    def stop(self) -> None:
        """
        Signal graceful shutdown of analytics coroutine.
        """
        if not self._task:
            return
        self._shutdown_event.set()

    # ------------------------------------------------------------------ #
    # Internal coroutine loop                                            #
    # ------------------------------------------------------------------ #

    async def _bootstrap(self) -> None:
        """
        Wait until event loop is running; register repository listener.
        """
        await asyncio.sleep(0)  # yield control
        self._repo.subscribe(self._on_repository_change)
        self.start()

    async def _run_loop(self) -> None:
        """
        Periodically compute trends and broadcast snapshots.
        """
        while not self._shutdown_event.is_set():
            try:
                snapshot = self._compute_snapshot()
                self._bus.dispatch(self.BROADCAST_EVENT, snapshot)
                logger.debug("Broadcasted TrendSnapshot at %s", snapshot.generated_at)
            except Exception:
                logger.exception("Failed to compute palette trends")
            await asyncio.wait(
                [self._shutdown_event.wait()], timeout=self._interval
            )
        logger.info("PaletteTrendAnalyzer stopped")

    # ------------------------------------------------------------------ #
    # Repository listener                                                #
    # ------------------------------------------------------------------ #

    def _on_repository_change(self, card: PrismCard) -> None:
        """
        Called by repository when a new card is inserted or modified.
        """
        self._latest_cards.append(card)
        logger.debug("Repository changed – buffered card %s", card.card_id)

    # ------------------------------------------------------------------ #
    # Analytics                                                          #
    # ------------------------------------------------------------------ #

    def _compute_snapshot(self) -> TrendSnapshot:
        """
        Collate color statistics over the sliding window of cards.
        """
        # 1. Gather dominant colors.
        color_counts: Counter = Counter()
        for card in self._latest_cards or self._repo.all():
            color_counts.update(card.dominant_colors)

        logger.debug("Aggregated color counts: %s", color_counts)

        # 2. Cluster similar colors.
        clustered: Dict[str, List[str]] = _cluster_palette(color_counts.keys())
        cluster_usage: Dict[str, int] = {
            exemplar: sum(color_counts[c] for c in members)
            for exemplar, members in clustered.items()
        }

        logger.debug("Clustered palettes: %s", cluster_usage)

        # 3. Compute metrics.
        top_palette = [
            PaletteMetric(
                hex_color=exemplar,
                usage_count=cluster_usage[exemplar],
                mood_score=_compute_mood_score(exemplar),
            )
            for exemplar in sorted(
                cluster_usage, key=cluster_usage.get, reverse=True
            )[:10]
        ]

        # 4. Determine trending up/down using naive moving average.
        trend_up, trend_down = self._determine_trend_direction(cluster_usage)

        return TrendSnapshot(
            generated_at=_dt.datetime.utcnow(),
            top_palette=top_palette,
            trending_up=trend_up,
            trending_down=trend_down,
        )

    def _determine_trend_direction(
        self, usage: Dict[str, int]
    ) -> Tuple[List[str], List[str]]:
        """
        Compare usage counts to a simple history kept in memory.
        """
        if not hasattr(self, "_history"):
            self._history: Deque[Dict[str, int]] = deque(maxlen=6)  # store 3 min
        self._history.append(usage)

        if len(self._history) < 2:
            return [], []

        prev = self._history[-2]
        growth = {
            color: usage.get(color, 0) - prev.get(color, 0) for color in usage
        }
        mean_growth = statistics.mean(growth.values() or [0])
        std_dev = statistics.stdev(growth.values() or [0]) or 1

        trending_up = [
            color
            for color, delta in growth.items()
            if delta > mean_growth + std_dev
        ]
        trending_down = [
            color
            for color, delta in growth.items()
            if delta < mean_growth - std_dev
        ]

        logger.debug("Growth stats: %s (mean=%s, σ=%s)", growth, mean_growth, std_dev)
        return trending_up, trending_down


# --------------------------------------------------------------------------- #
# FACTORY                                                                     #
# --------------------------------------------------------------------------- #

class AnalyzerFactory:
    """
    Factory for palette analyzers.  Keeps calling sites agnostic to concrete
    implementation and enforces the Singleton guarantee.
    """

    @staticmethod
    def create_default(
        repository: PrismCardRepository,
        bus: EventBus,
    ) -> PaletteTrendAnalyzer:
        return PaletteTrendAnalyzer(repository=repository, bus=bus)


# --------------------------------------------------------------------------- #
# BOOTSTRAP (called by application entrypoint)                                #
# --------------------------------------------------------------------------- #

def bootstrap_analytics_layer(
    repository: PrismCardRepository,
    event_bus: EventBus,
    *,
    jitter: bool = True,
) -> PaletteTrendAnalyzer:
    """
    Entry point used by the application container to spin up analytics.  The
    optional `jitter` staggers analyzer startup to avoid stampeding on launch.
    """
    if jitter:
        # Add up to 3 seconds of startup delay to avoid lockstep analytics when
        # multiple providers are started concurrently (e.g., test suite).
        delay = random.uniform(0.0, 3.0)
        logger.debug("Applying %0.2fs jitter to analyzer startup", delay)
        asyncio.get_event_loop().call_later(
            delay, AnalyzerFactory.create_default, repository, event_bus
        )
        return PaletteTrendAnalyzer(repository=repository, bus=event_bus)  # ensures singleton
    return AnalyzerFactory.create_default(repository, event_bus)
```