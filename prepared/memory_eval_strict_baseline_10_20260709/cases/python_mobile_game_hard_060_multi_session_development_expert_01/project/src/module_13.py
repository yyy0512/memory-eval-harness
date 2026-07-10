```python
"""
QuestSmith: Productivity RPG Forge
----------------------------------

Module: src/module_13.py
Purpose: Adaptive Difficulty Engine (ADE)

This module implements an adaptive–difficulty engine that listens to quest
completion events and continuously tunes the player–specific difficulty curve.
It follows the Repository and Observer patterns to remain decoupled from
persistence and messaging layers.  A simple factory helper is included so the
engine can be instantiated with different repository or event-bus back-ends
during testing.

The algorithm:
    1. Observe QuestCompleted / QuestFailed events.
    2. Maintain a moving window of the last *N* quests.
    3. Compute a performance score (0–1) based on completion time, success
       ratio, and optional streak bonus.
    4. Persist aggregated stats through the repository layer.
    5. Emit a DifficultyChanged event when the player’s difficulty band moves.

The engine is designed to be light-weight and offline-friendly.  It works
entirely with local metrics and will reconcile with the server once
connectivity resumes.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from enum import Enum, auto
from pathlib import Path
from typing import Callable, Deque, Dict, Optional, Protocol, Any, List

LOGGER = logging.getLogger("questsmith.adaptive_difficulty")
logging.basicConfig(level=logging.INFO)

# --------------------------------------------------------------------------- #
# Domain enums & data classes
# --------------------------------------------------------------------------- #


class DifficultyBand(Enum):
    EASY = auto()
    NORMAL = auto()
    HARD = auto()
    LEGENDARY = auto()

    @classmethod
    def from_score(cls, score: float) -> "DifficultyBand":
        """Map performance score to predefined difficulty bands."""
        if score < 0.45:       # Struggling
            return cls.EASY
        if score < 0.70:       # Average
            return cls.NORMAL
        if score < 0.90:       # Performing well
            return cls.HARD
        return cls.LEGENDARY   # Crushing it


@dataclass(frozen=True)
class QuestEvent:
    """Event emitted by the quest engine."""
    quest_id: str
    user_id: str
    completed: bool
    duration_seconds: float
    timestamp: float  # epoch seconds

    # Synthetic helpers
    @property
    def is_success(self) -> bool:
        return self.completed


@dataclass
class PerformanceSnapshot:
    """Aggregated user performance persisted to DB."""
    user_id: str
    quests_completed: int = 0
    quests_failed: int = 0
    total_duration_sec: float = 0.0
    difficulty_band: DifficultyBand = DifficultyBand.NORMAL
    last_updated: float = time.time()

    @property
    def success_ratio(self) -> float:
        attempts = self.quests_completed + self.quests_failed
        return 0.0 if attempts == 0 else self.quests_completed / attempts

    @property
    def avg_duration(self) -> float:
        attempts = self.quests_completed + self.quests_failed
        return 0.0 if attempts == 0 else self.total_duration_sec / attempts

    def compute_score(self) -> float:
        """
        Calculates a composite performance score.
        Score range: 0 (poor) -> 1 (excellent).
        We weigh success ratio 70% and inverse normalized duration 30%.
        """
        # Normalize duration by using an arbitrary max duration of 30 mins.
        NORMALIZATION_MAX = 30 * 60
        norm_duration = max(0.0, min(self.avg_duration / NORMALIZATION_MAX, 1.0))
        duration_score = 1.0 - norm_duration
        score = (self.success_ratio * 0.7) + (duration_score * 0.3)
        return round(score, 4)


# --------------------------------------------------------------------------- #
# Repository Abstraction
# --------------------------------------------------------------------------- #


class PerformanceRepository(Protocol):
    """Protocol for abstracting persistence."""

    def load(self, user_id: str) -> PerformanceSnapshot:
        ...

    def save(self, snapshot: PerformanceSnapshot) -> None:
        ...


class SQLitePerformanceRepository:
    """SQLite-based repository implementation."""

    _DDL = """
    CREATE TABLE IF NOT EXISTS performance (
        user_id TEXT PRIMARY KEY,
        quests_completed INTEGER NOT NULL,
        quests_failed INTEGER NOT NULL,
        total_duration_sec REAL NOT NULL,
        difficulty_band TEXT NOT NULL,
        last_updated REAL NOT NULL
    );
    """

    def __init__(self, db_path: Path):
        self._db_path = db_path
        self._conn_lock = threading.Lock()
        self._ensure_schema()

    @contextmanager
    def _cursor(self) -> Any:
        with self._conn_lock:
            conn = sqlite3.connect(self._db_path)
            try:
                yield conn.cursor()
                conn.commit()
            finally:
                conn.close()

    def _ensure_schema(self) -> None:
        with self._cursor() as cur:
            cur.execute(self._DDL)

    # --- Repository API --------------------------------------------------- #

    def load(self, user_id: str) -> PerformanceSnapshot:
        with self._cursor() as cur:
            cur.execute("SELECT * FROM performance WHERE user_id = ?", (user_id,))
            row = cur.fetchone()
            if not row:
                LOGGER.debug("No snapshot found for user %s; returning empty snapshot.", user_id)
                return PerformanceSnapshot(user_id=user_id)

            return PerformanceSnapshot(
                user_id=row[0],
                quests_completed=row[1],
                quests_failed=row[2],
                total_duration_sec=row[3],
                difficulty_band=DifficultyBand[row[4]],
                last_updated=row[5]
            )

    def save(self, snapshot: PerformanceSnapshot) -> None:
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO performance (user_id, quests_completed, quests_failed,
                                         total_duration_sec, difficulty_band, last_updated)
                VALUES (:user_id, :quests_completed, :quests_failed,
                        :total_duration_sec, :difficulty_band, :last_updated)
                ON CONFLICT(user_id) DO UPDATE SET
                    quests_completed=excluded.quests_completed,
                    quests_failed=excluded.quests_failed,
                    total_duration_sec=excluded.total_duration_sec,
                    difficulty_band=excluded.difficulty_band,
                    last_updated=excluded.last_updated;
                """,
                {
                    **asdict(snapshot),
                    "difficulty_band": snapshot.difficulty_band.name,
                    "last_updated": time.time()
                }
            )


# --------------------------------------------------------------------------- #
# Event Bus (simplified Observer Pattern)
# --------------------------------------------------------------------------- #


class EventBus:
    """A minimal, thread-safe event bus."""

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[[Any], None]]] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_type: str, handler: Callable[[Any], None]) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)
            LOGGER.debug("Handler %s subscribed to %s.", handler.__qualname__, event_type)

    def emit(self, event_type: str, payload: Any) -> None:
        with self._lock:
            handlers = list(self._subscribers.get(event_type, []))
        for handler in handlers:
            try:
                handler(payload)
            except Exception:  # pylint: disable=broad-except
                LOGGER.exception("Error while handling %s event by %s.", event_type, handler)


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine
# --------------------------------------------------------------------------- #


class AdaptiveDifficultyEngine:
    """
    The ADE observes quest events and recalculates difficulty bands in real-time.

    Usage:
        repository = SQLitePerformanceRepository(Path("/data/user_0/.../questsmith.db"))
        bus = EventBus()
        ade = AdaptiveDifficultyEngine(bus, repository)
        ade.start()      # non-blocking, registers internal handlers
    """

    WINDOW_SIZE = 20  # # of recent quests to use for moving average

    def __init__(self, bus: EventBus, repo: PerformanceRepository):
        self._bus = bus
        self._repo = repo
        self._windows: Dict[str, Deque[QuestEvent]] = {}
        self._lock = threading.RLock()
        self._running = False

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """Start listening to quest events."""
        if self._running:
            return

        self._bus.subscribe("QuestCompleted", self._handle_quest_event)
        self._bus.subscribe("QuestFailed", self._handle_quest_event)
        self._running = True
        LOGGER.info("AdaptiveDifficultyEngine started.")

    # ------------------------------------------------------------------ #
    # Event Handling
    # ------------------------------------------------------------------ #

    def _handle_quest_event(self, event: QuestEvent) -> None:
        """Central handler for quest outcome events."""
        with self._lock:
            window = self._windows.setdefault(event.user_id, deque(maxlen=self.WINDOW_SIZE))
            window.append(event)
            LOGGER.debug("Event appended to window: %s", event)

        # Perform update in a separate thread to keep bus responsive
        threading.Thread(
            target=self._recompute_difficulty,
            args=(event.user_id,),
            daemon=True,
        ).start()

    # ------------------------------------------------------------------ #
    # Internal worker
    # ------------------------------------------------------------------ #

    def _recompute_difficulty(self, user_id: str) -> None:
        time.sleep(0.05)  # slight debounce for burst events
        with self._lock:
            window = list(self._windows.get(user_id, []))

        if not window:
            return

        completed = sum(1 for e in window if e.is_success)
        failed = len(window) - completed
        total_duration = sum(e.duration_seconds for e in window)

        snapshot = self._repo.load(user_id)
        snapshot.quests_completed += completed
        snapshot.quests_failed += failed
        snapshot.total_duration_sec += total_duration

        score = snapshot.compute_score()
        new_band = DifficultyBand.from_score(score)

        if new_band != snapshot.difficulty_band:
            LOGGER.info(
                "User %s difficulty adjusted: %s -> %s (score=%.3f)",
                user_id,
                snapshot.difficulty_band.name,
                new_band.name,
                score,
            )
            snapshot.difficulty_band = new_band
            # Notify interested parties
            self._bus.emit(
                "DifficultyChanged",
                {"user_id": user_id, "difficulty": new_band, "score": score},
            )

        snapshot.last_updated = time.time()

        try:
            self._repo.save(snapshot)
            LOGGER.debug("Snapshot persisted for user %s.", user_id)
        except sqlite3.Error:
            LOGGER.exception("Failed to persist snapshot for user %s.", user_id)


# --------------------------------------------------------------------------- #
# Factory helper
# --------------------------------------------------------------------------- #


class AdaptiveDifficultyFactory:
    """Convenience factory for building ADE with default infra."""

    DEFAULT_DB_PATH = Path.home() / ".questsmith" / "questsmith.db"

    @classmethod
    def build(cls, bus: Optional[EventBus] = None,
              db_path: Optional[Path] = None) -> AdaptiveDifficultyEngine:
        bus = bus or EventBus()
        db_path = db_path or cls.DEFAULT_DB_PATH
        db_path.parent.mkdir(parents=True, exist_ok=True)
        repo = SQLitePerformanceRepository(db_path)
        ade = AdaptiveDifficultyEngine(bus, repo)
        ade.start()
        return ade


# --------------------------------------------------------------------------- #
# Example usage (will not run on import when used as part of the package)
# --------------------------------------------------------------------------- #

def _demo() -> None:  # pragma: no cover
    """
    Run a demo with synthetic events.
    Execute `python -m src.module_13` for a quick self-test.
    """
    bus = EventBus()
    ade = AdaptiveDifficultyFactory.build(bus)

    # Simulate events
    for i in range(40):
        event = QuestEvent(
            quest_id=f"q{i}",
            user_id="player_1",
            completed=(i % 4 != 0),  # 75% success rate
            duration_seconds=300 + (i * 5),  # Gradually increasing duration
            timestamp=time.time()
        )
        bus.emit("QuestCompleted" if event.completed else "QuestFailed", event)
        time.sleep(0.02)

    # Give the worker threads a moment to finish
    time.sleep(1)


if __name__ == "__main__":  # pragma: no cover
    _demo()
```