```python
"""
module_5.py

QuestSmith – Adaptive Difficulty Engine
=======================================

This module houses the AdaptiveDifficultyEngine, an Observer‐pattern
component that listens to quest‐related events and continuously tunes a
per-user difficulty factor.  The factor determines how aggressively
QuestSmith scales quest requirements, reward multipliers, and AI
opponent strength.

Key characteristics
-------------------
•   Pure-Python, UI-agnostic logic (MVVM friendly)
•   Repository Pattern for persistence
•   Event-driven updates via Observer Pattern
•   Factory-injected dependencies for loose coupling

The engine will happily operate offline; updates are persisted locally
and synchronised by the app’s overarching sync layer when the network
becomes available.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Deque, Dict, Optional, Protocol, runtime_checkable

# --------------------------------------------------------------------------- #
# External service interfaces (supplied elsewhere in the project)            #
# --------------------------------------------------------------------------- #

@runtime_checkable
class EventBus(Protocol):
    """A minimal interface for the Observer Event Bus used across the app."""

    def subscribe(self, event_type: str, callback: "EventCallback") -> None: ...

    def unsubscribe(self, event_type: str, callback: "EventCallback") -> None: ...

    def publish(self, event_type: str, payload: Optional[dict] = None) -> None: ...


EventCallback = callable


@runtime_checkable
class Repository(Protocol):
    """A generic persistence interface."""

    def get(self, key: str) -> Optional[dict]: ...

    def upsert(self, key: str, value: dict) -> None: ...


@runtime_checkable
class CrashReporter(Protocol):
    """Platform crash reporter wrapper."""

    def capture_exception(self, exc: BaseException) -> None: ...


# --------------------------------------------------------------------------- #
# Dataclasses                                                                 #
# --------------------------------------------------------------------------- #

@dataclass
class DifficultyProfile:
    """Persisted snapshot of the user’s difficulty parameters."""

    user_id: str
    factor: float = 1.0  # Neutral baseline.
    last_updated: datetime = field(default_factory=datetime.utcnow)

    @classmethod
    def from_dict(cls, data: Dict) -> "DifficultyProfile":
        return cls(
            user_id=data["user_id"],
            factor=data["factor"],
            last_updated=datetime.fromisoformat(data["last_updated"]),
        )

    def to_dict(self) -> Dict:
        return {
            "user_id": self.user_id,
            "factor": self.factor,
            "last_updated": self.last_updated.isoformat(),
        }


# --------------------------------------------------------------------------- #
# Exceptions                                                                  #
# --------------------------------------------------------------------------- #

class AdaptiveDifficultyError(RuntimeError):
    """Base‐class for engine related errors."""


# --------------------------------------------------------------------------- #
# Adaptive Difficulty Engine                                                  #
# --------------------------------------------------------------------------- #

class AdaptiveDifficultyEngine:
    """
    Observes quest outcomes and adapts gameplay difficulty.

    Thread‐safe, non-blocking implementation.  Heavy analytics should be
    deferred to the project’s analytics subsystem; the engine only
    considers lightweight recent history.
    """

    # Configuration knobs (could be externalised to settings.yaml)
    WINDOW_SIZE: int = 50                   # Maximum quests to consider
    LOWER_THRESHOLD: float = 0.55           # Drop difficulty below this
    UPPER_THRESHOLD: float = 0.85           # Raise difficulty above this
    UPDATE_COOLDOWN: timedelta = timedelta(hours=1)  # Minimum gap
    STEP: float = 0.05                      # Factor delta per adjustment
    MIN_FACTOR: float = 0.5
    MAX_FACTOR: float = 2.0

    def __init__(
        self,
        user_id: str,
        event_bus: EventBus,
        repository: Repository,
        crash_reporter: Optional[CrashReporter] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        self._user_id = user_id
        self._event_bus = event_bus
        self._repo = repository
        self._crash = crash_reporter
        self._log = logger or logging.getLogger(__name__)

        self._lock = threading.RLock()
        self._history: Deque[bool] = deque(maxlen=self.WINDOW_SIZE)

        # Load or bootstrap difficulty state
        self._profile: DifficultyProfile = self._load_profile()

        # Bind event listeners
        self._event_bus.subscribe("quest_completed", self._on_quest_completed)
        self._event_bus.subscribe("quest_failed", self._on_quest_failed)

        self._log.debug(
            "AdaptiveDifficultyEngine initialised for user %s (factor=%.2f)",
            self._user_id,
            self._profile.factor,
        )

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def shutdown(self) -> None:
        """Unsubscribe listeners and flush state."""
        self._event_bus.unsubscribe("quest_completed", self._on_quest_completed)
        self._event_bus.unsubscribe("quest_failed", self._on_quest_failed)
        self._save_profile()
        self._log.debug("AdaptiveDifficultyEngine shutdown complete.")

    def get_current_factor(self) -> float:
        """Return the current difficulty multiplier."""
        with self._lock:
            return self._profile.factor

    # --------------------------------------------------------------------- #
    # Event handlers                                                        #
    # --------------------------------------------------------------------- #

    def _on_quest_completed(self, _event_type: str, payload: Optional[dict]) -> None:
        self._log.debug("Quest completed event received: %s", payload)
        self._update_history(success=True)

    def _on_quest_failed(self, _event_type: str, payload: Optional[dict]) -> None:
        self._log.debug("Quest failed event received: %s", payload)
        self._update_history(success=False)

    # --------------------------------------------------------------------- #
    # Internal mechanics                                                    #
    # --------------------------------------------------------------------- #

    def _update_history(self, *, success: bool) -> None:
        """
        Record quest outcome and trigger difficulty reevaluation in a
        separate daemon thread to avoid blocking the UI thread.
        """
        with self._lock:
            self._history.append(success)
            should_evaluate = self._should_evaluate_locked()

        if should_evaluate:
            t = threading.Thread(
                target=self._evaluate_and_persist, daemon=True, name="diff-eval"
            )
            t.start()

    def _should_evaluate_locked(self) -> bool:
        """
        Determines if enough data & cooldown elapsed for a re-evaluation.

        Pre-condition: caller holds _lock.
        """
        if len(self._history) < max(5, int(0.2 * self.WINDOW_SIZE)):
            return False  # Not enough data yet.

        elapsed = datetime.utcnow() - self._profile.last_updated
        return elapsed >= self.UPDATE_COOLDOWN

    def _evaluate_and_persist(self) -> None:
        """Compute new difficulty factor and persist the profile."""
        try:
            with self._lock:
                success_rate = sum(self._history) / len(self._history)
                self._log.debug(
                    "Evaluating difficulty | success_rate=%.02f "
                    "window=%d current_factor=%.2f",
                    success_rate,
                    len(self._history),
                    self._profile.factor,
                )

                new_factor = self._profile.factor  # Default to unchanged.

                if success_rate > self.UPPER_THRESHOLD:
                    new_factor += self.STEP
                elif success_rate < self.LOWER_THRESHOLD:
                    new_factor -= self.STEP

                new_factor = self._clamp(new_factor, self.MIN_FACTOR, self.MAX_FACTOR)

                if not math.isclose(new_factor, self._profile.factor, abs_tol=1e-3):
                    self._profile.factor = new_factor
                    self._profile.last_updated = datetime.utcnow()
                    self._save_profile_locked()
                    self._broadcast_update_locked()
                    self._log.info(
                        "Difficulty adjusted to %.2f (success_rate=%.02f)",
                        new_factor,
                        success_rate,
                    )
                else:
                    self._log.debug("No difficulty adjustment required.")
        except Exception as exc:  # pylint: disable=broad-except
            if self._crash:
                self._crash.capture_exception(exc)
            self._log.exception("Error while evaluating adaptive difficulty.")

    # --------------------------------------------------------------------- #
    # Persistence helpers                                                   #
    # --------------------------------------------------------------------- #

    def _load_profile(self) -> DifficultyProfile:
        """Fetch DifficultyProfile from repository or create new one."""
        key = self._profile_key()
        record = self._repo.get(key)
        if record:
            try:
                profile = DifficultyProfile.from_dict(record)
                self._log.debug(
                    "Loaded existing DifficultyProfile: %s", profile.to_dict()
                )
                return profile
            except Exception as exc:  # pylint: disable=broad-except
                self._log.warning(
                    "Corrupted difficulty profile for %s: %s. Rebuilding.",
                    self._user_id,
                    exc,
                )
                if self._crash:
                    self._crash.capture_exception(exc)

        # Bootstrap brand-new profile
        profile = DifficultyProfile(user_id=self._user_id)
        self._repo.upsert(key, profile.to_dict())
        return profile

    def _save_profile(self) -> None:
        with self._lock:
            self._save_profile_locked()

    def _save_profile_locked(self) -> None:
        key = self._profile_key()
        self._repo.upsert(key, self._profile.to_dict())
        self._log.debug("Difficulty profile persisted.")

    def _profile_key(self) -> str:
        return f"user:{self._user_id}:difficulty"

    # --------------------------------------------------------------------- #
    # Messaging                                                             #
    # --------------------------------------------------------------------- #

    def _broadcast_update_locked(self) -> None:
        """
        Notify other subsystems that difficulty has changed.

        Pre-condition: caller holds _lock.
        """
        self._event_bus.publish(
            "difficulty_updated",
            {
                "user_id": self._user_id,
                "difficulty_factor": self._profile.factor,
                "timestamp": time.time(),
            },
        )

    # --------------------------------------------------------------------- #
    # Utility                                                                #
    # --------------------------------------------------------------------- #

    @staticmethod
    def _clamp(value: float, min_value: float, max_value: float) -> float:
        return max(min_value, min(max_value, value))
```