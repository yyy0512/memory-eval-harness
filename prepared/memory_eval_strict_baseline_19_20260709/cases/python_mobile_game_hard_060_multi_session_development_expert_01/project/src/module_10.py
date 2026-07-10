```python
"""
QuestSmith – Adaptive Difficulty Engine
---------------------------------------

This module implements all logic related to *adaptive difficulty scaling*.
By monitoring the player’s quest-completion performance it dynamically
adjusts reward multipliers so the game remains motivating without becoming
too easy or frustratingly hard.

Pattern Highlights
------------------
* Repository Pattern  — `AdaptiveDifficultyRepository` centralises DB access  
* Observer Pattern    — `EventBus` + `AdaptiveDifficultyManager` subscriber  
* Factory Pattern     — `repository_factory` helper for easy DI/Testing       

The code is intentionally self-contained so it can be dropped into the
monolithic QuestSmith app without touching the rest of the code-base.
"""

from __future__ import annotations

import contextlib
import sqlite3
import threading
import uuid
import logging
from collections import deque, defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Deque, Dict, Iterable, List, Optional

# -----------------------------------------------------------------------------
# Logging configuration
# -----------------------------------------------------------------------------

LOGGER = logging.getLogger(__name__)
if not LOGGER.handlers:  # Prevent duplicate handlers when re-loading in dev
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)8s] %(name)s:%(lineno)d  %(message)s"
        )
    )
    LOGGER.addHandler(_handler)
    LOGGER.setLevel(logging.INFO)

# -----------------------------------------------------------------------------
# Event-bus (extremely light implementation for stand-alone operation)
# -----------------------------------------------------------------------------

EventCallback = Callable[["BaseEvent"], None]


class EventBus:
    """
    A *very* small Observer implementation. In production, QuestSmith provides
    a richer, thread-safe event-bus, but this fallback keeps the module
    functional when unit-tested in isolation.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[EventCallback]] = defaultdict(list)
        self._lock = threading.Lock()

    # ----------------------------------------------------------------------

    def subscribe(self, event_type: str, callback: EventCallback) -> None:
        """Register `callback` for `event_type`."""
        with self._lock:
            self._subscribers[event_type].append(callback)
            LOGGER.debug("Subscribed %s to %s", callback, event_type)

    def unsubscribe(self, event_type: str, callback: EventCallback) -> None:
        """Remove an earlier subscription. Silently ignores missing combos."""
        with self._lock:
            try:
                self._subscribers[event_type].remove(callback)
                LOGGER.debug("Unsubscribed %s from %s", callback, event_type)
            except (KeyError, ValueError):
                pass

    # ----------------------------------------------------------------------

    def publish(self, event: "BaseEvent") -> None:
        """Push `event` to all listeners on current thread."""
        callbacks = list(self._subscribers.get(event.event_type, []))
        LOGGER.debug("Publishing %s to %d subscriber(s)", event, len(callbacks))
        for cb in callbacks:
            try:
                cb(event)
            except Exception:  # pragma: no cover
                LOGGER.exception("Uncaught error in event subscriber")


# -----------------------------------------------------------------------------
# Event types
# -----------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class BaseEvent:
    event_id: str
    event_type: str
    created_at: datetime

    def __init__(self, event_type: str) -> None:
        object.__setattr__(self, "event_id", str(uuid.uuid4()))
        object.__setattr__(self, "event_type", event_type)
        object.__setattr__(self, "created_at", datetime.now(timezone.utc))


@dataclass(frozen=True, slots=True)
class QuestCompletedEvent(BaseEvent):
    user_id: str
    quest_id: str
    duration_seconds: int  # Time from quest start to finish
    xp_awarded: int
    succeeded: bool

    def __init__(
        self,
        user_id: str,
        quest_id: str,
        duration_seconds: int,
        xp_awarded: int,
        succeeded: bool,
    ) -> None:
        super().__init__(event_type="quest_completed")
        object.__setattr__(self, "user_id", user_id)
        object.__setattr__(self, "quest_id", quest_id)
        object.__setattr__(self, "duration_seconds", duration_seconds)
        object.__setattr__(self, "xp_awarded", xp_awarded)
        object.__setattr__(self, "succeeded", succeeded)


@dataclass(frozen=True, slots=True)
class DifficultyChangedEvent(BaseEvent):
    user_id: str
    old_multiplier: float
    new_multiplier: float

    def __init__(self, user_id: str, old_multiplier: float, new_multiplier: float):
        super().__init__(event_type="difficulty_changed")
        object.__setattr__(self, "user_id", user_id)
        object.__setattr__(self, "old_multiplier", old_multiplier)
        object.__setattr__(self, "new_multiplier", new_multiplier)


# -----------------------------------------------------------------------------
# Persistence — Repository Pattern
# -----------------------------------------------------------------------------

DB_FILE = Path.home() / ".questsmith.db"
_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS adaptive_difficulty (
    user_id TEXT PRIMARY KEY,
    multiplier REAL NOT NULL,
    updated_at TEXT NOT NULL
)
"""


@dataclass(slots=True)
class DifficultyProfile:
    """POJO representing a single row in the DB."""

    user_id: str
    multiplier: float = 1.0
    updated_at: datetime = datetime.now(timezone.utc)


class AdaptiveDifficultyRepository:
    """
    Thin wrapper around SQLite. Handles schema creation, (de)serialisation,
    and basic CRUD. Thread-safe thanks to the GIL + per-method connections.
    """

    def __init__(self, db_path: Path | str = DB_FILE) -> None:
        self._db_path = Path(db_path)
        self._ensure_schema()

    # ----------------------------------------------------------------------
    # Public API
    # ----------------------------------------------------------------------

    def get_profile(self, user_id: str) -> DifficultyProfile:
        LOGGER.debug("Fetching difficulty profile for user %s", user_id)
        row = self._fetch_one(
            "SELECT * FROM adaptive_difficulty WHERE user_id = ?", (user_id,)
        )
        if row:
            return self._row_to_profile(row)
        # Provision default record
        profile = DifficultyProfile(user_id=user_id)
        self.save_profile(profile)
        return profile

    def save_profile(self, profile: DifficultyProfile) -> None:
        LOGGER.debug("Saving difficulty profile: %s", profile)
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO adaptive_difficulty (user_id, multiplier, updated_at)
                VALUES (:user_id, :multiplier, :updated_at)
                ON CONFLICT(user_id)
                    DO UPDATE SET
                        multiplier=excluded.multiplier,
                        updated_at=excluded.updated_at
                """,
                {
                    "user_id": profile.user_id,
                    "multiplier": profile.multiplier,
                    "updated_at": profile.updated_at.isoformat(),
                },
            )

    # ----------------------------------------------------------------------
    # Internals
    # ----------------------------------------------------------------------

    def _ensure_schema(self) -> None:
        with self._connect() as con:
            con.execute(_TABLE_SQL)

    @contextlib.contextmanager
    def _connect(self) -> Iterable[sqlite3.Connection]:
        con = sqlite3.connect(self._db_path)
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _fetch_one(self, query: str, params: tuple) -> Optional[sqlite3.Row]:
        with self._connect() as con:
            con.row_factory = sqlite3.Row
            cur = con.execute(query, params)
            return cur.fetchone()

    @staticmethod
    def _row_to_profile(row: sqlite3.Row) -> DifficultyProfile:
        return DifficultyProfile(
            user_id=row["user_id"],
            multiplier=float(row["multiplier"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )


# -----------------------------------------------------------------------------
# Repository factory — to maintain Factory Pattern compliance
# -----------------------------------------------------------------------------

def repository_factory(db_path: Path | str = DB_FILE) -> AdaptiveDifficultyRepository:
    """Return a new repo instance. Allows injection/mocking in other layers."""
    return AdaptiveDifficultyRepository(db_path=db_path)


# -----------------------------------------------------------------------------
# Adaptive Difficulty Engine  – Observer Pattern consumer
# -----------------------------------------------------------------------------

class AdaptiveDifficultyManager:
    """
    Subscribes to *QuestCompletedEvent* events, keeps a rolling performance
    window per user, calculates new multipliers, persists them, and notifies
    interested parties via *DifficultyChangedEvent*.
    """

    WINDOW_SIZE = 50                   # Quests considered for rolling stats
    SUCCESS_THRESHOLD_HIGH = 0.90      # >90 % success → increase difficulty
    SUCCESS_THRESHOLD_LOW = 0.35       # <35 % success → decrease difficulty
    INCREMENT = 0.10                   # Step size for multiplier adjustments
    MIN_MULTIPLIER = 0.5
    MAX_MULTIPLIER = 2.0

    # ----------------------------------------------------------------------

    def __init__(
        self,
        event_bus: EventBus,
        repo: AdaptiveDifficultyRepository | None = None,
        window_size: int | None = None,
    ) -> None:
        self._bus = event_bus
        self._repo = repo or repository_factory()
        self._windows: Dict[str, Deque[bool]] = defaultdict(
            lambda: deque(maxlen=window_size or self.WINDOW_SIZE)
        )
        # Thread-safety for window updates / profile caching
        self._lock = threading.Lock()
        self._bus.subscribe("quest_completed", self._on_quest_completed)
        LOGGER.info("AdaptiveDifficultyManager initialised")

    # ----------------------------------------------------------------------

    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:  # noqa: D401
        """Handle incoming QuestCompletedEvent."""
        if not isinstance(event, QuestCompletedEvent):
            return

        with self._lock:
            window = self._windows[event.user_id]
            window.append(event.succeeded)
            LOGGER.debug("Updated perf window for user %s: %s", event.user_id, window)

            # Wait until we have a reasonable sample size
            if len(window) < window.maxlen:
                return

            success_rate = sum(window) / len(window)
            profile = self._repo.get_profile(event.user_id)
            LOGGER.debug(
                "User %s success-rate %.1f%%  (current multiplier %.2f)",
                event.user_id,
                success_rate * 100,
                profile.multiplier,
            )

            new_multiplier = self._calculate_new_multiplier(
                success_rate, profile.multiplier
            )

            # No change → nothing to do
            if abs(new_multiplier - profile.multiplier) < 1e-6:
                return

            # Persist + notify on a background thread so we don’t block UI
            threading.Thread(
                target=self._apply_multiplier_change,
                args=(event.user_id, profile.multiplier, new_multiplier),
                name=f"AdaptiveDiff-{event.user_id}",
                daemon=True,
            ).start()

    # ----------------------------------------------------------------------

    def _calculate_new_multiplier(self, success_rate: float, current: float) -> float:
        if success_rate >= self.SUCCESS_THRESHOLD_HIGH:
            new = min(self.MAX_MULTIPLIER, current + self.INCREMENT)
            LOGGER.debug("Increasing difficulty (%.2f → %.2f)", current, new)
            return new
        if success_rate <= self.SUCCESS_THRESHOLD_LOW:
            new = max(self.MIN_MULTIPLIER, current - self.INCREMENT)
            LOGGER.debug("Decreasing difficulty (%.2f → %.2f)", current, new)
            return new
        return current  # Keep as-is

    # ----------------------------------------------------------------------

    def _apply_multiplier_change(
        self, user_id: str, old: float, new: float
    ) -> None:  # pragma: no cover
        """Persist change and notify observers (runs in background thread)."""
        try:
            profile = DifficultyProfile(
                user_id=user_id, multiplier=new, updated_at=datetime.now(timezone.utc)
            )
            self._repo.save_profile(profile)
            self._bus.publish(
                DifficultyChangedEvent(user_id=user_id, old_multiplier=old, new_multiplier=new)
            )
            LOGGER.info(
                "Difficulty multiplier for user %s changed %.2f → %.2f",
                user_id,
                old,
                new,
            )
        except Exception:  # pragma: no cover
            LOGGER.exception("Failed to persist difficulty change for user %s", user_id)

    # ----------------------------------------------------------------------
    # External API – useful for UI or analytics modules
    # ----------------------------------------------------------------------

    def get_multiplier(self, user_id: str) -> float:
        """Return current difficulty multiplier for `user_id`."""
        return self._repo.get_profile(user_id).multiplier

    def preload_user(self, user_id: str) -> None:
        """
        Optionally prime cache for given user. Might be called when user logs
        in so first quest completion doesn’t touch the DB from the UI thread.
        """
        self._repo.get_profile(user_id)


# -----------------------------------------------------------------------------
# Quick self-test
# -----------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    # Simulated run to showcase behaviour.
    bus = EventBus()
    manager = AdaptiveDifficultyManager(bus)

    user = "demo-user"

    # Make the user extremely successful to trigger an increase
    for _ in range(manager.WINDOW_SIZE):
        bus.publish(
            QuestCompletedEvent(
                user_id=user,
                quest_id=str(uuid.uuid4()),
                duration_seconds=60,
                xp_awarded=100,
                succeeded=True,
            )
        )

    # Make the user fail miserably to trigger a decrease
    for _ in range(manager.WINDOW_SIZE):
        bus.publish(
            QuestCompletedEvent(
                user_id=user,
                quest_id=str(uuid.uuid4()),
                duration_seconds=60,
                xp_awarded=100,
                succeeded=False,
            )
        )

    LOGGER.info(
        "Final multiplier for %s: %.2f", user, manager.get_multiplier(user)
    )
```