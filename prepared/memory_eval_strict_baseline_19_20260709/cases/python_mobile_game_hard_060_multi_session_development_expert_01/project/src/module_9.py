```python
"""
module_9.py

Central Event-Bus implementation and a small collection of default observers for
QuestSmith: Productivity RPG Forge.

Patterns exercised:
    • Observer Pattern (EventBus / subscribers)
    • Repository Pattern (SQLiteAnalyticsRepository)
    • Factory Pattern   (AdapterFactory)
    • Adapter Pattern   (CrashReporter, PushNotifications*)

This module purposefully contains no framework-specific (Kivy / Android / iOS)
code so that it can be imported in unit-tests and command-line tooling without
dragging GUI dependencies with it.
"""
from __future__ import annotations

import abc
import asyncio
import enum
import logging
import os
import sqlite3
import threading
import time
import weakref
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import (
    Any,
    Awaitable,
    Callable,
    Deque,
    Dict,
    List,
    MutableMapping,
    NamedTuple,
    Optional,
    Protocol,
    Set,
    Tuple,
    Type,
    TypeVar,
)

# ------------------------------------------------------------------------------
# Logging setup
# ------------------------------------------------------------------------------

_LOGGER = logging.getLogger("questsmith.eventbus")
if not _LOGGER.handlers:
    # Default configuration – can be overridden by main application
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

# ------------------------------------------------------------------------------
# Type declarations
# ------------------------------------------------------------------------------

T = TypeVar("T")
SubscriberCallback = Callable[["Event"], Any]
AsyncSubscriberCallback = Callable[["Event"], Awaitable[Any]]


class EventType(enum.Enum):
    """
    Known QuestSmith event categories.

    ANY is used for wildcard subscriptions that should receive *all* events.
    """

    ANY = "*"
    QUEST_STARTED = "quest_started"
    QUEST_COMPLETED = "quest_completed"
    QUEST_FAILED = "quest_failed"
    XP_GAINED = "xp_gained"
    LEVEL_UP = "level_up"
    ITEM_CRAFTED = "item_crafted"
    LOCATION_ENTERED = "location_entered"
    BIO_AUTH_SUCCESS = "biometric_auth_success"
    BIO_AUTH_FAILURE = "biometric_auth_failure"


@dataclass(slots=True, frozen=True)
class Event:
    """
    Immutable event object that flows through the system.

    Attributes
    ----------
    type : EventType
        Category of the event.
    payload : dict[str, Any]
        Arbitrary JSON-serialisable payload.
    ts : float
        Epoch timestamp (seconds).
    """

    type: EventType
    payload: Dict[str, Any]
    ts: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        # Strongly validate payload so that downstream consumers can rely on it.
        if not isinstance(self.payload, dict):
            raise TypeError("Event.payload must be a dict")


# ------------------------------------------------------------------------------
# EventBus
# ------------------------------------------------------------------------------


class _Subscriber(NamedTuple):
    cb_ref: "weakref.ReferenceType[Callable[[Event], Any]]"
    priority: int
    is_async: bool
    id: int


class Disposable:
    """
    Returned by EventBus.subscribe(); call .dispose() (or use as CM) to detach.
    """

    __slots__ = ("_bus", "_token", "_lock", "_disposed")

    def __init__(self, bus: "EventBus", token: int) -> None:
        self._bus = bus
        self._token = token
        self._lock = threading.Lock()
        self._disposed = False

    def dispose(self) -> None:
        with self._lock:
            if self._disposed:
                return
            self._bus._unsubscribe(self._token)  # noqa: SLF001
            self._disposed = True

    def __enter__(self) -> "Disposable":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.dispose()


class EventBus:
    """
    Thread-safe in-process publish/subscribe hub.

    Synchronous as well as asynchronous subscribers are supported.
    Asynchronous handlers are executed via ``asyncio.create_task``; synchronous
    ones are executed in the calling thread.
    """

    _instance_lock = threading.Lock()
    _instance: Optional["EventBus"] = None

    POLL_INTERVAL_SEC = 0.200

    # ---------------------------------------------------------------------
    # Singleton helpers
    # ---------------------------------------------------------------------
    @classmethod
    def get_global(cls) -> "EventBus":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # ---------------------------------------------------------------------
    # Construction
    # ---------------------------------------------------------------------
    def __init__(self) -> None:
        self._subscribers: MutableMapping[EventType, List[_Subscriber]] = {}
        self._next_token = 1
        self._lock = threading.RLock()
        self._pending_async: Set[asyncio.Task[Any]] = set()

        # Start a background task that removes finished asyncio Tasks so we
        # don’t accumulate memory.
        loop = asyncio.get_event_loop()
        loop.call_soon(self._drain_completed_tasks)

    # ---------------------------------------------------------------------
    # Subscription
    # ---------------------------------------------------------------------
    def subscribe(
        self,
        event_type: EventType | None,
        callback: SubscriberCallback | AsyncSubscriberCallback,
        *,
        priority: int = 0,
        weak: bool = True,
    ) -> Disposable:
        """
        Register a function / coroutine to receive events.

        Parameters
        ----------
        event_type : EventType | None
            Type of events to receive, or None / EventType.ANY for all.
        callback : Callable[[Event], Any] | Callable[[Event], Awaitable[Any]]
            Handler. If it returns an Awaitable *or* is defined with ``async``,
            it is treated as async.
        priority : int
            Higher priority handlers run before lower ones.
        weak : bool
            Store a weak reference to the callback (default) to avoid leaks.
        """
        if event_type is None:
            event_type = EventType.ANY

        if not callable(callback):
            raise TypeError("Callback must be callable")

        is_async = asyncio.iscoroutinefunction(callback) or isinstance(
            callback, asyncio.coroutines.Coroutine
        )

        token = self._generate_token()

        cb_ref: weakref.ReferenceType  # type: ignore[valid-type]
        if weak:
            try:
                cb_ref = weakref.ref(callback)
            except TypeError:
                # e.g. built-in functions don’t support weak refs
                _LOGGER.debug("Callback %s cannot be weak-referenced; storing strong reference.", callback)
                cb_ref = lambda: callback  # type: ignore[assignment]
        else:
            cb_ref = lambda: callback  # type: ignore[assignment]

        subscriber = _Subscriber(
            cb_ref=cb_ref,
            priority=priority,
            is_async=is_async,
            id=token,
        )
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(subscriber)
            # Keep list sorted by priority (descending)
            self._subscribers[event_type].sort(key=lambda s: -s.priority)

        _LOGGER.debug("Subscribed %s to %s with token=%d", callback, event_type, token)
        return Disposable(self, token)

    def _generate_token(self) -> int:
        with self._lock:
            token = self._next_token
            self._next_token += 1
        return token

    # ---------------------------------------------------------------------
    # Unsubscription
    # ---------------------------------------------------------------------
    def _unsubscribe(self, token: int) -> None:
        with self._lock:
            for lst in self._subscribers.values():
                for sub in list(lst):
                    if sub.id == token:
                        lst.remove(sub)
                        _LOGGER.debug("Unsubscribed token=%d", token)
                        return

    # ---------------------------------------------------------------------
    # Publishing
    # ---------------------------------------------------------------------
    def emit(self, event: Event) -> None:
        """
        Publish an event to all interested subscribers.
        """
        if not isinstance(event, Event):
            raise TypeError("event must be Event")

        _LOGGER.debug("Emitting %s", event)

        # Snapshot for thread safety
        with self._lock:
            targets = list(self._subscribers.get(event.type, []))
            targets += self._subscribers.get(EventType.ANY, [])

        for sub in targets:
            cb = sub.cb_ref()
            if cb is None:
                continue  # target GC’ed – silently ignore

            try:
                if sub.is_async:
                    task = asyncio.create_task(cb(event))  # type: ignore[arg-type]
                    self._pending_async.add(task)
                    task.add_done_callback(self._pending_async.discard)
                else:
                    cb(event)  # type: ignore[arg-type]
            except Exception as exc:
                # Do *not* let observers kill the bus – forward to crash reporter
                _LOGGER.exception("Error while executing subscriber callback: %s", exc)
                try:
                    AdapterFactory.get_crash_reporter().capture_exception(exc)
                except Exception:  # noqa: BLE001
                    # Crash reporting must never propagate to game logic
                    _LOGGER.debug("Crash reporter failed in EventBus")

    def _drain_completed_tasks(self) -> None:
        """
        Remove done asyncio Tasks so we don’t leak memory.
        """
        self._pending_async = {t for t in self._pending_async if not t.done()}
        # Reschedule self
        loop = asyncio.get_event_loop()
        loop.call_later(self.POLL_INTERVAL_SEC, self._drain_completed_tasks)

    # ---------------------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------------------
    @contextmanager
    def temporary_subscription(
        self,
        event_type: EventType,
        callback: SubscriberCallback | AsyncSubscriberCallback,
        *,
        priority: int = 0,
        weak: bool = True,
    ):
        """
        Context-manager variant for short-lived subscriptions.
        """
        disp = self.subscribe(event_type, callback, priority=priority, weak=weak)
        try:
            yield disp
        finally:
            disp.dispose()


# ------------------------------------------------------------------------------
# Analytics Repository
# ------------------------------------------------------------------------------


class IAnalyticsRepository(Protocol):
    """
    Storage adapter interface – implemented by SQLiteAnalyticsRepository.
    """

    def save_event(self, event: Event) -> None: ...

    def flush(self) -> None: ...


class SQLiteAnalyticsRepository(IAnalyticsRepository):
    """
    Very small connection-pooled SQLite repository for game analytics.

    A real production implementation would likely batch writes or offload
    heavy I/O but this is sufficient for demonstration purposes.
    """

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS analytics_events (
        ts         REAL NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL
    );
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._pool: Deque[sqlite3.Connection] = deque()
        self._pool_lock = threading.Lock()
        self._init_db()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def save_event(self, event: Event) -> None:
        conn = self._acquire()
        try:
            conn.execute(
                "INSERT INTO analytics_events (ts, type, payload) VALUES (?, ?, ?)",
                (event.ts, event.type.value, str(event.payload)),
            )
            # We *purposefully* do not commit immediately to allow higher-level
            # batching; flush() handles that.
        finally:
            self._release(conn)

    def flush(self) -> None:
        """
        Commit all outstanding writes.
        """
        with self._pool_lock:
            for conn in self._pool:
                conn.commit()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------
    def _acquire(self) -> sqlite3.Connection:
        with self._pool_lock:
            try:
                conn = self._pool.pop()
            except IndexError:
                conn = sqlite3.connect(self._db_path.as_posix(), check_same_thread=False)
                conn.execute("PRAGMA journal_mode=WAL;")
            return conn

    def _release(self, conn: sqlite3.Connection) -> None:
        with self._pool_lock:
            self._pool.append(conn)

    # ------------------------------------------------------------------
    # Init
    # ------------------------------------------------------------------
    def _init_db(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._db_path.as_posix(), check_same_thread=False)
        try:
            conn.executescript(self.SCHEMA)
        finally:
            conn.close()


# ------------------------------------------------------------------------------
# Analytics Engine Observer
# ------------------------------------------------------------------------------


class AnalyticsEngine:
    """
    Listens to EventBus and records events to repository.

    The engine is intentionally lightweight: more advanced aggregation,
    adaptive difficulty calculations, and syncing to online backends are out of
    scope for this module.
    """

    _instance: Optional["AnalyticsEngine"] = None
    _instance_lock = threading.Lock()

    def __init__(self, repo: IAnalyticsRepository, bus: EventBus | None = None) -> None:
        self._repo = repo
        self._bus = bus or EventBus.get_global()
        self._disposable = self._bus.subscribe(EventType.ANY, self._on_event, weak=True)

    # ------------------------------------------------------------------
    # Singleton helper
    # ------------------------------------------------------------------
    @classmethod
    def ensure_started(cls, db_path: Path | str, bus: EventBus | None = None) -> "AnalyticsEngine":
        with cls._instance_lock:
            if cls._instance is None:
                repo = SQLiteAnalyticsRepository(db_path)
                cls._instance = cls(repo, bus)
            return cls._instance

    # ------------------------------------------------------------------
    # Handler
    # ------------------------------------------------------------------
    def _on_event(self, event: Event) -> None:
        try:
            self._repo.save_event(event)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.exception("Analytics repository failed: %s", exc)
            AdapterFactory.get_crash_reporter().capture_exception(exc)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def flush(self) -> None:
        self._repo.flush()

    def shutdown(self) -> None:
        self._disposable.dispose()
        self.flush()


# ------------------------------------------------------------------------------
# Adapter / Factory Interfaces
# ------------------------------------------------------------------------------


class ICrashReporter(abc.ABC):
    @abc.abstractmethod
    def capture_exception(self, exc: BaseException) -> None: ...

    @abc.abstractmethod
    def capture_message(self, msg: str) -> None: ...


class NoopCrashReporter(ICrashReporter):
    """
    Default stub when platform crash reporting isn’t available.
    """

    def capture_exception(self, exc: BaseException) -> None:  # noqa: D401
        _LOGGER.debug("NoopCrashReporter.capture_exception: %s", exc)

    def capture_message(self, msg: str) -> None:
        _LOGGER.debug("NoopCrashReporter.capture_message: %s", msg)


class IPushNotifier(abc.ABC):
    """
    Abstract push-notification scheduler.
    """

    @abc.abstractmethod
    def schedule_notification(self, title: str, body: str, when: float) -> None: ...


class ConsolePushNotifier(IPushNotifier):
    """
    Debug implementation for desktop runs.
    """

    def schedule_notification(self, title: str, body: str, when: float) -> None:  # noqa: D401
        _LOGGER.info("[Push@%s] %s – %s", time.ctime(when), title, body)


# ------------------------------------------------------------------------------
# Adapter Factory
# ------------------------------------------------------------------------------


class AdapterFactory:
    """
    Very lightweight service-locator.

    In production, app.bootstrap() injects production adapters before any other
    modules are imported. When this doesn’t happen (e.g. unit tests, CLI),
    stub implementations are used.
    """

    _crash_reporter: ICrashReporter | None = None
    _push_notifier: IPushNotifier | None = None

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------
    @classmethod
    def register_crash_reporter(cls, reporter: ICrashReporter) -> None:
        cls._crash_reporter = reporter
        _LOGGER.debug("Registered crash reporter: %s", reporter)

    @classmethod
    def register_push_notifier(cls, notifier: IPushNotifier) -> None:
        cls._push_notifier = notifier
        _LOGGER.debug("Registered push notifier: %s", notifier)

    # ------------------------------------------------------------------
    # Resolution
    # ------------------------------------------------------------------
    @classmethod
    def get_crash_reporter(cls) -> ICrashReporter:
        return cls._crash_reporter or NoopCrashReporter()

    @classmethod
    def get_push_notifier(cls) -> IPushNotifier:
        return cls._push_notifier or ConsolePushNotifier()


# ------------------------------------------------------------------------------
# Push Notification Observer
# ------------------------------------------------------------------------------


class NotificationObserver:
    """
    Subscribes to quest-related events and schedules push notifications to help
    re-engage the player.
    """

    REMINDER_DELAY_SEC = 60 * 30  # 30 minutes

    def __init__(self, bus: EventBus | None = None) -> None:
        self._bus = bus or EventBus.get_global()
        self._disposable = self._bus.subscribe(EventType.QUEST_STARTED, self._on_quest_started)

    def _on_quest_started(self, event: Event) -> None:
        quest_id = event.payload.get("quest_id")
        title = "Keep forging ahead!"
        body = f"Your quest '{quest_id}' awaits – complete it for loot and XP!"
        when = time.time() + self.REMINDER_DELAY_SEC
        AdapterFactory.get_push_notifier().schedule_notification(title, body, when)

    def shutdown(self) -> None:
        self._disposable.dispose()


# ------------------------------------------------------------------------------
# Module initialisation helpers (used by desktop CLI / tests)
# ------------------------------------------------------------------------------

def _default_db_path() -> Path:
    home = Path(os.environ.get("QUESTSMITH_HOME", Path.home() / ".questsmith"))
    return home / "analytics.db"


def init_default_services() -> None:
    """
    Initialise global services when the mobile bootstrap hasn’t run yet.

    Safe to call multiple times – subsequent calls are ignored.
    """
    AnalyticsEngine.ensure_started(_default_db_path())
    NotificationObserver()


# On import in a non-mobile environment, set up default services.
try:
    import kivy  # type: ignore

    # On mobile Kivy targets, the app will register production adapters.
except ImportError:
    init_default_services()
```