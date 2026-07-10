```python
"""
module_35.py
QuestSmith: Productivity RPG Forge ─ Adaptive Difficulty Engine

This module implements a lightweight analytics layer that continuously
monitors quest–completion outcomes and adapts future quest difficulty on a
per-user / per-quest-type basis.  The implementation showcases the Repository,
Observer and Factory patterns used throughout the monolith while keeping the
core logic framework-agnostic and easily unit-testable.

Key Concepts
------------
• Repository Pattern
  - DifficultyRepository encapsulates all SQLite persistence concerns,
    delivering a clean domain-model API to higher layers.

• Observer Pattern
  - AdaptiveDifficultyEngine subscribes to QuestCompletedEvent publications
    on the global EventBus and reacts by persisting analytics + recalculating
    difficulty coefficients.

• Thread-Safety
  - A re-entrant lock guards critical sections that mutate shared state or
    SQLite connections, ensuring correctness when EventBus dispatches on
    background threads (e.g., push-notification workers).

Author: QuestSmith Engineering
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import logging
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Callable, Dict, Iterable, List, Optional, Tuple, Union

###############################################################################
# Logging Configuration
###############################################################################

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
)
logger.addHandler(_handler)

###############################################################################
# Event Bus (Observer Pattern)
###############################################################################


class EventBus:
    """
    Extremely small footprint event bus suitable for in-process pub/sub.
    This is *not* a message broker; it simply dispatches to registered callables.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[..., None]]] = {}
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, topic: str, handler: Callable[..., None]) -> None:
        with self._lock:
            self._subscribers.setdefault(topic, []).append(handler)
            logger.debug("Handler %s subscribed to %s", handler, topic)

    def unsubscribe(self, topic: str, handler: Callable[..., None]) -> None:
        with self._lock:
            try:
                self._subscribers[topic].remove(handler)
            except (KeyError, ValueError):
                logger.warning("Tried to unsubscribe non-registered handler.")

    def publish(self, topic: str, **payload) -> None:
        with self._lock:
            handlers = list(self._subscribers.get(topic, []))  # Shallow copy
        for handler in handlers:
            try:
                handler(**payload)
            except Exception:  # noqa: BLE001
                logger.exception("Unhandled exception in event handler '%s'.", topic)


# A process-wide global bus is sufficient for the mobile monolith.
GLOBAL_EVENT_BUS = EventBus()

###############################################################################
# Domain Events
###############################################################################


@dataclass(slots=True, frozen=True)
class QuestCompletedEvent:
    user_id: int
    quest_id: int
    quest_type: str
    baseline_difficulty: float
    completion_time_sec: int
    succeeded: bool
    timestamp: _dt.datetime = _dt.datetime.utcnow()


###############################################################################
# Repository Pattern
###############################################################################


class DifficultyRepository:
    """
    SQLite-backed persistence store for adaptive-difficulty data.
    """

    # Schema DDL
    _DDL = """
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS players (
        id                     INTEGER PRIMARY KEY,
        difficulty_modifier    REAL    NOT NULL DEFAULT 1.0,
        modifier_updated_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quest_completion (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                INTEGER NOT NULL,
        quest_type             TEXT    NOT NULL,
        baseline_difficulty    REAL    NOT NULL,
        completion_time        INTEGER NOT NULL,
        succeeded              INTEGER NOT NULL,
        ts                     TEXT    NOT NULL,
        FOREIGN KEY (user_id) REFERENCES players(id)
    );

    CREATE INDEX IF NOT EXISTS idx_completion_user_type_ts
        ON quest_completion (user_id, quest_type, ts);
    """

    def __init__(self, db_path: Union[str, Path] = "questsmith.db") -> None:
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._ensure_schema()

    # ------------------------------------------------------------------ #
    # Context Management
    # ------------------------------------------------------------------ #

    def __enter__(self) -> "DifficultyRepository":
        self._connect()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: D401
        self._disconnect()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def record_completion(self, ev: QuestCompletedEvent) -> None:
        """
        Persist a QuestCompletedEvent.
        """
        with self._lock, self._conn:  # Auto-commit
            self._conn.execute(
                """
                INSERT INTO quest_completion
                    (user_id, quest_type, baseline_difficulty, completion_time,
                     succeeded, ts)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    ev.user_id,
                    ev.quest_type,
                    ev.baseline_difficulty,
                    ev.completion_time_sec,
                    1 if ev.succeeded else 0,
                    ev.timestamp.isoformat(sep=" ", timespec="seconds"),
                ),
            )

    def fetch_recent_completions(
        self,
        user_id: int,
        quest_type: str,
        limit: int = 25,
    ) -> List[Tuple[int, bool]]:
        """
        Returns completion_time_sec and succeeded for the last <limit> quests.
        """
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT completion_time, succeeded
                FROM quest_completion
                WHERE user_id = ? AND quest_type = ?
                ORDER BY ts DESC
                LIMIT ?;
                """,
                (user_id, quest_type, limit),
            )
            return [(row[0], bool(row[1])) for row in cur]

    def get_modifier(self, user_id: int) -> float:
        """
        Returns the current difficulty_modifier for the user (defaults to 1.0).
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT difficulty_modifier FROM players WHERE id = ?;", (user_id,)
            )
            row = cur.fetchone()
            return row[0] if row else 1.0

    def set_modifier(self, user_id: int, modifier: float) -> None:
        now = _dt.datetime.utcnow().isoformat(sep=" ", timespec="seconds")
        with self._lock, self._conn:  # Auto-commit
            self._conn.execute(
                """
                INSERT INTO players (id, difficulty_modifier, modifier_updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    difficulty_modifier = excluded.difficulty_modifier,
                    modifier_updated_at = excluded.modifier_updated_at;
                """,
                (user_id, modifier, now),
            )

    # ------------------------------------------------------------------ #
    # Internal Helpers
    # ------------------------------------------------------------------ #

    def _connect(self) -> None:
        if self._conn is None:
            try:
                self._conn = sqlite3.connect(
                    self._db_path,
                    detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES,
                    check_same_thread=False,  # We'll handle locking ourselves.
                )
                self._conn.row_factory = sqlite3.Row
            except sqlite3.Error as exc:  # noqa: BLE001
                logger.exception("Failed to connect to DB at %s.", self._db_path)
                raise RuntimeError("Database connection error") from exc

    def _disconnect(self) -> None:
        if self._conn:
            self._conn.close()
        self._conn = None

    def _ensure_schema(self) -> None:
        self._connect()
        with self._conn:
            self._conn.executescript(self._DDL)


###############################################################################
# Adaptive Difficulty Engine
###############################################################################


class AdaptiveDifficultyEngine:
    """
    Calculates personalised difficulty scaling coefficients, persisting them
    in the repository and exposing a query API for other subsystems.
    """

    _SUCCESS_TARGET = 0.80  # ‑— The desired success rate we want players at
    _CLAMP_RANGE = (0.5, 2.0)  # ‑— Hard bounds on difficulty modifiers
    _WINDOW_SIZE = 20  # ‑— Number of recent completions considered

    def __init__(
        self,
        repo: DifficultyRepository,
        event_bus: EventBus = GLOBAL_EVENT_BUS,
    ):
        self._repo = repo
        self._bus = event_bus
        self._lock = threading.RLock()

        # Subscribe to quest completion events
        self._bus.subscribe("quest_completed", self._on_quest_completed)
        logger.info("AdaptiveDifficultyEngine initialised and listening.")

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def recommended_difficulty(
        self, user_id: int, baseline: float, quest_type: str | None = None
    ) -> float:
        """
        Returns a scaled difficulty value for new quests.

        Parameters
        ----------
        user_id : int
            Player identifier.
        baseline : float
            Raw difficulty points assigned by the quest generator.
        quest_type : str | None
            Optional quest_type hint for debugging/logging; not used otherwise.

        Returns
        -------
        float
            The difficulty points after adaptive scaling.
        """
        modifier = self._repo.get_modifier(user_id)
        adjusted = baseline * modifier
        logger.debug(
            "Difficulty adjusted: baseline %.2f × modifier %.2f = %.2f",
            baseline,
            modifier,
            adjusted,
        )
        return adjusted

    # ------------------------------------------------------------------ #
    # Event Handling
    # ------------------------------------------------------------------ #

    def _on_quest_completed(self, **payload) -> None:  # noqa: D401
        """
        Handler wired to QuestCompleted events.
        """
        try:
            ev = QuestCompletedEvent(**payload)  # type: ignore[arg-type]
        except TypeError:
            logger.error(
                "Malformed payload for QuestCompletedEvent: %s", payload, exc_info=True
            )
            return

        # Persist event
        with contextlib.suppress(Exception):
            self._repo.record_completion(ev)

        # Recalculate difficulty asynchronously
        threading.Thread(
            target=self._recalculate_modifier,
            args=(ev.user_id, ev.quest_type),
            daemon=True,
        ).start()

    # ------------------------------------------------------------------ #
    # Internal Logic
    # ------------------------------------------------------------------ #

    def _recalculate_modifier(self, user_id: int, quest_type: str) -> None:
        with self._lock:
            history = self._repo.fetch_recent_completions(
                user_id, quest_type, self._WINDOW_SIZE
            )
            if len(history) < 5:  # Need some data before adapting.
                return

            success_rate = mean(s for _, s in history)
            # Logistic scaling around target success rate:
            diff = (success_rate - self._SUCCESS_TARGET) / self._SUCCESS_TARGET
            current_modifier = self._repo.get_modifier(user_id)

            # Exponent based on variance of completion time (harder if too quick)
            times = [t for t, _ in history]
            time_variance = (max(times) - min(times)) / (mean(times) or 1)
            exponent = 1 + min(time_variance, 1)

            new_modifier = current_modifier * (1 - diff) ** exponent

            # Clamp to sensible boundaries
            new_modifier = max(self._CLAMP_RANGE[0], min(new_modifier, self._CLAMP_RANGE[1]))

            logger.info(
                "Recalculated difficulty for user %s: "
                "success_rate=%.2f variance=%.2f -> modifier %.3f → %.3f",
                user_id,
                success_rate,
                time_variance,
                current_modifier,
                new_modifier,
            )

            self._repo.set_modifier(user_id, new_modifier)

            # Notify other subscribers
            self._bus.publish(
                "difficulty_updated",
                user_id=user_id,
                quest_type=quest_type,
                difficulty_modifier=new_modifier,
            )


###############################################################################
# Factory Helper
###############################################################################


def create_adaptive_engine(db_path: Union[str, Path] = "questsmith.db") -> AdaptiveDifficultyEngine:
    """
    Factory helper that initialises repository + engine for DI wiring
    (useful for tests or when plugging into the wider application).
    """
    repo = DifficultyRepository(db_path)
    return AdaptiveDifficultyEngine(repo)


###############################################################################
# CLI Test Harness
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    """
    Quick-n-dirty smoke test:

    $ python -m src.module_35
    """
    import random
    import time

    engine = create_adaptive_engine(":memory:")  # In-memory DB for demo

    user = 42
    q_type = "fitness"

    # Simulate event streaming
    for i in range(1, 50):
        success = random.random() < 0.75  # ~75 % success rate
        completion_time = random.randint(300, 1200)
        ev = QuestCompletedEvent(
            user_id=user,
            quest_id=i,
            quest_type=q_type,
            baseline_difficulty=1.0,
            completion_time_sec=completion_time,
            succeeded=success,
        )
        GLOBAL_EVENT_BUS.publish("quest_completed", **ev.__dict__)
        time.sleep(0.05)

        if i % 10 == 0:
            recommended = engine.recommended_difficulty(user, baseline=1.0, quest_type=q_type)
            logger.info("Recommended difficulty after %d events: %.2f", i, recommended)
```