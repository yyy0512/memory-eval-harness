```python
"""
PrismPocket – Palette Analytics Module
--------------------------------------

This module powers the colour–usage analytics engine that fuels PrismPocket’s
creative–trend surfacing.  It demonstrates a mix of patterns used throughout
the code-base (Singleton, Repository, Factory, Observer) while remaining
self-contained and independently testable.

Key responsibilities
~~~~~~~~~~~~~~~~~~~~
* Listen for PrismCard capture events and update palette metrics
* Persist metrics locally (SQLite) for offline access
* Compute trending palettes and publish updates back onto the EventBus
* Provide a high-level factory for prompt/suggestion generation

The public surface of this file is limited to:

    PaletteAnalyticsEngine   –  Starts/stops the analytics processing runtime
    TrendSuggestionFactory   –  Creates text prompts from palette trends
    EventBus                 –  Lightweight Observer for intra-process events

Usage example
~~~~~~~~~~~~~
>>> bus = EventBus()
>>> engine = PaletteAnalyticsEngine(bus)
>>> engine.start()
>>>
>>> bus.publish("prism_card.captured", {"colors": ["#FFFFFF", "#000000"]})
>>> factory = TrendSuggestionFactory()
>>> print(factory.make_suggestions(1))
['Remix with trending palette #000000, #FFFFFF']
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

# --------------------------------------------------------------------------- #
# Module-level configuration                                                  #
# --------------------------------------------------------------------------- #

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s – %(message)s",
)

_LOG = logging.getLogger("prismpocket.analytics.palette")

_DATA_DIR = Path(os.getenv("PRISMPOCKET_DATA_DIR", Path.home() / ".prismpocket"))
_DATA_DIR.mkdir(parents=True, exist_ok=True)
_DB_FILE = _DATA_DIR / "palette_metrics.db"


# --------------------------------------------------------------------------- #
# Patterns                                                                    #
# --------------------------------------------------------------------------- #
class SingletonMeta(type):
    """
    Thread-safe Singleton metaclass.
    """

    _instances: Dict[type, "SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super(SingletonMeta, cls).__call__(
                    *args, **kwargs
                )
        return cls._instances[cls]


class EventBus(metaclass=SingletonMeta):
    """
    Very lightweight pub-sub bus for intra-process messages.

    Consumers subscribe to *event_type* strings and receive the payload dict
    asynchronously (each callback is executed in its own thread).
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[[dict], None]]] = defaultdict(list)
        self._lock = threading.Lock()

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def subscribe(self, event_type: str, callback: Callable[[dict], None]) -> None:
        """
        Register a callback for *event_type*.
        """
        with self._lock:
            self._subscribers[event_type].append(callback)
            _LOG.debug("Subscriber added for event '%s': %s", event_type, callback)

    def publish(self, event_type: str, payload: dict) -> None:
        """
        Publish *payload* on *event_type* channel.
        """
        with self._lock:
            subscribers = list(self._subscribers.get(event_type, []))

        if not subscribers:
            _LOG.debug("No subscribers for event '%s'", event_type)
            return

        _LOG.debug("Publishing event '%s' to %d subscribers", event_type, len(subscribers))
        for cb in subscribers:
            # Delegate to a worker thread to avoid blocking
            threading.Thread(target=self._safe_call, args=(cb, payload), daemon=True).start()

    # ------------------------------------------------------------------ #
    # Helpers                                                            #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _safe_call(callback: Callable[[dict], None], payload: dict) -> None:
        try:
            callback(payload)
        except Exception:  # pragma: no cover
            _LOG.exception("Unhandled exception within subscribed callback")


# --------------------------------------------------------------------------- #
# Repository                                                                  #
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PaletteMetric:
    """
    A persistence-ready representation of a colour palette’s popularity.
    """

    palette_id: str
    colors: Tuple[str, ...]
    usage_count: int
    last_seen: float  # epoch seconds

    # Score is calculated dynamically rather than persisted
    def score(self, now: float | None = None) -> float:  # noqa: D401
        """
        Returns a composite score that privileges both popularity (count) and
        recency (last_seen).
        """
        now = now or time.time()
        recency_factor = 1 / (now - self.last_seen + 1)
        return self.usage_count * 0.7 + recency_factor * 0.3 * 1_000


class PaletteTrendRepository(metaclass=SingletonMeta):
    """
    Local-storage (SQLite) repository for PaletteMetric records.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS palette_metrics (
        palette_id   TEXT PRIMARY KEY,
        colors       TEXT NOT NULL,     -- JSON array
        usage_count  INTEGER NOT NULL,
        last_seen    REAL NOT NULL
    )
    """

    def __init__(self, db_path: Path | str = _DB_FILE) -> None:
        self._path = Path(db_path)
        self._lock = threading.Lock()
        self._ensure_schema()

    # ------------------------------------------------------------------ #
    # Public API                                                         #
    # ------------------------------------------------------------------ #

    def update_palette_metric(self, colors: Iterable[str]) -> PaletteMetric:
        """
        Upserts the palette metric associated with *colors* and returns the
        updated metric.
        """
        normalized = tuple(sorted({c.upper() for c in colors}))
        palette_id = hashlib.sha1("".join(normalized).encode()).hexdigest()
        ts = time.time()

        with self._transaction() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO palette_metrics (palette_id, colors, usage_count, last_seen)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(palette_id) DO UPDATE SET
                    usage_count = usage_count + 1,
                    last_seen   = excluded.last_seen
                """,
                (palette_id, json.dumps(normalized), ts),
            )
            cur.execute(
                "SELECT palette_id, colors, usage_count, last_seen FROM palette_metrics "
                "WHERE palette_id = ?",
                (palette_id,),
            )
            row = cur.fetchone()

        metric = PaletteMetric(
            palette_id=row[0],
            colors=tuple(json.loads(row[1])),
            usage_count=row[2],
            last_seen=row[3],
        )
        _LOG.debug("Palette metric updated: %s", metric)
        return metric

    def get_top_palettes(self, limit: int = 10) -> List[PaletteMetric]:
        """
        Return *limit* palettes ordered by their computed score.
        """
        with self._transaction() as conn:
            rows = conn.execute(
                "SELECT palette_id, colors, usage_count, last_seen FROM palette_metrics"
            ).fetchall()

        metrics = [
            PaletteMetric(
                palette_id=row[0],
                colors=tuple(json.loads(row[1])),
                usage_count=row[2],
                last_seen=row[3],
            )
            for row in rows
        ]
        metrics.sort(key=lambda m: m.score(), reverse=True)
        _LOG.debug("Top %d palettes fetched", limit)
        return metrics[:limit]

    # ------------------------------------------------------------------ #
    # Internal helpers                                                   #
    # ------------------------------------------------------------------ #

    def _ensure_schema(self) -> None:
        with self._transaction() as conn:
            conn.executescript(self._SCHEMA)
        _LOG.debug("Schema ensured for %s", self._path)

    @contextmanager
    def _transaction(self):  # noqa: D401
        """
        Context manager that yields a SQLite connection with automatic commit/rollback
        and thread-safe locking.
        """
        with self._lock:
            conn = sqlite3.connect(self._path)
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()


# --------------------------------------------------------------------------- #
# Analytics Engine                                                            #
# --------------------------------------------------------------------------- #
class PaletteAnalyticsEngine:
    """
    Consumes `prism_card.captured` bus events and keeps palette metrics fresh.
    """

    _CARD_CAPTURED_EVENT = "prism_card.captured"
    _PAL_METRIC_UPDATED_EVENT = "analytics.palette_metric.updated"

    def __init__(
        self,
        bus: EventBus | None = None,
        repository: PaletteTrendRepository | None = None,
    ) -> None:
        self._bus = bus or EventBus()
        self._repo = repository or PaletteTrendRepository()
        self._started = threading.Event()

    # ------------------------------------------------------------------ #
    # Lifecycle                                                          #
    # ------------------------------------------------------------------ #

    def start(self) -> None:
        """
        Idempotent start. Multiple calls have no additional effect.
        """
        if self._started.is_set():
            return

        self._bus.subscribe(self._CARD_CAPTURED_EVENT, self._handle_card_capture)
        self._started.set()
        _LOG.info("PaletteAnalyticsEngine started and listening for '%s'", self._CARD_CAPTURED_EVENT)

    def stop(self) -> None:
        """Marker for future clean-up facilities (not needed for this module)."""
        self._started.clear()

    # ------------------------------------------------------------------ #
    # Event Handlers                                                     #
    # ------------------------------------------------------------------ #

    def _handle_card_capture(self, payload: dict) -> None:
        """
        Payload example:
            {
                "colors": ["#FF0000", "#00FF00", "#0000FF"],
                "card_id": "abc123",
                ...
            }
        """
        try:
            colors: Sequence[str] = payload.get("colors") or ()
            if not colors:
                _LOG.debug("No colours found in payload – skipping metric update")
                return

            metric = self._repo.update_palette_metric(colors)
            self._bus.publish(self._PAL_METRIC_UPDATED_EVENT, metric.__dict__)
            _LOG.debug("Metric published back on bus (%s)", self._PAL_METRIC_UPDATED_EVENT)
        except Exception:  # pragma: no cover
            _LOG.exception("Failed processing prism_card.captured payload")


# --------------------------------------------------------------------------- #
# Factory                                                                     #
# --------------------------------------------------------------------------- #
class TrendSuggestionFactory:
    """
    Produces user-facing text prompts derived from palette analytics.
    """

    def __init__(self, repo: PaletteTrendRepository | None = None) -> None:
        self._repo = repo or PaletteTrendRepository()

    def make_suggestions(self, limit: int = 3) -> List[str]:
        """
        Returns up to *limit* textual suggestions for trending palettes.
        """
        try:
            palettes = self._repo.get_top_palettes(limit=limit)
            suggestions = [
                f"Remix with trending palette {', '.join(metric.colors)}"
                for metric in palettes
            ]
            _LOG.debug("Generated %d suggestions", len(suggestions))
            return suggestions
        except Exception:  # pragma: no cover
            _LOG.exception("Could not generate suggestions")
            return []


# --------------------------------------------------------------------------- #
# CLI / Manual Test (python -m src.module_67)                                 #
# --------------------------------------------------------------------------- #
def _demo() -> None:  # pragma: no cover
    bus = EventBus()
    engine = PaletteAnalyticsEngine(bus)
    engine.start()

    # Simulate several card captures
    example_payloads = [
        {"card_id": "1", "colors": ["#FFAA00", "#FFFFFF", "#000000"]},
        {"card_id": "2", "colors": ["#FFAA00", "#FFFFFF", "#000000"]},
        {"card_id": "3", "colors": ["#00FFFF", "#FF00FF"]},
    ]

    for p in example_payloads:
        bus.publish("prism_card.captured", p)
        time.sleep(0.1)  # Allow async workers to finish

    suggestions = TrendSuggestionFactory().make_suggestions(limit=5)
    print("Suggestions:", suggestions)


if __name__ == "__main__":  # pragma: no cover
    _demo()
```