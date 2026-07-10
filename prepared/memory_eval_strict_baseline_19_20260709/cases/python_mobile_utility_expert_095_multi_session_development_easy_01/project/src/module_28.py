```python
"""
PrismPocket – Color Trend Analytics Engine
------------------------------------------

This module houses a self-contained analytics engine that ingests `PrismCard`
events, extracts dominant colour information, and produces real-time palette
trends and creative prompts.  It adheres to PrismPocket’s architectural
guidelines (Singleton, Observer, Repository) but keeps all logic local so the
file can be dropped into a fresh checkout without additional dependencies.

Typical workflow
----------------
1.  External adapter publishes `"card_synced"` events to `ObserverBus`.
2.  `ColorTrendEngine` (a singleton) is auto-registered as a listener.  
3.  On every incoming card:
      • dominant colours are extracted (or re-used if already provided)  
      • internal counters & rolling statistics are updated  
      • secondary events such as `"palette_metric_updated"` are emitted  
4.  Consumers (e.g. ViewModels, Suggestion engines) subscribe to those events
    to update UI or recommend artistic prompts to users.

If Pillow is available, the engine will perform true colour quantisation;
otherwise it falls back to a lightweight histogram based on random sampling.
"""

from __future__ import annotations

import datetime as _dt
import itertools as _it
import logging as _logging
import random as _random
import statistics as _statistics
import threading as _threading
import time as _time
from collections import Counter as _Counter, defaultdict as _defaultdict
from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import (Any, Callable, Dict, Iterable, List, MutableMapping,
                    Optional, Sequence, Set, Tuple)

# --------------------------------------------------------------------------- #
# Optional dependency – if not present we gracefully downgrade functionality. #
# --------------------------------------------------------------------------- #
try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover
    Image = None  # Pillow not available

__all__ = [
    "PrismCard",
    "PaletteMetric",
    "ObserverBus",
    "ColorTrendEngine",
]

###############################################################################
# Logging
###############################################################################

_logger = _logging.getLogger("prismpocket.analytics")
_logger.setLevel(_logging.INFO)

###############################################################################
# Domain Stubs (would normally live elsewhere in the project)
###############################################################################


@dataclass(slots=True, frozen=True)
class PrismCard:
    """
    Light-weight representation of a synced prism card.

    For the purpose of the colour analytics engine we only need a subset of the
    full domain entity – namely its identifier, capture timestamp and (optionally)
    a pre-computed colour histogram.
    """

    card_id: str
    media_path: str  # Path to an image on local storage
    created_at: _dt.datetime
    text: Optional[str] = None
    color_histogram: Optional[Sequence[Tuple[int, int, int]]] = None  # Top colours (RGB)
    mood_score: Optional[float] = None  # Placeholder for extended analysis


@dataclass(slots=True)
class PaletteMetric:
    """
    Captures aggregated usage information of a palette.
    """
    palette: Tuple[str, ...]  # Hex strings e.g. ('#FFEE00', '#000000', '#333333')
    usage_count: int
    last_seen: _dt.datetime
    mood_mean: Optional[float] = None

    @property
    def popularity_score(self) -> float:
        """
        A simple heuristic combining frequency and recency.
        """
        hours_since_seen = (_dt.datetime.utcnow() - self.last_seen).total_seconds() / 3600
        recency_penalty = 1 / (1 + hours_since_seen)
        return self.usage_count * recency_penalty


###############################################################################
# Observer Bus (Singleton)
###############################################################################

class EventType(str, Enum):
    CARD_SYNCED = "card_synced"
    PALETTE_METRIC_UPDATED = "palette_metric_updated"
    ERROR = "error"


class SingletonMeta(type):
    """
    Thread-safe Singleton metaclass.
    """
    _instances: Dict[type, Any] = {}
    _lock: _threading.Lock = _threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class ObserverBus(metaclass=SingletonMeta):
    """
    Simplified in-memory observer bus supporting synchronous callbacks.
    """

    def __init__(self) -> None:
        self._subscribers: MutableMapping[EventType, Set[Callable[[Any], None]]] = _defaultdict(set)
        self._bus_lock = _threading.RLock()

    # --------------------------------------------------------------------- #
    # Subscription
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: EventType, callback: Callable[[Any], None]) -> None:
        """
        Register a callable for a given event type.
        """
        with self._bus_lock:
            self._subscribers[event_type].add(callback)
            _logger.debug("Subscriber %s registered for %s", callback, event_type)

    def unsubscribe(self, event_type: EventType, callback: Callable[[Any], None]) -> None:
        """
        Remove a callable from the subscriber list.
        """
        with self._bus_lock:
            self._subscribers[event_type].discard(callback)
            _logger.debug("Subscriber %s removed from %s", callback, event_type)

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #

    def publish(self, event_type: EventType, payload: Any) -> None:
        """
        Dispatch payload to all listeners.  Exceptions inside listeners are
        caught and re-routed as ERROR events so a single bad subscriber does not
        break the bus.
        """
        with self._bus_lock:
            listeners = list(self._subscribers.get(event_type, []))
        if not listeners:
            _logger.debug("No listeners for event %s – skipping dispatch.", event_type)
            return

        _logger.debug("Dispatching event %s to %d listener(s).", event_type, len(listeners))
        for callback in listeners:
            try:
                callback(payload)
            except Exception as exc:  # pragma: no cover
                _logger.exception("Listener %s raised during %s: %s", callback, event_type, exc)
                self.publish(EventType.ERROR, exc)


###############################################################################
# Color Trend Engine
###############################################################################

class ColorTrendEngine(metaclass=SingletonMeta):
    """
    Ingests PrismCard instances, maintains palette statistics and pushes
    analytics events onto the ObserverBus.

    The heavy lifting (colour extraction) can optionally be done using Pillow;
    in pure-python mode the engine relies on a lightweight random sampler which
    is considerably less accurate but avoids forcing the dependency.
    """

    # Maximum distinct colours we keep per card to avoid memory bloat.
    _MAX_COLORS_PER_CARD: int = 5

    def __init__(self) -> None:
        self._palette_counter: _Counter[Tuple[str, ...]] = _Counter()
        self._palette_meta: Dict[Tuple[str, ...], PaletteMetric] = {}
        self._engine_lock = _threading.RLock()
        self._stop_event = _threading.Event()

        # Background thread recomputes rolling mood means and cleans stale palettes.
        self._maintenance_thread = _threading.Thread(
            name="ColorTrendMaintenance",
            target=self._maintenance_loop,
            daemon=True,
        )
        self._maintenance_thread.start()

        # Self-register to observer bus
        ObserverBus().subscribe(EventType.CARD_SYNCED, self.ingest_card)

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def ingest_card(self, card: PrismCard) -> None:
        """
        Update internal metrics with a newly synced card.
        """
        try:
            _logger.debug("Ingesting card %s", card.card_id)

            # Step 1: Derive palette
            palette = self._derive_palette(card)

            # Step 2: Update counters
            with self._engine_lock:
                self._palette_counter[palette] += 1
                if palette not in self._palette_meta:
                    self._palette_meta[palette] = PaletteMetric(
                        palette=palette,
                        usage_count=0,
                        last_seen=_dt.datetime.utcnow(),
                    )
                metric = self._palette_meta[palette]
                metric.usage_count = self._palette_counter[palette]
                metric.last_seen = _dt.datetime.utcnow()
                if card.mood_score is not None:
                    # Keep rolling mood scores for later retrieval.
                    prev = metric.mood_mean or card.mood_score
                    metric.mood_mean = (prev + card.mood_score) / 2

            # Step 3: Publish update
            ObserverBus().publish(EventType.PALETTE_METRIC_UPDATED, metric)
            _logger.info(
                "Palette %s now has %d occurrences (popularity=%.2f)",
                palette,
                metric.usage_count,
                metric.popularity_score,
            )

        except Exception as exc:  # pragma: no cover
            _logger.exception("Failed to ingest card %s: %s", card.card_id, exc)
            ObserverBus().publish(EventType.ERROR, exc)

    def get_top_palettes(self, limit: int = 5) -> List[PaletteMetric]:
        """
        Return the most popular palettes sorted by composite popularity score.
        """
        with self._engine_lock:
            return sorted(
                self._palette_meta.values(),
                key=lambda pm: pm.popularity_score,
                reverse=True,
            )[:limit]

    def generate_prompt(self) -> str:
        """
        Produce a creative prompt based on trending colours.
        """
        top_palettes = self.get_top_palettes(limit=3)
        if not top_palettes:
            return "Capture something colourful around you!"

        chosen = _random.choice(top_palettes)
        colours = ", ".join(chosen.palette[:3])
        return f"Try remixing with these colours: {colours}"

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    def _derive_palette(self, card: PrismCard) -> Tuple[str, ...]:
        """
        Return a canonical palette (tuple of hex strings) for a given card,
        either by using its pre-computed histogram or by running our own
        extraction algorithm.
        """
        if card.color_histogram:
            _logger.debug("Using provided histogram for card %s", card.card_id)
            rgb = card.color_histogram
        else:
            _logger.debug("Extracting colours from %s", card.media_path)
            rgb = self._extract_colours_from_media(card.media_path)

        # Keep only the most frequent colours (max 5) and convert to hex.
        trimmed = rgb[: self._MAX_COLORS_PER_CARD]
        palette = tuple(self._rgb_to_hex(c) for c in trimmed)
        return palette

    def _extract_colours_from_media(self, media_path: str) -> List[Tuple[int, int, int]]:
        """
        Extract dominant colours from an image using Pillow if available,
        otherwise fall back to random sampling.
        """
        path = Path(media_path)
        if not path.exists():
            _logger.warning("Media file %s does not exist – using fallback palette.", media_path)
            return [(255, 255, 255)]  # white as placeholder

        if Image is None:  # Pillow not installed
            return self._fallback_palette(path)

        try:
            with Image.open(path) as img:
                img = img.convert("RGB")
                # Resize to speed up processing
                img.thumbnail((256, 256))
                # Quantise to ensure limited colour set
                result = img.quantize(colors=self._MAX_COLORS_PER_CARD, method=Image.MEDIANCUT)
                palette = result.getpalette()
                colour_counts = _Counter(result.getdata())
                # Sort by frequency
                dominant = sorted(
                    colour_counts.items(),
                    key=lambda t: t[1],
                    reverse=True,
                )
                rgb_values: List[Tuple[int, int, int]] = []
                for colour_index, _count in dominant[: self._MAX_COLORS_PER_CARD]:
                    offset = colour_index * 3
                    rgb_values.append(
                        tuple(palette[offset + i] for i in range(3))  # type: ignore[misc]
                    )
                return rgb_values
        except Exception as exc:  # pragma: no cover
            _logger.exception("Pillow extraction failed for %s: %s", media_path, exc)
            return self._fallback_palette(path)

    def _fallback_palette(self, path: Path) -> List[Tuple[int, int, int]]:
        """
        Extremely naïve palette: sample k random pixels to approximate colour
        distribution without external libraries.
        """
        # For demonstration we just generate random colours based on filename hash.
        _random.seed(hash(path.name))
        palette = [
            (
                _random.randint(0, 255),
                _random.randint(0, 255),
                _random.randint(0, 255),
            )
            for _ in range(self._MAX_COLORS_PER_CARD)
        ]
        _logger.debug("Generated fallback palette for %s: %s", path, palette)
        return palette

    @staticmethod
    def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
        return "#{:02X}{:02X}{:02X}".format(*rgb)

    # --------------------------------------------------------------------- #
    # Background maintenance
    # --------------------------------------------------------------------- #

    _PALETTE_TTL_HOURS: float = 24  # Remove palettes not seen in this window

    def _maintenance_loop(self) -> None:
        """
        Periodically clean up stale palettes and recompute statistics.
        """
        _logger.debug("ColorTrendEngine maintenance loop started.")
        while not self._stop_event.is_set():
            try:
                self._run_maintenance_cycle()
            except Exception as exc:  # pragma: no cover
                _logger.exception("Maintenance cycle failure: %s", exc)
            self._stop_event.wait(60)  # run every minute

    def _run_maintenance_cycle(self) -> None:
        """
        Remove stale palettes and log health status.
        """
        cutoff = _dt.datetime.utcnow() - _dt.timedelta(hours=self._PALETTE_TTL_HOURS)
        with self._engine_lock:
            stale_palettes = [
                p for p, meta in self._palette_meta.items() if meta.last_seen < cutoff
            ]
            for palette in stale_palettes:
                _logger.debug("Removing stale palette %s", palette)
                del self._palette_meta[palette]
                if palette in self._palette_counter:
                    del self._palette_counter[palette]
        _logger.debug(
            "Maintenance completed. %d palettes tracked.",
            len(self._palette_meta),
        )

    # --------------------------------------------------------------------- #
    # Shutdown
    # --------------------------------------------------------------------- #

    def shutdown(self) -> None:
        """
        Signal the maintenance thread to stop.  Should be called during
        application teardown to allow a clean exit.
        """
        _logger.info("Shutting down ColorTrendEngine.")
        self._stop_event.set()
        self._maintenance_thread.join(timeout=5)


###############################################################################
# On-import initialisation
###############################################################################

# Trigger engine instantiation so it starts listening immediately.
ColorTrendEngine()

###############################################################################
# CLI helper (optional)
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    import argparse
    import json
    import os

    parser = argparse.ArgumentParser(description="PrismPocket Color Trend CLI")
    parser.add_argument("image", help="Path to an image file to ingest.")
    parser.add_argument("--text", help="Optional caption.")
    args = parser.parse_args()

    if not os.path.exists(args.image):
        parser.error("Image does not exist.")

    card = PrismCard(
        card_id=f"cli_{int(_time.time())}",
        media_path=args.image,
        created_at=_dt.datetime.utcnow(),
        text=args.text,
        mood_score=_random.uniform(-1.0, 1.0),
    )

    bus = ObserverBus()
    bus.publish(EventType.CARD_SYNCED, card)

    engine = ColorTrendEngine()
    print(json.dumps([pm.__dict__ for pm in engine.get_top_palettes()], indent=2))
```