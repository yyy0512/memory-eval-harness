```python
"""
PrismPocket – Palette Analytics Engine
--------------------------------------
This module implements a production-ready analytics component that listens to
`PrismCard` mutations, extracts color information, and surfaces real-time
palette trends and mood scores. Results are pushed back onto the global
observer bus so that view-models and other consumers can react immediately.

Key concepts
============
1. ObserverPattern – A lightweight message bus (`ObserverBus`) relays events.
2. Singleton – `PaletteTrendAnalyzer` is a process-wide singleton.
3. AsyncIO – Non-blocking event ingestion & scheduled computations.
4. Robustness – Graceful degradation, logging, type safety and timeouts.

NOTE: External project modules (e.g., `domain.prism_card`) are referenced via
      “soft imports” to avoid hard build-time dependencies. Replace the
      stubs with real implementations when wiring into the full codebase.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import math
import random
import signal
import sys
import time
from collections import Counter, defaultdict
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import Event
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Iterable,
    List,
    Literal,
    Mapping,
    MutableMapping,
    Optional,
    Sequence,
    Tuple,
    TypedDict,
    Union,
)

###############################################################################
# Logging configuration
###############################################################################

_LOGGER = logging.getLogger("prism_pocket.analytics.palette")
if not _LOGGER.handlers:
    # Avoid duplicate handlers if module is re-loaded
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "[%(asctime)s] %(levelname)s – %(name)s – %(message)s",
            "%Y-%m-%d %H:%M:%S",
        )
    )
    _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)

###############################################################################
# Event & Bus infrastructure
###############################################################################


class EventType(Literal["PRISM_CARD_SAVED", "TREND_UPDATE"]):
    """Enumeration of supported event channels (string literals for flexibility)."""


@dataclass(frozen=True, slots=True)
class PrismCardEvent:
    """Emitted whenever a PrismCard is created or modified."""

    card_id: str
    user_id: str
    colors: Sequence[str]  # Hex strings "#RRGGBB"
    mood_tag: str  # e.g. "happy", "calm"
    timestamp: datetime = field(default_factory=lambda: datetime.now(tz=timezone.utc))

    event_type: EventType = field(init=False, default="PRISM_CARD_SAVED")


@dataclass(frozen=True, slots=True)
class TrendUpdateEvent:
    """Published by analytics once new trends are available."""

    top_palettes: List[Tuple[str, int]]  # (hex, usage_count)
    mood_scores: Mapping[str, float]
    generated_at: datetime = field(default_factory=lambda: datetime.now(tz=timezone.utc))

    event_type: EventType = field(init=False, default="TREND_UPDATE")


Callback = Callable[[Any], Union[None, Awaitable[None]]]


class ObserverBus:
    """Very small in-proc pub/sub bus."""

    _instance: "ObserverBus" | None = None

    def __new__(cls) -> "ObserverBus":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._subscriptions: Dict[EventType, List[Callback]] = defaultdict(list)  # type: ignore
        return cls._instance

    def subscribe(self, event_type: EventType, callback: Callback) -> None:
        _LOGGER.debug("Subscribing %s to %s", callback, event_type)
        self._subscriptions[event_type].append(callback)

    def unsubscribe(self, event_type: EventType, callback: Callback) -> None:
        with suppress(ValueError):
            self._subscriptions[event_type].remove(callback)

    async def publish(self, event: Any) -> None:
        """Fan-out to all subscribers. Supports sync and async callbacks."""
        callbacks: List[Callback] = list(self._subscriptions.get(event.event_type, []))
        _LOGGER.debug("Publishing %s to %d subscriber(s)", event, len(callbacks))

        for cb in callbacks:
            try:
                result = cb(event)
                if asyncio.iscoroutine(result):
                    await result  # type: ignore[arg-type]
            except Exception as exc:  # pylint: disable=broad-except
                # We log but never propagate so that one faulty subscriber
                # doesn't block the pipeline.
                _LOGGER.exception("Unhandled error in subscriber: %s", exc)


###############################################################################
# Utility helpers
###############################################################################


def _hex_to_rgb(hex_str: str) -> Tuple[int, int, int]:
    """Convert #RRGGBB -> (r, g, b)."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) != 6:
        raise ValueError(f"Invalid hex color: {hex_str!r}")
    return tuple(int(hex_str[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def _relative_luminance(rgb: Tuple[int, int, int]) -> float:
    """WCAG relative luminance (simplistic)."""
    def _channel(n: int) -> float:
        n /= 255.0
        return n / 12.92 if n <= 0.03928 else ((n + 0.055) / 1.055) ** 2.4

    r, g, b = map(_channel, rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _color_distance(c1: str, c2: str) -> float:
    """Euclidean distance in RGB space."""
    r1, g1, b1 = _hex_to_rgb(c1)
    r2, g2, b2 = _hex_to_rgb(c2)
    return math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)


###############################################################################
# Core analytics engine
###############################################################################


class _SingletonMeta(type):
    """Thread-safe, lazy Singleton metaclass."""

    _instances: Dict[type, "PaletteTrendAnalyzer"] = {}
    _lock = asyncio.Lock()

    async def __call__(cls, *args: Any, **kwargs: Any):  # type: ignore[override]
        async with cls._lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)  # type: ignore[misc]
                cls._instances[cls] = instance
            return cls._instances[cls]


class PaletteTrendAnalyzer(metaclass=_SingletonMeta):
    """
    Consumes `PrismCardEvent`s from the ObserverBus, keeps rolling metrics, and
    periodically emits `TrendUpdateEvent`s.
    """

    WINDOW: timedelta = timedelta(hours=24)
    TOP_K = 10
    COMPUTE_INTERVAL_SEC = 30

    def __init__(self) -> None:
        self._bus = ObserverBus()
        self._bus.subscribe("PRISM_CARD_SAVED", self._on_prism_card)
        self._metrics_lock = asyncio.Lock()
        self._color_counter: Counter[str] = Counter()
        self._mood_counter: Counter[str] = Counter()
        self._timestamped_cards: List[Tuple[datetime, Sequence[str], str]] = []

        # Scheduling
        self._shutdown = Event()
        self._loop = asyncio.get_event_loop()
        self._future: asyncio.Future[None] | None = None
        self._start_background_task()
        _LOGGER.info("PaletteTrendAnalyzer initialized.")

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    async def get_trending_palettes(self) -> List[Tuple[str, int]]:
        """Return current top palettes."""
        async with self._metrics_lock:
            return self._color_counter.most_common(self.TOP_K)

    async def get_mood_scores(self) -> Dict[str, float]:
        """Normalized distribution of moods (0.0 … 1.0)."""
        async with self._metrics_lock:
            total = sum(self._mood_counter.values()) or 1
            return {mood: count / total for mood, count in self._mood_counter.items()}

    def shutdown(self) -> None:
        """Stop background task. Call on application exit."""
        _LOGGER.info("Shutting down PaletteTrendAnalyzer…")
        self._shutdown.set()
        if self._future:
            self._future.cancel()

    # --------------------------------------------------------------------- #
    # Internal logic
    # --------------------------------------------------------------------- #

    def _start_background_task(self) -> None:
        async def _runner() -> None:
            _LOGGER.debug("Background metrics loop started.")
            while not self._shutdown.is_set():
                try:
                    await asyncio.sleep(self.COMPUTE_INTERVAL_SEC)
                    await self._recompute_metrics()
                except asyncio.CancelledError:  # graceful cancellation
                    break
                except Exception as exc:  # pylint: disable=broad-except
                    _LOGGER.exception("Metrics computation failed: %s", exc)
            _LOGGER.debug("Background metrics loop terminated.")

        self._future = self._loop.create_task(_runner())

    async def _on_prism_card(self, event: PrismCardEvent) -> None:
        """Handle incoming cards."""
        async with self._metrics_lock:
            self._timestamped_cards.append((event.timestamp, event.colors, event.mood_tag))
            for color in event.colors:
                self._color_counter[color] += 1
            self._mood_counter[event.mood_tag] += 1
        _LOGGER.debug(
            "Ingested card %s with %d colors. Color counter size=%d",
            event.card_id,
            len(event.colors),
            len(self._color_counter),
        )

    async def _recompute_metrics(self) -> None:
        """Sliding window pruning + publication."""
        cutoff = datetime.now(tz=timezone.utc) - self.WINDOW
        async with self._metrics_lock:
            # Remove outdated entries
            before_len = len(self._timestamped_cards)
            while self._timestamped_cards and self._timestamped_cards[0][0] < cutoff:
                ts, colors, mood = self._timestamped_cards.pop(0)
                for clr in colors:
                    self._color_counter[clr] -= 1
                    if self._color_counter[clr] <= 0:
                        del self._color_counter[clr]
                self._mood_counter[mood] -= 1
                if self._mood_counter[mood] <= 0:
                    del self._mood_counter[mood]
            after_len = len(self._timestamped_cards)
            _LOGGER.debug("Pruned %d obsolete entries.", before_len - after_len)

            top_palettes = self._color_counter.most_common(self.TOP_K)
            mood_scores = await self.get_mood_scores()

        # Publish outside the lock
        await self._bus.publish(
            TrendUpdateEvent(
                top_palettes=top_palettes,
                mood_scores=mood_scores,
            )
        )

        _LOGGER.info(
            "Trend update published. Top palette=%s | mood_count=%d",
            top_palettes[:1],
            len(mood_scores),
        )


###############################################################################
# Graceful application lifecycle hooks
###############################################################################


_analyzer_task: PaletteTrendAnalyzer | None = None


def _init_analyzer() -> None:
    """Create singleton on module import (can be deferred if needed)."""
    global _analyzer_task  # pylint: disable=global-statement

    async def _create() -> None:
        global _analyzer_task  # pylint: disable=global-statement
        _analyzer_task = await PaletteTrendAnalyzer()  # type: ignore[assignment]

    asyncio.get_event_loop().run_until_complete(_create())


def _register_signals() -> None:
    """Ensure we flush analytics on SIGINT/SIGTERM."""

    def _signal_handler(signo: int, _frame: Any) -> None:
        _LOGGER.info("Signal %s received. Flushing analytics…", signo)
        if _analyzer_task:
            _analyzer_task.shutdown()
        sys.exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(ValueError):  # Signals not available on all OS
            signal.signal(sig, _signal_handler)


_init_analyzer()
_register_signals()

###############################################################################
# Example usage (for debugging only)
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    async def _demo() -> None:
        bus = ObserverBus()

        # Subscriber that prints trend updates
        async def _printer(evt: TrendUpdateEvent) -> None:
            _LOGGER.info(">>> Received trend update: %s", evt.top_palettes)

        bus.subscribe("TREND_UPDATE", _printer)

        # Simulate random PrismCard events
        moods = ["happy", "chill", "moody"]
        colors = ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#00FFFF", "#FF00FF"]

        for i in range(50):
            await bus.publish(
                PrismCardEvent(
                    card_id=f"card_{i}",
                    user_id="demo",
                    colors=random.sample(colors, k=random.randint(1, 3)),
                    mood_tag=random.choice(moods),
                )
            )
            await asyncio.sleep(0.5)

        await asyncio.sleep(5)  # allow background job to publish

    asyncio.run(_demo())
```