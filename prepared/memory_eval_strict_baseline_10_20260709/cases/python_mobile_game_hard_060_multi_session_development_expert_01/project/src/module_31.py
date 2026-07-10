```python
"""
module_31.py
QuestSmith – Productivity RPG Forge (mobile_game)

This module contains core infrastructure-level components that are shared
throughout the QuestSmith application.  It demonstrates several architectural
patterns employed by the project:

    • Repository Pattern for a unified SQLite data source
    • Observer Pattern for an in-process event bus
    • Factory & Adapter Patterns to abstract platform services
    • Minimal MVVM-friendly “service” layer that coordinates repositories
      with external adapters

The code purposefully avoids any direct UI dependencies to keep the module
pure-logic, testable, and reusable across Kivy views and background workers.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Tuple

# --------------------------------------------------------------------------- #
# Logging Configuration
# --------------------------------------------------------------------------- #

_LOG_FORMAT = (
    "%(asctime)s — [%(threadName)s] %(levelname)s   %(name)s: %(message)s"
)
logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT)
logger = logging.getLogger("questsmith.core")

# --------------------------------------------------------------------------- #
# Observer Pattern – Event Bus
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Event:
    """
    A lightweight, immutable event object distributed across the app.

    Attributes
    ----------
    type:
        A machine-readable identifier (e.g. "quest.completed").
    payload:
        Arbitrary event data.  Consumers must inspect/validate content.
    timestamp:
        Creation time in UTC.
    """
    type: str
    payload: Dict[str, Any]
    timestamp: datetime = datetime.utcnow()


Subscriber = Callable[[Event], None]


class EventBus:
    """
    Thread-safe, in-memory publish/subscribe hub.

    The bus purposefully keeps API minimal so it can be replaced by a more
    sophisticated implementation (Redis, RxPy, etc.) without changing call-sites.
    """

    _instance: "EventBus" | None = None
    _lock = threading.RLock()

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Subscriber]] = {}
        self._global_subscribers: List[Subscriber] = []
        self._event_lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Singleton helpers
    # --------------------------------------------------------------------- #

    @classmethod
    def get(cls) -> "EventBus":
        """
        Singleton accessor used across the project.

        Raises
        ------
        RuntimeError
            If someone tries to instantiate the EventBus directly more than once.
        """
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    # --------------------------------------------------------------------- #
    # Subscription Management
    # --------------------------------------------------------------------- #

    def subscribe(self, subscriber: Subscriber, *, event_type: Optional[str] = None) -> None:
        """
        Register a subscriber for the given event type.

        If `event_type` is None, the callback receives *all* events.
        """
        with self._event_lock:
            if event_type is None:
                if subscriber not in self._global_subscribers:
                    self._global_subscribers.append(subscriber)
                    logger.debug("Subscriber %s registered for all events", subscriber)
            else:
                self._subscribers.setdefault(event_type, [])
                if subscriber not in self._subscribers[event_type]:
                    self._subscribers[event_type].append(subscriber)
                    logger.debug(
                        "Subscriber %s registered for event '%s'", subscriber, event_type
                    )

    def unsubscribe(self, subscriber: Subscriber) -> None:
        """Remove a subscriber from all lists."""
        with self._event_lock:
            if subscriber in self._global_subscribers:
                self._global_subscribers.remove(subscriber)

            for sub_list in self._subscribers.values():
                if subscriber in sub_list:
                    sub_list.remove(subscriber)

    # --------------------------------------------------------------------- #
    # Dispatch
    # --------------------------------------------------------------------- #

    def publish(self, event: Event) -> None:
        """
        Publish an event to all listeners.  Non-blocking; exceptions inside
        subscribers are logged but do not stop dispatching.
        """
        with self._event_lock:
            targets: List[Subscriber] = list(self._global_subscribers)
            targets.extend(self._subscribers.get(event.type, []))

        for callback in targets:
            try:
                callback(event)
            except Exception:  # noqa: BLE001 — Never break event propagation
                logger.exception("Error in subscriber %s while handling %s", callback, event)


# --------------------------------------------------------------------------- #
# Repository Pattern – Quest Repository
# --------------------------------------------------------------------------- #


class RepositoryError(RuntimeError):
    """Generic persistence-layer failure."""


@dataclass(slots=True)
class Quest:
    id: int
    name: str
    status: str  # e.g. "pending", "completed", "failed"
    due_at: Optional[datetime]
    location: Optional[str]
    created_at: datetime
    updated_at: datetime

    # Domain helpers -------------------------------------------------------

    def is_overdue(self, at: Optional[datetime] = None) -> bool:
        """Return True if the quest is overdue at the provided time (default now)."""
        if not self.due_at:
            return False
        current = at or datetime.utcnow()
        return current > self.due_at and self.status != "completed"


class QuestRepository:
    """
    SQLite-based repository for Quest entities.
    """

    _DDL = """
    CREATE TABLE IF NOT EXISTS quests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        due_at TEXT,
        location TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path).expanduser()
        logger.debug("QuestRepository initialized with db_path=%s", self._db_path)
        self._init_schema()

    # ------------------------------------------------------------------ #
    # Private helpers
    # ------------------------------------------------------------------ #

    def _init_schema(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(self._DDL)
            logger.debug("Database schema ensured for quests table")

    @contextmanager
    def _get_conn(self) -> Iterable[sqlite3.Connection]:
        try:
            conn = sqlite3.connect(
                self._db_path,
                detect_types=sqlite3.PARSE_DECLTYPES | sqlite3.PARSE_COLNAMES,
            )
            conn.row_factory = sqlite3.Row
            yield conn
            conn.commit()
        except sqlite3.Error as exc:  # noqa: BLE001
            logger.exception("QuestRepository DB failure")
            raise RepositoryError(str(exc)) from exc
        finally:
            if "conn" in locals():
                conn.close()

    # ------------------------------------------------------------------ #
    # CRUD operations
    # ------------------------------------------------------------------ #

    def add(
        self,
        name: str,
        *,
        due_at: Optional[datetime] = None,
        location: Optional[str] = None,
    ) -> Quest:
        now = datetime.utcnow()
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO quests (name, status, due_at, location, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    "pending",
                    due_at.isoformat() if due_at else None,
                    location,
                    now.isoformat(),
                    now.isoformat(),
                ),
            )
            new_id = cursor.lastrowid
            logger.info("Quest %s added with id=%s", name, new_id)
            return self.get(new_id)

    def get(self, quest_id: int) -> Quest:
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM quests WHERE id = ?", (quest_id,)
            ).fetchone()
            if not row:
                raise RepositoryError(f"Quest id={quest_id} not found")
            return self._row_to_entity(row)

    def list(self, *, status: Optional[str] = None) -> List[Quest]:
        sql = "SELECT * FROM quests"
        args: Tuple[Any, ...] = ()
        if status:
            sql += " WHERE status = ?"
            args = (status,)
        with self._get_conn() as conn:
            rows = conn.execute(sql, args).fetchall()
            return [self._row_to_entity(r) for r in rows]

    def update_status(self, quest_id: int, status: str) -> Quest:
        now = datetime.utcnow()
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                UPDATE quests SET status = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    status,
                    now.isoformat(),
                    quest_id,
                ),
            )
            if cursor.rowcount == 0:
                raise RepositoryError(f"Quest id={quest_id} not found for status update")
            logger.info("Quest id=%s status updated to '%s'", quest_id, status)
            return self.get(quest_id)

    # ------------------------------------------------------------------ #
    # Internal conversions
    # ------------------------------------------------------------------ #

    @staticmethod
    def _row_to_entity(row: sqlite3.Row) -> Quest:
        return Quest(
            id=row["id"],
            name=row["name"],
            status=row["status"],
            due_at=datetime.fromisoformat(row["due_at"]) if row["due_at"] else None,
            location=row["location"],
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


# --------------------------------------------------------------------------- #
# Adapter & Factory – Platform Service Abstractions
# --------------------------------------------------------------------------- #


class PushNotifier(Protocol):
    """Abstract push notification service."""

    def send(self, title: str, message: str, *, data: Optional[Dict[str, Any]] = None) -> None:
        ...


class CrashReporter(Protocol):
    """Abstract crash reporter service."""

    def capture_exception(self, err: Exception) -> None: ...


class BiometricAuthenticator(Protocol):
    """Abstract biometric authentication service."""

    def authenticate(self, prompt: str = "Authenticate") -> bool: ...


# --- Factory helpers ------------------------------------------------------- #


def get_push_notifier() -> PushNotifier:
    """
    Return a platform-specific PushNotifier implementation.

    For simplicity, this factory currently returns a logging stub.  In the real
    mobile build, it selects Android/iOS adapters injected at runtime.
    """
    class _LoggingPushNotifier:
        def send(self, title: str, message: str, *, data: Optional[Dict[str, Any]] = None) -> None:
            logger.info("[PushNotifier] %s — %s • data=%s", title, message, data)

    return _LoggingPushNotifier()


def get_crash_reporter() -> CrashReporter:
    """
    Return a platform-specific CrashReporter.  Stubbed here for demonstration.
    """
    class _LoggingCrashReporter:
        def capture_exception(self, err: Exception) -> None:  # noqa: D401
            logger.error("[CrashReporter] Captured: %s", err, exc_info=err)

    return _LoggingCrashReporter()


def get_biometric_authenticator() -> BiometricAuthenticator:
    """
    Return a biometric authenticator.  Real implementation would bridge
    to Android/iOS APIs.  Here, we fallback to a simple yes/no prompt.
    """
    class _PromptAuthenticator:
        def authenticate(self, prompt: str = "Authenticate") -> bool:  # noqa: D401
            try:
                response = input(f"{prompt} (y/n): ")
                return response.lower().startswith("y")
            except EOFError:  # Non-interactive context
                return False

    return _PromptAuthenticator()


# --------------------------------------------------------------------------- #
# Application Service Layer (MVVM-friendly)
# --------------------------------------------------------------------------- #


class QuestService:
    """
    Coordinating layer that exposes high-level quest operations used by ViewModels.

    It persists data via the repository, emits domain events via the bus, triggers
    push notifications, and records analytics—all while remaining UI agnostic.
    """

    def __init__(
        self,
        repository: QuestRepository,
        event_bus: EventBus | None = None,
        push_notifier: PushNotifier | None = None,
        crash_reporter: CrashReporter | None = None,
    ) -> None:
        self._repo = repository
        self._bus = event_bus or EventBus.get()
        self._push = push_notifier or get_push_notifier()
        self._crash = crash_reporter or get_crash_reporter()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def create_quest(
        self,
        name: str,
        *,
        due_at: Optional[datetime] = None,
        location: Optional[str] = None,
    ) -> Quest:
        quest = self._repo.add(name, due_at=due_at, location=location)
        self._bus.publish(Event("quest.created", {"quest": quest}))
        return quest

    def complete_quest(self, quest_id: int) -> Quest:
        try:
            quest = self._repo.update_status(quest_id, "completed")
            self._bus.publish(Event("quest.completed", {"quest": quest}))

            # Notify user of reward
            self._push.send(
                "Quest Completed!",
                f"You have completed “{quest.name}”. Great job!",
                data={"quest_id": quest.id},
            )
            return quest
        except Exception as exc:  # noqa: BLE001
            self._crash.capture_exception(exc)
            raise

    def fail_quest(self, quest_id: int) -> Quest:
        quest = self._repo.update_status(quest_id, "failed")
        self._bus.publish(Event("quest.failed", {"quest": quest}))
        return quest

    def list_pending_quests(self) -> List[Quest]:
        return self._repo.list(status="pending")


# --------------------------------------------------------------------------- #
# Analytics Subscriber Example
# --------------------------------------------------------------------------- #


class AnalyticsTracker:
    """
    Lightweight, pluggable analytics tracker that subscribes to domain events.
    """

    def __init__(self, bus: EventBus | None = None) -> None:
        self._bus = bus or EventBus.get()
        self._bus.subscribe(self._handle_event)

    # ------------------------------------------------------------------ #
    # Internal event handler
    # ------------------------------------------------------------------ #

    def _handle_event(self, event: Event) -> None:
        try:
            if event.type.startswith("quest."):
                quest: Quest = event.payload["quest"]
                logger.info(
                    "[Analytics] Event=%s QuestID=%s Status=%s", event.type, quest.id, quest.status
                )
                # Here we could increment counters, send network beacons, etc.
        except Exception:
            logger.exception("[Analytics] failed to process event %s", event.type)


# --------------------------------------------------------------------------- #
# Convenience bootstrap for ad-hoc testing
# --------------------------------------------------------------------------- #

def _bootstrap_demo(db_path: Path = Path.home() / ".questsmith.sqlite3") -> None:
    """
    Quick-and-dirty bootstrap that demonstrates repository + event bus interplay.

    This function is meant for developers.  It is *not* executed automatically at
    import-time to avoid side effects in production.
    """
    auth = get_biometric_authenticator()
    if not auth.authenticate("Access QuestSmith demo?"):
        print("Authentication failed – exiting demo.")
        return

    repo = QuestRepository(db_path)
    bus = EventBus.get()
    AnalyticsTracker(bus)  # subscribe analytics

    service = QuestService(repo, bus)

    # Create Quest
    quest = service.create_quest("Write integration tests", due_at=datetime.utcnow())
    logger.info("Created: %s", quest)

    # Mark complete
    service.complete_quest(quest.id)
    logger.info("Quest completion demo done.")


if __name__ == "__main__":
    try:
        _bootstrap_demo()
    except KeyboardInterrupt:
        print("\nDemo interrupted by user.")
```