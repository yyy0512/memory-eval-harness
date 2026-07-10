```python
"""
QuestSmith – Productivity RPG Forge
===================================

module_34.py
------------

Centralised, thread-safe event bus and analytics collector used across the
application.  Implements an Observer pattern with soft-references to prevent
memory leaks and optional UI-thread dispatch via Kivy’s ``Clock``.  An adaptive
analytics pipeline persists raw events into a local SQLite store using the
Repository pattern so that other components (difficulty balancer, achievement
engine, etc.) can query historic data.

The module is *pure* Python and therefore fully testable off-device; platform
specific hooks (crash reporting, push notifications, …) can be injected through
factories at run-time without contaminating the core logic.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import inspect
import json
import logging
import queue
import sqlite3
import threading
import types
import weakref
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, MutableMapping, Optional, Set, Type, Union

# --------------------------------------------------------------------------- #
# Optional Kivy import                                                        #
# --------------------------------------------------------------------------- #
try:
    from kivy.clock import Clock  # type: ignore
except Exception:  # pragma: no cover – no Kivy on CI
    Clock = None  # type: ignore

# --------------------------------------------------------------------------- #
# Logging setup                                                               #
# --------------------------------------------------------------------------- #
logger = logging.getLogger("questsmith.eventbus")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Crash-reporting hook                                                        #
# --------------------------------------------------------------------------- #

_CrashReporter = Callable[[BaseException], None]
_global_crash_reporter: Optional[_CrashReporter] = None


def set_crash_reporter(reporter: Optional[_CrashReporter]) -> None:
    """Register a callable that will be invoked whenever an unhandled exception
    occurs inside a subscriber callback."""
    global _global_crash_reporter
    _global_crash_reporter = reporter


# --------------------------------------------------------------------------- #
# Event hierarchy                                                             #
# --------------------------------------------------------------------------- #
class BaseEvent:
    """Base-class for all events dispatched through :class:`EventBus`."""

    __slots__ = ("timestamp",)

    def __init__(self) -> None:
        self.timestamp: _dt.datetime = _dt.datetime.utcnow()

    # Convenience: enable *event == type check* (e.g. `if event == QuestCompletedEvent:`).
    def __eq__(self, other: Union["BaseEvent", Type["BaseEvent"]]) -> bool:  # type: ignore[override]
        if inspect.isclass(other):
            return isinstance(self, other)
        return self is other

    def to_dict(self) -> Dict[str, Any]:
        """Serialise event into a JSON-serialisable dict."""
        return {"ts": self.timestamp.isoformat()}


class QuestCompletedEvent(BaseEvent):
    __slots__ = ("quest_id", "xp_gained", "items_rewarded")

    def __init__(self, quest_id: str, xp_gained: int, items_rewarded: List[str]) -> None:
        super().__init__()
        self.quest_id = quest_id
        self.xp_gained = xp_gained
        self.items_rewarded = items_rewarded

    def to_dict(self) -> Dict[str, Any]:  # noqa: D401
        return {
            **super().to_dict(),
            "quest_id": self.quest_id,
            "xp": self.xp_gained,
            "items": self.items_rewarded,
        }


class QuestFailedEvent(BaseEvent):
    __slots__ = ("quest_id",)

    def __init__(self, quest_id: str) -> None:
        super().__init__()
        self.quest_id = quest_id

    def to_dict(self) -> Dict[str, Any]:
        return {**super().to_dict(), "quest_id": self.quest_id}


class UserLevelUpEvent(BaseEvent):
    __slots__ = ("new_level",)

    def __init__(self, new_level: int) -> None:
        super().__init__()
        self.new_level = new_level

    def to_dict(self) -> Dict[str, Any]:
        return {**super().to_dict(), "level": self.new_level}


class StatsUpdatedEvent(BaseEvent):
    """Fired periodically (≈ every 15 s in the background) so passive listeners
    can refresh their UI without polling the database."""

    __slots__ = ("stats",)

    def __init__(self, stats: Dict[str, Any]) -> None:
        super().__init__()
        self.stats = stats

    def to_dict(self) -> Dict[str, Any]:
        return {**super().to_dict(), "stats": self.stats}


# --------------------------------------------------------------------------- #
# EventBus implementation (Observer pattern)                                  #
# --------------------------------------------------------------------------- #
Subscriber = Callable[[BaseEvent], None]


class EventBus:
    """
    Thread-safe, weak-referenced event bus.

    Behaviours
    ----------
    • Handlers are stored as weak references and are auto-removed on GC
    • Handlers can subscribe to specific event types or to the base
      :class:`BaseEvent` to receive **all** events
    • Dispatch can be marshalled onto the UI thread via Kivy’s `Clock`
    """

    _SUBSCRIPTIONS: MutableMapping[Type[BaseEvent], "weakref.WeakSet[Subscriber]"]

    def __init__(self, ui_thread_dispatch: bool = True) -> None:
        self._SUBSCRIPTIONS = {}
        self._lock = threading.RLock()
        self._ui_thread_dispatch = ui_thread_dispatch
        logger.debug("EventBus initialised (ui-thread-dispatch=%s)", ui_thread_dispatch)

    # --------------------------------------------------------------------- #
    # Subscription management                                               #
    # --------------------------------------------------------------------- #
    def subscribe(self, event_type: Type[BaseEvent], handler: Subscriber) -> None:
        """
        Register `handler` for `event_type`.

        Pick the most specific type you are interested in.  Handlers registered
        to :class:`BaseEvent` will receive *every* event.
        """
        if not inspect.isclass(event_type) or not issubclass(event_type, BaseEvent):
            raise TypeError("event_type must be subclass of BaseEvent")
        if not callable(handler):
            raise TypeError("handler must be callable")

        with self._lock:
            bucket = self._SUBSCRIPTIONS.setdefault(event_type, weakref.WeakSet())
            bucket.add(handler)
        logger.debug("Subscribed %s to %s", handler, event_type.__name__)

    def unsubscribe(self, handler: Subscriber, event_type: Optional[Type[BaseEvent]] = None) -> None:
        """
        Unregister a previously subscribed handler.

        If *event_type* is omitted the handler is removed from **all** buckets.
        """
        with self._lock:
            if event_type is not None:
                self._SUBSCRIPTIONS.get(event_type, set()).discard(handler)
                logger.debug("Unsubscribed %s from %s", handler, event_type.__name__)
            else:
                for bucket in self._SUBSCRIPTIONS.values():
                    bucket.discard(handler)
                logger.debug("Unsubscribed %s from all buckets", handler)

    # --------------------------------------------------------------------- #
    # Publishing                                                            #
    # --------------------------------------------------------------------- #
    def post(self, event: BaseEvent) -> None:
        """Publish *event* to all interested subscribers."""
        if not isinstance(event, BaseEvent):
            raise TypeError("event must derive from BaseEvent")

        logger.debug("Event posted: %s", event.__class__.__name__)
        with self._lock:
            # Build a *stable* copy of handlers. Otherwise modifications in
            # a callback could alter our iteration.
            handlers: Set[Subscriber] = set()
            for etype, bucket in self._SUBSCRIPTIONS.items():
                if isinstance(event, etype):
                    handlers.update(bucket)

        if not handlers:
            logger.debug("No subscribers for event %s", type(event).__name__)
            return

        if self._ui_thread_dispatch and Clock is not None and threading.current_thread() is not threading.main_thread():
            Clock.schedule_once(lambda _dt: self._dispatch(event, handlers), 0)
        else:
            self._dispatch(event, handlers)

    # --------------------------------------------------------------------- #
    # Internal helpers                                                      #
    # --------------------------------------------------------------------- #
    def _dispatch(self, event: BaseEvent, handlers: Iterable[Subscriber]) -> None:
        for handler in list(handlers):  # copy – avoid mutation
            try:
                handler(event)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Subscriber %s failed for %s", handler, type(event).__name__)
                if _global_crash_reporter:
                    _global_crash_reporter(exc)

    # --------------------------------------------------------------------- #
    # Decorator                                                             #
    # --------------------------------------------------------------------- #
    def listener(self, event_type: Type[BaseEvent]) -> Callable[[Subscriber], Subscriber]:
        """Decorator to register *event_type* listener:

        >>> @event_bus.listener(QuestCompletedEvent)
        ... def notify_toast(event):
        ...     pass
        """

        def decorator(handler: Subscriber) -> Subscriber:
            self.subscribe(event_type, handler)
            return handler

        return decorator


# Global, singleton instance
event_bus = EventBus(ui_thread_dispatch=True)

# --------------------------------------------------------------------------- #
# Analytics – Repository Pattern                                              #
# --------------------------------------------------------------------------- #
class IAnalyticsRepository:
    """
    Abstract repository interface for persistence.

    Separated behind a protocol so we can swap out implementations – for
    example, push events to a remote endpoint when online connectivity is
    available.
    """

    def log_event(self, name: str, payload: Dict[str, Any], timestamp: _dt.datetime) -> None: ...

    def fetch_event_counts_since(
        self, name: str, since: _dt.datetime
    ) -> int: ...  # pragma: no cover


class SQLiteAnalyticsRepository(IAnalyticsRepository):
    """
    Lightweight on-device repository backed by SQLite.  The DB lives in the
    app-specific user data directory.
    """

    _CREATE_SQL = """
        CREATE TABLE IF NOT EXISTS analytics_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            payload TEXT,
            ts_utc TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_analytics_name_ts ON analytics_events (name, ts_utc);
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self._db_path = db_path or (Path.home() / ".questsmith" / "analytics.db")
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._apply_migrations()
        logger.info("SQLiteAnalyticsRepository ready at %s", self._db_path)

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #
    def log_event(self, name: str, payload: Dict[str, Any], timestamp: _dt.datetime) -> None:
        payload_json = json.dumps(payload, separators=(",", ":"))
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO analytics_events (name, payload, ts_utc) VALUES (?, ?, ?)",
                (name, payload_json, timestamp.isoformat()),
            )
        logger.debug("Analytics logged %s", name)

    def fetch_event_counts_since(self, name: str, since: _dt.datetime) -> int:
        cursor = self._conn.execute(
            "SELECT COUNT(*) FROM analytics_events WHERE name = ? AND ts_utc >= ?",
            (name, since.isoformat()),
        )
        return int(cursor.fetchone()[0])

    # --------------------------------------------------------------------- #
    # Internal helpers                                                      #
    # --------------------------------------------------------------------- #
    def _apply_migrations(self) -> None:
        with self._conn:
            self._conn.executescript(self._CREATE_SQL)


# --------------------------------------------------------------------------- #
# Analytics Collector                                                         #
# --------------------------------------------------------------------------- #
class AnalyticsCollector(threading.Thread):
    """
    Background thread that subscribes to the :data:`event_bus`, persists events
    to the configured repository and performs lightweight aggregation.  Heavy
    ML tasks are off-loaded to the *AdaptiveDifficultyEngine* (not part of this
    module).
    """

    _QUEUE_MAXSIZE = 1024

    def __init__(
        self,
        repo: Optional[IAnalyticsRepository] = None,
        daemon: bool = True,
        flush_interval: float = 1.0,
    ) -> None:
        super().__init__(name="AnalyticsCollector", daemon=daemon)
        self._repo = repo or SQLiteAnalyticsRepository()
        self._queue: "queue.Queue[BaseEvent]" = queue.Queue(self._QUEUE_MAXSIZE)
        self._stop_event = threading.Event()
        self._flush_interval = flush_interval

        # Hook into EventBus
        event_bus.subscribe(BaseEvent, self._enqueue)
        logger.debug("AnalyticsCollector subscribed to EventBus")

    # --------------------------------------------------------------------- #
    # Subscriber callback (runs on posting thread)                          #
    # --------------------------------------------------------------------- #
    def _enqueue(self, event: BaseEvent) -> None:
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(event)

    # --------------------------------------------------------------------- #
    # Thread loop                                                           #
    # --------------------------------------------------------------------- #
    def run(self) -> None:  # noqa: D401
        buffer: List[BaseEvent] = []
        last_flush = _dt.datetime.utcnow()

        while not self._stop_event.is_set():
            timeout = max(0, (last_flush + _dt.timedelta(seconds=self._flush_interval) - _dt.datetime.utcnow()).total_seconds())
            try:
                evt = self._queue.get(timeout=timeout)
                buffer.append(evt)
            except queue.Empty:
                pass  # time to flush

            now = _dt.datetime.utcnow()
            if buffer and (now - last_flush).total_seconds() >= self._flush_interval:
                self._flush(buffer)
                buffer.clear()
                last_flush = now

    # --------------------------------------------------------------------- #
    # Flushing & shutdown                                                   #
    # --------------------------------------------------------------------- #
    def _flush(self, events: Iterable[BaseEvent]) -> None:
        for evt in events:
            try:
                self._repo.log_event(evt.__class__.__name__, evt.to_dict(), evt.timestamp)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Failed to persist analytics event")
                if _global_crash_reporter:
                    _global_crash_reporter(exc)

        logger.debug("Analytics flushed %d events", len(list(events)))

    def stop(self) -> None:
        """Signal the thread to stop and wait for clean shutdown."""
        self._stop_event.set()
        self.join(timeout=2.0)
        event_bus.unsubscribe(self._enqueue, BaseEvent)
        logger.info("AnalyticsCollector stopped")


# --------------------------------------------------------------------------- #
# Decorator Sugar                                                             #
# --------------------------------------------------------------------------- #
def subscriber(event_type: Type[BaseEvent]) -> Callable[[Subscriber], Subscriber]:
    """
    Module-level sugar so call-site code doesn’t have to import
    :data:`event_bus` explicitly::

        from src import module_34 as events

        @events.subscriber(UserLevelUpEvent)
        def on_level_up(evt):
            ...
    """

    return event_bus.listener(event_type)


# --------------------------------------------------------------------------- #
# Initialisation                                                              #
# --------------------------------------------------------------------------- #
_ANALYTICS_COLLECTOR: Optional[AnalyticsCollector] = None


def initialise(analytics_repo: Optional[IAnalyticsRepository] = None) -> None:
    """Start background analytics collector.  Safe to call multiple times."""
    global _ANALYTICS_COLLECTOR
    if _ANALYTICS_COLLECTOR is None or not _ANALYTICS_COLLECTOR.is_alive():
        _ANALYTICS_COLLECTOR = AnalyticsCollector(repo=analytics_repo)
        _ANALYTICS_COLLECTOR.start()
        logger.info("AnalyticsCollector started")


def shutdown() -> None:
    """Stop background workers gracefully."""
    if _ANALYTICS_COLLECTOR and _ANALYTICS_COLLECTOR.is_alive():
        _ANALYTICS_COLLECTOR.stop()


# --------------------------------------------------------------------------- #
# Self-test (only executed when run directly)                                 #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)
    initialise()

    # Emit some fake events
    event_bus.post(QuestCompletedEvent("abc123", 50, ["Iron Ore", "Oak Wood"]))
    event_bus.post(UserLevelUpEvent(2))
    event_bus.post(QuestFailedEvent("def456"))

    # Let the collector flush
    import time as _time

    _time.sleep(2)
    shutdown()
```