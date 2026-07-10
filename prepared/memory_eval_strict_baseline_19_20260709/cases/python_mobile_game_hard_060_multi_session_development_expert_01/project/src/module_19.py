```python
"""
QuestSmith – Notification Scheduling Module
===========================================

src/module_19.py
----------------
This module contains the production-ready implementation of the push-
notification scheduling system used by QuestSmith.  It connects the domain
event-bus with a platform-specific push-notification adapter and the quest
repository, applying the Observer, Factory and Repository patterns in a single
cohesive component.

Key responsibilities
--------------------
1. Listen for quest-status changes and (re)schedule mobile push notifications.
2. Perform initial scheduling of all active quests when the application starts.
3. Abstract platform specifics behind a *PushServiceAdapter* so that the core
   logic remains pure Python and is covered by unit tests.
"""

from __future__ import annotations

import abc
import asyncio
import enum
import logging
import platform
import sys
import threading
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional

# --------------------------------------------------------------------------------------
# Logging setup
# --------------------------------------------------------------------------------------

LOGGER = logging.getLogger("questsmith.notification_scheduler")
_HANDLER = logging.StreamHandler(sys.stdout)
_HANDLER.setFormatter(
    logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
)
LOGGER.addHandler(_HANDLER)
LOGGER.setLevel(logging.INFO)

# --------------------------------------------------------------------------------------
# Domain models & events (light-weight public contracts)
# --------------------------------------------------------------------------------------


class QuestStatus(enum.Enum):
    """Subset of Quest status values that affect notification scheduling."""

    PENDING = "pending"  # Quest exists but not completed.
    COMPLETED = "completed"
    ABANDONED = "abandoned"


@dataclass(frozen=True)
class Quest:
    """Relevant quest information required for scheduling."""

    id: str
    title: str
    due_at: datetime
    status: QuestStatus


@dataclass(frozen=True)
class QuestStatusChangedEvent:
    """Domain event emitted when a quest's status changes."""

    quest_id: str
    old_status: QuestStatus
    new_status: QuestStatus


# --------------------------------------------------------------------------------------
# Event-bus contract (simplified Observer pattern)
# --------------------------------------------------------------------------------------


class EventBus:
    """A minimal Observer event-bus interface."""

    def subscribe(
        self, event_type: type, consumer: Callable[[object], None], *, weak: bool = True
    ) -> None: ...

    def unsubscribe(self, event_type: type, consumer: Callable[[object], None]) -> None:
        ...

    def publish(self, event: object) -> None: ...


# --------------------------------------------------------------------------------------
# Repository contract
# --------------------------------------------------------------------------------------


class QuestRepository(abc.ABC):
    """Abstract quest repository used by the scheduler."""

    @abc.abstractmethod
    async def get(self, quest_id: str) -> Optional[Quest]:
        """Return a quest or ``None`` if it does not exist."""
        raise NotImplementedError

    @abc.abstractmethod
    async def list_active(self) -> list[Quest]:
        """Return all quests that are still pending."""
        raise NotImplementedError


# --------------------------------------------------------------------------------------
# Push-notification adapter and factory
# --------------------------------------------------------------------------------------


class PushServiceAdapter(abc.ABC):
    """
    Platform-specific push-notification adapter interface.

    Methods should raise *RuntimeError* on failure so that the scheduler can
    detect and recover gracefully.
    """

    @abc.abstractmethod
    def schedule_notification(
        self,
        title: str,
        message: str,
        when: datetime,
        payload: Optional[dict] = None,
    ) -> str:
        """
        Schedule a new push notification.

        Returns a *notification_id* that can later be used to cancel the
        notification.
        """
        raise NotImplementedError

    @abc.abstractmethod
    def cancel_notification(self, notification_id: str) -> None:
        """Cancel a previously scheduled notification."""
        raise NotImplementedError


# Concrete adapters (high-level stubs)
# ------------------------------------


class _AndroidPushAdapter(PushServiceAdapter):
    """Android push implementation stub."""

    def schedule_notification(
        self, title: str, message: str, when: datetime, payload: Optional[dict] = None
    ) -> str:
        # Real implementation would integrate with Android AlarmManager + WorkManager.
        notification_id = f"android:{hash((title, when))}"
        LOGGER.debug("Android schedule %s @ %s", title, when.isoformat())
        return notification_id

    def cancel_notification(self, notification_id: str) -> None:
        LOGGER.debug("Android cancel %s", notification_id)


class _IOSPushAdapter(PushServiceAdapter):
    """iOS push implementation stub."""

    def schedule_notification(
        self, title: str, message: str, when: datetime, payload: Optional[dict] = None
    ) -> str:
        notification_id = f"ios:{hash((title, when))}"
        LOGGER.debug("iOS schedule %s @ %s", title, when.isoformat())
        return notification_id

    def cancel_notification(self, notification_id: str) -> None:
        LOGGER.debug("iOS cancel %s", notification_id)


class _DebugPushAdapter(PushServiceAdapter):
    """Development fallback adapter that only logs."""

    def schedule_notification(
        self, title: str, message: str, when: datetime, payload: Optional[dict] = None
    ) -> str:
        notification_id = f"debug:{hash((title, when))}"
        LOGGER.info("[DEBUG] Scheduled '%s' for %s (id=%s)", title, when, notification_id)
        return notification_id

    def cancel_notification(self, notification_id: str) -> None:
        LOGGER.info("[DEBUG] Canceled notification %s", notification_id)


def create_push_adapter() -> PushServiceAdapter:
    """
    Factory that returns a platform-appropriate push-service adapter.

    The adapter implementation is chosen at runtime so that the core game logic
    is agnostic of the underlying OS.
    """
    system = platform.system().lower()
    LOGGER.debug("Selecting push adapter for platform '%s'", system)
    if system == "android":
        return _AndroidPushAdapter()
    if system == "ios":
        return _IOSPushAdapter()
    return _DebugPushAdapter()


# --------------------------------------------------------------------------------------
# Notification scheduler
# --------------------------------------------------------------------------------------


class NotificationScheduler:
    """
    Observes quest events and handles push-notification life-cycle.

    Public API:
        • start() – start listening for events and schedule pending quests.
        • stop()  – unsubscribe from the event-bus and cancel scheduled tasks.
    """

    # Reminder offset: send notification X minutes before the quest is due.
    DEFAULT_REMINDER_OFFSET = timedelta(minutes=15)

    def __init__(
        self,
        *,
        event_bus: EventBus,
        repository: QuestRepository,
        push_adapter: PushServiceAdapter | None = None,
        tz: timezone = timezone.utc,
    ) -> None:
        self._bus = event_bus
        self._repo = repository
        self._push = push_adapter or create_push_adapter()
        self._tz = tz

        # quest_id  -> notification_id
        self._scheduled: Dict[str, str] = {}

        # Concurrency / shutdown control
        self._loop = asyncio.new_event_loop()
        self._thread: Optional[threading.Thread] = None
        self._stop_requested = threading.Event()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Boot the scheduler in a background thread."""
        LOGGER.info("Starting notification scheduler.")
        self._bus.subscribe(QuestStatusChangedEvent, self._on_quest_status_changed)

        # Background loop handling async repository calls.
        self._thread = threading.Thread(
            target=self._run_event_loop, name="NotificationSchedulerLoop", daemon=True
        )
        self._thread.start()

        # Schedule existing active quests.
        asyncio.run_coroutine_threadsafe(self._initial_schedule(), self._loop)

    def stop(self) -> None:
        """Shutdown the scheduler cleanly."""
        LOGGER.info("Stopping notification scheduler.")
        with suppress(Exception):
            self._bus.unsubscribe(QuestStatusChangedEvent, self._on_quest_status_changed)

        self._stop_requested.set()
        if self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    # ------------------------------------------------------------------
    # Event handling
    # ------------------------------------------------------------------

    def _on_quest_status_changed(self, event: QuestStatusChangedEvent) -> None:
        """
        Event-bus callback triggered by quest status changes.

        The method offloads the heavy lifting to the async loop so that we don't
        block the event-bus.  Errors are logged but swallowed to avoid crashing
        the bus.
        """
        LOGGER.debug("Quest status changed: %s", event)
        asyncio.run_coroutine_threadsafe(
            self._handle_status_change(event), self._loop
        ).add_done_callback(self._log_task_exception)

    async def _handle_status_change(self, event: QuestStatusChangedEvent) -> None:
        quest = await self._repo.get(event.quest_id)
        if not quest:
            LOGGER.warning("Quest '%s' no longer exists – ignoring event", event.quest_id)
            return

        try:
            if event.new_status == QuestStatus.PENDING:
                self._schedule_quest(quest)
            else:  # quest completed / abandoned
                self._cancel_quest(quest.id)
        except Exception as exc:
            LOGGER.exception("Failed to adjust notification for quest %s: %s", quest.id, exc)

    # ------------------------------------------------------------------
    # Scheduling logic
    # ------------------------------------------------------------------

    async def _initial_schedule(self) -> None:
        """Schedule all active quests on startup."""
        LOGGER.info("Scheduling existing quests …")
        active = await self._repo.list_active()
        for quest in active:
            try:
                self._schedule_quest(quest)
            except Exception as exc:  # pragma: no cover
                LOGGER.exception("Cannot schedule quest %s: %s", quest.id, exc)
        LOGGER.info("Initial scheduling complete (%d quests).", len(active))

    def _schedule_quest(self, quest: Quest) -> None:
        """Schedule or reschedule the notification for a single quest."""
        self._cancel_quest(quest.id)  # ensure no duplicates

        trigger_time = (quest.due_at - self.DEFAULT_REMINDER_OFFSET).astimezone(self._tz)

        # Edge case: trigger time already passed → schedule immediate notification.
        now = datetime.now(tz=self._tz)
        if trigger_time <= now:
            LOGGER.debug(
                "Trigger time %s for quest '%s' is in the past – sending immediate.",
                trigger_time,
                quest.id,
            )
            trigger_time = now + timedelta(seconds=5)  # small buffer

        nid = self._push.schedule_notification(
            title=quest.title,
            message="Quest is almost due! ⏰",
            when=trigger_time,
            payload={"quest_id": quest.id},
        )
        self._scheduled[quest.id] = nid
        LOGGER.info(
            "Notification scheduled for quest %s at %s (id=%s)",
            quest.id,
            trigger_time.isoformat(),
            nid,
        )

    def _cancel_quest(self, quest_id: str) -> None:
        """Cancel any previously scheduled notification for the quest."""
        nid = self._scheduled.pop(quest_id, None)
        if nid is None:
            return
        try:
            self._push.cancel_notification(nid)
            LOGGER.info("Canceled scheduled notification %s for quest %s", nid, quest_id)
        except Exception as exc:  # pragma: no cover
            LOGGER.exception("Failed to cancel notification %s: %s", nid, exc)

    # ------------------------------------------------------------------
    # Async-loop helpers
    # ------------------------------------------------------------------

    def _run_event_loop(self) -> None:
        """Run the internal asyncio event-loop until stop is requested."""
        asyncio.set_event_loop(self._loop)
        while not self._stop_requested.is_set():
            try:
                self._loop.run_forever()
            except RuntimeError:  # loop stopped
                break
            except Exception as exc:  # pragma: no cover
                LOGGER.exception("Async loop error: %s", exc)
        self._loop.close()
        LOGGER.debug("Notification scheduler loop closed.")

    @staticmethod
    def _log_task_exception(task: asyncio.Future) -> None:
        """Callback to ensure exceptions in background tasks are logged."""
        with suppress(asyncio.CancelledError):
            exc = task.exception()
            if exc:
                LOGGER.exception("Background task failed: %s", exc)


# --------------------------------------------------------------------------------------
# Convenience bootstrapper (used by the Kivy App delegate)
# --------------------------------------------------------------------------------------

_scheduler_singleton: Optional[NotificationScheduler] = None


def initialize_scheduler(
    *, event_bus: EventBus, repository: QuestRepository, tz: timezone = timezone.utc
) -> NotificationScheduler:
    """
    Create and start the global notification scheduler singleton.

    The function is idempotent – repeated calls re-use the existing instance.
    """
    global _scheduler_singleton
    if _scheduler_singleton:
        return _scheduler_singleton

    LOGGER.debug("Bootstrapping global NotificationScheduler singleton.")
    _scheduler_singleton = NotificationScheduler(
        event_bus=event_bus, repository=repository, tz=tz
    )
    _scheduler_singleton.start()
    return _scheduler_singleton
```