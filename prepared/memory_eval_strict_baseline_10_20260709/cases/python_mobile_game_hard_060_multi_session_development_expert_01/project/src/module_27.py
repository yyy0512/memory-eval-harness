```python
"""
QuestSmith – Productivity RPG Forge
===================================

src/module_27.py
----------------
Adaptive difficulty & analytics engine.

This module listens to quest–related events and continuously tunes
difficulty multipliers so that users stay in the ‘flow channel’
(not too easy, not too hard).  It follows MVVM-friendly principles by
exposing an observable `DifficultyViewModel` that UI components can
bind to, while persisting state through the repository layer so tuning
survives application restarts and can be shared across devices.

Patterns used
-------------
* Repository Pattern          – decouples persistence/storage
* Observer  Pattern (EventBus)– propagates quest events
* Factory   Pattern           – resolves concrete repository
* MVVM                          exposed ViewModel
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable, Dict, List, Protocol, TypeVar

# --------------------------------------------------------------------------- #
#                                  Logging                                    #
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
if not logger.handlers:
    # When embedded inside Kivy the root handler is already configured,
    # but we still add our own for stand-alone tests.
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("[%(levelname)s] %(name)s: %(message)s")
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
#                               Event Bus (Observer)                          #
# --------------------------------------------------------------------------- #

T = TypeVar("T")


class EventType(str, Enum):
    """
    A minimal set of events required by this module.
    """
    QUEST_COMPLETED = "quest_completed"
    QUEST_FAILED = "quest_failed"
    APP_FOREGROUND = "app_foreground"
    CRASH_REPORTED = "crash_reported"


class EventBus:
    """
    Thread-safe publish/subscribe event bus.
    """

    _subscribers: Dict[EventType, List[Callable[[T], None]]]

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers = {}

    def subscribe(self, event_type: EventType, callback: Callable[[T], None]) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(callback)
            logger.debug("Subscriber added to %s: %s", event_type, callback)

    def publish(self, event_type: EventType, payload: T) -> None:
        with self._lock:
            callbacks = list(self._subscribers.get(event_type, []))
        logger.debug(
            "Publishing %s to %s subscriber(s)", event_type, len(callbacks)
        )
        for cb in callbacks:
            try:
                cb(payload)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception(
                    "Unhandled exception in event subscriber %s: %s", cb, exc
                )


# --------------------------------------------------------------------------- #
#                         Domain & Persistence Models                         #
# --------------------------------------------------------------------------- #

class DifficultyTier(Enum):
    CASUAL = auto()
    BALANCED = auto()
    CHALLENGING = auto()
    HARDCORE = auto()


@dataclass
class DifficultySettings:
    """
    User-specific difficulty parameters.
    """
    tier: DifficultyTier = DifficultyTier.BALANCED
    multiplier_xp: float = 1.0   # XP earned
    multiplier_loot: float = 1.0 # Loot drop rate
    multiplier_time: float = 1.0 # Deadline/timer scaling
    last_updated: float = field(
        default_factory=lambda: time.time()
    )  # Unix epoch


# --------------------------------------------------------------------------- #
#                        Repository ‑ Abstract Protocol                       #
# --------------------------------------------------------------------------- #

class DifficultyRepository(Protocol):
    """
    Abstract repository definition used by the engine.
    """

    def load(self, user_id: str) -> DifficultySettings:
        ...

    def save(self, user_id: str, settings: DifficultySettings) -> None:
        ...


# --------------------------------------------------------------------------- #
#                         SQLite Repository Implementation                    #
# --------------------------------------------------------------------------- #

_SQL_INIT = """
CREATE TABLE IF NOT EXISTS user_difficulty (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    multiplier_xp REAL NOT NULL,
    multiplier_loot REAL NOT NULL,
    multiplier_time REAL NOT NULL,
    last_updated REAL NOT NULL
);
"""


class SQLiteDifficultyRepository:
    """
    Concrete repository implementing storage with SQLite.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        self._ensure_schema()

    # --------------------------- Private helpers --------------------------- #

    def _ensure_schema(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(_SQL_INIT)
            logger.debug("Difficulty schema ensured.")

    def _get_conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self._db_path)

    # ------------------------ Repository interface ------------------------- #

    def load(self, user_id: str) -> DifficultySettings:
        logger.debug("Loading difficulty for user %s.", user_id)
        with self._lock, self._get_conn() as conn:
            cur = conn.execute(
                "SELECT tier, multiplier_xp, multiplier_loot, "
                "multiplier_time, last_updated "
                "FROM user_difficulty WHERE user_id = ?",
                (user_id,),
            )
            row = cur.fetchone()
            if row:
                settings = DifficultySettings(
                    tier=DifficultyTier[row[0]],
                    multiplier_xp=row[1],
                    multiplier_loot=row[2],
                    multiplier_time=row[3],
                    last_updated=row[4],
                )
                logger.debug("Loaded settings: %s", settings)
                return settings
            logger.debug("No settings found for user %s, returning default.", user_id)
            return DifficultySettings()

    def save(self, user_id: str, settings: DifficultySettings) -> None:
        logger.debug("Saving difficulty for user %s: %s", user_id, settings)
        with self._lock, self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO user_difficulty
                    (user_id, tier, multiplier_xp, multiplier_loot,
                     multiplier_time, last_updated)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    tier            = excluded.tier,
                    multiplier_xp   = excluded.multiplier_xp,
                    multiplier_loot = excluded.multiplier_loot,
                    multiplier_time = excluded.multiplier_time,
                    last_updated    = excluded.last_updated
                """,
                (
                    user_id,
                    settings.tier.name,
                    settings.multiplier_xp,
                    settings.multiplier_loot,
                    settings.multiplier_time,
                    settings.last_updated,
                ),
            )
            conn.commit()
            logger.debug("Difficulty saved.")


# --------------------------------------------------------------------------- #
#                         Difficulty View-Model (MVVM)                        #
# --------------------------------------------------------------------------- #

class DifficultyViewModel:
    """
    Observable view model exposing current difficulty to the UI layer.
    """

    def __init__(self, initial: DifficultySettings) -> None:
        self._settings = initial
        self._observers: List[Callable[[DifficultySettings], None]] = []
        self._lock = threading.RLock()

    # ----------------------------- Properties ------------------------------ #

    @property
    def settings(self) -> DifficultySettings:
        with self._lock:
            return self._settings

    # -------------------------- Public interface --------------------------- #

    def subscribe(self, cb: Callable[[DifficultySettings], None]) -> None:
        """
        Attach a new observer that will be called whenever difficulty changes.
        """
        with self._lock:
            self._observers.append(cb)

    def _notify(self) -> None:
        with self._lock:
            observers = list(self._observers)
            settings_snapshot = self._settings
        logger.debug("Notifying %d UI observers.", len(observers))
        for cb in observers:
            try:
                cb(settings_snapshot)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Uncaught exception in UI observer.")

    def update(self, new_settings: DifficultySettings) -> None:
        """
        Replace current settings and notify observers.
        """
        with self._lock:
            self._settings = new_settings
        self._notify()


# --------------------------------------------------------------------------- #
#                    Adaptive Difficulty & Analytics Engine                   #
# --------------------------------------------------------------------------- #

class AdaptiveDifficultyEngine:
    """
    Core adaptation algorithm.  Consumes EventBus and Repository,
    exposes a ViewModel for UI, and writes back data through repository.
    """

    # Constants fine-tuned via offline Monte-Carlo simulations.
    _XP_THRESHOLD = 500          # xp per hour considered ‘fast’
    _FAIL_RATE_THR = 0.3         # 30 % quests failed means too hard
    _TIME_WINDOW   = 3600 * 24   # one day history length

    def __init__(
        self,
        user_id: str,
        event_bus: EventBus,
        repo_factory: Callable[[], DifficultyRepository],
    ) -> None:
        self._user_id = user_id
        self._event_bus = event_bus
        self._repo: DifficultyRepository = repo_factory()
        self._vm = DifficultyViewModel(self._repo.load(user_id))

        # Stats collected in-memory & flushed periodically.
        self._xp_earned: float = 0.0
        self._quests_completed: int = 0
        self._quests_failed: int = 0
        self._stats_lock = threading.RLock()

        # Subscribe to events.
        self._event_bus.subscribe(
            EventType.QUEST_COMPLETED, self._on_quest_completed
        )
        self._event_bus.subscribe(
            EventType.QUEST_FAILED, self._on_quest_failed
        )
        self._event_bus.subscribe(
            EventType.APP_FOREGROUND, self._on_app_foreground
        )
        # Crash events reset difficulty to BALANCED (prevent frustration)
        self._event_bus.subscribe(
            EventType.CRASH_REPORTED, self._on_crash_reported
        )

        logger.info("AdaptiveDifficultyEngine initialized for user %s.", user_id)

    # ----------------------------- Event handlers -------------------------- #

    def _on_quest_completed(self, payload: Dict[str, float]) -> None:
        """
        Payload expected: {"xp": float}
        """
        xp = float(payload.get("xp", 0))
        with self._stats_lock:
            self._xp_earned += xp
            self._quests_completed += 1
        logger.debug("Quest completed (+%s XP).", xp)
        self._evaluate_if_needed()

    def _on_quest_failed(self, _payload: Dict) -> None:
        with self._stats_lock:
            self._quests_failed += 1
        logger.debug("Quest failed.")
        self._evaluate_if_needed()

    def _on_app_foreground(self, _payload: None) -> None:
        """
        When the app returns to foreground, flush cached stats immediately
        so that widgets show up-to-date information.
        """
        logger.debug("App foregrounded. Forcing evaluation.")
        self._evaluate(forced=True)

    def _on_crash_reported(self, _payload: Dict) -> None:
        """
        Set difficulty back to balanced after a crash to reduce churn.
        """
        logger.warning("Crash reported. Resetting difficulty to BALANCED.")
        balanced = DifficultySettings()
        self._persist_and_broadcast(balanced)

    # ---------------------------- Core evaluation -------------------------- #

    def _evaluate_if_needed(self) -> None:
        """
        Only evaluate once in a while to avoid CPU & DB spamming.
        """
        with self._stats_lock:
            if (
                self._quests_completed + self._quests_failed
            ) % 5 == 0:  # every 5 quests
                logger.debug("Stat threshold reached. Evaluating.")
                self._evaluate()

    def _evaluate(self, forced: bool = False) -> None:
        now = time.time()

        with self._stats_lock:
            total_quests = self._quests_completed + self._quests_failed
            fail_rate = (
                self._quests_failed / total_quests
                if total_quests > 0
                else 0
            )
            xp_per_hour = (
                self._xp_earned / ((self._TIME_WINDOW) / 3600)
            )

            # Reset accumulators to keep sliding window effect
            self._xp_earned = 0
            self._quests_completed = 0
            self._quests_failed = 0

        settings = self._vm.settings  # current snapshot

        logger.debug(
            "Evaluating difficulty (fail_rate=%.2f, xp/h=%.2f).", fail_rate, xp_per_hour
        )

        updated = DifficultySettings(
            tier=settings.tier,
            multiplier_xp=settings.multiplier_xp,
            multiplier_loot=settings.multiplier_loot,
            multiplier_time=settings.multiplier_time,
        )

        # Simplistic adaptive algorithm
        if fail_rate > self._FAIL_RATE_THR:
            updated = self._decrease_difficulty(settings)
        elif xp_per_hour > self._XP_THRESHOLD:
            updated = self._increase_difficulty(settings)
        elif forced:
            # Re-broadcast current settings so UI can refresh.
            logger.debug("Forced evaluation with no change requested.")

        # Any changes?
        if updated != settings or forced:
            updated.last_updated = now
            self._persist_and_broadcast(updated)

    # --------------------------- Difficulty mutations ---------------------- #

    def _increase_difficulty(
        self, settings: DifficultySettings
    ) -> DifficultySettings:
        logger.info("Player over-performing. Increasing difficulty.")

        if settings.tier == DifficultyTier.HARDCORE:
            logger.debug("Already at maximum difficulty.")
            return settings

        new_tier = DifficultyTier(settings.tier.value + 1)
        return DifficultySettings(
            tier=new_tier,
            multiplier_xp=settings.multiplier_xp * 1.2,
            multiplier_loot=settings.multiplier_loot * 0.9,
            multiplier_time=settings.multiplier_time * 0.9,
        )

    def _decrease_difficulty(
        self, settings: DifficultySettings
    ) -> DifficultySettings:
        logger.info("Player struggling. Decreasing difficulty.")

        if settings.tier == DifficultyTier.CASUAL:
            logger.debug("Already at minimum difficulty.")
            return settings

        new_tier = DifficultyTier(settings.tier.value - 1)
        return DifficultySettings(
            tier=new_tier,
            multiplier_xp=settings.multiplier_xp * 0.8,
            multiplier_loot=settings.multiplier_loot * 1.1,
            multiplier_time=settings.multiplier_time * 1.1,
        )

    # ---------------------------- Persistence + UI ------------------------ #

    def _persist_and_broadcast(self, settings: DifficultySettings) -> None:
        logger.debug("Persisting & broadcasting new difficulty: %s", settings)
        try:
            self._repo.save(self._user_id, settings)
            self._vm.update(settings)
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to persist difficulty settings.")

    # -------------------------- Public accessors --------------------------- #

    @property
    def view_model(self) -> DifficultyViewModel:
        return self._vm


# --------------------------------------------------------------------------- #
#                            Factory helper (Adapter)                         #
# --------------------------------------------------------------------------- #

def build_sqlite_difficulty_repo() -> DifficultyRepository:
    """
    Factory function injected throughout the codebase.
    Putting it here avoids circular imports.
    """
    app_dir = Path.home() / ".questsmith"
    app_dir.mkdir(exist_ok=True)
    db_path = app_dir / "questsmith.db"
    return SQLiteDifficultyRepository(db_path)


# --------------------------------------------------------------------------- #
#                           Example standalone usage                          #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    """
    Run `python src/module_27.py` for a quick smoke test of the engine.
    """
    bus = EventBus()
    engine = AdaptiveDifficultyEngine(
        "debug_user",
        bus,
        repo_factory=build_sqlite_difficulty_repo,
    )

    def print_ui(settings: DifficultySettings) -> None:
        logger.info("UI receives new difficulty: %s", settings)

    engine.view_model.subscribe(print_ui)

    # Simulate game events
    for _ in range(8):
        bus.publish(EventType.QUEST_COMPLETED, {"xp": 150})
    for _ in range(3):
        bus.publish(EventType.QUEST_FAILED, {})

    bus.publish(EventType.APP_FOREGROUND, None)
    bus.publish(EventType.CRASH_REPORTED, {})
```