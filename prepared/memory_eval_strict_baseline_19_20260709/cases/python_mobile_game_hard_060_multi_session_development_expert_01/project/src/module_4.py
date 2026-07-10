```python
"""
QuestSmith – module_4.py
=======================

Core domain services and infrastructure glue used throughout the QuestSmith
mobile application.  This file purposefully groups components that must be
singletons or *nearly* singletons inside the process:

1. EventBus – lightweight Observer implementation used by every layer.
2. QuestRepository – Repository-Pattern façade around the SQLite data store.
3. QuestEngine – domain service that implements quest completion logic,
   adaptive rewards, and publishes high-level domain events.
4. Default observers for analytics and push-notification scheduling.

The code is 100 % stdlib to keep the monolith self-contained and easy to
vendor on mobile platforms where binary wheels are not an option.

Author: QuestSmith Engineering Team
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import datetime as _dt
import enum
import logging
import sqlite3
import sys
import threading
import types
import weakref
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────

_LOGGER = logging.getLogger("questsmith")
if not _LOGGER.handlers:  # Avoid duplicate logs in unit-test reloads
    _handler = logging.StreamHandler(stream=sys.stdout)
    _handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s "
            "%(name)s:%(lineno)d – %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    _LOGGER.addHandler(_handler)
    _LOGGER.setLevel(logging.INFO)

# ──────────────────────────────────────────────────────────────────────────────
# Event Bus (Observer Pattern)
# ──────────────────────────────────────────────────────────────────────────────


class EventBus:
    """
    Tiny, thread-safe event bus using weak references so that subscribers do
    not *have* to unsubscribe explicitly – garbage collection is enough.

    The implementation is intentionally minimal to keep footprint down whilst
    still being fully production-grade for QuestSmith’s needs.
    """

    _instance_lock = threading.Lock()
    _instance: Optional["EventBus"] = None

    def __new__(cls) -> "EventBus":  # Singleton
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._listeners: Dict[str, List[weakref.ref]] = {}
                cls._instance._loop = asyncio.get_event_loop()
            return cls._instance

    # --------------------------------------------------------------------- #
    # API
    # --------------------------------------------------------------------- #

    def subscribe(
        self, event_name: str, callback: Callable[..., Any]
    ) -> Callable[[], None]:
        """
        Subscribe `callback` to `event_name`.

        Returns
        -------
        unsubscribe : Callable
            A callable to remove this specific listener instance.
        """

        ref: weakref.ref  # Fine-grained typing below
        if isinstance(callback, types.MethodType):
            ref = weakref.WeakMethod(callback)  # Keeps obj alive only weakly
        else:
            ref = weakref.ref(callback)

        self._listeners.setdefault(event_name, []).append(ref)
        _LOGGER.debug("Subscribed %s to %s", callback, event_name)

        def _unsubscribe() -> None:
            listeners = self._listeners.get(event_name, [])
            with contextlib.suppress(ValueError):
                listeners.remove(ref)
            _LOGGER.debug("Unsubscribed %s from %s", callback, event_name)

        return _unsubscribe

    # alias
    on = subscribe

    def publish(self, event_name: str, **payload: Any) -> None:
        """
        Fire an event on the bus.  Publication is **non-blocking**:
        callbacks are dispatched on the event loop with `create_task`.

        Parameters
        ----------
        event_name : str
            Name of the event, e.g. ``"quest_completed"``.
        payload : dict
            Arbitrary keyword arguments forwarded to the subscribers.
        """
        listeners = self._listeners.get(event_name, []).copy()
        if not listeners:
            _LOGGER.debug("No listeners for event %s", event_name)
            return

        for ref in listeners:
            cb = ref()
            if cb is None:
                # Target object was GC’d – drop stale ref.
                with contextlib.suppress(ValueError):
                    self._listeners[event_name].remove(ref)
                continue

            async def _invoke(listener: Callable[..., Any]) -> None:
                try:
                    result = listener(**payload)
                    if isinstance(result, Awaitable):
                        await result
                except Exception:  # noqa: BLE001 – we *must* isolate failures
                    _LOGGER.exception(
                        "Exception handling event '%s' in %s",
                        event_name,
                        listener,
                    )

            # fire-and-forget; keeps UI snappy
            self._loop.create_task(_invoke(cb))


# Global singleton for convenience
event_bus = EventBus()

# ──────────────────────────────────────────────────────────────────────────────
# Domain Model
# ──────────────────────────────────────────────────────────────────────────────


class QuestStatus(str, enum.Enum):
    OPEN = "open"
    COMPLETED = "completed"
    FAILED = "failed"
    ARCHIVED = "archived"


@dataclasses.dataclass(slots=True)
class Quest:
    id: Optional[int]
    title: str
    description: str
    due: _dt.datetime
    xp: int
    status: QuestStatus = QuestStatus.OPEN
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    # Convenience for SQLite row ⇄ object mapping
    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Quest":
        return cls(
            id=row["id"],
            title=row["title"],
            description=row["description"],
            due=_dt.datetime.fromisoformat(row["due"]),
            xp=row["xp"],
            status=QuestStatus(row["status"]),
            latitude=row["latitude"],
            longitude=row["longitude"],
        )


@dataclasses.dataclass(slots=True)
class Reward:
    xp_gained: int
    currency: int
    materials: int


# ──────────────────────────────────────────────────────────────────────────────
# Repository Pattern: QuestRepository
# ──────────────────────────────────────────────────────────────────────────────


class QuestRepository:
    """
    Unified access layer around the SQLite database.  The class must be async
    because the rest of the codebase (Kivy side) is driven by `asyncio`.

    The repository uses *one* connection opened in «autocommit» mode (isolation
    level = None).  Operations are executed inside `asyncio.to_thread` to avoid
    blocking the event loop.  This is fast enough for mobile workloads while
    requiring no external dependencies (aiosqlite, sqlalchemy…).
    """

    _lock = threading.Lock()
    _instance: Optional["QuestRepository"] = None

    def __new__(cls, db_path: str | Path | None = None) -> "QuestRepository":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init(str(db_path or "quests.db"))
            return cls._instance

    # ------------------------------------------------------------------ #
    # Init helpers
    # ------------------------------------------------------------------ #

    def _init(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn = sqlite3.connect(
            db_path, check_same_thread=False, isolation_level=None
        )
        self._conn.row_factory = sqlite3.Row
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS quests (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                description TEXT,
                due         TEXT NOT NULL,
                xp          INTEGER NOT NULL,
                status      TEXT NOT NULL,
                latitude    REAL,
                longitude   REAL
            );
            CREATE INDEX IF NOT EXISTS idx_quests_status ON quests(status);
            """
        )
        _LOGGER.debug("Database schema ensured at %s", self._db_path)

    # ------------------------------------------------------------------ #
    # CRUD
    # ------------------------------------------------------------------ #

    async def add_quest(self, quest: Quest) -> int:
        """
        Insert quest and return the newly assigned row id.
        """
        _LOGGER.debug("Adding quest %s", quest)
        return await asyncio.to_thread(self._add_quest_sync, quest)

    def _add_quest_sync(self, quest: Quest) -> int:
        cursor = self._conn.execute(
            """
            INSERT INTO quests (
                title, description, due, xp,
                status, latitude, longitude
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                quest.title,
                quest.description,
                quest.due.isoformat(),
                quest.xp,
                quest.status.value,
                quest.latitude,
                quest.longitude,
            ),
        )
        quest_id = int(cursor.lastrowid)
        _LOGGER.info("Quest added with id=%s", quest_id)
        return quest_id

    async def get_quest_by_id(self, quest_id: int) -> Optional[Quest]:
        return await asyncio.to_thread(self._get_quest_by_id_sync, quest_id)

    def _get_quest_by_id_sync(self, quest_id: int) -> Optional[Quest]:
        cur = self._conn.execute(
            "SELECT * FROM quests WHERE id = ?", (quest_id,)
        )
        row = cur.fetchone()
        return Quest.from_row(row) if row else None

    async def update_quest_status(
        self, quest_id: int, status: QuestStatus
    ) -> None:
        await asyncio.to_thread(self._update_quest_status_sync, quest_id, status)

    def _update_quest_status_sync(
        self, quest_id: int, status: QuestStatus
    ) -> None:
        self._conn.execute(
            "UPDATE quests SET status = ? WHERE id = ?",
            (status.value, quest_id),
        )
        _LOGGER.debug("Quest %s updated to %s", quest_id, status.value)

    async def list_active_quests(self) -> List[Quest]:
        return await asyncio.to_thread(self._list_active_quests_sync)

    def _list_active_quests_sync(self) -> List[Quest]:
        cur = self._conn.execute(
            """
            SELECT * FROM quests
            WHERE status = ? AND due >= ?
            ORDER BY due ASC
            """,
            (QuestStatus.OPEN.value, _dt.datetime.utcnow().isoformat()),
        )
        return [Quest.from_row(r) for r in cur.fetchall()]


# Global repository singleton
quest_repo = QuestRepository()

# ──────────────────────────────────────────────────────────────────────────────
# Quest Engine – domain service
# ──────────────────────────────────────────────────────────────────────────────


class QuestEngineError(Exception):
    """Base class for QuestEngine exceptions."""


class QuestAlreadyCompleted(QuestEngineError):
    """Raised when attempting to complete an already completed quest."""


class QuestEngine:
    """
    Domain service responsible for:

    • Validating quest completion.
    • Granting adaptive rewards.
    • Publishing domain events.
    """

    def __init__(
        self,
        repository: QuestRepository | None = None,
        bus: EventBus | None = None,
    ) -> None:
        self._repo = repository or quest_repo
        self._bus = bus or event_bus

    # ------------------------------------------------------------------ #
    # Business logic
    # ------------------------------------------------------------------ #

    async def complete_quest(self, quest_id: int) -> Reward:
        """
        Mark quest as completed and calculate reward.

        Emits:
        -------
        event_name='quest_completed'
            quest   : Quest
            reward  : Reward
        """
        quest = await self._repo.get_quest_by_id(quest_id)
        if quest is None:
            raise QuestEngineError(f"Quest id {quest_id} does not exist")

        if quest.status == QuestStatus.COMPLETED:
            raise QuestAlreadyCompleted(f"Quest {quest_id} already done")

        # Basic adaptive difficulty: later due ⇒ harder ⇒ more reward
        now = _dt.datetime.utcnow()
        seconds_before_due = max(
            (quest.due - now).total_seconds(), 0
        )  # ≥0 because due can be in past
        bonus_multiplier = 1.0 + (seconds_before_due / 86_400) * 0.1  # 10 % / day

        reward = Reward(
            xp_gained=int(quest.xp * bonus_multiplier),
            currency=int(10 * bonus_multiplier),
            materials=int(3 * bonus_multiplier),
        )

        await self._repo.update_quest_status(quest_id, QuestStatus.COMPLETED)

        # Update local object to reflect new status
        quest.status = QuestStatus.COMPLETED

        # Fire domain event
        self._bus.publish("quest_completed", quest=quest, reward=reward)

        _LOGGER.info(
            "Quest %s completed. Reward: %s xp, %s currency, %s mats",
            quest_id,
            reward.xp_gained,
            reward.currency,
            reward.materials,
        )
        return reward


# ──────────────────────────────────────────────────────────────────────────────
# Observers
# ──────────────────────────────────────────────────────────────────────────────


class AnalyticsObserver:
    """
    Very lightweight analytics sink.
    In production this would enqueue the event into the analytics engine.
    """

    def __init__(self) -> None:
        event_bus.subscribe("quest_completed", self._on_quest_completed)

    def _on_quest_completed(self, quest: Quest, reward: Reward) -> None:
        _LOGGER.info(
            "[Analytics] Quest '%s' (%s) completed – +%s xp",
            quest.title,
            quest.id,
            reward.xp_gained,
        )
        # Here we would call analytics_service.track(...)


class PushNotificationObserver:
    """
    Schedules follow-up notifications after quest completion
    (e.g., “Try a harder quest next!”).  For demo purposes we only log.
    """

    def __init__(self) -> None:
        event_bus.subscribe("quest_completed", self._handle)

    async def _handle(self, quest: Quest, reward: Reward) -> None:
        await asyncio.sleep(1.0)  # simulate async call to OS scheduler
        _LOGGER.info(
            "[PushNotification] Congrats on completing '%s'! "
            "You've earned %s xp.",
            quest.title,
            reward.xp_gained,
        )
        # push_service.schedule(...)


def register_default_observers() -> None:
    """
    The DI container (or the Kivy App class) can call this once at boot.
    """
    AnalyticsObserver()
    PushNotificationObserver()
    _LOGGER.debug("Default observers registered.")


# ──────────────────────────────────────────────────────────────────────────────
# Development harness
# ──────────────────────────────────────────────────────────────────────────────

async def _demo() -> None:
    """
    Quick in-module demonstration when executing:

        python -m src.module_4
    """
    register_default_observers()

    engine = QuestEngine()

    # Build a sample quest scheduled for later today
    quest = Quest(
        id=None,
        title="Finish QuestSmith PRD",
        description="Complete the product requirement doc for QuestSmith 1.0",
        due=_dt.datetime.utcnow() + _dt.timedelta(hours=3),
        xp=50,
    )
    quest_id = await quest_repo.add_quest(quest)

    # Complete the quest
    await engine.complete_quest(quest_id)

    # List still-open quests
    open_quests = await quest_repo.list_active_quests()
    _LOGGER.info("Remaining open quests: %s", len(open_quests))


if __name__ == "__main__":
    try:
        asyncio.run(_demo())
    except KeyboardInterrupt:
        pass
```