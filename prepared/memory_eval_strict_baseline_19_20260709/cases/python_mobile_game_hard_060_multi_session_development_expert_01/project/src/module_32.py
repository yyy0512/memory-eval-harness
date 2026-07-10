```python
"""
QuestSmith – Productivity RPG Forge
src/module_32.py

This module provides an Event-Bus implementation and an AdaptiveDifficultyService
that reacts to quest-related events to dynamically tune game difficulty.  It is
designed to be embedded in the QuestSmith monolith and therefore relies only on
the Python standard library plus a minimal set of third-party packages that are
already transitively shipped with the application (e.g. `sqlite3`, `typing`).

Key patterns employed
---------------------
• Observer Pattern      – `EventBus` dispatches events to registered listeners.
• Repository Pattern    – `QuestRepository` and `SettingsRepository` abstract
                          access to persistent storage (SQLite underneath).
• Factory Pattern       – `RepositoryFactory` creates concrete repository
                          instances appropriate for the current execution
                          context (online/offline, encrypted DB, etc).

The module is intentionally self-contained: importing it does NOT implicitly
create threads, open database connections, or register global listeners.
Callers are expected to:

    bus = EventBus.shared()
    svc = AdaptiveDifficultyService(bus)
    bus.register(svc)
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import weakref
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Protocol, Sequence, Set

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

logger = logging.getLogger("questsmith.adaptive_difficulty")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Event system                                                                #
# --------------------------------------------------------------------------- #

class EventType(Enum):
    """Enumeration of high-level QuestSmith events."""
    QUEST_COMPLETED = auto()
    QUEST_FAILED = auto()
    QUEST_CREATED = auto()
    LEVEL_UP = auto()


@dataclass(frozen=True, slots=True)
class Event:
    """Base event object carried on the bus."""
    type: EventType
    payload: Dict[str, Any]
    timestamp: float = time.time()


class EventSubscriber(Protocol):
    """Interface that every subscriber on the EventBus must fulfil."""

    def handle_event(self, event: Event) -> None:  # pragma: no cover
        ...


class EventBus:
    """
    A thread-safe, weak-reference based event bus.

    Uses a single internal queue and a dedicated dispatcher thread so that
    subscribers are not required to be re-entrant or async.
    """

    _instance: Optional["EventBus"] = None
    _instance_lock = threading.Lock()

    DISPATCH_INTERVAL_SEC = 0.1

    def __init__(self) -> None:
        self._subscribers: Set[weakref.ReferenceType[EventSubscriber]] = set()
        self._queue: Deque[Event] = deque()
        self._queue_lock = threading.Lock()
        self._dispatcher_thread = threading.Thread(
            target=self._dispatch_loop, name="EventBusDispatcher", daemon=True
        )
        self._dispatcher_thread.start()
        logger.debug("EventBus initialized and dispatcher thread started.")

    # ---------------- Singleton handling ---------------- #

    @classmethod
    def shared(cls) -> "EventBus":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    # ---------------- Public API ---------------- #

    def register(self, subscriber: EventSubscriber) -> None:
        self._subscribers.add(weakref.ref(subscriber))
        logger.debug("Registered subscriber: %s", subscriber)

    def unregister(self, subscriber: EventSubscriber) -> None:
        self._subscribers = {
            ref for ref in self._subscribers if ref() is not subscriber and ref() is not None
        }
        logger.debug("Unregistered subscriber: %s", subscriber)

    def post(self, event: Event) -> None:
        logger.debug("Posting event: %s", event)
        with self._queue_lock:
            self._queue.append(event)

    # ---------------- Internal ---------------- #

    def _dispatch_loop(self) -> None:
        logger.debug("EventBus dispatch loop started.")
        while True:
            if not self._queue:
                time.sleep(self.DISPATCH_INTERVAL_SEC)
                continue

            with self._queue_lock:
                event = self._queue.popleft()

            dead_refs: List[weakref.ReferenceType[EventSubscriber]] = []

            for ref in list(self._subscribers):
                subscriber = ref()
                if subscriber is None:
                    dead_refs.append(ref)
                    continue
                try:
                    subscriber.handle_event(event)
                except Exception as exc:  # noqa: BLE001
                    logger.exception("Error while delivering event '%s' to %s: %s", event, subscriber, exc)

            # Clean up any GC’ed subscribers
            self._subscribers.difference_update(dead_refs)


# --------------------------------------------------------------------------- #
# Repository layer                                                            #
# --------------------------------------------------------------------------- #

class QuestDifficulty(Enum):
    EASY = 1
    MEDIUM = 2
    HARD = 3
    NIGHTMARE = 4


@dataclass(slots=True)
class QuestRecord:
    quest_id: str
    title: str
    created_at: float
    due_at: float
    completed_at: Optional[float]
    difficulty: QuestDifficulty


class QuestRepository(Protocol):
    """Repository interface for CRUD operations on quests."""

    def get_recent_quests(self, limit: int = 20) -> Sequence[QuestRecord]:
        ...

    def update_difficulty(self, quest_id: str, difficulty: QuestDifficulty) -> None:
        ...

    def insert_quest(self, record: QuestRecord) -> None:
        ...


class SettingsRepository(Protocol):
    """Repository interface for app-wide settings."""

    def get_user_pref(self, key: str, default: Any = None) -> Any:
        ...

    def set_user_pref(self, key: str, value: Any) -> None:
        ...


# ---------------- Simple SQLite implementation ---------------- #

_DB_DIR = Path.home() / ".questsmith"
_DB_DIR.mkdir(parents=True, exist_ok=True)
_DB_PATH = _DB_DIR / "questsmith.sqlite3"


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS quests(
            quest_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at REAL NOT NULL,
            due_at REAL NOT NULL,
            completed_at REAL,
            difficulty INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings(
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    conn.commit()


@contextmanager
def _db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH)
    try:
        _ensure_schema(conn)
        yield conn
    finally:
        conn.close()


class SQLiteQuestRepository:
    """SQLite implementation of QuestRepository with minimal indexing."""

    def get_recent_quests(self, limit: int = 20) -> Sequence[QuestRecord]:
        with _db_connection() as conn:
            cur = conn.execute(
                """
                SELECT quest_id, title, created_at, due_at,
                       completed_at, difficulty
                FROM quests
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
        return [
            QuestRecord(
                quest_id=row[0],
                title=row[1],
                created_at=row[2],
                due_at=row[3],
                completed_at=row[4],
                difficulty=QuestDifficulty(row[5]),
            )
            for row in rows
        ]

    def update_difficulty(self, quest_id: str, difficulty: QuestDifficulty) -> None:
        with _db_connection() as conn:
            conn.execute(
                "UPDATE quests SET difficulty = ? WHERE quest_id = ?",
                (difficulty.value, quest_id),
            )
            conn.commit()
        logger.debug("Updated difficulty for quest '%s' to %s", quest_id, difficulty)

    def insert_quest(self, record: QuestRecord) -> None:
        with _db_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO quests
                (quest_id, title, created_at, due_at, completed_at, difficulty)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record.quest_id,
                    record.title,
                    record.created_at,
                    record.due_at,
                    record.completed_at,
                    record.difficulty.value,
                ),
            )
            conn.commit()
        logger.debug("Inserted/updated quest record: %s", record)


class SQLiteSettingsRepository:
    """SQLite implementation of SettingsRepository."""

    def get_user_pref(self, key: str, default: Any = None) -> Any:
        with _db_connection() as conn:
            cur = conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
            row = cur.fetchone()
        return row[0] if row else default

    def set_user_pref(self, key: str, value: Any) -> None:
        with _db_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value)
            )
            conn.commit()
        logger.debug("Set user preference %s = %s", key, value)


# ---------------- Factory for repositories ---------------- #

class RepositoryFactory:
    """Factory producing repository instances.

    In the production app, this factory may return encrypted or remote-syncing
    variants depending on runtime environment.
    """

    @staticmethod
    def quest_repository() -> QuestRepository:
        return SQLiteQuestRepository()

    @staticmethod
    def settings_repository() -> SettingsRepository:
        return SQLiteSettingsRepository()


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Service                                                 #
# --------------------------------------------------------------------------- #

class AdaptiveDifficultyService(EventSubscriber):
    """
    Adjusts future quest difficulties based on recent user performance.

    Algorithm (simplified):
    -----------------------
    • Calculates success ratio over last N completed/failed quests.
    • If user succeeds at >75 % quests and average completion time is ≤50 % of
      allotted time, increase difficulty (up to NIGHTMARE).
    • If success ratio falls below 40 % or average completion time > allotted
      time, decrease difficulty (down to EASY).
    • Persists the target difficulty to `settings` so that Quest creation can
      use it as a baseline.
    """

    _SUCCESS_THRESHOLD = 0.75
    _FAILURE_THRESHOLD = 0.40

    PREF_KEY_DIFFICULTY = "adaptive.base_difficulty"
    ANALYSIS_WINDOW = 20  # quests

    def __init__(
        self,
        event_bus: EventBus | None = None,
        repository_factory: RepositoryFactory | None = None,
    ) -> None:
        self._bus = event_bus or EventBus.shared()
        self._repo_factory = repository_factory or RepositoryFactory()
        self._quest_repo = self._repo_factory.quest_repository()
        self._settings_repo = self._repo_factory.settings_repository()
        logger.info("AdaptiveDifficultyService initialized.")

    # ---------------- Observer interface ---------------- #

    def handle_event(self, event: Event) -> None:
        if event.type not in {EventType.QUEST_COMPLETED, EventType.QUEST_FAILED}:
            return  # Ignore irrelevant events

        # Run analysis in a background thread to avoid blocking the bus.
        threading.Thread(
            target=self._recalculate_difficulty,
            name="AdaptiveDifficultyWorker",
            daemon=True,
        ).start()

    # ---------------- Internal ---------------- #

    def _recalculate_difficulty(self) -> None:
        logger.debug("Starting difficulty recalculation.")
        recent = self._quest_repo.get_recent_quests(limit=self.ANALYSIS_WINDOW)
        if not recent:
            logger.debug("No recent quests found, skipping recalculation.")
            return

        successes = [q for q in recent if q.completed_at is not None and q.completed_at <= q.due_at]
        failures = [q for q in recent if q.completed_at is None or q.completed_at > q.due_at]

        success_ratio = len(successes) / len(recent)
        logger.debug("Success ratio over last %d quests: %.2f", len(recent), success_ratio)

        # Compute average completion time vs allotted time for successes
        time_efficiency = 1.0  # default when no successes
        if successes:
            proportions = [
                (q.completed_at - q.created_at) / (q.due_at - q.created_at) for q in successes  # type: ignore
            ]
            time_efficiency = sum(proportions) / len(proportions)
            logger.debug("Average time efficiency: %.2f", time_efficiency)

        current = self._current_base_difficulty()
        target = current

        should_increase = success_ratio >= self._SUCCESS_THRESHOLD and time_efficiency <= 0.5
        should_decrease = success_ratio <= self._FAILURE_THRESHOLD or time_efficiency > 1.0

        if should_increase and current != QuestDifficulty.NIGHTMARE:
            target = QuestDifficulty(current.value + 1)
        elif should_decrease and current != QuestDifficulty.EASY:
            target = QuestDifficulty(current.value - 1)

        if target != current:
            self._settings_repo.set_user_pref(self.PREF_KEY_DIFFICULTY, target.value)
            logger.info("Adaptive difficulty adjusted: %s → %s", current.name, target.name)
        else:
            logger.debug("Difficulty remains unchanged at %s", current.name)

    def _current_base_difficulty(self) -> QuestDifficulty:
        stored = self._settings_repo.get_user_pref(self.PREF_KEY_DIFFICULTY, default=QuestDifficulty.MEDIUM.value)
        try:
            return QuestDifficulty(int(stored))
        except (ValueError, KeyError):  # pragma: no cover
            logger.warning(
                "Corrupted difficulty preference value '%s'. Resetting to MEDIUM.", stored
            )
            self._settings_repo.set_user_pref(self.PREF_KEY_DIFFICULTY, QuestDifficulty.MEDIUM.value)
            return QuestDifficulty.MEDIUM


# --------------------------------------------------------------------------- #
# Helper utilities (optional)                                                 #
# --------------------------------------------------------------------------- #

def create_sample_quests(repo: QuestRepository) -> None:  # pragma: no cover
    """Insert dummy quests for manual testing."""
    now = time.time()
    for i in range(25):
        quest_id = f"dummy_{i}"
        created_at = now - (i * 3600 * 6)  # spaced 6h apart
        due_at = created_at + 3600  # 1 hour quest duration
        completed_at = None if i % 5 == 0 else due_at - 1800  # some failed quests
        record = QuestRecord(
            quest_id=quest_id,
            title=f"Sample Quest {i}",
            created_at=created_at,
            due_at=due_at,
            completed_at=completed_at,
            difficulty=QuestDifficulty.MEDIUM,
        )
        repo.insert_quest(record)
    logger.info("Sample quests created.")


if __name__ == "__main__":  # pragma: no cover
    # Example manual test run
    bus = EventBus.shared()
    service = AdaptiveDifficultyService(bus)
    bus.register(service)

    repo = RepositoryFactory.quest_repository()
    if not repo.get_recent_quests():
        create_sample_quests(repo)

    # Simulate quest completion events
    bus.post(Event(type=EventType.QUEST_COMPLETED, payload={"quest_id": "dummy_1"}))
    bus.post(Event(type=EventType.QUEST_FAILED, payload={"quest_id": "dummy_2"}))

    # Give the worker thread some time to finish
    time.sleep(2.0)
```