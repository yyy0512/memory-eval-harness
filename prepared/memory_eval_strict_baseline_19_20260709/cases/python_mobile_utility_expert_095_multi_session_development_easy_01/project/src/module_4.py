```python
"""
src/module_4.py
PrismPocket – Palette & Trend Analytics Engine

This module contains the production-grade implementation for PrismPocket’s
real-time color-trend analytics.  It listens to the global Observer/Event bus
for PrismCard mutations, extracts palette information, computes lightweight
mood scores, updates in-memory aggregates, and periodically persists the
results to a local SQLite store so they can be surfaced in the UI layer or
synced to the cloud workspace.

Architecture patterns applied
-----------------------------
1. Singleton           – Ensures exactly one EventBus and one TrendTracker.
2. Observer            – EventBus allows observers to subscribe/unsubscribe.
3. Factory             – AnalyzerFactory instantiates concrete analyzers.
4. Repository          – TrendRepository isolates persistence concerns.

The code purposefully avoids heavyweight external dependencies.  When Pillow
is available it is used for palette extraction; otherwise we gracefully
degrade with a fallback stub so the rest of the app can continue to function.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import json
import logging
import os
import sqlite3
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, DefaultDict, Dict, List, MutableMapping, Optional, Tuple

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover
    Image = None  # Pillow is optional; analytics degrade gracefully.


LOG = logging.getLogger(__name__)
LOG.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Domain placeholders (import from real domain package when available)        #
# --------------------------------------------------------------------------- #
try:
    # The real project should export these from `prism_core.domain`. We fall
    # back to a lightweight stub for standalone execution & unit-testing.
    from prism_core.domain.prism_card import PrismCard  # type: ignore
except Exception:  # pragma: no cover

    @dataclass(slots=True)
    class PrismCard:  # pylint: disable=too-few-public-methods
        """Minimal stub for PrismCard used by the analytics subsystem."""
        card_id: str
        # List of HEX strings representing the card’s palette, e.g. ["#ff00ff"]
        palette: List[str] = field(default_factory=list)
        # Client apps may supply the raw image path; used only when Pillow is
        # installed – otherwise ignored.
        image_path: Optional[Path] | None = None


# --------------------------------------------------------------------------- #
# Analytics model                                                             #
# --------------------------------------------------------------------------- #
@dataclass(slots=True, frozen=True)
class PaletteMetric:
    """Represents a single color-palette occurrence captured from a PrismCard."""
    card_id: str
    timestamp: _dt.datetime
    dominant_colors: Tuple[str, ...]  # Sorted HEX codes
    mood_score: float  # 0 ⇒ calm, 1 ⇒ vibrant


class AnalyticsError(RuntimeError):
    """Domain-level exception for analytics-specific failures."""


# --------------------------------------------------------------------------- #
# Observer / Event Bus (Singleton)                                            #
# --------------------------------------------------------------------------- #
class _Singleton(type):
    """Metaclass enforcing the Singleton pattern."""

    _instances: Dict[type, "EventBus"] = {}

    def __call__(cls, *args, **kwargs):  # noqa: D401
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)  # type: ignore
        return cls._instances[cls]


class EventBus(metaclass=_Singleton):
    """
    Thread-safe, minimalistic event bus.
    Observers register callbacks keyed by an arbitrary event_type string.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._observers: DefaultDict[str, List[Callable[[object], None]]] = (
            DefaultDict(list)
        )

    # --------------------------- Public API -------------------------------- #
    def register(self, event_type: str, callback: Callable[[object], None]) -> None:
        """Attach callback to an event type."""
        with self._lock:
            self._observers[event_type].append(callback)
            LOG.debug("Observer registered for %s: %s", event_type, callback)

    def unregister(self, event_type: str, callback: Callable[[object], None]) -> None:
        """Detach callback from event type (if previously registered)."""
        with self._lock:
            try:
                self._observers[event_type].remove(callback)
                LOG.debug("Observer unregistered for %s: %s", event_type, callback)
            except ValueError:
                LOG.warning("Attempted to unregister unknown callback %s", callback)

    def emit(self, event_type: str, payload: object) -> None:
        """Publish an event to all observers subscribed to event_type."""
        with self._lock:
            observers_snapshot = list(self._observers[event_type])

        for callback in observers_snapshot:
            try:
                callback(payload)
            except Exception as exc:  # pragma: no cover
                LOG.exception("Error in observer callback %s: %s", callback, exc)


# --------------------------------------------------------------------------- #
# Color utilities                                                             #
# --------------------------------------------------------------------------- #
class _ColorUtils:
    """Utility helpers for palette and mood computing."""

    @staticmethod
    def _hexify(rgb: Tuple[int, int, int]) -> str:
        return "#{:02x}{:02x}{:02x}".format(*rgb)

    @classmethod
    def extract_dominant_colors(
        cls, image_path: Path | None, fallback_palette: List[str], max_colors: int = 5
    ) -> Tuple[str, ...]:
        """
        Compute dominant colors using Pillow's getcolors/k-means fallback.

        If Pillow or the image is unavailable, rely on the card’s supplied
        palette. Returns a tuple sorted alphabetically to guarantee deterministic
        hashing/ordering.
        """
        if Image is None or image_path is None or not image_path.exists():
            if not fallback_palette:
                raise AnalyticsError("No palette data available for card.")
            sorted_hex = sorted({c.lower() for c in fallback_palette})[:max_colors]
            return tuple(sorted_hex)

        try:
            with Image.open(image_path) as img:
                img = img.convert("RGB")
                # Resize down so `.getcolors()` does not explode on very big images.
                img.thumbnail((128, 128))
                colors = img.getcolors(128 * 128) or []
                # Sort by frequency descending
                colors.sort(key=lambda x: x[0], reverse=True)
                top = [cls._hexify(rgb) for _, rgb in colors[:max_colors]]
                return tuple(sorted({c.lower() for c in top}))
        except Exception as exc as exc:  # type: ignore[misc]  # pragma: no cover
            LOG.warning("Failed to extract colors via Pillow: %s", exc)
            sorted_hex = sorted({c.lower() for c in fallback_palette})[:max_colors]
            return tuple(sorted_hex)

    @staticmethod
    def compute_mood_score(hex_colors: Tuple[str, ...]) -> float:
        """
        Heuristic ‘mood’ score based on luma.
        Returns a float in [0, 1], where:
        0   : very dark / muted
        1   : very bright / vibrant
        """
        def _luma(hex_code: str) -> float:
            rgb = tuple(int(hex_code[i : i + 2], 16) for i in (1, 3, 5))
            # Rec. 709 luma formula
            return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255.0

        lumas = [_luma(h) for h in hex_colors]
        mood = sum(lumas) / len(lumas) if lumas else 0.0
        return min(max(mood, 0.0), 1.0)


# --------------------------------------------------------------------------- #
# Trend Repository (SQLite)                                                   #
# --------------------------------------------------------------------------- #
class TrendRepository:
    """
    SQLite-backed repository managing palette metrics.

    It is intentionally lightweight; the cloud sync layer takes care of pushing
    data upstream.  The file is created under the user’s cache directory.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS palette_metrics(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        colors TEXT NOT NULL,
        mood REAL NOT NULL
    );
    """

    def __init__(self, db_path: Path | None = None) -> None:
        self._db_path = (
            db_path
            or Path(os.getenv("PRISM_CACHE_DIR", Path.home() / ".prism_cache"))
            / "palette_metrics.db"
        )
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_db()

    # --------------------------------------------------------------------- #
    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(self._SCHEMA)
            conn.commit()

    @contextlib.contextmanager
    def _get_conn(self) -> sqlite3.Connection:  # noqa: D401
        """Context manager returning a SQLite connection with row factory."""
        with self._lock:
            conn = sqlite3.connect(
                str(self._db_path), check_same_thread=False, timeout=10
            )
            conn.row_factory = sqlite3.Row
            try:
                yield conn
            finally:
                conn.close()

    # --------------------------------------------------------------------- #
    def persist_metric(self, metric: PaletteMetric) -> None:
        """Insert a single PaletteMetric row."""
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO palette_metrics(card_id, ts, colors, mood)
                VALUES(?, ?, ?, ?)
                """,
                (
                    metric.card_id,
                    int(metric.timestamp.timestamp()),
                    json.dumps(metric.dominant_colors),
                    metric.mood_score,
                ),
            )
            conn.commit()
            LOG.debug("PaletteMetric persisted for card %s", metric.card_id)

    # --------------------------------------------------------------------- #
    def top_colors(self, limit: int = 5) -> List[Tuple[str, int]]:
        """Return the most frequent colors across all stored metrics."""
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                SELECT colors FROM palette_metrics
                """
            )
            counter: Counter[str] = Counter()
            for row in cursor.fetchall():
                colors: List[str] = json.loads(row["colors"])
                counter.update(colors)

        return counter.most_common(limit)


# --------------------------------------------------------------------------- #
# Analyzers                                                                   #
# --------------------------------------------------------------------------- #
class PaletteTrendAnalyzer:
    """
    Observes prism_card_saved events and computes palette-level aggregates.
    """

    EVENT_TYPE = "prism_card_saved"

    def __init__(
        self,
        repository: TrendRepository,
        flush_interval: float = 60.0,  # seconds
    ) -> None:
        self._repo = repository
        self._counter: Counter[str] = Counter()
        self._flush_interval = flush_interval
        self._lock = threading.RLock()
        self._last_flush = time.monotonic()

        EventBus().register(self.EVENT_TYPE, self._on_card_saved)

    # --------------------------------------------------------------------- #
    def _on_card_saved(self, card: PrismCard) -> None:
        """Callback invoked by EventBus upon a new PrismCard being saved."""
        try:
            colors = _ColorUtils.extract_dominant_colors(
                card.image_path, card.palette
            )
            mood = _ColorUtils.compute_mood_score(colors)
            metric = PaletteMetric(
                card_id=card.card_id,
                timestamp=_dt.datetime.utcnow(),
                dominant_colors=colors,
                mood_score=mood,
            )
            self._update_counters(metric)
            self._maybe_flush(metric)
        except AnalyticsError:
            LOG.warning("Failed to compute palette for card %s", card.card_id)

    def _update_counters(self, metric: PaletteMetric) -> None:
        with self._lock:
            self._counter.update(metric.dominant_colors)

    # --------------------------------------------------------------------- #
    def _maybe_flush(self, metric: PaletteMetric) -> None:
        now = time.monotonic()
        if now - self._last_flush >= self._flush_interval:
            threading.Thread(
                target=self._flush, args=(metric,), daemon=True
            ).start()
            self._last_flush = now

    def _flush(self, metric: PaletteMetric) -> None:
        """Persist metric + counter snapshot asynchronously."""
        try:
            self._repo.persist_metric(metric)
        except Exception:  # pragma: no cover
            LOG.exception("Failed to persist PaletteMetric")
            return

        # For demonstration we also persist aggregated top colors to disk so
        # the UI can show “Top N Colors” without heavy SQL.
        snapshot_path = self._repo._db_path.parent / "top_colors.json"  # noqa: SLF001
        with snapshot_path.open("w", encoding="utf-8") as fh:
            json.dump(self.top_colors(), fh, indent=2)
        LOG.debug("Flushed analytics snapshot to %s", snapshot_path)

    # --------------------------------------------------------------------- #
    def top_colors(self, limit: int = 5) -> List[Tuple[str, int]]:
        with self._lock:
            return self._counter.most_common(limit)


# --------------------------------------------------------------------------- #
# Factory                                                                     #
# --------------------------------------------------------------------------- #
class AnalyzerFactory(metaclass=_Singleton):
    """
    Provides analyzers.  New metric types can be registered without touching
    client code.
    """

    def __init__(self) -> None:
        self._cache: MutableMapping[str, object] = {}
        self._repo = TrendRepository()

    # --------------------------------------------------------------------- #
    def get_palette_analyzer(self) -> PaletteTrendAnalyzer:
        """Get (or create) the Singleton PaletteTrendAnalyzer instance."""
        if "palette" not in self._cache:
            self._cache["palette"] = PaletteTrendAnalyzer(repository=self._repo)
        return self._cache["palette"]  # type: ignore[return-value]


# --------------------------------------------------------------------------- #
# Public API for module importers                                             #
# --------------------------------------------------------------------------- #
def init_analytics_subsystem() -> None:
    """
    Initializes analytics subsystem. Should be called early in application
    bootstrap – typically inside AppDelegate (iOS) / Application (Android).
    """
    AnalyzerFactory().get_palette_analyzer()
    LOG.info("Analytics subsystem initialized.")


# --------------------------------------------------------------------------- #
# When executed directly – run a tiny smoke test                              #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)
    init_analytics_subsystem()

    # Emit fake events for demo.
    bus = EventBus()
    for idx in range(10):
        fake_card = PrismCard(
            card_id=f"demo-{idx}",
            palette=["#ff0000", "#00ff00", "#0000ff"],
        )
        bus.emit("prism_card_saved", fake_card)

    # Allow background flush threads to finish.
    time.sleep(2)
    repo = TrendRepository()
    print("Top colors:", repo.top_colors())
```