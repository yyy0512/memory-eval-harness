"""PrismPocket – Analytics & Prompt Generation Module (module_80)

This module is responsible for analysing PrismCards that exist in local or
remote repositories and producing insight-driven prompts that feed the
creative–prompt engine on device.  The workflow is roughly as follows:

1. TrendAnalyticsService (Singleton)
   ├─ Pulls card data from an IPrismCardRepository implementation
   ├─ Computes colour palette metrics, hotspot locations and mood statistics
   └─ Publishes a TrendReport on a lightweight in-process EventBus

2. SuggestionFactory
   ├─ Listens for TrendReport events
   └─ Generates human-readable Prompt objects tailored to current trends

Architecture patterns in play:
• Repository Pattern        → IPrismCardRepository abstraction
• Singleton                 → TrendAnalyticsService instance-gating
• Observer (Pub/Sub)        → EventBus
• Factory Pattern           → SuggestionFactory.create_prompt
"""

from __future__ import annotations

import itertools
import logging
import math
import random
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Callable, Dict, Iterable, List, Mapping, MutableMapping, Sequence, Tuple

# --------------------------------------------------------------------------------------
# Logging configuration
# --------------------------------------------------------------------------------------

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Add a NullHandler for library-style safe import; real app adds Stream/File handlers.
logging.getLogger(__name__).addHandler(logging.NullHandler())

# --------------------------------------------------------------------------------------
# Generic EventBus (Observer Pattern)
# --------------------------------------------------------------------------------------


class EventBus:
    """A lightweight, threadsafe in-process event bus suited for UI–thread pub/sub
    without the overhead of Rx or other heavy frameworks.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers: MutableMapping[str, List[Callable[..., None]]] = defaultdict(list)

    def subscribe(self, event_name: str, callback: Callable[..., None]) -> None:
        """Register a callback for an event."""
        with self._lock:
            self._subscribers[event_name].append(callback)
            logger.debug("Subscriber %s registered to event '%s'", callback, event_name)

    def unsubscribe(self, event_name: str, callback: Callable[..., None]) -> None:
        """Remove a previously registered callback."""
        with self._lock:
            if event_name in self._subscribers:
                self._subscribers[event_name] = [
                    c for c in self._subscribers[event_name] if c is not callback
                ]
                logger.debug("Subscriber %s removed from event '%s'", callback, event_name)

    def publish(self, event_name: str, *args, **kwargs) -> None:
        """Synchronously publish data to all listeners."""
        with self._lock:
            callbacks = list(self._subscribers.get(event_name, []))
        logger.debug("Publishing event '%s' to %d subscriber(s)", event_name, len(callbacks))
        for callback in callbacks:
            try:
                callback(*args, **kwargs)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Error while dispatching event '%s' to %s", event_name, callback)


EVENT_BUS = EventBus()

# --------------------------------------------------------------------------------------
# Domain Models
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PrismCard:
    """Domain entity describing a single PrismCard."""
    card_id: str
    created_at: datetime
    colors: Sequence[str]  # Hex codes e.g. ["#FFAA33", "#102030", …]
    location: Tuple[float, float] | None  # (latitude, longitude) or None if unknown
    mood_score: float  # –1.0 (sad) ... +1.0 (happy)
    card_type: str  # e.g. 'text', 'photo', 'voice'


@dataclass(frozen=True)
class TrendReport:
    """Analytics output summarising current user trends."""
    generated_at: datetime
    top_colors: List[str]
    hotspot_location: Tuple[float, float] | None  # centric lat, lon
    average_mood: float
    total_cards: int


@dataclass(frozen=True)
class Prompt:
    """Creative prompt sent to ViewModels."""
    text: str
    trend_ref: TrendReport


# --------------------------------------------------------------------------------------
# Repository Pattern
# --------------------------------------------------------------------------------------


class IPrismCardRepository:
    """Repository abstraction that hides source of PrismCards (local DB, Cloud, etc.)."""

    def get_cards(self, since: datetime | None = None) -> Iterable[PrismCard]:
        """Return PrismCards created after the given timestamp (inclusive)."""
        raise NotImplementedError


class InMemoryPrismCardRepository(IPrismCardRepository):
    """Minimal in-memory repository primarily for testing & fallback offline use."""

    def __init__(self, initial_cards: Iterable[PrismCard] | None = None) -> None:
        self._lock = threading.RLock()
        self._cards: List[PrismCard] = list(initial_cards) if initial_cards else []

    # CRUD helpers ---------------------------------------------------------------------

    def add_card(self, card: PrismCard) -> None:
        with self._lock:
            self._cards.append(card)
            logger.debug("Card %s added to repository", card.card_id)

    # Repository interface -------------------------------------------------------------

    def get_cards(self, since: datetime | None = None) -> Iterable[PrismCard]:
        with self._lock:
            if since is None:
                return list(self._cards)
            return [card for card in self._cards if card.created_at >= since]


# --------------------------------------------------------------------------------------
# Singleton meta (thread-safe lazy init)
# --------------------------------------------------------------------------------------


class _SingletonMeta(type):
    _instances: Dict[type, "TrendAnalyticsService"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------------------
# Analytics Engine
# --------------------------------------------------------------------------------------


class TrendAnalyticsService(metaclass=_SingletonMeta):
    """Crunches PrismCard data and publishes TrendReports."""

    EVENT_TREND_READY = "trend_report_ready"

    # Geo clustering tunables
    _EARTH_RADIUS_KM = 6371.0088

    def __init__(self, repository: IPrismCardRepository) -> None:
        self._repo = repository
        self._last_run: datetime | None = None
        self._lock = threading.RLock()

    # Public API -----------------------------------------------------------------------

    def run(self, force: bool = False, window: timedelta = timedelta(days=7)) -> TrendReport | None:
        """Executes analysis pipeline if due. Returns latest TrendReport or None if skipped.

        Arguments
        ---------
        force   : if True, run regardless of last_run timestamp.
        window  : sliding time window for data considered part of "current" trends.
        """
        with self._lock:
            if not force and self._last_run and (datetime.now(timezone.utc) - self._last_run) < timedelta(minutes=15):
                logger.info("Analytics skipped; last run too recent.")
                return None

            since = datetime.now(timezone.utc) - window
            cards = list(self._repo.get_cards(since=since))
            logger.info("Fetched %d cards for analysis (since %s)", len(cards), since.isoformat())

            if not cards:
                logger.info("No cards available for trend analysis.")
                return None

            report = self._compute_trends(cards)
            self._last_run = datetime.now(timezone.utc)

        EVENT_BUS.publish(self.EVENT_TREND_READY, report)
        return report

    # Internal helpers -----------------------------------------------------------------

    def _compute_trends(self, cards: List[PrismCard]) -> TrendReport:
        """Aggregate incoming cards into a TrendReport."""
        top_colors = self._extract_top_colors(cards, limit=5)
        hotspot = self._compute_hotspot(cards)
        avg_mood = self._compute_average_mood(cards)

        report = TrendReport(
            generated_at=datetime.now(timezone.utc),
            top_colors=top_colors,
            hotspot_location=hotspot,
            average_mood=avg_mood,
            total_cards=len(cards),
        )
        logger.debug("TrendReport generated: %s", report)
        return report

    @staticmethod
    def _extract_top_colors(cards: List[PrismCard], limit: int = 5) -> List[str]:
        """Return top N colours across cards."""
        counter: Counter[str] = Counter(
            color.lower()
            for card in cards
            for color in card.colors
            if color  # guard against empty strings
        )
        most_common = [color for color, _ in counter.most_common(limit)]
        logger.debug("Top colours extracted: %s", most_common)
        return most_common

    def _compute_hotspot(self, cards: List[PrismCard]) -> Tuple[float, float] | None:
        """Compute the geographic centroid for most popular location cluster."""
        locations = [c.location for c in cards if c.location is not None]
        if not locations:
            return None

        # Simple K-means with k=1 (centroid) – we assume one hotspot for UX simplicity.
        latitudes, longitudes = zip(*locations)
        centroid = (mean(latitudes), mean(longitudes))
        logger.debug("Hotspot centroid calculated: %s", centroid)
        return centroid

    @staticmethod
    def _compute_average_mood(cards: List[PrismCard]) -> float:
        moods = [c.mood_score for c in cards]
        avg = mean(moods) if moods else 0.0
        logger.debug("Average mood score: %.3f", avg)
        return avg


# --------------------------------------------------------------------------------------
# Prompt Factory
# --------------------------------------------------------------------------------------


class SuggestionFactory:
    """Generates prompts from TrendReports using Factory Pattern."""

    MOOD_ADJECTIVES = {
        "positive": ["vibrant", "joyful", "radiant", "lively"],
        "neutral": ["subtle", "calm", "minimal"],
        "negative": ["moody", "soft-hued", "muted", "dreamy"],
    }

    COLOR_TEMPLATES = [
        "Try blending {colors} into your next card!",
        "Feeling inspired by {colors}? Craft a scene with them.",
        "Make {colors} the hero palette of your new prism card.",
    ]

    LOCATION_TEMPLATES = [
        "Explore creativity around {lat:.2f}°, {lon:.2f}°!",
        "Your {city} moments are trending—add another?",
    ]

    def __init__(self) -> None:
        EVENT_BUS.subscribe(TrendAnalyticsService.EVENT_TREND_READY, self._on_trend_update)

    # -------------------------------------------------------------------------
    # Event Listener
    # -------------------------------------------------------------------------

    def _on_trend_update(self, report: TrendReport) -> None:
        prompt = self.create_prompt(report)
        EVENT_BUS.publish("prompt_ready", prompt)
        logger.info("Prompt generated & published: %s", prompt.text)

    # -------------------------------------------------------------------------
    # Factory method
    # -------------------------------------------------------------------------

    def create_prompt(self, report: TrendReport) -> Prompt:
        """Return a creative Prompt based on TrendReport features."""
        fragments: List[str] = []

        # Colour-driven prompt
        if report.top_colors:
            colors_str = ", ".join(report.top_colors[:3])
            color_phrase = random.choice(self.COLOR_TEMPLATES).format(colors=colors_str)
            fragments.append(color_phrase)

        # Mood-driven prompt
        mood_adj = self._select_mood_adj(report.average_mood)
        fragments.append(f"Capture a {mood_adj} moment today.")

        # Location-driven prompt
        if report.hotspot_location:
            lat, lon = report.hotspot_location
            loc_phrase = random.choice(self.LOCATION_TEMPLATES).format(lat=lat, lon=lon, city="your city")
            fragments.append(loc_phrase)

        prompt_text = " ".join(fragments)
        return Prompt(text=prompt_text, trend_ref=report)

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------

    def _select_mood_adj(self, mood_value: float) -> str:
        if mood_value > 0.25:
            bucket = "positive"
        elif mood_value < -0.25:
            bucket = "negative"
        else:
            bucket = "neutral"
        adjective = random.choice(self.MOOD_ADJECTIVES[bucket])
        logger.debug("Mood adjective selected: %s (%s)", adjective, bucket)
        return adjective


# --------------------------------------------------------------------------------------
# Convenience boot-strap for unit tests / manual runs
# --------------------------------------------------------------------------------------

def _bootstrap_demo() -> None:  # pragma: no cover
    """Quick and dirty demo run if this module is executed directly."""
    import uuid
    from pprint import pprint

    # Add stdout logging for the demo
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    logging.getLogger(__name__).addHandler(handler)
    logging.getLogger(__name__).setLevel(logging.DEBUG)

    # Create repository and seed with random cards
    repo = InMemoryPrismCardRepository()
    tz = timezone.utc
    now = datetime.now(tz)

    for i in range(50):
        repo.add_card(
            PrismCard(
                card_id=str(uuid.uuid4()),
                created_at=now - timedelta(hours=random.randint(0, 168)),  # last 7 days
                colors=random.sample(
                    ["#FF5733", "#33C1FF", "#FF33D4", "#8DFF33", "#F1C40F", "#9B59B6", "#2ECC71"], k=3
                ),
                location=(37.7749 + random.uniform(-0.05, 0.05), -122.4194 + random.uniform(-0.05, 0.05)),
                mood_score=random.uniform(-1, 1),
                card_type=random.choice(["photo", "text", "voice"]),
            )
        )

    # Instantiate analytics service and suggestion factory
    analytics_service = TrendAnalyticsService(repository=repo)
    _ = SuggestionFactory()  # subscribes to events

    report = analytics_service.run(force=True)
    pprint(report)

    # Wait a moment to receive prompt event
    import time

    def print_prompt(prompt: Prompt) -> None:
        print("\nPrompt received:", prompt.text)

    EVENT_BUS.subscribe("prompt_ready", print_prompt)
    time.sleep(1)


if __name__ == "__main__":  # pragma: no cover
    _bootstrap_demo()
