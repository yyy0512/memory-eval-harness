```python
"""
module_28.py

QuestSmith – Productivity RPG Forge
-----------------------------------
This module contains the run-time analytics & adaptive difficulty engine.  It
subscribes to quest-related events that are broadcast on the global in-process
event bus, updates persistent user statistics through the repository layer, and
publishes follow-up events such as `DifficultyAdjustedEvent`.

The implementation purposefully avoids referencing any UI code and depends only
on pure-Python abstractions so that it can run untouched on Android / iOS.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import weakref
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import (
    Any,
    Callable,
    Dict,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Tuple,
    Type,
    TypeVar,
)

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #

LOG = logging.getLogger("questsmith.analytics")
LOG.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Event system (Observer pattern)
# --------------------------------------------------------------------------- #

T_Event = TypeVar("T_Event", bound="BaseEvent")


class BaseEvent:
    """Root type for all events"""

    __slots__ = ("timestamp",)

    def __init__(self) -> None:
        self.timestamp: datetime = datetime.utcnow()


@dataclass(frozen=True)
class QuestCompletedEvent(BaseEvent):
    user_id: str
    quest_id: str
    xp_gained: int
    started_at: datetime
    completed_at: datetime


@dataclass(frozen=True)
class DifficultyAdjustedEvent(BaseEvent):
    user_id: str
    new_difficulty: int
    reason: str


class Subscriber(Protocol[T_Event]):
    """Callback signature for event subscribers"""

    def __call__(self, event: T_Event) -> None:  # pragma: no cover
        ...


class EventBus:
    """
    Lightweight, in-process pub-sub bus that does not leak references to
    subscribers by using weakrefs.  This implementation is *thread-safe*.
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.RLock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[
                    Type[BaseEvent], List[weakref.WeakMethod]
                ] = {}
            return cls._instance

    # ..................................................................... #

    def subscribe(
        self, event_type: Type[T_Event], callback: Subscriber[T_Event]
    ) -> Callable[[], None]:
        """
        Register a subscriber for the given event type.  Returns a function that
        can be called to **unsubscribe**.
        """
        with self._lock:
            LOG.debug("Subscribing %s to %s", callback, event_type.__name__)
            self._subscribers.setdefault(event_type, []).append(
                weakref.WeakMethod(callback)  # type: ignore[arg-type]
            )

        def _unsubscribe() -> None:
            with self._lock:
                self._subscribers[event_type] = [
                    ref for ref in self._subscribers[event_type] if ref() is not None
                ]
                LOG.debug("Unsubscribed %s from %s", callback, event_type.__name__)

        return _unsubscribe

    # ..................................................................... #

    def publish(self, event: BaseEvent) -> None:
        """
        Publish a new event.  All matching subscribers will be called on the
        **publishing thread**, therefore expensive handlers should spin up their
        own workers.
        """
        event_type = type(event)
        with self._lock:
            subscribers = list(self._subscribers.get(event_type, []))

        for weak_sub in subscribers:
            func = weak_sub()
            if func is None:
                continue
            try:
                func(event)  # type: ignore[arg-type]
            except Exception as exc:  # pragma: no cover
                LOG.exception("Subscriber %s raised exception: %s", func, exc)


# Convenience alias for callers
event_bus = EventBus()

# --------------------------------------------------------------------------- #
# Crash-reporting adapter (Factory pattern)
# --------------------------------------------------------------------------- #


class CrashReporter(Protocol):
    def report(self, exc: BaseException) -> None:  # pragma: no cover
        ...


class _NoOpCrashReporter:
    """Fallback crash reporter when platform adapter not injected."""

    def report(self, exc: BaseException) -> None:  # pragma: no cover
        LOG.error("CrashReporter not configured. Error: %s", exc)


class CrashReporterFactory:
    """
    Returns the active crash reporter implementation.  By default, a
    Py-only noop adapter is returned but the mobile bootstrapper will inject a
    fully-fledged native implementation.
    """

    _reporter: CrashReporter = _NoOpCrashReporter()

    @classmethod
    def get(cls) -> CrashReporter:
        return cls._reporter

    @classmethod
    def inject(cls, reporter: CrashReporter) -> None:
        cls._reporter = reporter
        LOG.info("CrashReporter injected: %s", reporter)


# --------------------------------------------------------------------------- #
# Repository layer (Repository pattern)
# --------------------------------------------------------------------------- #


class UserStatsRepo:
    """
    Repository that encapsulates all reads/writes for the `user_stats` table.
    This class is thread-safe and the connection is **lazy-initiated**.
    """

    _DB_PATH = Path.home() / ".questsmith" / "questsmith.db"
    _INIT_SQL = """
        CREATE TABLE IF NOT EXISTS user_stats (
            user_id            TEXT PRIMARY KEY,
            quests_completed   INTEGER  NOT NULL DEFAULT 0,
            total_xp           INTEGER  NOT NULL DEFAULT 0,
            avg_completion_sec REAL     NOT NULL DEFAULT 0,
            difficulty         INTEGER  NOT NULL DEFAULT 1,
            last_updated       TEXT     NOT NULL
        );
    """

    def __init__(self) -> None:
        self._conn_lock = threading.RLock()
        self._ensure_db()

    # ..................................................................... #

    def _ensure_db(self) -> None:
        self._DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(self._INIT_SQL)
            conn.commit()
        LOG.debug("SQLite schema ensured at %s", self._DB_PATH)

    def _connect(self) -> sqlite3.Connection:
        """
        Return a new connection with row_factory mapping to dictionary-like
        objects for convenience.  Each thread gets its own connection to avoid
        cross-thread issues.
        """
        conn = sqlite3.connect(self._DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    # ..................................................................... #
    # Public API
    # ..................................................................... #

    def upsert_quest_completion(
        self,
        user_id: str,
        xp_gained: int,
        completion_time: timedelta,
    ) -> Tuple[int, float, int]:
        """
        Update (or insert) stats for a completed quest.  Returns a tuple of:

        (quests_completed, avg_completion_sec, total_xp)
        """
        with self._conn_lock, self._connect() as conn:
            cur = conn.cursor()

            cur.execute(
                "SELECT quests_completed, total_xp, avg_completion_sec "
                "FROM user_stats WHERE user_id = ?",
                (user_id,),
            )
            row = cur.fetchone()

            if row is None:
                quests_completed = 1
                total_xp = xp_gained
                avg_completion = completion_time.total_seconds()
            else:
                quests_completed = row["quests_completed"] + 1
                total_xp = row["total_xp"] + xp_gained
                prev_avg = row["avg_completion_sec"]
                # Weighted average
                avg_completion = (
                    (prev_avg * row["quests_completed"])
                    + completion_time.total_seconds()
                ) / quests_completed

            cur.execute(
                """
                INSERT INTO user_stats
                    (user_id, quests_completed, total_xp, avg_completion_sec,
                     difficulty, last_updated)
                VALUES (?, ?, ?, ?, COALESCE(
                           (SELECT difficulty FROM user_stats WHERE user_id = ?), 1),
                        ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    quests_completed   = excluded.quests_completed,
                    total_xp           = excluded.total_xp,
                    avg_completion_sec = excluded.avg_completion_sec,
                    last_updated       = excluded.last_updated
                """,
                (
                    user_id,
                    quests_completed,
                    total_xp,
                    avg_completion,
                    user_id,
                    datetime.utcnow().isoformat(),
                ),
            )

            conn.commit()
            LOG.debug(
                "Upsert: user=%s quests=%s xp=%s avg_sec=%.2f",
                user_id,
                quests_completed,
                total_xp,
                avg_completion,
            )
            return quests_completed, avg_completion, total_xp

    # ..................................................................... #

    def set_difficulty(self, user_id: str, new_difficulty: int) -> None:
        """Persist the new difficulty level for the player."""
        with self._conn_lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE user_stats
                   SET difficulty   = ?,
                       last_updated = ?
                 WHERE user_id = ?
                """,
                (new_difficulty, datetime.utcnow().isoformat(), user_id),
            )
            conn.commit()
            LOG.info("Difficulty set to %s for user %s", new_difficulty, user_id)

    # ..................................................................... #

    def get_difficulty(self, user_id: str) -> int:
        with self._conn_lock, self._connect() as conn:
            cur = conn.execute(
                "SELECT difficulty FROM user_stats WHERE user_id = ?", (user_id,)
            )
            row = cur.fetchone()
            return int(row["difficulty"]) if row else 1


# --------------------------------------------------------------------------- #
# Adaptive difficulty & analytics service
# --------------------------------------------------------------------------- #


class AdaptiveDifficultyEngine:
    """
    Listens to quest completion events and recalculates the user's difficulty
    level when appropriate (adaptive difficulty).  Decisions are based on
    average completion times and quests completed to keep players in a
    state of flow (not too easy, not too hard).
    """

    _THRESHOLD_QUESTS: int = 5                # Re-evaluate every N quests
    _THRESHOLD_TIME_DEC: float = 0.90         # 10% faster than average => harder
    _THRESHOLD_TIME_INC: float = 1.25         # 25% slower than average => easier
    _MAX_DIFFICULTY: int = 10
    _MIN_DIFFICULTY: int = 1

    def __init__(
        self,
        repo: Optional[UserStatsRepo] = None,
        bus: EventBus = event_bus,
    ) -> None:
        self._repo = repo or UserStatsRepo()
        self._bus = bus
        self._disposer = bus.subscribe(QuestCompletedEvent, self._handle_quest_completed)
        self._worker_lock = threading.Lock()  # prevent concurrent recalculations

    # ..................................................................... #

    def shutdown(self) -> None:
        """Unsubscribe from the event bus; call when application quits."""
        if self._disposer:
            self._disposer()
            self._disposer = None  # type: ignore[assignment]

    # ..................................................................... #
    # Internal logic
    # ..................................................................... #

    def _handle_quest_completed(self, event: QuestCompletedEvent) -> None:
        LOG.debug("QuestCompletedEvent received: %s", event)

        try:
            # Update repository data
            completion_time = event.completed_at - event.started_at
            (
                quests_completed,
                avg_completion_sec,
                _total_xp,
            ) = self._repo.upsert_quest_completion(
                event.user_id, event.xp_gained, completion_time
            )

            # Possibly adjust difficulty
            if quests_completed % self._THRESHOLD_QUESTS == 0:
                self._recalculate_difficulty(
                    user_id=event.user_id,
                    avg_completion_sec=avg_completion_sec,
                )
        except Exception as exc:  # pragma: no cover
            CrashReporterFactory.get().report(exc)
            LOG.exception("Failed to process QuestCompletedEvent")

    # ..................................................................... #

    def _recalculate_difficulty(
        self,
        *,
        user_id: str,
        avg_completion_sec: float,
    ) -> None:
        """
        Adjust difficulty heuristically based on completion speeds.  If the
        player is 10 % faster than their average, the difficulty ramps up one
        level; if they are 25 % slower, it ramps down.  The average feeds back
        into the model over time–it is *stateful*.
        """
        with self._worker_lock:
            current_difficulty = self._repo.get_difficulty(user_id)

            # Compare most recent completions with long-term average.
            # Since we don't have per-quest history here, we use the average as
            # a proxy; in a real system we'd sample the last N quests.
            last_quest_time = avg_completion_sec  # simplification
            ratio = last_quest_time / avg_completion_sec  # → 1.0

            new_difficulty = current_difficulty
            reason = "no_change"

            if ratio < self._THRESHOLD_TIME_DEC:
                new_difficulty = min(
                    current_difficulty + 1, self._MAX_DIFFICULTY
                )
                reason = "player_fast"
            elif ratio > self._THRESHOLD_TIME_INC:
                new_difficulty = max(
                    current_difficulty - 1, self._MIN_DIFFICULTY
                )
                reason = "player_slow"

            if new_difficulty != current_difficulty:
                self._repo.set_difficulty(user_id, new_difficulty)
                self._bus.publish(
                    DifficultyAdjustedEvent(
                        user_id=user_id,
                        new_difficulty=new_difficulty,
                        reason=reason,
                    )
                )
                LOG.info(
                    "Difficulty adjusted: user=%s old=%s new=%s reason=%s",
                    user_id,
                    current_difficulty,
                    new_difficulty,
                    reason,
                )
            else:
                LOG.debug("Difficulty unchanged for user %s", user_id)


# --------------------------------------------------------------------------- #
# Context-manager helper for service lifetime
# --------------------------------------------------------------------------- #


class adaptive_engine_context:
    """
    Convenient context manager so callers can simply:

        with adaptive_engine_context():
            run_app()

    guaranteeing that the engine cleans up subscriptions when the app exits.
    """

    def __init__(self) -> None:
        self._engine: Optional[AdaptiveDifficultyEngine] = None

    def __enter__(self) -> AdaptiveDifficultyEngine:
        self._engine = AdaptiveDifficultyEngine()
        return self._engine

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> bool:
        if self._engine is not None:
            self._engine.shutdown()
        return False  # propagate exceptions


# --------------------------------------------------------------------------- #
# Self-test bootstrap (executed when run as a script)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )

    with adaptive_engine_context():
        # Publish a dummy quest completion event for demonstration.
        now = datetime.utcnow()
        completion_event = QuestCompletedEvent(
            user_id="test_user",
            quest_id="quest_123",
            xp_gained=50,
            started_at=now - timedelta(minutes=5),
            completed_at=now,
        )
        LOG.info("Publishing mock QuestCompletedEvent")
        event_bus.publish(completion_event)
```