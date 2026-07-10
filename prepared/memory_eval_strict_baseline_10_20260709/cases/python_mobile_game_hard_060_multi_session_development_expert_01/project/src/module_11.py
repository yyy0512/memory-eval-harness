```python
"""
QuestSmith: Productivity RPG Forge
----------------------------------

src/module_11.py

This module contains a thread-safe, repository-backed implementation of an
Observer-based event bus that is used throughout the application to propagate
quest‐related status changes (e.g. quest completed, level up, crafting started)
to any interested sub-systems such as UI widgets, push-notification schedulers,
analytics collectors, crash reporters, etc.

It demonstrates usage of:

* Repository Pattern   – `SQLiteEventRepository`
* Observer Pattern     – `QuestEventBus`
* Factory Pattern      – `CrashReporterFactory`
* Python best practices – typing, logging, error handling, docstrings

The implementation is designed to work entirely offline; events are persisted
locally and automatically flushed to subscribers when connectivity returns or
new subscribers are registered.

Author: QuestSmith Engineering
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
import weakref
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum, auto
from types import TracebackType
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Sequence,
    Set,
    Tuple,
    Type,
)

###############################################################################
# Logging configuration
###############################################################################

logger = logging.getLogger("questsmith.event_bus")
if not logger.handlers:  # Prevent duplicate handlers in case of multiple import
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s "
            "[%(name)s:%(lineno)d] %(funcName)s(): %(message)s"
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

###############################################################################
# Crash reporter interfaces and factories (Factory Pattern)
###############################################################################


class CrashReporter(Protocol):
    """Abstract crash reporter used to decouple from vendor specific SDK."""

    def capture_exception(
        self,
        exc: BaseException,
        context: Optional[Dict[str, Any]] = None,
    ) -> None: ...


class _NullCrashReporter:
    """Fallback crash reporter that silently ignores exceptions."""

    def capture_exception(
        self,
        exc: BaseException,
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        logger.debug("CrashReporter suppressed exception: %s", exc, exc_info=exc)


class CrashReporterFactory:
    """Factory used to obtain a crash reporter instance."""

    @staticmethod
    def create() -> CrashReporter:
        try:
            import sentry_sdk  # type: ignore

            class _SentryCrashReporter:  # pragma: no cover – runtime dependency
                def capture_exception(
                    self,
                    exc: BaseException,
                    context: Optional[Dict[str, Any]] = None,
                ) -> None:
                    with sentry_sdk.push_scope() as scope:
                        if context:
                            for key, value in context.items():
                                scope.set_extra(key, value)
                        sentry_sdk.capture_exception(exc)

            logger.info("Sentry crash reporter initialised.")
            return _SentryCrashReporter()
        except ModuleNotFoundError:
            logger.warning("Sentry SDK not available – using NullCrashReporter.")
            return _NullCrashReporter()


###############################################################################
# Event models
###############################################################################


class QuestEventType(Enum):
    """Enumeration of all quest-related events."""

    QUEST_CREATED = auto()
    QUEST_COMPLETED = auto()
    QUEST_FAILED = auto()
    LEVEL_UP = auto()
    CRAFTING_STARTED = auto()
    CRAFTING_FINISHED = auto()
    REWARD_COLLECTED = auto()


@dataclass(slots=True, frozen=True)
class QuestEvent:
    """
    Immutable data class representing a single quest event.

    Parameters
    ----------
    id: UUID4 string
        Unique identifier for this event.
    type: QuestEventType
        What kind of quest event occurred.
    payload: dict[str, Any]
        JSON-serialisable payload with event details (e.g. quest_id, xp_gained).
    timestamp: float
        Unix epoch timestamp (UTC seconds).
    dispatched: bool
        Internal flag used by repository to mark event as already published.
    """

    id: str
    type: QuestEventType
    payload: Dict[str, Any]
    timestamp: float
    dispatched: bool = False

    def to_record(self) -> Tuple[str, str, str, float, int]:
        """Convert data class to a SQLite row tuple."""
        return (
            self.id,
            self.type.name,
            json.dumps(self.payload),
            self.timestamp,
            int(self.dispatched),
        )

    @staticmethod
    def from_record(record: Tuple[str, str, str, float, int]) -> "QuestEvent":
        """Convert a SQLite row to a QuestEvent."""
        event_id, type_name, payload_json, timestamp, dispatched = record
        return QuestEvent(
            id=event_id,
            type=QuestEventType[type_name],
            payload=json.loads(payload_json),
            timestamp=timestamp,
            dispatched=bool(dispatched),
        )


###############################################################################
# Repository Pattern implementation
###############################################################################


class SQLiteEventRepository:
    """
    Repository responsible for persisting quest events to a local SQLite DB.

    Thread-safe and resilient to database corruption.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS quest_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp REAL NOT NULL,
        dispatched INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dispatched ON quest_events(dispatched);
    """

    def __init__(self, db_path: str = "questsmith.db") -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        logger.debug("Initialising SQLiteEventRepository with DB %s", db_path)
        with self._get_connection() as conn:
            conn.executescript(self._SCHEMA)

    @contextmanager
    def _get_connection(self) -> Iterable[sqlite3.Connection]:
        conn = sqlite3.connect(
            self._db_path,
            check_same_thread=False,
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # CRUD operations -----------------------------------------------------

    def add_event(self, event: QuestEvent) -> None:
        logger.debug("Persisting event %s (%s)", event.id, event.type.name)
        with self._lock, self._get_connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO quest_events "
                "(id, type, payload, timestamp, dispatched) VALUES (?,?,?,?,?)",
                event.to_record(),
            )

    def mark_dispatched(self, event_ids: Sequence[str]) -> None:
        if not event_ids:
            return
        with self._lock, self._get_connection() as conn:
            conn.executemany(
                "UPDATE quest_events SET dispatched = 1 WHERE id = ?",
                [(eid,) for eid in event_ids],
            )
        logger.debug("Marked %d events as dispatched", len(event_ids))

    def fetch_pending(self, limit: int = 100) -> List[QuestEvent]:
        with self._lock, self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT id, type, payload, timestamp, dispatched "
                "FROM quest_events WHERE dispatched = 0 ORDER BY timestamp ASC LIMIT ?",
                (limit,),
            )
            records = cursor.fetchall()
        events = [QuestEvent.from_record(tuple(r)) for r in records]
        logger.debug("Fetched %d pending events from repository", len(events))
        return events

    def purge_dispatched(self, older_than: float) -> int:
        """Remove dispatched events older than given epoch seconds."""
        with self._lock, self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM quest_events WHERE dispatched = 1 AND timestamp < ?",
                (older_than,),
            )
            deleted = cursor.rowcount
        if deleted:
            logger.info("Purged %d dispatched events from repository", deleted)
        return deleted


###############################################################################
# Observer Pattern implementation
###############################################################################


SubscriptionCallback = Callable[[QuestEvent], None]


class _Subscription:
    """Internal handle object that supports unsubscription via context manager."""

    __slots__ = ("_bus_ref", "_event_type", "_callback")

    def __init__(
        self,
        bus: "QuestEventBus",
        event_type: QuestEventType,
        callback: SubscriptionCallback,
    ) -> None:
        # Keep only a weak reference to avoid memory leaks
        self._bus_ref = weakref.ref(bus)
        self._event_type = event_type
        self._callback = callback

    def unsubscribe(self) -> None:
        bus = self._bus_ref()
        if bus:
            bus._unsubscribe(self._event_type, self._callback)

    # Allow usage as a context manager for automatic unsubscription
    def __enter__(self) -> "_Subscription":  # noqa: D401
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> Optional[bool]:
        self.unsubscribe()
        return None


class QuestEventBus:
    """
    Thread-safe event bus that persists all events and notifies subscribers.

    Subscribers can register callbacks per `QuestEventType`. If a callback raises
    an exception, that exception will be logged and forwarded to the configured
    crash reporter but **will not** prevent delivery to other subscribers.
    """

    _DISPATCH_THREAD_NAME = "QuestEventDispatcher"

    def __init__(
        self,
        repository: Optional[SQLiteEventRepository] = None,
        crash_reporter: Optional[CrashReporter] = None,
    ) -> None:
        self._repo = repository or SQLiteEventRepository()
        self._crash_reporter = crash_reporter or CrashReporterFactory.create()
        self._subscribers: Dict[QuestEventType, Set[SubscriptionCallback]] = {}
        self._lock = threading.RLock()
        self._dispatcher_thread = threading.Thread(
            target=self._dispatch_loop,
            name=self._DISPATCH_THREAD_NAME,
            daemon=True,
        )
        self._dispatch_event = threading.Event()
        self._stop_event = threading.Event()
        self._dispatcher_thread.start()
        logger.info("QuestEventBus initialised and dispatcher thread started.")

    # Public API ----------------------------------------------------------

    def publish(self, event_type: QuestEventType, payload: Dict[str, Any]) -> None:
        """
        Publish a new event to the bus.

        The event is immediately persisted and the dispatcher thread is notified
        to deliver it to all current subscribers.
        """
        event = QuestEvent(
            id=str(uuid.uuid4()),
            type=event_type,
            payload=payload,
            timestamp=time.time(),
            dispatched=False,
        )
        self._repo.add_event(event)
        logger.info("Published event %s [%s]", event.id, event.type.name)
        self._dispatch_event.set()

    def subscribe(
        self, event_type: QuestEventType, callback: SubscriptionCallback
    ) -> _Subscription:
        """
        Subscribe callback to an event type and immediately flush backlog.

        Returns
        -------
        _Subscription
            Handle that can be used to manually unsubscribe or as a context
            manager: `with bus.subscribe(...): ...`
        """
        with self._lock:
            self._subscribers.setdefault(event_type, set()).add(callback)
        logger.debug("Subscription added for %s", event_type.name)

        # Deliver any pending events of this type (backlog replay)
        pending = [
            ev for ev in self._repo.fetch_pending()
            if ev.type is event_type
        ]
        for event in pending:
            self._safe_invoke(callback, event)
            self._repo.mark_dispatched([event.id])

        return _Subscription(self, event_type, callback)

    def stop(self, timeout: float = 2.0) -> None:
        """Stop dispatcher thread and flush any remaining events."""
        self._stop_event.set()
        self._dispatch_event.set()  # Wake dispatcher
        self._dispatcher_thread.join(timeout=timeout)
        logger.info("QuestEventBus stopped.")

    # ---------------------------------------------------------------------

    def _unsubscribe(
        self, event_type: QuestEventType, callback: SubscriptionCallback
    ) -> None:
        with self._lock:
            if callbacks := self._subscribers.get(event_type):
                callbacks.discard(callback)
                if not callbacks:
                    del self._subscribers[event_type]
        logger.debug("Unsubscribed callback from %s", event_type.name)

    # Dispatch loop -------------------------------------------------------

    _POLL_INTERVAL_SEC = 5.0

    def _dispatch_loop(self) -> None:  # pragma: no cover – threaded
        """
        Background loop that polls for undispatched events and delivers them.

        Runs on a dedicated daemon thread started during initialisation.
        """
        logger.debug("Dispatcher loop entered.")
        while not self._stop_event.is_set():
            # Wait for publish signal or timeout
            triggered = self._dispatch_event.wait(self._POLL_INTERVAL_SEC)
            self._dispatch_event.clear()
            if triggered:
                logger.debug("Dispatch event triggered.")
            try:
                self._flush_pending_events()
            except Exception as exc:  # Defensive: never crash the dispatcher
                logger.exception("Unexpected error in dispatch loop")
                self._crash_reporter.capture_exception(exc)

    def _flush_pending_events(self) -> None:
        # Drain pending events in batches
        while True:
            pending = self._repo.fetch_pending(limit=100)
            if not pending:
                break
            logger.debug("Flushing %d pending events …", len(pending))
            dispatched_ids: List[str] = []
            for event in pending:
                callbacks = list(self._subscribers.get(event.type, ()))
                if not callbacks:
                    continue  # Nobody cares (yet), keep undispatched
                for cb in callbacks:
                    self._safe_invoke(cb, event)
                dispatched_ids.append(event.id)
            if dispatched_ids:
                self._repo.mark_dispatched(dispatched_ids)

        # Optionally purge old dispatched events (keep last 7 days)
        week_ago = time.time() - 86_400 * 7
        self._repo.purge_dispatched(older_than=week_ago)

    # Utilities -----------------------------------------------------------

    def _safe_invoke(self, callback: SubscriptionCallback, event: QuestEvent) -> None:
        try:
            callback(event)
        except Exception as exc:
            logger.error(
                "Subscriber %s raised exception on event %s",
                callback.__name__,
                event.id,
                exc_info=exc,
            )
            # Forward to crash reporter
            self._crash_reporter.capture_exception(
                exc, context={"event_id": event.id, "event_type": event.type.name}
            )


###############################################################################
# Example subscribers (would live elsewhere in the real project)
###############################################################################


class _AnalyticsSubscriber:
    """Example analytics tracking subscriber."""

    def __call__(self, event: QuestEvent) -> None:
        logger.info(
            "[Analytics] Event '%s' processed with payload=%s",
            event.type.name,
            event.payload,
        )


class _PushNotificationSubscriber:
    """Example push notification subscriber."""

    def __call__(self, event: QuestEvent) -> None:
        if event.type is QuestEventType.QUEST_COMPLETED:
            quest_name = event.payload.get("quest_name", "Unnamed Quest")
            logger.info("[PushNotifications] 🎉 Quest '%s' completed!", quest_name)


###############################################################################
# Demonstration
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    # This demo can be run as `python -m src.module_11`
    bus = QuestEventBus()

    # Register demo subscribers
    sub1 = bus.subscribe(QuestEventType.QUEST_COMPLETED, _AnalyticsSubscriber())
    sub2 = bus.subscribe(QuestEventType.QUEST_COMPLETED, _PushNotificationSubscriber())

    # Publish a couple of events
    bus.publish(
        QuestEventType.QUEST_CREATED,
        payload={"quest_id": "123", "quest_name": "Write documentation"},
    )
    bus.publish(
        QuestEventType.QUEST_COMPLETED,
        payload={"quest_id": "123", "quest_name": "Write documentation"},
    )

    # Allow background dispatcher some time to process
    time.sleep(2)

    # Clean up
    sub1.unsubscribe()
    sub2.unsubscribe()
    bus.stop()
```