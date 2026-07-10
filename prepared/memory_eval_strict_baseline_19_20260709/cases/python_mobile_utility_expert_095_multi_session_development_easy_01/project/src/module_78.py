```python
"""
src/module_78.py

Palette Trend Analytics module for PrismPocket.

This module listens to PrismCard mutations streamed on the global
Observer bus, aggregates palette–usage metrics in a lightweight
SQLite cache, and exposes synchronous/async helpers that allow
other layers (view-models, cloud sync jobs, etc.) to query the
current “trending palettes” report.

Patterns applied
----------------
- Repository Pattern  : PaletteMetricRepository persists metrics.
- Observer Pattern    : Listens to PrismCard events on EventBus.
- Singleton           : PaletteTrendAnalyzer is process-wide.
- Factory             : PaletteAnalyzerFactory builds analyzers.

The code plays nicely with Clean Architecture: entities stay pure,
infrastructure sits at the outer ring, and nothing in this file
talks to UIKit/Jetpack or any other presentation detail.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import threading
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# If the hosting application does not configure logging, attach a fallback.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(name)s [%(levelname)s]: %(message)s")
    )
    logger.addHandler(_handler)


# --------------------------------------------------------------------------- #
# Domain stubs (import from real package if available)
# --------------------------------------------------------------------------- #

try:
    # Real entities live in the domain layer.
    from prism_pocket.domain.entities import PrismCard, Palette
    from prism_pocket.infrastructure.event_bus import EventBus, GlobalEventBus
except ImportError:  # pragma: no cover – fallback for isolated execution
    logger.debug("Falling back to local stubs for PrismPocket imports.")

    @dataclass(frozen=True)
    class Palette:  # Minimal stub for color palettes
        colors: Tuple[str, ...]  # tuple of hex colours, e.g. ('#FF0099', ...)

    @dataclass(frozen=True)
    class PrismCard:  # Minimal stub for PrismCard events
        card_id: str
        palette: Palette
        created_at: datetime

    class EventBus:  # Very small observer bus implementation
        def __init__(self) -> None:
            self._subscribers: List = []

        def subscribe(self, fn) -> None:
            self._subscribers.append(fn)
            logger.debug("Subscriber %s registered on fallback EventBus.", fn)

        def unsubscribe(self, fn) -> None:
            self._subscribers.remove(fn)
            logger.debug("Subscriber %s removed from fallback EventBus.", fn)

        def publish(self, event_type: str, payload) -> None:
            for fn in list(self._subscribers):
                try:
                    fn(event_type, payload)
                except Exception as exc:  # pragma: no cover
                    logger.exception("Error in subscriber %s: %s", fn, exc)

    # Global singleton instance for fallback mode
    GlobalEventBus = EventBus()


# --------------------------------------------------------------------------- #
# Configuration helpers
# --------------------------------------------------------------------------- #

DEFAULT_DB_NAME = "palette_metrics.sqlite"
DEFAULT_TOP_N: int = 5
RECENT_WINDOW_MINS = 60  # Time-window for “trending” definition


def _app_cache_dir() -> Path:
    """
    Resolve a writable cache directory. Respect the platform‐specific
    environment variables if set, otherwise fallback to ~/.cache.
    """
    base = os.getenv("PRISMPOCKET_CACHE_DIR")
    if base:
        return Path(base).expanduser().resolve()
    return Path.home().joinpath(".cache", "prism_pocket").resolve()


# --------------------------------------------------------------------------- #
# Data layer
# --------------------------------------------------------------------------- #

@dataclass(slots=True, frozen=True)
class PaletteMetric:
    """
    Aggregate metric describing how many times a palette was used
    and when it was last encountered.
    """
    palette_key: str         # Normalised key, e.g. '#FF00FF/#112233/#AA9900'
    usage_count: int
    last_seen_ts: float      # Unix timestamp


class PaletteMetricRepository:
    """
    SQLite-backed repository that stores PaletteMetric rows.

    Schema:
        CREATE TABLE IF NOT EXISTS palette_metric (
            palette_key TEXT PRIMARY KEY,
            usage_count INTEGER NOT NULL,
            last_seen_ts REAL NOT NULL
        );
    """

    _SCHEMA_SQL = """
    CREATE TABLE IF NOT EXISTS palette_metric (
        palette_key   TEXT PRIMARY KEY,
        usage_count   INTEGER NOT NULL,
        last_seen_ts  REAL NOT NULL
    );
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        logger.debug("PaletteMetricRepository using DB at %s", db_path)
        self._init_db()

    def _init_db(self) -> None:
        with self._conn_ctx() as conn:
            conn.executescript(self._SCHEMA_SQL)
            conn.commit()
        logger.debug("PaletteMetricRepository schema ensured.")

    @contextmanager
    def _conn_ctx(self):
        """
        Context manager that yields a sqlite3.Connection with
        the row_factory set to sqlite3.Row and WAL enabled.
        """
        conn = sqlite3.connect(
            str(self._db_path),
            timeout=5,
            isolation_level=None,  # autocommit
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        try:
            yield conn
        finally:
            conn.close()

    # --------------------------------------------------------------------- #
    # Public repository interface
    # --------------------------------------------------------------------- #

    def upsert_metric(self, palette_key: str) -> None:
        """
        Insert or update a palette metric, incrementing usage_count
        and adjusting last_seen_ts.
        """
        now = time.time()
        with self._lock, self._conn_ctx() as conn:
            cursor = conn.execute(
                """
                UPDATE palette_metric
                   SET usage_count = usage_count + 1,
                       last_seen_ts = ?
                 WHERE palette_key = ?
                """,
                (now, palette_key),
            )
            if cursor.rowcount == 0:
                conn.execute(
                    """
                    INSERT INTO palette_metric (palette_key, usage_count, last_seen_ts)
                    VALUES (?, 1, ?)
                    """,
                    (palette_key, now),
                )
            logger.debug("Upserted metric for palette_key=%s", palette_key)

    def top_palettes(
        self,
        limit: int = DEFAULT_TOP_N,
        recent_window_minutes: Optional[int] = None,
    ) -> List[PaletteMetric]:
        """
        Return top palettes ordered by usage_count DESC, filtered by
        optional `recent_window_minutes`.
        """
        params: Sequence = ()
        where_clause = ""
        if recent_window_minutes is not None:
            since = time.time() - (recent_window_minutes * 60)
            where_clause = "WHERE last_seen_ts >= ?"
            params = (since,)

        query = f"""
            SELECT palette_key, usage_count, last_seen_ts
              FROM palette_metric
              {where_clause}
          ORDER BY usage_count DESC, last_seen_ts DESC
             LIMIT ?
        """
        params = (*params, limit)

        with self._lock, self._conn_ctx() as conn:
            rows = conn.execute(query, params).fetchall()

        metrics = [
            PaletteMetric(
                palette_key=row["palette_key"],
                usage_count=row["usage_count"],
                last_seen_ts=row["last_seen_ts"],
            )
            for row in rows
        ]
        logger.debug("Retrieved %d top palettes", len(metrics))
        return metrics

    def purge_older_than(self, days: int) -> int:
        """
        Remove metrics that have not been seen in the given number of days.
        Returns how many rows were deleted.
        """
        threshold = time.time() - (days * 86400)
        with self._lock, self._conn_ctx() as conn:
            cursor = conn.execute(
                "DELETE FROM palette_metric WHERE last_seen_ts < ?", (threshold,)
            )
            logger.info("Purged %d old palette metrics.", cursor.rowcount)
            return cursor.rowcount


# --------------------------------------------------------------------------- #
# Singleton metaclass for the analyzer
# --------------------------------------------------------------------------- #

class _Singleton(type):
    _instances: dict = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
            return cls._instances[cls]


# --------------------------------------------------------------------------- #
# PaletteTrendAnalyzer
# --------------------------------------------------------------------------- #

class PaletteTrendAnalyzer(metaclass=_Singleton):
    """
    High-level facade that receives PrismCard events, feeds the repository,
    and provides synchronous/async methods to generate trend reports.
    """

    def __init__(self, event_bus: EventBus | None = None) -> None:
        self._event_bus = event_bus or GlobalEventBus
        self._repo = PaletteMetricRepository(_app_cache_dir() / DEFAULT_DB_NAME)
        self._loop = asyncio.get_event_loop()
        self._event_bus.subscribe(self._on_event)  # Reactive wiring
        logger.info("PaletteTrendAnalyzer initialised and subscribed to EventBus.")

    # --------------------------------------------------------------------- #
    # Event handling
    # --------------------------------------------------------------------- #

    def _on_event(self, event_type: str, payload) -> None:
        """
        Callback invoked by EventBus for every PrismCard event.

        Expected event_type examples:
            'prism_card/created'
            'prism_card/updated'
        """
        try:
            if not event_type.startswith("prism_card/"):
                return
            card: PrismCard = payload
            palette_key = self._normalise_palette(card.palette)
            self._repo.upsert_metric(palette_key)
            logger.debug(
                "PaletteTrendAnalyzer ingested card %s with palette_key=%s",
                getattr(card, "card_id", "unknown"),
                palette_key,
            )
        except Exception as exc:  # pragma: no cover
            logger.exception("Failed to process PrismCard event: %s", exc)

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def top_trending_palettes(
        self,
        limit: int = DEFAULT_TOP_N,
        within_minutes: int = RECENT_WINDOW_MINS,
    ) -> List[PaletteMetric]:
        """
        Blocking call: returns top palettes in the given time window.
        """
        return self._repo.top_palettes(limit=limit, recent_window_minutes=within_minutes)

    async def top_trending_palettes_async(
        self,
        limit: int = DEFAULT_TOP_N,
        within_minutes: int = RECENT_WINDOW_MINS,
    ) -> List[PaletteMetric]:
        """
        Async wrapper for top_trending_palettes allowing UI coroutines
        to await without thread blocking.
        """
        loop = self._loop or asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self.top_trending_palettes, limit, within_minutes
        )

    def generate_report_text(self) -> str:
        """
        Produce a human-readable textual report of current trends.
        """
        metrics = self.top_trending_palettes()
        if not metrics:
            return "No palette usage data yet."

        lines = ["🎨 PrismPocket Palette Trends (last hour)", "-" * 40]
        for idx, metric in enumerate(metrics, 1):
            palette_str = metric.palette_key.replace("/", "  ")
            lines.append(
                f"{idx:>2}. used {metric.usage_count:>4}×  ::  {palette_str}"
            )
        return "\n".join(lines)

    # --------------------------------------------------------------------- #
    # Helper utilities
    # --------------------------------------------------------------------- #

    @staticmethod
    def _normalise_palette(palette: Palette) -> str:
        """
        Convert a Palette instance into a deduplicated, order-consistent key
        that can be used as primary key in the repository.
        """
        # Remove duplicates, preserve frequency, but sort for determinism.
        deduped = list(dict.fromkeys(palette.colors))
        sorted_hex = sorted(deduped, key=str.lower)
        palette_key = "/".join(sorted_hex)
        logger.debug("Normalised palette %s -> %s", palette.colors, palette_key)
        return palette_key


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #

class PaletteAnalyzerFactory:
    """
    Factory class that returns a PaletteTrendAnalyzer. If a custom EventBus
    is provided, a new analyzer bound to that bus is created; otherwise the
    process-wide singleton instance is returned.
    """

    @staticmethod
    def get(event_bus: EventBus | None = None) -> PaletteTrendAnalyzer:
        if event_bus is None:
            return PaletteTrendAnalyzer()  # singleton instance
        # If a different bus is provided we create a dedicated instance
        # that listens only to that specific bus.
        class _DedicatedAnalyzer(PaletteTrendAnalyzer):
            pass

        # Bypass singleton to allow multiple instances bound to custom buses.
        analyzer = object.__new__(_DedicatedAnalyzer)
        _DedicatedAnalyzer.__init__(analyzer, event_bus=event_bus)
        return analyzer


# --------------------------------------------------------------------------- #
# Convenience CLI for debugging
# --------------------------------------------------------------------------- #

def _demo() -> None:  # pragma: no cover
    """
    Quick demo executed when running this file directly.
    Generates fake PrismCard events, waits a bit, then prints a report.
    """
    logger.setLevel(logging.DEBUG)
    event_bus = GlobalEventBus
    analyzer = PaletteTrendAnalyzer()

    # Generate fake data
    palettes = [
        ("#FF0000", "#00FF00", "#0000FF"),
        ("#00FF00", "#0000FF", "#FF0000"),
        ("#F0F0F0", "#0F0F0F"),
        ("#FF0000", "#00FF00", "#0000FF"),
    ]

    for idx, colors in enumerate(palettes, 1):
        card = PrismCard(
            card_id=f"card_{idx}",
            palette=Palette(colors=colors),
            created_at=datetime.utcnow(),
        )
        event_bus.publish("prism_card/created", card)

    # Let async tasks flush
    time.sleep(0.2)

    print(analyzer.generate_report_text())


if __name__ == "__main__":  # pragma: no cover
    _demo()
```