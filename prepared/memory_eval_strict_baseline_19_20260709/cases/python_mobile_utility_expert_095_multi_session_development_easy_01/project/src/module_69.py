```python
"""
PrismPocket – Analytics & Prompt Generation Module
==================================================

This module wires together a small in-process Observer bus, an analytics engine
that digests PrismCard creation events, and a factory that turns live analytics
into creative prompt suggestions for the user.  The code purposefully avoids
platform-specific dependencies so it can run inside both the iOS/Android
packaged interpreters and the server-side workspace worker pool.

Patterns exercised
------------------
• SingletonMeta      – guarantees singletons for EventBus, AnalyticsEngine,
                       and CrashReporter.
• Observer Pattern   – EventBus publishes domain mutations to subscribers.
• Repository Pattern – AnalyticsEngine persists metrics to a lightweight JSON
                       “repository” on local storage.
• Factory Pattern    – PromptSuggestionFactory generates prompt objects based
                       on the latest analytics snapshot.

The public API surface area
---------------------------
• EventBus           – `publish(event_type, **payload)`
• PrismAnalyticsEngine
    • `record_card(payload: dict)`
    • `get_trending_colors(top_n=5)`
    • `get_hotspot_locations(top_n=5)`
    • `get_average_mood()`
• PromptSuggestionFactory
    • `generate_prompts(num_prompts=3) -> list[str]`

Any component in the app may subscribe to `"analytics_updated"` to receive
full, immutable snapshots of the latest metrics.

Author: PrismPocket Core Engineering Team
"""

from __future__ import annotations

import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# -----------------------------------------------------------------------------
# Logging setup
# -----------------------------------------------------------------------------
logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("[%(levelname)s|%(name)s] %(asctime)s – %(message)s")
)
logger.addHandler(_handler)

# -----------------------------------------------------------------------------
# Singleton MetaClass
# -----------------------------------------------------------------------------


class SingletonMeta(type):
    """
    A thread-safe implementation of Singleton.

    Note – this is intentionally *very* small; we lock only the object
    creation path to avoid unnecessary contention during normal use.
    """

    _instances: Dict[type, "SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)
                cls._instances[cls] = instance
        return cls._instances[cls]


# -----------------------------------------------------------------------------
# Crash Reporter (placeholder for native integration)
# -----------------------------------------------------------------------------


class CrashReporter(metaclass=SingletonMeta):
    """
    Stubbed crash reporter. In production builds, this would bridge to
    Firebase Crashlytics, Sentry, or the native OS crash manager.
    """

    def capture(self, exc: Exception, context: Optional[str] = None) -> None:
        logger.error(
            "Captured exception%s: %s",
            f" ({context})" if context else "",
            exc,
            exc_info=True,
        )


# -----------------------------------------------------------------------------
# Observer Bus
# -----------------------------------------------------------------------------


class EventBus(metaclass=SingletonMeta):
    """
    Publish/Subscribe message bus for lightweight, in-memory events.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[[Dict[str, Any]], None]]] = defaultdict(list)
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Subscription                                                          #
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        """
        Register a callback for `event_type`. Duplicate callbacks are ignored.
        """
        with self._lock:
            if callback not in self._subscribers[event_type]:
                self._subscribers[event_type].append(callback)
                logger.debug("Subscriber added: %s for event '%s'", callback, event_type)

    def unsubscribe(self, event_type: str, callback: Callable[[Dict[str, Any]], None]) -> None:
        """Remove previously registered callback. Silently ignored if not found."""
        with self._lock:
            try:
                self._subscribers[event_type].remove(callback)
                logger.debug("Subscriber removed: %s for event '%s'", callback, event_type)
            except ValueError:
                pass

    # --------------------------------------------------------------------- #
    # Publishing                                                            #
    # --------------------------------------------------------------------- #

    def publish(self, event_type: str, **payload: Any) -> None:
        """
        Broadcast an event with a JSON-serialisable payload.
        """
        with self._lock:
            callbacks = list(self._subscribers.get(event_type, []))

        logger.debug("Publishing '%s' to %d listeners", event_type, len(callbacks))

        for cb in callbacks:
            try:
                cb(payload)
            except Exception as exc:  # pragma: no cover – defensive
                CrashReporter().capture(exc, context=f"EventBus publishing '{event_type}'")
                # Do *not* re-raise to avoid annihilating the entire bus.


# -----------------------------------------------------------------------------
# Analytics Engine
# -----------------------------------------------------------------------------


class PrismAnalyticsEngine(metaclass=SingletonMeta):
    """
    Aggregates analytics on PrismCards in near-real time.
    """

    # Where analytics snapshots live on disk
    _STORAGE_PATH = Path.home() / ".prism_pocket" / "analytics.json"
    _STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Used for geospatial hotspot rounding (approx ~100m)
    _COORD_ROUNDING_DIGITS = 3

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._palette_counter: Counter[str] = Counter()
        self._location_counter: Counter[Tuple[float, float]] = Counter()
        self._mood_scores: List[int] = []

        logger.info("Initialising PrismAnalyticsEngine")
        self._restore_from_disk()

        # Subscribe to card creation events
        EventBus().subscribe("prism_card_created", self._on_card_created)

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def record_card(self, card_payload: Dict[str, Any]) -> None:
        """
        Explicitly record a card creation (alternative to EventBus pathway).
        Can be used for batch sync/import operations.
        """
        self._on_card_created(card_payload)

    def get_trending_colors(self, top_n: int = 5) -> List[Tuple[str, int]]:
        with self._lock:
            return self._palette_counter.most_common(top_n)

    def get_hotspot_locations(self, top_n: int = 5) -> List[Tuple[Tuple[float, float], int]]:
        with self._lock:
            return self._location_counter.most_common(top_n)

    def get_average_mood(self) -> Optional[float]:
        with self._lock:
            if not self._mood_scores:
                return None
            return sum(self._mood_scores) / len(self._mood_scores)

    # --------------------------------------------------------------------- #
    # Event handling                                                        #
    # --------------------------------------------------------------------- #

    def _on_card_created(self, payload: Dict[str, Any]) -> None:
        """
        Expected payload shape:
        {
            "colors": ["#ff00ff", "#00ff00", ...],        # 0-N colors
            "location": {"lat": 51.5045, "lon": -0.0865}, # optional
            "mood_score": 8                               # 0–10, optional
        }
        """
        try:
            with self._lock:
                # 1. Palette
                for color in payload.get("colors", []):
                    canonical_color = color.lower()
                    self._palette_counter[canonical_color] += 1
                    logger.debug("Palette updated – %s: %d", canonical_color, self._palette_counter[canonical_color])

                # 2. Geo hotspots
                loc = payload.get("location")
                if loc and {"lat", "lon"} <= loc.keys():
                    rounded_loc = (
                        round(float(loc["lat"]), self._COORD_ROUNDING_DIGITS),
                        round(float(loc["lon"]), self._COORD_ROUNDING_DIGITS),
                    )
                    self._location_counter[rounded_loc] += 1
                    logger.debug(
                        "Location updated – %s: %d", rounded_loc, self._location_counter[rounded_loc]
                    )

                # 3. Mood
                mood = payload.get("mood_score")
                if isinstance(mood, (int, float)):
                    self._mood_scores.append(int(mood))

                # 4. Persist and broadcast
                self._persist_to_disk()

            EventBus().publish(
                "analytics_updated",
                at=datetime.utcnow().isoformat() + "Z",
                trending_colors=self.get_trending_colors(),
                hotspots=self.get_hotspot_locations(),
                avg_mood=self.get_average_mood(),
            )

        except Exception as exc:  # pragma: no cover
            CrashReporter().capture(exc, context="_on_card_created")

    # --------------------------------------------------------------------- #
    # Persistence                                                           #
    # --------------------------------------------------------------------- #

    def _restore_from_disk(self) -> None:
        if not self._STORAGE_PATH.exists():
            logger.info("No existing analytics snapshot found; starting fresh.")
            return

        try:
            data = json.loads(self._STORAGE_PATH.read_text())
            self._palette_counter = Counter(data.get("palette_counter", {}))
            self._location_counter = Counter(
                {tuple(map(float, k.split(","))): v for k, v in data.get("location_counter", {}).items()}
            )
            self._mood_scores = data.get("mood_scores", [])
            logger.info("Analytics restored from disk with %d palette items.", len(self._palette_counter))
        except Exception as exc:  # pragma: no cover
            CrashReporter().capture(exc, context="restore_from_disk")
            # Start afresh on corruption
            self._palette_counter.clear()
            self._location_counter.clear()
            self._mood_scores.clear()

    def _persist_to_disk(self) -> None:
        try:
            data = {
                "palette_counter": dict(self._palette_counter),
                "location_counter": {f"{lat},{lon}": c for (lat, lon), c in self._location_counter.items()},
                "mood_scores": self._mood_scores,
            }
            tmp_path = self._STORAGE_PATH.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(data))
            tmp_path.replace(self._STORAGE_PATH)
            logger.debug("Analytics persisted to %s", self._STORAGE_PATH)
        except Exception as exc:  # pragma: no cover
            CrashReporter().capture(exc, context="persist_to_disk")


# -----------------------------------------------------------------------------
# Prompt Suggestion Factory
# -----------------------------------------------------------------------------


class PromptSuggestionFactory:
    """
    Generates creative prompts driven by current analytics. This object is
    stateless and therefore cheap to instantiate.
    """

    # Example prompt templates
    _TEMPLATES = [
        "Use {color} as your dominant hue today!",
        "Capture an item near {location} – can you discover something new?",
        "Feeling {mood}? Remix with a contrasting palette!",
        "Trending color: {color}. How will you incorporate it?",
        "Explore around {location} and share the vibe.",
    ]

    def __init__(self, analytics: Optional[PrismAnalyticsEngine] = None) -> None:
        self._analytics = analytics or PrismAnalyticsEngine()

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def generate_prompts(self, num_prompts: int = 3) -> List[str]:
        """
        Create a list of creative prompt strings based on live analytics.
        """
        colors = [c for c, _ in self._analytics.get_trending_colors(5)]
        hotspots = [loc for loc, _ in self._analytics.get_hotspot_locations(5)]
        avg_mood = self._analytics.get_average_mood()

        prompts: List[str] = []
        idx = 0

        while len(prompts) < num_prompts and idx < len(self._TEMPLATES) * 2:
            template = self._TEMPLATES[idx % len(self._TEMPLATES)]
            idx += 1

            if "{color}" in template and colors:
                prompt = template.format(color=colors[idx % len(colors)])
            elif "{location}" in template and hotspots:
                lat, lon = hotspots[idx % len(hotspots)]
                prompt = template.format(location=f"{lat:.3f},{lon:.3f}")
            elif "{mood}" in template and avg_mood is not None:
                mood_word = self._mood_to_word(avg_mood)
                prompt = template.format(mood=mood_word)
            else:
                # Skip templates that cannot be rendered due to missing data.
                continue

            prompts.append(prompt)

        return prompts

    # --------------------------------------------------------------------- #
    # Helpers                                                               #
    # --------------------------------------------------------------------- #

    @staticmethod
    def _mood_to_word(mood_value: float) -> str:
        if mood_value >= 8:
            return "ecstatic"
        if mood_value >= 6:
            return "happy"
        if mood_value >= 4:
            return "neutral"
        if mood_value >= 2:
            return "pensive"
        return "melancholic"


# -----------------------------------------------------------------------------
# Module-level convenience functions
# -----------------------------------------------------------------------------
# These helpers are intended for quick, decoupled access from anywhere in the
# codebase without importing the classes explicitly.

def record_prism_card_event(payload: Dict[str, Any]) -> None:
    """
    Convenience wrapper that publishes a `prism_card_created` event on the bus.
    """
    EventBus().publish("prism_card_created", **payload)


def get_prompt_suggestions(n: int = 3) -> List[str]:
    """
    Syntactic sugar around `PromptSuggestionFactory.generate_prompts`.
    """
    return PromptSuggestionFactory().generate_prompts(n)


# -----------------------------------------------------------------------------
# Defensive initialisation (ensure engine is eagerly instantiated)
# -----------------------------------------------------------------------------
# This guarantees that subscriptions are active even if no other module has
# created the engine yet.

_ = PrismAnalyticsEngine()
```