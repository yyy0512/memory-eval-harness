```python
"""
QuestSmith: Productivity RPG Forge
==================================

Module: src/module_18.py
------------------------

Adaptive Difficulty Engine
~~~~~~~~~~~~~~~~~~~~~~~~~~
This module contains the implementation of an adaptive–difficulty engine that
monitors quest–related events and continuously tunes the user’s difficulty
level.  Difficulty is increased when the user consistently completes quests
ahead of schedule and decreased when the user struggles.  All computations are
done locally so the game can remain fully functional offline; updates are later
synced when connectivity becomes available.

Architecture Touch-points
-------------------------
* Repository Pattern   – `DifficultySettingsRepository` (SQLite)
* Observer Pattern     – `EventBus` + `AdaptiveDifficultyEngine`
* Factory Pattern      – `build_adaptive_difficulty_engine`
* MVVM                 – View-models observe the repository for UI updates
* Adapter Pattern      – Platform-agnostic event bus & data store

The code is intentionally self-contained; external collaborators may inject
alternative implementations via the public factory function.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Deque, Dict, List, Optional, Protocol, Type, TypeVar

# -----------------------------------------------------------------------------#
# Logging Setup
# -----------------------------------------------------------------------------#
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# In a real app, handlers are configured at application bootstrap.
if not logger.handlers:  # Avoid duplicate handlers in unit-tests
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(levelname)1.1s] %(name)s: %(message)s")
    )
    logger.addHandler(_handler)

# -----------------------------------------------------------------------------#
# Event Bus (Observer Pattern)
# -----------------------------------------------------------------------------#


class Event(Protocol):
    """Base interface for all events."""


T = TypeVar("T", bound=Event)
EventHandler = Callable[[T], None]


class EventBus:
    """
    Thread-safe, in-memory event bus suitable for a mobile app.  Subscribers can
    register callbacks for a specific `Event` subclass; events are dispatched
    synchronously on the posting thread to keep the implementation light-weight.
    """

    _instance: "EventBus" = None
    _lock = threading.RLock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[Type[Event], List[EventHandler]] = {}
            return cls._instance

    # ---------------------------------------------------------------------#
    # Subscription
    # ---------------------------------------------------------------------#
    def subscribe(self, event_type: Type[T], handler: EventHandler[T]) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)
            logger.debug("EventBus: %s subscribed to %s", handler, event_type.__name__)

    def unsubscribe(self, event_type: Type[T], handler: EventHandler[T]) -> None:
        with self._lock:
            handlers = self._subscribers.get(event_type, [])
            if handler in handlers:
                handlers.remove(handler)
                logger.debug(
                    "EventBus: %s unsubscribed from %s", handler, event_type.__name__
                )

    # ---------------------------------------------------------------------#
    # Publishing
    # ---------------------------------------------------------------------#
    def publish(self, event: T) -> None:
        handlers_snapshot: List[EventHandler[T]]
        with self._lock:
            handlers_snapshot = list(self._subscribers.get(type(event), []))
        logger.debug(
            "EventBus: Publishing %s to %d subscriber(s)",
            type(event).__name__,
            len(handlers_snapshot),
        )
        for handler in handlers_snapshot:
            try:
                handler(event)
            except Exception:  # pylint: disable=broad-except
                logger.exception("EventBus: Error in event handler '%s'", handler)


# -----------------------------------------------------------------------------#
# Domain Events
# -----------------------------------------------------------------------------#


@dataclass(frozen=True, slots=True)
class QuestCompleted(Event):
    user_id: int
    quest_id: int
    expected_duration_s: float  # Duration defined at quest creation
    actual_duration_s: float  # Actual time the user spent
    timestamp: float = field(default_factory=time.time)


@dataclass(frozen=True, slots=True)
class QuestFailed(Event):
    user_id: int
    quest_id: int
    reason: str
    timestamp: float = field(default_factory=time.time)


# -----------------------------------------------------------------------------#
# Domain Objects
# -----------------------------------------------------------------------------#


class DifficultyLevel(str, Enum):
    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"
    HEROIC = "heroic"

    @property
    def multiplier(self) -> float:
        """Scaling factor for reward / XP calculation."""
        return {
            DifficultyLevel.EASY: 0.75,
            DifficultyLevel.NORMAL: 1.0,
            DifficultyLevel.HARD: 1.25,
            DifficultyLevel.HEROIC: 1.5,
        }[self]


@dataclass(slots=True)
class PerformanceSample:
    """
    A concise snapshot of a single quest attempt used by the adaptive algorithm.
    """

    success: bool
    efficiency_ratio: float  # actual / expected (lower is better)
    timestamp: float = field(default_factory=time.time)


# -----------------------------------------------------------------------------#
# Repository (SQLite)
# -----------------------------------------------------------------------------#


class DifficultySettingsRepository:
    """
    SQLite-backed repository responsible for persisting the current difficulty
    level per user.  Using a separate repository keeps the engine agnostic of
    the underlying storage details.
    """

    _ddl = """
    CREATE TABLE IF NOT EXISTS user_difficulty (
        user_id         INTEGER PRIMARY KEY,
        difficulty      TEXT     NOT NULL,
        updated_at      REAL     NOT NULL
    );
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL;")  # Better concurrency
        self._conn.execute(self._ddl)
        self._conn.commit()
        self._lock = threading.RLock()
        logger.debug("DifficultySettingsRepository initialized @ %s", self._db_path)

    # -------------------------------------------------------------------------#
    # Public API
    # -------------------------------------------------------------------------#
    def get_current_level(self, user_id: int) -> DifficultyLevel:
        with self._lock:
            cur = self._conn.execute(
                "SELECT difficulty FROM user_difficulty WHERE user_id = ?;",
                (user_id,),
            )
            row = cur.fetchone()
            level = DifficultyLevel(row[0]) if row else DifficultyLevel.NORMAL
            logger.debug(
                "Repository: Retrieved difficulty %s for user %s", level, user_id
            )
            return level

    def set_current_level(self, user_id: int, level: DifficultyLevel) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO user_difficulty (user_id, difficulty, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id)
                DO UPDATE SET difficulty=excluded.difficulty, updated_at=excluded.updated_at;
                """,
                (user_id, level.value, time.time()),
            )
            logger.info("Repository: Set user %s difficulty to %s", user_id, level)

    # -------------------------------------------------------------------------#
    # Housekeeping
    # -------------------------------------------------------------------------#
    def close(self) -> None:
        with self._lock:
            self._conn.close()
            logger.debug("DifficultySettingsRepository: Connection closed.")


# -----------------------------------------------------------------------------#
# Adaptive Difficulty Engine
# -----------------------------------------------------------------------------#


class AdaptiveDifficultyEngine:
    """
    Observes quest outcome events and continuously tunes player difficulty.
    The algorithm uses a sliding window of recent performance samples in order
    to be responsive while resisting short-term variance.

    Decision logic (subject to future ML replacement):
    --------------------------------------------------
    1. Aggregate the last `window_size` samples.
    2. Compute:
       • success_rate       (#success / window)
       • avg_efficiency     (mean efficiency_ratio for success samples only)
    3. Apply thresholds:
       • If success_rate < 0.50 or avg_efficiency > 1.25   -> decrease diff
       • If success_rate > 0.90 and avg_efficiency < 0.80  -> increase diff
    """

    # These thresholds were empirically tuned in playtests
    _SUCCESS_UPPER_THRESHOLD = 0.90
    _SUCCESS_LOWER_THRESHOLD = 0.50
    _EFFICIENCY_UPPER_THRESHOLD = 1.25
    _EFFICIENCY_LOWER_THRESHOLD = 0.80

    def __init__(
        self,
        user_id: int,
        repository: DifficultySettingsRepository,
        event_bus: EventBus,
        window_size: int = 20,
    ) -> None:
        self._user_id = user_id
        self._repo = repository
        self._bus = event_bus
        self._samples: Deque[PerformanceSample] = deque(maxlen=window_size)
        self._lock = threading.RLock()

        # Subscribe to relevant events
        self._bus.subscribe(QuestCompleted, self._handle_quest_completed)
        self._bus.subscribe(QuestFailed, self._handle_quest_failed)
        logger.info(
            "AdaptiveDifficultyEngine: Initialized for user %s (window=%s)",
            self._user_id,
            window_size,
        )

    # ---------------------------------------------------------------------#
    # Event Handlers
    # ---------------------------------------------------------------------#
    def _handle_quest_completed(self, event: QuestCompleted) -> None:
        if event.user_id != self._user_id:
            return  # Multi-profile: ignore foreign events
        efficiency = event.actual_duration_s / max(event.expected_duration_s, 1.0)
        sample = PerformanceSample(success=True, efficiency_ratio=efficiency)
        self._add_sample(sample)

    def _handle_quest_failed(self, event: QuestFailed) -> None:
        if event.user_id != self._user_id:
            return
        sample = PerformanceSample(success=False, efficiency_ratio=2.0)  # Penalize
        self._add_sample(sample)

    # ---------------------------------------------------------------------#
    # Internal Helpers
    # ---------------------------------------------------------------------#
    def _add_sample(self, sample: PerformanceSample) -> None:
        with self._lock:
            self._samples.append(sample)
            logger.debug("AdaptiveDifficultyEngine: Added sample %s", sample)
            # Only evaluate once the window has filled (avoids knee-jerk changes)
            if len(self._samples) == self._samples.maxlen:
                self._evaluate_difficulty()

    def _evaluate_difficulty(self) -> None:
        success_count = sum(1 for s in self._samples if s.success)
        total = len(self._samples)
        success_rate = success_count / total if total else 0.0

        successful_samples = [s for s in self._samples if s.success]
        avg_efficiency = (
            sum(s.efficiency_ratio for s in successful_samples) / len(successful_samples)
            if successful_samples
            else float("inf")
        )

        logger.debug(
            "AdaptiveDifficultyEngine: Evaluation — success_rate=%.2f, "
            "avg_efficiency=%.2f",
            success_rate,
            avg_efficiency,
        )

        current_level = self._repo.get_current_level(self._user_id)
        new_level = current_level  # default: unchanged

        # Decision rules
        if (
            success_rate > self._SUCCESS_UPPER_THRESHOLD
            and avg_efficiency < self._EFFICIENCY_LOWER_THRESHOLD
        ):
            new_level = self._increase_difficulty(current_level)
        elif (
            success_rate < self._SUCCESS_LOWER_THRESHOLD
            or avg_efficiency > self._EFFICIENCY_UPPER_THRESHOLD
        ):
            new_level = self._decrease_difficulty(current_level)

        if new_level != current_level:
            logger.info(
                "AdaptiveDifficultyEngine: Difficulty change %s -> %s",
                current_level,
                new_level,
            )
            self._repo.set_current_level(self._user_id, new_level)
            # Notify other systems via event bus (e.g., UI, analytics)
            self._bus.publish(UserDifficultyChanged(self._user_id, new_level))

    @staticmethod
    def _increase_difficulty(level: DifficultyLevel) -> DifficultyLevel:
        order = list(DifficultyLevel)
        idx = min(order.index(level) + 1, len(order) - 1)
        return order[idx]

    @staticmethod
    def _decrease_difficulty(level: DifficultyLevel) -> DifficultyLevel:
        order = list(DifficultyLevel)
        idx = max(order.index(level) - 1, 0)
        return order[idx]

    # ---------------------------------------------------------------------#
    # Clean-up
    # ---------------------------------------------------------------------#
    def dispose(self) -> None:
        self._bus.unsubscribe(QuestCompleted, self._handle_quest_completed)
        self._bus.unsubscribe(QuestFailed, self._handle_quest_failed)
        logger.debug("AdaptiveDifficultyEngine: Disposed for user %s", self._user_id)


# -----------------------------------------------------------------------------#
# Notification Events
# -----------------------------------------------------------------------------#


@dataclass(frozen=True, slots=True)
class UserDifficultyChanged(Event):
    user_id: int
    new_level: DifficultyLevel
    timestamp: float = field(default_factory=time.time)


# -----------------------------------------------------------------------------#
# Factory
# -----------------------------------------------------------------------------#


def build_adaptive_difficulty_engine(
    user_id: int, db_path: Path | str
) -> AdaptiveDifficultyEngine:
    """
    Factory function to create a fully wired `AdaptiveDifficultyEngine` for the
    given user.  Other modules should depend on this method rather than the
    concrete classes to keep the coupling minimal.
    """
    repo = DifficultySettingsRepository(db_path)
    bus = EventBus()  # Singleton
    engine = AdaptiveDifficultyEngine(user_id=user_id, repository=repo, event_bus=bus)
    logger.debug(
        "Factory: AdaptiveDifficultyEngine built for user %s @ %s", user_id, db_path
    )
    return engine


# -----------------------------------------------------------------------------#
# __all__
# -----------------------------------------------------------------------------#

__all__ = [
    "DifficultyLevel",
    "PerformanceSample",
    "DifficultySettingsRepository",
    "AdaptiveDifficultyEngine",
    "build_adaptive_difficulty_engine",
    "QuestCompleted",
    "QuestFailed",
    "UserDifficultyChanged",
    "EventBus",
]
```