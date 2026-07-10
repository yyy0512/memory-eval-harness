```python
"""
src/module_16.py

QuestSmith – Adaptive Difficulty Engine
---------------------------------------
This module encapsulates the game–logic layer responsible for analysing player
performance in near-real-time and dynamically tuning difficulty parameters
(e.g., enemy strength, time-limits, loot drop-rates).  It listens to quest life-
cycle events broadcast on the global event-bus and persists calibration meta-
data through the designated repository abstraction.

Architecture Patterns Involved
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
• Observer Pattern  – Subscribes to Quest* events.
• Repository Pattern – Reads/Writes adaptive data in SQLite via DAO facade.
• Factory Pattern   – Injects platform-specific push notification adapter.
• MVVM             – Exposes a read-only ViewModel for UI binding.

Note: This file purposefully avoids Kivy imports; it remains pure-Python so the
      domain logic is easily unit-testable outside the UI runtime.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque
from dataclasses import dataclass, field
from enum import Enum, auto
from statistics import mean
from typing import Deque, List, Protocol, runtime_checkable

# --------------------------------------------------------------------------- #
#  Logging Configuration                                                      #
# --------------------------------------------------------------------------- #
logger = logging.getLogger("questsmith.adaptive_difficulty")
logger.setLevel(logging.DEBUG)


# --------------------------------------------------------------------------- #
#  Event-Bus Abstractions (would normally live in a shared core package)      #
# --------------------------------------------------------------------------- #
class Event:
    """Base-class for all domain events."""
    pass


@dataclass(frozen=True)
class QuestCompletedEvent(Event):
    quest_id: int
    xp_gained: int
    timestamp: float


@dataclass(frozen=True)
class QuestFailedEvent(Event):
    quest_id: int
    timestamp: float


class EventBus:
    """
    Very light-weight synchronous event-bus.  The real implementation in the
    monolith provides thread-safe async dispatch – only the subset needed by
    this module is reproduced here to keep it self-contained.
    """

    def __init__(self) -> None:
        self._subscribers: dict[type[Event], List] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_type: type[Event], handler) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)
            logger.debug("Subscribed %s to %s", handler, event_type)

    def unsubscribe(self, event_type: type[Event], handler) -> None:
        with self._lock:
            try:
                self._subscribers[event_type].remove(handler)
            except (KeyError, ValueError):
                pass
            logger.debug("Unsubscribed %s from %s", handler, event_type)

    def publish(self, event: Event) -> None:
        handlers = list(self._subscribers.get(type(event), []))
        logger.debug("Publishing %s to %d handlers", event, len(handlers))
        for handler in handlers:
            try:
                handler(event)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Exception in event handler %s", handler)


GLOBAL_EVENT_BUS = EventBus()  # would be imported from a central place


# --------------------------------------------------------------------------- #
#  Repository Contracts                                                       #
# --------------------------------------------------------------------------- #
@runtime_checkable
class AdaptiveRepo(Protocol):
    """Persistence contract for difficulty calibration."""

    async def load_state(self, user_id: int) -> "DifficultyState":
        ...

    async def save_state(self, user_id: int, state: "DifficultyState") -> None:
        ...


# --------------------------------------------------------------------------- #
#  Notification Adapter Contract (Factory Pattern)                            #
# --------------------------------------------------------------------------- #
@runtime_checkable
class NotificationAdapter(Protocol):
    """Cross-platform notification push interface."""

    async def send_local_notification(self, title: str, body: str) -> None: ...


class NotificationFactory:
    """Obtains the platform-specific adapter chosen at runtime."""

    _adapter: NotificationAdapter | None = None

    @classmethod
    def register_adapter(cls, adapter: NotificationAdapter) -> None:
        cls._adapter = adapter
        logger.debug("Notification adapter %s registered", adapter)

    @classmethod
    def get_adapter(cls) -> NotificationAdapter | None:
        return cls._adapter


# --------------------------------------------------------------------------- #
#  Difficulty Domain Objects                                                  #
# --------------------------------------------------------------------------- #
class DifficultyLevel(Enum):
    TRIVIAL = auto()
    EASY = auto()
    NORMAL = auto()
    HARD = auto()
    INSANE = auto()

    def harder(self) -> "DifficultyLevel":
        levels = list(DifficultyLevel)
        idx = min(levels.index(self) + 1, len(levels) - 1)
        return levels[idx]

    def softer(self) -> "DifficultyLevel":
        levels = list(DifficultyLevel)
        idx = max(levels.index(self) - 1, 0)
        return levels[idx]


@dataclass
class DifficultyState:
    """Per-user calibration values persisted via AdaptiveRepo."""
    current_level: DifficultyLevel = DifficultyLevel.NORMAL
    completion_history: Deque[bool] = field(default_factory=lambda: deque(maxlen=50))

    def record_result(self, succeeded: bool) -> None:
        self.completion_history.append(succeeded)
        logger.debug("Recorded quest result: %s (history=%s)",
                     succeeded, list(self.completion_history))

    @property
    def success_rate(self) -> float:
        if not self.completion_history:
            return 0.0
        return mean(self.completion_history)


# --------------------------------------------------------------------------- #
#  Adaptive Difficulty Engine                                                 #
# --------------------------------------------------------------------------- #
class AdaptiveDifficultyEngine:
    """
    Central coordinator that listens to quest outcomes, updates a rolling
    success-rate, recalibrates the player's difficulty tier, and optionally
    schedules nudging notifications.
    """

    _TUNE_INTERVAL = 10               # quests
    _DEC_RATE_THRESHOLD = 0.3         # 30% success → too hard
    _INC_RATE_THRESHOLD = 0.85        # 85% success → too easy

    def __init__(
        self,
        user_id: int,
        repo: AdaptiveRepo,
        event_bus: EventBus = GLOBAL_EVENT_BUS,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._user_id = user_id
        self._repo = repo
        self._event_bus = event_bus
        self._state: DifficultyState | None = None
        self._loop = loop or asyncio.get_event_loop()

        self._event_bus.subscribe(QuestCompletedEvent, self._on_quest_completed)
        self._event_bus.subscribe(QuestFailedEvent, self._on_quest_failed)
        logger.info("AdaptiveDifficultyEngine initialised for user %d", user_id)

    # --------------------------------------------------------------------- #
    #  Public API                                                           #
    # --------------------------------------------------------------------- #
    async def initialise(self) -> None:
        """Loads persisted calibration for the current user."""
        self._state = await self._repo.load_state(self._user_id)
        logger.debug("Loaded difficulty state: %s", self._state)

    def current_level(self) -> DifficultyLevel:
        if not self._state:
            raise RuntimeError("Engine not initialised")
        return self._state.current_level

    def dispose(self) -> None:
        """Cleans up event subscriptions."""
        self._event_bus.unsubscribe(QuestCompletedEvent, self._on_quest_completed)
        self._event_bus.unsubscribe(QuestFailedEvent, self._on_quest_failed)

    # --------------------------------------------------------------------- #
    #  Event Handlers (sync, offloads to async)                             #
    # --------------------------------------------------------------------- #
    def _on_quest_completed(self, event: QuestCompletedEvent) -> None:
        logger.debug("Handling QuestCompletedEvent %s", event)
        asyncio.run_coroutine_threadsafe(
            self._process_result(True), loop=self._loop
        )

    def _on_quest_failed(self, event: QuestFailedEvent) -> None:
        logger.debug("Handling QuestFailedEvent %s", event)
        asyncio.run_coroutine_threadsafe(
            self._process_result(False), loop=self._loop
        )

    # --------------------------------------------------------------------- #
    #  Internal                                                              #
    # --------------------------------------------------------------------- #
    async def _process_result(self, succeeded: bool) -> None:
        if not self._state:
            await self.initialise()  # lazy load for robustness

        self._state.record_result(succeeded)

        if len(self._state.completion_history) % self._TUNE_INTERVAL == 0:
            await self._recalibrate()

    async def _recalibrate(self) -> None:
        success_rate = self._state.success_rate
        current_level = self._state.current_level
        logger.debug("Recalibrating… current=%s success_rate=%.2f",
                     current_level, success_rate)

        if success_rate < self._DEC_RATE_THRESHOLD:
            new_level = current_level.softer()
            reason = "struggling"
        elif success_rate > self._INC_RATE_THRESHOLD:
            new_level = current_level.harder()
            reason = "mastering"
        else:
            new_level = current_level
            reason = "balanced"

        if new_level != current_level:
            logger.info("Difficulty changed: %s → %s due to %s",
                        current_level.name, new_level.name, reason)
            self._state.current_level = new_level
            await self._notify_player(new_level, reason)

        await self._repo.save_state(self._user_id, self._state)

    async def _notify_player(self, new_level: DifficultyLevel, reason: str) -> None:
        adapter = NotificationFactory.get_adapter()
        if not adapter:
            logger.debug("No notification adapter configured; skipping push")
            return

        title = "QuestSmith Difficulty Updated"
        body = (
            f"We've adjusted your adventure to {new_level.name.title()} "
            f"because you were {reason} recent quests."
        )
        try:
            await adapter.send_local_notification(title=title, body=body)
            logger.debug("Sent notification: %s – %s", title, body)
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to send notification")


# --------------------------------------------------------------------------- #
#  Example In-Memory Repository Implementation (for tests)                    #
# --------------------------------------------------------------------------- #
class InMemoryAdaptiveRepo:
    """A trivial, thread-unsafe repository for demonstration & unit testing."""

    def __init__(self) -> None:
        self._store: dict[int, DifficultyState] = {}

    async def load_state(self, user_id: int) -> DifficultyState:
        state = self._store.setdefault(user_id, DifficultyState())
        logger.debug("In-mem load_state -> %s", state)
        return state

    async def save_state(self, user_id: int, state: DifficultyState) -> None:
        self._store[user_id] = state
        logger.debug("In-mem save_state <- %s", state)


# --------------------------------------------------------------------------- #
#  Convenience Bootstrap (only executed when run directly)                    #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    async def _demo() -> None:
        repo = InMemoryAdaptiveRepo()
        engine = AdaptiveDifficultyEngine(user_id=1, repo=repo)
        await engine.initialise()

        # Simulate a series of quest outcomes
        bus = GLOBAL_EVENT_BUS
        for i in range(30):
            evt = QuestCompletedEvent(quest_id=i, xp_gained=25, timestamp=0) \
                if i % 3 else QuestFailedEvent(quest_id=i, timestamp=0)
            bus.publish(evt)
            await asyncio.sleep(0.05)

        print("Final difficulty:", engine.current_level().name)
        engine.dispose()

    asyncio.run(_demo())
```