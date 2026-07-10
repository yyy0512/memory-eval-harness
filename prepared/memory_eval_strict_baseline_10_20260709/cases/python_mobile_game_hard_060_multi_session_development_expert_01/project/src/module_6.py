```python
"""
QuestSmith – Module 6
--------------------

This module aggregates several core facilities that are needed across the
entire QuestSmith application.  They include:

• An Observer-based, thread-safe EventBus implementation
• A light-weight SQLite repository for Quest persistence
• A pluggable AnalyticsEngine that consumes quest events
• A PushNotificationScheduler stub that demonstrates loose coupling
• A minimal Factory for adapter injection (e.g., crash reporting)

The code uses only the Python 3 standard library, so that it remains
self-contained and easily portable to Kivy-enabled mobile targets.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from enum import Enum, IntEnum, auto
from pathlib import Path
from typing import Any, Callable, Dict, Generic, List, Optional, Protocol, Type, TypeVar

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

LOGGER = logging.getLogger("questsmith")
if not LOGGER.handlers:  # Avoid duplicate handlers when module is re-loaded.
    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s:%(name)s:%(funcName)s:%(lineno)d » %(message)s"
    )
    handler.setFormatter(formatter)
    LOGGER.addHandler(handler)
LOGGER.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #


class QuestStatus(IntEnum):
    """The various states a quest can be in."""

    PENDING = 1
    IN_PROGRESS = 2
    COMPLETED = 3
    ABANDONED = 4
    FAILED = 5


@dataclass(frozen=True, slots=True)
class Quest:
    """
    An immutable quest entity.

    Note that quests are uniquely identified by their UUID4 string; this avoids
    collisions during offline play.  (The DB enforces uniqueness.)
    """

    uuid: str
    title: str
    description: str
    created_ts: float
    due_ts: float
    status: QuestStatus
    exp_reward: int
    gold_reward: int

    def to_db_row(self) -> Dict[str, Any]:
        """Convert to a dict suitable for sqlite3 `execute` `:named` parameters."""
        d = asdict(self)
        d["status"] = self.status.value
        return d

    @staticmethod
    def from_db_row(row: sqlite3.Row) -> "Quest":
        return Quest(
            uuid=row["uuid"],
            title=row["title"],
            description=row["description"],
            created_ts=row["created_ts"],
            due_ts=row["due_ts"],
            status=QuestStatus(row["status"]),
            exp_reward=row["exp_reward"],
            gold_reward=row["gold_reward"],
        )


@dataclass(slots=True, frozen=True)
class QuestStatusEvent:
    """Event published on the bus whenever a quest changes status."""

    quest_uuid: str
    old_status: QuestStatus
    new_status: QuestStatus
    timestamp: float


# --------------------------------------------------------------------------- #
# Observer-based EventBus
# --------------------------------------------------------------------------- #

E = TypeVar("E")


class Subscriber(Protocol, Generic[E]):
    """A callable that is interested in events of type `E`."""

    def __call__(self, event: E) -> None: ...


class EventBus:
    """
    A thread-safe, generic event bus.

    Subscribers can register for specific event types.  Publishing an event will
    invoke every subscriber that registered for that event’s type, as well as
    any subscriber of the ‘Any’ wildcard.
    """

    _WILDCARD: Type[Any] = object

    def __init__(self) -> None:
        self._subscribers: Dict[Type[Any], List[Subscriber[Any]]] = {}
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Subscription
    # --------------------------------------------------------------------- #

    def subscribe(
        self, event_type: Type[E] | None, subscriber: Subscriber[E], *, sticky: bool = False
    ) -> None:
        """
        Subscribe to events of `event_type`.

        • `event_type` – `None` or `EventBus._WILDCARD` subscribes to *all* events.
        • `sticky` – If True and the event has been published before, the subscriber
          immediately receives the most recent event of the given type.
        """
        key = event_type or self._WILDCARD

        with self._lock:
            self._subscribers.setdefault(key, []).append(subscriber)

            if sticky:
                # Deliver the last event of this type, if any
                last = _StickyStore.last_event_of(key)
                if last is not _NoValue:
                    # Cast away type system complaints for ease of use
                    subscriber(last)  # type: ignore[arg-type]

    def unsubscribe(self, subscriber: Subscriber[Any]) -> None:
        """Remove *all* subscriptions associated with `subscriber`."""
        with self._lock:
            for subs in self._subscribers.values():
                if subscriber in subs:
                    subs.remove(subscriber)

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #

    def publish(self, event: E) -> None:
        key = type(event)
        _StickyStore.store(key, event)
        with self._lock:
            # Deliver to type-specific subscribers
            for sub in self._subscribers.get(key, ()):
                _invoke_safe(sub, event)
            # Deliver to wildcard subscribers
            for sub in self._subscribers.get(self._WILDCARD, ()):
                _invoke_safe(sub, event)


class _NoValueType:
    pass


_NoValue = _NoValueType()


class _StickyStore:
    """
    Maintains the most recent event per type so newly joined subscribers can
    immediately ‘catch up’.
    """

    _store: Dict[Type[Any], Any] = {}
    _lock = threading.RLock()

    @classmethod
    def store(cls, key: Type[Any], event: Any) -> None:
        with cls._lock:
            cls._store[key] = event

    @classmethod
    def last_event_of(cls, key: Type[Any]) -> Any:
        with cls._lock:
            return cls._store.get(key, _NoValue)


def _invoke_safe(callback: Callable[[Any], None], event: Any) -> None:
    """Run a subscriber while shielding the bus from unhandled exceptions."""
    try:
        callback(event)
    except Exception:  # pylint: disable=broad-except
        LOGGER.exception("Subscriber %r failed when handling event %r", callback, event)


# --------------------------------------------------------------------------- #
# Repository Pattern – QuestRepository
# --------------------------------------------------------------------------- #


class QuestRepository:
    """
    Centralized data access for quests.

    The repository is intentionally lean; complex query composition is delegated
    to higher-level services.
    """

    _SCHEMA_SQL = """
    CREATE TABLE IF NOT EXISTS quests (
        uuid         TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT,
        created_ts   REAL NOT NULL,
        due_ts       REAL NOT NULL,
        status       INTEGER NOT NULL,
        exp_reward   INTEGER NOT NULL,
        gold_reward  INTEGER NOT NULL
    );
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path).expanduser().resolve()
        self._lock = threading.RLock()

        # Ensure schema
        with self._get_conn() as conn:
            conn.executescript(self._SCHEMA_SQL)

    # ------------------------------------------------------------------ #
    # Context manager helpers
    # ------------------------------------------------------------------ #

    @contextmanager
    def _get_conn(self) -> sqlite3.Connection:
        """
        Get a connection with row factory configured for dict-style access.
        The connection is closed automatically when the context exits.
        """
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except sqlite3.DatabaseError:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ------------------------------------------------------------------ #
    # CRUD operations
    # ------------------------------------------------------------------ #

    def upsert(self, quest: Quest) -> None:
        sql = """
        INSERT INTO quests (
            uuid, title, description, created_ts, due_ts, status, exp_reward, gold_reward
        ) VALUES (
            :uuid, :title, :description, :created_ts, :due_ts, :status, :exp_reward, :gold_reward
        )
        ON CONFLICT(uuid) DO UPDATE SET
           title        = excluded.title,
           description  = excluded.description,
           created_ts   = excluded.created_ts,
           due_ts       = excluded.due_ts,
           status       = excluded.status,
           exp_reward   = excluded.exp_reward,
           gold_reward  = excluded.gold_reward;
        """
        with self._lock, self._get_conn() as conn:
            conn.execute(sql, quest.to_db_row())
        LOGGER.debug("Upserted quest %s", quest.uuid)

    def get(self, uuid: str) -> Optional[Quest]:
        sql = "SELECT * FROM quests WHERE uuid = ?;"
        with self._lock, self._get_conn() as conn:
            row = conn.execute(sql, (uuid,)).fetchone()
            return Quest.from_db_row(row) if row else None

    def delete(self, uuid: str) -> None:
        sql = "DELETE FROM quests WHERE uuid = ?;"
        with self._lock, self._get_conn() as conn:
            conn.execute(sql, (uuid,))
        LOGGER.debug("Deleted quest %s", uuid)

    def all(self) -> List[Quest]:
        sql = "SELECT * FROM quests;"
        with self._lock, self._get_conn() as conn:
            return [Quest.from_db_row(r) for r in conn.execute(sql)]


# --------------------------------------------------------------------------- #
# Analytics Engine
# --------------------------------------------------------------------------- #


class AnalyticsEngine:
    """
    A naïve analytics engine that collects quest status transitions and writes
    them to a JSON lines log.  It demonstrates EventBus consumption and could be
    swapped out transparently via the factory.
    """

    def __init__(self, bus: EventBus, log_path: Path | str) -> None:
        self._bus = bus
        self._log_path = Path(log_path).expanduser().resolve()
        self._lock = threading.RLock()
        self._bus.subscribe(QuestStatusEvent, self._on_quest_status)

    def _on_quest_status(self, event: QuestStatusEvent) -> None:
        payload = {
            "type": "quest_status",
            "quest_uuid": event.quest_uuid,
            "old": event.old_status.name,
            "new": event.new_status.name,
            "ts": event.timestamp,
        }
        with self._lock, self._log_path.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(payload, ensure_ascii=False) + "\n")
        LOGGER.debug("Analytics logged quest transition: %s", payload)


# --------------------------------------------------------------------------- #
# Push Notification Scheduler
# --------------------------------------------------------------------------- #


class PushNotificationScheduler:
    """
    Listens to quest-related events and schedules OS notifications accordingly.

    Rationale: Trophy moment? Completed quest => ‘Victory!’ notification.
    """

    def __init__(self, bus: EventBus, adapter_factory: "PlatformAdapterFactory") -> None:
        self._bus = bus
        self._adapter_factory = adapter_factory
        self._pn_adapter = adapter_factory.get_push_adapter()
        self._bus.subscribe(QuestStatusEvent, self._handle_quest_status)

    def _handle_quest_status(self, event: QuestStatusEvent) -> None:
        """Schedule a platform push notification."""
        if event.new_status is QuestStatus.COMPLETED:
            title = "Quest Completed!"
            body = f"🔥 You finished '{event.quest_uuid}'. Claim your rewards now!"
            self._pn_adapter.schedule(title=title, body=body, delay_seconds=1)
            LOGGER.info("Scheduled completion notification for quest %s", event.quest_uuid)

        elif event.new_status is QuestStatus.ABANDONED:
            title = "Quest Abandoned"
            body = "Sometimes retreat is the better option. Ready for a new challenge?"
            self._pn_adapter.schedule(title=title, body=body, delay_seconds=1)
            LOGGER.info("Scheduled abandonment notification for quest %s", event.quest_uuid)


# --------------------------------------------------------------------------- #
# Factory Pattern – Platform Adapters
# --------------------------------------------------------------------------- #


class PushAdapter(Protocol):
    """Platform specific push notification adapter."""

    def schedule(self, *, title: str, body: str, delay_seconds: int) -> None: ...


class CrashReporter(Protocol):
    """Platform specific crash reporting adapter."""

    def capture_exception(self, exc: BaseException) -> None: ...


class _NoOpPushAdapter:
    """Fallback push adapter that prints to log for unsupported platforms."""

    def schedule(self, *, title: str, body: str, delay_seconds: int) -> None:  # noqa: D401
        LOGGER.info(
            "PushNotification (noop) in %ds — %s: %s", delay_seconds, title, body
        )


class _NoOpCrashReporter:
    """Fallback crash reporter that logs but never raises."""

    def capture_exception(self, exc: BaseException) -> None:  # noqa: D401
        LOGGER.error("Crash captured (noop): %s", exc, exc_info=exc)


class PlatformAdapterFactory:
    """
    Provides correct platform adapters at runtime.

    The implementation could use `plyer`, Android/iOS APIs, or any other bridge.
    Here we simply return a no-op for demonstration.
    """

    def __init__(
        self,
        push_adapter_cls: Type[PushAdapter] | None = None,
        crash_reporter_cls: Type[CrashReporter] | None = None,
    ) -> None:
        self._push_cls = push_adapter_cls or _NoOpPushAdapter
        self._crash_cls = crash_reporter_cls or _NoOpCrashReporter

    # ------------------------------------------------------------------ #
    # Factory methods
    # ------------------------------------------------------------------ #

    def get_push_adapter(self) -> PushAdapter:  # noqa: D401
        return self._push_cls()

    def get_crash_reporter(self) -> CrashReporter:  # noqa: D401
        return self._crash_cls()


# --------------------------------------------------------------------------- #
# Public API for module:
# --------------------------------------------------------------------------- #

__all__ = [
    # Data
    "Quest",
    "QuestStatus",
    "QuestStatusEvent",
    # Event bus
    "EventBus",
    # Repository
    "QuestRepository",
    # Analytics
    "AnalyticsEngine",
    # Notifications
    "PushNotificationScheduler",
    # Factory
    "PlatformAdapterFactory",
]

# --------------------------------------------------------------------------- #
# Self-test harness (optional – executed only when run as a script)
# --------------------------------------------------------------------------- #

def _demo() -> None:
    """
    Quick smoke test that exercises the module’s happy path.  Executed when
    running `python -m module_6` or `python src/module_6.py`.
    """
    import uuid
    temp_db = Path("./_questsmith_demo.db")

    # Clean slate
    if temp_db.exists():
        temp_db.unlink()

    bus = EventBus()
    repo = QuestRepository(temp_db)
    analytics = AnalyticsEngine(bus, "./_analytics.log")
    factory = PlatformAdapterFactory()
    pn_scheduler = PushNotificationScheduler(bus, factory)

    # Create a quest
    q = Quest(
        uuid=str(uuid.uuid4()),
        title="Finish unit tests",
        description="Increase code coverage to 95%",
        created_ts=time.time(),
        due_ts=time.time() + 86400,
        status=QuestStatus.PENDING,
        exp_reward=150,
        gold_reward=350,
    )
    repo.upsert(q)

    # Simulate progress
    new_status = QuestStatus.COMPLETED
    # Persist change
    repo.upsert(q := q.__class__(**{**asdict(q), "status": new_status}))
    # Broadcast change
    bus.publish(
        QuestStatusEvent(
            quest_uuid=q.uuid,
            old_status=QuestStatus.PENDING,
            new_status=new_status,
            timestamp=time.time(),
        )
    )

    LOGGER.info("Demo finished. Check _analytics.log for output.")


if __name__ == "__main__":
    try:
        _demo()
    except Exception as exc:  # pylint: disable=broad-except
        LOGGER.exception("Unhandled exception during demo: %s", exc)
```