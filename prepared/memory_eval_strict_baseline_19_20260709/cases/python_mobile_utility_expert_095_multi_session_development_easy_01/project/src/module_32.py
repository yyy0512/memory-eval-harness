```python
"""
src/module_32.py

Palette analytics engine for PrismPocket.

This module belongs to the ‘application / service’ layer in the Clean-Architecture
stack and offers:

1. A lightweight in-process Observer bus (pub-sub) for broadcasting analytics
   mutations to the presentation layer (e.g. View-Models).
2. A PaletteTrendAnalyzer that crunches incoming PrismCard data and surfaces
   “trending” colour palettes in real-time.
3. A scheduler helper that runs the analysis loop on a background thread and
   safely tears down on application exit.

The module purposefully contains *no* concrete persistence or platform code—
those concerns are injected via interfaces/abstractions so unit-testing remains
trivial.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from types import TracebackType
from typing import Callable, Dict, Iterable, List, MutableMapping, Optional, Sequence, Tuple, Type, TypeVar

###############################################################################
# Logging configuration
###############################################################################

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
# In real production code the handler will be configured by the host app; this
# fallback ensures logs are visible during standalone runs / tests.
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(handler)

###############################################################################
# Domain primitives
###############################################################################

Color = Tuple[int, int, int]  # RGB triplet


@dataclass(frozen=True)
class PrismCard:
    """
    Domain Entity: Core creative item captured by the user.

    For brevity only the fields relevant for palette analysis are included.
    """
    card_id: str
    user_id: str
    palette: List[Color]
    mood_score: Optional[float] = None
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class PaletteMetric:
    """
    Aggregate analytics data for a palette hashed string.
    """
    palette_hash: str
    usage_count: int
    trend_score: float  # e.g. a smoothed change compared to previous window

    def to_dict(self) -> Dict[str, str | int | float]:
        return {
            "palette_hash": self.palette_hash,
            "usage_count": self.usage_count,
            "trend_score": round(self.trend_score, 4),
        }

###############################################################################
# Repository Abstraction
###############################################################################


class PrismCardRepository:
    """
    Interface for a data-source that yields PrismCard entries.

    Any concrete implementation (e.g. local SQLite repository, REST client, GRPC
    adapter) must comply with this minimal contract.
    """

    def stream_cards(
        self, since: datetime, until: datetime
    ) -> Iterable[PrismCard]:  # pragma: no cover
        """
        Blocking / generator style API returning PrismCards created within the
        window [since, until). Must handle pagination / batching internally.
        """
        raise NotImplementedError


###############################################################################
# PubSub – thin event bus (simple Observer pattern)
###############################################################################

Subscriber = Callable[[str, object], None]
_T = TypeVar("_T", bound="EventBus")


class EventBus:
    """
    A process-local, thread-safe singleton event bus.

    Using an explicit singleton here avoids accidental multiple instances when
    the module is imported via different paths in a mobile embedding scenario.
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.Lock()

    def __init__(self) -> None:
        # topic -> list[subscribers]
        self._subscriptions: MutableMapping[str, List[Subscriber]] = defaultdict(list)
        self._bus_lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Singleton helpers
    # --------------------------------------------------------------------- #
    def __new__(cls: Type[_T]) -> _T:
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance  # type: ignore[return-value]

    # --------------------------------------------------------------------- #
    # Subscription API
    # --------------------------------------------------------------------- #
    def subscribe(self, topic: str, callback: Subscriber) -> Callable[[], None]:
        """
        Register callback for a given topic.
        Returns an unsubscribe function for convenience.
        """
        if not callable(callback):
            raise TypeError("callback must be callable")

        with self._bus_lock:
            self._subscriptions[topic].append(callback)
            logger.debug("Subscriber added for topic '%s'", topic)

        def _unsubscribe() -> None:
            self.unsubscribe(topic, callback)

        return _unsubscribe

    def unsubscribe(self, topic: str, callback: Subscriber) -> None:
        with self._bus_lock:
            try:
                self._subscriptions[topic].remove(callback)
                logger.debug("Subscriber removed from topic '%s'", topic)
            except (KeyError, ValueError):
                # Silently ignore double-unsubscribes
                logger.debug("Attempted to remove missing subscriber from '%s'", topic)

    # --------------------------------------------------------------------- #
    # Publishing API
    # --------------------------------------------------------------------- #
    def publish(self, topic: str, payload: object) -> None:
        with self._bus_lock:
            subscribers: Sequence[Subscriber] = tuple(
                self._subscriptions.get(topic, [])
            )

        # Dispatch outside lock to avoid deadlocks where subscriber repubs.
        for subscriber in subscribers:
            try:
                subscriber(topic, payload)
            except Exception:  # pragma: no cover
                logger.exception(
                    "Unhandled error in subscriber '%s' for topic '%s'", subscriber, topic
                )


###############################################################################
# PaletteTrendAnalyzer
###############################################################################


class PaletteTrendAnalyzer:
    """
    Computes trending colour palettes on a rolling time window and publishes
    the result to the Observer bus.

    The algorithm is intentionally simple:
        1. Pull all cards within `analysis_window` (e.g. 24h)
        2. Group by palette (hash)
        3. Compare with previous window to calculate Δ usage
    """

    EVENT_TOPIC = "analytics.palette_trend.updated"

    def __init__(
        self,
        repository: PrismCardRepository,
        analysis_window: timedelta = timedelta(hours=24),
        publish_top_n: int = 10,
    ):
        self._repository = repository
        self._analysis_window = analysis_window
        self._publish_top_n = publish_top_n

        self._bus = EventBus()
        self._previous_counts: Dict[str, int] = {}

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def run_once(self) -> List[PaletteMetric]:
        """
        Execute a single analysis cycle, publish results, and return them.
        """
        now = datetime.utcnow()
        since = now - self._analysis_window

        logger.info(
            "Running palette analysis for window [%s .. %s), top_n=%d",
            since.isoformat(),
            now.isoformat(),
            self._publish_top_n,
        )
        cards = list(self._repository.stream_cards(since=since, until=now))
        logger.debug("Fetched %d cards for analysis", len(cards))

        current_counts: Counter[str] = Counter(
            _hash_palette(card.palette) for card in cards if card.palette
        )

        metrics: List[PaletteMetric] = []
        for palette_hash, count in current_counts.items():
            previous = self._previous_counts.get(palette_hash, 0)
            # Simple trend: % change – avoid div/0
            if previous == 0 and count > 0:
                trend_score = 1.0  # 100% increase from 0
            elif previous == 0:
                trend_score = 0.0
            else:
                trend_score = (count - previous) / previous

            metrics.append(
                PaletteMetric(
                    palette_hash=palette_hash,
                    usage_count=count,
                    trend_score=trend_score,
                )
            )

        # Keep only those palettes that have changed or are popular
        metrics = sorted(
            metrics,
            key=lambda m: (
                -m.trend_score,
                -m.usage_count,
            ),
        )[: self._publish_top_n]

        logger.info(
            "Computed %d palette metrics (top_n)",
            len(metrics),
        )
        # Publish on event bus
        self._bus.publish(self.EVENT_TOPIC, metrics)
        # Carry metric counts forward for next run
        self._previous_counts = dict(current_counts)

        return metrics


###############################################################################
# Analysis Scheduler
###############################################################################


class AnalysisScheduler:
    """
    Background thread that triggers PaletteTrendAnalyzer at a fixed interval.

    Usage:
        repo = SqlitePrismCardRepository(db_path)
        analyzer = PaletteTrendAnalyzer(repo)
        scheduler = AnalysisScheduler(analyzer, interval=timedelta(minutes=10))
        scheduler.start()
        ...
        scheduler.stop()  # on application shutdown
    """

    def __init__(
        self, analyzer: PaletteTrendAnalyzer, interval: timedelta = timedelta(minutes=5)
    ):
        self._analyzer = analyzer
        self._interval = interval
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------ #
    # Context manager helpers
    # ------------------------------------------------------------------ #
    def __enter__(self) -> "AnalysisScheduler":
        self.start()
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> bool:
        self.stop()
        # Do not suppress exceptions
        return False

    # ------------------------------------------------------------------ #
    # Control
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            logger.warning("AnalysisScheduler already running")
            return

        logger.info(
            "Starting PaletteTrend analysis scheduler (interval=%s)",
            self._interval,
        )
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="PaletteTrendAnalysisThread",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        logger.info("Stopping PaletteTrend analysis scheduler...")
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=timeout)
        logger.info("Scheduler stopped")

    # ------------------------------------------------------------------ #
    # Internal
    # ------------------------------------------------------------------ #
    def _run_loop(self) -> None:
        next_run = time.monotonic()
        while not self._stop_event.is_set():
            try:
                self._analyzer.run_once()
            except Exception:  # pragma: no cover
                logger.exception("PaletteTrendAnalyzer crashed; continuing loop")

            # Determine sleep time, drift-safe
            next_run += self._interval.total_seconds()
            sleep_for = max(0.0, next_run - time.monotonic())

            if self._stop_event.wait(timeout=sleep_for):
                break


###############################################################################
# Utility helpers
###############################################################################


def _hash_palette(palette: Iterable[Color]) -> str:
    """
    Stable hash of a palette (order-insensitive) so that [ (255,0,0),(0,0,0) ]
    equals [ (0,0,0), (255,0,0) ]
    """
    # Sort colours for deterministic representation
    sorted_rgb = sorted(palette)
    # Convert to hex string e.g. '#FF0000#000000'
    return "".join(f"#{r:02X}{g:02X}{b:02X}" for r, g, b in sorted_rgb)


###############################################################################
# Example stub repository for local testing / demonstration
###############################################################################


class _InMemoryPrismCardRepository(PrismCardRepository):
    """
    Non-production, in-memory repository useful for unit-tests or demos.
    """

    def __init__(self, cards: Iterable[PrismCard] | None = None):
        self._cards: List[PrismCard] = list(cards or [])

    def add_card(self, card: PrismCard) -> None:
        self._cards.append(card)

    def stream_cards(
        self, since: datetime, until: datetime
    ) -> Iterable[PrismCard]:
        # naive implementation
        return (c for c in self._cards if since <= c.created_at < until)


###############################################################################
# Stand-alone test run (feature-flag controlled)
###############################################################################

if __name__ == "__main__":
    # Quick demonstration when module executed directly.
    logger.setLevel(logging.DEBUG)

    repo = _InMemoryPrismCardRepository()

    # Pre-seed repository with synthetic data
    now = datetime.utcnow()
    red = (255, 0, 0)
    blue = (0, 0, 255)
    green = (0, 255, 0)

    repo.add_card(
        PrismCard(
            card_id="c1",
            user_id="u1",
            palette=[red, blue],
            created_at=now - timedelta(hours=1),
        )
    )
    repo.add_card(
        PrismCard(
            card_id="c2",
            user_id="u2",
            palette=[green, blue],
            created_at=now - timedelta(hours=1, minutes=30),
        )
    )
    repo.add_card(
        PrismCard(
            card_id="c3",
            user_id="u3",
            palette=[red, blue],
            created_at=now - timedelta(minutes=5),
        )
    )

    # Subscribe to event bus
    EventBus().subscribe(
        PaletteTrendAnalyzer.EVENT_TOPIC,
        lambda topic, payload: logger.info(
            "Received event '%s': %s",
            topic,
            [m.to_dict() for m in payload],
        ),
    )

    analyzer = PaletteTrendAnalyzer(repo)
    scheduler = AnalysisScheduler(analyzer, interval=timedelta(seconds=10))

    try:
        with scheduler:
            # Run for ~30 seconds
            time.sleep(30)
    except KeyboardInterrupt:
        pass
```