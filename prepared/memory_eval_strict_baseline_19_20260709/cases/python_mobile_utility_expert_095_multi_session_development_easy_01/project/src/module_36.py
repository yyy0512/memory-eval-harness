```python
"""
src/module_36.py

Color-centric analytics for PrismPocket.

This module contains a micro, yet production-grade, analytics engine that inspects
PrismCard instances persisted in any repository implementation, derives palette
metrics (dominant swatches, mood score, usage count, etc.), and streams the
results through a lightweight, thread-safe Observer bus.

The engine is purpose-built for *live* usage in the mobile client, but it
remains platform-agnostic—it may be executed on the handset, a background
worker, or a serverless cloud function.

Architecture Patterns Demonstrated
----------------------------------
• Repository Pattern – decouples data access from analytics.
• Observer Pattern    – pushes incremental analytics to subscribers in
                        real time (e.g., ViewModels, widgets, or cloud sync).
• Singleton           – guarantees a single event bus instance.
• Factory Pattern     – (internal) used to provision repositories.

All public classes are crafted for testability and may be replaced with fakes
or mocks during unit testing.
"""
from __future__ import annotations

import logging
import threading
import time
from abc import ABC, abstractmethod
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import mean
from typing import Callable, Deque, Dict, Iterable, List, Mapping, MutableMapping, Optional, Sequence, Tuple

# ------------------------------------------------------------------------------
# Logging configuration
# ------------------------------------------------------------------------------

LOGGER = logging.getLogger("prism.analytics")
LOGGER.addHandler(logging.NullHandler())


# ------------------------------------------------------------------------------
# Domain Entities
# ------------------------------------------------------------------------------

@dataclass(frozen=True)
class PrismCard:
    """
    A minimal, self-contained representation of a PrismCard that analytics needs.
    """
    card_id: str
    user_id: str
    created_at: datetime
    colors: Tuple[str, ...]  # Hex colors, e.g., "#FFAA00"
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@dataclass(frozen=True)
class PaletteMetric:
    """
    Metric object surfaced by the analytics engine.
    """
    palette_signature: Tuple[str, ...]      # Ordered palette for easy hashing
    dominant_color: str                     # Color with highest frequency
    usage_count: int                        # Number of cards that used palette
    average_mood_score: float               # Mean mood score of the palette
    last_occurrence: datetime               # Last time the palette was seen


# ------------------------------------------------------------------------------
# Repository contracts
# ------------------------------------------------------------------------------

class CardRepository(ABC):
    """
    Repository interface. Concrete implementations (SQLite, REST, etc.)
    must implement *all* methods below.
    """

    @abstractmethod
    def fetch_cards_since(self, timestamp: datetime) -> Iterable[PrismCard]:
        """
        Return all PrismCards created after *timestamp* (inclusive).
        """
        raise NotImplementedError

    @abstractmethod
    def all_cards(self) -> Iterable[PrismCard]:
        """
        Return a full snapshot of all cards. May be expensive; used
        only for cold starts.
        """
        raise NotImplementedError


# ------------------------------------------------------------------------------
# Observer Bus (Singleton)
# ------------------------------------------------------------------------------

class ObserverBus:
    """
    Thread-safe, singleton event bus for pub/sub mechanics—lightweight and
    dependency-free.
    """
    _INSTANCE: Optional["ObserverBus"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "ObserverBus":
        with cls._lock:
            if cls._INSTANCE is None:
                cls._INSTANCE = super().__new__(cls)
                cls._INSTANCE._subscribers: MutableMapping[str, List[Callable]] = {}
                cls._INSTANCE._bus_lock = threading.RLock()
        return cls._INSTANCE

    def subscribe(self, event_name: str, callback: Callable) -> None:
        """
        Register *callback* to be called whenever *event_name* occurs.
        """
        with self._bus_lock:
            self._subscribers.setdefault(event_name, []).append(callback)
            LOGGER.debug("Observer subscribed to %s; total=%d",
                         event_name, len(self._subscribers[event_name]))

    def unsubscribe(self, event_name: str, callback: Callable) -> None:
        """
        Unregister *callback* from *event_name*.
        """
        with self._bus_lock:
            try:
                self._subscribers[event_name].remove(callback)
                LOGGER.debug("Observer unsubscribed from %s; total=%d",
                             event_name, len(self._subscribers[event_name]))
            except (KeyError, ValueError):
                LOGGER.warning("Attempt to unsubscribe unknown callback from %s", event_name)

    def publish(self, event_name: str, payload) -> None:  # noqa: ANN001 – generic payload
        """
        Publish *payload* under *event_name*. Subscribers will be invoked in
        the publication thread's context—dispatch responsibility lies on them.
        """
        with self._bus_lock:
            callbacks = tuple(self._subscribers.get(event_name, []))
        for cb in callbacks:
            try:
                cb(payload)
            except Exception:  # pragma: no cover
                LOGGER.exception("Error while delivering %s to %r", event_name, cb)


# ------------------------------------------------------------------------------
# Color Utilities
# ------------------------------------------------------------------------------

def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """
    Convert #RRGGBB string to RGB ints (0-255).
    """
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        raise ValueError(f"Invalid hex color: {hex_color}")
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (0, 2, 4))
    return r, g, b


def _rgb_to_hsv(r: int, g: int, b: int) -> Tuple[float, float, float]:
    """
    Convert RGB (0-255) to HSV (0-1 floats). Implements a lightweight
    conversion to avoid external deps.
    """
    r, g, b = [x / 255.0 for x in (r, g, b)]
    c_max, c_min = max(r, g, b), min(r, g, b)
    delta = c_max - c_min

    # Hue calculation
    if delta == 0:
        h = 0.0
    elif c_max == r:
        h = (60 * ((g - b) / delta) + 360) % 360
    elif c_max == g:
        h = (60 * ((b - r) / delta) + 120) % 360
    else:
        h = (60 * ((r - g) / delta) + 240) % 360

    # Saturation
    s = 0.0 if c_max == 0 else delta / c_max

    # Value
    v = c_max

    return h / 360.0, s, v


def calculate_mood_score(colors: Sequence[str]) -> float:
    """
    Generate a naive, yet empirically effective "mood score" within [0, 1].
    The formula rewards bright, saturated palettes while penalizing dullness.
    """
    hsv_values = []
    for col in colors:
        try:
            hsv_values.append(_rgb_to_hsv(*_hex_to_rgb(col)))
        except ValueError:
            LOGGER.warning("Skipping malformed color %s", col)

    if not hsv_values:
        return 0.0

    _, s_values, v_values = zip(*hsv_values)  # h ignored for now
    return round((mean(s_values) * 0.6) + (mean(v_values) * 0.4), 3)


# ------------------------------------------------------------------------------
# Analytics Engine
# ------------------------------------------------------------------------------

class PaletteAnalyticsService:
    """
    Derives palette metrics across PrismCards and broadcasts updates.

    Typical usage:

        service = PaletteAnalyticsService(repo)
        service.refresh_metrics()  # cold start
        # engine auto-publishes events on the ObserverBus
    """

    #: Observer event emitted when *any* palette metric is updated
    EVT_METRICS_UPDATED = "analytics.palette_metrics.updated"

    #: Sliding time window (in seconds) for trending detection
    TREND_WINDOW_SEC = 60 * 60 * 3  # 3 hours

    def __init__(self, repository: CardRepository, bus: ObserverBus | None = None) -> None:
        self._repo = repository
        self._bus = bus or ObserverBus()
        self._palette_index: Dict[Tuple[str, ...], PaletteMetric] = {}
        self._recent_events: Deque[Tuple[datetime, Tuple[str, ...]]] = deque()
        self._lock = threading.RLock()
        self._last_refresh: datetime = datetime.utcfromtimestamp(0)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def refresh_metrics(self) -> None:
        """
        Refresh palette metrics by scanning newly created cards.

        • Cold start: scans entire repository.
        • Incremental: processes only cards created since last refresh.
        """
        with self._lock:
            since = self._last_refresh
            LOGGER.debug("Refreshing palette metrics since %s", since.isoformat())
            try:
                cards_iter = (
                    self._repo.all_cards() if since == datetime.utcfromtimestamp(0)
                    else self._repo.fetch_cards_since(since)
                )
            except Exception as exc:  # pragma: no cover
                LOGGER.exception("Repository failure during metric refresh: %s", exc)
                return

            new_metrics: List[PaletteMetric] = []

            for card in cards_iter:
                sig = tuple(sorted(set(card.colors)))
                if not sig:
                    continue

                # Update occurrence counter
                current = self._palette_index.get(sig)
                mood = calculate_mood_score(sig)
                if current:
                    updated = PaletteMetric(
                        palette_signature=sig,
                        dominant_color=self._select_dominant_color(sig),
                        usage_count=current.usage_count + 1,
                        average_mood_score=round(
                            ((current.average_mood_score * current.usage_count) + mood)
                            / (current.usage_count + 1),
                            3,
                        ),
                        last_occurrence=card.created_at,
                    )
                else:
                    updated = PaletteMetric(
                        palette_signature=sig,
                        dominant_color=self._select_dominant_color(sig),
                        usage_count=1,
                        average_mood_score=mood,
                        last_occurrence=card.created_at,
                    )
                self._palette_index[sig] = updated
                new_metrics.append(updated)

                # Keep a sliding window for trending analytics
                self._recent_events.append((card.created_at, sig))

            # Shrink sliding window
            boundary = datetime.utcnow() - timedelta(seconds=self.TREND_WINDOW_SEC)
            while self._recent_events and self._recent_events[0][0] < boundary:
                self._recent_events.popleft()

            self._last_refresh = datetime.utcnow()

        if new_metrics:
            self._bus.publish(self.EVT_METRICS_UPDATED, new_metrics)
            LOGGER.info("Published %d new/updated palette metrics", len(new_metrics))

    def top_palettes(self, limit: int = 5) -> List[PaletteMetric]:
        """
        Return the *limit* most frequent palettes observed since cold start.
        """
        with self._lock:
            sorted_palettes = sorted(
                self._palette_index.values(),
                key=lambda m: (-m.usage_count, -m.average_mood_score),
            )
            return sorted_palettes[:limit]

    def trending_palettes(self, limit: int = 5) -> List[PaletteMetric]:
        """
        Return palettes most used within the recent TREND_WINDOW_SEC.
        """
        with self._lock:
            counter: Counter[Tuple[str, ...]] = Counter(sig for _, sig in self._recent_events)
            most_common = counter.most_common(limit)
            return [self._palette_index[sig] for sig, _ in most_common]

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    @staticmethod
    def _select_dominant_color(colors: Sequence[str]) -> str:
        """
        Naively select the brightest color as dominant (could be replaced
        with advanced K-Means or neural inference in future versions).
        """
        def brightness(hex_color: str) -> float:
            r, g, b = _hex_to_rgb(hex_color)
            return (r * 299 + g * 587 + b * 114) / 1000  # perceived luminance

        return max(colors, key=brightness)


# ------------------------------------------------------------------------------
# Sample In-Memory Repository (for unit tests / demo)
# ------------------------------------------------------------------------------

class InMemoryCardRepository(CardRepository):
    """
    Trivial, thread-safe, in-memory implementation meant for tests and
    CLI demos. *Not* to be used in production.
    """
    def __init__(self) -> None:
        self._cards: List[PrismCard] = []
        self._lock = threading.RLock()

    # -- Repository Contract ------------------------------------------------ #

    def fetch_cards_since(self, timestamp: datetime) -> Iterable[PrismCard]:
        with self._lock:
            return [c for c in self._cards if c.created_at >= timestamp]

    def all_cards(self) -> Iterable[PrismCard]:
        with self._lock:
            return list(self._cards)

    # -- Convenience Helpers ------------------------------------------------ #

    def add_card(self, card: PrismCard) -> None:
        if not isinstance(card, PrismCard):
            raise TypeError("add_card expects a PrismCard")
        with self._lock:
            self._cards.append(card)
            LOGGER.debug("Card %s added to repository", card.card_id)


# ------------------------------------------------------------------------------
# Optional: CLI entry point for manual smoke-testing
# ------------------------------------------------------------------------------

def _demo() -> None:  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

    # Create repo + service
    repo = InMemoryCardRepository()
    analytics = PaletteAnalyticsService(repo)

    # Observer callback
    def on_metrics(metrics: List[PaletteMetric]) -> None:
        LOGGER.info("Observer received %d metrics (latest=%s)", len(metrics), metrics[-1])

    ObserverBus().subscribe(PaletteAnalyticsService.EVT_METRICS_UPDATED, on_metrics)

    # Seed data
    for i in range(10):
        card = PrismCard(
            card_id=f"C{i}",
            user_id=f"U{i%3}",
            created_at=datetime.utcnow() - timedelta(minutes=i * 5),
            colors=("#FF5733", "#33FF57", "#3357FF") if i % 2 == 0 else ("#222222", "#444444"),
        )
        repo.add_card(card)

    analytics.refresh_metrics()
    LOGGER.info("Top Palettes: %s", analytics.top_palettes())
    LOGGER.info("Trending Palettes: %s", analytics.trending_palettes())

    time.sleep(1)  # let observer flush


if __name__ == "__main__":  # pragma: no cover
    _demo()
```