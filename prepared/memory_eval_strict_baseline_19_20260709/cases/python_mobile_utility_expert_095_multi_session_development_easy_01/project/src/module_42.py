```python
"""
module_42.py

Analytics processing pipeline for PrismPocket.

Responsibilities
----------------
✓ Listens to PrismCard creation/update events via Observer bus.  
✓ Extracts key metrics: dominant color palette, geo-hotspots, mood score.  
✓ Maintains running aggregates and exposes a query interface for View-Models.  

The module purposefully avoids any platform-specific dependencies so it can be
shared by both the iOS & Android packages of PrismPocket.
"""
from __future__ import annotations

import json
import logging
import random
import threading
import time
from collections import Counter, deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Set, Tuple

try:                     # Pillow is an optional dependency for image analysis
    from PIL import Image
except ImportError:      # pragma: no cover
    Image = None         # Soft-fail if not present

# -----------------------------------------------------------------------------
# Logging configuration
# -----------------------------------------------------------------------------
logger = logging.getLogger(__name__)
if not logger.handlers:                      # Re-usable config when reloaded
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s — %(message)s")
    )
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)

# -----------------------------------------------------------------------------
# Design-pattern helpers
# -----------------------------------------------------------------------------
class SingletonMeta(type):
    """
    Thread-safe implementation of the Singleton pattern using a metaclass.
    """
    _instances: Dict[type, "SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        # Double-checked locking
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:
                    inst = super().__call__(*args, **kwargs)
                    cls._instances[cls] = inst
        return cls._instances[cls]


class Observable:
    """
    Lightweight Observable base-class (Observer pattern).
    """

    __slots__ = ("_observers", "_lock")

    def __init__(self) -> None:
        self._observers: Set[Callable[..., None]] = set()
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- API
    def subscribe(self, fn: Callable[..., None]) -> None:
        with self._lock:
            self._observers.add(fn)

    def unsubscribe(self, fn: Callable[..., None]) -> None:
        with self._lock:
            self._observers.discard(fn)

    # ------------------------------------------------------------ internal use
    def _notify(self, *args, **kwargs) -> None:
        with self._lock:
            observers = tuple(self._observers)
        for fn in observers:
            try:
                fn(*args, **kwargs)
            except Exception:  # pragma: no cover
                logger.exception("Observer %r raised.", fn)


# -----------------------------------------------------------------------------
# Domain entities (trimmed down versions used by engine)
# -----------------------------------------------------------------------------
@dataclass(frozen=True)
class GeoPoint:
    lat: float
    lon: float


@dataclass(frozen=True)
class PrismCard:
    """
    Slightly simplified representation of the domain entity “PrismCard” used by
    the engine. In the real project this dataclass lives in the `domain`
    package; we duplicate the minimum subset here to keep the module isolated.
    """

    id: str
    created_ts: float
    media_path: Optional[Path] = None  # Image only (other media ignored here)
    text: Optional[str] = None
    geo: Optional[GeoPoint] = None
    tags: List[str] = field(default_factory=list)

    # ---------------------------------------------------------------- helpers
    def has_image(self) -> bool:
        return bool(self.media_path and self.media_path.exists())


# -----------------------------------------------------------------------------
# Color utilities (private)
# -----------------------------------------------------------------------------
class _ColorUtils:
    """
    Tiny utility collection for palette extraction decoupled from Pillow so the
    rest of the engine keeps working even if the dependency is missing.
    """

    @staticmethod
    def extract_palette(path: Path, k: int = 5) -> List[Tuple[int, int, int]]:
        """
        Extract up to `k` dominant RGB tuples from an image using Pillow’s
        median-cut quantizer. Returns an empty list if Pillow is not available.
        """
        if Image is None:
            logger.debug("Pillow not installed ‑ palette extraction skipped.")
            return []

        try:
            with Image.open(path).convert("RGB") as img:
                img.thumbnail((128, 128))
                paletted = img.quantize(colors=k, method=Image.MEDIANCUT)
                palette = paletted.getpalette()[: k * 3]
                return [tuple(palette[i : i + 3]) for i in range(0, len(palette), 3)]
        except Exception as exc:  # pragma: no cover
            logger.exception("Could not extract palette from %s: %s", path, exc)
            return []


# -----------------------------------------------------------------------------
# Event types consumed by the engine
# -----------------------------------------------------------------------------
@dataclass(slots=True)
class CardEvent:
    card: PrismCard
    event_type: str  # “created”, “updated”, …
    ts: float = field(default_factory=time.time)


# -----------------------------------------------------------------------------
# Core analytics engine
# -----------------------------------------------------------------------------
class AnalyticsEngine(Observable, metaclass=SingletonMeta):
    """
    Central async analytics component.
    """

    _TREND_WINDOW_SEC = 60 * 60 * 24 * 3  # 3 days history considered “trending”

    def __init__(self, workers: int = 4) -> None:
        super().__init__()
        self._executor = ThreadPoolExecutor(max_workers=workers)
        self._queue: deque[CardEvent] = deque()
        self._palette_counter: Counter[Tuple[int, int, int]] = Counter()
        self._hotspot_counter: Counter[Tuple[int, int]] = Counter()
        self._mood_counter: Counter[str] = Counter()
        self._state_lock = threading.RLock()

        # Dedicated dispatcher thread for snapshot emission
        self._stop_event = threading.Event()
        self._dispatcher = threading.Thread(
            target=self._dispatch_loop, name="Analytics-Dispatcher", daemon=True
        )
        self._dispatcher.start()
        logger.debug("AnalyticsEngine instantiated with %d workers.", workers)

    # ---------------------------------------------------------------- public –

    def push(self, event: CardEvent) -> Future:
        """
        Enqueue a new CardEvent for processing.
        """
        logger.debug("Event %s received for card %s.", event.event_type, event.card.id)
        return self._executor.submit(self._process_event, event)

    def shutdown(self, wait: bool = True) -> None:
        """
        Clean shutdown for application exit or testing teardown.
        """
        logger.info("AnalyticsEngine shutting down…")
        self._stop_event.set()
        if wait:
            self._dispatcher.join(timeout=3)
        self._executor.shutdown(wait=wait)

    # ---------------------------------------------------------- internal flow

    def _process_event(self, event: CardEvent) -> None:
        """
        Heavy-lifting happens here but within executor threads.
        """
        try:
            card = event.card
            palette = _ColorUtils.extract_palette(card.media_path) if card.has_image() else []
            mood = self._infer_mood(card)

            with self._state_lock:
                self._queue.append(event)

                # Palette
                for rgb in palette:
                    self._palette_counter[rgb] += 1

                # Geo hotspots (rounded to 0.1 deg bucket)
                if card.geo:
                    bucket = (round(card.geo.lat, 1), round(card.geo.lon, 1))
                    self._hotspot_counter[bucket] += 1

                # Mood
                if mood:
                    self._mood_counter[mood] += 1

            logger.debug("Card %s processed.", card.id)
        except Exception:
            logger.exception("Unhandled error processing event for card %s.", event.card.id)

    def _dispatch_loop(self) -> None:
        """
        Periodically publishes analytics snapshots to observers.
        """
        logger.debug("Dispatcher thread started.")
        while not self._stop_event.is_set():
            self._stop_event.wait(5)
            if self._stop_event.is_set():
                break

            self._trim_history()
            snapshot = self._build_snapshot()
            self._notify(snapshot)

    # --------------------------------------------------------- helper logic

    def _trim_history(self) -> None:
        """
        Remove events that fall outside the trend window to keep counters fresh.
        """
        cutoff = time.time() - self._TREND_WINDOW_SEC
        with self._state_lock:
            while self._queue and self._queue[0].ts < cutoff:
                old = self._queue.popleft()
                self._reverse_event(old)

    def _reverse_event(self, event: CardEvent) -> None:
        """
        Roll back counters for an expired event.
        """
        card = event.card
        palette = _ColorUtils.extract_palette(card.media_path) if card.has_image() else []
        for rgb in palette:
            self._palette_counter[rgb] -= 1
            if self._palette_counter[rgb] <= 0:
                self._palette_counter.pop(rgb, None)

        if card.geo:
            bucket = (round(card.geo.lat, 1), round(card.geo.lon, 1))
            self._hotspot_counter[bucket] -= 1
            if self._hotspot_counter[bucket] <= 0:
                self._hotspot_counter.pop(bucket, None)

        mood = self._infer_mood(card)
        if mood:
            self._mood_counter[mood] -= 1
            if self._mood_counter[mood] <= 0:
                self._mood_counter.pop(mood, None)

    def _build_snapshot(self) -> Dict[str, object]:
        """
        Take a thread-safe snapshot of current analytics state.
        """
        with self._state_lock:
            snapshot = {
                "ts": time.time(),
                "top_palettes": self._palette_counter.most_common(10),
                "hotspots": self._hotspot_counter.most_common(10),
                "moods": self._mood_counter.most_common(),
            }
        logger.debug("Snapshot built: %s", snapshot)
        return snapshot

    @staticmethod
    def _infer_mood(card: PrismCard) -> Optional[str]:
        """
        Extremely naive mood classifier using tag look-ups.
        """
        moods = {
            "happy": {"happy", "joy", "smile"},
            "calm": {"calm", "zen", "peace"},
            "love": {"love", "heart", "romantic"},
            "energetic": {"energy", "excited", "hype"},
        }

        tag_set = set(map(str.lower, card.tags))
        for mood, keywords in moods.items():
            if tag_set & keywords:
                return mood
        return None


# -----------------------------------------------------------------------------
# Convenience factory for external callers
# -----------------------------------------------------------------------------
def ingest_card_payload(payload: Dict) -> CardEvent:
    """
    Validate & transform raw dict into CardEvent, raising ValueError on issues.
    """
    try:
        card = PrismCard(
            id=payload["id"],
            created_ts=payload.get("created_ts", time.time()),
            media_path=Path(payload["media_path"]) if payload.get("media_path") else None,
            text=payload.get("text"),
            geo=GeoPoint(**payload["geo"]) if payload.get("geo") else None,
            tags=payload.get("tags", []),
        )
    except (TypeError, KeyError) as exc:
        raise ValueError(f"Malformed card dict: {exc}") from exc

    return CardEvent(card=card, event_type=payload.get("event_type", "created"))


# -----------------------------------------------------------------------------
# Example observer for debugging / dev tools
# -----------------------------------------------------------------------------
class DebugAnalyticsPrinter:
    """Observer that pretty-prints snapshots to the console."""

    def __call__(self, snapshot: Dict[str, object]) -> None:
        pretty = json.dumps(snapshot, default=str, indent=2)
        logger.info("Analytics Snapshot\n%s", pretty)


# -----------------------------------------------------------------------------
# Ad-hoc manual test (executed when run directly)
# -----------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    engine = AnalyticsEngine()
    engine.subscribe(DebugAnalyticsPrinter())

    # Simulate event flow
    for i in range(3):
        payload = {
            "id": f"card_{i}",
            "created_ts": time.time(),
            "media_path": None,  # supply an image path to test palette
            "geo": {"lat": 37.77 + random.uniform(-0.05, 0.05), "lon": -122.42},
            "tags": random.choice([["happy"], ["calm"], ["love"], []]),
        }
        event = ingest_card_payload(payload)
        engine.push(event)
        time.sleep(1)

    try:
        time.sleep(10)  # let dispatcher send a couple of snapshots
    finally:
        engine.shutdown()
```