```python
"""
QuestSmith – Productivity RPG Forge
module_25.py

This module bundles several infrastructural components used across the
QuestSmith application:

1. EventBus            – Lightweight, thread-safe Observer implementation.
2. Domain models       – Quest, QuestStatus, Reward, UserStats.
3. Repository Layer    – SQLiteQuestRepository (Repository Pattern).
4. Service Factories   – PushNotificationAdapter, CrashReporterAdapter.
5. AnalyticsEngine     – Aggregates quest life-cycle data in real-time.
6. QuestManager        – Coordinates quest completion, rewards, & observers.

The code is written to be production-ready, with type hints, docstrings,
and robust error-handling where appropriate.  External frameworks
(Kivy, biometrics, etc.) are intentionally abstracted behind adapters so
that this module remains platform-agnostic and purely Pythonic.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Union

###############################################################################
# Logging Configuration
###############################################################################

LOG_LEVEL = os.environ.get("QUESTSMITH_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="[%(asctime)s] %(levelname)s in %(module)s: %(message)s",
)
logger = logging.getLogger(__name__)

###############################################################################
# Event Bus – Observer Pattern
###############################################################################


class Event(Protocol):
    """
    Marker protocol for domain events.
    """


Listener = Callable[[Event], None]


class EventBus:
    """
    Thread-safe publish-subscribe event bus.
    """

    _instance: "EventBus" = None
    _lock = threading.RLock()

    def __new__(cls) -> "EventBus":
        if not cls._instance:
            with cls._lock:
                if not cls._instance:
                    cls._instance = super().__new__(cls)
                    cls._instance._subscribers: Dict[type, List[Listener]] = {}
        return cls._instance

    # --------------------------------------------------------------------- #
    def subscribe(self, event_type: type, listener: Listener) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(listener)
            logger.debug(
                "Listener %s subscribed to %s", listener.__qualname__, event_type.__name__
            )

    def unsubscribe(self, event_type: type, listener: Listener) -> None:
        with self._lock:
            listeners = self._subscribers.get(event_type, [])
            if listener in listeners:
                listeners.remove(listener)
                logger.debug(
                    "Listener %s unsubscribed from %s",
                    listener.__qualname__,
                    event_type.__name__,
                )

    # --------------------------------------------------------------------- #
    def publish(self, event: Event) -> None:
        listeners: List[Listener]
        with self._lock:
            listeners = list(self._subscribers.get(type(event), []))

        logger.debug("Publishing %s -> %d listeners", type(event).__name__, len(listeners))
        for listener in listeners:
            try:
                listener(event)
            except Exception:  # pragma: no cover
                logger.exception("Error handling %s by %s", event, listener)


###############################################################################
# Domain Models
###############################################################################


class QuestStatus(Enum):
    """
    State of a quest within the game.
    """

    PENDING = auto()
    ACTIVE = auto()
    COMPLETED = auto()
    FAILED = auto()
    EXPIRED = auto()


@dataclass(slots=True, frozen=True)
class Reward:
    """
    Concrete reward for a quest.
    """

    xp: int = 0
    coins: int = 0
    materials: Dict[str, int] = field(default_factory=dict)


@dataclass
class Quest:
    """
    Quest domain entity.
    """

    id: str
    title: str
    description: str
    due_at: datetime
    status: QuestStatus = QuestStatus.PENDING
    reward: Reward = field(default_factory=Reward)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())


@dataclass
class UserStats:
    """
    Aggregated player statistics.
    """

    xp: int = 0
    coins: int = 0
    materials: Dict[str, int] = field(default_factory=dict)

    def apply_reward(self, reward: Reward) -> None:
        self.xp += reward.xp
        self.coins += reward.coins
        for k, v in reward.materials.items():
            self.materials[k] = self.materials.get(k, 0) + v

###############################################################################
# Events
###############################################################################


@dataclass(frozen=True, slots=True)
class QuestStatusChanged(Event):
    quest_id: str
    old_status: QuestStatus
    new_status: QuestStatus
    timestamp: float = field(default_factory=time.time)


###############################################################################
# Repository Pattern – SQLite Implementation
###############################################################################


class QuestRepository(Protocol):
    """
    Abstraction over quest persistence.
    """

    def add_or_update(self, quest: Quest) -> None: ...

    def delete(self, quest_id: str) -> None: ...

    def get(self, quest_id: str) -> Optional[Quest]: ...

    def list(self, status: Optional[QuestStatus] = None) -> List[Quest]: ...


class SQLiteQuestRepository:
    """
    SQLite concrete repository for quests.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        due_at INTEGER,
        status TEXT,
        reward JSON
    );
    """

    def __init__(self, db_path: Union[str, Path] = "questsmith.db") -> None:
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._prepare_database()

    # ------------------------------------------------------------------ #
    def _prepare_database(self) -> None:
        with self._get_conn() as conn:
            conn.execute(self._SCHEMA)
            conn.commit()
        logger.debug("SQLite DB initialised at %s", self._db_path.resolve())

    # ------------------------------------------------------------------ #
    @contextmanager
    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        try:
            yield conn
        finally:
            conn.close()

    # ------------------------------------------------------------------ #
    def add_or_update(self, quest: Quest) -> None:
        with self._lock, self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO quests (id, title, description, due_at, status, reward)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    description=excluded.description,
                    due_at=excluded.due_at,
                    status=excluded.status,
                    reward=excluded.reward
                """,
                (
                    quest.id,
                    quest.title,
                    quest.description,
                    int(quest.due_at.timestamp()),
                    quest.status.name,
                    json.dumps(quest.reward.__dict__),
                ),
            )
            conn.commit()
        logger.debug("Quest %s persisted with status %s", quest.id, quest.status.name)

    # ------------------------------------------------------------------ #
    def get(self, quest_id: str) -> Optional[Quest]:
        with self._lock, self._get_conn() as conn:
            cur = conn.execute("SELECT * FROM quests WHERE id = ?", (quest_id,))
            row = cur.fetchone()
        return self._row_to_quest(row) if row else None

    # ------------------------------------------------------------------ #
    def delete(self, quest_id: str) -> None:
        with self._lock, self._get_conn() as conn:
            conn.execute("DELETE FROM quests WHERE id = ?", (quest_id,))
            conn.commit()
        logger.debug("Quest %s removed from DB", quest_id)

    # ------------------------------------------------------------------ #
    def list(self, status: Optional[QuestStatus] = None) -> List[Quest]:
        query = "SELECT * FROM quests"
        params: tuple = ()
        if status:
            query += " WHERE status = ?"
            params = (status.name,)

        with self._lock, self._get_conn() as conn:
            cur = conn.execute(query, params)
            rows = cur.fetchall()

        return [self._row_to_quest(r) for r in rows]

    # ------------------------------------------------------------------ #
    @staticmethod
    def _row_to_quest(row: tuple) -> Quest:
        _id, title, description, due_at, status, reward_json = row
        reward_data = json.loads(reward_json)
        return Quest(
            id=_id,
            title=title,
            description=description,
            due_at=datetime.fromtimestamp(due_at),
            status=QuestStatus[status],
            reward=Reward(**reward_data),
        )


###############################################################################
# Factory Pattern – Platform Adapters
###############################################################################


class PushNotificationAdapter(Protocol):
    """
    Adapter for scheduling push notifications.
    """

    def schedule(self, quest: Quest) -> None: ...

    def cancel(self, quest_id: str) -> None: ...


class _DebugPushNotificationAdapter:
    """
    Debug implementation prints to stdout; replace in production.
    """

    def schedule(self, quest: Quest) -> None:  # pragma: no cover
        logger.info("PushNotification scheduled: %s due %s", quest.title, quest.due_at)

    def cancel(self, quest_id: str) -> None:  # pragma: no cover
        logger.info("PushNotification cancelled: %s", quest_id)


###############################################################################
# Crash Reporting Adapter
###############################################################################


class CrashReporterAdapter(Protocol):
    def record_exception(self, exc: Exception) -> None: ...


class _StdErrorCrashReporter:
    def record_exception(self, exc: Exception) -> None:  # pragma: no cover
        logger.error("Crash captured: %s", exc, exc_info=True)


###############################################################################
# Analytics Engine
###############################################################################


class AnalyticsEngine:
    """
    Subscribes to quest events and produces real-time analytics.
    """

    def __init__(self, event_bus: EventBus) -> None:
        self._data_lock = threading.RLock()
        self._quest_counts: Dict[QuestStatus, int] = {}
        event_bus.subscribe(QuestStatusChanged, self._on_quest_status_change)

    # ------------------------------------------------------------------ #
    def _on_quest_status_change(self, event: QuestStatusChanged) -> None:
        with self._data_lock:
            self._quest_counts[event.new_status] = (
                self._quest_counts.get(event.new_status, 0) + 1
            )

    # ------------------------------------------------------------------ #
    def snapshot(self) -> Dict[str, int]:
        """
        Return an immutable copy of the aggregated quest counts.
        """
        with self._data_lock:
            return {status.name: count for status, count in self._quest_counts.items()}


###############################################################################
# Quest Manager – Domain Orchestration
###############################################################################


class QuestManager:
    """
    Core service coordinating quest state changes, rewards, notifications,
    analytics, and persistence.
    """

    def __init__(
        self,
        repository: QuestRepository,
        notification_adapter: PushNotificationAdapter,
        crash_reporter: CrashReporterAdapter,
        event_bus: EventBus,
    ) -> None:
        self._repo = repository
        self._notify = notification_adapter
        self._crash_reporter = crash_reporter
        self._event_bus = event_bus
        self._user_stats = UserStats()

    # ------------------------------------------------------------------ #
    def create_quest(
        self,
        title: str,
        description: str,
        due_in: timedelta,
        reward: Optional[Reward] = None,
    ) -> Quest:
        """
        Convenience wrapper to create & persist a new quest.
        """
        quest = Quest(
            id=str(uuid.uuid4()),
            title=title,
            description=description,
            due_at=datetime.utcnow() + due_in,
            status=QuestStatus.ACTIVE,
            reward=reward or Reward(xp=10, coins=5),
        )
        self._repo.add_or_update(quest)
        self._notify.schedule(quest)
        logger.info("Quest '%s' created (%s)", quest.title, quest.id)
        return quest

    # ------------------------------------------------------------------ #
    def complete_quest(self, quest_id: str) -> None:
        self._transition_status(quest_id, QuestStatus.COMPLETED)

    def fail_quest(self, quest_id: str) -> None:
        self._transition_status(quest_id, QuestStatus.FAILED)

    # ------------------------------------------------------------------ #
    def _transition_status(self, quest_id: str, new_status: QuestStatus) -> None:
        quest = self._repo.get(quest_id)
        if not quest:
            logger.warning("Quest %s not found", quest_id)
            return

        if quest.status is new_status:
            logger.debug("Quest %s already at status %s", quest_id, new_status.name)
            return

        old_status = quest.status
        quest.status = new_status
        self._repo.add_or_update(quest)

        # Cancel notification if final state
        if new_status in {QuestStatus.COMPLETED, QuestStatus.FAILED, QuestStatus.EXPIRED}:
            self._notify.cancel(quest.id)

        # Apply reward
        if new_status == QuestStatus.COMPLETED:
            self._user_stats.apply_reward(quest.reward)

        # Publish domain event
        self._event_bus.publish(
            QuestStatusChanged(quest_id=quest.id, old_status=old_status, new_status=new_status)
        )

        logger.info(
            "Quest %s transitioned %s -> %s", quest.title, old_status.name, new_status.name
        )

    # ------------------------------------------------------------------ #
    def tick(self) -> None:
        """
        Should be called periodically (e.g., from Kivy Clock) to expire quests.
        """
        now = datetime.utcnow()
        for quest in self._repo.list(QuestStatus.ACTIVE):
            if quest.due_at < now:
                self._transition_status(quest.id, QuestStatus.EXPIRED)

    # ------------------------------------------------------------------ #
    def user_stats(self) -> UserStats:
        return self._user_stats

    # ------------------------------------------------------------------ #
    def safe_execute(self, func: Callable[[], Any]) -> Any:
        """
        Executes a callable within a crash-protection wrapper.
        """
        try:
            return func()
        except Exception as exc:  # pragma: no cover
            self._crash_reporter.record_exception(exc)
            raise


###############################################################################
# Factory Methods
###############################################################################


def create_default_quest_manager(db_path: Union[str, Path] = "questsmith.db") -> QuestManager:
    repo = SQLiteQuestRepository(db_path=db_path)
    event_bus = EventBus()
    analytics = AnalyticsEngine(event_bus)
    logger.debug("Analytics engine initialised: %s", analytics)
    return QuestManager(
        repository=repo,
        notification_adapter=_DebugPushNotificationAdapter(),
        crash_reporter=_StdErrorCrashReporter(),
        event_bus=event_bus,
    )


###############################################################################
# Demonstration / Self-test
###############################################################################

if __name__ == "__main__":
    # NOTE: For full application integration this will be replaced by Kivy UI glue,
    # but the following code demonstrates module functionality in isolation.
    manager = create_default_quest_manager()

    # Create a quest that expires in 5 seconds
    quest = manager.create_quest(
        title="Stretch for 2 minutes",
        description="Remember to stretch your legs!",
        due_in=timedelta(seconds=5),
        reward=Reward(xp=15, coins=3, materials={"herb": 1}),
    )

    # Wait, mark it complete before expiration
    time.sleep(2)
    manager.complete_quest(quest.id)

    # Snapshot analytics
    snap = manager.safe_execute(lambda: manager._event_bus._instance._subscribers)  # type: ignore
    logger.info("Listeners registered: %s", snap.keys())

    logger.info("User Stats: %s", manager.user_stats().__dict__)
```