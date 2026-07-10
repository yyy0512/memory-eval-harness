```python
"""
src/module_37.py
PrismPocket – mobile_utility

This module powers PrismPocket’s color–trend analytics subsystem.  It keeps a
rolling tally of palette usage, notifies interested observers in real-time, and
generates creative prompts based on emerging trends.

Architectural notes
-------------------
• Pure domain logic – no direct UI / platform dependencies
• Utilises the Observer, Singleton, and Repository patterns
• Async-friendly: non-blocking I/O for local persistence
• Designed for unit-testability (pure functions + small surface area)
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import sqlite3
import threading
from collections import Counter, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from typing import Callable, Deque, Dict, Iterable, List, MutableMapping, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Domain models
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Color:
    """
    Immutable 24-bit RGB colour representation.

    Each component ranges 0–255 inclusive.  Hex string conversion is provided
    for UI display and storage.
    """

    r: int
    g: int
    b: int

    def to_hex(self) -> str:
        return f"#{self.r:02X}{self.g:02X}{self.b:02X}"

    @staticmethod
    def from_hex(value: str) -> "Color":
        if not value.startswith("#") or len(value) != 7:
            raise ValueError(f"Invalid hex colour: {value}")
        r, g, b = (int(value[i : i + 2], 16) for i in (1, 3, 5))
        return Color(r, g, b)


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    """
    Aggregated usage metric for an individual colour.

    Attributes
    ----------
    colour : Color
        The colour being tracked.
    occurrences : int
        Number of times this colour appeared across all PrismCards.
    """

    colour: Color
    occurrences: int


@dataclass(slots=True)
class PrismCardSnapshot:
    """
    Lightweight snapshot of a PrismCard relevant for analytics.

    Only colour palette and timestamp are required for this module, allowing
    the rest of the PrismCard object graph to remain unloaded.
    """

    palette: Sequence[Color]
    created_at: float  # Unix timestamp


# --------------------------------------------------------------------------- #
# Observer bus
# --------------------------------------------------------------------------- #


class _Observer:
    """Callable that receives any published payload."""

    def __init__(self, callback: Callable[[str, object], None]) -> None:
        self._callback = callback

    def __call__(self, event: str, payload: object) -> None:
        try:
            self._callback(event, payload)
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Observer callback failed: %s", exc)


class ObservableMixin:
    """Simple pub-sub mixin – not thread-safe by itself."""

    def __init__(self) -> None:
        self._observers: List[_Observer] = []

    def subscribe(self, callback: Callable[[str, object], None]) -> None:
        self._observers.append(_Observer(callback))

    def _notify(self, event: str, payload: object) -> None:
        for observer in list(self._observers):
            observer(event, payload)


# --------------------------------------------------------------------------- #
# Local persistence
# --------------------------------------------------------------------------- #


class _SQLiteClient:
    """
    Tiny async wrapper for SQLite read/write operations.

    SQLite is shipped on both iOS & Android; it offers enough performance for
    moderate analytics workloads.  The synchronous driver is run in a thread
    pool to keep the asyncio loop responsive.
    """

    _DDL = """
    CREATE TABLE IF NOT EXISTS palette_metric (
        hex_colour TEXT PRIMARY KEY,
        occurrences INTEGER NOT NULL
    );
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._lock = threading.RLock()
        self._setup()

    def _setup(self) -> None:
        with self._conn() as cur:
            cur.executescript(self._DDL)

    @contextmanager
    def _conn(self):
        with self._lock:
            conn = sqlite3.connect(self._db_path)
            try:
                yield conn.cursor()
                conn.commit()
            finally:
                conn.close()

    async def upsert_palette(self, colour: Color, delta: int = 1) -> None:
        await asyncio.get_running_loop().run_in_executor(
            None, self._upsert_sync, colour.to_hex(), delta
        )

    def _upsert_sync(self, hex_colour: str, delta: int) -> None:
        with self._conn() as cur:
            cur.execute(
                """
                INSERT INTO palette_metric (hex_colour, occurrences)
                VALUES (?, ?)
                ON CONFLICT(hex_colour)
                DO UPDATE SET occurrences = occurrences + ?
                """,
                (hex_colour, delta, delta),
            )

    async def load_metrics(self) -> List[PaletteMetric]:
        rows = await asyncio.get_running_loop().run_in_executor(
            None, self._load_metrics_sync
        )
        return [PaletteMetric(Color.from_hex(h), n) for h, n in rows]

    def _load_metrics_sync(self) -> List[Tuple[str, int]]:
        with self._conn() as cur:
            cur.execute("SELECT hex_colour, occurrences FROM palette_metric")
            return cur.fetchall()


# --------------------------------------------------------------------------- #
# Repository (Singleton + Observable)
# --------------------------------------------------------------------------- #


class _SingletonMeta(type):
    """Thread-safe Singleton metaclass."""

    _instances: Dict[type, "AnalyticsRepository"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class AnalyticsRepository(ObservableMixin, metaclass=_SingletonMeta):
    """
    Source of truth for colour palette metrics.

    Observers are notified on each update:
        • event="metric_updated"
        • payload=PaletteMetric
    """

    _ROLLING_WINDOW_SIZE = 500  # max PrismCards cached in memory

    def __init__(self, db_path: Path | str | None = None) -> None:
        super().__init__()
        self._palette_counter: Counter[str] = Counter()
        self._recent_cards: Deque[PrismCardSnapshot] = deque(
            maxlen=self._ROLLING_WINDOW_SIZE
        )
        self._loop = asyncio.get_event_loop()
        self._storage = _SQLiteClient(Path(db_path or "palette_metrics.db"))
        # Pre-load persisted state
        self._loop.run_until_complete(self._hydrate())

    async def _hydrate(self) -> None:
        metrics = await self._storage.load_metrics()
        self._palette_counter.update({m.colour.to_hex(): m.occurrences for m in metrics})
        logger.info("Loaded %d palette metrics from disk", len(metrics))

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    async def register_card(self, snapshot: PrismCardSnapshot) -> None:
        """
        Record a new PrismCard snapshot, incrementing colour tallies.

        This method can be safely called from synchronous code by wrapping
        `asyncio.run_coroutine_threadsafe(...)` at call site.
        """
        self._recent_cards.append(snapshot)
        for colour in snapshot.palette:
            hex_colour = colour.to_hex()
            self._palette_counter[hex_colour] += 1
            await self._storage.upsert_palette(colour, delta=1)
            metric = PaletteMetric(colour, self._palette_counter[hex_colour])
            self._notify("metric_updated", metric)
        logger.debug("Registered card with %d colours", len(snapshot.palette))

    def top_colours(self, limit: int = 10) -> List[PaletteMetric]:
        """Return most frequent colours in descending order."""
        most_common = self._palette_counter.most_common(limit)
        return [
            PaletteMetric(Color.from_hex(hex_colour), occurrences)
            for hex_colour, occurrences in most_common
        ]

    def mood_score(self) -> float:
        """
        Naïve 'mood score' based on colour warmth.

        The warmer the average hue, the higher the score (0–100).
        """
        if not self._palette_counter:
            return 0.0

        hues: List[float] = []
        for hex_colour, count in self._palette_counter.items():
            r, g, b = Color.from_hex(hex_colour)
            # Convert to HLS, hue ∈ [0, 1]
            h, _, _ = _rgb_to_hls01(r, g, b)
            hues.extend([h] * count)

        avg_hue = mean(hues)
        return round(avg_hue * 100, 1)

    # --------------------------------------------------------------------- #
    # Diagnostic helpers
    # --------------------------------------------------------------------- #

    def debug_dump(self) -> None:
        logger.info(
            "PaletteCounter=%s  RecentCards=%d",
            dict(self._palette_counter),
            len(self._recent_cards),
        )


# --------------------------------------------------------------------------- #
# Trend analyser & prompt generation
# --------------------------------------------------------------------------- #


class TrendAnalyser:
    """
    Performs periodic analysis of colour usage trends and derives
    user-facing creative prompts.
    """

    _PROMPT_TEMPLATES = [
        "Try blending {colour} with a soft gradient to evoke calm.",
        "How about a bold splash of {colour} for your next card?",
        "Mix {colour} with neon stickers for a retro vibe!",
        "Challenge: create a monochrome scene around {colour}.",
    ]

    def __init__(
        self,
        repo: AnalyticsRepository | None = None,
        analysis_interval: float = 15.0,
    ) -> None:
        self._repo = repo or AnalyticsRepository()
        self._interval = analysis_interval
        self._running = False
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------ #
    # Public control
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """Begin background analysis in current event loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run(), name="TrendAnalyser")

    async def stop(self) -> None:
        """Stop background task gracefully."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    # ------------------------------------------------------------------ #
    # Internal
    # ------------------------------------------------------------------ #

    async def _run(self) -> None:
        while self._running:
            try:
                await self._analyse()
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Trend analysis failed: %s", exc)
            await asyncio.sleep(self._interval)

    async def _analyse(self) -> None:
        top = self._repo.top_colours(limit=5)
        if not top:
            return
        trending_colour = top[0].colour
        prompt = self._generate_prompt(trending_colour)
        logger.info(
            "Trending colour %s (occ=%d) – generated prompt: %s",
            trending_colour.to_hex(),
            top[0].occurrences,
            prompt,
        )
        # Propagate prompt to UI observers
        self._repo._notify("prompt_generated", prompt)  # pylint: disable=protected-access

    # ------------------------------------------------------------------ #
    # Utilities
    # ------------------------------------------------------------------ #

    def _generate_prompt(self, colour: Color) -> str:
        template = random.choice(self._PROMPT_TEMPLATES)
        return template.format(colour=colour.to_hex())


# --------------------------------------------------------------------------- #
# Helper functions
# --------------------------------------------------------------------------- #


def _rgb_to_hls01(r: int, g: int, b: int) -> Tuple[float, float, float]:
    """
    Convert 0–255 RGB to 0–1 HLS using built-in `colorsys`.

    We re-implement a lightweight version here to avoid shipping an extra
    dependency to mobile clients.
    """
    import colorsys

    return colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)


# --------------------------------------------------------------------------- #
# Test harness (only executed when run as script, not imported)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    async def _demo() -> None:
        repo = AnalyticsRepository(":memory:")  # in-memory DB for demo
        analyser = TrendAnalyser(repo, analysis_interval=5.0)
        analyser.start()

        # Simulate feed of PrismCard snapshots
        for i in range(20):
            # Random pastel palette
            snapshot = PrismCardSnapshot(
                palette=[
                    Color(
                        r=random.randint(100, 255),
                        g=random.randint(100, 255),
                        b=random.randint(100, 255),
                    )
                    for _ in range(3)
                ],
                created_at=asyncio.get_running_loop().time(),
            )
            await repo.register_card(snapshot)
            await asyncio.sleep(1.0)

        await asyncio.sleep(10)
        await analyser.stop()

    asyncio.run(_demo())
```