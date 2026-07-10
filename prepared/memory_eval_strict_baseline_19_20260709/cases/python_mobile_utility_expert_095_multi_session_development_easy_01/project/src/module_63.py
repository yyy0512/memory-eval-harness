```python
"""
src/module_63.py

Palette analytics and trend–detection utilities for the PrismPocket mobile
application.

This module subscribes to PrismCard save events, extracts the dominant
palette for each card, updates a local metric store, and periodically
calculates trending colours / moods that can be surfaced in the UI layer.

Patterns showcased:
    • Observer            – simple in-process event bus
    • Repository          – PaletteMetricRepository
    • Singleton           – enforced on PaletteMetricRepository
    • Factory             – PaletteAnalyzerFactory for configurable analyzers

The code purposefully avoids referencing platform-specific APIs so that it
can execute unchanged in unit-test environments or headless cloud workers.
"""
from __future__ import annotations

import colorsys
import logging
import math
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from statistics import mean
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# Ensures duplicate handlers are not added during hot-reloads in e.g. pytest
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(_handler)


# --------------------------------------------------------------------------- #
# Domain Models
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PrismCard:
    """Lightweight value object representing a captured card."""
    id: str
    media_uri: str
    palette: Sequence[str]  # hex colours like ["#AABBCC", ...]
    created_at: datetime
    mood_score: float  # −1.0 … 1.0 derived elsewhere


@dataclass(frozen=True)
class PaletteMetric:
    """Aggregated analytics derived from many PrismCards."""
    colour: str  # canonical uppercase hex e.g. "#AABBCC"
    count: int
    last_seen: datetime
    score: float  # computed impact / trend value


# --------------------------------------------------------------------------- #
# Util helpers
# --------------------------------------------------------------------------- #
def _hex_to_rgb(hex_colour: str) -> Tuple[int, int, int]:
    """Converts hex colour (#RRGGBB) to an RGB tuple."""
    hex_colour = hex_colour.lstrip("#")
    if len(hex_colour) != 6:
        raise ValueError(f"Invalid hex colour: {hex_colour}")
    r, g, b = (
        int(hex_colour[0:2], 16),
        int(hex_colour[2:4], 16),
        int(hex_colour[4:6], 16),
    )
    return r, g, b


def perceptual_distance(c1: str, c2: str) -> float:
    """
    Computes a perceptual colour distance in LAB space.  For performance
    reasons this approximates LAB by converting to HSV and Euclidean distance.
    """
    r1, g1, b1 = _hex_to_rgb(c1)
    r2, g2, b2 = _hex_to_rgb(c2)

    h1, s1, v1 = colorsys.rgb_to_hsv(r1 / 255, g1 / 255, b1 / 255)
    h2, s2, v2 = colorsys.rgb_to_hsv(r2 / 255, g2 / 255, b2 / 255)

    # Weight hue more heavily than saturation/value.
    dh = min(abs(h1 - h2), 1 - abs(h1 - h2)) * 2  # hue is circular
    ds = abs(s1 - s2)
    dv = abs(v1 - v2)

    distance = math.sqrt((2 * dh) ** 2 + ds ** 2 + dv ** 2)
    return distance


# --------------------------------------------------------------------------- #
# Observer Bus – in-process
# --------------------------------------------------------------------------- #
class _EventBus:
    """Very small observer/event bus for in-process pub/sub."""

    def __init__(self) -> None:
        self._listeners: Dict[str, List] = defaultdict(list)
        self._lock = threading.RLock()

    def subscribe(self, event_key: str, callback) -> None:
        with self._lock:
            self._listeners[event_key].append(callback)
            logger.debug("Listener added for event '%s'", event_key)

    def publish(self, event_key: str, payload=None) -> None:
        with self._lock:
            listeners = list(self._listeners.get(event_key, ()))
        for cb in listeners:
            try:
                cb(payload)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Listener raised on event '%s': %s", event_key, exc)


# global singleton bus – accessible app-wide
event_bus = _EventBus()

CARD_SAVED_EVENT = "CARD_SAVED_EVENT"


# --------------------------------------------------------------------------- #
# Repository
# --------------------------------------------------------------------------- #
class SingletonMeta(type):
    """Metaclass enforcing a single instance even across subclassing."""

    _instances: Dict[type, "SingletonMeta"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)
                cls._instances[cls] = instance
            return cls._instances[cls]


class PaletteMetricRepository(metaclass=SingletonMeta):
    """
    Thread-safe repository for palette metrics.

    Realistically this would live in its own module and leverage the full DAO
    layer with migrations.  For brevity a single sqlite file is used here.
    """

    _DB_FILENAME = Path.home() / ".prismpocket_palette_metrics.db"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            self._DB_FILENAME, check_same_thread=False, isolation_level=None
        )
        self._setup_schema()

    # ----------------------- Private helpers ----------------------- #
    def _setup_schema(self) -> None:
        with self._conn as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS palette_metrics (
                    colour TEXT PRIMARY KEY,
                    count INTEGER NOT NULL,
                    last_seen TEXT NOT NULL,
                    score REAL NOT NULL
                );
                """
            )

    # ----------------------- Public API ---------------------------- #
    def upsert_metric(self, colour: str, inc: int = 1) -> None:
        """
        Inserts or updates a metric row by incrementing its count and updating
        last_seen.  A naive scoring algorithm is applied inline.
        """
        colour = colour.upper()
        now_ts = datetime.utcnow().isoformat()

        with self._conn as conn:
            # Query existing
            row = conn.execute(
                "SELECT count, last_seen FROM palette_metrics WHERE colour = ?",
                (colour,),
            ).fetchone()

            if row:
                prev_count, prev_last_seen = row  # noqa: N806
                new_count = prev_count + inc
                days_since_last = max(
                    (datetime.utcnow() - datetime.fromisoformat(prev_last_seen)).days, 1
                )
                score = new_count / days_since_last
                conn.execute(
                    """
                    UPDATE palette_metrics
                    SET count = ?, last_seen = ?, score = ?
                    WHERE colour = ?;
                    """,
                    (new_count, now_ts, score, colour),
                )
            else:
                score = inc
                conn.execute(
                    """
                    INSERT INTO palette_metrics (colour, count, last_seen, score)
                    VALUES (?, ?, ?, ?);
                    """,
                    (colour, inc, now_ts, score),
                )
        logger.debug("Metric upserted: %s (+%s)", colour, inc)

    def top_trending(
        self,
        *,
        limit: int = 10,
        since: Optional[datetime] = None,
        min_count: int = 1,
    ) -> List[PaletteMetric]:
        """
        Returns top trending colours, optionally filtered to those seen since a
        given datetime.
        """
        query = (
            "SELECT colour, count, last_seen, score FROM palette_metrics "
            "WHERE count >= ? "
        )
        params: List = [min_count]

        if since:
            query += "AND last_seen >= ? "
            params.append(since.isoformat())

        query += "ORDER BY score DESC LIMIT ?"
        params.append(limit)

        with self._conn as conn:
            rows = conn.execute(query, params).fetchall()

        return [
            PaletteMetric(
                colour=row[0],
                count=row[1],
                last_seen=datetime.fromisoformat(row[2]),
                score=row[3],
            )
            for row in rows
        ]


# --------------------------------------------------------------------------- #
# Analytics Core
# --------------------------------------------------------------------------- #
class PaletteTrendAnalyzer:
    """
    Consumes PrismCard events, records colour usage, and runs periodic analyses
    to compute trending palettes & moods.

    Instantiate through PaletteAnalyzerFactory to ensure proper configuration.
    """

    def __init__(
        self,
        repo: PaletteMetricRepository,
        *,
        interval_sec: int = 300,
        palette_size: int = 5,
        max_age_days: int = 30,
    ) -> None:
        self._repo = repo
        self._interval = interval_sec
        self._palette_size = palette_size
        self._max_age_days = max_age_days

        self._stop_event = threading.Event()
        self._worker_thread: Optional[threading.Thread] = None

        event_bus.subscribe(CARD_SAVED_EVENT, self._on_card_saved)

    # ----------------------- Lifecycle ----------------------------- #
    def start(self) -> None:
        if self._worker_thread and self._worker_thread.is_alive():
            logger.debug("PaletteTrendAnalyzer already running.")
            return

        self._stop_event.clear()
        self._worker_thread = threading.Thread(
            target=self._worker_loop, name="PaletteTrendAnalyzer", daemon=True
        )
        self._worker_thread.start()
        logger.info("PaletteTrendAnalyzer started.")

    def stop(self, *, join: bool = False) -> None:
        self._stop_event.set()
        if join and self._worker_thread:
            self._worker_thread.join()

    # ----------------------- Event Handlers ------------------------ #
    def _on_card_saved(self, card: PrismCard) -> None:
        if not card or not card.palette:
            return

        for colour in card.palette[: self._palette_size]:
            try:
                self._repo.upsert_metric(colour)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed upserting metric for %s: %s", colour, exc)

    # ----------------------- Worker loop --------------------------- #
    def _worker_loop(self) -> None:
        logger.debug("Analyzer worker thread entered.")

        while not self._stop_event.wait(self._interval):
            try:
                self._purge_old_metrics()
            except Exception as exc:  # noqa: BLE001
                logger.exception("Periodic purge raised: %s", exc)

    # ----------------------- Maintenance --------------------------- #
    def _purge_old_metrics(self) -> None:
        """Removes metrics no longer relevant (older than max_age_days)."""
        threshold = datetime.utcnow() - timedelta(days=self._max_age_days)
        # We can't easily delete rows without last_seen < threshold in a generic
        # manner because sqlite datetime comparisons require consistent format.
        # We'll load and delete per-row to keep it simple for the example.
        old_metrics = self._repo.top_trending(
            limit=10_000, since=None, min_count=0
        )  # all rows

        to_delete = [m.colour for m in old_metrics if m.last_seen < threshold]
        if not to_delete:
            logger.debug("No old metrics to purge.")
            return

        with self._repo._conn as conn:  # pylint: disable=protected-access
            conn.executemany(
                "DELETE FROM palette_metrics WHERE colour = ?",
                [(c,) for c in to_delete],
            )
        logger.info("Purged %d old palette metrics.", len(to_delete))


# --------------------------------------------------------------------------- #
# Factory – allows different strategies / test injection
# --------------------------------------------------------------------------- #
class PaletteAnalyzerFactory:
    """Factory for building a PaletteTrendAnalyzer with sensible defaults."""

    @classmethod
    def create_default(cls) -> PaletteTrendAnalyzer:
        repo = PaletteMetricRepository()
        analyzer = PaletteTrendAnalyzer(repo)
        return analyzer


# --------------------------------------------------------------------------- #
# Diagnostic / Debug entrypoint
# --------------------------------------------------------------------------- #
def _demo() -> None:  # pragma: no cover
    """
    Quick-and-dirty demonstration that does NOT run in production builds.
    Run with:  python -m src.module_63
    """
    import random
    import uuid

    # Spin up analyzer
    analyzer = PaletteAnalyzerFactory.create_default()
    analyzer.start()

    # Emit fake card events
    colours = ["#FF5733", "#33FF57", "#3357FF", "#FFFF33", "#FF33FF"]

    for _ in range(100):
        card = PrismCard(
            id=str(uuid.uuid4()),
            media_uri="file:///tmp/mock.jpg",
            palette=random.sample(colours, k=3),
            created_at=datetime.utcnow(),
            mood_score=random.uniform(-1, 1),
        )
        event_bus.publish(CARD_SAVED_EVENT, card)
        time.sleep(0.01)

    # Allow background worker to run maintenance
    time.sleep(1)

    # Fetch and display trending
    repo = PaletteMetricRepository()
    trending = repo.top_trending(limit=5)
    for metric in trending:
        print(metric)

    analyzer.stop(join=True)


# --------------------------------------------------------------------------- #
# Allow running this module directly for quick smoke-testing.
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    _demo()
```