```python
"""
src/module_7.py

Trend analytics engine for PrismPocket.

This module sits in the Domain / Service ring of the Clean Architecture stack.
It consumes immutable PrismCard entities coming from the Repository layer,
derives palette, location, and sentiment metrics, then notifies interested
Observers (e.g. the View-Model responsible for showing “Creative Trends”).
"""

from __future__ import annotations

import colorsys
import logging
import threading
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Dict, Iterable, List, MutableMapping, Optional, Protocol, Sequence, Tuple

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover
    Image = None  # Pillow is optional; color extraction degrades gracefully.

try:
    from textblob import TextBlob  # type: ignore
except ImportError:  # pragma: no cover
    TextBlob = None  # Sentiment analysis will fallback to neutral.


LOGGER = logging.getLogger("prism_pocket.trend_engine")
LOGGER.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
# Domain-level stubs (These would normally live in `domain/entities/…`)
# --------------------------------------------------------------------------- #

@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Minimal stub of PrismCard for trend analysis.
    """
    id: uuid.UUID
    created_at: datetime
    author_id: uuid.UUID
    text: Optional[str] = None
    image_path: Optional[str] = None  # Local path to an image asset.
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    """
    Representation of a color palette extracted from a PrismCard image.
    """
    dominant_rgb: Tuple[int, int, int]
    palette: Tuple[Tuple[int, int, int], ...]
    score: float  # Confidence score (0.0 – 1.0)


# --------------------------------------------------------------------------- #
# Observer Pattern Implementation
# --------------------------------------------------------------------------- #

class Observer(Protocol):
    """
    Observer interface for trend update subscriptions.
    """

    def update(self, event: "TrendEvent") -> None:  # noqa: D401 – imperative
        """
        Receive an event from the TrendAnalyticsEngine.
        """
        ...


@dataclass(frozen=True, slots=True)
class TrendEvent:
    """
    Event object dispatched by TrendAnalyticsEngine.
    """
    timestamp: datetime
    card_id: uuid.UUID
    palette_metric: Optional[PaletteMetric]
    mood_score: float
    location_bucket: Optional[str]


class Observable:
    """
    Thread-safe Observable base class.
    """

    def __init__(self) -> None:
        self._observers: List[Observer] = []
        self._lock = threading.Lock()

    def attach(self, observer: Observer) -> None:
        with self._lock:
            if observer not in self._observers:
                self._observers.append(observer)
                LOGGER.debug("Observer attached: %s", observer)

    def detach(self, observer: Observer) -> None:
        with self._lock:
            if observer in self._observers:
                self._observers.remove(observer)
                LOGGER.debug("Observer detached: %s", observer)

    def _notify(self, event: TrendEvent) -> None:
        for observer in list(self._observers):
            try:
                observer.update(event)
            except Exception:  # pragma: no cover
                LOGGER.exception("Observer %s failed on update()", observer)


# --------------------------------------------------------------------------- #
# Trend Analytics Engine Singleton
# --------------------------------------------------------------------------- #

class TrendAnalyticsEngine(Observable):
    """
    Singleton service that ingests PrismCards and produces trend metrics.

    Usage:
        engine = TrendAnalyticsEngine.instance()
        engine.attach(my_view_model)
        engine.ingest_card(card)
    """

    _INSTANCE: Optional["TrendAnalyticsEngine"] = None
    _INSTANCE_LOCK = threading.Lock()

    WINDOW = timedelta(days=1)  # Rolling window considered “recent”.

    # ---- Singleton plumbing ------------------------------------------------ #

    def __new__(cls) -> "TrendAnalyticsEngine":  # noqa: D401
        raise RuntimeError("Use TrendAnalyticsEngine.instance()")

    @classmethod
    def instance(cls) -> "TrendAnalyticsEngine":
        with cls._INSTANCE_LOCK:
            if cls._INSTANCE is None:
                # Bypass __new__
                cls._INSTANCE = super().__new__(cls)  # type: ignore[misc]
                super(TrendAnalyticsEngine, cls._INSTANCE).__init__(cls._INSTANCE)  # init Observable
                cls._INSTANCE._initialize()
            return cls._INSTANCE

    # ---- Object initialization -------------------------------------------- #

    def _initialize(self) -> None:
        self._trend_lock = threading.RLock()
        self._recent_cards: MutableMapping[uuid.UUID, PrismCard] = {}
        self._palette_counter: Counter[Tuple[int, int, int]] = Counter()
        self._location_counter: Counter[str] = Counter()
        self._mood_scores: List[float] = []

        LOGGER.info("TrendAnalyticsEngine initialized")

    # ---- Public API -------------------------------------------------------- #

    def ingest_card(self, card: PrismCard) -> None:
        """
        Process a new card and update trend statistics.

        This method is thread-safe and non-blocking for observers.
        """
        LOGGER.debug("Ingesting card: %s", card.id)
        palette_metric = self._extract_palette(card)
        mood_score = self._compute_mood(card)
        location_bucket = self._bucket_location(card)

        with self._trend_lock:
            self._recent_cards[card.id] = card
            if palette_metric:
                self._palette_counter[palette_metric.dominant_rgb] += 1
            if location_bucket:
                self._location_counter[location_bucket] += 1
            self._mood_scores.append(mood_score)
            self._prune_expired()

        event = TrendEvent(
            timestamp=datetime.now(tz=timezone.utc),
            card_id=card.id,
            palette_metric=palette_metric,
            mood_score=mood_score,
            location_bucket=location_bucket,
        )
        self._notify(event)
        LOGGER.debug("TrendEvent dispatched for card: %s", card.id)

    def get_top_palettes(self, limit: int = 5) -> List[Tuple[int, int, int]]:
        """
        Return the top N dominant colors from the recent window.
        """
        with self._trend_lock:
            return [rgb for rgb, _ in self._palette_counter.most_common(limit)]

    def get_hotspots(self, limit: int = 5) -> List[str]:
        """
        Return the top N location buckets from the recent window.
        """
        with self._trend_lock:
            return [bucket for bucket, _ in self._location_counter.most_common(limit)]

    def get_average_mood(self) -> float:
        """
        Return the average sentiment score of recent cards (−1.0 … 1.0).
        """
        with self._trend_lock:
            return mean(self._mood_scores) if self._mood_scores else 0.0

    # ---- Internal helpers -------------------------------------------------- #

    def _extract_palette(self, card: PrismCard) -> Optional[PaletteMetric]:
        """
        Extract dominant palette from an image, if present.

        Uses a naive k-means-like quantization when Pillow is available,
        otherwise returns None.
        """
        if not card.image_path or Image is None:
            LOGGER.debug("Palette extraction skipped (no image or Pillow).")
            return None

        try:
            with Image.open(card.image_path) as img:
                img = img.convert("RGB").resize((64, 64))  # downsample for speed
                pixels = list(img.getdata())
        except Exception:  # pragma: no cover
            LOGGER.exception("Failed to open image: %s", card.image_path)
            return None

        # Basic frequency-based dominant color
        freq = Counter(pixels)
        dominant_rgb, _ = freq.most_common(1)[0]
        palette = tuple(rgb for rgb, _ in freq.most_common(5))

        # Compute a rudimentary “vividness” score based on saturation
        hsv = colorsys.rgb_to_hsv(*(c / 255 for c in dominant_rgb))
        score = (hsv[1] + hsv[2]) / 2  # scale 0-1
        metric = PaletteMetric(dominant_rgb=dominant_rgb, palette=palette, score=round(score, 3))

        LOGGER.debug("Palette extracted for card %s: %s", card.id, metric)
        return metric

    def _compute_mood(self, card: PrismCard) -> float:
        """
        Determine a sentiment score from card text (−1.0 … 1.0).

        On devices without TextBlob, returns neutral (0.0).
        """
        text = card.text or ""
        if not text.strip() or TextBlob is None:
            LOGGER.debug("Mood analysis skipped (no text or TextBlob).")
            return 0.0

        try:
            polarity = TextBlob(text).sentiment.polarity
            LOGGER.debug("Mood score for card %s: %.3f", card.id, polarity)
            return polarity
        except Exception:  # pragma: no cover
            LOGGER.exception("Sentiment analysis failed.")
            return 0.0

    def _bucket_location(self, card: PrismCard) -> Optional[str]:
        """
        Bucketize coordinates into ‘geo-hash like’ strings for trend grouping.
        """
        if card.latitude is None or card.longitude is None:
            return None

        # Simple 1-degree grid hash
        lat_bucket = int(card.latitude)
        lon_bucket = int(card.longitude)
        bucket = f"{lat_bucket:+03d}:{lon_bucket:+03d}"
        LOGGER.debug("Location bucket for card %s: %s", card.id, bucket)
        return bucket

    def _prune_expired(self) -> None:
        """
        Remove cards and metrics that have fallen outside of the rolling window.
        """
        cutoff = datetime.now(tz=timezone.utc) - self.WINDOW
        expired_ids: List[uuid.UUID] = [
            cid for cid, c in self._recent_cards.items() if c.created_at < cutoff
        ]
        for cid in expired_ids:
            card = self._recent_cards.pop(cid)
            LOGGER.debug("Pruning expired card: %s", cid)
            # Reverse apply counters if possible
            palette_metric = self._extract_palette(card)
            if palette_metric:
                self._palette_counter[palette_metric.dominant_rgb] -= 1
                if self._palette_counter[palette_metric.dominant_rgb] <= 0:
                    del self._palette_counter[palette_metric.dominant_rgb]

            bucket = self._bucket_location(card)
            if bucket:
                self._location_counter[bucket] -= 1
                if self._location_counter[bucket] <= 0:
                    del self._location_counter[bucket]

        # Recompute mood scores list
        self._mood_scores = [
            self._compute_mood(c)
            for c in self._recent_cards.values()
            if c.text and c.text.strip()
        ]


# --------------------------------------------------------------------------- #
# Factory helper (optional)
# --------------------------------------------------------------------------- #

class AnalyticsEngineFactory:
    """
    Simple factory to produce (or fetch) the singleton instance.

    Provided primarily so that DI frameworks can request a concrete
    implementation via interface, and we yet keep the engine a singleton.
    """

    @staticmethod
    def create() -> TrendAnalyticsEngine:
        """
        Return the singleton TrendAnalyticsEngine instance.
        """
        return TrendAnalyticsEngine.instance()


# --------------------------------------------------------------------------- #
# Example Observer Implementation
# --------------------------------------------------------------------------- #

class LoggingObserver(Observer):
    """
    Debug observer that logs every trend event.
    """

    def update(self, event: TrendEvent) -> None:
        LOGGER.info(
            "TrendEvent ▸ card=%s mood=%.2f bucket=%s dominant=%s",
            event.card_id,
            event.mood_score,
            event.location_bucket,
            event.palette_metric.dominant_rgb if event.palette_metric else None,
        )


# --------------------------------------------------------------------------- #
# Module-level convenience
# --------------------------------------------------------------------------- #

# Expose a ready-to-use singleton for most callers
trend_engine = TrendAnalyticsEngine.instance()
```