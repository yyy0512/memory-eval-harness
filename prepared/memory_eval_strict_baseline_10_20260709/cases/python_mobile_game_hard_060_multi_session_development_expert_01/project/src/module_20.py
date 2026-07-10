```python
"""
QuestSmith – Adaptive Difficulty & Analytics Engine
===================================================

This module implements the analytics backbone responsible for
adapting quest difficulty to the player’s historical performance.
It observes quest-related events, derives rolling statistics, and
publishes difficulty-update events that other layers (e.g., View-
Models, Reward Calculators) can react to.

Patterns used
-------------
* Repository Pattern   – abstracts persistent stats store (SQLite)
* Observer  Pattern    – event bus for decoupled communication
* Factory   Pattern    – pluggable repository / bus implementations
* MVVM friendly        – side-effect-free core, UI layer subscribes
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Coroutine, Deque, Dict, List, Optional, Protocol, Sequence, Tuple

###############################################################################
# Logging setup
###############################################################################

LOG = logging.getLogger("questsmith.adaptive")
LOG.setLevel(logging.DEBUG)

###############################################################################
# Event Bus (Observer Pattern)
###############################################################################


class Event:
    """Base class for all events."""
    timestamp: float

    def __init__(self) -> None:
        self.timestamp = time.time()


class Subscriber(Protocol):
    """Callable type that can be subscribed to an event."""

    def __call__(self, event: Event) -> None: ...


class EventBus:
    """
    Thread-safe, in-process publish/subscribe message bus.

    A lightweight implementation sufficient for domain-level events.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[type[Event], List[Subscriber]] = {}
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Subscription
    # --------------------------------------------------------------------- #
    def subscribe(self, event_type: type[Event], fn: Subscriber) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(fn)
            LOG.debug("Subscriber %s registered for %s", fn, event_type.__name__)

    def unsubscribe(self, event_type: type[Event], fn: Subscriber) -> None:
        with self._lock:
            if event_type in self._subscribers and fn in self._subscribers[event_type]:
                self._subscribers[event_type].remove(fn)
                LOG.debug("Subscriber %s removed from %s", fn, event_type.__name__)

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #
    def publish(self, event: Event) -> None:
        LOG.debug("Publishing event %s", event)
        subscribers = []
        with self._lock:
            subscribers = list(self._subscribers.get(type(event), []))

        # Dispatch outside the lock to avoid deadlocks if subscriber publishes
        # another event synchronously.
        for fn in subscribers:
            try:
                fn(event)
            except Exception:  # noqa: BLE001
                LOG.exception("Unhandled exception in subscriber %s", fn)


###############################################################################
# Domain Events
###############################################################################


@dataclass(slots=True)
class QuestCompletedEvent(Event):
    quest_id: str
    user_id: str
    duration_seconds: int
    success: bool  # True if completed within time/constraints


@dataclass(slots=True)
class DifficultyUpdatedEvent(Event):
    user_id: str
    new_multiplier: float


###############################################################################
# Repository Layer – persistent analytics store
###############################################################################


@dataclass(slots=True)
class QuestPerformance:
    """
    Lightweight DTO to persist player-level metrics which the difficulty
    engine feeds off.
    """

    user_id: str
    ema_success_rate: float = 1.0  # Exponential Moving Average (0..1)
    ema_duration: float = 0.0      # Seconds
    difficulty_multiplier: float = 1.0
    last_updated: float = field(default_factory=time.time)


class IPerformanceRepository(Protocol):
    """Required interface for performance persistence."""

    # Read
    def load(self, user_id: str) -> QuestPerformance | None: ...
    # Write
    def save(self, perf: QuestPerformance) -> None: ...


class SQLitePerformanceRepository(IPerformanceRepository):
    """
    Simple SQLite implementation.
    DB schema:
        CREATE TABLE IF NOT EXISTS quest_performance (
            user_id TEXT PRIMARY KEY,
            ema_success_rate REAL NOT NULL,
            ema_duration      REAL NOT NULL,
            difficulty_multiplier REAL NOT NULL,
            last_updated      REAL NOT NULL
        );
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with self._conn() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS quest_performance (
                    user_id TEXT PRIMARY KEY,
                    ema_success_rate REAL NOT NULL,
                    ema_duration REAL NOT NULL,
                    difficulty_multiplier REAL NOT NULL,
                    last_updated REAL NOT NULL
                )
                """
            )

    # ------------------------------------------------------------------ #
    # API
    # ------------------------------------------------------------------ #
    def load(self, user_id: str) -> QuestPerformance | None:
        with self._conn() as cur:
            row = cur.execute(
                "SELECT * FROM quest_performance WHERE user_id=?", (user_id,)
            ).fetchone()
            if not row:
                return None
            return QuestPerformance(
                user_id=row["user_id"],
                ema_success_rate=row["ema_success_rate"],
                ema_duration=row["ema_duration"],
                difficulty_multiplier=row["difficulty_multiplier"],
                last_updated=row["last_updated"],
            )

    def save(self, perf: QuestPerformance) -> None:
        with self._conn() as cur:
            cur.execute(
                """
                INSERT INTO quest_performance
                (user_id, ema_success_rate, ema_duration,
                 difficulty_multiplier, last_updated)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    ema_success_rate=excluded.ema_success_rate,
                    ema_duration=excluded.ema_duration,
                    difficulty_multiplier=excluded.difficulty_multiplier,
                    last_updated=excluded.last_updated
                """,
                (
                    perf.user_id,
                    perf.ema_success_rate,
                    perf.ema_duration,
                    perf.difficulty_multiplier,
                    perf.last_updated,
                ),
            )

    # ------------------------------------------------------------------ #
    # Internal
    # ------------------------------------------------------------------ #
    @contextlib.contextmanager
    def _conn(self) -> "sqlite3.Cursor":
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn.cursor()
            conn.commit()
        finally:
            conn.close()


###############################################################################
# Adaptive Difficulty Engine
###############################################################################


class AdaptiveDifficultyEngine:
    """
    Core analytics component that keeps the game ‘in the zone’ by
    keeping challenge roughly aligned to the user’s skill level.
    """

    # --- Constants – tuned after live-ops experimentation ------------- #
    _EMA_ALPHA = 0.15  # Decay factor for exponential moving averages
    _SUCCESS_RATE_TARGET = 0.85
    _DURATION_TARGET_FACTOR = 0.8
    _MIN_MULTIPLIER = 0.5
    _MAX_MULTIPLIER = 3.0
    _ANALYTICS_WINDOW = 100  # number of quests to hold in memory

    def __init__(
        self,
        repository: IPerformanceRepository,
        event_bus: EventBus,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._repo = repository
        self._bus = event_bus
        self._loop = loop or asyncio.get_event_loop()
        self._buffers: Dict[str, Deque[QuestCompletedEvent]] = {}
        # Register for QuestCompletedEvent
        self._bus.subscribe(QuestCompletedEvent, self._on_quest_completed)
        LOG.info("AdaptiveDifficultyEngine initialised")

    # ---------------------------------------------------------------- #
    # Event Handlers
    # ---------------------------------------------------------------- #
    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        LOG.debug("QuestCompleted received: %s", event)
        buffer_ = self._buffers.setdefault(event.user_id, deque(maxlen=self._ANALYTICS_WINDOW))
        buffer_.append(event)
        # Process asynchronously to avoid blocking UI thread
        asyncio.run_coroutine_threadsafe(
            self._process_event(event.user_id), self._loop
        )

    async def _process_event(self, user_id: str) -> None:
        perf = self._repo.load(user_id) or QuestPerformance(user_id=user_id)
        buffer_ = self._buffers[user_id]

        # Recalculate EMA success rate
        recent_success = 1.0 if buffer_[-1].success else 0.0
        perf.ema_success_rate = self._ema(
            previous=perf.ema_success_rate,
            current=recent_success,
            alpha=self._EMA_ALPHA,
        )

        # Recalculate EMA duration (only consider successful quests)
        durations = [e.duration_seconds for e in buffer_ if e.success]
        if durations:
            current_avg_duration = statistics.mean(durations)
            perf.ema_duration = self._ema(
                previous=perf.ema_duration or current_avg_duration,
                current=current_avg_duration,
                alpha=self._EMA_ALPHA,
            )

        # Determine new difficulty multiplier
        new_multiplier = self._compute_multiplier(perf)
        # Clamp value
        new_multiplier = max(self._MIN_MULTIPLIER, min(new_multiplier, self._MAX_MULTIPLIER))

        # Early exit if unchanged to reduce churn
        if abs(new_multiplier - perf.difficulty_multiplier) < 0.01:
            LOG.debug("Multiplier unchanged (%.2f)", perf.difficulty_multiplier)
            return

        # Persist & notify
        perf.difficulty_multiplier = new_multiplier
        perf.last_updated = time.time()
        try:
            self._repo.save(perf)
            self._bus.publish(DifficultyUpdatedEvent(user_id=user_id, new_multiplier=new_multiplier))
            LOG.info(
                "Difficulty updated for %s -> %.2f (EMA success: %.2f, EMA duration: %.1fs)",
                user_id,
                new_multiplier,
                perf.ema_success_rate,
                perf.ema_duration,
            )
        except Exception:  # noqa: BLE001
            LOG.exception("Failed to update difficulty for user %s", user_id)

    # ---------------------------------------------------------------- #
    # Helpers
    # ---------------------------------------------------------------- #
    @staticmethod
    def _ema(*, previous: float, current: float, alpha: float) -> float:
        """Exponential moving average."""
        return (alpha * current) + ((1 - alpha) * previous)

    def _compute_multiplier(self, perf: QuestPerformance) -> float:
        """
        Simple heuristic:
        - If success rate exceeds target AND average duration below target,
          ramp difficulty up, else down.
        """
        success_delta = perf.ema_success_rate - self._SUCCESS_RATE_TARGET
        # If no duration data yet, base only on success rate
        duration_factor = (
            (perf.ema_duration or 1.0) / (self._DURATION_TARGET_FACTOR * (perf.ema_duration or 1.0))
        )
        adjustment = 1.0 + (success_delta * 0.5) - ((duration_factor - 1.0) * 0.25)
        return perf.difficulty_multiplier * adjustment

    # ---------------------------------------------------------------- #
    # Public API – may be used by ViewModels for immediate reads
    # ---------------------------------------------------------------- #
    def get_current_multiplier(self, user_id: str) -> float:
        """Fetch last known multiplier without mutating state."""
        perf = self._repo.load(user_id)
        return perf.difficulty_multiplier if perf else 1.0


###############################################################################
# Factory helpers
###############################################################################


def create_default_engine(db_file: Path | str = "data/analytics.sqlite3") -> AdaptiveDifficultyEngine:
    """Convenience factory for production use."""
    repository = SQLitePerformanceRepository(db_file)
    bus = EventBus()
    loop = asyncio.get_event_loop()
    return AdaptiveDifficultyEngine(repository=repository, event_bus=bus, loop=loop)


###############################################################################
# CLI testing harness (optional)
###############################################################################

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)

    # Spin up engine
    engine = create_default_engine(":memory:")
    bus = engine._bus  # Type: ignore[attr-defined]
    user = "demo_user"

    # Simulate quest completions
    for i in range(30):
        ev = QuestCompletedEvent(
            quest_id=f"quest_{i}",
            user_id=user,
            duration_seconds=300 - i * 2,
            success=i % 5 != 0,
        )
        bus.publish(ev)
        time.sleep(0.05)  # give async loop time to process

    print("Final multiplier:", engine.get_current_multiplier(user))
```