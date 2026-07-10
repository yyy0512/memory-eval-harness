```python
"""
PrismPocket – Palette Analytics Processor
-----------------------------------------

This module wires together an Observer-pattern event-bus with an asynchronous
analytics processor dedicated to colour-palette metrics.  It listens to prism
card creation / remix events, aggregates raw RGB data in-memory and flushes
derived KPIs (top colours, mood score, etc.) into a small local repository that
can later be synced to the cloud layer.

Design notes
~~~~~~~~~~~~
* Clean Architecture: analytics processing lives in the “domain service” ring;
  the repository is an infrastructural adapter.
* Patterns employed:
    - Singleton (EventBus, Processor-factory)
    - Observer / Pub–Sub (EventBus)
    - Repository (PaletteMetricRepository)
    - Factory (get_palette_analytics_processor)

The module is intentionally self-contained and relies only on the standard
library to avoid heavyweight runtime requirements on mobile targets.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import shelve
import statistics
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field, asdict
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Iterable, List, MutableMapping, Optional, Tuple

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
LOGGER = logging.getLogger("prism.analytics.palette")
if not LOGGER.handlers:
    # Defensive check: avoid configuring twice if reloaded in REPL
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter(
        "[%(levelname)s] %(name)s:%(lineno)d | %(message)s"))
    LOGGER.addHandler(_handler)
    LOGGER.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Event Bus – lightweight Singleton observer
# --------------------------------------------------------------------------- #
Subscriber = Callable[[str, Dict[str, Any]], None]


class _EventBus:
    """
    Thread-safe, process-local event bus suitable for lightweight, in-app PubSub.
    Listeners receive `channel` + `payload` on every publish.
    """

    _instance_lock = threading.Lock()
    _instance: Optional["_EventBus"] = None

    def __new__(cls) -> "_EventBus":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[str, List[Subscriber]] = {}
                cls._instance._lock = threading.RLock()
            return cls._instance

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def subscribe(self, channel: str, listener: Subscriber) -> None:
        """
        Register a callback for a channel.

        Parameters
        ----------
        channel:
            Arbitrary string identifying a topic.
        listener:
            Callable that accepts `(channel, payload)`.
        """
        with self._lock:
            self._subscribers.setdefault(channel, []).append(listener)
            LOGGER.debug("Listener %s subscribed to '%s'", listener, channel)

    def unsubscribe(self, channel: str, listener: Subscriber) -> None:
        with self._lock:
            listeners = self._subscribers.get(channel, [])
            try:
                listeners.remove(listener)
                LOGGER.debug("Listener %s removed from '%s'", listener, channel)
            except ValueError:
                LOGGER.warning("Listener %s not found in '%s'", listener, channel)

    def publish(self, channel: str, payload: Dict[str, Any]) -> None:
        """
        Synchronously fan-out the payload to all listeners subscribed
        to the given channel.  Never blocks longer than it takes the
        longest subscriber to return.
        """
        with self._lock:
            listeners = list(self._subscribers.get(channel, []))

        for listener in listeners:
            try:
                listener(channel, payload)
            except Exception:  # pylint: disable=broad-except
                LOGGER.exception("Exception raised by listener '%s' on channel '%s'",
                                 listener, channel)


# Exposed singleton
EventBus: _EventBus = _EventBus()

# --------------------------------------------------------------------------- #
# Domain objects
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RGBColor:
    r: int
    g: int
    b: int

    def __post_init__(self) -> None:
        for comp in (self.r, self.g, self.b):
            if not 0 <= comp <= 255:
                raise ValueError("RGB components must be in 0..255")

    @property
    def hex(self) -> str:
        """Return the colour as uppercase HEX (#RRGGBB)."""
        return f"#{self.r:02X}{self.g:02X}{self.b:02X}"

    @property
    def brightness(self) -> float:
        """
        Perceived brightness (0..255) based on simple RGB average.
        More sophisticated models (e.g. HSP) are possible but heavier.
        """
        return (self.r + self.g + self.b) / 3

    @classmethod
    def from_hex(cls, value: str) -> "RGBColor":
        if not value.startswith("#") or len(value) != 7:
            raise ValueError("HEX value must be in format '#RRGGBB'")
        r, g, b = (int(value[i:i + 2], 16) for i in (1, 3, 5))
        return cls(r, g, b)


class PrismEvent(Enum):
    """
    Types of events a PrismCard can emit that interest analytics.
    """
    CARD_CREATED = auto()
    CARD_REMIXED = auto()
    FILTER_APPLIED = auto()
    CARD_SHARED = auto()


# --------------------------------------------------------------------------- #
# Repository – simple, persistent storage
# --------------------------------------------------------------------------- #
@dataclass
class PaletteMetricRecord:
    """
    Snap-shot of palette usage metrics emitted by the processor.
    """
    timestamp: float
    top_colours: List[str]  # HEX, ordered descending frequency
    mood_score: float       # average brightness
    sample_size: int        # number of colours aggregated


class PaletteMetricRepository:
    """
    Tiny key–value repository built on Python `shelve` for local persistence.
    The repo is NOT multi-process safe – PrismPocket runs as a single process.
    """

    _SHELVE_VERSION = "v1"

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path).expanduser().resolve()
        self._lock = threading.RLock()
        self._ensure_parent()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def save(self, record: PaletteMetricRecord) -> None:
        """
        Persist a record.  The key space is monotonically increasing integers.
        """
        with self._lock, shelve.open(str(self._db_path), writeback=True) as db:
            versioned = db.setdefault(self._SHELVE_VERSION, {})
            key = str(len(versioned))
            versioned[key] = asdict(record)
            LOGGER.debug("PaletteMetricRecord saved under key %s", key)

    def latest(self) -> Optional[PaletteMetricRecord]:
        with self._lock, shelve.open(str(self._db_path)) as db:
            versioned: MutableMapping[str, Any] = db.get(self._SHELVE_VERSION, {})
            if not versioned:
                return None
            latest_key = str(len(versioned) - 1)
            return PaletteMetricRecord(**versioned[latest_key])

    # --------------------------------------------------------------------- #
    # Helpers
    # --------------------------------------------------------------------- #
    def _ensure_parent(self) -> None:
        try:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            LOGGER.exception("Failed to create directory for palette metric DB [%s]",
                             self._db_path)


# --------------------------------------------------------------------------- #
# Analytics processor
# --------------------------------------------------------------------------- #
@dataclass
class _InMemoryBucket:
    """
    Simple in-memory data bucket for colour aggregation.
    """
    colours: Counter[str] = field(default_factory=Counter)
    brightness_values: List[float] = field(default_factory=list)

    def append(self, colour: RGBColor) -> None:
        self.colours[colour.hex] += 1
        self.brightness_values.append(colour.brightness)


class PaletteAnalyticsProcessor:
    """
    Asynchronous service that listens to Prism events and produces metrics.
    """
    _CHANNEL = "prism.card"

    def __init__(
        self,
        bus: _EventBus,
        repository: PaletteMetricRepository,
        flush_interval: float = 10.0,
        top_k: int = 5,
    ) -> None:
        self._bus = bus
        self._repo = repository
        self._flush_interval = flush_interval
        self._top_k = top_k

        self._bucket: _InMemoryBucket = _InMemoryBucket()
        self._queue: "asyncio.Queue[Tuple[str, Dict[str, Any]]]" = asyncio.Queue()
        self._task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()

        # subscribe synchronously (bridging to async queue)
        self._bus.subscribe(self._CHANNEL, self._on_event)
        LOGGER.info("PaletteAnalyticsProcessor subscribed to channel '%s'", self._CHANNEL)

    # --------------------------------------------------------------------- #
    # Public control
    # --------------------------------------------------------------------- #
    async def start(self) -> None:
        """
        Begin background task that consumes queue and flushes metrics.
        Safe to await multiple times – only the first call actually starts.
        """
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._run(), name="palette-analytics")
            LOGGER.info("PaletteAnalyticsProcessor started")

    async def stop(self) -> None:
        """
        Stop background task gracefully.
        """
        if self._task is None:
            return
        self._stop_event.set()
        await self._task
        LOGGER.info("PaletteAnalyticsProcessor stopped")

    # --------------------------------------------------------------------- #
    # Event listener bridge (sync -> async)
    # --------------------------------------------------------------------- #
    def _on_event(self, channel: str, payload: Dict[str, Any]) -> None:
        """
        Places the event on the asyncio queue for processing by the background
        coroutine. This method is invoked by EventBus synchronously on whatever
        thread published the event.
        """
        try:
            self._queue.put_nowait((channel, payload))
        except asyncio.QueueFull:
            LOGGER.warning("Analytics queue full – dropping event %s", payload)

    # --------------------------------------------------------------------- #
    # Internal loop
    # --------------------------------------------------------------------- #
    async def _run(self) -> None:
        """
        Consume events, bucket them, and flush aggregated metrics periodically
        to the repository.
        """
        last_flush = time.monotonic()
        while not self._stop_event.is_set():
            try:
                # Wait up to flush_interval before timing out
                timeout = max(0.0, self._flush_interval - (time.monotonic() - last_flush))
                try:
                    channel, payload = await asyncio.wait_for(self._queue.get(), timeout)
                except asyncio.TimeoutError:
                    # No new events – fall through to flush check
                    channel = payload = None  # type: ignore
                else:
                    self._handle_payload(channel, payload)

                now = time.monotonic()
                if now - last_flush >= self._flush_interval:
                    if self._bucket.colours:
                        self._flush()
                    last_flush = now
            except Exception:  # pylint: disable=broad-except
                LOGGER.exception("Uncaught exception in PaletteAnalyticsProcessor loop")

        # final flush on stop
        if self._bucket.colours:
            self._flush()

    def _handle_payload(self, channel: str, payload: Dict[str, Any]) -> None:
        """
        Extract colour data from the payload.  Expected schema:

            {
                "event": PrismEvent.CARD_CREATED,
                "palette": ["#FF0000", "#00FF00", ...]
            }

        Additional keys are ignored for analytics purposes.
        """
        try:
            event_type = PrismEvent(payload["event"])
            palette: Iterable[str] = payload.get("palette", [])
        except (KeyError, ValueError) as exc:
            LOGGER.debug("Skipping invalid payload: %s (%s)", payload, exc)
            return

        if event_type in {PrismEvent.CARD_CREATED,
                          PrismEvent.CARD_REMIXED,
                          PrismEvent.FILTER_APPLIED}:
            for hex_colour in palette:
                try:
                    colour = RGBColor.from_hex(hex_colour)
                    self._bucket.append(colour)
                except ValueError:
                    LOGGER.debug("Invalid colour string '%s' – skipping", hex_colour)

    def _flush(self) -> None:
        """
        Calculate metrics and persist to repository.
        """
        colours_counter = self._bucket.colours
        brightness_values = self._bucket.brightness_values

        top_colours = [c for c, _ in colours_counter.most_common(self._top_k)]
        mood_score = statistics.mean(brightness_values) if brightness_values else 0.0
        record = PaletteMetricRecord(
            timestamp=time.time(),
            top_colours=top_colours,
            mood_score=round(mood_score, 2),
            sample_size=sum(colours_counter.values()),
        )

        try:
            self._repo.save(record)
            LOGGER.info("Palette metrics flushed: %s", record)
        except Exception:  # pylint: disable=broad-except
            LOGGER.exception("Failed to persist palette metrics")

        # clear bucket for next interval
        self._bucket = _InMemoryBucket()


# --------------------------------------------------------------------------- #
# Factory / Singleton wiring helper
# --------------------------------------------------------------------------- #
_PROCESSOR_SINGLETON: Optional[PaletteAnalyticsProcessor] = None
_PROCESSOR_LOCK = threading.Lock()


def get_palette_analytics_processor(
    db_path: Path | str = "~/.prism_pocket/palette_metrics.db",
    flush_interval: float = 10.0,
) -> PaletteAnalyticsProcessor:
    """
    Obtain a process-wide singleton of PaletteAnalyticsProcessor.
    Creating multiple instances would double-count events.
    """
    global _PROCESSOR_SINGLETON  # pylint: disable=global-statement
    if _PROCESSOR_SINGLETON is None:
        with _PROCESSOR_LOCK:
            if _PROCESSOR_SINGLETON is None:
                repo = PaletteMetricRepository(db_path)
                _PROCESSOR_SINGLETON = PaletteAnalyticsProcessor(
                    bus=EventBus,
                    repository=repo,
                    flush_interval=flush_interval,
                )
    return _PROCESSOR_SINGLETON


# --------------------------------------------------------------------------- #
# Convenience: quick test run
# --------------------------------------------------------------------------- #
async def _demo() -> None:  # pragma: no cover
    """
    Minimal demonstration when executing this module directly.
    Streams random colours.
    """
    processor = get_palette_analytics_processor()
    await processor.start()

    for _ in range(50):
        EventBus.publish(
            "prism.card",
            {
                "event": PrismEvent.CARD_CREATED,
                "palette": [f"#{random.randint(0, 0xFFFFFF):06X}" for _ in range(3)],
            },
        )
        await asyncio.sleep(random.uniform(0.05, 0.2))

    await asyncio.sleep(12)  # allow flush
    await processor.stop()


if __name__ == "__main__":  # pragma: no cover
    try:
        asyncio.run(_demo())
    except KeyboardInterrupt:
        pass
```