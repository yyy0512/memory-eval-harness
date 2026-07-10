```python
"""
PrismPocket – Palette Trend Service
-----------------------------------

This module implements real-time analysis of `PrismCard` colour usage
patterns. It continuously ingests newly-created cards, extracts their
dominant palettes, updates rolling metrics, and emits `TrendUpdateEvent`
objects on the global Observer bus.

Design patterns leveraged
=========================
1. Singleton          – A single, shared `PaletteTrendService` instance.
2. Factory            – `ColorExtractorFactory` chooses extraction strategy.
3. Observer           – Service pushes updates to listening view-models.
4. Repository         – Pulls cards through the injected `PrismCardRepository`.
5. Clean Architecture – No direct dependency on UI / platform code.

NOTE: External dependencies (Pillow, numpy, sklearn) are optional.  If they
are unavailable the module transparently falls back to a lightweight
histogram-based extractor.
"""

from __future__ import annotations

import asyncio
import collections
import datetime as _dt
import logging
import random
import statistics
from functools import lru_cache
from pathlib import Path
from types import MappingProxyType
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

try:
    # Heavyweight path – preferred for accuracy.
    import numpy as _np
    from PIL import Image as _Image  # type: ignore
    from sklearn.cluster import KMeans  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    # Lightweight fallback.
    _np = None  # type: ignore
    _Image = None  # type: ignore
    KMeans = None  # type: ignore


_LOGGER = logging.getLogger(__name__)
RGB = Tuple[int, int, int]


# =============================================================================
# Domain stubs (imported dynamically in production runtime)
# =============================================================================

try:
    # The real packages live inside `prism.domain.*`
    from prism.domain.entities import PrismCard, PaletteMetric  # type: ignore
    from prism.common.events import TrendUpdateEvent  # type: ignore
    from prism.common.observer import ObserverBus  # type: ignore

except ModuleNotFoundError:  # pragma: no cover

    class PrismCard:  # noqa: D401
        """Stub fallback for type-checking only."""

        def __init__(self, card_id: str, media_path: Path, created_at: _dt.datetime):
            self.card_id = card_id
            self.media_path = media_path
            self.created_at = created_at

        def __repr__(self) -> str:  # noqa: D401
            return f"PrismCard({self.card_id})"

    class PaletteMetric:  # noqa: D401
        """Colour palette metric record."""

        def __init__(self, rgb: RGB, weight: float) -> None:
            self.rgb, self.weight = rgb, weight

    class TrendUpdateEvent:  # noqa: D401
        """Event raised when new palette trends are available."""

        def __init__(self, top_colors: Sequence[RGB], timestamp: _dt.datetime):
            self.top_colors = top_colors
            self.timestamp = timestamp

    class ObserverBus:  # noqa: D401
        """Simplified synchronous observer bus."""

        _listeners: List = []

        @classmethod
        def subscribe(cls, fn) -> None:
            cls._listeners.append(fn)

        @classmethod
        def post(cls, event) -> None:
            for fn in cls._listeners:
                try:
                    fn(event)
                except Exception:  # pragma: no cover
                    _LOGGER.exception("Unhandled error in observer listener.")


# =============================================================================
# Color Extraction strategies
# =============================================================================


class ColorExtractor:
    """Strategy interface that extracts dominant colours from an image."""

    __slots__ = ()

    async def extract(self, image_path: Path, k: int = 5) -> List[RGB]:
        """Extract `k` dominant RGB colours."""
        raise NotImplementedError


class HistogramColorExtractor(ColorExtractor):
    """
    Fallback colour extractor based on a naive RGB histogram.

    Works without numpy/sklearn, at the cost of reduced accuracy.
    """

    __slots__ = ("_loop",)

    def __init__(self) -> None:
        self._loop = asyncio.get_running_loop()

    async def extract(self, image_path: Path, k: int = 5) -> List[RGB]:
        if _Image is None:  # pragma: no cover
            raise RuntimeError("Pillow not installed; colour extraction unavailable.")

        return await self._loop.run_in_executor(
            None, self._sync_extract, image_path, k
        )

    @staticmethod
    def _sync_extract(image_path: Path, k: int) -> List[RGB]:
        with _Image.open(image_path).convert("RGB") as img:
            histogram = img.getcolors(img.size[0] * img.size[1])  # type: ignore
            if not histogram:  # pragma: no cover
                return []

        # Sort by frequency, then take top k
        histogram.sort(key=lambda tup: tup[0], reverse=True)
        top_pixels = [pix for _cnt, pix in histogram[: k * 10]]

        # Down-sample if there are too many colours
        stride = max(1, len(top_pixels) // k)
        sampled = [top_pixels[i] for i in range(0, len(top_pixels), stride)][:k]
        return sampled


class KMeansColorExtractor(ColorExtractor):
    """More accurate extractor using K-Means clustering (requires numpy, sklearn)."""

    __slots__ = ()

    async def extract(self, image_path: Path, k: int = 5) -> List[RGB]:
        if _np is None or KMeans is None or _Image is None:  # pragma: no cover
            raise RuntimeError("KMeans extractor selected but dependencies missing.")

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._sync_extract, image_path, k)

    @staticmethod
    def _sync_extract(image_path: Path, k: int) -> List[RGB]:
        with _Image.open(image_path).convert("RGB") as img:
            arr = _np.asarray(img)
            flat = arr.reshape(-1, 3)

        # KMeans may raise ValueError for small inputs
        try:
            model = KMeans(n_clusters=k, n_init="auto")
            model.fit(flat)
            colors = model.cluster_centers_.astype(int)
        except Exception:  # pragma: no cover
            # Fall back to random sample
            colors = random.sample(list(map(tuple, flat)), min(k, len(flat)))

        return [tuple(map(int, rgb)) for rgb in colors]


class ColorExtractorFactory:
    """Factory that hands out the best possible extractor for the runtime."""

    _PREFERRED = (
        KMeansColorExtractor if _np is not None and KMeans is not None else None
    )

    @classmethod
    def build(cls) -> ColorExtractor:
        if cls._PREFERRED is not None:
            _LOGGER.debug("Using KMeansColorExtractor.")
            return cls._PREFERRED()
        _LOGGER.debug("Using HistogramColorExtractor (fallback).")
        return HistogramColorExtractor()


# =============================================================================
# Palette Trend Service (Singleton)
# =============================================================================


class PaletteTrendService:
    """
    Computes rolling statistics for palette usage across the user's PrismCards.

    The public interface is intentionally small; the heavy lifting is internal.
    """

    _INSTANCE: Optional["PaletteTrendService"] = None

    # Configurable parameters
    WINDOW_HOURS = 24
    TOP_N_COLORS = 6

    # --------------------------------------------------------------------- #
    # Construction / Singleton plumbing
    # --------------------------------------------------------------------- #
    def __new__(cls, *args, **kwargs):  # noqa: D401
        if cls._INSTANCE is None:
            cls._INSTANCE = super().__new__(cls)
        return cls._INSTANCE

    def __init__(self, repository: "PrismCardRepository"):  # noqa: D401
        if hasattr(self, "_initialized"):
            return  # Avoid running __init__ twice in the singleton.
        self._initialized = True

        self._repo = repository
        self._extractor = ColorExtractorFactory.build()
        self._metrics: "collections.deque[Tuple[_dt.datetime, List[RGB]]]" = (
            collections.deque()
        )
        self._lock = asyncio.Lock()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    async def warm_start(self) -> None:
        """
        Prime the service with cards from the past WINDOW_HOURS.

        Should be awaited once during application startup.
        """
        cutoff = _dt.datetime.utcnow() - _dt.timedelta(hours=self.WINDOW_HOURS)
        cards = await self._repo.fetch_since(cutoff)
        for card in cards:
            try:
                palette = await self._extract_palette(card)
            except Exception:  # pragma: no cover
                _LOGGER.exception("Failed to extract palette for %s", card)
                continue
            self._metrics.append((card.created_at, palette))

        await self._broadcast_trends()

    async def on_new_card(self, card: PrismCard) -> None:
        """Callback for repository when a new card is persisted."""
        async with self._lock:
            palette = await self._extract_palette(card)
            self._metrics.append((card.created_at, palette))
            self._drop_expired()
            await self._broadcast_trends()

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    async def _extract_palette(self, card: PrismCard, k: int = 5) -> List[RGB]:
        """Extract a list of dominant colours from the card."""
        if not card.media_path.exists():
            raise FileNotFoundError(card.media_path)

        palette = await self._extractor.extract(card.media_path, k=k)
        return palette

    def _drop_expired(self) -> None:
        """Keep the internal buffer within the rolling window."""
        cutoff = _dt.datetime.utcnow() - _dt.timedelta(hours=self.WINDOW_HOURS)
        while self._metrics and self._metrics[0][0] < cutoff:
            self._metrics.popleft()

    async def _broadcast_trends(self) -> None:
        """Compute top colours and push an event to the Observer bus."""
        flat_colours = [rgb for _ts, pal in self._metrics for rgb in pal]
        if not flat_colours:
            return

        # Very naive frequency count.
        freq: Dict[RGB, int] = collections.Counter(flat_colours)
        sorted_colors = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)

        top_colors = [rgb for rgb, _count in sorted_colors[: self.TOP_N_COLORS]]
        ObserverBus.post(TrendUpdateEvent(top_colors, _dt.datetime.utcnow()))

    # --------------------------------------------------------------------- #
    # Exposed diagnostic helpers
    # --------------------------------------------------------------------- #
    @property
    def current_metrics(self) -> MappingProxyType:
        """
        Returns a read-only snapshot of current palette usage frequencies.

        Mostly intended for diagnostics / debug screens.
        """
        flat_colours = [rgb for _ts, pal in self._metrics for rgb in pal]
        counts = collections.Counter(flat_colours)
        return MappingProxyType(dict(counts))


# =============================================================================
# Repository Abstraction
# =============================================================================


class PrismCardRepository:
    """
    Abstract repository for reading PrismCards from local persistence or cloud.

    Sub-classes must be provided by platform-specific code.
    """

    async def fetch_since(self, since: _dt.datetime) -> Iterable[PrismCard]:
        raise NotImplementedError

    async def save(self, card: PrismCard) -> None:  # pragma: no cover
        raise NotImplementedError


# =============================================================================
# Convenience utility
# =============================================================================


@lru_cache
def format_rgb(rgb: RGB) -> str:
    """Converts an RGB tuple into a CSS-style hex string."""
    return "#{:02X}{:02X}{:02X}".format(*rgb)


# =============================================================================
# When run directly (debug)
# =============================================================================

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    class _InMemRepo(PrismCardRepository):
        """Toy in-memory repository for manual testing."""

        def __init__(self, cards: List[PrismCard]):
            self._cards = cards

        async def fetch_since(self, since: _dt.datetime) -> Iterable[PrismCard]:
            return [c for c in self._cards if c.created_at >= since]

    async def _demo() -> None:
        # Generate fake cards (no image I/O to keep demo simple)
        now = _dt.datetime.utcnow()
        sample_cards = [
            PrismCard(f"id_{i}", Path("fake/path.jpg"), now - _dt.timedelta(hours=i))
            for i in range(10)
        ]
        repo = _InMemRepo(sample_cards)
        service = PaletteTrendService(repo)

        async def listener(event: TrendUpdateEvent) -> None:
            print(
                "Top colours:",
                [format_rgb(rgb) for rgb in event.top_colors],
                "@",
                event.timestamp.isoformat(),
            )

        ObserverBus.subscribe(listener)
        await service.warm_start()

    asyncio.run(_demo())
```