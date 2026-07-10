```python
"""
QuestSmith – Productivity RPG Forge
module_17.py

This module contains the adaptive difficulty engine that keeps quests engaging
while preventing burnout.  Difficulty is adjusted in real-time based on the
player’s recent performance using an Observer-pattern subscription to the
global event bus.

The module is completely self-contained and can be unit-tested offline; all
external dependencies are injected through factories to honour project
architecture guidelines (Repository, Factory & Observer patterns).
"""

from __future__ import annotations

import enum
import logging
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Optional

# --------------------------------------------------------------------------- #
# Optional dependencies – we degrade gracefully when the real adapters are
# not available (e.g. during unit tests).                                     #
# --------------------------------------------------------------------------- #
try:
    # Real implementations provided elsewhere in the monorepo.
    from questsmith.core.event_bus import EventBus
    from questsmith.adapters.crash_reporting import CrashReporter
except ModuleNotFoundError:  # pragma: no cover  – Use stubs in test env
    class EventBus:
        """Light-weight stub for unit tests."""
        _subscribers: Dict[str, list[Callable]] = {}

        @classmethod
        def subscribe(cls, event_name: str, cb: Callable) -> None:
            cls._subscribers.setdefault(event_name, []).append(cb)

        @classmethod
        def unsubscribe(cls, event_name: str, cb: Callable) -> None:
            if event_name in cls._subscribers:
                cls._subscribers[event_name].remove(cb)

        @classmethod
        def emit(cls, event_name: str, *args, **kwargs) -> None:
            for cb in list(cls._subscribers.get(event_name, [])):
                try:
                    cb(*args, **kwargs)
                except Exception:  # pylint: disable=broad-except
                    logging.exception("Event handler %s failed.", cb)

    class CrashReporter:  # noqa: D401 – Simple stub
        @staticmethod
        def capture_exception(exc: Exception) -> None:  # noqa: D401
            logging.exception("Captured crash-report exception: %s", exc)


# --------------------------------------------------------------------------- #
# Constant & configuration section                                            #
# --------------------------------------------------------------------------- #

_DEFAULT_DB_PATH = (
    Path(os.getenv("QUESTSMITH_DB_PATH", ""))  # custom path OR
    or (Path.home() / ".questsmith" / "questsmith.db")  # default user data dir
)

_STREAK_TO_LEVEL_UP = 5     # Consecutive successes needed to raise difficulty
_FAILURES_TO_LEVEL_DOWN = 3  # Consecutive failures to lower difficulty.

_LOCK = threading.Lock()  # Singleton lock protecting SQLite writes


# --------------------------------------------------------------------------- #
# Enum & dataclass definitions                                                #
# --------------------------------------------------------------------------- #
class DifficultyLevel(enum.IntEnum):
    """Enumerates quest difficulty tiers in ascending order."""

    EASY = 1
    NORMAL = 2
    HARD = 3
    EXPERT = 4

    @property
    def next(self) -> "DifficultyLevel":
        """Return the next harder difficulty, capped at EXPERT."""
        levels = list(DifficultyLevel)
        idx = min(levels.index(self) + 1, len(levels) - 1)
        return levels[idx]

    @property
    def prev(self) -> "DifficultyLevel":
        """Return the previous easier difficulty, floored at EASY."""
        levels = list(DifficultyLevel)
        idx = max(levels.index(self) - 1, 0)
        return levels[idx]


class QuestOutcome(str, enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"


@dataclass(frozen=True, slots=True)
class QuestEvent:
    """Payload emitted by `quest_completed` or `quest_failed` events."""

    quest_id: str
    user_id: str
    quest_type: str
    outcome: QuestOutcome
    timestamp: float  # POSIX time
    xp_reward: int
    difficulty: DifficultyLevel


# --------------------------------------------------------------------------- #
# SQLite repository                                                           #
# --------------------------------------------------------------------------- #
class DifficultyRepository:
    """
    Repository responsible for reading / writing user difficulty profiles.
    Adheres to the Repository Pattern to keep storage logic isolated.
    """

    def __init__(self, db_path: Path | str = _DEFAULT_DB_PATH) -> None:
        self._db_path = Path(db_path)
        self._ensure_schema()

    # --------------------------- Public API -------------------------------- #
    def get_user_level(self, user_id: str, quest_type: str) -> DifficultyLevel:
        """Return the persisted difficulty for a user & quest-type."""
        with self._get_connection() as conn:
            cur = conn.execute(
                "SELECT difficulty_level FROM difficulty_profile "
                "WHERE user_id = ? AND quest_type = ?",
                (user_id, quest_type),
            )
            row = cur.fetchone()
            return DifficultyLevel(row[0]) if row else DifficultyLevel.EASY

    def update_user_level(
        self,
        user_id: str,
        quest_type: str,
        new_level: DifficultyLevel,
    ) -> None:
        """Update or insert difficulty level for the given user/quest."""
        with self._get_connection() as conn, conn:  # Explicit transaction
            conn.execute(
                """
                INSERT INTO difficulty_profile (user_id, quest_type,
                                                difficulty_level, last_updated)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, quest_type)
                DO UPDATE SET difficulty_level = excluded.difficulty_level,
                              last_updated    = excluded.last_updated
                """,
                (
                    user_id,
                    quest_type,
                    int(new_level),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    # --------------------------- Helper methods ---------------------------- #
    def _get_connection(self) -> sqlite3.Connection:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        return sqlite3.connect(
            self._db_path,
            timeout=30,
            isolation_level=None,  # autocommit false, explicit BEGIN required
            check_same_thread=False,
        )

    def _ensure_schema(self) -> None:
        with self._get_connection() as conn, conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS difficulty_profile (
                    user_id         TEXT NOT NULL,
                    quest_type      TEXT NOT NULL,
                    difficulty_level INTEGER NOT NULL,
                    last_updated    TEXT NOT NULL,
                    PRIMARY KEY (user_id, quest_type)
                )
                """
            )


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine                                                  #
# --------------------------------------------------------------------------- #
class AdaptiveDifficultyEngine:
    """
    Listens to quest outcome events and dynamically adjusts difficulty.

    The engine subscribes itself to the central EventBus; therefore instantiate
    exactly once per active user session.
    """

    _THREAD_NAME_PREFIX = "QuestSmithDifficultyWorker"

    def __init__(
        self,
        *,
        event_bus: type[EventBus] = EventBus,
        repo: Optional[DifficultyRepository] = None,
        crash_reporter: type[CrashReporter] = CrashReporter,
    ) -> None:
        self._event_bus = event_bus
        self._repo = repo or DifficultyRepository()
        self._crash_reporter = crash_reporter

        # In-memory performance tracking structure:
        self._success_streaks: Dict[tuple[str, str], int] = {}
        self._failure_counts: Dict[tuple[str, str], int] = {}

        self._register_listeners()

    # --------------------------- Event handling ---------------------------- #
    def _register_listeners(self) -> None:
        self._event_bus.subscribe("quest_completed", self._on_quest_completed)
        self._event_bus.subscribe("quest_failed", self._on_quest_failed)

    def stop(self) -> None:
        """Unsubscribe from the EventBus, typically on app shutdown."""
        self._event_bus.unsubscribe("quest_completed", self._on_quest_completed)
        self._event_bus.unsubscribe("quest_failed", self._on_quest_failed)

    def _on_quest_completed(self, event: QuestEvent) -> None:
        self._track_outcome(event, QuestOutcome.SUCCESS)

    def _on_quest_failed(self, event: QuestEvent) -> None:
        self._track_outcome(event, QuestOutcome.FAILURE)

    # --------------------------- Core logic -------------------------------- #
    def _track_outcome(self, event: QuestEvent, outcome: QuestOutcome) -> None:
        """Update streak counters & schedule difficulty evaluation."""
        key = (event.user_id, event.quest_type)

        if outcome is QuestOutcome.SUCCESS:
            self._success_streaks[key] = self._success_streaks.get(key, 0) + 1
            self._failure_counts[key] = 0
        else:
            self._failure_counts[key] = self._failure_counts.get(key, 0) + 1
            self._success_streaks[key] = 0

        # Run evaluation in a background thread to keep UI snappy.
        t = threading.Thread(
            target=self._evaluate_difficulty,
            args=(event,),
            name=f"{self._THREAD_NAME_PREFIX}-{time.time_ns()}",
            daemon=True,
        )
        t.start()

    def _evaluate_difficulty(self, event: QuestEvent) -> None:  # noqa: C901 (complex)
        try:
            key = (event.user_id, event.quest_type)
            current_level = self._repo.get_user_level(*key)

            upgraded = False
            downgraded = False

            # --------------- Difficulty upgrade path ---------------------- #
            if self._success_streaks.get(key, 0) >= _STREAK_TO_LEVEL_UP:
                new_level = current_level.next
                if new_level != current_level:
                    upgraded = True
                    self._repo.update_user_level(
                        event.user_id, event.quest_type, new_level
                    )
                self._success_streaks[key] = 0  # reset streak after promotion

            # --------------- Difficulty downgrade path -------------------- #
            elif self._failure_counts.get(key, 0) >= _FAILURES_TO_LEVEL_DOWN:
                new_level = current_level.prev
                if new_level != current_level:
                    downgraded = True
                    self._repo.update_user_level(
                        event.user_id, event.quest_type, new_level
                    )
                self._failure_counts[key] = 0  # reset after demotion

            # Emit events if level changed
            if upgraded:
                self._emit_difficulty_changed(event, "upgraded", current_level.next)
            elif downgraded:
                self._emit_difficulty_changed(event, "downgraded", current_level.prev)

        except Exception as exc:  # pragma: no cover
            # Capture any unexpected failure; never crash the UI thread.
            self._crash_reporter.capture_exception(exc)

    # --------------------------- Event emission --------------------------- #
    def _emit_difficulty_changed(
        self,
        event: QuestEvent,
        change_type: str,
        new_level: DifficultyLevel,
    ) -> None:
        """Notify other subsystems (UI, analytics, etc.) about level changes."""
        payload = {
            "user_id": event.user_id,
            "quest_type": event.quest_type,
            "new_level": int(new_level),
            "change_type": change_type,
            "timestamp": time.time(),
        }
        self._event_bus.emit("difficulty_changed", payload)

    # --------------------------- Utility ---------------------------------- #
    def get_current_level(self, user_id: str, quest_type: str) -> DifficultyLevel:
        """Expose current level for quick UI queries or debugging."""
        return self._repo.get_user_level(user_id, quest_type)


# --------------------------------------------------------------------------- #
# Convenience bootstrap for the application                                  #
# --------------------------------------------------------------------------- #
_ENGINE_INSTANCE: Optional[AdaptiveDifficultyEngine] = None


def bootstrap() -> AdaptiveDifficultyEngine:
    """
    Start the adaptive difficulty engine if not already running.

    This helper is idempotent; calling multiple times returns the same instance.
    """
    global _ENGINE_INSTANCE  # pylint: disable=global-statement
    if _ENGINE_INSTANCE is None:
        _ENGINE_INSTANCE = AdaptiveDifficultyEngine()
    return _ENGINE_INSTANCE


# Execute bootstrap at import-time for production mobile build; in unit tests
# explicit calls are preferred so we guard with an env var.
if os.getenv("QUESTSMITH_BOOT_ADAPTIVE_ENGINE", "1") == "1":  # pragma: no cover
    try:
        bootstrap()
    except Exception as exc:  # pylint: disable=broad-except
        CrashReporter.capture_exception(exc)
        logging.exception("Failed to bootstrap AdaptiveDifficultyEngine")
```