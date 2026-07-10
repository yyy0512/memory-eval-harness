```python
"""
PrismPocket – Analytics & Trend Detection Module
================================================

This module powers the *real-time* analytics layer used throughout the
application.  It listens to the global Observer bus for mutations
produced by repositories (e.g., `PrismCardRepository`, `RemixSessionRepository`)
and continuously derives insight such as:

* Most used color palettes over a sliding time window
* Geographic “hot-spots” of creativity
* Aggregate mood scores

The core components deliberately respect Separation-of-Concerns:

* `AnalyticsEvent` – Immutable DTO for anything worth tracking.
* `AnalyticsCollector` – Subscribes to the Observer bus and funnels events
  into an in-memory queue.
* `TrendDetector` – Periodically crunches queued events and publishes
  structured metrics to a downstream consumer (usually the cloud workspace).
* `AnalyticsEngine` – A façade + singleton wrapper that wires everything
  together and exposes a concise public API for the rest of the app.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import threading
from collections import Counter, deque
from contextlib import suppress
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from enum import Enum, auto
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, MutableMapping, Optional

# ──────────────────────────────────────────────────────────────────────────────
# Configuration & Logging
# ──────────────────────────────────────────────────────────────────────────────

_LOG = logging.getLogger("prism.analytics")
_LOG.setLevel(logging.INFO)

# A nicer default formatter than the bare one.
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter(
        "[%(levelname)s] %(asctime)s — %(name)s:%(lineno)d | %(message)s",
        datefmt="%H:%M:%S",
    )
)
# StreamHandler uses stderr by default; do not duplicate handlers
if not any(isinstance(h, logging.StreamHandler) for h in _LOG.handlers):
    _LOG.addHandler(_handler)

# ──────────────────────────────────────────────────────────────────────────────
# Domain-level objects
# ──────────────────────────────────────────────────────────────────────────────


class EventKind(Enum):
    """Different mutation types that the analytics engine cares about."""

    CARD_CREATED = auto()
    CARD_REMIXED = auto()
    CARD_SHARED = auto()
    REMIX_SESSION_STARTED = auto()
    APP_LAUNCHED = auto()
    USER_AUTHENTICATED = auto()
    UNKNOWN = auto()


@dataclass(frozen=True)
class AnalyticsEvent:
    """
    Immutable event object representing a single analytics datum.

    Attributes
    ----------
    kind:
        Categorical type of event.
    timestamp:
        Monotonic-ish UTC timestamp generated client-side.
    payload:
        Arbitrary, JSON-serialisable structure containing event metadata.
    user_id:
        Anonymised user identifier.
    """

    kind: EventKind
    timestamp: datetime
    payload: Dict[str, Any]
    user_id: str

    def to_json(self) -> str:
        """Serialise the event for storage or transmission."""
        return json.dumps(
            {
                "kind": self.kind.name,
                "timestamp": self.timestamp.isoformat(),
                "payload": self.payload,
                "user_id": self.user_id,
            },
            separators=(",", ":"),
        )


# ──────────────────────────────────────────────────────────────────────────────
# Observer Infrastructure (minimal placeholder)
# ──────────────────────────────────────────────────────────────────────────────


class Observable:
    """
    A *very* light-weight Observable placeholder.

    Real implementation resides in the core infrastructure module; we only
    need enough here to allow unit testing of the analytics stack.
    """

    def __init__(self) -> None:
        self._subscribers: List["Observer"] = []

    def subscribe(self, observer: "Observer") -> None:
        _LOG.debug("Subscriber added: %s", observer)
        self._subscribers.append(observer)

    def notify_all(self, value: Any) -> None:
        for sub in self._subscribers:
            sub.on_next(value)


class Observer:
    """Abstract baseclass for observers compatible with `Observable`."""

    def on_next(self, value: Any) -> None:
        raise NotImplementedError


# ──────────────────────────────────────────────────────────────────────────────
# Analytics Collector
# ──────────────────────────────────────────────────────────────────────────────


class AnalyticsCollector(Observer):
    """
    Collector that receives raw events from the app's Observer bus.

    It does *no* heavy processing; instead, it quickly validates and enqueues
    the event so we do not block UI or I/O threads.
    """

    QUEUE_MAXLEN = 10_000  # Keep memory usage sane

    def __init__(self) -> None:
        self._queue: Deque[AnalyticsEvent] = deque(maxlen=self.QUEUE_MAXLEN)
        self._lock = threading.Lock()

    # IMPLEMENTS Observer.
    def on_next(self, value: Any) -> None:
        if not isinstance(value, AnalyticsEvent):
            _LOG.debug("Ignoring foreign value %s", value)
            return

        with self._lock:
            self._queue.append(value)
            _LOG.debug("Event queued (%s). New size=%d", value.kind, len(self._queue))

    def drain(self, max_items: int | None = None) -> List[AnalyticsEvent]:
        """
        Atomically pull up to ``max_items`` events from the queue.

        If `max_items` is None we drain *all* events currently present.
        """
        with self._lock:
            if max_items is None:
                max_items = len(self._queue)

            items: List[AnalyticsEvent] = []
            for _ in range(min(max_items, len(self._queue))):
                items.append(self._queue.popleft())

        _LOG.debug("Drained %d events from collector", len(items))
        return items


# ──────────────────────────────────────────────────────────────────────────────
# Trend Detector
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class TrendSnapshot:
    """
    Computed, aggregated metrics for a given time window.
    """

    window_start: datetime
    window_end: datetime
    top_palette: List[str]  # Hex codes representing RGB colors
    mood_average: float
    hotspots: List[str]  # Human-readable place names

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class TrendDetector:
    """
    Consumes raw events and derives higher-level insights.

    The detector operates on a *sliding window* basis so that trends feel
    responsive in the UX while still being statistically meaningful.
    """

    WINDOW_SIZE_MINUTES = 60
    REPORT_INTERVAL_SEC = 15  # How frequently to refresh trends

    def __init__(
        self,
        collector: AnalyticsCollector,
        *,
        dispatch_callback: callable[[TrendSnapshot], None],
        cache_dir: Optional[Path] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._collector = collector
        self._dispatch_callback = dispatch_callback
        self._loop = loop or asyncio.get_event_loop()
        self._cache_dir = cache_dir or Path.home() / ".prism_cache"
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        # Internal state
        self._event_buffer: Deque[AnalyticsEvent] = deque()
        self._running = False
        self._task: Optional[asyncio.Task[None]] = None

    # PUBLIC API .................................................................
    def start(self) -> None:
        if self._running:
            return

        _LOG.info("Starting TrendDetector background task")
        self._running = True
        self._task = self._loop.create_task(self._run())

    def stop(self) -> None:
        """Signal the background loop to shut down gracefully."""
        if not self._running:
            return

        _LOG.info("Stopping TrendDetector")
        self._running = False
        if self._task:
            self._task.cancel()

    # BACKGROUND COROUTINE ......................................................
    async def _run(self) -> None:
        try:
            while self._running:
                await self._consume_collector()
                snapshot = self._compute_snapshot()
                if snapshot:
                    self._dispatch_callback(snapshot)
                    self._persist_snapshot(snapshot)
                await asyncio.sleep(self.REPORT_INTERVAL_SEC)
        except asyncio.CancelledError:
            _LOG.debug("TrendDetector cancelled; flushing remaining work.")
            # Flush once more before exiting.
            snapshot = self._compute_snapshot()
            if snapshot:
                self._dispatch_callback(snapshot)
                self._persist_snapshot(snapshot)

    async def _consume_collector(self) -> None:
        """
        Drain events from the collector and add them to the buffer.

        Runs in the event loop thread, but collector may be pushing events from
        arbitrary threads; there is no contention due to internal locking.
        """

        drained = self._collector.drain()
        self._event_buffer.extend(drained)

        # Remove events outside the sliding window
        cutoff = datetime.utcnow() - timedelta(minutes=self.WINDOW_SIZE_MINUTES)
        while self._event_buffer and self._event_buffer[0].timestamp < cutoff:
            removed = self._event_buffer.popleft()
            _LOG.debug("Expired event %s @ %s", removed.kind, removed.timestamp)

    # METRIC CALCULATION ........................................................
    def _compute_snapshot(self) -> Optional[TrendSnapshot]:
        if not self._event_buffer:
            _LOG.debug("No events buffered; skipping snapshot generation.")
            return None

        window_start = self._event_buffer[0].timestamp
        window_end = self._event_buffer[-1].timestamp

        # --- Palette usage -----------------------------------------------------
        palette_counter: Counter[str] = Counter()
        moods: List[float] = []
        hotspot_counter: Counter[str] = Counter()

        for ev in self._event_buffer:
            payload = ev.payload

            # Palette information: expect payload["palette"] = ["#RRGGBB", ...]
            palette = payload.get("palette")
            if palette and isinstance(palette, list):
                palette_counter.update(palette)

            # Mood information: payload["mood"] = float (0-1)
            mood = payload.get("mood")
            if isinstance(mood, (int, float)):
                moods.append(float(mood))

            # Geo information: payload["location_name"] = "Berlin, Germany"
            loc_name = payload.get("location_name")
            if isinstance(loc_name, str):
                hotspot_counter.update([loc_name])

        top_palette = [c for c, _ in palette_counter.most_common(5)]
        mood_average = round(sum(moods) / len(moods), 2) if moods else 0.0
        hotspots = [n for n, _ in hotspot_counter.most_common(3)]

        snapshot = TrendSnapshot(
            window_start=window_start,
            window_end=window_end,
            top_palette=top_palette,
            mood_average=mood_average,
            hotspots=hotspots,
        )

        _LOG.debug("Generated TrendSnapshot: %s", snapshot)
        return snapshot

    # PERSISTENCE ................................................................
    def _persist_snapshot(self, snapshot: TrendSnapshot) -> None:
        """Persist snapshots locally for offline reading / debugging."""
        fname = (
            f"snapshot_{snapshot.window_end.strftime('%Y%m%dT%H%M%S')}.json"
        )
        try:
            with (self._cache_dir / fname).open("w") as f:
                json.dump(snapshot.to_dict(), f, indent=2)
            _LOG.debug("Snapshot persisted to %s", fname)
        except OSError as exc:
            _LOG.warning("Failed to persist snapshot: %s", exc)


# ──────────────────────────────────────────────────────────────────────────────
# Analytics Engine (Facade + Singleton)
# ──────────────────────────────────────────────────────────────────────────────


class _SingletonMeta(type):
    """Thread-safe singleton metaclass."""

    _instances: Dict[type, "AnalyticsEngine"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any) -> "AnalyticsEngine":
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]  # type: ignore[return-value]


class AnalyticsEngine(metaclass=_SingletonMeta):
    """
    Public façade coordinating *collection* and *analysis* of events.

    This is the object that view-models & repositories interact with.
    """

    def __init__(self) -> None:
        # Outside world pushes events into the Observable
        self._observable_bus = Observable()

        # Collector subscribes to bus
        self._collector = AnalyticsCollector()
        self._observable_bus.subscribe(self._collector)

        # TrendDetector periodically generates snapshots
        self._detector = TrendDetector(
            self._collector, dispatch_callback=self._handle_snapshot
        )

        self._loop = asyncio.get_event_loop()
        self._detector.start()

    # --------------------------------------------------------------------- API
    def push_event(self, event: AnalyticsEvent) -> None:
        """Push events from anywhere in the app—thread-safe."""
        self._observable_bus.notify_all(event)

    def shutdown(self) -> None:
        """
        Stop background workers.

        Should be called when the app goes into the background or terminates.
        """
        self._detector.stop()

    # -------------------------------------------------------------- Snapshots
    _LATEST_SNAPSHOT: Optional[TrendSnapshot] = None
    _SNAPSHOT_LOCK = threading.RLock()

    def get_latest_snapshot(self) -> Optional[TrendSnapshot]:
        with self._SNAPSHOT_LOCK:
            return self._LATEST_SNAPSHOT

    # ------------------------------------------------------ Internal Handlers
    def _handle_snapshot(self, snapshot: TrendSnapshot) -> None:
        _LOG.info(
            "New trend snapshot ⏰ %s-%s | 🎨 top=%s | 😊 mood=%.2f | 📍 hotspots=%s",
            snapshot.window_start.strftime("%H:%M"),
            snapshot.window_end.strftime("%H:%M"),
            snapshot.top_palette,
            snapshot.mood_average,
            snapshot.hotspots,
        )
        with self._SNAPSHOT_LOCK:
            self._LATEST_SNAPSHOT = snapshot


# ──────────────────────────────────────────────────────────────────────────────
# Convenience factory for other modules
# ──────────────────────────────────────────────────────────────────────────────


def get_engine() -> AnalyticsEngine:
    """
    Retrieve the singleton analytics engine without importing its class.

    Example
    -------
    >>> from src.module_53 import get_engine
    >>> engine = get_engine()
    >>> engine.push_event(my_event)
    """
    return AnalyticsEngine()


# ──────────────────────────────────────────────────────────────────────────────
# Minimal self-test / demonstration
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Run a minimal demo when executed directly.

    async def main() -> None:
        engine = get_engine()

        # Simulate random events for ~30 seconds
        start = datetime.utcnow()
        while (datetime.utcnow() - start).seconds < 30:
            ev = AnalyticsEvent(
                kind=random.choice(list(EventKind)),
                timestamp=datetime.utcnow(),
                payload={
                    "palette": [random.choice(["#FF0000", "#00FF00", "#0000FF"])],
                    "mood": random.random(),
                    "location_name": random.choice(
                        ["Berlin", "Tokyo", "NYC", "Paris", "São Paulo"]
                    ),
                },
                user_id="demo_user",
            )
            engine.push_event(ev)
            await asyncio.sleep(random.uniform(0.1, 0.4))

        # Retrieve latest snapshot
        snapshot = engine.get_latest_snapshot()
        print("\nLATEST SNAPSHOT:", snapshot)

        engine.shutdown()

    with suppress(KeyboardInterrupt):
        asyncio.run(main())
```