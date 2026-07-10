```python
"""
module_26.py
QuestSmith: Productivity RPG Forge – Adaptive Difficulty Engine
================================================================

This module contains a production-ready implementation of an adaptive
difficulty engine that analyses a player’s recent quest performance and
dynamically tunes the difficulty of upcoming quests.  The engine follows
Repository, Observer, and Factory patterns to stay decoupled from storage
and messaging layers.

Responsibilities
----------------
1. Pull recent quest-completion statistics from the QuestRepository.
2. Compute a difficulty adjustment using an exponential moving average.
3. Persist the newly-computed difficulty back to the repository.
4. Broadcast a `DifficultyAdjustedEvent` through the central EventBus so
   that other subsystems (UI widgets, analytics, notification scheduler)
   can react accordingly.

The module is deliberately self-contained: if the wider application has
its own implementations of a repository or event bus, they can be wired
in via factories.  Otherwise, lightweight default fallbacks included
here will be used instead.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from statistics import mean
from typing import List, Optional, Protocol

##############################################################################
# Logging configuration
##############################################################################

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_formatter = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s :: %(message)s"
)
_handler.setFormatter(_formatter)
logger.addHandler(_handler)

##############################################################################
# Domain models & events
##############################################################################


class DifficultyTier(str, Enum):
    """
    Human-readable difficulty tiers understood by the rest of the game.
    """

    STORY = "story"  # Extra-easy for casual users
    EASY = "easy"
    NORMAL = "normal"
    HARD = "hard"
    LEGENDARY = "legendary"  # For masochists ☠️


@dataclass(frozen=True)
class QuestCompletion:
    """
    Lightweight immutable value object summarising one quest completion.
    """

    quest_id: str
    user_id: str
    completed_at: datetime
    scheduled_duration: timedelta
    actual_duration: timedelta

    @property
    def overrun_ratio(self) -> float:
        """
        How much longer the quest took compared to planned time.  >1 means
        the user took longer than expected, <1 means faster.
        """
        # Protect against division by zero
        planned_secs = max(self.scheduled_duration.total_seconds(), 1)
        return self.actual_duration.total_seconds() / planned_secs


@dataclass(frozen=True)
class DifficultyAdjustedEvent:
    """
    Event dispatched every time the difficulty engine updates a player's
    personal difficulty tier.
    """

    user_id: str
    new_tier: DifficultyTier
    timestamp: datetime


##############################################################################
# Repository layer
##############################################################################


class QuestRepository(Protocol):
    """
    Abstract repository interface.  Concrete implementations can be backed by
    SQLite, an HTTP API, etc.
    """

    # region Quest completions ------------------------------------------------
    def get_recent_completions(
        self, user_id: str, lookback_days: int
    ) -> List[QuestCompletion]:
        ...

    # endregion

    # region Difficulty tier --------------------------------------------------
    def get_difficulty_tier(self, user_id: str) -> DifficultyTier:
        ...

    def set_difficulty_tier(
        self, user_id: str, tier: DifficultyTier, updated_at: datetime
    ) -> None:
        ...

    # endregion


class RepositoryError(RuntimeError):
    """Generic wrapper for repository-related exceptions."""


class SQLiteQuestRepository:
    """
    Minimal SQLite implementation satisfying ``QuestRepository``.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        self._ensure_schema()

    # --------------------------------------------------------------------- #
    # Public API                                                             #
    # --------------------------------------------------------------------- #

    def get_recent_completions(
        self, user_id: str, lookback_days: int = 14
    ) -> List[QuestCompletion]:
        query = """
            SELECT
                quest_id,
                completed_at,
                scheduled_duration_sec,
                actual_duration_sec
            FROM quest_completion
            WHERE user_id = ?
              AND completed_at >= ?
            ORDER BY completed_at DESC
        """
        try:
            lookback_date = datetime.utcnow() - timedelta(days=lookback_days)
            with self._cursor() as cur:
                cur.execute(query, (user_id, lookback_date.timestamp()))
                rows = cur.fetchall()
            return [
                QuestCompletion(
                    quest_id=row[0],
                    user_id=user_id,
                    completed_at=datetime.utcfromtimestamp(row[1]),
                    scheduled_duration=timedelta(seconds=row[2]),
                    actual_duration=timedelta(seconds=row[3]),
                )
                for row in rows
            ]
        except sqlite3.DatabaseError as exc:
            logger.exception("DB failure during get_recent_completions")
            raise RepositoryError from exc

    def get_difficulty_tier(self, user_id: str) -> DifficultyTier:
        query = """
            SELECT difficulty_tier
            FROM user_difficulty
            WHERE user_id = ?
        """
        try:
            with self._cursor() as cur:
                cur.execute(query, (user_id,))
                row = cur.fetchone()
            return DifficultyTier(row[0]) if row else DifficultyTier.NORMAL
        except sqlite3.DatabaseError as exc:
            logger.exception("DB failure during get_difficulty_tier")
            raise RepositoryError from exc

    def set_difficulty_tier(
        self, user_id: str, tier: DifficultyTier, updated_at: datetime
    ) -> None:
        upsert = """
            INSERT INTO user_difficulty (user_id, difficulty_tier, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE
            SET difficulty_tier = excluded.difficulty_tier,
                updated_at      = excluded.updated_at
        """
        try:
            with self._cursor(commit=True) as cur:
                cur.execute(
                    upsert,
                    (user_id, tier.value, int(updated_at.timestamp())),
                )
        except sqlite3.DatabaseError as exc:
            logger.exception("DB failure during set_difficulty_tier")
            raise RepositoryError from exc

    # --------------------------------------------------------------------- #
    # Internal utilities                                                     #
    # --------------------------------------------------------------------- #

    @contextmanager
    def _cursor(self, *, commit: bool = False):
        with self._lock:
            conn = sqlite3.connect(self._db_path, timeout=5)
            conn.execute("PRAGMA foreign_keys = ON")
            cur = conn.cursor()
            try:
                yield cur
                if commit:
                    conn.commit()
            finally:
                cur.close()
                conn.close()

    def _ensure_schema(self) -> None:
        """Creates minimal tables if they do not exist."""
        create_completion = """
            CREATE TABLE IF NOT EXISTS quest_completion (
                quest_id                TEXT NOT NULL,
                user_id                 TEXT NOT NULL,
                completed_at            INTEGER NOT NULL,
                scheduled_duration_sec  INTEGER NOT NULL,
                actual_duration_sec     INTEGER NOT NULL
            )
        """
        create_difficulty = """
            CREATE TABLE IF NOT EXISTS user_difficulty (
                user_id        TEXT PRIMARY KEY,
                difficulty_tier TEXT NOT NULL,
                updated_at     INTEGER NOT NULL
            )
        """
        with self._cursor(commit=True) as cur:
            cur.execute(create_completion)
            cur.execute(create_difficulty)


##############################################################################
# Observer/event bus pattern
##############################################################################


class EventBus(Protocol):
    """A very small subset of a Publish/Subscribe contract."""

    def publish(self, event: object) -> None: ...


class LocalEventBus:
    """Thread-safe, in-memory event bus (fallback for unit tests)."""

    def __init__(self) -> None:
        self._subscribers: list[tuple[type, callable]] = []
        self._lock = threading.RLock()

    def subscribe(self, event_type: type, callback) -> None:
        with self._lock:
            self._subscribers.append((event_type, callback))

    def publish(self, event: object) -> None:
        with self._lock:
            for ev_type, cb in self._subscribers:
                if isinstance(event, ev_type):
                    try:
                        cb(event)
                    except Exception:  # noqa: BLE001
                        logger.exception("Unhandled exception in event handler")


##############################################################################
# Core engine
##############################################################################


class AdaptiveDifficultyEngine:
    """
    Analyse recent performance and recalibrate the difficulty tier for a user.
    A smoothing factor (alpha) controls sensitivity to short-term swings.
    """

    _DEFAULT_ALPHA: float = 0.4
    _LOOKBACK_DAYS: int = 14
    _OVERRUN_HIGH: float = 1.25  # 25% slower than planned
    _OVERRUN_LOW: float = 0.85   # 15% faster than planned

    def __init__(
        self,
        repository: QuestRepository,
        event_bus: Optional[EventBus] = None,
        *,
        alpha: float | None = None,
    ) -> None:
        self._repo = repository
        self._bus = event_bus or LocalEventBus()
        self._alpha = alpha or self._DEFAULT_ALPHA
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Public API                                                             #
    # --------------------------------------------------------------------- #

    def evaluate_and_apply(self, user_id: str) -> DifficultyTier:
        """
        Primary entry point.  Analyses recent quests, decides on a new tier
        (or keeps the old one), persists it, then broadcasts an event.
        """
        with self._lock:
            recent = self._repo.get_recent_completions(
                user_id, lookback_days=self._LOOKBACK_DAYS
            )
            logger.debug("Fetched %d recent completions for %s", len(recent), user_id)

            if not recent:
                logger.info("No data for user %s; keeping existing difficulty", user_id)
                return self._repo.get_difficulty_tier(user_id)

            ema = self._compute_ema_overrun(recent)
            logger.debug("Computed EMA overrun=%.3f for user %s", ema, user_id)

            new_tier = self._determine_tier(ema)
            current_tier = self._repo.get_difficulty_tier(user_id)

            if new_tier != current_tier:
                logger.info(
                    "Difficulty change for %s: %s ➜ %s (EMA %.3f)",
                    user_id,
                    current_tier.value,
                    new_tier.value,
                    ema,
                )
                self._repo.set_difficulty_tier(user_id, new_tier, datetime.utcnow())
                self._bus.publish(
                    DifficultyAdjustedEvent(
                        user_id=user_id,
                        new_tier=new_tier,
                        timestamp=datetime.utcnow(),
                    )
                )
            else:
                logger.debug("No difficulty change for %s", user_id)

            return new_tier

    # --------------------------------------------------------------------- #
    # Internal calculations                                                  #
    # --------------------------------------------------------------------- #

    def _compute_ema_overrun(self, completions: List[QuestCompletion]) -> float:
        """
        Exponential moving average of quest overrun ratios, most-recent first.
        """
        sorted_completions = sorted(
            completions, key=lambda c: c.completed_at, reverse=True
        )
        ema: Optional[float] = None
        for record in sorted_completions:
            ratio = record.overrun_ratio
            ema = ratio if ema is None else self._alpha * ratio + (1 - self._alpha) * ema
        return ema if ema is not None else 1.0

    def _determine_tier(self, ema_overrun: float) -> DifficultyTier:
        """
        Converts the EMA value into a difficulty tier using simple thresholds
        that can later be tuned or replaced with ML models.
        """
        if ema_overrun >= self._OVERRUN_HIGH:
            # User consistently exceeds planned time ⇒ lower difficulty
            return DifficultyTier.EASY
        if ema_overrun <= self._OVERRUN_LOW:
            # User completes well ahead of schedule ⇒ increase difficulty
            return DifficultyTier.HARD
        # Otherwise keep at normal
        return DifficultyTier.NORMAL


##############################################################################
# Factory utilities (optional convenience)
##############################################################################


def build_default_engine(db_path: str) -> AdaptiveDifficultyEngine:
    """
    Convenience factory used by the main application to obtain a fully
    wired engine with concrete dependencies.
    """
    repo = SQLiteQuestRepository(db_path)
    bus = LocalEventBus()  # Could be replaced by global event bus singleton
    return AdaptiveDifficultyEngine(repository=repo, event_bus=bus)


##############################################################################
# CLI entry-point for manual testing
##############################################################################

if __name__ == "__main__":
    import argparse
    import random

    parser = argparse.ArgumentParser(description="Adaptive Difficulty Debug CLI")
    parser.add_argument("--db", default="questsmith.db", help="Path to SQLite DB")
    parser.add_argument("--user", required=True, help="User ID to evaluate")
    parser.add_argument("--simulate", action="store_true", help="Generate fake data")
    args = parser.parse_args()

    engine = build_default_engine(args.db)

    if args.simulate:
        # Faker: insert random completions in last two weeks
        db_repo: SQLiteQuestRepository = engine._repo  # type: ignore[assignment]
        now = datetime.utcnow()
        logger.info("Simulating random completions for user %s", args.user)
        for i in range(20):
            scheduled = random.randint(900, 3600)  # 15–60 mins
            actual = int(scheduled * random.uniform(0.6, 1.4))
            insert = """
                INSERT INTO quest_completion
                (quest_id, user_id, completed_at,
                 scheduled_duration_sec, actual_duration_sec)
                VALUES (?, ?, ?, ?, ?)
            """
            with db_repo._cursor(commit=True) as cur:
                cur.execute(
                    insert,
                    (
                        f"quest_{i}",
                        args.user,
                        int((now - timedelta(days=random.randint(0, 13))).timestamp()),
                        scheduled,
                        actual,
                    ),
                )

    tier = engine.evaluate_and_apply(args.user)
    print(f"New difficulty tier for {args.user}: {tier.value}")
```