```python
"""
module_29.py

QuestSmith – Adaptive Difficulty Engine
---------------------------------------

This module implements a runtime service that continuously monitors quest
outcomes and dynamically tunes the global difficulty multiplier stored in the
player-profile repository.  The service follows the Observer pattern: it
subscribes to QuestCompleted / QuestFailed signals published on the central
event-bus and reacts by recalculating a rolling success-rate KPI.  Whenever
a significant drift is detected, a DifficultyChanged event is broadcast so
renderers, reward calculators, and enemy AI adapters can immediately pick up
the new value.

The engine is entirely decoupled from concrete infrastructure by relying on
Repository and EventBus interfaces provided by the DI ‑ Factory layer.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum, auto
from typing import Deque, Iterable, Protocol, runtime_checkable

# ------------------------------------------------------------------------------
# Logging configuration (module-local – parent logger should propagate handlers)
# ------------------------------------------------------------------------------

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# ------------------------------------------------------------------------------
# Interfaces (Repository, EventBus, Subscriber)
# ------------------------------------------------------------------------------

@runtime_checkable
class EventBus(Protocol):
    """Publish / subscribe abstraction used throughout the project."""

    def subscribe(self, event_type: type, listener: "EventSubscriber") -> None: ...
    def unsubscribe(self, event_type: type, listener: "EventSubscriber") -> None: ...
    def post(self, event: object) -> None: ...


@runtime_checkable
class PlayerRepository(Protocol):
    """
    Repository abstraction for persisting / retrieving player-profile data.

    Only the API surface required by this module is declared here.  Concrete
    implementations are supplied by the Repository factory at startup.
    """

    # Difficulty multiplier is a global float applied to XP, loot chance, etc.
    def get_difficulty_multiplier(self, player_id: str) -> float: ...
    def set_difficulty_multiplier(self, player_id: str, multiplier: float) -> None: ...

    # Stats used for analytics dashboard
    def append_difficulty_kpi(
        self,
        player_id: str,
        timestamp: float,
        success_rate: float,
        multiplier: float,
    ) -> None: ...


class EventSubscriber(Protocol):
    """Interface implemented by any class that wants to receive bus events."""

    def on_event(self, event: object) -> None: ...


# ------------------------------------------------------------------------------
# Domain Events
# ------------------------------------------------------------------------------

class QuestResult(Enum):
    SUCCESS = auto()
    FAILURE = auto()


@dataclass(frozen=True, slots=True)
class QuestOutcomeEvent:
    """Event published by QuestManager when a quest concludes."""
    player_id: str
    quest_id: str
    result: QuestResult
    difficulty: float  # difficulty rating of the quest at completion
    timestamp: float = time.time()


@dataclass(frozen=True, slots=True)
class DifficultyChangedEvent:
    """Event broadcast by this module whenever the multiplier is updated."""
    player_id: str
    old_multiplier: float
    new_multiplier: float
    timestamp: float = time.time()


# ------------------------------------------------------------------------------
# Adaptive Difficulty Engine
# ------------------------------------------------------------------------------

class AdaptiveDifficultyEngine(EventSubscriber):
    """
    Continuously calibrates quest difficulty based on recent player performance.

    Public API
    ----------
    start()  -> begin listening to quest outcome events
    stop()   -> detach from event bus and flush any remaining state
    """

    # Default window size for rolling success-rate
    WINDOW_SIZE: int = 30
    # Minimum change required to trigger an update (to prevent jitter)
    MIN_DELTA: float = 0.05
    # Increment / decrement step applied to difficulty multiplier
    STEP: float = 0.1
    # Bounds to keep multiplier within sane limits
    MIN_MULTIPLIER: float = 0.5
    MAX_MULTIPLIER: float = 3.0

    def __init__(
        self,
        player_id: str,
        repository: PlayerRepository,
        event_bus: EventBus,
        *,
        window_size: int | None = None,
    ) -> None:
        self._player_id = player_id
        self._repo = repository
        self._bus = event_bus
        self._window: Deque[QuestResult] = deque(maxlen=window_size or self.WINDOW_SIZE)

        # Internal lock — invoked from the event-bus thread
        self._lock = threading.RLock()
        self._running = False

    # --------------------------------------------------------------------- API

    def start(self) -> None:
        """Attach to event bus so incoming QuestOutcomeEvents will be received."""
        with self._lock:
            if self._running:
                return
            self._bus.subscribe(QuestOutcomeEvent, self)
            self._running = True
            logger.info("AdaptiveDifficultyEngine started for player %s", self._player_id)

    def stop(self) -> None:
        """Detach from event bus; no further events will be processed."""
        with self._lock:
            if not self._running:
                return
            self._bus.unsubscribe(QuestOutcomeEvent, self)
            self._running = False
            logger.info("AdaptiveDifficultyEngine stopped for player %s", self._player_id)

    # ---------------------------------------------------------------- EventSubscriber

    def on_event(self, event: object) -> None:
        """Handle subscribed events from the event bus."""
        if not isinstance(event, QuestOutcomeEvent):
            return  # ignore unrelated events

        if event.player_id != self._player_id:
            return  # event for a different player profile

        try:
            self._process_outcome(event)
        except Exception as exc:  # pragma: no-cover – never fail hard in listeners
            logger.exception("Error while processing QuestOutcomeEvent: %s", exc)

    # ----------------------------------------------------------------- Internal

    def _process_outcome(self, event: QuestOutcomeEvent) -> None:
        """Update rolling window and possibly adapt difficulty multiplier."""
        with self._lock:
            self._window.append(event.result)
            # Only start adapting after window has at least 10 entries
            if len(self._window) < 10:
                return

            success_rate = self._window.count(QuestResult.SUCCESS) / len(self._window)
            logger.debug(
                "Success-rate for player %s is now %.2f (window=%d)",
                self._player_id,
                success_rate,
                len(self._window),
            )

            current_multiplier = self._safe_get_multiplier()
            target_multiplier = self._calculate_new_multiplier(success_rate, current_multiplier)

            if abs(target_multiplier - current_multiplier) >= self.MIN_DELTA:
                self._update_multiplier(current_multiplier, target_multiplier, success_rate)

    def _calculate_new_multiplier(self, success_rate: float, current: float) -> float:
        """
        Derive next difficulty multiplier based on moving success-rate.

        > 80 % success  -> increase difficulty
        < 50 % success  -> decrease difficulty
        Otherwise       -> keep as is
        """
        if success_rate >= 0.80:
            current += self.STEP
        elif success_rate <= 0.50:
            current -= self.STEP

        # clamp to bounds
        return max(self.MIN_MULTIPLIER, min(self.MAX_MULTIPLIER, round(current, 2)))

    # ---------------------------------------------------------------- repository helpers

    def _safe_get_multiplier(self) -> float:
        """Retrieve multiplier from repository with graceful degradation."""
        try:
            return self._repo.get_difficulty_multiplier(self._player_id)
        except Exception as exc:
            logger.exception(
                "Repository failure while fetching difficulty multiplier: %s", exc
            )
            # Fall back to neutral multiplier
            return 1.0

    def _update_multiplier(
        self,
        old: float,
        new: float,
        success_rate: float,
    ) -> None:
        """Persist new multiplier and broadcast DifficultyChangedEvent."""
        try:
            self._repo.set_difficulty_multiplier(self._player_id, new)
            self._repo.append_difficulty_kpi(
                self._player_id,
                timestamp=time.time(),
                success_rate=success_rate,
                multiplier=new,
            )
        except Exception as exc:
            logger.exception(
                "Repository failure while updating difficulty multiplier: %s", exc
            )
            return  # early exit – do not broadcast event if we couldn't persist

        self._bus.post(
            DifficultyChangedEvent(
                player_id=self._player_id,
                old_multiplier=old,
                new_multiplier=new,
                timestamp=time.time(),
            )
        )

        logger.info(
            "Adaptive Difficulty updated for player %s – %.2f ➔ %.2f (success-rate %.0f%%)",
            self._player_id,
            old,
            new,
            success_rate * 100,
        )


# ------------------------------------------------------------------------------
# Utilities – factory helper to wire engine into the app
# ------------------------------------------------------------------------------

def create_and_start_engine(
    player_id: str,
    repository: PlayerRepository,
    event_bus: EventBus,
    *,
    window_size: int | None = None,
) -> AdaptiveDifficultyEngine:
    """
    Convenience function used by the DI container to bootstrap the service.

    Returns the running engine instance so the caller can register it for
    graceful shutdown hooks.
    """
    engine = AdaptiveDifficultyEngine(
        player_id=player_id,
        repository=repository,
        event_bus=event_bus,
        window_size=window_size,
    )
    engine.start()
    return engine
```