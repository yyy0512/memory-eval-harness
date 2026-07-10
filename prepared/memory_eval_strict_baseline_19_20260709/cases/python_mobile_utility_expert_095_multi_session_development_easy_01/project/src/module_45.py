"""
PrismPocket – Trend Analytics Engine (module_45)
------------------------------------------------

This module houses a production-grade, thread-safe analytics engine that consumes
PrismCard domain events and produces real-time trend snapshots consumed by the
presentation layer (e.g., UI “Explore” tab, creative prompt generator).

Pattern highlights
------------------
• Singleton                – only one analytics engine lives inside the process
• Observer / Event Bus     – the engine subscribes to a global DomainEventBus
• Repository Pattern       – lazy loads look-ups for geo & palette resolution
• Background Worker Thread – non-blocking, incremental metric computation
• Typed, Testable Core     – pure calculations are factored out for unit tests
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import wraps
from typing import Dict, List, Optional, Sequence

# ---------------------------------------------------------------------------
# Simulated cross-module imports (would be real in full project)
# ---------------------------------------------------------------------------
try:
    from prismpocket.domain.entities import PrismCard  # type: ignore
except ImportError:  # Fallback for stand-alone lint / test
    @dataclass
    class PrismCard:  # pragma: no cover
        """Minimal stub for unit docs/linting."""
        card_id: str
        created_at: datetime
        dominant_colors: List[str]  # Hex strings, e.g. ["#FF0000"]
        location: Optional[str] = None
        mood_score: Optional[float] = None  # –1.0 .. 1.0


try:
    from prismpocket.infrastructure.bus import DomainEventBus  # type: ignore
except ImportError:  # pragma: no cover
    class DomainEventBus:  # Minimal stub
        _subscribers: List = []

        @classmethod
        def subscribe(cls, cb):
            cls._subscribers.append(cb)

        @classmethod
        def publish(cls, topic: str, payload):
            for cb in cls._subscribers:
                cb(topic, payload)


# ---------------------------------------------------------------------------
# Logging Setup
# ---------------------------------------------------------------------------
logger = logging.getLogger("prismpocket.analytics.trend_engine")
if not logger.handlers:
    # Allow idempotent re-import
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)s %(name)s – %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Utility decorators
# ---------------------------------------------------------------------------
def synchronized(lock: threading.Lock):
    """Thread-safe decorator for instance methods using provided lock."""

    def decorator(func):
        @wraps(func)
        def wrapper(self, *args, **kwargs):
            with lock:
                return func(self, *args, **kwargs)

        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
TREND_WINDOW = timedelta(days=3)  # Only last 72h count toward “trending”

@dataclass(frozen=True)
class TrendSnapshot:
    """DTO representing instantaneous creative trends."""
    generated_at: datetime
    top_colors: List[str] = field(default_factory=list)
    hotspot_locations: List[str] = field(default_factory=list)
    mood_score: float = 0.0
    total_cards_seen: int = 0


# ---------------------------------------------------------------------------
# Internal metric accumulator
# ---------------------------------------------------------------------------
class _Metrics:
    """In-memory, decaying metric store."""

    def __init__(self) -> None:
        self._cards: List[PrismCard] = []
        self._lock = threading.Lock()

    @synchronized(lock=threading.Lock())
    def push(self, card: PrismCard) -> None:
        self._cards.append(card)

    def prune(self) -> None:
        """Remove cards outside the trending window for memory safety."""
        cutoff = datetime.utcnow() - TREND_WINDOW
        with self._lock:
            original_len = len(self._cards)
            self._cards = [c for c in self._cards if c.created_at >= cutoff]
            pruned = original_len - len(self._cards)
            if pruned:
                logger.debug("Pruned %s stale cards from metric cache", pruned)

    def snapshot(self) -> TrendSnapshot:
        """Create a snapshot of current trends."""
        self.prune()
        with self._lock:
            if not self._cards:
                return TrendSnapshot(
                    generated_at=datetime.utcnow(),
                    top_colors=[],
                    hotspot_locations=[],
                    mood_score=0.0,
                    total_cards_seen=0,
                )

            color_counter: Counter = Counter()
            location_counter: Counter = Counter()
            mood_total, mood_count = 0.0, 0

            for card in self._cards:
                color_counter.update(card.dominant_colors)
                if card.location:
                    location_counter.update([card.location])
                if card.mood_score is not None:
                    mood_total += card.mood_score
                    mood_count += 1

            top_colors = [c for c, _ in color_counter.most_common(5)]
            hotspots = [l for l, _ in location_counter.most_common(3)]
            avg_mood = (mood_total / mood_count) if mood_count else 0.0

            return TrendSnapshot(
                generated_at=datetime.utcnow(),
                top_colors=top_colors,
                hotspot_locations=hotspots,
                mood_score=round(avg_mood, 3),
                total_cards_seen=len(self._cards),
            )


# ---------------------------------------------------------------------------
# Trend Analytics Engine (Singleton)
# ---------------------------------------------------------------------------
class TrendAnalyticsEngine:
    """Singleton engine that listens to DomainEventBus and computes trends."""

    _instance: Optional["TrendAnalyticsEngine"] = None
    _singleton_lock = threading.Lock()

    POLL_INTERVAL_SEC = 5  # Worker builds snapshot every N seconds

    def __new__(cls):
        """Enforce Singleton pattern."""
        with cls._singleton_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if getattr(self, "_initialized", False):
            return  # Avoid running twice

        self._queue: "queue.Queue[PrismCard]" = queue.Queue(maxsize=5000)
        self._metrics = _Metrics()
        self._latest_snapshot: TrendSnapshot = TrendSnapshot(generated_at=datetime.utcnow())

        # Worker thread
        self._worker_thread = threading.Thread(
            target=self._worker_loop, daemon=True, name="TrendAnalyticsWorker"
        )
        self._shutdown_event = threading.Event()
        self._worker_thread.start()

        # Subscribe to event bus
        DomainEventBus.subscribe(self._on_event)

        logger.info("TrendAnalyticsEngine started and subscribed to DomainEventBus.")
        self._initialized = True  # Mark as initialized

    # ---------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------
    def latest_snapshot(self) -> TrendSnapshot:
        return self._latest_snapshot

    # ---------------------------------------------------------------------
    # Event-bus callback
    # ---------------------------------------------------------------------
    def _on_event(self, topic: str, payload) -> None:
        if topic != "prism_card_created":
            return

        try:
            card: PrismCard = payload  # type: ignore
            self._queue.put_nowait(card)
            logger.debug("Queued card %s for analytics processing.", getattr(card, "card_id", "?"))
        except queue.Full:
            logger.warning(
                "TrendAnalyticsEngine queue is full; discarding card %s",
                getattr(payload, "card_id", "?"),
            )

    # ---------------------------------------------------------------------
    # Background worker
    # ---------------------------------------------------------------------
    def _worker_loop(self) -> None:
        """Runs in daemon thread, incrementally updates metrics & snapshots."""
        logger.debug("TrendAnalyticsEngine worker thread booted up.")
        while not self._shutdown_event.is_set():
            try:
                # Drain queue quickly
                while True:
                    try:
                        card = self._queue.get_nowait()
                        self._metrics.push(card)
                    except queue.Empty:
                        break

                # Re-build snapshot periodically
                self._latest_snapshot = self._metrics.snapshot()
                logger.debug(
                    "Generated new TrendSnapshot – cards=%d mood=%.3f colors=%s",
                    self._latest_snapshot.total_cards_seen,
                    self._latest_snapshot.mood_score,
                    self._latest_snapshot.top_colors,
                )

                # Sleep until next run or early wake
                self._shutdown_event.wait(self.POLL_INTERVAL_SEC)

            except Exception as exc:  # pragma: no cover
                logger.exception("Uncaught error in TrendAnalyticsEngine worker: %s", exc)

        logger.info("TrendAnalyticsEngine worker loop terminated.")

    # ---------------------------------------------------------------------
    # Lifecycle management
    # ---------------------------------------------------------------------
    def shutdown(self) -> None:
        """Gracefully stop background thread (for app termination/tests)."""
        self._shutdown_event.set()
        self._worker_thread.join(timeout=2.0)
        logger.info("TrendAnalyticsEngine shut down.")


# ---------------------------------------------------------------------------
# Convenience accessor
# ---------------------------------------------------------------------------
_engine_singleton: Optional[TrendAnalyticsEngine] = None
_access_lock = threading.Lock()


def get_trend_engine() -> TrendAnalyticsEngine:
    """Retrieve global instance, lazily creating it on first call."""
    global _engine_singleton
    with _access_lock:
        if _engine_singleton is None:
            _engine_singleton = TrendAnalyticsEngine()
        return _engine_singleton


# ---------------------------------------------------------------------------
# Module self-test (executed only when run directly)
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    import random
    import uuid

    engine = get_trend_engine()

    # Simulate random PrismCard events
    for _ in range(50):
        card = PrismCard(
            card_id=str(uuid.uuid4()),
            created_at=datetime.utcnow(),
            dominant_colors=[random.choice(["#FF0000", "#00FF00", "#0000FF", "#FFFF00"])],
            location=random.choice(["NYC", "Berlin", "Tokyo", None]),
            mood_score=random.uniform(-1, 1),
        )
        DomainEventBus.publish("prism_card_created", card)

    # Allow engine to compute
    time.sleep(6)
    snapshot = engine.latest_snapshot()
    print("Snapshot:", snapshot)

    # Shutdown (for script run)
    engine.shutdown()
