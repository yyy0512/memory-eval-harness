```python
"""
QuestSmith – module_14
======================

This module contains the production–ready implementation of the quest
notification pipeline.  It illustrates several architectural patterns used
throughout the application:

• Repository Pattern – SQLiteQuestRepository centralises data access.
• Observer Pattern  – EventBus propagates quest-related events.
• Factory Pattern   – NotificationAdapterFactory resolves platform specific
                      push-notification adapters.
• MVVM Separation   – NotificationScheduler is a view-model-friendly façade.
• Adapter Pattern   – PlatformNotificationAdapter wraps iOS/Android APIs.

The code is deliberately self-contained.  Interfaces that would normally be
imported from other packages are re-declared in a minimal form so that this
file can be executed and unit-tested in isolation.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import sys
import threading
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, Final, Iterable, List, Optional, Protocol, Set

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #
logger = logging.getLogger("questsmith.module_14")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler(stream=sys.stdout)
_handler.setFormatter(
    logging.Formatter("[%(levelname)s] %(asctime)s – %(name)s: %(message)s")
)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Domain models
# --------------------------------------------------------------------------- #


class QuestStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELED = "canceled"


@dataclass(frozen=True, slots=True)
class Quest:
    """
    Simple Quest value object.
    """

    id: int
    title: str
    due: datetime
    status: QuestStatus
    # Optional location trigger expressed as (lat, lon, radius_m)
    location: Optional[tuple[float, float, float]] = None


@dataclass(frozen=True, slots=True)
class QuestEvent:
    """
    Event dispatched through the EventBus.
    """

    quest_id: int
    type: str
    metadata: Dict[str, Any]


# --------------------------------------------------------------------------- #
# Observer pattern – simple but thread-safe event bus
# --------------------------------------------------------------------------- #


class Observer(Protocol):
    """
    Observer interface for receiving QuestEvents.
    """

    def notify(self, event: QuestEvent) -> None:  # pragma: no cover
        ...


class EventBus:
    """
    Very light-weight, thread-safe event bus.
    """

    _instance: Optional["EventBus"] = None
    _lock: Final = threading.RLock()

    def __init__(self) -> None:
        self._observers: Dict[str, Set[Observer]] = {}
        self._observers_lock = threading.RLock()

    @classmethod
    def instance(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    def register(self, event_type: str, observer: Observer) -> None:
        with self._observers_lock:
            self._observers.setdefault(event_type, set()).add(observer)
        logger.debug("Registered %s for %s", observer, event_type)

    def unregister(self, event_type: str, observer: Observer) -> None:
        with self._observers_lock:
            observers = self._observers.get(event_type)
            if observers and observer in observers:
                observers.discard(observer)
                logger.debug("Unregistered %s from %s", observer, event_type)

    def emit(self, event: QuestEvent) -> None:
        logger.debug("Emitting event: %s", event)
        with self._observers_lock:
            observers = list(self._observers.get(event.type, ()))
        for observer in observers:
            try:
                observer.notify(event)
            except Exception:  # pragma: no cover
                logger.exception("Unhandled exception within observer: %s", observer)


# --------------------------------------------------------------------------- #
# Repository pattern – SQLite implementation
# --------------------------------------------------------------------------- #


class QuestRepository(ABC):
    @abstractmethod
    def get_quest(self, quest_id: int) -> Optional[Quest]: ...

    @abstractmethod
    def get_due_quests(self, before: datetime) -> List[Quest]: ...

    @abstractmethod
    def update_status(self, quest_id: int, status: QuestStatus) -> None: ...


class SQLiteQuestRepository(QuestRepository):
    """
    Production-ready repository for quest persistence.

    The connection is scoped to the instance because `sqlite3.Connection`
    objects are *not* thread-safe by default.
    """

    def __init__(self, db_path: str | Path) -> None:
        self._conn = sqlite3.connect(
            str(db_path), detect_types=sqlite3.PARSE_DECLTYPES, check_same_thread=False
        )
        self._conn.row_factory = sqlite3.Row
        self._create_schema()

    def _create_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS quests (
                id          INTEGER PRIMARY KEY,
                title       TEXT NOT NULL,
                due         TIMESTAMP NOT NULL,
                status      TEXT NOT NULL CHECK (status IN ('pending','in_progress','completed','canceled')),
                lat         REAL,
                lon         REAL,
                radius_m    REAL
            )
            """
        )
        self._conn.commit()

    @contextmanager
    def _cursor(self):
        cur = self._conn.cursor()
        try:
            yield cur
            self._conn.commit()
        finally:
            cur.close()

    def _row_to_quest(self, row: sqlite3.Row) -> Quest:
        location = (
            (row["lat"], row["lon"], row["radius_m"])
            if row["lat"] is not None
            else None
        )
        return Quest(
            id=row["id"],
            title=row["title"],
            due=row["due"].replace(tzinfo=timezone.utc),
            status=QuestStatus(row["status"]),
            location=location,
        )

    def get_quest(self, quest_id: int) -> Optional[Quest]:
        with self._cursor() as cur:
            cur.execute("SELECT * FROM quests WHERE id = ?", (quest_id,))
            row = cur.fetchone()
        return self._row_to_quest(row) if row else None

    def get_due_quests(self, before: datetime) -> List[Quest]:
        utc_before = before.astimezone(timezone.utc)
        with self._cursor() as cur:
            cur.execute("SELECT * FROM quests WHERE due <= ?", (utc_before,))
            rows = cur.fetchall()
        return [self._row_to_quest(r) for r in rows]

    def update_status(self, quest_id: int, status: QuestStatus) -> None:
        logger.debug("Updating quest %s status to %s", quest_id, status)
        with self._cursor() as cur:
            cur.execute(
                "UPDATE quests SET status = ? WHERE id = ?",
                (status.value, quest_id),
            )
        EventBus.instance().emit(
            QuestEvent(
                quest_id=quest_id,
                type="quest_status_changed",
                metadata={"status": status.value},
            )
        )


# --------------------------------------------------------------------------- #
# Adapter & Factory pattern – push notification adapters
# --------------------------------------------------------------------------- #


class NotificationPriority(Enum):
    LOW = "low"
    DEFAULT = "default"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True, slots=True)
class Notification:
    title: str
    body: str
    schedule_at: datetime
    quest_id: int
    priority: NotificationPriority = NotificationPriority.DEFAULT


class NotificationAdapter(ABC):
    """
    Abstract interface for platform-specific notification delivery.
    """

    @abstractmethod
    async def schedule(self, notification: Notification) -> None: ...

    @abstractmethod
    async def cancel(self, notification_id: int) -> None: ...

    @abstractmethod
    async def cancel_by_quest(self, quest_id: int) -> None: ...


class _AndroidNotificationAdapter(NotificationAdapter):
    """
    Placeholder Android implementation.  In production, this would call the
    native side via PyJNIus or a bundled Java/Kotlin bridge.
    """

    async def schedule(self, notification: Notification) -> None:
        logger.info("Android – scheduling notification: %s", notification)

    async def cancel(self, notification_id: int) -> None:
        logger.info("Android – cancel notification_id=%s", notification_id)

    async def cancel_by_quest(self, quest_id: int) -> None:
        logger.info("Android – cancel notifications for quest_id=%s", quest_id)


class _IOSNotificationAdapter(NotificationAdapter):
    """
    Placeholder iOS implementation.  In production, this would call PyObjC
    or a swift-based bridge.
    """

    async def schedule(self, notification: Notification) -> None:
        logger.info("iOS – scheduling notification: %s", notification)

    async def cancel(self, notification_id: int) -> None:
        logger.info("iOS – cancel notification_id=%s", notification_id)

    async def cancel_by_quest(self, quest_id: int) -> None:
        logger.info("iOS – cancel notifications for quest_id=%s", quest_id)


class NotificationAdapterFactory:
    """
    Simple factory that resolves the appropriate notification adapter based
    on runtime conditions (platform, user settings, etc.).
    """

    _ADAPTERS: Dict[str, Callable[[], NotificationAdapter]] = {
        "android": _AndroidNotificationAdapter,
        "ios": _IOSNotificationAdapter,
    }

    @classmethod
    def build(cls, platform: Optional[str] = None) -> NotificationAdapter:
        if platform is None:
            platform = cls._detect_platform()

        adapter_cls = cls._ADAPTERS.get(platform.lower())
        if not adapter_cls:
            raise RuntimeError(f"Unsupported platform: {platform}")

        logger.debug("Instantiated notification adapter for %s", platform)
        return adapter_cls()

    @staticmethod
    def _detect_platform() -> str:
        if sys.platform.startswith("linux") and "ANDROID_ARGUMENT" in sys.argv:
            return "android"
        if sys.platform == "darwin":
            return "ios"
        # Default to android for desktop testing
        return "android"


# --------------------------------------------------------------------------- #
# NotificationScheduler – MVVM-friendly façade
# --------------------------------------------------------------------------- #


class NotificationScheduler(Observer):
    """
    Coordinates quest events with notifications.

    It listens to QuestEvents from the EventBus and schedules/cancels
    platform notifications accordingly.  The scheduler maintains an internal
    asyncio event loop which is owned by the main Kivy/UI thread in the real
    application.  If an event loop is already running (e.g. uvicorn or Kivy),
    it re-uses it to avoid spawning extra threads.
    """

    def __init__(
        self,
        repository: QuestRepository,
        adapter: Optional[NotificationAdapter] = None,
        pre_alert_delta: timedelta = timedelta(minutes=5),
    ) -> None:
        self._repo = repository
        self._adapter = adapter or NotificationAdapterFactory.build()
        self._pre_alert_delta = pre_alert_delta

        self._loop = self._get_or_create_event_loop()
        self._register_events()

    # --------------------------------------------------------------------- #
    # EventBus integration
    # --------------------------------------------------------------------- #

    def _register_events(self) -> None:
        bus = EventBus.instance()
        bus.register("quest_created", self)
        bus.register("quest_status_changed", self)

    def notify(self, event: QuestEvent) -> None:
        logger.debug("NotificationScheduler received event: %s", event)
        if event.type == "quest_created":
            self._schedule_notifications(event.quest_id)
        elif event.type == "quest_status_changed":
            status = event.metadata.get("status")
            if status in (QuestStatus.COMPLETED.value, QuestStatus.CANCELED.value):
                self._cancel_notifications(event.quest_id)
            else:
                self._schedule_notifications(event.quest_id)

    # --------------------------------------------------------------------- #
    # Private helpers
    # --------------------------------------------------------------------- #

    def _schedule_notifications(self, quest_id: int) -> None:
        quest = self._repo.get_quest(quest_id)
        if not quest:
            logger.warning("Quest id=%s not found for scheduling", quest_id)
            return

        if quest.status in (QuestStatus.COMPLETED, QuestStatus.CANCELED):
            logger.debug("Quest id=%s already completed/canceled; skipping", quest_id)
            return

        notify_at = quest.due - self._pre_alert_delta
        if notify_at < datetime.now(tz=timezone.utc):
            logger.debug("Notification time in the past; sending immediate alert")
            notify_at = datetime.now(tz=timezone.utc) + timedelta(seconds=1)

        notification = Notification(
            title="Quest Reminder",
            body=f"'{quest.title}' is due soon!",
            schedule_at=notify_at,
            quest_id=quest.id,
            priority=NotificationPriority.HIGH,
        )

        asyncio.run_coroutine_threadsafe(
            self._adapter.schedule(notification), self._loop
        )

    def _cancel_notifications(self, quest_id: int) -> None:
        asyncio.run_coroutine_threadsafe(
            self._adapter.cancel_by_quest(quest_id), self._loop
        )

    # --------------------------------------------------------------------- #
    # Event loop management
    # --------------------------------------------------------------------- #

    @staticmethod
    def _get_or_create_event_loop() -> asyncio.AbstractEventLoop:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            threading.Thread(
                target=NotificationScheduler._run_event_loop,
                args=(loop,),
                name="notification-event-loop",
                daemon=True,
            ).start()
            return loop

    @staticmethod
    def _run_event_loop(loop: asyncio.AbstractEventLoop) -> None:  # pragma: no cover
        asyncio.set_event_loop(loop)
        loop.run_forever()


# --------------------------------------------------------------------------- #
# Convenience bootstrap function
# --------------------------------------------------------------------------- #


def bootstrap_notifications(
    db_path: str | Path = ":memory:",
    platform: Optional[str] = None,
) -> NotificationScheduler:
    """
    Initialise repository, adapter, and scheduler.  Intended to be called
    once during application start-up.
    """
    repository = SQLiteQuestRepository(db_path=db_path)
    adapter = NotificationAdapterFactory.build(platform=platform)
    scheduler = NotificationScheduler(repository=repository, adapter=adapter)
    logger.info("Notification subsystem ready")
    return scheduler


# --------------------------------------------------------------------------- #
# When executed as script, run a tiny smoke test
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # Smoke test for development purposes only
    scheduler = bootstrap_notifications()

    repo = scheduler._repo  # type: ignore[attr-defined]
    now = datetime.now(tz=timezone.utc)

    # Create a quest directly in the DB for demonstration
    with repo._cursor() as cur:  # type: ignore[attr-defined]
        cur.execute(
            """
            INSERT INTO quests (id, title, due, status)
            VALUES (?, ?, ?, ?)
            """,
            (1, "Write unit tests", now + timedelta(minutes=10), QuestStatus.PENDING),
        )

    # Emit quest created event
    EventBus.instance().emit(
        QuestEvent(quest_id=1, type="quest_created", metadata={})
    )

    # Wait a beat for async tasks to schedule
    import time

    time.sleep(1)
    print("Smoke test completed.")
```