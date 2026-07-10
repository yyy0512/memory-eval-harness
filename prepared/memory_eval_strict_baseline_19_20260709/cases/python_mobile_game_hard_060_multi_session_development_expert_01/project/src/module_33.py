```python
"""
QuestSmith – Adaptive Difficulty Engine
---------------------------------------

This module contains a small, self-contained implementation of an adaptive
difficulty engine that reacts to quest-completion events and continuously
adjusts a per-user difficulty level persisted in SQLite.  It demonstrates a
subset of QuestSmith’s architecture patterns:

* Observer Pattern       – EventBus with publish / subscribe
* Repository Pattern     – DifficultyRepository hides SQLite access
* Factory Pattern        – `create_engine` instantiation helper
* MVVM / Clean separation – Pure business logic, no UI dependencies

The engine can be dropped into unit tests or integrated directly with the
larger QuestSmith code-base.  All external dependencies are from the Python
standard library, keeping the file self-contained yet production-ready.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import logging
import sqlite3
import statistics
import threading
import types
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Deque, Dict, List, Optional, Type, TypeVar

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #
LOGGER_NAME = "questsmith.adaptive_difficulty"
_logger = logging.getLogger(LOGGER_NAME)
if not _logger.handlers:
    # Prevent duplicate handlers in interactive / reload scenarios
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d – %(message)s"
        )
    )
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Event Bus (Observer Pattern)
# --------------------------------------------------------------------------- #


class Event:  # pylint: disable=too-few-public-methods
    """Base class for all events passed through the EventBus."""


T = TypeVar("T", bound=Event)
Subscriber = Callable[[T], None]


class EventBus:
    """
    Thread-safe singleton event bus that broadcasts strongly-typed events to
    registered subscribers.  Callbacks are executed in the publishing thread,
    therefore subscribers should keep handlers fast and non-blocking.
    """

    _instance: Optional["EventBus"] = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._subs: Dict[Type[Event], List[Subscriber]] = defaultdict(list)
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Singleton helpers
    # --------------------------------------------------------------------- #

    @classmethod
    def instance(cls) -> "EventBus":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: Type[T], callback: Subscriber[T]) -> None:
        """
        Register `callback` for `event_type`.  Duplicate registrations are
        ignored gracefully.
        """
        with self._lock:
            if callback not in self._subs[event_type]:
                self._subs[event_type].append(callback)
                _logger.debug("Subscribed %s to %s", callback, event_type.__name__)

    def unsubscribe(self, event_type: Type[T], callback: Subscriber[T]) -> None:
        """Remove a previously registered subscriber."""
        with self._lock:
            try:
                self._subs[event_type].remove(callback)
                _logger.debug("Unsubscribed %s from %s", callback, event_type.__name__)
            except (KeyError, ValueError):
                # Subscriber already gone – silently ignore
                pass

    def publish(self, event: T) -> None:
        """
        Broadcast `event` synchronously to all subscribers of its exact class.
        """
        _logger.debug("Publishing %s", event)
        with self._lock:
            for callback in list(self._subs.get(type(event), [])):
                try:
                    callback(event)  # type: ignore[arg-type]
                except Exception as ex:  # pylint: disable=broad-except
                    _logger.exception("Error in event subscriber %s: %s", callback, ex)


# --------------------------------------------------------------------------- #
# Event Definitions
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class QuestCompletionEvent(Event):
    """
    Raised when a quest is completed (successfully or otherwise).

    Attributes
    ----------
    user_id: str
        Unique identifier for the profile that attempted the quest.
    quest_id: str
        Identifier of the quest instance.
    succeeded: bool
        Whether the user completed the quest objectives.
    expected_duration_s: int
        Quests contain an estimate of how long they *should* take.
    actual_duration_s: int
        How long the user really spent (measured by task timer or heuristics).
    timestamp: datetime.datetime
        UTC time when the quest was resolved.
    """

    user_id: str
    quest_id: str
    succeeded: bool
    expected_duration_s: int
    actual_duration_s: int
    timestamp: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.utcnow().replace(tzinfo=_dt.timezone.utc)
    )


# --------------------------------------------------------------------------- #
# Difficulty Repository (Repository Pattern)
# --------------------------------------------------------------------------- #


class DifficultyRepository:
    """
    Persists and queries the current difficulty level for each user.  Uses an
    embedded SQLite database located in the application’s writable directory.
    Thread-safe through an internal re-entrant lock.
    """

    _DDL = """
    CREATE TABLE IF NOT EXISTS user_difficulty (
        user_id         TEXT PRIMARY KEY,
        difficulty      REAL NOT NULL CHECK(difficulty >= 0),
        last_updated    TEXT NOT NULL
    );
    """

    def __init__(self, sqlite_path: str | Path = "questsmith.db") -> None:
        self._path = str(sqlite_path)
        self._lock = threading.RLock()
        self._ensure_schema()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def get(self, user_id: str, default: float = 1.0) -> float:
        """
        Returns the stored difficulty for `user_id` or `default` if not found.
        """
        with self._connection() as conn, conn:
            cur = conn.execute(
                "SELECT difficulty FROM user_difficulty WHERE user_id = ?",
                (user_id,),
            )
            row = cur.fetchone()
            return float(row[0]) if row else default

    def set(self, user_id: str, difficulty: float) -> None:
        """
        Upsert (`insert or replace`) difficulty for `user_id`.
        """
        timestamp = _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
        with self._connection() as conn, conn:
            conn.execute(
                """
                INSERT INTO user_difficulty (user_id, difficulty, last_updated)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE
                    SET difficulty = excluded.difficulty,
                        last_updated = excluded.last_updated;
                """,
                (user_id, difficulty, timestamp),
            )
        _logger.debug(
            "Persisted difficulty %.2f for user=%s at %s", difficulty, user_id, timestamp
        )

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _ensure_schema(self) -> None:
        with self._connection() as conn, conn:
            conn.executescript(self._DDL)

    @contextlib.contextmanager
    def _connection(self) -> sqlite3.Connection:
        """
        Provide a DB-API 2.0 connection with the row factory set to return
        dictionary-like objects.  The connection is closed automatically.
        """
        conn = sqlite3.connect(self._path, detect_types=sqlite3.PARSE_DECLTYPES)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine
# --------------------------------------------------------------------------- #


class AdaptiveDifficultyEngine:
    """
    Maintains a sliding window of recent quest outcomes for each user and
    adjusts the global difficulty scalar accordingly.

    Heuristics:
    * completed quickly & successfully   → difficulty ↑
    * failed or took too long            → difficulty ↓
    * bounded to the range [0.5, 5.0]
    """

    _WINDOW_SIZE = 20  # recent quest outcomes to consider
    _MIN_DIFFICULTY = 0.5
    _MAX_DIFFICULTY = 5.0
    _ADJUSTMENT_STEP = 0.1

    def __init__(
        self,
        repository: DifficultyRepository,
        event_bus: EventBus | None = None,
    ) -> None:
        self._repo = repository
        self._bus = event_bus or EventBus.instance()
        self._histories: Dict[str, Deque[QuestCompletionEvent]] = defaultdict(
            lambda: deque(maxlen=self._WINDOW_SIZE)
        )
        self._lock = threading.RLock()
        # Register for quest completion notifications
        self._bus.subscribe(QuestCompletionEvent, self._on_quest_completed)
        _logger.info("AdaptiveDifficultyEngine initialized and subscribed to events.")

    # --------------------------------------------------------------------- #
    # Public helpers
    # --------------------------------------------------------------------- #

    def shutdown(self) -> None:
        """Unsubscribe from all events – idempotent."""
        self._bus.unsubscribe(QuestCompletionEvent, self._on_quest_completed)

    def current_difficulty(self, user_id: str) -> float:
        """Return the latest difficulty level for `user_id`."""
        return self._repo.get(user_id)

    # --------------------------------------------------------------------- #
    # Event handlers
    # --------------------------------------------------------------------- #

    def _on_quest_completed(self, evt: QuestCompletionEvent) -> None:
        """Collect stats and recalculate difficulty for the user."""
        _logger.debug("Processing QuestCompletionEvent: %s", evt)
        with self._lock:
            history = self._histories[evt.user_id]
            history.append(evt)
            new_difficulty = self._compute_difficulty(evt.user_id, history)
            self._repo.set(evt.user_id, new_difficulty)

    # --------------------------------------------------------------------- #
    # Core algorithm
    # --------------------------------------------------------------------- #

    def _compute_difficulty(
        self, user_id: str, history: Deque[QuestCompletionEvent]
    ) -> float:
        """
        Based on recent outcomes, decide if difficulty needs nudging. The logic
        uses success ratio and time efficiency.
        """
        if not history:
            return self._repo.get(user_id)

        successes = [e for e in history if e.succeeded]
        success_ratio = len(successes) / len(history)

        time_efficiencies = [
            e.expected_duration_s / max(e.actual_duration_s, 1) for e in successes
        ]

        avg_efficiency = statistics.mean(time_efficiencies) if time_efficiencies else 0

        current = self._repo.get(user_id)
        _logger.debug(
            "User=%s success=%.2f efficiency=%.2f currentDiff=%.2f",
            user_id,
            success_ratio,
            avg_efficiency,
            current,
        )

        # Very naive heuristic – can be replaced by ML in the future
        if success_ratio >= 0.8 and avg_efficiency >= 1.1:
            current += self._ADJUSTMENT_STEP
        elif success_ratio <= 0.4 or avg_efficiency <= 0.8:
            current -= self._ADJUSTMENT_STEP

        # Clamp
        current = max(self._MIN_DIFFICULTY, min(self._MAX_DIFFICULTY, current))
        _logger.info("New difficulty for user=%s → %.2f", user_id, current)
        return current


# --------------------------------------------------------------------------- #
# Factory helper (Factory Pattern)
# --------------------------------------------------------------------------- #


def create_engine(
    *,
    sqlite_path: str | Path = "questsmith.db",
    event_bus: EventBus | None = None,
) -> AdaptiveDifficultyEngine:
    """
    Build all dependencies and return a ready-to-use AdaptiveDifficultyEngine.
    """
    repo = DifficultyRepository(sqlite_path)
    return AdaptiveDifficultyEngine(repository=repo, event_bus=event_bus)


# --------------------------------------------------------------------------- #
# Optional: standalone smoke test
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    engine = create_engine(sqlite_path=":memory:")
    bus = EventBus.instance()

    # Simulate some quest outcomes
    user = "alice"
    now = _dt.datetime.utcnow().replace(tzinfo=_dt.timezone.utc)
    for i in range(25):
        evt = QuestCompletionEvent(
            user_id=user,
            quest_id=f"Q{i}",
            succeeded=i % 5 != 0,  # fail every 5th quest
            expected_duration_s=300,
            actual_duration_s=270 if i % 3 else 600,
            timestamp=now + _dt.timedelta(minutes=i),
        )
        bus.publish(evt)

    print(f"Final difficulty for {user}: {engine.current_difficulty(user):.2f}")
    engine.shutdown()
```