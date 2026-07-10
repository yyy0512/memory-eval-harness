```python
"""
src/module_21.py

QuestSmith – Productivity RPG Forge
-----------------------------------
This module contains an Observer-based event bus and a push-notification
scheduler that demonstrates the Repository, Factory, and Adapter patterns.
It is self-contained and does not rely on any other QuestSmith modules so
that it can be executed in isolation for unit testing purposes.

Key responsibilities
====================
1. EventBus          – Thread-safe publish / subscribe implementation.
2. NotificationScheduler
                     – Listens for quest events and orchestrates push
                       notifications based on user preferences.
3. Factory classes   – Produce platform-specific adapters while keeping
                       the core logic completely platform-agnostic.
4. Repository stubs  – CRUD interface for user notification settings.

The code is production-quality: type-annotated, well-documented, Exception-
aware, and designed with extensibility in mind.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
import weakref
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Dict, Generic, Iterable, List, Optional, Type, TypeVar

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

LOGGER_NAME = "questsmith.module_21"
logger = logging.getLogger(LOGGER_NAME)
if not logger.handlers:
    # Prevent double-adding handlers if the module is reloaded
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s – %(levelname)s – %(name)s – %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Event system (Observer Pattern)                                             #
# --------------------------------------------------------------------------- #

E = TypeVar("E", bound="BaseEvent")
Subscriber = Callable[[E], None]


class BaseEvent(ABC):
    """
    Root class for all events that can pass through the EventBus.
    """

    __slots__ = ("timestamp", "event_id")

    def __init__(self) -> None:
        self.timestamp: float = time.time()
        self.event_id: str = uuid.uuid4().hex

    @property
    def pretty_time(self) -> str:
        return datetime.fromtimestamp(self.timestamp).isoformat(sep=" ", timespec="seconds")


@dataclass(frozen=True, slots=True)
class QuestCompletedEvent(BaseEvent):
    """
    Raised when a quest has been successfully completed.
    """

    user_id: str
    quest_id: str
    exp_gained: int
    materials_gained: Dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class QuestFailedEvent(BaseEvent):
    """
    Raised when a quest has failed (e.g., due deadline miss).
    """

    user_id: str
    quest_id: str
    penalty: int


class EventBus:
    """
    A thread-safe pub/sub event bus implementation.
    Each subscriber is weak-referenced to avoid memory leaks when views
    get destroyed in the Kivy UI layer.
    """

    _lock: threading.RLock
    _subscribers: Dict[Type[BaseEvent], List[weakref.ReferenceType[Subscriber]]]

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers = {}

    # Public API ------------------------------------------------------------ #

    def subscribe(self, event_type: Type[E], callback: Subscriber[E]) -> Callable[[], None]:
        """
        Subscribe a callback for the given event type.

        Returns a function that, when called, unsubscribes the callback.
        """
        if not callable(callback):
            raise TypeError("callback must be callable")

        with self._lock:
            logger.debug("Subscribing %s to %s", callback, event_type)
            self._subscribers.setdefault(event_type, []).append(weakref.ref(callback))

        def _unsubscribe() -> None:
            self.unsubscribe(event_type, callback)

        return _unsubscribe

    def unsubscribe(self, event_type: Type[E], callback: Subscriber[E]) -> None:
        """
        Unsubscribe a callback from the given event type.
        """
        with self._lock:
            refs = self._subscribers.get(event_type, [])
            self._subscribers[event_type] = [
                ref for ref in refs if ref() is not None and ref() != callback
            ]
            logger.debug("Unsubscribed %s from %s", callback, event_type)

    def publish(self, event: E) -> None:
        """
        Publish an event to all subscribers, executing callbacks on the
        current thread. Exceptions inside callbacks are caught and logged
        individually so that a single faulty subscriber does not break the
        entire chain.
        """
        logger.info("Publishing %s", event)
        with self._lock:
            subscribers = list(self._subscribers.get(type(event), []))

        for ref in subscribers:
            callback = ref()
            if callback is None:
                # The subscribing object has likely been GC'ed
                continue
            try:
                callback(event)
            except Exception as exc:  # pylint: disable=broad-exception-caught
                logger.exception("Error in subscriber '%s': %s", callback, exc)

    # Introspection API ----------------------------------------------------- #

    def get_subscriber_count(self, event_type: Type[E]) -> int:
        """
        Return the number of active subscribers for the provided event type.
        """
        with self._lock:
            return sum(1 for ref in self._subscribers.get(event_type, []) if ref() is not None)


# --------------------------------------------------------------------------- #
# Repository Pattern – User notification settings                             #
# --------------------------------------------------------------------------- #

class NotificationSettingsRepository(ABC):
    """
    Contract for persisting and retrieving user notification preferences.
    """

    @abstractmethod
    def is_enabled(self, user_id: str) -> bool:
        """Return True if notifications are enabled for the given user."""

    @abstractmethod
    def get_daily_summary_time(self, user_id: str) -> Optional[datetime.time]:
        """Return the preferred time when the user receives daily summary notifications."""


class InMemoryNotificationSettingsRepository(NotificationSettingsRepository):
    """
    Simplistic in-memory implementation suitable for prototyping and unit tests.
    """

    def __init__(self) -> None:
        # For a real app this would be SQLite or a remote backend.
        self._enabled: Dict[str, bool] = {}
        self._summary_time: Dict[str, datetime.time] = {}

    def set_enabled(self, user_id: str, enabled: bool) -> None:
        self._enabled[user_id] = enabled

    def set_daily_summary_time(self, user_id: str, summary_time: datetime.time) -> None:
        self._summary_time[user_id] = summary_time

    # Implement abstract methods
    def is_enabled(self, user_id: str) -> bool:
        return self._enabled.get(user_id, True)

    def get_daily_summary_time(self, user_id: str) -> Optional[datetime.time]:
        return self._summary_time.get(user_id, None)


# --------------------------------------------------------------------------- #
# Adapter Pattern – Platform push notification abstraction                    #
# --------------------------------------------------------------------------- #

class PushNotificationAdapter(ABC):
    """
    Abstracts platform-specific push/local notification APIs so that core
    logic can remain decoupled from Android/iOS SDKs.
    """

    @abstractmethod
    def schedule_local_notification(
        self,
        user_id: str,
        title: str,
        message: str,
        when: datetime,
        payload: Optional[Dict[str, str]] = None,
    ) -> None:
        """
        Schedule a one-time local notification for the specified moment.
        """

    @abstractmethod
    def cancel_all_notifications(self, user_id: str) -> None:
        """
        Cancel all previously scheduled notifications for the user.
        """


class LoggingNotificationAdapter(PushNotificationAdapter):
    """
    Fallback adapter that simply logs notification actions. Useful when
    running on unsupported platforms or during backend unit tests.
    """

    def schedule_local_notification(
        self,
        user_id: str,
        title: str,
        message: str,
        when: datetime,
        payload: Optional[Dict[str, str]] = None,
    ) -> None:
        logger.info(
            "Scheduling notification for user %s at %s – %s / %s (payload=%s)",
            user_id,
            when.isoformat(sep=' ', timespec='seconds'),
            title,
            message,
            payload,
        )

    def cancel_all_notifications(self, user_id: str) -> None:
        logger.info("Cancelling all notifications for user %s", user_id)


# --------------------------------------------------------------------------- #
# Factory Pattern – Notification adapter factory                              #
# --------------------------------------------------------------------------- #

class NotificationAdapterFactory:
    """
    Produces platform-specific notification adapters. In production the
    factory could inspect *plyer*, *jnius* availability or environment
    variables to choose between Android, iOS, or the fallback adapter.
    """

    @staticmethod
    def build(platform: str = "generic") -> PushNotificationAdapter:
        logger.debug("Building PushNotificationAdapter for platform=%s", platform)
        # TODO: Expand to real platform checks
        return LoggingNotificationAdapter()


# --------------------------------------------------------------------------- #
# NotificationScheduler                                                       #
# --------------------------------------------------------------------------- #

T = TypeVar("T", bound=BaseEvent)


class NotificationScheduler(Generic[T]):
    """
    Subscribes to quest execution events and pushes local notifications
    based on user preferences. A dedicated worker thread is used so that
    heavy or blocking operations do not obstruct the caller thread.

    The scheduler is intentionally conservative: if anything goes wrong
    (e.g., repository unavailable), it will log warnings instead of raising
    exceptions to avoid crashing the main game runtime.
    """

    _worker_thread: threading.Thread
    _stop_event: threading.Event

    def __init__(
        self,
        event_bus: EventBus,
        settings_repo: NotificationSettingsRepository,
        adapter: PushNotificationAdapter,
        *,
        queue_maxsize: int = 1024,
        batch_time_window: timedelta = timedelta(seconds=2),
    ) -> None:
        self._event_bus = event_bus
        self._settings_repo = settings_repo
        self._adapter = adapter

        self._queue: queue.Queue[T] = queue.Queue(maxsize=queue_maxsize)
        self._stop_event = threading.Event()
        self._batch_time_window = batch_time_window

        self._worker_thread = threading.Thread(
            target=self._process_queue,
            name="NotificationSchedulerWorker",
            daemon=True,
        )
        self._worker_thread.start()

        # Subscribe to relevant events
        self._unsubscribe_completed = self._event_bus.subscribe(
            QuestCompletedEvent, self._on_quest_completed
        )
        self._unsubscribe_failed = self._event_bus.subscribe(
            QuestFailedEvent, self._on_quest_failed
        )

        logger.debug("NotificationScheduler initialized")

    # Public API ------------------------------------------------------------ #

    def shutdown(self) -> None:
        """
        Gracefully stop the worker thread and unsubscribe from the event bus.
        """
        logger.info("Shutting down NotificationScheduler")
        self._unsubscribe_completed()
        self._unsubscribe_failed()

        self._stop_event.set()
        self._queue.put_nowait(None)  # type: ignore
        self._worker_thread.join(timeout=5.0)

    # Event callbacks ------------------------------------------------------- #

    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        self._enqueue_event(event)

    def _on_quest_failed(self, event: QuestFailedEvent) -> None:
        self._enqueue_event(event)

    def _enqueue_event(self, event: T) -> None:
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            logger.warning("Notification queue is full; dropping event %s", event)

    # Worker thread --------------------------------------------------------- #

    def _process_queue(self) -> None:
        """
        Batch events to minimise the number of repository calls and avoid
        flooding the notification subsystem. Events are grouped within the
        configured `batch_time_window`.
        """
        logger.debug("Notification worker thread started")
        pending_events: List[T] = []
        last_flush = time.monotonic()

        while not self._stop_event.is_set():
            timeout = max(0.0, self._batch_time_window.total_seconds() - (time.monotonic() - last_flush))
            try:
                event = self._queue.get(timeout=timeout)
            except queue.Empty:
                # Time window elapsed; flush pending events
                if pending_events:
                    self._flush(pending_events)
                    pending_events.clear()
                    last_flush = time.monotonic()
                continue

            if event is None:  # Shutdown sentinel
                logger.debug("Notification worker received shutdown sentinel")
                break

            pending_events.append(event)

            # Flush if we reached time window
            if time.monotonic() - last_flush >= self._batch_time_window.total_seconds():
                self._flush(pending_events)
                pending_events.clear()
                last_flush = time.monotonic()

        # Flush remaining events on exit
        if pending_events:
            self._flush(pending_events)

    def _flush(self, events: Iterable[T]) -> None:
        """
        Process a batch of events and schedule notifications as necessary.
        """
        for event in events:
            try:
                self._handle_event(event)
            except Exception as exc:  # pylint: disable=broad-exception-caught
                logger.exception("Error while handling event %s: %s", event, exc)

    # Business logic -------------------------------------------------------- #

    def _handle_event(self, event: T) -> None:
        """
        Map Quest events to user-facing notifications.
        """
        user_id = getattr(event, "user_id", None)
        if user_id is None:
            logger.debug("Event %s lacks user_id; skipping", event)
            return

        if not self._settings_repo.is_enabled(user_id):
            logger.debug("Notifications disabled for user %s; skipping", user_id)
            return

        if isinstance(event, QuestCompletedEvent):
            self._handle_quest_completed(event)
        elif isinstance(event, QuestFailedEvent):
            self._handle_quest_failed(event)
        else:
            logger.debug("Unhandled event type %s", type(event))

    def _handle_quest_completed(self, event: QuestCompletedEvent) -> None:
        title = "Quest Complete!"
        message = (
            f"You earned {event.exp_gained} XP "
            f"and {sum(event.materials_gained.values())} materials."
        )
        when = datetime.utcnow() + timedelta(seconds=1)
        payload = {"quest_id": event.quest_id, "event": "quest_completed"}

        logger.debug(
            "Scheduling quest-completed notification for user %s: '%s' – '%s'",
            event.user_id,
            title,
            message,
        )
        self._adapter.schedule_local_notification(event.user_id, title, message, when, payload)

    def _handle_quest_failed(self, event: QuestFailedEvent) -> None:
        title = "Quest Failed"
        message = f"You lost {event.penalty} XP. Better luck next time!"
        when = datetime.utcnow() + timedelta(seconds=1)
        payload = {"quest_id": event.quest_id, "event": "quest_failed"}

        logger.debug(
            "Scheduling quest-failed notification for user %s: '%s' – '%s'",
            event.user_id,
            title,
            message,
        )
        self._adapter.schedule_local_notification(event.user_id, title, message, when, payload)


# --------------------------------------------------------------------------- #
# Module self-test                                                            #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    """
    Basic sanity check when the module is executed directly:

    $ python -m src.module_21
    """
    logging.getLogger(LOGGER_NAME).setLevel(logging.DEBUG)

    # Instantiate infrastructure
    bus = EventBus()
    settings_repo = InMemoryNotificationSettingsRepository()
    adapter = NotificationAdapterFactory.build(platform="generic")

    user_id_sample = "user123"
    settings_repo.set_enabled(user_id_sample, True)

    scheduler = NotificationScheduler(bus, settings_repo, adapter)

    # Publish test events
    bus.publish(
        QuestCompletedEvent(
            user_id=user_id_sample,
            quest_id="quest_001",
            exp_gained=150,
            materials_gained={"iron": 3, "wood": 5},
        )
    )
    bus.publish(
        QuestFailedEvent(
            user_id=user_id_sample,
            quest_id="quest_002",
            penalty=25,
        )
    )

    # Allow some time for background processing then shut down
    time.sleep(3)
    scheduler.shutdown()
```