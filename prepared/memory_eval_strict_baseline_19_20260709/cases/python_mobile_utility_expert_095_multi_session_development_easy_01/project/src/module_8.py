```python
"""
PrismPocket – Trend Analytics Engine
------------------------------------

This module hosts the runtime analytics layer that chews through the steady
fire-hose of PrismCard events and distils them into actionable *creative
insights*.  The resulting metrics are surfaced to the UI (live “hot–spot”
heat-maps, trending palette swatches) and to the PromptComposer that nudges
users with context-aware artistic suggestions.

Clean-Architecture position:
    ┌───────────────────────────────┐
    │  module_8.AnalyticsEngine     │  <─ Domain Services (inner ring)
    └───────────────────────────────┘
               ▲  subscribes
               │
    ┌───────────────────────────────┐
    │  Observer Bus (module_8)      │  <─ Interface Adapters
    └───────────────────────────────┘

External dependencies are purposefully kept minimal to remain friendly to
mobile cross-compile targets (BeeWare / Kivy-iOS / Chaquopy etc.).
"""

from __future__ import annotations

import collections
import dataclasses
import datetime as _dt
import functools
import json
import logging
import random
import threading
import types
import typing
import uuid
import weakref

# Public re-exports
__all__ = [
    "EventBus",
    "AnalyticsEngine",
    "TrendSnapshot",
    "PaletteMetric",
    "Hotspot",
    "PromptComposer",
    "Event",
    "EventType",
]

LOGGER = logging.getLogger("prism_pocket.analytics")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
)

T = typing.TypeVar("T")

# --------------------------------------------------------------------------- #
#  Observer / Event System
# --------------------------------------------------------------------------- #


class SingletonMeta(type):
    """Thread-safe Singleton metaclass."""

    _instances: dict[type, object] = {}
    _lock = threading.RLock()

    def __call__(cls, *args, **kwargs):  # type: ignore[misc]
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return typing.cast(object, cls._instances[cls])


class EventType(str, typing.Enum):  # type: ignore[misc]
    """Enumeration of event types flowing through the Observer bus."""

    CARD_CREATED = "card_created"
    CARD_UPDATED = "card_updated"
    CARD_DELETED = "card_deleted"
    # Engine may publish its own:
    TRENDS_REFRESHED = "trends_refreshed"


@dataclasses.dataclass(slots=True, frozen=True)
class Event:
    """Generic event container."""

    type: EventType
    payload: dict[str, typing.Any]
    emitted_at: _dt.datetime = dataclasses.field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )


class EventBus(metaclass=SingletonMeta):
    """
    Lightweight, in-process Pub/Sub hub.

    The bus purposefully avoids heavy frameworks (RxPy, pydispatch) to keep the
    dependency footprint small.  Subscribers are **weakly referenced** to
    prevent leaks when view-models are swiftly recycled by the mobile runtime.
    """

    def __init__(self) -> None:
        self._subscribers: dict[EventType, weakref.WeakSet[typing.Callable[[Event], None]]] = (
            collections.defaultdict(weakref.WeakSet)
        )
        self._lock = threading.RLock()

    def subscribe(self, event_type: EventType, callback: typing.Callable[[Event], None]) -> None:
        """Register a listener for *event_type*."""
        if not callable(callback):
            raise TypeError("callback must be callable")
        with self._lock:
            self._subscribers[event_type].add(callback)  # type: ignore[arg-type]
            LOGGER.debug("Subscriber %s added for %s", callback, event_type)

    def unsubscribe(self, event_type: EventType, callback: typing.Callable[[Event], None]) -> None:
        """Remove a previously registered listener."""
        with self._lock:
            self._subscribers.get(event_type, weakref.WeakSet()).discard(callback)
            LOGGER.debug("Subscriber %s removed from %s", callback, event_type)

    def publish(self, event: Event) -> None:
        """Broadcast *event* to all listeners."""
        listeners_copy: list[typing.Callable[[Event], None]]
        with self._lock:
            listeners_copy = list(self._subscribers.get(event.type, []))
        LOGGER.debug(
            "Publishing %s to %s listener(s) – payload: %s",
            event.type,
            len(listeners_copy),
            event.payload,
        )
        for listener in listeners_copy:
            try:
                listener(event)
            except Exception:  # pragma: no cover – defensive catch-all
                LOGGER.exception("Uncaught error in subscriber %s", listener)


# --------------------------------------------------------------------------- #
#  Domain DTOs
# --------------------------------------------------------------------------- #


@dataclasses.dataclass(slots=True, frozen=True)
class PrismCard:
    """
    *Minimal* projection of a PrismCard domain entity needed for analytics.

    Only the fields relevant to trend computation are included.  The actual
    domain entity (managed elsewhere) is vastly more feature-rich.
    """

    card_id: uuid.UUID
    created_at: _dt.datetime
    color_palette: tuple[str, ...]  # hex colours, e.g. ("#FF0000", "#00FF00")
    geo_lat: float | None = None
    geo_lon: float | None = None
    mood_score: float | None = None  # Normalised –1.0 (sad) → 1.0 (happy)


@dataclasses.dataclass(slots=True, frozen=True)
class PaletteMetric:
    hex_color: str
    count: int


@dataclasses.dataclass(slots=True, frozen=True)
class Hotspot:
    lat_round: float
    lon_round: float
    count: int


@dataclasses.dataclass(slots=True, frozen=True)
class TrendSnapshot:
    generated_at: _dt.datetime
    trending_palettes: tuple[PaletteMetric, ...]
    hotspots: tuple[Hotspot, ...]
    average_mood: float | None


# --------------------------------------------------------------------------- #
#  Analytics Engine
# --------------------------------------------------------------------------- #


class AnalyticsEngine(metaclass=SingletonMeta):
    """
    Central brain that computes live creative trends.

    The engine keeps an in-memory sliding window of the most recent N cards,
    periodically recalculates statistics, and posts `TRENDS_REFRESHED` events.
    """

    _MAX_CARD_HISTORY = 1000  # tunable: ~5 MB memory footprint

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._history: collections.deque[PrismCard] = collections.deque(maxlen=self._MAX_CARD_HISTORY)
        self._last_snapshot: TrendSnapshot | None = None

        # Subscribe to card life-cycle events
        bus = EventBus()
        bus.subscribe(EventType.CARD_CREATED, self._on_card_event)
        bus.subscribe(EventType.CARD_UPDATED, self._on_card_event)
        bus.subscribe(EventType.CARD_DELETED, self._on_card_event)

    # --------------------------------------------------------------------- #
    #  Event ingestion
    # --------------------------------------------------------------------- #

    def _on_card_event(self, event: Event) -> None:
        """Receive cards via the Observer Bus and update our sliding window."""
        try:
            card_data = event.payload["card"]
            card = _ensure_prism_card(card_data)
        except Exception as exc:  # pragma: no cover
            LOGGER.error("Invalid card event payload: %s – %s", event.payload, exc)
            return

        with self._lock:
            match event.type:
                case EventType.CARD_DELETED:
                    # Remove any matching card
                    before = len(self._history)
                    self._history = collections.deque(
                        (c for c in self._history if c.card_id != card.card_id),
                        maxlen=self._MAX_CARD_HISTORY,
                    )
                    LOGGER.debug("Deleted card %s (history len %d → %d)", card.card_id, before, len(self._history))
                case EventType.CARD_UPDATED:
                    # Replace old instance with the new one
                    self._history = collections.deque(
                        (c for c in self._history if c.card_id != card.card_id),
                        maxlen=self._MAX_CARD_HISTORY,
                    )
                    self._history.append(card)
                    LOGGER.debug("Updated card %s (history size %d)", card.card_id, len(self._history))
                case _:
                    # CARD_CREATED (or default)
                    self._history.append(card)
                    LOGGER.debug("Added card %s (history size %d)", card.card_id, len(self._history))

        # Off-load heavy recalculation onto a background thread to avoid UI jank
        threading.Thread(target=self._refresh_trends, daemon=True).start()

    # --------------------------------------------------------------------- #
    #  Trend computation
    # --------------------------------------------------------------------- #

    def _refresh_trends(self) -> None:
        """Recompute trend snapshot and broadcast the refreshed data."""
        with self._lock:
            cards = list(self._history)

        snapshot = self._compute_snapshot(cards=cards)
        self._last_snapshot = snapshot

        EventBus().publish(
            Event(type=EventType.TRENDS_REFRESHED, payload={"snapshot": snapshot})
        )

    @staticmethod
    def _compute_snapshot(cards: list[PrismCard]) -> TrendSnapshot:
        if not cards:
            now = _dt.datetime.now(tz=_dt.timezone.utc)
            empty = TrendSnapshot(
                generated_at=now,
                trending_palettes=tuple(),
                hotspots=tuple(),
                average_mood=None,
            )
            LOGGER.debug("Empty snapshot generated")
            return empty

        # Colour palette trend (top N hex colours)
        palette_counter: collections.Counter[str] = collections.Counter()
        for c in cards:
            palette_counter.update(c.color_palette)
        top_palette = tuple(
            PaletteMetric(hex_color=h, count=n) for h, n in palette_counter.most_common(6)
        )

        # Hotspot trend – round lat/lon to 1 decimal (~11 km) and count frequency
        hotspot_counter: collections.Counter[tuple[float, float]] = collections.Counter()
        for c in cards:
            if c.geo_lat is None or c.geo_lon is None:
                continue
            hotspot_counter.update([(round(c.geo_lat, 1), round(c.geo_lon, 1))])
        top_hotspots = tuple(
            Hotspot(lat_round=lat, lon_round=lon, count=n)
            for (lat, lon), n in hotspot_counter.most_common(5)
        )

        # Average mood score
        moods = [c.mood_score for c in cards if c.mood_score is not None]
        avg_mood = round(sum(moods) / len(moods), 3) if moods else None

        snapshot = TrendSnapshot(
            generated_at=_dt.datetime.now(tz=_dt.timezone.utc),
            trending_palettes=top_palette,
            hotspots=top_hotspots,
            average_mood=avg_mood,
        )
        LOGGER.info(
            "Trend snapshot computed – palettes: %d, hotspots: %d, avg_mood: %s",
            len(top_palette),
            len(top_hotspots),
            avg_mood,
        )
        return snapshot

    # --------------------------------------------------------------------- #
    #  Public API
    # --------------------------------------------------------------------- #

    def latest_snapshot(self) -> TrendSnapshot | None:
        """Retrieve the most recently computed trend snapshot."""
        with self._lock:
            return self._last_snapshot

    # Convenience method – used by PromptComposer below
    def generate_prompt(self) -> str:
        """Return one prompt based on current trends."""
        snapshot = self.latest_snapshot()
        return PromptComposer.compose(snapshot)


# --------------------------------------------------------------------------- #
#  Prompt Composer (Factory Pattern)
# --------------------------------------------------------------------------- #


class PromptComposer:
    """
    Generate ephemeral prompts for the creative canvas, inspired by analytics.

    Factory-like static interface keeps the surface minimal and pure.
    """

    _MOOD_MAP = {
        (-1.0, -0.5): "Try channeling reflective blues into a calming sketch.",
        (-0.5, 0.0): "Capture a mellow vibe with soft gradients.",
        (0.0, 0.5): "Brighten the canvas with optimistic hues!",
        (0.5, 1.1): "Go bold—celebrate the good vibes with a pop of neon!",
    }

    @classmethod
    def compose(cls, snapshot: TrendSnapshot | None) -> str:
        """
        Produce a single prompt string.  Falls back to generic prompts when
        *snapshot* is not available (e.g., cold start).
        """
        if not snapshot:
            return random.choice(
                [
                    "Add a card that captures your current mood in colour.",
                    "Spot something interesting nearby? Snap it with a Prism!",
                    "Challenge: build a palette using only shades of green.",
                ]
            )

        prompts: list[str] = []

        # Palette-based prompt
        if snapshot.trending_palettes:
            top_color = snapshot.trending_palettes[0].hex_color.upper()
            prompts.append(f"Remix a card using trending colour {top_color}.")

        # Location-based prompt
        if snapshot.hotspots:
            lat, lon = snapshot.hotspots[0].lat_round, snapshot.hotspots[0].lon_round
            prompts.append(f"Create a postcard for your {lat:.1f}°, {lon:.1f}° hotspot.")

        # Mood-based prompt
        if snapshot.average_mood is not None:
            mood_prompt = cls._resolve_mood_prompt(snapshot.average_mood)
            if mood_prompt:
                prompts.append(mood_prompt)

        if not prompts:
            prompts.append("Document a moment with PrismPocket today!")

        selected = random.choice(prompts)
        LOGGER.debug("Prompt composed: %s", selected)
        return selected

    @classmethod
    def _resolve_mood_prompt(cls, mood_score: float) -> str | None:
        """Map mood score into a textual suggestion."""
        for (lo, hi), text in cls._MOOD_MAP.items():
            if lo <= mood_score < hi:
                return text
        return None


# --------------------------------------------------------------------------- #
#  Utility functions
# --------------------------------------------------------------------------- #


def _ensure_prism_card(card_data: PrismCard | dict[str, typing.Any]) -> PrismCard:
    """
    Accept either a *PrismCard* instance or a mapping of raw data, returning a
    validated *PrismCard* object.

    The loose contract lets calling layers pass JSON dictionaries without
    instantiating domain objects themselves.
    """
    if isinstance(card_data, PrismCard):
        return card_data

    required = {"card_id", "created_at", "color_palette"}
    missing = required.difference(card_data)
    if missing:
        raise ValueError(f"Missing fields in card data: {', '.join(missing)}")

    card_id = (
        card_data["card_id"]
        if isinstance(card_data["card_id"], uuid.UUID)
        else uuid.UUID(card_data["card_id"])
    )
    created_at = (
        card_data["created_at"]
        if isinstance(card_data["created_at"], _dt.datetime)
        else _dt.datetime.fromisoformat(card_data["created_at"])
    )
    color_palette = tuple(card_data["color_palette"])

    return PrismCard(
        card_id=card_id,
        created_at=created_at,
        color_palette=color_palette,
        geo_lat=card_data.get("geo_lat"),
        geo_lon=card_data.get("geo_lon"),
        mood_score=card_data.get("mood_score"),
    )


# --------------------------------------------------------------------------- #
#  Quick self-test
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover  – manual smoke test
    bus = EventBus()
    engine = AnalyticsEngine()

    def on_trend(event: Event) -> None:
        LOGGER.info(">>> Trends refreshed! %s", json.dumps(dataclasses.asdict(event.payload["snapshot"]), default=str))

    bus.subscribe(EventType.TRENDS_REFRESHED, on_trend)

    # Fabricate synthetic events
    for i in range(10):
        card = {
            "card_id": str(uuid.uuid4()),
            "created_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
            "color_palette": [f"#{random.randint(0, 0xFFFFFF):06X}", "#00FF00"],
            "geo_lat": 37.77 + random.random(),
            "geo_lon": -122.43 + random.random(),
            "mood_score": random.uniform(-1, 1),
        }
        bus.publish(Event(EventType.CARD_CREATED, payload={"card": card}))

    # Generate prompt
    threading.Event().wait(1)
    print("Prompt →", engine.generate_prompt())
```