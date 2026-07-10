```python
"""
src/module_6.py

Analytics & Trend-prompt engine for PrismPocket.
Consumes PrismCard events from the global Observer bus, aggregates metrics in
real-time, and emits contextual creative prompts back onto the bus.

This module purposefully sits in the “domain service” ring: it is pure
business logic with zero knowledge of UI, persistence, or platform APIs.
"""

from __future__ import annotations

import itertools
import logging
import random
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, auto
from typing import Callable, Dict, Iterable, List, Optional, Tuple, Type, Union

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Domain model stubs (would ordinarily live in prism_pocket.domain.entities)  #
# --------------------------------------------------------------------------- #


class CardType(Enum):
    TEXT = auto()
    IMAGE = auto()
    VOICE = auto()
    GEO = auto()
    MIXED = auto()


@dataclass(frozen=True)
class PrismCard:
    """
    Minimal representation of a PrismCard for analytics purposes.
    The authoritative definition lives in the domain layer; this is a
    lightweight–duplicate to minimise import coupling.
    """

    id: str
    user_id: str
    card_type: CardType
    colors: Tuple[str, ...]  # Normalised 6-digit hex values (e.g., '#FF5733')
    location: Optional[Tuple[float, float]]  # (lat, lon) in WGS-84
    mood_score: Optional[int]  # 0–100 inclusive
    created_at: datetime

    def dominant_color(self) -> Optional[str]:
        """
        Returns the first colour if available. In production we would compute
        a true dominant swatch from pixel data.
        """
        return self.colors[0] if self.colors else None


# --------------------------------------------------------------------------- #
# Observer / Event bus                                                        #
# --------------------------------------------------------------------------- #


class EventType(Enum):
    CARD_ADDED = auto()
    CARD_UPDATED = auto()
    PROMPT_AVAILABLE = auto()  # Emitted by analytics back to the bus


@dataclass(frozen=True)
class Event:
    """
    Generic bus event: payload semantics vary by `event_type`.
    """
    event_type: EventType
    payload: Union[PrismCard, "Prompt"]


class _EventBus:
    """
    Lightweight synchronous pub/sub bus.

    This is *not* intended to replace a robust reactive framework; it is just
    enough to demonstrate module behaviour without external dependencies.
    """

    _instance: Optional["_EventBus"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "_EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[
                    EventType, List[Callable[[Event], None]]
                ] = defaultdict(list)
        return cls._instance

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: EventType, handler: Callable[[Event], None]) -> None:
        logger.debug("Subscribing handler %s to event %s", handler, event_type)
        self._subscribers[event_type].append(handler)

    def publish(self, event: Event) -> None:
        """
        Publish an event synchronously. Handlers execute in FIFO order on the
        calling thread; callers should offload heavy-weight work.
        """
        handlers = self._subscribers.get(event.event_type, [])
        logger.debug(
            "Publishing %s to %d subscribers", event.event_type, len(handlers)
        )
        for handler in handlers:
            try:
                handler(event)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Unhandled exception in bus handler: %s", exc)


# Global, module-level bus instance
event_bus = _EventBus()

# --------------------------------------------------------------------------- #
# Trend aggregation                                                           #
# --------------------------------------------------------------------------- #


@dataclass
class TrendSnapshot:
    """
    Immutable snapshot representing creative trends over a sliding window.
    """
    generated_at: datetime
    top_palette: List[str]  # Hex colours
    hotspot_locations: List[Tuple[float, float]]
    prevailing_mood: Optional[str]


class _RollingCounter:
    """
    Thread-safe counter that keeps only the `maxlen` most-recent increments
    in memory to prevent unbounded growth on long-running sessions.
    """

    def __init__(self, maxlen: int = 2_000) -> None:
        self._deque: "collections.deque[str]" = collections.deque(maxlen=maxlen)
        self._counter: Counter[str] = Counter()
        self._lock = threading.Lock()

    def add(self, item: str) -> None:
        with self._lock:
            if len(self._deque) == self._deque.maxlen:  # purge oldest
                oldest = self._deque.popleft()
                self._counter[oldest] -= 1
                if self._counter[oldest] <= 0:
                    del self._counter[oldest]
            self._deque.append(item)
            self._counter[item] += 1

    def top(self, n: int) -> List[str]:
        with self._lock:
            return [color for color, _ in self._counter.most_common(n)]

    def __len__(self) -> int:
        return len(self._deque)


class AnalyticsEngine:
    """
    Aggregates creative usage patterns and emits prompt suggestions.

    Implements the Singleton pattern via module-level instantiation.
    """

    _instance: Optional["AnalyticsEngine"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "AnalyticsEngine":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init()
        return cls._instance

    # --------------------------------------------------------------------- #
    # Initialisation & subscription                                         #
    # --------------------------------------------------------------------- #

    def _init(self) -> None:
        self._color_counter: Counter[str] = Counter()
        self._location_counter: Counter[str] = Counter()
        self._mood_counter: Counter[str] = Counter()
        self._snapshot_lock = threading.Lock()
        # Subscribe to card events
        event_bus.subscribe(EventType.CARD_ADDED, self._handle_card_event)
        logger.info("AnalyticsEngine initialised and subscribed to CARD_ADDED.")

    # --------------------------------------------------------------------- #
    # Event handling                                                        #
    # --------------------------------------------------------------------- #

    def _handle_card_event(self, event: Event) -> None:
        if not isinstance(event.payload, PrismCard):
            logger.warning("Unexpected payload type: %s", type(event.payload))
            return
        try:
            self._process_card(event.payload)
            snapshot = self._build_snapshot()
            prompt = SuggestionFactory.build_prompt(snapshot)
            if prompt:
                logger.debug("Prompt generated: %s", prompt.text)
                event_bus.publish(Event(EventType.PROMPT_AVAILABLE, prompt))
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Analytics processing failed: %s", exc)

    # --------------------------------------------------------------------- #
    # Core processing                                                       #
    # --------------------------------------------------------------------- #

    def _process_card(self, card: PrismCard) -> None:
        logger.debug("Processing card %s", card.id)
        # Aggregate colour usage
        for color in card.colors:
            normalised = color.upper()
            self._color_counter[normalised] += 1

        # Aggregate locations (rounded to ~100m grid to preserve privacy)
        if card.location:
            lat, lon = card.location
            coarse_key = f"{round(lat, 3)}:{round(lon,3)}"
            self._location_counter[coarse_key] += 1

        # Aggregate mood buckets
        if card.mood_score is not None:
            mood_bucket = self._bucket_mood(card.mood_score)
            self._mood_counter[mood_bucket] += 1

    @staticmethod
    def _bucket_mood(score: int) -> str:
        if score < 30:
            return "somber"
        if score < 70:
            return "neutral"
        return "uplifting"

    # --------------------------------------------------------------------- #
    # Snapshot generation                                                   #
    # --------------------------------------------------------------------- #

    def _build_snapshot(self) -> TrendSnapshot:
        with self._snapshot_lock:
            top_palette = [c for c, _ in self._color_counter.most_common(5)]
            hotspots = [
                tuple(map(float, key.split(":"))) for key, _ in self._location_counter.most_common(3)
            ]
            prevailing_mood = (
                self._mood_counter.most_common(1)[0][0]
                if self._mood_counter
                else None
            )
            snapshot = TrendSnapshot(
                generated_at=datetime.utcnow(),
                top_palette=top_palette,
                hotspot_locations=hotspots,
                prevailing_mood=prevailing_mood,
            )
            logger.debug("Trend snapshot built: %s", snapshot)
            return snapshot


# --------------------------------------------------------------------------- #
# Prompt generation                                                           #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Prompt:
    """
    Creative suggestion emitted to the presentation layer.
    """

    text: str
    metadata: Dict[str, Union[str, float, int]] = field(default_factory=dict)


class PromptStrategy:
    """
    Strategy interface for converting a trend snapshot into a prompt.
    """

    def build(self, snapshot: TrendSnapshot) -> Optional[Prompt]:
        raise NotImplementedError


class PalettePromptStrategy(PromptStrategy):
    def build(self, snapshot: TrendSnapshot) -> Optional[Prompt]:
        if not snapshot.top_palette:
            return None
        joined = ", ".join(snapshot.top_palette)
        text = f"🌈 Try remixing with today's trending colours: {joined}"
        return Prompt(text=text, metadata={"palette": snapshot.top_palette})


class LocationPromptStrategy(PromptStrategy):
    def build(self, snapshot: TrendSnapshot) -> Optional[Prompt]:
        if not snapshot.hotspot_locations:
            return None
        lat, lon = random.choice(snapshot.hotspot_locations)
        text = (
            f"📍 Lots of creativity buzzing around ({lat:.3f}, {lon:.3f}). "
            "Capture something there!"
        )
        return Prompt(
            text=text,
            metadata={"location": {"lat": lat, "lon": lon}},
        )


class MoodPromptStrategy(PromptStrategy):
    def build(self, snapshot: TrendSnapshot) -> Optional[Prompt]:
        if not snapshot.prevailing_mood:
            return None
        mood_emoji = {
            "somber": "🖤",
            "neutral": "🎨",
            "uplifting": "💖",
        }.get(snapshot.prevailing_mood, "✨")
        text = f"{mood_emoji} Feeling {snapshot.prevailing_mood}? Translate that mood into a new prism!"
        return Prompt(text=text, metadata={"mood": snapshot.prevailing_mood})


class SuggestionFactory:
    """
    Factory that decides which prompt strategy to apply based on heuristic
    weightings of the trend snapshot.
    """

    _strategies: List[Type[PromptStrategy]] = [
        PalettePromptStrategy,
        LocationPromptStrategy,
        MoodPromptStrategy,
    ]

    @classmethod
    def build_prompt(cls, snapshot: TrendSnapshot) -> Optional[Prompt]:
        for strategy_cls in cls._strategies:
            strategy = strategy_cls()
            prompt = strategy.build(snapshot)
            if prompt:
                logger.debug(
                    "Prompt generated by %s: %s", strategy_cls.__name__, prompt.text
                )
                return prompt
        logger.debug("No prompt generated for snapshot.")
        return None


# --------------------------------------------------------------------------- #
# Bootstrap                                                                   #
# --------------------------------------------------------------------------- #

# Instantiate singleton & subscribe automatically
analytics_engine = AnalyticsEngine()

__all__ = [
    "PrismCard",
    "CardType",
    "Event",
    "EventType",
    "event_bus",
    "Prompt",
    "TrendSnapshot",
    "analytics_engine",
]

# --------------------------------------------------------------------------- #
# Self-test                                                                   #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    # Only executes when running this module directly; does not fire in prod.
    demo_card = PrismCard(
        id="demo-1",
        user_id="alice",
        card_type=CardType.IMAGE,
        colors=("#FF5733", "#FFBD33", "#33C1FF"),
        location=(51.5074, -0.1278),  # London
        mood_score=87,
        created_at=datetime.utcnow(),
    )

    def prompt_printer(event: Event) -> None:
        if isinstance(event.payload, Prompt):
            logger.info("PROMPT RECEIVED: %s", event.payload.text)

    event_bus.subscribe(EventType.PROMPT_AVAILABLE, prompt_printer)
    # Publish a few demo events
    for _ in range(5):
        event_bus.publish(Event(EventType.CARD_ADDED, demo_card))
```