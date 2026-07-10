```python
"""
PrismPocket – Palette Analytics Module (module_27)

This module encapsulates the business logic responsible for aggregating colour-
usage statistics across all captured `PrismCard`s and publishing live updates
onto the Observer bus.  The service fulfils the analytics feature-set described
in the project documentation, plugging neatly into the Clean Architecture ring
structure:

 ┌─────────────────────────┐
 │   Presentation (MVVM)   │ ⇒ Listens for PaletteMetricEvent
 ├─────────────────────────┤
 │          Domain         │ ⇒ Entities (PrismCard, PaletteMetric, …)
 ├─────────────────────────┤
 │        Services         │ ⇐ PaletteAnalyticsService   ← This file
 ├─────────────────────────┤
 │  Infrastructure/Adapters│ ⇒ ObserverBus, Persistence, …
 └─────────────────────────┘

The implementation purposefully keeps external dependencies light.  Where
project-wide abstractions (e.g. `ObserverBus`, `PrismCard`) are referenced,
`typing.Protocol` stubs are introduced so that the code remains importable and
unit-testable in isolation while still complying with the architecture.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from types import MappingProxyType
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Protocol,
    Sequence,
    Set,
    Tuple,
)

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Handlers should be configured by the application’s bootstrapper; we still add
# a fallback so local execution (e.g. unit tests, notebooks) sees useful output.
if not logging.root.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        "[%(asctime)s][%(levelname)1.1s][%(name)s] %(message)s",
        "%H:%M:%S",
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)

# --------------------------------------------------------------------------- #
# Protocol definitions (boundary interfaces)
# --------------------------------------------------------------------------- #


class PrismCard(Protocol):
    """
    Subset of the domain entity interface required by this module.
    """

    id: str
    captured_at: datetime
    dominant_colors: Sequence[str]  # Hex triplets, e.g. ['#ff00cc', '#222222']


class ObserverBus(Protocol):
    """
    Minimalistic observer bus interface used within the project.
    """

    def subscribe(self, event_type: str, callback: Callable[[Any], None]) -> None:
        ...

    def publish(self, event_type: str, payload: Any) -> None:
        ...


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCardAddedEvent:
    """Event emitted when a new PrismCard has been persisted elsewhere."""

    card: PrismCard


@dataclass(frozen=True, slots=True)
class PaletteMetricEvent:
    """
    Event published by the analytics service whenever colour statistics are
    updated.  This is consumed by ViewModels (to update UI) and the cloud sync
    adapter (for server-side trend aggregation).
    """

    timestamp: datetime
    top_colors: Tuple[str, ...]
    color_usage: MappingProxyType[str, int]
    total_cards: int


# --------------------------------------------------------------------------- #
# In-memory analytic state container
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _PaletteState:
    """
    Internal value-object that tracks aggregated statistics.  Optimised for fast
    updates on the hot path (card ingests).
    """

    color_counter: Counter[str] = field(default_factory=Counter)
    card_count: int = 0

    def ingest(self, colors: Iterable[str]) -> None:
        """Update counters in-place with a sequence of validated hex colours."""
        self.color_counter.update(colors)
        self.card_count += 1
        logger.debug("State updated; now at %d cards, %d unique colours",
                     self.card_count, len(self.color_counter))


# --------------------------------------------------------------------------- #
# Utility helpers
# --------------------------------------------------------------------------- #

_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}){1,2}$")


def _is_valid_hex(color: str) -> bool:
    """Return True iff `color` is a valid 3/6-char hex code (#fff or #ffffff)."""
    valid = bool(_HEX_RE.fullmatch(color))
    if not valid:
        logger.debug("Rejected invalid colour code: %s", color)
    return valid


def _normalise_hex(color: str) -> str:
    """
    Normalise various hex representations into the 6-character lowercase form.
    (e.g. '#FFF' → '#ffffff')
    """
    color = color.lower()
    if len(color) == 4:  # '#abc' form
        color = "#" + "".join(ch * 2 for ch in color[1:])
    return color


# --------------------------------------------------------------------------- #
# Analytics Service
# --------------------------------------------------------------------------- #


class PaletteAnalyticsService:
    """
    Aggregate colour metrics across all PrismCards.  The service subscribes to
    `PrismCardAddedEvent`s on construction and publishes `PaletteMetricEvent`s
    when the sliding time-window or top-N ranking changes.

    Thread-Safety:
        The service can be called from multiple threads (e.g., background
        persistence, foreground UI) thanks to an internal lock protecting the
        mutable state.  Heavy computations are off-loaded to an asyncio loop
        when available, avoiding UI jank on mobile.
    """

    EVENT_CARD_ADDED = "card_added"
    EVENT_PALETTE_UPDATED = "palette_updated"

    # Default configuration
    TOP_N_COLORS = 5
    EVENT_DEBOUNCE_SEC = 0.8  # Aggregate quick successive changes

    def __init__(
        self,
        bus: ObserverBus,
        *,
        top_n: int | None = None,
        debounce_seconds: float | None = None,
    ) -> None:
        self._bus = bus
        self._state = _PaletteState()
        self._top_n = top_n or self.TOP_N_COLORS
        self._debounce = debounce_seconds or self.EVENT_DEBOUNCE_SEC
        self._lock = threading.RLock()
        self._pending_publish_handle: asyncio.TimerHandle | None = None

        # Subscribe to upstream events
        self._bus.subscribe(self.EVENT_CARD_ADDED, self._on_card_added)
        logger.info("PaletteAnalyticsService initialised (top_n=%d, debounce=%.2fs)",
                    self._top_n, self._debounce)

    # --------------------------------------------------------------------- #
    # Event handlers
    # --------------------------------------------------------------------- #

    def _on_card_added(self, event: PrismCardAddedEvent) -> None:
        """
        Ingest the card colours and schedule a debounced metric publication.
        """
        logger.debug("Received PrismCardAddedEvent for card %s", event.card.id)
        if not event.card.dominant_colors:
            logger.debug("Card %s has no dominant colours; skipping", event.card.id)
            return

        colours = [
            _normalise_hex(c)
            for c in event.card.dominant_colors
            if _is_valid_hex(c)
        ]

        if not colours:
            logger.debug("Card %s had no valid colours after validation", event.card.id)
            return

        with self._lock:
            self._state.ingest(colours)
            self._schedule_metric_publish()

    # --------------------------------------------------------------------- #
    # Publishing logic
    # --------------------------------------------------------------------- #

    def _schedule_metric_publish(self) -> None:
        """
        Debounce rapid successive updates to avoid spamming the Observer bus.
        """
        loop = asyncio.get_event_loop_policy().get_event_loop()
        if self._pending_publish_handle:  # Reset existing timer
            self._pending_publish_handle.cancel()

        self._pending_publish_handle = loop.call_later(
            self._debounce, self._publish_metrics_safe
        )
        logger.debug("Scheduled metric publish in %.2fs", self._debounce)

    def _publish_metrics_safe(self) -> None:
        try:
            self._publish_metrics()
        except Exception:  # pragma: no cover
            logger.exception("Unexpected error while publishing palette metrics")

    def _publish_metrics(self) -> None:
        with self._lock:
            if self._state.card_count == 0:
                logger.debug("No cards recorded yet; skipping metric publish")
                return

            top_colors = tuple(
                color
                for color, _count in self._state.color_counter.most_common(self._top_n)
            )
            snapshot = PaletteMetricEvent(
                timestamp=datetime.utcnow(),
                top_colors=top_colors,
                color_usage=MappingProxyType(dict(self._state.color_counter)),
                total_cards=self._state.card_count,
            )

        self._bus.publish(self.EVENT_PALETTE_UPDATED, snapshot)
        logger.info("Published PaletteMetricEvent (top=%s, cards=%d)",
                    snapshot.top_colors, snapshot.total_cards)

    # --------------------------------------------------------------------- #
    # Diagnostic hooks
    # --------------------------------------------------------------------- #

    def snapshot(self) -> PaletteMetricEvent | None:
        """
        Synchronously obtain the current state snapshot.  Returns None if no
        cards have been processed yet.
        """
        with self._lock:
            if self._state.card_count == 0:
                return None
            top_colors = tuple(
                c for c, _ in self._state.color_counter.most_common(self._top_n)
            )
            return PaletteMetricEvent(
                timestamp=datetime.utcnow(),
                top_colors=top_colors,
                color_usage=MappingProxyType(dict(self._state.color_counter)),
                total_cards=self._state.card_count,
            )


# --------------------------------------------------------------------------- #
# Reference in-memory observer bus (fallback implementation)
# --------------------------------------------------------------------------- #

class _InMemoryObserverBus:
    """
    A trivial synchronous observer bus suitable for unit tests and CLI demos.
    Production builds swap this out for the platform-specific implementation.
    """

    def __init__(self) -> None:
        self._subs: MutableMapping[str, Set[Callable[[Any], None]]] = defaultdict(set)
        self._lock = threading.Lock()

    # Public API ----------------------------------------------------------- #

    def subscribe(self, event_type: str, callback: Callable[[Any], None]) -> None:
        with self._lock:
            self._subs[event_type].add(callback)
        logger.debug("Subscriber registered for '%s': %s", event_type, callback)

    def publish(self, event_type: str, payload: Any) -> None:
        with self._lock:
            callbacks = list(self._subs.get(event_type, ()))
        logger.debug("Publishing event '%s' to %d subscribers", event_type, len(callbacks))
        for cb in callbacks:
            try:
                cb(payload)
            except Exception:
                logger.exception("Error in subscriber callback for event '%s'", event_type)


# --------------------------------------------------------------------------- #
# Self-test / demonstration
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    import random

    async def demo() -> None:
        bus = _InMemoryObserverBus()
        service = PaletteAnalyticsService(bus)

        # Subscriber printing out metric updates
        bus.subscribe(
            PaletteAnalyticsService.EVENT_PALETTE_UPDATED,
            lambda evt: logger.info(">>> Metric Update: %s", evt),
        )

        # Simulate card ingestion
        hex_choices = [
            "#ff3366", "#3366ff", "#33ff66", "#ffff33", "#ff33ff",
            "#ff3333", "#333333", "#ffffff",
        ]

        for i in range(20):
            colors = random.sample(hex_choices, k=random.randint(1, 4))
            card = type(
                "MockCard",
                (),
                {
                    "id": f"card_{i}",
                    "captured_at": datetime.utcnow(),
                    "dominant_colors": colors,
                },
            )()
            bus.publish(
                PaletteAnalyticsService.EVENT_CARD_ADDED,
                PrismCardAddedEvent(card=card),
            )
            await asyncio.sleep(random.uniform(0.05, 0.25))

        # Allow pending debounced publish to fire
        await asyncio.sleep(1.5)

    asyncio.run(demo())
```