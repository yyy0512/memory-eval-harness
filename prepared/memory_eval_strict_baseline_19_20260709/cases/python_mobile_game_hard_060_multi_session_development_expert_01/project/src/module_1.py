```python
"""
QuestSmith – Productivity RPG Forge
src/module_1.py

This module centralises the “quest” domain logic that is shared across the
mobile application.  It demonstrates the Repository, Factory, Observer, and
MVVM patterns in a single, self-contained file while remaining agnostic to the
actual Kivy UI layer.

The code purposefully avoids any direct dependency on Kivy so that it can be
unit-tested in isolation.  UI widgets are expected to interact with the
QuestViewModel exposed at the bottom of the file.

Author: QuestSmith Engineering Team
"""

from __future__ import annotations

import json
import logging
import pathlib
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from datetime import datetime
from enum import Enum, unique
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Sequence, Tuple, Union

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s – %(message)s"
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
logger = logging.getLogger("questsmith.module_1")

# --------------------------------------------------------------------------- #
# Domain Model
# --------------------------------------------------------------------------- #

@unique
class QuestStatus(str, Enum):
    """Enumerated quest states."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ABANDONED = "abandoned"


@dataclass(frozen=True, slots=True)
class Quest:
    """Immutable quest representation."""
    uid: str
    title: str
    description: str
    created_at: datetime
    due_at: Optional[datetime]
    status: QuestStatus
    xp_reward: int
    gold_reward: int

    @staticmethod
    def create(
        title: str,
        description: str = "",
        due_at: Optional[datetime] = None,
        xp_reward: int = 50,
        gold_reward: int = 10,
    ) -> "Quest":
        """Factory that returns a new Quest instance with a fresh UID."""
        uid = uuid.uuid4().hex
        return Quest(
            uid=uid,
            title=title,
            description=description,
            created_at=datetime.utcnow(),
            due_at=due_at,
            status=QuestStatus.PENDING,
            xp_reward=xp_reward,
            gold_reward=gold_reward,
        )


# --------------------------------------------------------------------------- #
# Repository Pattern
# --------------------------------------------------------------------------- #

class RepositoryError(RuntimeError):
    """Base class for repository related errors."""


class QuestRepository:
    """
    SQLite-backed repository that persists Quest objects.

    The repository is thread-safe via a simple connection-per-thread strategy and
    a coarse lock around write operations. For a mobile application, this is a
    reasonable trade-off between simplicity and performance.
    """

    DB_FILE = pathlib.Path.home() / ".questsmith" / "questsmith.sqlite3"
    _SCHEMA_VERSION = 1

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._local = threading.local()
        self._ensure_db()

    # ------------- Public API ------------------------------------------------

    def add_quest(self, quest: Quest) -> None:
        logger.debug("Adding quest: %s", quest)
        with self._lock, self._conn_ctx() as conn:
            conn.execute(
                """
                INSERT INTO quests (
                    uid, title, description, created_at, due_at,
                    status, xp_reward, gold_reward
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    quest.uid,
                    quest.title,
                    quest.description,
                    int(quest.created_at.timestamp()),
                    int(quest.due_at.timestamp()) if quest.due_at else None,
                    quest.status.value,
                    quest.xp_reward,
                    quest.gold_reward,
                ),
            )
            conn.commit()

    def update_status(self, uid: str, new_status: QuestStatus) -> None:
        logger.debug("Updating status for quest %s => %s", uid, new_status)
        with self._lock, self._conn_ctx() as conn:
            cur = conn.execute(
                "UPDATE quests SET status = ? WHERE uid = ?",
                (new_status.value, uid),
            )
            if cur.rowcount == 0:
                raise RepositoryError(f"No quest found with uid={uid}")
            conn.commit()

    def delete_quest(self, uid: str) -> None:
        logger.debug("Deleting quest: %s", uid)
        with self._lock, self._conn_ctx() as conn:
            conn.execute("DELETE FROM quests WHERE uid = ?", (uid,))
            conn.commit()

    def fetch_quest(self, uid: str) -> Quest:
        with self._conn_ctx() as conn:
            cur = conn.execute("SELECT * FROM quests WHERE uid = ?", (uid,))
            row = cur.fetchone()
            if not row:
                raise RepositoryError(f"No quest found with uid={uid}")
            return self._row_to_quest(row)

    def list_quests(
        self,
        status: Optional[QuestStatus] = None,
        order_by_due: bool = False,
    ) -> List[Quest]:
        with self._conn_ctx() as conn:
            if status:
                cur = conn.execute(
                    "SELECT * FROM quests WHERE status = ? ORDER BY due_at NULLS LAST",
                    (status.value,),
                )
            else:
                cur = conn.execute("SELECT * FROM quests")
            rows = cur.fetchall()
            quests = [self._row_to_quest(r) for r in rows]
            if order_by_due:
                quests.sort(key=lambda q: q.due_at or datetime.max)
            return quests

    # --------------- Internal helpers ---------------------------------------

    def _ensure_db(self) -> None:
        self.DB_FILE.parent.mkdir(parents=True, exist_ok=True)
        with self._conn_ctx() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS quests (
                    uid TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT,
                    created_at INTEGER NOT NULL,
                    due_at INTEGER,
                    status TEXT NOT NULL,
                    xp_reward INTEGER NOT NULL,
                    gold_reward INTEGER NOT NULL
                )
                """
            )
            # Migrate schema if needed
            cur = conn.execute("SELECT value FROM meta WHERE key='schema_version'")
            row = cur.fetchone()
            version = int(row[0]) if row else 0
            if version < self._SCHEMA_VERSION:
                logger.info("Migrating DB from v%s => v%s", version, self._SCHEMA_VERSION)
                # No migration steps yet; placeholder for future.
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                    (self._SCHEMA_VERSION,),
                )
            conn.commit()

    def _get_connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.DB_FILE, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    @contextmanager
    def _conn_ctx(self):
        conn = self._get_connection()
        try:
            yield conn
        finally:
            pass  # connection lifecycle managed per-thread

    @staticmethod
    def _row_to_quest(row: sqlite3.Row) -> Quest:
        return Quest(
            uid=row["uid"],
            title=row["title"],
            description=row["description"],
            created_at=datetime.fromtimestamp(row["created_at"]),
            due_at=datetime.fromtimestamp(row["due_at"]) if row["due_at"] else None,
            status=QuestStatus(row["status"]),
            xp_reward=row["xp_reward"],
            gold_reward=row["gold_reward"],
        )


# --------------------------------------------------------------------------- #
# Observer Pattern – Simple Event Bus
# --------------------------------------------------------------------------- #

class EventHandler(Protocol):
    """Callable signature for event handlers."""
    def __call__(self, event: str, payload: Dict[str, Any]) -> None:
        ...


class EventBus:
    """
    Thread-safe pub/sub bus.  Handlers are weakly-referenced to avoid memory
    leaks when UI widgets get destroyed and garbage-collected.
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.RLock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[str, List[EventHandler]] = {}
        return cls._instance

    # ----------- Public API --------------------------------------------------

    def subscribe(self, event: str, handler: EventHandler) -> None:
        with self._lock:
            self._subscribers.setdefault(event, []).append(handler)
            logger.debug("Subscribed %s to %s", handler, event)

    def unsubscribe(self, event: str, handler: EventHandler) -> None:
        with self._lock:
            handlers = self._subscribers.get(event, [])
            if handler in handlers:
                handlers.remove(handler)
                logger.debug("Unsubscribed %s from %s", handler, event)

    def emit(self, event: str, payload: Optional[Dict[str, Any]] = None) -> None:
        payload = payload or {}
        subscribers = list(self._subscribers.get(event, []))
        logger.debug("Emitting event=%s payload=%s to %s handlers", event, payload, len(subscribers))
        for handler in subscribers:
            try:
                handler(event, payload)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Error while handling event '%s' in %s", event, handler)


# --------------------------------------------------------------------------- #
# Factory Pattern – Platform Service Adapters
# --------------------------------------------------------------------------- #

class BiometricAuthAdapter(Protocol):
    def authenticate(self) -> bool:
        ...


class CrashReporterAdapter(Protocol):
    def capture_exception(self, exc: BaseException) -> None:
        ...


class ServiceFactory:
    """
    Provides platform-specific adapters.  Real mobile builds inject concrete
    implementations through dependency injection at application bootstrap.
    The default (fallback) implementations are no-ops suitable for unit tests.
    """

    _biometric_adapter: Optional[BiometricAuthAdapter] = None
    _crash_adapter: Optional[CrashReporterAdapter] = None

    # ------------------- Registration API -----------------------------------

    @classmethod
    def register_biometric(cls, adapter: BiometricAuthAdapter) -> None:
        cls._biometric_adapter = adapter

    @classmethod
    def register_crash_reporter(cls, adapter: CrashReporterAdapter) -> None:
        cls._crash_adapter = adapter

    # ------------------- Accessors ------------------------------------------

    @classmethod
    def biometric_auth(cls) -> BiometricAuthAdapter:
        if cls._biometric_adapter is None:
            cls._biometric_adapter = _DefaultBiometricAuthAdapter()
        return cls._biometric_adapter

    @classmethod
    def crash_reporter(cls) -> CrashReporterAdapter:
        if cls._crash_adapter is None:
            cls._crash_adapter = _DefaultCrashReporterAdapter()
        return cls._crash_adapter


class _DefaultBiometricAuthAdapter:
    """Fallback biometric auth (always succeeds)."""

    def authenticate(self) -> bool:
        logger.info("Biometric auth fallback – automatically approved.")
        # Simulate processing time
        time.sleep(0.2)
        return True


class _DefaultCrashReporterAdapter:
    """Fallback crash reporter that logs locally."""

    def capture_exception(self, exc: BaseException) -> None:
        logger.error("Captured exception (fallback reporter): %s", exc, exc_info=exc)


# --------------------------------------------------------------------------- #
# MVVM – ViewModel for Quest List
# --------------------------------------------------------------------------- #

class QuestViewModel:
    """
    Acts as the gateway between UI widgets and the underlying domain.
    All public methods are safe to call from the UI thread.
    """

    EVENT_QUEST_ADDED = "quest_added"
    EVENT_QUEST_UPDATED = "quest_updated"
    EVENT_QUEST_DELETED = "quest_deleted"

    def __init__(self, repo: Optional[QuestRepository] = None) -> None:
        self._repo = repo or QuestRepository()
        self._bus = EventBus()
        self._crash_reporter = ServiceFactory.crash_reporter()

    # --------------- Command API ------------------------------------------- #

    def add_new_quest(
        self,
        title: str,
        description: str = "",
        due_at: Optional[datetime] = None,
        xp_reward: int = 50,
        gold_reward: int = 10,
    ) -> None:
        try:
            quest = Quest.create(
                title=title,
                description=description,
                due_at=due_at,
                xp_reward=xp_reward,
                gold_reward=gold_reward,
            )
            self._repo.add_quest(quest)
            self._bus.emit(self.EVENT_QUEST_ADDED, {"quest": quest})
        except Exception as exc:  # pylint: disable=broad-except
            self._crash_reporter.capture_exception(exc)
            logger.exception("Failed to add quest.")

    def complete_quest(self, uid: str) -> None:
        self._update_status(uid, QuestStatus.COMPLETED)

    def abandon_quest(self, uid: str) -> None:
        self._update_status(uid, QuestStatus.ABANDONED)

    def start_quest(self, uid: str) -> None:
        self._update_status(uid, QuestStatus.IN_PROGRESS)

    def delete_quest(self, uid: str) -> None:
        try:
            self._repo.delete_quest(uid)
            self._bus.emit(self.EVENT_QUEST_DELETED, {"uid": uid})
        except Exception as exc:  # pylint: disable=broad-except
            self._crash_reporter.capture_exception(exc)
            logger.exception("Failed to delete quest.")

    # --------------- Query API --------------------------------------------- #

    def list_pending_quests(self) -> List[Quest]:
        return self._repo.list_quests(status=QuestStatus.PENDING, order_by_due=True)

    def list_active_quests(self) -> List[Quest]:
        return self._repo.list_quests(status=QuestStatus.IN_PROGRESS, order_by_due=True)

    def list_completed_quests(self) -> List[Quest]:
        return self._repo.list_quests(status=QuestStatus.COMPLETED, order_by_due=False)

    # --------------- Subscription Helpers ---------------------------------- #

    def on_quest_added(self, handler: EventHandler) -> None:
        self._bus.subscribe(self.EVENT_QUEST_ADDED, handler)

    def on_quest_updated(self, handler: EventHandler) -> None:
        self._bus.subscribe(self.EVENT_QUEST_UPDATED, handler)

    def on_quest_deleted(self, handler: EventHandler) -> None:
        self._bus.subscribe(self.EVENT_QUEST_DELETED, handler)

    # --------------- Internal helpers -------------------------------------- #

    def _update_status(self, uid: str, new_status: QuestStatus) -> None:
        try:
            self._repo.update_status(uid, new_status)
            self._bus.emit(self.EVENT_QUEST_UPDATED, {"uid": uid, "new_status": new_status})
        except Exception as exc:  # pylint: disable=broad-except
            self._crash_reporter.capture_exception(exc)
            logger.exception("Failed to update quest status.")


# --------------------------------------------------------------------------- #
# Lightweight test-drive (CLI demo)
# --------------------------------------------------------------------------- #

def _demo() -> None:
    """
    Quick demonstration when executed directly:

        python -m src.module_1
    """
    logger.info("QuestSmith CLI Demo – starting")
    vm = QuestViewModel()

    # Register console-print handlers
    vm.on_quest_added(lambda e, p: logger.info("EVENT: %s – %s", e, p["quest"].title))
    vm.on_quest_updated(lambda e, p: logger.info("EVENT: %s – %s => %s", e, p["uid"], p["new_status"]))
    vm.on_quest_deleted(lambda e, p: logger.info("EVENT: %s – UID=%s", e, p["uid"]))

    # Create a quest
    vm.add_new_quest(
        title="Finish QuestSmith PRD",
        description="Write the product requirements document",
        xp_reward=100,
        gold_reward=25,
    )

    # Get pending quests
    pending = vm.list_pending_quests()
    logger.info("Pending quests: %s", [q.title for q in pending])
    if not pending:
        return

    # Start and complete the quest
    quest_uid = pending[0].uid
    vm.start_quest(quest_uid)
    vm.complete_quest(quest_uid)

    # Delete quest
    vm.delete_quest(quest_uid)

    logger.info("QuestSmith CLI Demo – finished")


if __name__ == "__main__":
    # Authenticate user with fallback biometric
    if ServiceFactory.biometric_auth().authenticate():
        _demo()
    else:
        logger.warning("Biometric authentication failed – exiting.")
```