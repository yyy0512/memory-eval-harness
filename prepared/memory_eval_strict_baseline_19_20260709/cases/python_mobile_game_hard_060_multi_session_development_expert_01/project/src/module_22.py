```python
"""
QuestSmith – Adaptive Difficulty & Event-Driven Analytics Module
================================================================
File: src/module_22.py
Author: QuestSmith Engineering Team
Copyright © 2024

This module implements a lightweight, but production-ready, Adaptive
Difficulty Manager that continuously tunes the game balance based on the
player’s recent performance.  It observes Quest-related events broadcast
via the global `EventBus`, applies an EWMA (Exponential Weighted Moving
Average) model, persists the tuning state through a Repository
abstraction backed by SQLite, and publishes difficulty change events so
that the UI, reward calculator, and analytics pipeline can react in real
time.

Architectural touch points
--------------------------
• Observer Pattern  – `EventBus` (reactive quest event propagation)
• Repository Pattern – `SQLiteSettingsRepository`
• Factory Pattern   – `RepositoryFactory`, `CrashReporterFactory`
• MVVM Friendly     – Pure-python, UI agnostic, side-effect free (except
                      for repository I/O and event publishing)
• Adapter Pattern   – A thin Crash-reporting adapter is provided so that
                      the core logic does not depend on a concrete
                      third-party crash SDK.

Usage
-----
>>> bus = EventBus.get_global()
>>> adm = AdaptiveDifficultyManager(event_bus=bus)
>>> adm.start()       # begin listening to quest events
>>> bus.publish(QuestEvent(QuestEvent.Type.COMPLETED, quest_id=42,
...                        expected_duration=900, actual_duration=750))
"""

from __future__ import annotations

import enum
import logging
import sqlite3
import threading
import time
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Protocol

###############################################################################
# Logging configuration
###############################################################################

logger = logging.getLogger("questsmith.adaptive_difficulty")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
)
logger.addHandler(_handler)

###############################################################################
# Event bus — Observable, thread-safe, memory-leak resilient
###############################################################################


class Subscriber(Protocol):
    """Callable signature for event subscribers."""

    def __call__(self, event: "BaseEvent") -> None: ...


class EventBus:
    """
    A minimal, but thread-safe event bus with weak-ref subscribers.

    This bus is intentionally *very* light-weight so that it remains fast
    and easily embeddable in Kivy scheduling loops.
    """

    _GLOBAL: "EventBus | None" = None
    _lock = threading.RLock()

    def __init__(self) -> None:
        self._subscribers: Dict[type, List[weakref.ReferenceType[Subscriber]]] = {}

    # --------------------------------------------------------------------- #
    # Singleton helpers
    # --------------------------------------------------------------------- #
    @classmethod
    def get_global(cls) -> "EventBus":
        with cls._lock:
            if cls._GLOBAL is None:
                cls._GLOBAL = cls()
            return cls._GLOBAL

    # --------------------------------------------------------------------- #
    # Subscription handling
    # --------------------------------------------------------------------- #
    def subscribe(self, event_cls: type, listener: Subscriber) -> None:
        """
        Subscribe *listener* to events of type *event_cls* (or its
        subclass).  Duplicate subscriptions are ignored.
        """
        with self._lock:
            refs = self._subscribers.setdefault(event_cls, [])
            # Avoid duplicate registrations
            if any(r() is listener for r in refs):
                return
            refs.append(weakref.ref(listener))
            logger.debug("Listener %s subscribed to %s", listener, event_cls.__name__)

    def unsubscribe(self, event_cls: type, listener: Subscriber) -> None:
        with self._lock:
            refs = self._subscribers.get(event_cls)
            if not refs:
                return
            self._subscribers[event_cls] = [r for r in refs if r() is not listener]
            logger.debug("Listener %s unsubscribed from %s", listener, event_cls.__name__)

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #
    def publish(self, event: "BaseEvent") -> None:
        """
        Publish an event to all matching subscribers.  We walk the MRO so
        that subscribers of base classes also receive subclass events.
        """
        with self._lock:
            for cls in type(event).mro():
                refs = self._subscribers.get(cls, [])
                dead_refs: List[weakref.ReferenceType[Subscriber]] = []
                for ref in refs:
                    fn = ref()
                    if fn is None:
                        dead_refs.append(ref)
                        continue
                    try:
                        fn(event)
                    except Exception as exc:
                        # Forward to crash reporter if available
                        CrashReporterFactory.get().report_exception(exc)
                        logger.exception("Uncaught error in subscriber %s", fn)
                # Clean up GC’d subscribers
                for d in dead_refs:
                    refs.remove(d)


###############################################################################
# Crash-reporting adapter
###############################################################################


class CrashReporter(Protocol):
    """Public interface used by the app’s crash-reporting SDK adapter."""

    def report_exception(self, exc: BaseException) -> None: ...


class _NoOpCrashReporter:  # pylint: disable=too-few-public-methods
    """Fallback reporter used when no SDK is injected."""

    def report_exception(self, exc: BaseException) -> None:
        logger.error("CrashReporter unavailable; exception suppressed: %s", exc)


class CrashReporterFactory:
    """A simple provider so code can stay decoupled from the actual SDK."""

    _instance: CrashReporter | None = None

    @classmethod
    def init(cls, reporter: CrashReporter) -> None:
        cls._instance = reporter

    @classmethod
    def get(cls) -> CrashReporter:
        if cls._instance is None:
            cls._instance = _NoOpCrashReporter()
        return cls._instance


###############################################################################
# Domain events
###############################################################################


class BaseEvent:  # pylint: disable=too-few-public-methods
    """Marker base class so all events share a common ancestor."""


@dataclass(slots=True)
class QuestEvent(BaseEvent):
    """
    Emitted when a quest changes state.

    expected_duration and actual_duration are expressed in seconds.  They
    let the AdaptiveDifficultyManager reason about player efficiency.
    """

    class Type(enum.Enum):
        CREATED = "created"
        COMPLETED = "completed"
        FAILED = "failed"

    variant: "QuestEvent.Type"
    quest_id: int
    expected_duration: float | None = None
    actual_duration: float | None = None


@dataclass(slots=True)
class DifficultyChangedEvent(BaseEvent):
    """
    Published every time the AdaptiveDifficultyManager recalculates the
    difficulty multiplier.
    """

    new_multiplier: float
    previous_multiplier: float
    timestamp: float = time.time()


###############################################################################
# Repository layer
###############################################################################


class SettingsRepository(Protocol):
    """Storage abstraction for user/game settings needed by this module."""

    def get_difficulty_multiplier(self) -> float: ...

    def set_difficulty_multiplier(self, value: float) -> None: ...


class SQLiteSettingsRepository:  # pylint: disable=too-many-instance-attributes
    """
    SQLite-backed implementation of `SettingsRepository`.

    Expected schema (created automatically if missing):

        CREATE TABLE IF NOT EXISTS settings(
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """

    _CREATE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)"
    _UPSERT_SQL = "INSERT INTO settings(key,value) VALUES(?,?) " \
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    _SELECT_SQL = "SELECT value FROM settings WHERE key=?"

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = Path(db_path).expanduser().resolve()
        self._lock = threading.RLock()
        self._ensure_db()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def get_difficulty_multiplier(self) -> float:
        return float(self._get_or_default("difficulty_multiplier", default="1.0"))

    def set_difficulty_multiplier(self, value: float) -> None:
        self._set("difficulty_multiplier", str(value))

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    def _ensure_db(self) -> None:
        with self._connect() as conn:
            conn.execute(self._CREATE_TABLE_SQL)
            conn.commit()

    def _get_or_default(self, key: str, *, default: str) -> str:
        with self._connect() as conn:
            cur = conn.execute(self._SELECT_SQL, (key,))
            row = cur.fetchone()
            return row[0] if row else default

    def _set(self, key: str, value: str) -> None:
        with self._connect() as conn:
            conn.execute(self._UPSERT_SQL, (key, value))
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        # sqlite3 is threadsafe with `check_same_thread=False`
        return sqlite3.connect(self._db_path, check_same_thread=False)


class RepositoryFactory:
    """
    Factory that produces Repository instances, making testing easier and
    enabling dependency injection.
    """

    _settings_repo: SettingsRepository | None = None
    _lock = threading.Lock()

    @classmethod
    def init_sqlite_repository(cls, db_path: str | Path) -> None:
        with cls._lock:
            cls._settings_repo = SQLiteSettingsRepository(db_path)
            logger.info("SQLiteSettingsRepository initialised at %s", db_path)

    @classmethod
    def settings_repo(cls) -> SettingsRepository:
        if cls._settings_repo is None:
            raise RuntimeError("RepositoryFactory not initialised")
        return cls._settings_repo


###############################################################################
# Adaptive Difficulty Manager
###############################################################################


class AdaptiveDifficultyManager:  # pylint: disable=too-many-instance-attributes
    """
    Listens to quest outcome events and adaptively tunes difficulty.

    Algorithm overview
    ------------------
    We build a performance score *p* in the range [0,1] where 1 means the
    player always completes quests faster than expected, and 0 means the
    player never completes them.  After each quest (success or failure)
    we update *p* using an EWMA that favours recent progress:

        p_new = α·s + (1-α)·p_old

    where *s* is the success indicator:
        • success & quick completion  →  s = 1
        • success but overtime        →  s = 0.5
        • failure                     →  s = 0

    The difficulty multiplier *d* is computed as:

        d = clamp(0.5, 1.5, 1 + k · (0.5 - p_new))

    *k* is a scaling constant (default 1).  Hence:
        • when p_new → 1  ⇒ d ~ 0.5 (game gets harder)
        • when p_new → 0  ⇒ d ~ 1.5 (game gets easier)
    """

    _ALPHA = 0.3  # EWMA smoothing factor
    _K = 1.0      # Difficulty scaling factor
    _MIN_MULTIPLIER = 0.5
    _MAX_MULTIPLIER = 1.5

    def __init__(self, event_bus: EventBus | None = None) -> None:
        self._bus = event_bus or EventBus.get_global()
        self._settings = RepositoryFactory.settings_repo()
        self._lock = threading.RLock()

        # Cached state
        self._performance_score: float = 0.5  # neutral starting point
        self._current_multiplier: float = self._settings.get_difficulty_multiplier()

        # Lazily set when running
        self._is_running = False

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        with self._lock:
            if self._is_running:
                logger.debug("AdaptiveDifficultyManager already running")
                return
            self._bus.subscribe(QuestEvent, self._on_quest_event)
            self._is_running = True
            logger.info("AdaptiveDifficultyManager started")

    def stop(self) -> None:
        with self._lock:
            if not self._is_running:
                return
            self._bus.unsubscribe(QuestEvent, self._on_quest_event)
            self._is_running = False
            logger.info("AdaptiveDifficultyManager stopped")

    # ------------------------------------------------------------------ #
    # Event handler
    # ------------------------------------------------------------------ #
    def _on_quest_event(self, event: QuestEvent) -> None:
        logger.debug("Processing QuestEvent: %s", event)
        if event.variant is QuestEvent.Type.CREATED:
            return  # Difficulty not affected by quest creation

        try:
            new_score = self._update_performance_score(event)
            self._recalculate_multiplier(new_score)
        except Exception as exc:
            CrashReporterFactory.get().report_exception(exc)
            logger.exception("AdaptiveDifficultyManager failed to process event: %s", event)

    # ------------------------------------------------------------------ #
    # Core logic
    # ------------------------------------------------------------------ #
    def _update_performance_score(self, event: QuestEvent) -> float:
        """Return the updated performance score."""
        success_indicator = self._score_event(event)
        logger.debug("Success indicator: %.2f", success_indicator)

        with self._lock:
            old = self._performance_score
            new = self._ALPHA * success_indicator + (1 - self._ALPHA) * old
            self._performance_score = new
            logger.info("Performance score updated: %.3f → %.3f", old, new)
            return new

    def _recalculate_multiplier(self, performance_score: float) -> None:
        """Compute and publish new difficulty multiplier if necessary."""
        with self._lock:
            d = 1 + self._K * (0.5 - performance_score)
            d = max(self._MIN_MULTIPLIER, min(self._MAX_MULTIPLIER, d))
            if abs(d - self._current_multiplier) < 0.01:
                logger.debug("Multiplier change negligible; skipping publish")
                return  # No significant change

            prev = self._current_multiplier
            self._current_multiplier = d
            logger.info("Difficulty multiplier updated: %.3f → %.3f", prev, d)

            # Persist & notify
            self._settings.set_difficulty_multiplier(d)
            self._bus.publish(DifficultyChangedEvent(new_multiplier=d, previous_multiplier=prev))

    # ------------------------------------------------------------------ #
    # Scoring helpers
    # ------------------------------------------------------------------ #
    def _score_event(self, event: QuestEvent) -> float:
        if event.variant is QuestEvent.Type.COMPLETED:
            if (event.expected_duration and event.actual_duration and
                    event.actual_duration <= event.expected_duration):
                return 1.0  # Fast & successful
            return 0.5      # Successful but overtime
        return 0.0          # Failure

    # ------------------------------------------------------------------ #
    # External interface
    # ------------------------------------------------------------------ #
    @property
    def difficulty_multiplier(self) -> float:
        with self._lock:
            return self._current_multiplier

    @property
    def performance_score(self) -> float:
        with self._lock:
            return self._performance_score


###############################################################################
# Convenience initialiser — executed when module is imported from the app
###############################################################################

def _initialise_defaults() -> None:
    """
    Initialise singletons in a safe way so importing this module
    automatically wires the dependencies when the full app is running.

    In unit tests, callers may opt-out by setting the env-var
    `QUESTSMITH_DISABLE_AUTO_INIT`.
    """
    import os

    if os.getenv("QUESTSMITH_DISABLE_AUTO_INIT") == "1":
        return

    try:
        db_path = Path.home() / ".questsmith" / "questsmith.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        RepositoryFactory.init_sqlite_repository(db_path)
    except Exception as exc:  # pragma: no cover
        # On any DB failure we gracefully fallback to in-memory settings
        CrashReporterFactory.get().report_exception(exc)
        logger.exception("Falling back to in-memory repository due to error")
        RepositoryFactory._settings_repo = _InMemorySettingsRepository()  # type: ignore[attr-defined]

    # Start the AdaptiveDifficultyManager singleton
    adm = AdaptiveDifficultyManager()
    adm.start()


class _InMemorySettingsRepository:  # pylint: disable=too-few-public-methods
    """A minimal fallback repo used only if SQLite initialisation fails."""

    def __init__(self) -> None:
        self._storage: Dict[str, str] = {"difficulty_multiplier": "1.0"}
        self._lock = threading.Lock()

    def get_difficulty_multiplier(self) -> float:
        with self._lock:
            return float(self._storage["difficulty_multiplier"])

    def set_difficulty_multiplier(self, value: float) -> None:
        with self._lock:
            self._storage["difficulty_multiplier"] = str(value)


# Auto-init when the module is imported
_initialise_defaults()
```