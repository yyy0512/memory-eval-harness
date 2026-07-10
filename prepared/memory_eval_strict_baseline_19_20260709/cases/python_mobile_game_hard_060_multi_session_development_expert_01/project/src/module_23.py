```python
"""
QuestSmith – Adaptive Difficulty Module
=======================================

This module houses the production–ready, self-contained implementation of the
adaptive–difficulty subsystem.  It observes quest-completion events, aggregates
player performance metrics, and persists a per-profile `DifficultyProfile`
inside the shared SQLite store (Repository Pattern).  The profile is later
consumed by the quest-generation engine so that future quests remain engaging
yet attainable.

Key Concepts
------------
1. Observer Pattern
   - `EventBus` distributes domain events (`QuestCompletedEvent`, …) to all
     interested subscribers without tight coupling.
2. Repository Pattern
   - `StatsRepository` abstracts SQLite I/O behind a thread-safe façade.
3. MVVM / Separation of Concerns
   - This module lives squarely in the *Model* layer; it has no Kivy imports or
     UI dependencies.
4. Mobile Constraints
   - All commits are batched and connection-agnostic; the database resides in
     `app_user_data_dir()` which maps to a sandboxed path on both Android & iOS.

The algorithm is intentionally simple but extensible: it computes exponentially
weighted moving averages of completion times and success rates, then maps those
to an integer difficulty tier.  The tier can later influence enemy HP, reward
scaling, time limits, etc., elsewhere in the codebase.

Author: QuestSmith Engineering
"""

from __future__ import annotations

import contextlib
import logging
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger("questsmith.adaptive_difficulty")
logger.setLevel(logging.INFO)

# Add a NullHandler by default to avoid "No handler found" warnings in host app
logger.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Domain Models
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class QuestCompletedEvent:
    """
    Domain event published once a quest is finalized.

    Parameters
    ----------
    user_id:
        Primary key of the currently authenticated player.
    quest_id:
        UUID of the quest in question.
    success:
        Whether the quest was completed successfully.  A quest can *fail* when
        expired/time-boxed or manually canceled by the user.
    completion_time_sec:
        Seconds between quest activation (start) and finalization.
    timestamp:
        Unix epoch seconds at which the event was emitted.
    """
    user_id: str
    quest_id: str
    success: bool
    completion_time_sec: Optional[float]
    timestamp: float = time.time()


@dataclass(slots=True)
class DifficultyProfile:
    """
    Persisted adaptive-difficulty profile for a single player.

    Notes
    -----
    • EWMA (exponentially weighted moving average) is used so that recent
      behaviour has more impact than older history.

    Attributes
    ----------
    user_id:
        Identifier for the owning player.
    ewma_completion_time:
        Smoothed average of completion durations (seconds).
    ewma_success_rate:
        Probability (0–1) that a quest is successfully completed.
    tier:
        Discrete difficulty bucket [1–5] where 1 = easiest and 5 = hardest.
    updated_at:
        Unix epoch seconds of last modification.
    """
    user_id: str
    ewma_completion_time: float = 0.0
    ewma_success_rate: float = 1.0
    tier: int = 1
    updated_at: float = time.time()


# --------------------------------------------------------------------------- #
# Infrastructure: Lightweight Event Bus
# --------------------------------------------------------------------------- #

class EventBus:
    """
    Thread-safe, minimalistic event bus suitable for a mobile-first monolith.

    Other packages can replace this bus via Factory injection, but we provide a
    local fallback that’s ‘good enough’ for offline functionality and unit
    tests.
    """

    def __init__(self) -> None:
        self._subscribers: dict[type, list[Callable]] = {}
        self._lock = threading.Lock()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: type, handler: Callable) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)
            logger.debug("Subscribed %s to %s", handler, event_type)

    def publish(self, event: object) -> None:
        handlers = []
        with self._lock:
            handlers = list(self._subscribers.get(type(event), []))

        logger.debug("Publishing %s to %d handler(s)", type(event).__name__, len(handlers))
        for handler in handlers:
            try:
                handler(event)
            except Exception as exc:
                # Fail-safe: never let the event loop crash the main thread
                logger.exception("Unhandled exception while processing %s: %s", event, exc)


# --------------------------------------------------------------------------- #
# Repository Pattern – SQLite Wrapper
# --------------------------------------------------------------------------- #

class StatsRepository:
    """
    Thread-safe SQLite repository that stores performance statistics and
    difficulty tiers for each player profile.
    """

    DB_FILENAME = "questsmith.db"
    _INIT_SQL = """
    CREATE TABLE IF NOT EXISTS difficulty_profile (
        user_id                TEXT PRIMARY KEY,
        ewma_completion_time   REAL NOT NULL,
        ewma_success_rate      REAL NOT NULL,
        tier                   INTEGER NOT NULL,
        updated_at             REAL NOT NULL
    );
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self._db_path = db_path or self._default_db_path()
        self._conn_lock = threading.Lock()
        self._ensure_schema()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def fetch_profile(self, user_id: str) -> DifficultyProfile:
        """
        Retrieve the difficulty profile for the specified user.  If none exists,
        a default entry is lazily created (tier=1).
        """
        with self._cursor() as cur:
            cur.execute("SELECT * FROM difficulty_profile WHERE user_id = ?;", (user_id,))
            row = cur.fetchone()

            if row:
                profile = DifficultyProfile(
                    user_id=row["user_id"],
                    ewma_completion_time=row["ewma_completion_time"],
                    ewma_success_rate=row["ewma_success_rate"],
                    tier=row["tier"],
                    updated_at=row["updated_at"]
                )
            else:
                logger.info("No difficulty profile found for user '%s'; initializing defaults.", user_id)
                profile = DifficultyProfile(user_id=user_id)
                self.save_profile(profile)

            return profile

    def save_profile(self, profile: DifficultyProfile) -> None:
        """
        Insert or replace the provided DifficultyProfile.
        """
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO difficulty_profile (
                    user_id, ewma_completion_time, ewma_success_rate, tier, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    ewma_completion_time = excluded.ewma_completion_time,
                    ewma_success_rate   = excluded.ewma_success_rate,
                    tier                = excluded.tier,
                    updated_at          = excluded.updated_at;
                """,
                (
                    profile.user_id,
                    profile.ewma_completion_time,
                    profile.ewma_success_rate,
                    profile.tier,
                    profile.updated_at,
                ),
            )

    # --------------------------------------------------------------------- #
    # Internal Helpers
    # --------------------------------------------------------------------- #

    @staticmethod
    def _default_db_path() -> Path:
        """
        Determine a cross-platform SQLite location inside the app-specific
        sandbox (the function `app_user_data_dir` is hypothetical but could map
        to `kivy.utils.platform` resolution or `appdirs`).
        """
        try:
            from kivy.utils import platform  # type: ignore
            if platform in ("android", "ios"):
                # Mobile: Use user_data_dir retrieved from Kivy App
                from kivy.app import App  # type: ignore
                return Path(App.get_running_app().user_data_dir) / StatsRepository.DB_FILENAME
        except Exception:  # pragma: no cover
            pass

        # Fallback: use home directory for desktop / unit-tests
        return Path.home() / ".questsmith" / StatsRepository.DB_FILENAME

    def _ensure_schema(self) -> None:
        with self._cursor() as cur:
            cur.executescript(self._INIT_SQL)
            logger.debug("SQLite schema ensured/created.")

    @contextlib.contextmanager
    def _cursor(self) -> sqlite3.Cursor:
        """
        Context manager yielding a SQLite cursor with row factory enabled,
        wrapped in a re-entrant lock for thread-safety.
        """
        with self._conn_lock:
            conn = sqlite3.connect(
                self._db_path, check_same_thread=False, isolation_level=None  # autocommit
            )
            conn.row_factory = sqlite3.Row
            try:
                cur = conn.cursor()
                yield cur
            finally:
                cur.close()
                conn.close()


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine
# --------------------------------------------------------------------------- #

class AdaptiveDifficultyEngine:
    """
    Consumes quest completion events and maintains a persistent difficulty
    profile per user.

    Parameters
    ----------
    event_bus:
        Instance implementing `publish` / `subscribe`.
    stats_repo:
        Persistence repository.  If omitted, a default SQLite repository is
        instantiated.
    alpha_time:
        Smoothing constant for EWMA of completion time           (0 < α ≤ 1).
    alpha_success:
        Smoothing constant for EWMA of success rate              (0 < α ≤ 1).
    """

    _MIN_COMPLETION_TIME_SEC = 60.0   # 1 minute  -> floor for sensible stats
    _MAX_COMPLETION_TIME_SEC = 7200.0 # 2 hours   -> cap outlier impact

    def __init__(
        self,
        event_bus: EventBus,
        stats_repo: Optional[StatsRepository] = None,
        *,
        alpha_time: float = 0.2,
        alpha_success: float = 0.1,
    ) -> None:
        self._bus = event_bus
        self._repo = stats_repo or StatsRepository()
        self._alpha_t = alpha_time
        self._alpha_s = alpha_success
        self._bus.subscribe(QuestCompletedEvent, self._on_quest_completed)
        logger.info("AdaptiveDifficultyEngine initialized with α_time=%s, α_success=%s", alpha_time, alpha_success)

    # --------------------------------------------------------------------- #
    # Event Processing
    # --------------------------------------------------------------------- #

    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        logger.debug("Processing QuestCompletedEvent: %s", event)

        profile = self._repo.fetch_profile(event.user_id)
        now = time.time()

        # Update EWMA for completion time if success AND value is provided
        if event.success and event.completion_time_sec is not None:
            clamped_time = min(max(event.completion_time_sec, self._MIN_COMPLETION_TIME_SEC),
                               self._MAX_COMPLETION_TIME_SEC)
            profile.ewma_completion_time = self._ewma(
                previous=profile.ewma_completion_time or clamped_time,  # boot-strap
                new_value=clamped_time,
                alpha=self._alpha_t,
            )

        # Update EWMA for success probability
        success_numeric = 1.0 if event.success else 0.0
        profile.ewma_success_rate = self._ewma(
            previous=profile.ewma_success_rate,
            new_value=success_numeric,
            alpha=self._alpha_s,
        )

        # Re-assess difficulty tier
        new_tier = self._compute_difficulty_tier(
            avg_time=profile.ewma_completion_time,
            success_rate=profile.ewma_success_rate,
        )
        if new_tier != profile.tier:
            logger.info("Difficulty tier updated for user %s: %s → %s", event.user_id, profile.tier, new_tier)
            profile.tier = new_tier

        profile.updated_at = now
        self._repo.save_profile(profile)

    # --------------------------------------------------------------------- #
    # Static Helpers
    # --------------------------------------------------------------------- #

    @staticmethod
    def _ewma(*, previous: float, new_value: float, alpha: float) -> float:
        """
        Exponentially Weighted Moving Average computation.
        """
        return alpha * new_value + (1.0 - alpha) * previous

    @staticmethod
    def _compute_difficulty_tier(*, avg_time: float, success_rate: float) -> int:
        """
        Map performance metrics to a discrete tier.

        Heuristics
        ----------
        1. High success + low time    → increase tier
        2. Low success + high time    → decrease tier
        3. Else                       → keep tier
        """
        # Define thresholds (could be configured via remote feature flags)
        if success_rate > 0.9 and avg_time < 300:
            return 5
        if success_rate > 0.8 and avg_time < 600:
            return 4
        if success_rate < 0.4 or avg_time > 3600:
            return 1
        if success_rate < 0.6 or avg_time > 1800:
            return 2
        return 3


# --------------------------------------------------------------------------- #
# Optional Convenience API
# --------------------------------------------------------------------------- #

_default_bus: Optional[EventBus] = None
_default_engine: Optional[AdaptiveDifficultyEngine] = None


def init_default_engine() -> AdaptiveDifficultyEngine:
    """
    Bootstraps a singleton instance of both EventBus and AdaptiveDifficultyEngine.
    This is useful for scripts or unit-tests that don’t rely on the full
    dependency-injection stack of the mobile app.
    """
    global _default_bus, _default_engine

    if _default_engine is None:
        _default_bus = EventBus()
        _default_engine = AdaptiveDifficultyEngine(_default_bus)

    return _default_engine


# --------------------------------------------------------------------------- #
# Stand-alone Debug Harness (executed only when run as script)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    engine = init_default_engine()
    bus = _default_bus  # type: ignore

    # Simulate quests for demonstration
    user = "debug-user-123"
    for idx in range(10):
        fake_event = QuestCompletedEvent(
            user_id=user,
            quest_id=f"quest-{idx}",
            success=True if idx % 2 else False,
            completion_time_sec=1200 - idx * 50,  # Gradually faster
        )
        bus.publish(fake_event)
        profile = engine._repo.fetch_profile(user)
        logger.debug("Current profile: %s", profile)
```