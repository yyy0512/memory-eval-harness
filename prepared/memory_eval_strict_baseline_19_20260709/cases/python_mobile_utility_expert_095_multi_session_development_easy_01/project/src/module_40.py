```python
"""
module_40.py
============

A production-grade implementation of PrismPocket’s in-app analytics core.

This module provides:

* EventBus – A lightweight Observer implementation.
* PaletteTrendAnalyzer – A singleton service that turns live PrismCard events
  into color palette trends and publishes periodic snapshots.
* AnalyzerFactory – Factory for resolving analyzers by name, allowing the DI
  container to remain agnostic of the concrete class.
* Safe fall-backs for PrismCard and companion entities so the module can be
  executed in isolation (helpful for unit tests and CI environments).

The code adheres to Clean Architecture rules: domain entities are imported
(optionally stubbed), while infrastructure concerns such as scheduling and
threading live in this outer layer.

Usage (simplified):
-------------------
>>> from src.module_40 import EventBus, PaletteTrendAnalyzer
>>> bus = EventBus.get_global()
>>> analyzer = PaletteTrendAnalyzer.get_instance(bus)
>>> bus.publish("card_created", card=PrismCard.random_demo())  # feed events
>>> print(analyzer.snapshot())
"""

from __future__ import annotations

import logging
import threading
import time
import weakref
from collections import Counter, deque
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from random import randint, random
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------------#
# Logging setup
# ---------------------------------------------------------------------------#
logger = logging.getLogger("prism_pocket.analytics")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------#
# Fallback domain entities – these will be shadowed by real ones at runtime
# ---------------------------------------------------------------------------#
try:
    # The real entity lives inside the project's domain layer.
    from domain.entities import PrismCard  # type: ignore
except ImportError:  # pragma: no cover – Only for standalone execution
    @dataclass(frozen=True, slots=True)
    class PrismCard:
        """Minimal stub mimicking the real `PrismCard` entity."""

        id: str
        palette: List[Tuple[int, int, int]]  # RGB tuples
        location: Optional[Tuple[float, float]] = None  # (lat, lon)
        mood_score: float = 0.0
        created_at: datetime = field(default_factory=datetime.utcnow)

        @staticmethod
        def random_demo() -> "PrismCard":
            """Generate a random card for demo/testing."""
            palette = [(randint(0, 255), randint(0, 255), randint(0, 255))]
            loc = (random() * 180 - 90, random() * 360 - 180)  # lat, lon
            return PrismCard(
                id=f"demo_{randint(1000, 9999)}", palette=palette, location=loc, mood_score=random()
            )


# ---------------------------------------------------------------------------#
# Event Bus Implementation (Observer Pattern)
# ---------------------------------------------------------------------------#
Callback = Callable[..., None]


class _ObserverHandle:
    """Disposable handle representing a subscription."""

    __slots__ = ("_bus_ref", "_event", "_callback_ref", "_closed")

    def __init__(self, bus: "EventBus", event: str, callback: Callback) -> None:
        self._bus_ref = weakref.ref(bus)
        self._event = event
        self._callback_ref = weakref.ref(callback)
        self._closed = False

    def dispose(self) -> None:
        if self._closed:
            return
        bus = self._bus_ref()
        callback = self._callback_ref()
        self._closed = True
        if bus and callback:
            bus._unsubscribe(self._event, callback)


class EventBus:
    """
    A simple, thread-safe Observer bus.

    Subscriptions are weak-referenced so that lambdas / bound methods do not
    prevent their owning objects from being garbage-collected.
    """

    _GLOBAL: "EventBus" | None = None

    def __init__(self) -> None:
        self._subscribers: Dict[str, "weakref.WeakSet[Callback]"] = {}
        self._lock = threading.RLock()

    # ------------- Public API ------------------------------------------------
    def subscribe(self, event: str, callback: Callback) -> _ObserverHandle:
        """Subscribe to an event; returns a disposable handle."""
        with self._lock:
            self._subscribers.setdefault(event, weakref.WeakSet()).add(callback)
            logger.debug("Subscribed to '%s': %s", event, callback)
        return _ObserverHandle(self, event, callback)

    def publish(self, event: str, **kwargs: Any) -> None:
        """Publish an event to all listeners."""
        with self._lock:
            callbacks: Iterable[Callback] = (
                tuple(self._subscribers.get(event, ()))  # copy to avoid mutation
            )
        for cb in callbacks:
            try:
                cb(**kwargs)
            except Exception:  # pragma: no cover
                logger.exception("Unhandled error in event '%s' callback %s", event, cb)

    # ------------- Internal helpers ------------------------------------------
    def _unsubscribe(self, event: str, callback: Callback) -> None:
        with suppress(KeyError):
            with self._lock:
                self._subscribers[event].discard(callback)
                logger.debug("Unsubscribed from '%s': %s", event, callback)

    # ------------- Convenience ------------------------------------------------
    @classmethod
    def get_global(cls) -> "EventBus":
        if cls._GLOBAL is None:
            cls._GLOBAL = cls()
        return cls._GLOBAL


# ---------------------------------------------------------------------------#
# Trend-tracking domain data structures
# ---------------------------------------------------------------------------#
@dataclass(frozen=True, slots=True)
class PaletteTrendSnapshot:
    """Immutable value object emitted periodically by the analyzer."""

    timestamp: datetime
    top_colors: List[Tuple[str, int]]  # (hex, count)
    total_seen: int


# ---------------------------------------------------------------------------#
# PaletteTrendAnalyzer (Singleton + Observer)
# ---------------------------------------------------------------------------#
class PaletteTrendAnalyzer:
    """
    Consumes PrismCard creation events and derives palette usage trends.

    Implements:
      * Singleton pattern  – Only one analyzer should exist per process.
      * Observer pattern   – Subscribes to EventBus events.
      * Factory friendly   – Resolvable via `AnalyzerFactory`.
    """

    _INSTANCE: "PaletteTrendAnalyzer" | None = None
    _SNAPSHOT_INTERVAL_SEC = 60  # configurable

    # ------------- Construction ---------------------------------------------
    def __init__(self, bus: EventBus | None = None, history_hours: int = 24) -> None:
        if PaletteTrendAnalyzer._INSTANCE is not None:
            raise RuntimeError("Use PaletteTrendAnalyzer.get_instance() instead.")
        self._bus = bus or EventBus.get_global()
        self._history_window = timedelta(hours=history_hours)
        self._color_counter: Counter[str] = Counter()
        self._recent_cards: deque[Tuple[datetime, str]] = deque()  # (ts, color_hex)
        self._snapshot_lock = threading.RLock()
        self._stop_event = threading.Event()
        self._subscription = self._bus.subscribe("card_created", self._on_card_created)
        self._start_background_thread()

    # ------------- Singleton helpers ----------------------------------------
    @classmethod
    def get_instance(cls, bus: EventBus | None = None) -> "PaletteTrendAnalyzer":
        if cls._INSTANCE is None:
            cls._INSTANCE = cls(bus)
        return cls._INSTANCE

    # ------------- Observer callback ----------------------------------------
    def _on_card_created(self, *, card: PrismCard) -> None:
        """Extracts the dominant color (first palette color) and updates metrics."""
        try:
            color_rgb = card.palette[0]
        except (AttributeError, IndexError):
            logger.debug("Card lacks palette: %s", card)
            return

        color_hex = "#%02X%02X%02X" % color_rgb
        now = datetime.utcnow()
        with self._snapshot_lock:
            self._color_counter[color_hex] += 1
            self._recent_cards.append((now, color_hex))
            self._trim_expired(now)
        logger.debug("Processed card %s with color %s", card.id, color_hex)

    # ------------- Snapshotting ---------------------------------------------
    def _trim_expired(self, now: datetime) -> None:
        """Remove outdated entries from _recent_cards deque."""
        window_start = now - self._history_window
        while self._recent_cards and self._recent_cards[0][0] < window_start:
            _, color_hex = self._recent_cards.popleft()
            self._color_counter[color_hex] -= 1
            if self._color_counter[color_hex] <= 0:
                del self._color_counter[color_hex]

    def _snapshot_loop(self) -> None:
        while not self._stop_event.wait(self._SNAPSHOT_INTERVAL_SEC):
            snapshot = self.snapshot()
            self._bus.publish("analytics_snapshot", snapshot=snapshot)
            logger.info(
                "PaletteTrendSnapshot emitted: %s top colors=%s",
                snapshot.total_seen,
                snapshot.top_colors[:3],
            )

    def _start_background_thread(self) -> None:
        thread = threading.Thread(
            target=self._snapshot_loop, name="PaletteTrendAnalyzer", daemon=True
        )
        thread.start()

    # ------------- Public API ------------------------------------------------
    def snapshot(self) -> PaletteTrendSnapshot:
        """Return a thread-safe copy of current metrics."""
        with self._snapshot_lock:
            top = self._color_counter.most_common(10)
            total = sum(self._color_counter.values())
        return PaletteTrendSnapshot(timestamp=datetime.utcnow(), top_colors=top, total_seen=total)

    def stop(self) -> None:
        """Gracefully stop background thread and unsubscribe from bus."""
        self._stop_event.set()
        self._subscription.dispose()

    # ------------- Dunder helpers -------------------------------------------
    def __del__(self) -> None:  # pragma: no cover
        with suppress(Exception):
            self.stop()


# ---------------------------------------------------------------------------#
# AnalyzerFactory (Factory Pattern)
# ---------------------------------------------------------------------------#
class AnalyzerFactory:
    """
    Factory for analytics services.

    The DI container can request an analyzer by name without coupling to the
    concrete implementation.
    """

    _REGISTRY: Dict[str, Callable[..., Any]] = {
        "palette": PaletteTrendAnalyzer.get_instance,
        # Future analyzers (geo, mood, etc.) will be added here.
    }

    @classmethod
    def create(cls, name: str, **kwargs: Any) -> Any:
        try:
            creator = cls._REGISTRY[name]
        except KeyError as exc:
            raise ValueError(f"Unknown analyzer '{name}'") from exc
        return creator(**kwargs)


# ---------------------------------------------------------------------------#
# Convenience CLI for local testing
# ---------------------------------------------------------------------------#
def _demo() -> None:  # pragma: no cover
    """Run a small demo when this file is executed directly."""
    bus = EventBus.get_global()
    analyzer = AnalyzerFactory.create("palette")
    logger.info("Demo started – generating random cards… (CTRL+C to stop)")

    try:
        while True:
            card = PrismCard.random_demo()
            bus.publish("card_created", card=card)
            time.sleep(0.2)
    except KeyboardInterrupt:
        logger.info("Demo stopped by user.")
    finally:
        # Print final snapshot
        print("--- FINAL SNAPSHOT ---")
        print(analyzer.snapshot())
        analyzer.stop()


if __name__ == "__main__":  # pragma: no cover
    _demo()
```