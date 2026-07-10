```python
"""
QuestSmith – module_3.py
========================
This module bundles the core cross-cutting infrastructure used by several
other parts of the QuestSmith monolith:

    • EventBus:          Lightweight Observer implementation for in-process
                         pub/sub of domain events.
    • QuestRepository:   SQLite-backed Repository (per Repository Pattern)
                         providing persistence for quest domain objects.
    • AdaptiveDifficultyManager:
                         Domain service that listens to quest completion
                         events, tweaks difficulty curves, records analytics,
                         and schedules follow-up notifications—illustrating
                         MVVM-friendly, side-effect-free core logic.

All classes are written to be dependency-injectable and mobile-friendly.
Factory hooks are used whenever the implementation may vary by platform.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from types import TracebackType
from typing import Callable, Dict, Generic, Iterable, List, Optional, Protocol, Tuple, Type, TypeVar

###############################################################################
# Event Bus — simple, type-safe Observer implementation                       #
###############################################################################

T = TypeVar("T", bound="BaseEvent")
Subscriber = Callable[[T], None]


class BaseEvent(ABC):
    """Root domain-event class."""

    @property
    @abstractmethod
    def type(self) -> str:  # noqa: D401
        """Return event type as string identifier."""
        raise NotImplementedError


class EventBus:
    """
    Thread-safe singleton EventBus.  
    Listeners are weakly held by default; however, for simplicity
    we retain strong references (mobile app lives short).
    """

    _instance: "EventBus" | None = None
    _lock = threading.Lock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[str, List[Subscriber]] = {}
            return cls._instance

    # --------------------------------------------------------------------- #
    # Subscription management                                               #
    # --------------------------------------------------------------------- #
    def subscribe(self, event_type: Type[T] | str, handler: Subscriber) -> None:
        key = event_type if isinstance(event_type, str) else event_type.__name__
        self._subscribers.setdefault(key, []).append(handler)

    def unsubscribe(self, event_type: Type[T] | str, handler: Subscriber) -> None:
        key = event_type if isinstance(event_type, str) else event_type.__name__
        handlers = self._subscribers.get(key, [])
        if handler in handlers:
            handlers.remove(handler)

    # --------------------------------------------------------------------- #
    # Event dispatch                                                        #
    # --------------------------------------------------------------------- #
    def publish(self, event: BaseEvent) -> None:
        handlers = list(self._subscribers.get(event.type, []))
        for handler in handlers:
            try:
                handler(event)  # type: ignore[arg-type]
            except Exception as exc:  # pragma: no cover
                # Fail-safe: log, swallow, continue
                print(f"[EventBus] Handler {handler} raised for {event}: {exc}")


###############################################################################
# Events                                                                      #
###############################################################################


@dataclass(frozen=True, slots=True)
class QuestCompletedEvent(BaseEvent):
    quest_id: str
    user_id: str
    xp_gained: int
    timestamp: float = time.time()

    @property
    def type(self) -> str:  # noqa: D401
        return self.__class__.__name__


###############################################################################
# Repository                                                                  #
###############################################################################


@dataclass(slots=True)
class Quest:
    id: str
    user_id: str
    title: str
    difficulty: int  # 1-10
    is_completed: bool
    metadata: dict[str, str]


class QuestRepositoryProtocol(Protocol):
    """Repository abstraction used by the domain layer."""

    def get(self, quest_id: str, user_id: str) -> Optional[Quest]: ...
    def update(self, quest: Quest) -> None: ...
    def list_for_user(self, user_id: str) -> List[Quest]: ...


class SQLiteQuestRepository(QuestRepositoryProtocol):
    """SQLite-backed implementation with rudimentary migrations."""

    _DB_NAME = "questsmith.db"
    _SCHEMA_VERSION = 1

    def __init__(self, db_path: Path | str):
        self._db_path = Path(db_path).expanduser()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._ensure_schema()

    # ------------------------------------------------------------------ #
    # Context manager for connections to guarantee close after use       #
    # ------------------------------------------------------------------ #
    @contextmanager
    def _conn(self) -> Iterable[sqlite3.Connection]:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "CREATE TABLE IF NOT EXISTS meta"
                " (key TEXT PRIMARY KEY, value TEXT)"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS quests ("
                "  id TEXT, user_id TEXT, title TEXT, difficulty INTEGER,"
                "  is_completed INTEGER, metadata TEXT,"
                "  PRIMARY KEY (id, user_id)"
                ")"
            )
            conn.commit()

    # ------------------------------------------------------------------ #
    # CRUD                                                               #
    # ------------------------------------------------------------------ #
    def get(self, quest_id: str, user_id: str) -> Optional[Quest]:
        with self._conn() as conn, self._lock:
            row = conn.execute(
                "SELECT * FROM quests WHERE id=? AND user_id=?",
                (quest_id, user_id),
            ).fetchone()
            if not row:
                return None
            return self._row_to_quest(row)

    def update(self, quest: Quest) -> None:
        with self._conn() as conn, self._lock:
            payload = (
                quest.id,
                quest.user_id,
                quest.title,
                quest.difficulty,
                int(quest.is_completed),
                json.dumps(quest.metadata),
            )
            conn.execute(
                "INSERT OR REPLACE INTO quests "
                "(id, user_id, title, difficulty, is_completed, metadata) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                payload,
            )
            conn.commit()

    def list_for_user(self, user_id: str) -> List[Quest]:
        with self._conn() as conn, self._lock:
            rows = conn.execute(
                "SELECT * FROM quests WHERE user_id=?", (user_id,)
            ).fetchall()
            return [self._row_to_quest(r) for r in rows]

    # ------------------------------------------------------------------ #
    # Utility                                                            #
    # ------------------------------------------------------------------ #
    @staticmethod
    def _row_to_quest(row: sqlite3.Row) -> Quest:
        return Quest(
            id=row["id"],
            user_id=row["user_id"],
            title=row["title"],
            difficulty=row["difficulty"],
            is_completed=bool(row["is_completed"]),
            metadata=json.loads(row["metadata"] or "{}"),
        )


###############################################################################
# Factory Interfaces                                                          #
###############################################################################


class AnalyticsProvider(Protocol):
    @abstractmethod
    def track_event(self, name: str, props: Dict[str, str]) -> None: ...


class NotificationScheduler(Protocol):
    """Simplified protocol for push-notification scheduling."""

    @abstractmethod
    def schedule(
        self, user_id: str, title: str, body: str, trigger_at: float
    ) -> None: ...


class ServiceFactory:
    """
    Trivial service locator / factory.  
    Real implementation lives elsewhere; here we store instances
    for demonstration & unit-testing convenience.
    """

    _analytics: Optional[AnalyticsProvider] = None
    _notifier: Optional[NotificationScheduler] = None

    # ------------------------------------------------------------------ #
    # Registration                                                       #
    # ------------------------------------------------------------------ #
    @classmethod
    def register_analytics(cls, analytics: AnalyticsProvider) -> None:
        cls._analytics = analytics

    @classmethod
    def register_notifier(cls, notifier: NotificationScheduler) -> None:
        cls._notifier = notifier

    # ------------------------------------------------------------------ #
    # Access                                                             #
    # ------------------------------------------------------------------ #
    @classmethod
    def analytics(cls) -> AnalyticsProvider:
        if cls._analytics is None:
            raise RuntimeError("Analytics provider not registered.")
        return cls._analytics

    @classmethod
    def notifier(cls) -> NotificationScheduler:
        if cls._notifier is None:
            raise RuntimeError("Notification scheduler not registered.")
        return cls._notifier


###############################################################################
# Adaptive Difficulty                                                         #
###############################################################################


class AdaptiveDifficultyManager:
    """
    Domain service responsible for tweaking quest difficulty curves based on
    user's performance, while remaining UI-agnostic (MVVM-friendly).
    """

    _BASELINE_TIME = 60 * 60 * 24  # 24 hours before next quest appears
    _MAX_DIFFICULTY = 10
    _MIN_DIFFICULTY = 1

    def __init__(
        self,
        repo: QuestRepositoryProtocol,
        bus: EventBus | None = None,
    ) -> None:
        self._repo = repo
        self._bus = bus or EventBus()
        self._bus.subscribe(QuestCompletedEvent, self._on_quest_completed)
        self._algo_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Event handler                                                      #
    # ------------------------------------------------------------------ #
    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        with self._algo_lock:
            quest = self._repo.get(event.quest_id, event.user_id)
            if quest is None:
                return  # Out-of-date event; ignore

            # Mark quest completed
            quest.is_completed = True
            self._repo.update(quest)

            # Analytics
            ServiceFactory.analytics().track_event(
                "quest_completed",
                {
                    "quest_id": quest.id,
                    "user_id": quest.user_id,
                    "difficulty": str(quest.difficulty),
                    "xp": str(event.xp_gained),
                },
            )

            # Adjust difficulty
            new_difficulty = self._calculate_new_difficulty(
                user_id=quest.user_id,
                last_difficulty=quest.difficulty,
                xp_gained=event.xp_gained,
            )

            # Persist to upcoming quests
            self._apply_new_difficulty(user_id=quest.user_id, value=new_difficulty)

            # Schedule notification to encourage the user
            trigger = time.time() + self._BASELINE_TIME / max(1, new_difficulty)
            ServiceFactory.notifier().schedule(
                user_id=quest.user_id,
                title="A new challenge awaits!",
                body=f"Your next quest difficulty is {new_difficulty}. Ready up!",
                trigger_at=trigger,
            )

    # ------------------------------------------------------------------ #
    # Domain logic                                                       #
    # ------------------------------------------------------------------ #
    def _calculate_new_difficulty(
        self, user_id: str, last_difficulty: int, xp_gained: int
    ) -> int:
        """
        Simple adaptive algorithm:
        • Increase difficulty if user breezed through (high xp)
        • Decrease if user gained little
        """
        # Normalize xp to range ‑1 .. +1
        delta = (xp_gained - 50) / 50  # assume 0-100 xp typical
        step = 1 if delta >= 0 else -1
        new_level = last_difficulty + step
        return int(max(self._MIN_DIFFICULTY, min(self._MAX_DIFFICULTY, new_level)))

    def _apply_new_difficulty(self, user_id: str, value: int) -> None:
        # Update all non-completed quests for user atomically
        quests = self._repo.list_for_user(user_id)
        for q in quests:
            if not q.is_completed:
                q.difficulty = value
                self._repo.update(q)


###############################################################################
# Dummy Adapters for stand-alone demo                                         #
###############################################################################


class _ConsoleAnalytics(AnalyticsProvider):
    def track_event(self, name: str, props: Dict[str, str]) -> None:
        print(f"[Analytics] {name} – {props}")


class _ConsoleNotifier(NotificationScheduler):
    def schedule(
        self, user_id: str, title: str, body: str, trigger_at: float
    ) -> None:
        eta = trigger_at - time.time()
        print(
            f"[Notifier] To '{user_id}' in {eta:.0f}s — {title}: {body}"
        )


###############################################################################
# Module-level setup (executed on import)                                     #
###############################################################################

# Register console fallbacks
ServiceFactory.register_analytics(_ConsoleAnalytics())
ServiceFactory.register_notifier(_ConsoleNotifier())

# Expose convenience singletons
event_bus = EventBus()

###############################################################################
# Self-test when run as script                                                #
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    repo = SQLiteQuestRepository(":memory:")
    manager = AdaptiveDifficultyManager(repo, event_bus)

    # Seed fake quest
    quest = Quest(
        id="q1",
        user_id="u42",
        title="Study Algorithms",
        difficulty=3,
        is_completed=False,
        metadata={},
    )
    repo.update(quest)

    # Fire event
    event_bus.publish(QuestCompletedEvent("q1", "u42", xp_gained=80))
```