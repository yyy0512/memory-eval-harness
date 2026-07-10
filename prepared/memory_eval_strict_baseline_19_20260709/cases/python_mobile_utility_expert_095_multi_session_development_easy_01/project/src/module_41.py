```python
"""
PrismPocket – Prism Analytics Module
====================================

This module provides a micro-analytics engine responsible for deriving
real-time creative insights from a user’s *PrismCard* collection.  The
engine sits in the **domain layer** (Clean Architecture) and therefore
has **zero dependencies on mobile or UI frameworks**.  It publishes its
results through a lightweight Observer bus so that view-models can
subscribe and reactively update the UI canvas.

High-level responsibilities
---------------------------
1. Color palette aggregation and *“trending hue”* detection.
2. “Mood score” inference from a card’s dominant colors
   (range: –1.0 … +1.0).
3. Caching of analytics snapshots to avoid redundant computation.
4. Observer dispatch with debouncing to protect the main thread.

The engine is intentionally *pure Python* (batteries only) to keep the
domain layer testable and platform-agnostic.  Heavy ML/AI tasks are
delegated to a cloud lambda and therefore **out-of-scope** for this
module.

Author:  PrismPocket Core Team
"""

from __future__ import annotations

import asyncio
import colorsys
import logging
import statistics
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from threading import Lock
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

# ---------------------------------------------------------
# Rudimentary domain stubs (would normally come from prism.core)
# ---------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PrismColor:
    """RGB color wrapper."""
    r: int
    g: int
    b: int

    def to_hsv(self) -> Tuple[float, float, float]:
        """Convert RGB [0-255] to HSV [0-1]."""
        return colorsys.rgb_to_hsv(self.r / 255, self.g / 255, self.b / 255)

    def hue(self) -> float:
        """Return hue in degrees (0-360)."""
        h, _, _ = self.to_hsv()
        return h * 360


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Minimal representation of a Prism Card used solely for analytics.

    NOTE: The full object lives inside `prism.domain.entities`.
    """
    card_id: str
    created_at: datetime
    owner_id: str
    palette: Sequence[PrismColor]  # Extracted dominant colors
    text_blurb: str | None = None
    tags: Sequence[str] = field(default_factory=list)


# ---------------------------------------------------------
# Analytics data models
# ---------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    top_hues: List[float]
    total_cards: int
    computed_at: datetime


@dataclass(frozen=True, slots=True)
class MoodMetric:
    mood_score_avg: float
    sampled_cards: int
    computed_at: datetime


@dataclass(frozen=True, slots=True)
class CombinedAnalytics:
    palette_metric: PaletteMetric
    mood_metric: MoodMetric
    computed_at: datetime


# ---------------------------------------------------------
# Observer bus (very light-weight, thread-safe)
# ---------------------------------------------------------


ObserverCallback = Callable[[CombinedAnalytics], None]


class _AnalyticsObserverBus:
    """Thread-safe pub/sub for analytics events."""

    _instance: "_AnalyticsObserverBus" | None = None
    _lock = Lock()

    def __init__(self) -> None:
        self._subscribers: set[ObserverCallback] = set()
        self._sub_lock = Lock()

    # Singleton accessor -------------------------------------------------

    @classmethod
    def instance(cls) -> "_AnalyticsObserverBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # Subscriber management ----------------------------------------------

    def subscribe(self, callback: ObserverCallback) -> None:
        with self._sub_lock:
            self._subscribers.add(callback)

    def unsubscribe(self, callback: ObserverCallback) -> None:
        with self._sub_lock:
            self._subscribers.discard(callback)

    # Event dispatch ------------------------------------------------------

    def dispatch(self, payload: CombinedAnalytics) -> None:
        with self._sub_lock:
            subscribers_snapshot = list(self._subscribers)

        for cb in subscribers_snapshot:
            try:
                cb(payload)
            except Exception:  # noqa: BLE001
                logging.exception("Analytics observer raised an exception")


# ---------------------------------------------------------
# Analytics computation core
# ---------------------------------------------------------


class ColorTrendAnalyzer:
    """
    Detects trending hues from a collection of *PrismCard*s.

    Strategy
    --------
    1. Reduce each palette to its dominant hue (first entry).
    2. Bucket the hue values into 12 standard color wheel segments.
    3. Surface the 3 most frequent buckets as *“trending hues”*.
    """

    _BUCKET_SIZE_DEG = 30  # 360 / 12

    @staticmethod
    def _bucket_hue(hue: float) -> int:
        """Assign a hue to a discrete bucket ID."""
        return int(hue // ColorTrendAnalyzer._BUCKET_SIZE_DEG)

    def top_trending_hues(
        self, cards: Iterable[PrismCard], top_n: int = 3
    ) -> List[float]:
        if top_n <= 0:
            raise ValueError("top_n must be > 0")

        bucket_counter: Counter[int] = Counter()

        for card in cards:
            if not card.palette:
                # Skip cards without palette information
                continue
            dominant_hue = card.palette[0].hue()
            bucket_counter[self._bucket_hue(dominant_hue)] += 1

        logging.debug("Hue buckets: %s", bucket_counter)

        most_common = bucket_counter.most_common(top_n)
        return [
            (bucket_id * self._BUCKET_SIZE_DEG) + self._BUCKET_SIZE_DEG / 2
            for bucket_id, _ in most_common
        ]


class MoodScoreCalculator:
    """
    Infers a mood score from card colors.

    The heuristic is intentionally simple (and fully offline):
    - Warm colors (0-60°, 300-360°) bias towards +1.
    - Cool colors (120-240°) bias towards –1.
    - Neutral colors gravitate to 0.

    The *card's* mood is the mean mood value of its palette.
    """

    @staticmethod
    def _single_color_mood(hue: float) -> float:
        if 0 <= hue <= 60 or 300 <= hue <= 360:
            return 1.0
        if 120 <= hue <= 240:
            return -1.0
        return 0.0

    def card_mood(self, card: PrismCard) -> float | None:
        if not card.palette:
            return None

        moods = [self._single_color_mood(c.hue()) for c in card.palette]
        return statistics.fmean(moods)

    def average_mood(self, cards: Iterable[PrismCard]) -> float:
        mood_scores: List[float] = []
        for card in cards:
            score = self.card_mood(card)
            if score is not None:
                mood_scores.append(score)

        if not mood_scores:
            return 0.0  # Default neutral when no colors available

        return statistics.fmean(mood_scores)


# ---------------------------------------------------------
# Repository facade (caching + observer dispatch)
# ---------------------------------------------------------


class PrismAnalyticsRepository:
    """
    High-level facade that orchestrates analytics computation,
    caching and observer dispatch.

    Life-cycle
    ----------
    The repository is designed as **long-lived** (singleton-ish) and
    thread-safe.  It spawns background tasks, so make sure to call
    `.shutdown()` during application tear-down.
    """

    _CACHE_EXPIRY = timedelta(minutes=5)

    def __init__(self, *, max_workers: int = 2) -> None:
        self._logger = logging.getLogger(self.__class__.__name__)
        self._cards: Dict[str, PrismCard] = {}

        self._last_snapshot: CombinedAnalytics | None = None
        self._last_snapshot_ts: float = 0.0

        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._loop = asyncio.get_event_loop()
        self._shutdown = False

    # -----------------------------------------------------
    # Public API
    # -----------------------------------------------------

    def add_or_update_cards(self, cards: Iterable[PrismCard]) -> None:
        """
        Merge the provided cards into the repository and trigger
        an async analytics refresh if needed.
        """
        updated = False
        for c in cards:
            if c.card_id not in self._cards or c != self._cards[c.card_id]:
                self._cards[c.card_id] = c
                updated = True

        if updated:
            self._logger.debug("Card set updated; scheduling recompute")
            self._schedule_recompute()
        else:
            self._logger.debug("No card changes detected; skipping recompute")

    def current_snapshot(self) -> CombinedAnalytics | None:
        """Return the latest cached analytics snapshot."""
        return self._last_snapshot

    def subscribe(self, cb: ObserverCallback) -> None:
        _AnalyticsObserverBus.instance().subscribe(cb)

    def unsubscribe(self, cb: ObserverCallback) -> None:
        _AnalyticsObserverBus.instance().unsubscribe(cb)

    # -----------------------------------------------------
    # Life-cycle
    # -----------------------------------------------------

    def shutdown(self) -> None:
        """Flush executor and cancel outstanding tasks."""
        self._shutdown = True
        self._executor.shutdown(wait=False)

    # -----------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------

    def _schedule_recompute(self) -> None:
        """
        Schedule recomputation in the background, debounced so that
        rapid bursts of updates get coalesced.
        """
        if self._shutdown:
            self._logger.warning("Repository is shut down; ignoring recompute")
            return

        async def _debounced():
            await asyncio.sleep(0.5)  # debounce window
            await self._async_recompute_and_notify()

        # Fire-and-forget (we purposely don't await)
        asyncio.ensure_future(_debounced(), loop=self._loop)

    async def _async_recompute_and_notify(self) -> None:
        """Run compute on a thread, then _notify on completion."""
        if self._shutdown:
            return

        cards_snapshot = list(self._cards.values())

        try:
            analytics: CombinedAnalytics = await self._loop.run_in_executor(
                self._executor, self._compute_analytics, cards_snapshot
            )
        except Exception as exc:  # noqa: BLE001
            self._logger.exception("Failed to compute analytics: %s", exc)
            return

        self._last_snapshot = analytics
        self._last_snapshot_ts = time.time()

        self._logger.debug("New analytics snapshot available")
        _AnalyticsObserverBus.instance().dispatch(analytics)

    # -----------------------------------------------------
    # Pure computation (runs in thread pool)
    # -----------------------------------------------------

    def _compute_analytics(
        self, cards: Sequence[PrismCard]
    ) -> CombinedAnalytics:
        """Heavy lifting logic (CPU-bound)."""
        now = datetime.utcnow()
        if (
            self._last_snapshot
            and now - self._last_snapshot.computed_at < self._CACHE_EXPIRY
        ):
            self._logger.debug("Returning cached snapshot")
            return self._last_snapshot

        self._logger.debug(
            "Computing analytics for %s cards (pool thread)",
            len(cards),
        )

        color_trend_analyzer = ColorTrendAnalyzer()
        mood_calculator = MoodScoreCalculator()

        top_hues = color_trend_analyzer.top_trending_hues(cards)
        avg_mood = mood_calculator.average_mood(cards)

        palette_metric = PaletteMetric(
            top_hues=top_hues, total_cards=len(cards), computed_at=now
        )
        mood_metric = MoodMetric(
            mood_score_avg=avg_mood, sampled_cards=len(cards), computed_at=now
        )
        return CombinedAnalytics(
            palette_metric=palette_metric,
            mood_metric=mood_metric,
            computed_at=now,
        )


# ---------------------------------------------------------
# Convenience singleton proxy
# ---------------------------------------------------------

_default_repository: PrismAnalyticsRepository | None = None
_default_lock = Lock()


def analytics_repository() -> PrismAnalyticsRepository:
    """
    Retrieve the shared singleton instance of the analytics repository.

    This indirection avoids global state pollution in unit tests.
    """
    global _default_repository  # noqa: WPS420
    with _default_lock:
        if _default_repository is None:
            _default_repository = PrismAnalyticsRepository()
        return _default_repository


# ---------------------------------------------------------
# Debug / manual test hook (runs only when executed directly)
# ---------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    # Build some fake test data
    demo_cards = [
        PrismCard(
            card_id=f"id_{i}",
            created_at=datetime.utcnow(),
            owner_id="user123",
            palette=[
                PrismColor(255, 0, 0),  # Red
                PrismColor(255, 255, 0),  # Yellow
            ],
        )
        for i in range(5)
    ] + [
        PrismCard(
            card_id=f"id_b_{i}",
            created_at=datetime.utcnow(),
            owner_id="user123",
            palette=[PrismColor(0, 128, 255)],  # Blue
        )
        for i in range(8)
    ]

    repo = analytics_repository()

    def _observer(snapshot: CombinedAnalytics) -> None:
        print("Observer received:", snapshot)

    repo.subscribe(_observer)
    repo.add_or_update_cards(demo_cards)

    try:
        # Keep the script alive for a short while to allow async tasks to finish
        asyncio.get_event_loop().run_until_complete(asyncio.sleep(2))
    finally:
        repo.shutdown()
```