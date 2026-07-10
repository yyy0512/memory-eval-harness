```python
"""
QuestSmith – Adaptive Difficulty Engine
======================================

This module houses AdaptiveDifficultyEngine, an observer that listens for quest
results and dynamically adjusts game difficulty to keep players challenged yet
motivated.  It persists the current difficulty profile through the repository
layer, reports changes to the analytics backend, and notifies users of tier
shifts via the push-notification adapter.

The implementation purposefully depends only on abstractions that are supplied
by the larger QuestSmith code-base (EventBus, ProfileRepository, ServiceFactory).
To keep this file executable in isolation—for unit tests or documentation
examples—minimal fall-back “dummy” implementations are included behind
ImportError guards.  When running inside the real mobile application, the
official implementations will be imported instead.

Architecture patterns exercised in this file
--------------------------------------------
Repository Pattern : DifficultyProfile is loaded/saved exclusively through
                     ProfileRepository—never by talking directly to SQLite.

Observer Pattern   : The engine subscribes to quest_completed/quest_failed events
                     via EventBus, routing them to internal handlers.

Factory  Pattern   : All platform/service integrations (analytics, push) are
                     obtained from ServiceFactory to keep this code pure Python.

Thread-safety
-------------
All state mutation happens under a dedicated threading.Lock so that event
handlers (potentially invoked from multiple threads) never corrupt shared state.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

# --------------------------------------------------------------------------- #
# Fallback shims for development/testing outside the full QuestSmith runtime. #
# --------------------------------------------------------------------------- #
try:
    # Real implementations (available inside the production APK).
    from questsmith.infrastructure.event_bus import EventBus, EventSubscription
    from questsmith.repositories.profile_repository import ProfileRepository
    from questsmith.factories.service_factory import ServiceFactory
except ImportError:  # pragma: no cover – development stub
    logging.getLogger(__name__).warning(
        "QuestSmith runtime not detected – using in-memory dummy services."
    )

    class EventSubscription:  # noqa: D401
        """Lightweight handle returned by EventBus.subscribe."""

        def __init__(self, unsubscribe: Callable[[], None]):
            self._unsub = unsubscribe

        def unsubscribe(self) -> None:  # noqa: D401
            """Detach the subscription from its EventBus."""
            self._unsub()

    class EventBus:  # noqa: D101
        def __init__(self) -> None:
            self._subs: dict[str, List[Callable[[Any], None]]] = {}
            self._lock = threading.Lock()

        def subscribe(self, event_name: str, handler: Callable[[Any], None]) -> EventSubscription:
            with self._lock:
                self._subs.setdefault(event_name, []).append(handler)

            def _unsub() -> None:
                with self._lock:
                    self._subs.get(event_name, []).remove(handler)

            return EventSubscription(_unsub)

        def emit(self, event_name: str, payload: Any) -> None:
            for handler in list(self._subs.get(event_name, [])):
                try:
                    handler(payload)
                except Exception:  # pragma: no cover
                    logging.exception("Uncaught error in EventBus handler for %s", event_name)

    class ProfileRepository:  # noqa: D101
        """In-memory implementation for development use only."""

        def __init__(self) -> None:
            self._store: dict[str, dict[str, Any]] = {}

        # Keys used only in this module; repository may contain other data.
        _KEY = "difficulty_profile"

        def load_difficulty_profile(self) -> Optional[dict[str, Any]]:
            return self._store.get(self._KEY)

        def save_difficulty_profile(self, data: dict[str, Any]) -> None:
            self._store[self._KEY] = data.copy()

    class ServiceFactory:  # noqa: D101
        @staticmethod
        def get_analytics_service():  # noqa: D401
            class _DummyAnalytics:  # noqa: D401
                def record_event(self, name: str, **kwargs) -> None:
                    logging.debug("[analytics/%s] %s", name, kwargs)

            return _DummyAnalytics()

        @staticmethod
        def get_push_service():  # noqa: D401
            class _DummyPush:  # noqa: D401
                def schedule_notification(self, title: str, message: str, delay_seconds: int) -> None:
                    logging.debug(
                        "Push scheduled in %ss – %s: %s", delay_seconds, title, message
                    )

            return _DummyPush()


# Initialize root logger if the host app has not done so already.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
)
_LOG = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Data model                                                                   #
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class DifficultyProfile:
    """
    A concise snapshot of the user’s current difficulty tier and corresponding
    game-balancing multipliers.  The meaning of each field is documented inline.
    """

    # Current adaptive tier – 1 is the easiest, MAX_TIER (see engine) the hardest.
    tier: int = 1

    # XP multiplier applied when granting quest completion experience.
    xp_multiplier: float = 1.0

    # Modifier applied to enemy/obstacle stats in procedurally generated quests.
    enemy_strength_modifier: float = 1.0

    # Variance added to reward drops (higher tiers give wider variance to keep
    # things exciting—e.g., 0.25 allows ±25% deviation from base values).
    reward_variance: float = 0.0

    # Timestamp of the last engine-driven profile update.
    last_updated_ts: float = field(default_factory=time.time)

    # ------------------------- Convenience helpers -------------------------- #
    def to_dict(self) -> dict[str, Any]:  # noqa: D401
        """Serialize the dataclass into a JSON-friendly dictionary."""
        return {
            "tier": self.tier,
            "xp_multiplier": self.xp_multiplier,
            "enemy_strength_modifier": self.enemy_strength_modifier,
            "reward_variance": self.reward_variance,
            "last_updated_ts": self.last_updated_ts,
        }

    @staticmethod
    def from_dict(raw: dict[str, Any]) -> "DifficultyProfile":  # noqa: D401
        """Rebuild a DifficultyProfile from the repository payload."""
        return DifficultyProfile(
            tier=int(raw.get("tier", 1)),
            xp_multiplier=float(raw.get("xp_multiplier", 1.0)),
            enemy_strength_modifier=float(raw.get("enemy_strength_modifier", 1.0)),
            reward_variance=float(raw.get("reward_variance", 0.0)),
            last_updated_ts=float(raw.get("last_updated_ts", time.time())),
        )


# --------------------------------------------------------------------------- #
# Business logic                                                               #
# --------------------------------------------------------------------------- #
class AdaptiveDifficultyEngine:
    """
    Central coordinator that constantly re-evaluates player performance and
    upgrades/downgrades the difficulty tier to maintain the ‘zone of proximal
    productivity’.  The engine listens for `quest_completed` and `quest_failed`
    events and updates its rolling performance window.

    Performance evaluation:
        success_rate = successful quests / evaluated quests

    Tier changes are triggered at the following thresholds
        success_rate >= INCREASE_THRESHOLD  -> +1 tier
        success_rate <= DECREASE_THRESHOLD  -> -1 tier
        otherwise                           -> keep current tier

    Multipliers are recomputed deterministically from the new tier so that other
    game systems only have to read `DifficultyProfile` and never run their own
    calculations.
    """

    # Number of most-recent quest results evaluated when computing success_rate.
    PERFORMANCE_WINDOW: int = 20

    # Thresholds that cause tier jumps (values between 0 and 1).
    INCREASE_THRESHOLD: float = 0.85
    DECREASE_THRESHOLD: float = 0.40

    # Hard limits to prevent unreasonable game states.
    MIN_TIER: int = 1
    MAX_TIER: int = 10

    def __init__(
        self,
        event_bus: EventBus,
        repository: ProfileRepository,
        service_factory: ServiceFactory,
    ) -> None:
        self._bus = event_bus
        self._repo = repository
        self._analytics = service_factory.get_analytics_service()
        self._push = service_factory.get_push_service()

        self._profile: DifficultyProfile = self._load_profile()

        # Recently observed quest outcomes (True = success, False = failure).
        self._recent_results: List[bool] = []

        # Synchronize access to _recent_results & _profile.
        self._lock = threading.Lock()

        # Keep track of EventBus subscriptions so we can cleanly shut down.
        self._subscriptions: List[EventSubscription] = []

        self._register_to_bus()
        _LOG.info(
            "AdaptiveDifficultyEngine initialized – current tier %d", self._profile.tier
        )

    # --------------------------------------------------------------------- #
    # Public section                                                         #
    # --------------------------------------------------------------------- #
    def shutdown(self) -> None:
        """Unsubscribe from EventBus – call when the application closes."""
        for sub in self._subscriptions:
            sub.unsubscribe()
        self._subscriptions.clear()
        _LOG.info("AdaptiveDifficultyEngine shut down.")

    def current_profile(self) -> DifficultyProfile:  # noqa: D401
        """Thread-safe, read-only accessor for UI widgets and game systems."""
        with self._lock:
            return DifficultyProfile.from_dict(self._profile.to_dict())

    # --------------------------------------------------------------------- #
    # Event handling                                                         #
    # --------------------------------------------------------------------- #
    def _register_to_bus(self) -> None:
        """Attach local handlers to global EventBus events."""
        self._subscriptions.extend(
            [
                self._bus.subscribe("quest_completed", self._on_quest_completed),
                self._bus.subscribe("quest_failed", self._on_quest_failed),
            ]
        )

    def _on_quest_completed(self, payload: dict[str, Any]) -> None:
        _LOG.debug("Quest completed → payload=%s", payload)
        self._record_result(success=True)

    def _on_quest_failed(self, payload: dict[str, Any]) -> None:
        _LOG.debug("Quest failed → payload=%s", payload)
        self._record_result(success=False)

    # --------------------------------------------------------------------- #
    # Internal helpers                                                       #
    # --------------------------------------------------------------------- #
    def _record_result(self, *, success: bool) -> None:
        """
        Add a quest outcome to the rolling window and potentially trigger a
        difficulty re-evaluation.  The entire routine is guarded by a lock so
        that multiple events arriving in rapid succession cannot race.
        """
        with self._lock:
            self._recent_results.append(success)
            if len(self._recent_results) > self.PERFORMANCE_WINDOW:
                self._recent_results.pop(0)

            _LOG.debug(
                "Recorded quest result=%s (buffer=%d/%d)",
                success,
                len(self._recent_results),
                self.PERFORMANCE_WINDOW,
            )

            # Re-evaluate only once we have enough data.
            if len(self._recent_results) == self.PERFORMANCE_WINDOW:
                self._re_evaluate_locked()

    def _re_evaluate_locked(self) -> None:
        """
        Compute success_rate and, if thresholds are crossed, bump the tier.  All
        methods invoked from here must be free of additional locks.
        """
        success_rate: float = sum(self._recent_results) / len(self._recent_results)
        old_tier: int = self._profile.tier
        new_tier: int = old_tier

        if success_rate >= self.INCREASE_THRESHOLD:
            new_tier = min(old_tier + 1, self.MAX_TIER)
        elif success_rate <= self.DECREASE_THRESHOLD:
            new_tier = max(old_tier - 1, self.MIN_TIER)

        _LOG.debug(
            "Performance window filled – success_rate=%.02f → tier %d -> %d",
            success_rate,
            old_tier,
            new_tier,
        )

        if new_tier != old_tier:
            self._apply_new_tier(new_tier)
            # Reset window after tier change to avoid immediate oscillation.
            self._recent_results.clear()

    def _apply_new_tier(self, tier: int) -> None:
        """
        Update the profile with deterministic multipliers derived from `tier`,
        persist the change, and broadcast telemetry/notifications.
        """
        # Deterministic multipliers (tweak these to fine-tune balancing).
        xp_mult = round(1.0 + 0.15 * (tier - 1), 2)
        enemy_mod = round(1.0 + 0.12 * (tier - 1), 2)
        variance = round(min(0.30, 0.05 * tier), 2)

        self._profile = DifficultyProfile(
            tier=tier,
            xp_multiplier=xp_mult,
            enemy_strength_modifier=enemy_mod,
            reward_variance=variance,
            last_updated_ts=time.time(),
        )

        # Persist & propagate changes outside the lock to keep handlers fast.
        profile_snapshot = self._profile.to_dict()
        _LOG.info("Difficulty tier adjusted → %s", profile_snapshot)

        try:
            self._repo.save_difficulty_profile(profile_snapshot)
        except Exception:  # pragma: no cover
            _LOG.exception("Failed to persist difficulty profile")

        # Analytics – non-blocking.
        try:
            self._analytics.record_event(
                "difficulty_tier_changed",
                new_tier=tier,
                xp_multiplier=xp_mult,
                enemy_modifier=enemy_mod,
                variance=variance,
            )
        except Exception:  # pragma: no cover
            _LOG.exception("Analytics service raised while recording event")

        # Push notification – inform the user after a small delay so the toast
        # doesn’t overlap with any in-game reward pop-ups.
        try:
            title = "Challenge Updated!"
            body = (
                f"Great work! Your quests just got tougher – welcome to Tier {tier}."
                if tier > 1
                else "Keep pushing! We’ve dialed things back to help you regroup."
            )
            self._push.schedule_notification(title, body, delay_seconds=10)
        except Exception:  # pragma: no cover
            _LOG.exception("Push service raised while scheduling notification")

    # --------------------------------------------------------------------- #
    # Persistence                                                            #
    # --------------------------------------------------------------------- #
    def _load_profile(self) -> DifficultyProfile:
        """
        Attempt to retrieve a stored profile; if none exists (first app launch)
        create a fresh baseline profile at tier 1.
        """
        raw = None
        try:
            raw = self._repo.load_difficulty_profile()
        except Exception:  # pragma: no cover
            _LOG.exception("Repository threw while loading difficulty profile")

        if raw:
            _LOG.debug("Loaded difficulty profile from repository: %s", raw)
            return DifficultyProfile.from_dict(raw)

        _LOG.info("No stored difficulty profile found – creating default (tier 1)")
        profile = DifficultyProfile()
        try:
            self._repo.save_difficulty_profile(profile.to_dict())
        except Exception:  # pragma: no cover
            _LOG.exception("Could not persist default difficulty profile")

        return profile


# --------------------------------------------------------------------------- #
# Stand-alone demo (executed via `python module_36.py` for quick testing).     #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    bus = EventBus()
    repo = ProfileRepository()
    factory = ServiceFactory()

    engine = AdaptiveDifficultyEngine(bus, repo, factory)

    # Simulate a bunch of quest outcomes to trigger tier changes.
    for i in range(25):
        bus.emit("quest_completed", {})  # 25 successes → tier should increase

    time.sleep(0.1)  # Let async notifications print out
    print("Current profile after successes:", engine.current_profile())

    for i in range(25):
        bus.emit("quest_failed", {})  # 25 failures → tier should decrease

    time.sleep(0.1)
    print("Current profile after failures:", engine.current_profile())

    engine.shutdown()
```