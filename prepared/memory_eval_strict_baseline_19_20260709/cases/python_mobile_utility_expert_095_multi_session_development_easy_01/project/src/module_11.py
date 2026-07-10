```python
"""
src/module_11.py
================

Palette analytics and trend-surfacing utilities for PrismPocket.

This module implements a light-weight in-process event bus (Observer pattern) and an
analytics pipeline that listens for PrismCard–related events, persists palette
metrics, and surfaces real-time trend data to interested subscribers.

The implementation respects Clean Architecture boundaries: the analytic *use-case*
sits in the domain layer, while the SQLite repository is an outer-ring data source.
All communication with higher layers happens through immutable value objects
(dataclasses) and the observer bus.

The code is deliberately self-contained so that it can be dropped into the mobile
build without extra wiring, but can also be swapped out for platform-specific
implementations (e.g., Cloud Firestore, CoreData) thanks to the Repository Pattern.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
import weakref
from collections import Counter, deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Deque, Dict, Iterable, List, Optional, Tuple

###############################################################################
# Domain objects
###############################################################################


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    """Immutable value object representing a captured palette sample."""
    card_id: str
    colors: Tuple[str, ...]  # RGB hex strings: ("#FFFFFF", "#000000", ...)
    captured_at: datetime = field(default_factory=datetime.utcnow)

    # A precomputed, hashable signature used as the palette key
    signature: str = field(init=False)

    def __post_init__(self) -> None:
        # Enforce hex color format and compute signature
        object.__setattr__(self, "colors", tuple(c.upper() for c in self.colors))
        object.__setattr__(self, "signature", "|".join(self.colors))


###############################################################################
# Observer/Event Bus – simplified local implementation
###############################################################################


class _Subscription:
    """Internal helper capturing a weak reference to a callback."""

    def __init__(self, callback: Callable[[PaletteMetric], None]) -> None:
        self._ref = weakref.WeakMethod(callback)  # type: ignore[arg-type]

    def notify(self, payload: PaletteMetric) -> None:
        func = self._ref()
        if func is not None:
            try:
                func(payload)
            except Exception:  # pragma: no cover – guard rail
                # We do not crash consumer code; instead log and continue
                print(
                    f"[EventBus] Unhandled exception in subscriber {func.__qualname__}",
                    flush=True,
                )


class EventBus:
    """
    Simple singleton event bus. Optimised for *local* intra-process delivery;
    not intended for inter-device sync (handled by remote adapter elsewhere).
    """

    _instance: Optional["EventBus"] = None
    _lock = threading.RLock()

    def __new__(cls) -> "EventBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscriptions: List[_Subscription] = []
            return cls._instance

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(self, callback: Callable[[PaletteMetric], None]) -> Callable[[], None]:
        """
        Subscribe to PaletteMetric events.

        Returns a no-arg `dispose()` that removes the subscription.
        """
        sub = _Subscription(callback)
        with self._lock:
            self._subscriptions.append(sub)

        def _dispose() -> None:
            with self._lock:
                if sub in self._subscriptions:
                    self._subscriptions.remove(sub)

        return _dispose

    def publish(self, payload: PaletteMetric) -> None:
        """Publish an event synchronously to all subscribers."""
        # Copy to avoid issues when subscribers mutate the list
        with self._lock:
            subs_snapshot = list(self._subscriptions)

        for sub in subs_snapshot:
            sub.notify(payload)


###############################################################################
# Repository (SQLite) – persistence of PaletteMetric events
###############################################################################


class PaletteMetricRepository:
    """
    SQLite-backed repository persisting palette metrics.

    Thread-safe: each operation opens a new connection, respecting the SQLite
    'check_same_thread' guarantee.
    """

    _INIT_SQL = """
    CREATE TABLE IF NOT EXISTS palette_metric (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        colors_json TEXT NOT NULL,
        captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_palette_signature ON palette_metric (signature);
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path)
        self._ensure_schema()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def save(self, metric: PaletteMetric) -> None:
        """Persist a PaletteMetric instance."""
        sql = """
        INSERT OR IGNORE INTO palette_metric
            (id, card_id, signature, colors_json, captured_at)
        VALUES (?, ?, ?, ?, ?)
        """
        params = (
            str(uuid.uuid4()),
            metric.card_id,
            metric.signature,
            json.dumps(metric.colors),
            int(metric.captured_at.timestamp()),
        )
        with self._connect() as cur:
            cur.execute(sql, params)

    def fetch_since(self, since: datetime) -> List[PaletteMetric]:
        """
        Return all metrics captured *since* the given datetime.
        """
        sql = """
        SELECT card_id, colors_json, captured_at
        FROM palette_metric
        WHERE captured_at >= ?
        """
        with self._connect() as cur:
            ts = int(since.timestamp())
            rows = cur.execute(sql, (ts,)).fetchall()

        metrics: List[PaletteMetric] = []
        for card_id, colors_json, captured_at in rows:
            colors = tuple(json.loads(colors_json))
            metrics.append(
                PaletteMetric(
                    card_id=card_id,
                    colors=colors,
                    captured_at=datetime.utcfromtimestamp(captured_at),
                )
            )
        return metrics

    # ------------------------------------------------------------------ #
    # Internals
    # ------------------------------------------------------------------ #

    def _ensure_schema(self) -> None:
        with self._connect() as cur:
            cur.executescript(self._INIT_SQL)

    @contextmanager
    def _connect(self) -> Iterable[sqlite3.Cursor]:
        """
        Context manager returning a cursor with foreign keys enabled.
        Automatically commits on success and rolls back on error.
        """
        conn = sqlite3.connect(
            self._db_path,
            detect_types=sqlite3.PARSE_DECLTYPES,
            check_same_thread=False,
        )
        conn.execute("PRAGMA foreign_keys = 1")
        try:
            yield conn.cursor()
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


###############################################################################
# Analytics – Trend extraction over a sliding window
###############################################################################


class PaletteTrendAnalyzer:
    """
    Listens for PaletteMetric events and maintains a sliding-window view
    of the most popular color palettes.

    Subscribers can poll `get_trending()` for current rankings, or register
    callbacks via `on_update()` to receive incremental updates.
    """

    DEFAULT_WINDOW = timedelta(hours=1)
    DEFAULT_MAX_EVENTS = 5_000  # guard memory in pathological cases

    def __init__(
        self,
        repository: PaletteMetricRepository,
        window: timedelta = DEFAULT_WINDOW,
        bus: EventBus | None = None,
    ) -> None:
        self._repo = repository
        self._window = window
        self._bus = bus or EventBus()
        self._event_buffer: Deque[PaletteMetric] = deque(maxlen=self.DEFAULT_MAX_EVENTS)
        self._counter: Counter[str] = Counter()
        self._subscribers: List[Callable[[List[Tuple[str, int]]], None]] = []
        self._lock = threading.RLock()

        # Rehydrate state from persistent store
        self._bootstrap()
        # Start listening to live events
        self._dispose_bus = self._bus.subscribe(self._on_new_metric)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def get_trending(self, top_k: int = 5) -> List[Tuple[str, int]]:
        """
        Return a list of (palette_signature, weight) sorted by descending popularity.
        """
        with self._lock:
            return self._counter.most_common(top_k)

    def on_update(
        self, callback: Callable[[List[Tuple[str, int]]], None]
    ) -> Callable[[], None]:
        """
        Add a callback notified whenever trending rankings change.

        Returns dispose() function.
        """
        with self._lock:
            self._subscribers.append(callback)

        def _dispose() -> None:
            with self._lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return _dispose

    def shutdown(self) -> None:
        """Dispose subscriptions and release resources."""
        self._dispose_bus()  # stop listening
        with self._lock:
            self._subscribers.clear()
            self._event_buffer.clear()
            self._counter.clear()

    # ------------------------------------------------------------------ #
    # Event handling
    # ------------------------------------------------------------------ #

    def _on_new_metric(self, metric: PaletteMetric) -> None:
        """
        Callback invoked by the EventBus for every new PaletteMetric.
        Thread-safety provided by _lock; invoked on EventBus thread.
        """
        self._repo.save(metric)  # Persist first
        with self._lock:
            self._append_metric(metric)
            changed = self._prune_and_recompute()

            if changed:
                snapshot = self._counter.most_common()
                # Notify subscribers *outside* lock to avoid re-entry issues
                subs_snapshot = list(self._subscribers)
        # Notify outside critical section
        for cb in subs_snapshot:
            try:
                cb(snapshot)
            except Exception:
                print(
                    f"[PaletteTrendAnalyzer] Error in subscriber {cb.__qualname__}",
                    flush=True,
                )

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _bootstrap(self) -> None:
        """
        Preload the sliding window with persisted events to avoid cold start.
        """
        since = datetime.utcnow() - self._window
        for metric in self._repo.fetch_since(since):
            self._append_metric(metric)
        self._prune_and_recompute()

    def _append_metric(self, metric: PaletteMetric) -> None:
        """
        Add metric to local buffer. Caller must hold _lock.
        """
        self._event_buffer.append(metric)
        self._counter[metric.signature] += 1

    def _prune_and_recompute(self) -> bool:
        """
        Drop expired metrics outside the time window and recompute counter.

        Returns True if Top-N ordering changed.
        Caller must hold _lock.
        """
        now = datetime.utcnow()
        cutoff = now - self._window

        # Remove expired from buffer & counter
        changed = False
        while self._event_buffer and self._event_buffer[0].captured_at < cutoff:
            expired = self._event_buffer.popleft()
            self._counter[expired.signature] -= 1
            if self._counter[expired.signature] <= 0:
                del self._counter[expired.signature]
            changed = True

        # Detect ordering changes by comparing current top result
        # Assumes that ranking changes if counts changed OR new metric appended
        if changed:
            return True

        # Quick heuristic: if the last appended metric affects top order
        # we already incremented counter; recompute diff
        if len(self._counter) <= 1:
            return changed  # single item obviously no order change

        # Compare top 3 snapshot before/after
        previous = getattr(self, "_last_snapshot", [])
        current = self._counter.most_common(3)
        if previous != current:
            changed = True
            self._last_snapshot = current
        return changed


###############################################################################
# Example usage (would normally live elsewhere)
###############################################################################

def _demo() -> None:
    """
    Fires synthetic events to demonstrate real-time trend extraction.
    Executed only when running this file directly.
    """
    repo = PaletteMetricRepository(db_path=":memory:")
    analyzer = PaletteTrendAnalyzer(repository=repo)

    def log_update(top: List[Tuple[str, int]]) -> None:
        print(f"[Trend Update] {top}")

    analyzer.on_update(log_update)

    bus = EventBus()
    sample_palettes = [
        ("#FF0000", "#00FF00", "#0000FF"),
        ("#FFFF00", "#FF00FF", "#00FFFF"),
        ("#FF0000", "#00FF00", "#0000FF"),
    ]

    for i in range(10):
        metric = PaletteMetric(
            card_id=f"CARD-{i}",
            colors=sample_palettes[i % len(sample_palettes)],
            captured_at=datetime.utcnow(),
        )
        bus.publish(metric)
        time.sleep(0.1)

    analyzer.shutdown()


if __name__ == "__main__":
    _demo()
```