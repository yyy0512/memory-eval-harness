```python
"""
QuestSmith – Productivity RPG Forge
----------------------------------

module_24.py
~~~~~~~~~~~~
Adaptive difficulty engine, event-bus implementation, and a tiny repository
layer backed by SQLite.

This module demonstrates several of the project’s architectural patterns:

- Repository Pattern: `SQLiteRepository`
- Observer Pattern  : `EventBus`
- Factory Pattern   : `RepositoryFactory`
- MVVM Synergy      : View-Models can subscribe to `EventBus` and react
                      to `DIFFICULTY_CHANGED` announcements in real-time.

The adaptive algorithm is intentionally simple yet extendable: it tracks the
player’s recent quest performance and nudges the global difficulty level up
or down, keeping engagement in a “flow” channel—challenging but not punishing.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

logger = logging.getLogger("questsmith.adaptive")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Observer Pattern – Event Bus
# --------------------------------------------------------------------------- #


class EventType(Enum):
    """Event categories dispatched through the in-app event bus."""

    QUEST_COMPLETED = auto()
    QUEST_FAILED = auto()
    DIFFICULTY_CHANGED = auto()
    # Expand with more events as the game grows


@dataclass(frozen=True, slots=True)
class Event:
    """Generic container for event data."""

    type: EventType
    payload: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)


class EventBus:
    """
    Thread-safe publish/subscribe implementation.

    Usage:
        bus = EventBus.get_instance()
        bus.subscribe(EventType.QUEST_COMPLETED, handler)
        bus.emit(Event(EventType.QUEST_COMPLETED, {"quest_id": 42}))
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.RLock()

    def __init__(self) -> None:
        self._subscribers: Dict[EventType, List[Callable[[Event], None]]] = {}
        self._bus_lock = threading.RLock()

    # Singleton helper ------------------------------------------------------

    @classmethod
    def get_instance(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
                logger.debug("EventBus singleton instantiated")
            return cls._instance

    # Subscriber management --------------------------------------------------

    def subscribe(self, event_type: EventType,
                  callback: Callable[[Event], None]) -> None:
        with self._bus_lock:
            self._subscribers.setdefault(event_type, []).append(callback)
            logger.debug("Subscriber %s registered for %s",
                         callback.__name__, event_type.name)

    def unsubscribe(self, event_type: EventType,
                    callback: Callable[[Event], None]) -> None:
        with self._bus_lock:
            try:
                self._subscribers[event_type].remove(callback)
                logger.debug("Subscriber %s removed for %s",
                             callback.__name__, event_type.name)
            except (KeyError, ValueError):
                logger.warning("Attempted to unsubscribe non-existent handler")

    # Event dispatch ---------------------------------------------------------

    def emit(self, event: Event) -> None:
        with self._bus_lock:
            handlers = list(self._subscribers.get(event.type, []))

        logger.debug("Emitting %s to %d handlers", event.type.name,
                     len(handlers))
        for handler in handlers:
            try:
                handler(event)
            except Exception:  # noqa: BLE001
                logger.exception("Handler %s failed for event %s",
                                 handler.__name__, event.type.name)

# --------------------------------------------------------------------------- #
# Repository Pattern – SQLite access
# --------------------------------------------------------------------------- #


class RepositoryError(RuntimeError):
    """Raised for repository-level failures."""


class SQLiteRepository:
    """
    Minimal repository wrapping an on-device SQLite database.

    Responsibilities:
        * Centralized access to mutable game state
        * Convenience helpers for typed reads/writes
        * Thread-safe transactions
    """

    _DB_NAME = "questsmith.db"
    _SCHEMA = (
        """
        CREATE TABLE IF NOT EXISTS stats (
            key TEXT PRIMARY KEY NOT NULL,
            value INTEGER NOT NULL
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        """,
        # Expand schema here...
    )

    _instance: Optional["SQLiteRepository"] = None
    _lock = threading.RLock()

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._connection_lock = threading.RLock()
        self._ensure_db()

    # Singleton via factory --------------------------------------------------

    @classmethod
    def get_instance(cls, db_path: Path | None = None) -> "SQLiteRepository":
        """Return existing instance or build one if absent."""
        with cls._lock:
            if cls._instance is None:
                if db_path is None:
                    db_path = Path.home() / cls._DB_NAME
                cls._instance = cls(db_path)
                logger.info("SQLiteRepository initialised at %s", db_path)
            return cls._instance

    # Internal helpers -------------------------------------------------------

    def _ensure_db(self) -> None:
        with self._connect() as conn:
            cursor = conn.cursor()
            for ddl in self._SCHEMA:
                cursor.execute(ddl)
            conn.commit()
        logger.debug("SQLite schema validated")

    @contextmanager
    def _connect(self) -> sqlite3.Connection:
        try:
            with self._connection_lock:
                conn = sqlite3.connect(
                    self._db_path,
                    detect_types=sqlite3.PARSE_DECLTYPES,
                    check_same_thread=False,
                )
                conn.row_factory = sqlite3.Row
                yield conn
                conn.close()
        except sqlite3.Error as exc:
            logger.error("SQLite error: %s", exc)
            raise RepositoryError(exc) from exc

    # CRUD operations --------------------------------------------------------

    def get_int(self, key: str, default: int = 0) -> int:
        with self._connect() as conn:
            cur = conn.execute("SELECT value FROM stats WHERE key = ?", (key,))
            row = cur.fetchone()
            return int(row["value"]) if row else default

    def set_int(self, key: str, value: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO stats (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            conn.commit()
        logger.debug("Stat %s := %d", key, value)

    def increment_int(self, key: str, delta: int = 1) -> int:
        new_value = self.get_int(key) + delta
        self.set_int(key, new_value)
        return new_value

    def get_config(self, key: str, default: str | None = None) -> str | None:
        with self._connect() as conn:
            cur = conn.execute(
                "SELECT value FROM config WHERE key = ?", (key,))
            row = cur.fetchone()
            return row["value"] if row else default

    def set_config(self, key: str, value: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO config (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
            conn.commit()
        logger.debug("Config %s := %s", key, value)


# Factory Pattern wrapper (could be swapped for remote DB, tests, etc.)
class RepositoryFactory:
    """
    Abstracts repository creation. In production we use SQLite; in tests we
    might swap in an in-memory stub.
    """

    @staticmethod
    def provide() -> SQLiteRepository:
        return SQLiteRepository.get_instance()


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine
# --------------------------------------------------------------------------- #


class DifficultyLevel(Enum):
    EASY = 1
    NORMAL = 2
    HARD = 3
    NIGHTMARE = 4


@dataclass(slots=True)
class PerformanceWindow:
    """
    Sliding window of recent quest outcomes used to compute success ratio.
    """

    size: int = 20
    results: List[bool] = field(default_factory=list)

    def push(self, success: bool) -> None:
        self.results.append(success)
        if len(self.results) > self.size:
            self.results.pop(0)

    @property
    def ratio(self) -> float:
        if not self.results:
            return 0.5  # Neutral until we have data
        return sum(self.results) / len(self.results)


class AdaptiveDifficultyManager:
    """
    Listens to quest outcome events and tunes the global difficulty.

    Simple rule-based policy:
        - If success ratio > 80% for the window, increase difficulty
        - If success ratio < 40% for the window, decrease difficulty
        - Otherwise, stay put
    """

    STAT_COMPLETED = "quests.completed"
    STAT_FAILED = "quests.failed"
    CONFIG_DIFFICULTY = "difficulty"

    _CHANGE_COOLDOWN = timedelta(minutes=5)  # Debounce oscillation

    def __init__(self,
                 repo: SQLiteRepository,
                 bus: EventBus | None = None) -> None:
        self._bus = bus or EventBus.get_instance()
        self._repo = repo
        self._window = PerformanceWindow()
        self._last_change: datetime = datetime.min

        # Subscribe to quest events
        self._bus.subscribe(EventType.QUEST_COMPLETED, self._on_completed)
        self._bus.subscribe(EventType.QUEST_FAILED, self._on_failed)

        # Warm-up difficulty config
        if self._repo.get_config(self.CONFIG_DIFFICULTY) is None:
            self._repo.set_config(self.CONFIG_DIFFICULTY,
                                  DifficultyLevel.NORMAL.name)
            logger.info("Default difficulty initialised to NORMAL")

    # Event callbacks --------------------------------------------------------

    def _on_completed(self, event: Event) -> None:
        self._repo.increment_int(self.STAT_COMPLETED, 1)
        self._window.push(True)
        logger.debug("Quest completed recorded")
        self._evaluate()

    def _on_failed(self, event: Event) -> None:
        self._repo.increment_int(self.STAT_FAILED, 1)
        self._window.push(False)
        logger.debug("Quest failure recorded")
        self._evaluate()

    # Core logic -------------------------------------------------------------

    def _evaluate(self) -> None:
        now = datetime.utcnow()
        if now - self._last_change < self._CHANGE_COOLDOWN:
            logger.debug("Cooldown active, skipping evaluation")
            return

        ratio = self._window.ratio
        current = self.current_level
        logger.debug("Success ratio = %.2f on %d samples, current = %s",
                     ratio, len(self._window.results), current.name)

        new_level = current
        if ratio > 0.80 and current != DifficultyLevel.NIGHTMARE:
            new_level = DifficultyLevel(current.value + 1)
        elif ratio < 0.40 and current != DifficultyLevel.EASY:
            new_level = DifficultyLevel(current.value - 1)

        if new_level != current:
            self._set_level(new_level)
            self._last_change = now
            self._announce_change(current, new_level)

    # Helpers ----------------------------------------------------------------

    @property
    def current_level(self) -> DifficultyLevel:
        name = self._repo.get_config(
            self.CONFIG_DIFFICULTY, DifficultyLevel.NORMAL.name)
        try:
            return DifficultyLevel[name]
        except KeyError:
            logger.error("Corrupted difficulty value %s, resetting to NORMAL",
                         name)
            self._repo.set_config(self.CONFIG_DIFFICULTY,
                                  DifficultyLevel.NORMAL.name)
            return DifficultyLevel.NORMAL

    def _set_level(self, level: DifficultyLevel) -> None:
        self._repo.set_config(self.CONFIG_DIFFICULTY, level.name)
        logger.info("Difficulty changed → %s", level.name)

    def _announce_change(self, old: DifficultyLevel,
                         new: DifficultyLevel) -> None:
        self._bus.emit(Event(
            type=EventType.DIFFICULTY_CHANGED,
            payload={"old": old.name, "new": new.name},
        ))


# --------------------------------------------------------------------------- #
# Optional: quick self-test
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    """
    This block is ignored in production. It lets developers run:

        python -m src.module_24

    …and observe adaptive difficulty in action.
    """
    repo = RepositoryFactory.provide()
    bus = EventBus.get_instance()
    adm = AdaptiveDifficultyManager(repo, bus)

    # Demo handlers
    bus.subscribe(
        EventType.DIFFICULTY_CHANGED,
        lambda e: logger.warning("*** Difficulty shifted %s → %s",
                                 e.payload["old"], e.payload["new"]),
    )

    # Simulate gameplay -----------------------------------------------------
    import random
    for _ in range(50):
        success = random.random() < 0.75  # 75 % win-rate
        evt_type = EventType.QUEST_COMPLETED if success else EventType.QUEST_FAILED
        bus.emit(Event(evt_type))
```