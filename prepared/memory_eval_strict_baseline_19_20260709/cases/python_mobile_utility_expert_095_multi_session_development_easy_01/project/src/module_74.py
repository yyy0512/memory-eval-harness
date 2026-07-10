```python
"""
PrismPocket – Color Trend Analyzer
----------------------------------

This module provides a production-ready analytics component that tracks color
usage across all `PrismCard` instances in near-real-time, exposing insights that
power features like:

    • Trending-palette carousels
    • Mood-score calculations
    • Adaptive artistic prompts

The analyzer is implemented as a thread-safe Singleton, subscribes to the
application-wide Observer bus, and persists its rolling window to disk so that
analytics survive application restarts and offline stretches.

Throughout the file we embrace Clean Architecture principles:

    * Domain-oriented DTOs are kept pure
    * The Analyzer resides in the “domain service” ring
    * External resources (disk, event bus) are injected via adapters/factories
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter, deque
from pathlib import Path
from typing import (
    Deque,
    Dict,
    Iterable,
    List,
    Optional,
    Tuple,
    Type,
    TypeVar,
)

# --------------------------------------------------------------------------- #
# Optional imports that exist elsewhere in the codebase.
# We use `typing.TYPE_CHECKING` to avoid hard runtime dependencies and
# to help static type checkers like mypy across the monorepo.
# --------------------------------------------------------------------------- #
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover – only for type checking
    from bus.observer import ObserverBus  # App-wide event stream
    from entities.prism_card import PrismCard  # Domain entity


# --------------------------------------------------------------------------- #
# Logging configuration (override in root package if needed)
# --------------------------------------------------------------------------- #
logger = logging.getLogger(__name__)
if not logger.handlers:  # Prevent duplicate handlers during hot-reload
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(levelname)1.1s %(asctime)s] %(name)s: %(message)s")
    )
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Type helpers
# --------------------------------------------------------------------------- #
Color = str  # We treat colors as hex strings – e.g. "#FFEEAA"
Palette = Tuple[Color, ...]
T = TypeVar("T")


# --------------------------------------------------------------------------- #
# Singleton MetaClass
# --------------------------------------------------------------------------- #
class _SingletonMeta(type):
    """
    A thread-safe implementation of the classic Singleton pattern using a
    metaclass. Every subclass of `_SingletonMeta` becomes a Singleton.
    """

    _instances: Dict[Type, object] = {}
    _lock: threading.Lock = threading.Lock()  # Class-level lock

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        if cls not in cls._instances:
            with cls._lock:  # double-checked locking
                if cls not in cls._instances:
                    logger.debug("Creating new singleton instance of %s", cls.__name__)
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# ColorTrendAnalyzer
# --------------------------------------------------------------------------- #
class ColorTrendAnalyzer(metaclass=_SingletonMeta):
    """
    Maintains an in-memory rolling window of recent color data points and
    exposes fast, query-centric APIs for retrieving color/palette trends.

    The window is persisted to local storage so that analytics survive process
    restarts and offline gaps. ONLY color metadata is stored – private user data
    never leaves the device in this component.
    """

    DEFAULT_WINDOW_SEC = 60 * 60 * 24  # 24 hours of data
    MAX_DATA_POINTS = 50_000  # Guardrail for memory usage
    PERSIST_FILE = Path.home() / ".prism_pocket" / "color_trends.json"

    # Events we care about on the Observer bus
    _BUS_TOPIC_CARD_SAVED = "card_saved"  # payload: PrismCard

    # --------------------------------------------------------------------- #
    # Construction
    # --------------------------------------------------------------------- #
    def __init__(
        self,
        window_seconds: int | None = None,
        *,
        persist_file: Path | None = None,
    ) -> None:
        self._window_seconds = int(window_seconds or self.DEFAULT_WINDOW_SEC)
        self._persist_file = persist_file or self.PERSIST_FILE

        # {timestamp: [color, color, ...]}
        self._data: Deque[Tuple[float, Palette]] = deque()
        self._color_counter: Counter[Color] = Counter()

        # Thread-safety across I/O + observer callbacks
        self._lock = threading.RLock()

        # On startup load persisted metrics
        try:
            self._load_from_disk()
        except Exception:  # Broad – we log & continue with fresh state
            logger.exception("Failed to load color trend cache – starting clean.")

        logger.debug(
            "Initialized ColorTrendAnalyzer with %s data points, window=%s sec",
            len(self._data),
            self._window_seconds,
        )

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def process_card(self, card: "PrismCard") -> None:
        """
        Pull palette information from `PrismCard`, update counters,
        and evict outdated data.
        """
        palette: Optional[Palette] = self._extract_palette(card)
        if not palette:
            logger.debug("Card %s yielded empty palette; skipping.", card)
            return

        timestamp = time.time()
        with self._lock:
            self._data.append((timestamp, palette))
            self._color_counter.update(palette)
            logger.debug("Added palette %s at %s", palette, timestamp)

            self._evict_stale_locked()
        # Persist asynchronously
        threading.Thread(
            target=self._flush_to_disk,
            name="ColorTrendPersistThread",
            daemon=True,
        ).start()

    def get_top_colors(self, k: int = 5) -> List[Tuple[Color, int]]:
        """
        Return the globally most frequent colors (hex strings) within the
        current window of data.
        """
        if k <= 0:
            raise ValueError("k must be positive")
        with self._lock:
            return self._color_counter.most_common(k)

    def get_trending_palettes(self, k: int = 3) -> List[Tuple[Palette, int]]:
        """
        Identify the most frequent palettes (as distinct tuples of colors) by
        collapsing the data stream down to palette occurrences.

        This is an O(N) operation over the window, invoked sparingly.
        """
        if k <= 0:
            raise ValueError("k must be positive")

        with self._lock:
            palette_counter: Counter[Palette] = Counter(
                palette for _, palette in self._data
            )
            top_palettes = palette_counter.most_common(k)
            logger.debug("Computed top palettes: %s", top_palettes)
            return top_palettes

    # --------------------------------------------------------------------- #
    # Observer integration
    # --------------------------------------------------------------------- #
    def register_to_bus(self, bus: "ObserverBus") -> None:
        """
        Bind the analyzer to the shared Observer bus so that every new or
        modified PrismCard automatically updates the analytics.
        """

        def _on_card_saved(card: "PrismCard") -> None:
            try:
                self.process_card(card)
            except Exception:
                logger.exception("Failed to process PrismCard in event callback")

        bus.subscribe(self._BUS_TOPIC_CARD_SAVED, _on_card_saved)
        logger.info("ColorTrendAnalyzer subscribed to topic '%s'.", self._BUS_TOPIC_CARD_SAVED)

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #
    def _extract_palette(self, card: "PrismCard") -> Optional[Palette]:
        """
        Robustly pull a palette from `PrismCard`. Falls back through multiple
        strategies because entities may evolve over time.
        """
        palette: Optional[Iterable[str]] = None

        # Preferred: explicit palette attribute
        if hasattr(card, "palette"):
            palette = getattr(card, "palette")

        # Fallback: deferred extraction method
        if not palette and hasattr(card, "extract_palette"):
            palette = card.extract_palette()

        if not palette:
            return None

        # Normalise to tuple + uppercase hex strings
        try:
            normalised: Palette = tuple(c.upper() for c in palette if isinstance(c, str))
        except Exception:
            logger.warning("Palette normalisation failed for card %s: %s", card, palette)
            return None

        # Empty after filtering non-strings
        return normalised or None

    def _evict_stale_locked(self) -> None:
        """
        Remove data points outside the rolling window whilst holding
        the re-entrant instance lock.
        """
        expire_before = time.time() - self._window_seconds
        evicted = 0

        while self._data and self._data[0][0] < expire_before:
            old_ts, old_palette = self._data.popleft()
            self._color_counter.subtract(old_palette)
            evicted += 1

        if evicted:
            logger.debug("Evicted %s stale palette records.", evicted)

        # Safety valve in case of parameter mis-configuration
        if len(self._data) > self.MAX_DATA_POINTS:
            overflow = len(self._data) - self.MAX_DATA_POINTS
            logger.warning("Trend window overflow (%s). Trimming oldest %s events.", len(self._data), overflow)
            for _ in range(overflow):
                _ts, _pal = self._data.popleft()
                self._color_counter.subtract(_pal)

    # --------------------------------------------------------------------- #
    # Persistence
    # --------------------------------------------------------------------- #
    def _flush_to_disk(self) -> None:
        """
        Serialize the rolling window to JSON. Best-effort; failures are logged
        but otherwise ignored to keep user experience unaffected.
        """
        with self._lock:
            payload = [
                (ts, list(palette)) for ts, palette in self._data
            ]  # Convert tuples -> list for JSON

        try:
            self._persist_file.parent.mkdir(parents=True, exist_ok=True)
            with self._persist_file.open("w", encoding="utf-8") as fp:
                json.dump(payload, fp)
            logger.debug("Color trend cache persisted with %s records.", len(payload))
        except Exception:
            logger.exception("Failed to persist color trend cache.")

    def _load_from_disk(self) -> None:
        """
        Load the rolling window from the persisted JSON file, if present. Caller
        must handle exceptions.
        """
        if not self._persist_file.exists():
            logger.info("No existing color trend cache found at %s", self._persist_file)
            return

        with self._persist_file.open("r", encoding="utf-8") as fp:
            raw: List[Tuple[float, List[str]]] = json.load(fp)

        now = time.time()
        loaded = 0
        for ts, pal_list in raw:
            # Discard anything older than the window or malformed
            if not isinstance(ts, (float, int)) or (now - ts > self._window_seconds):
                continue
            palette = tuple(str(c).upper() for c in pal_list)
            self._data.append((float(ts), palette))
            self._color_counter.update(palette)
            loaded += 1

        logger.info("Loaded %s palette records from cache.", loaded)

    # --------------------------------------------------------------------- #
    # Debug / maintenance
    # --------------------------------------------------------------------- #
    def clear_cache(self) -> None:
        """
        Wipe in-memory and on-disk analytics. Intended for unit tests or
        privacy-centric user flows.
        """
        with self._lock:
            self._data.clear()
            self._color_counter.clear()

        try:
            if self._persist_file.exists():
                self._persist_file.unlink()
            logger.info("Color trend cache cleared.")
        except Exception:
            logger.exception("Failed to delete persisted color trend cache.")


# --------------------------------------------------------------------------- #
# Factory / convenience accessor
# --------------------------------------------------------------------------- #
_analyzer_instance: Optional[ColorTrendAnalyzer] = None
_factory_lock = threading.Lock()


def get_color_trend_analyzer() -> ColorTrendAnalyzer:
    """
    Obtain the shared `ColorTrendAnalyzer` instance. Wrapped in a tiny factory
    to decouple import sites from the class implementation (promotes DI).
    """
    global _analyzer_instance
    if _analyzer_instance is None:
        with _factory_lock:
            if _analyzer_instance is None:
                _analyzer_instance = ColorTrendAnalyzer()
    return _analyzer_instance
```