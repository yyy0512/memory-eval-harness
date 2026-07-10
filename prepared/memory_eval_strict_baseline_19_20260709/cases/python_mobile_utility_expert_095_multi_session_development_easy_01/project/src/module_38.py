```python
"""
PrismPocket – Palette Trend Analytics
-------------------------------------

This module powers PrismPocket’s real-time palette trend engine.  It listens to
domain-level events (e.g. a new `PrismCard` is persisted), extracts palette
information, updates local metrics, and periodically publishes a digest that
other services (e.g. the suggestion prompt engine, social-sharing widget, or
remote cloud sync) can consume.

Clean-architecture location: *Domain Service / Analytics Ring*.

Because the project targets both mobile platforms, the code is designed to run
on CPython or PyPy inside a mobile runtime such as PyObjC / Chaquopy.  Heavy
lifting (colour clustering, async scheduling) is done purely in Python to
remain portable.

Public API
~~~~~~~~~~
    TrendAnalyticsService        – High-level façade (start / stop)
    PaletteMetric                – Dataclass summarising a palette’s score
    PaletteTrendEvent            – Emitted by the service when a trend update is ready
"""

from __future__ import annotations

import asyncio
import colorsys
import json
import logging
import math
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# External / domain imports (soft-import to avoid hard coupling for this file)
# --------------------------------------------------------------------------- #

try:
    # Domain entities exposed by the inner ring.
    from domain.entities import PrismCard
except ModuleNotFoundError:  # Fallback stub for standalone execution / tests
    @dataclass(frozen=True)
    class PrismCard:  # type: ignore
        """Lightweight fallback stub for the real PrismCard entity."""
        id: str
        palette: List[str]  # list of RGB hex strings (e.g. '#AABBCC')


try:
    # A shared observer bus used throughout the app
    from common.event_bus import EventBus, EventHandler
except ModuleNotFoundError:  # pragma: no cover – hermetic stub
    class EventBus:  # type: ignore
        _subscribers: Dict[str, List["EventHandler"]] = defaultdict(list)
        _lock = threading.Lock()

        @classmethod
        def publish(cls, channel: str, evt) -> None:
            with cls._lock:
                for cb in cls._subscribers[channel]:
                    cb(evt)

        @classmethod
        def subscribe(cls, channel: str, handler: "EventHandler") -> None:
            with cls._lock:
                cls._subscribers[channel].append(handler)

        @classmethod
        def unsubscribe(cls, channel: str, handler: "EventHandler") -> None:
            with cls._lock:
                cls._subscribers[channel].remove(handler)

    EventHandler = callable

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism.analytics.trends")
logger.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Data structures
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class PaletteMetric:
    """Aggregate metric for a single colour palette."""

    palette_hash: str
    usage_count: int = 0
    recency_weight: float = 0.0  # exponentially-decayed weight
    last_seen_ts: float = field(default_factory=time.time)

    @property
    def score(self) -> float:
        """Composite score used for trending (higher = hotter)."""
        return self.usage_count + self.recency_weight

    def register_hit(self, ts: Optional[float] = None) -> None:
        now = ts or time.time()
        # Simple half-life decay to keep recent activity hotter
        elapsed = now - self.last_seen_ts
        decay = math.exp(-elapsed / 3600)  # 1-hour half-life
        self.recency_weight *= decay
        self.recency_weight += 1.0
        self.usage_count += 1
        self.last_seen_ts = now


@dataclass(frozen=True, slots=True)
class PaletteTrendEvent:
    """Event broadcast by the service when new trend rankings are available."""
    top_palettes: Sequence[Tuple[str, float]]  # [(palette_hash, score), …]
    generated_at: float


# --------------------------------------------------------------------------- #
# Colour helpers
# --------------------------------------------------------------------------- #

def normalise_hex(hex_colour: str) -> str:
    """Return uppercase 7-char RGB hex (#AABBCC)."""
    hex_colour = hex_colour.lstrip("#")
    if len(hex_colour) == 3:  # short notation #ABC
        hex_colour = "".join(2 * c for c in hex_colour)
    return f"#{hex_colour.upper():0>6}"


def palette_hash(palette: Sequence[str]) -> str:
    """
    Deterministic hash for a palette irrespective of order.
    The palette is first canonicalised (sorted, normalised) then SHA-1 hashed.
    """
    import hashlib

    canonical = ",".join(sorted(map(normalise_hex, palette)))
    return hashlib.sha1(canonical.encode()).hexdigest()  # nosec


def rgb_to_hsv(hex_colour: str) -> Tuple[float, float, float]:
    """Convert #RRGGBB → HSV tuple with components in 0-1 range (for clustering)."""
    hex_colour = normalise_hex(hex_colour)[1:]
    r, g, b = (int(hex_colour[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return colorsys.rgb_to_hsv(r, g, b)


def perceptual_distance(c1: str, c2: str) -> float:
    """Quick & cheap perceptual colour distance in HSV space."""
    h1, s1, v1 = rgb_to_hsv(c1)
    h2, s2, v2 = rgb_to_hsv(c2)
    dh = min(abs(h1 - h2), 1 - abs(h1 - h2))  # Hue is circular
    ds = abs(s1 - s2)
    dv = abs(v1 - v2)
    return (dh * 2) + ds + dv  # crude weighting


# --------------------------------------------------------------------------- #
# Trend Analytics Service
# --------------------------------------------------------------------------- #


class TrendAnalyticsService:
    """
    Background service responsible for computing trending colour palettes.

    Usage
    -----
        service = TrendAnalyticsService(cache_dir=Path("/var/tmp/prism"))
        service.start()

        # …
        service.stop()
    """

    CHANNEL_CARD_SAVED = "domain.card.saved"
    CHANNEL_TRENDS = "analytics.palette_trend"

    FLUSH_INTERVAL = 15.0  # seconds between digest publications
    DUMP_FILENAME = "palette_metrics.json"

    def __init__(self, cache_dir: Path, top_k: int = 7) -> None:
        self._cache_dir = cache_dir
        self._top_k = top_k
        self._metrics: Dict[str, PaletteMetric] = {}
        self._loop = asyncio.get_event_loop()
        self._stop_event = asyncio.Event()
        self._bg_task: Optional[asyncio.Task] = None

        # Ensure persistence directory exists
        cache_dir.mkdir(parents=True, exist_ok=True)

        self._load_metrics()
        EventBus.subscribe(self.CHANNEL_CARD_SAVED, self._on_card_saved)

    # ------------------------ Public lifecycle API ------------------------ #

    def start(self) -> None:
        """Spawns the background async task on the current event loop."""
        if self._bg_task and not self._bg_task.done():
            logger.debug("TrendAnalyticsService already running")
            return
        logger.debug("Starting TrendAnalyticsService")
        self._stop_event.clear()
        self._bg_task = self._loop.create_task(self._run())

    def stop(self) -> None:
        """Signal the background task to shut down and wait for completion."""
        logger.debug("Stopping TrendAnalyticsService")
        self._stop_event.set()
        if self._bg_task:
            self._loop.run_until_complete(self._bg_task)
        EventBus.unsubscribe(self.CHANNEL_CARD_SAVED, self._on_card_saved)
        self._dump_metrics()

    # ----------------------- Event-bus / message handlers ------------------ #

    def _on_card_saved(self, card: PrismCard) -> None:
        """
        Event-bus callback fired whenever a PrismCard is saved to the repository.
        Extracts the palette and updates the in-memory metric bucket.
        """
        try:
            if not card.palette:
                return
            h = palette_hash(card.palette)
            metric = self._metrics.setdefault(h, PaletteMetric(palette_hash=h))
            metric.register_hit()
            logger.debug("Registered hit for palette %s (score=%.3f)",
                         h[:7], metric.score)
        except Exception:  # pragma: no cover
            logger.exception("Failed to process card_saved event")

    # ---------------------- Async background processing -------------------- #

    async def _run(self) -> None:
        """Main coroutine loop; flushes top-K trending palettes periodically."""
        try:
            while not self._stop_event.is_set():
                await asyncio.sleep(self.FLUSH_INTERVAL)
                await self._publish_digest()
        finally:
            # On cancellation flush once more for good measure
            await self._publish_digest()

    async def _publish_digest(self) -> None:
        """Compute current top-K palettes and broadcast the trend event."""
        if not self._metrics:
            return

        ranked = sorted(
            ((h, m.score) for h, m in self._metrics.items()),
            key=lambda tup: tup[1],
            reverse=True,
        )[: self._top_k]

        trend_evt = PaletteTrendEvent(
            top_palettes=ranked,
            generated_at=time.time()
        )
        logger.debug("Publishing palette trend event with top %d palettes", len(ranked))
        EventBus.publish(self.CHANNEL_TRENDS, trend_evt)
        self._dump_metrics()

    # ----------------------- Persistence (local storage) ------------------- #

    def _dump_metrics(self) -> None:
        """Persist current metric state to disk (JSON)."""
        try:
            data = {
                h: {
                    "usage_count": m.usage_count,
                    "recency_weight": float(
                        Decimal(m.recency_weight).quantize(
                            Decimal("0.0001"),
                            rounding=ROUND_HALF_UP
                        )
                    ),
                    "last_seen_ts": m.last_seen_ts,
                }
                for h, m in self._metrics.items()
            }
            tmp = self._cache_dir / f"{self.DUMP_FILENAME}.tmp"
            dst = self._cache_dir / self.DUMP_FILENAME
            tmp.write_text(json.dumps(data, separators=(",", ":")))
            tmp.replace(dst)
            logger.debug("Dumped palette metrics to %s", dst)
        except Exception:  # pragma: no cover
            logger.exception("Failed to dump palette metrics")

    def _load_metrics(self) -> None:
        """Load persisted metrics from previous session (if available)."""
        fp = self._cache_dir / self.DUMP_FILENAME
        if not fp.exists():
            return
        try:
            data = json.loads(fp.read_text())
            for h, attrs in data.items():
                self._metrics[h] = PaletteMetric(
                    palette_hash=h,
                    usage_count=int(attrs.get("usage_count", 0)),
                    recency_weight=float(attrs.get("recency_weight", 0.0)),
                    last_seen_ts=float(attrs.get("last_seen_ts", time.time())),
                )
            logger.debug("Loaded %d palette metrics from cache", len(self._metrics))
        except Exception:  # pragma: no cover
            logger.exception("Failed to load palette metrics")


# --------------------------------------------------------------------------- #
# Convenience bootstrap (when running the module directly for debugging)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    cache_path = Path(".cache")
    service = TrendAnalyticsService(cache_path)

    try:
        service.start()

        # Mock some incoming events for demo purposes
        sample_cards = [
            PrismCard(id="1", palette=["#ff0000", "#00ff00", "#0000ff"]),
            PrismCard(id="2", palette=["#FF0000", "#00FF00", "#0000FF"]),
            PrismCard(id="3", palette=["#FFFF00", "#FF00FF"]),
        ]

        for card in sample_cards:
            EventBus.publish(TrendAnalyticsService.CHANNEL_CARD_SAVED, card)

        logger.info("Service running – press Ctrl+C to exit")
        asyncio.get_event_loop().run_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down from __main__")
    finally:
        service.stop()
```