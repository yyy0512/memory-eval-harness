```python
"""
PrismPocket – Color Analytics & Trend Suggestion Module

This module encapsulates the color-centric analytics pipeline that powers the
“trending palettes” and “creative prompt” features in PrismPocket.  It provides:

1. A lightweight Observable implementation to broadcast analytics snapshots
   to interested view-models and back-end sync workers.

2. A thread-safe, singleton ColorAnalyticsEngine that:
   • Accepts PrismCard instances as they stream in from capture repositories
   • Extracts color information (hex codes) and auxiliary metadata
   • Computes rolling palette usage metrics in the background
   • Persists intermediate state to disk for crash-safe recovery

3. A TrendSuggestionFactory that converts raw PaletteMetric objects into
   high-level “CreativePrompt” value objects later surfaced to the UI layer.

The code purposefully depends only on the Python standard library to keep the
core analytics engine platform-agnostic.  Platform or framework specific glue
(e.g., Kivy, BeeWare, PyObjC) should live inside adapter layers.
"""
from __future__ import annotations

import json
import queue
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, Future
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Protocol, Sequence, Tuple

###############################################################################
# Basic Domain Stubs
###############################################################################


class PrismCard:
    """
    Minimal stub representation of a PrismCard domain entity.  In the real
    project this is defined in `domain/prism_card.py`.  A reduced version is
    re-declared here to keep the module self-contained for distribution.
    """

    __slots__ = ("uid", "created_at", "colors", "geo", "mood")

    def __init__(
        self,
        uid: str,
        colors: Sequence[str],
        geo: Optional[Tuple[float, float]] = None,
        mood: Optional[float] = None,
        created_at: Optional[datetime] = None,
    ) -> None:
        self.uid: str = uid
        self.created_at: datetime = created_at or datetime.now(tz=timezone.utc)
        self.colors: Tuple[str, ...] = tuple(colors)
        self.geo: Optional[Tuple[float, float]] = geo
        self.mood: Optional[float] = mood

    # The __repr__ is useful for debug logging.
    def __repr__(self) -> str:  # pragma: no cover
        return f"PrismCard(uid={self.uid}, colors={len(self.colors)})"


class PaletteMetric:
    """
    Aggregate data object representing historical statistics about color usage.
    """

    __slots__ = ("timestamp", "most_common", "palette_counts")

    def __init__(self, palette_counts: Dict[str, int]) -> None:
        self.timestamp: datetime = datetime.now(tz=timezone.utc)
        self.palette_counts: Dict[str, int] = palette_counts
        self.most_common: List[Tuple[str, int]] = Counter(palette_counts).most_common()

    def to_json(self) -> str:
        return json.dumps(
            {
                "timestamp": self.timestamp.isoformat(),
                "palette_counts": self.palette_counts,
                "most_common": self.most_common,
            }
        )

    @classmethod
    def from_json(cls, payload: str) -> "PaletteMetric":
        blob = json.loads(payload)
        metric = cls(blob["palette_counts"])
        metric.timestamp = datetime.fromisoformat(blob["timestamp"])
        return metric

    def __repr__(self) -> str:  # pragma: no cover
        return f"PaletteMetric(ts={self.timestamp.isoformat()}, colors={len(self.palette_counts)})"


###############################################################################
# Observable / Observer implementation
###############################################################################


class Observer(Protocol):
    """
    Protocol describing the expected signature for observers.
    """

    def update(self, metric: PaletteMetric) -> None: ...


class Observable:
    """
    Thread-safe mixin implementing the subscription bus used across the app.
    """

    __slots__ = ("_observers", "_ob_lock")

    def __init__(self) -> None:
        self._observers: List[Observer] = []
        self._ob_lock = threading.RLock()

    # Subscription API ----------------------------------------------------------------

    def add_observer(self, observer: Observer) -> None:
        with self._ob_lock:
            if observer not in self._observers:
                self._observers.append(observer)

    def remove_observer(self, observer: Observer) -> None:
        with self._ob_lock:
            try:
                self._observers.remove(observer)
            except ValueError:
                pass  # Failing silently is acceptable here.

    def _notify(self, metric: PaletteMetric) -> None:
        with self._ob_lock:
            # Copy to avoid modification during iteration.
            observers = list(self._observers)
        for observer in observers:
            try:
                observer.update(metric)
            except Exception as exc:  # pragma: no cover
                # Swallow exceptions from observers to keep engine alive.
                print(f"[Observable] Observer {observer} raised {exc!r}")


###############################################################################
# Singleton Meta Class
###############################################################################


class _Singleton(type):
    _instances: Dict["_Singleton", "ColorAnalyticsEngine"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        """
        Return the existing instance if present.  Thread-safe.
        """
        if cls not in cls._instances:
            with cls._lock:
                # Double-check pattern.
                if cls not in cls._instances:
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


###############################################################################
# Color Analytics Engine
###############################################################################


class ColorAnalyticsEngine(Observable, metaclass=_Singleton):
    """
    Long-living singleton that continuously computes color usage metrics from
    incoming PrismCards.  It is resilient to crashes by persisting its current
    palette counter to disk on each flush interval.
    """

    STORAGE_PATH = Path.home() / ".prism_pocket" / "palette_metrics.json"
    _FLUSH_BATCH_SIZE = 16

    def __init__(self, max_workers: int = 2) -> None:
        super().__init__()
        self._counter: Counter[str] = Counter()
        self._queue: queue.Queue[PrismCard] = queue.Queue()
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="PaletteWorker"
        )
        self._shutdown = threading.Event()
        self._background_future: Optional[Future[None]] = None
        self._load_state()

    # --------------------------------------------------------------------- Public API

    def submit_card(self, card: PrismCard) -> None:
        """
        Queue a new PrismCard for palette analysis.
        """
        if self._shutdown.is_set():
            raise RuntimeError("Analytics engine has been shut down.")
        self._queue.put(card)
        # Lazily start the worker on the first submission for this lifecycle.
        if self._background_future is None:
            self._background_future = self._executor.submit(self._drain_loop)

    def flush(self) -> PaletteMetric:
        """
        Force computation of the current metric, persist state, and
        synchronously notify observers.  This method is useful during
        app backgrounding when time is constrained.
        """
        metric = self._make_metric()
        self._persist_state()
        self._notify(metric)
        return metric

    def shutdown(self, wait: bool = True) -> None:
        """
        Drain outstanding work and stop background threads gracefully.
        """
        self._shutdown.set()
        if wait and self._background_future:
            self._background_future.result(timeout=10)
        self._executor.shutdown(wait=wait)
        self._persist_state()

    # ----------------------------------------------------------------- Internal Loop

    def _drain_loop(self) -> None:
        """
        Continuously drains the card queue, updating the counter, and emitting
        metrics periodically.  Runs inside a worker thread.
        """
        batch: List[PrismCard] = []

        while not self._shutdown.is_set():
            try:
                card = self._queue.get(timeout=0.25)
                batch.append(card)
                if len(batch) >= self._FLUSH_BATCH_SIZE:
                    self._integrate_batch(batch)
                    batch.clear()
            except queue.Empty:
                if batch:
                    # Flush partial batch.
                    self._integrate_batch(batch)
                    batch.clear()

        # Final flush when shutdown event is set
        if batch:
            self._integrate_batch(batch)

    # ---------------------------------------------------------------- Helper Methods

    def _integrate_batch(self, cards: Iterable[PrismCard]) -> None:
        """
        Update internal counters and dispatch metrics after processing a batch.
        """
        for card in cards:
            self._counter.update(card.colors)

        metric = self._make_metric()
        self._persist_state()
        self._notify(metric)

    def _make_metric(self) -> PaletteMetric:
        """
        Create a PaletteMetric snapshot from the current counter.
        """
        # Counter is mutable; copy to avoid race conditions with observers.
        counts_copy = dict(self._counter)
        return PaletteMetric(counts_copy)

    # -------------------------------------------------------------- Persistence Layer

    def _load_state(self) -> None:
        """
        Attempt to restore palette counters from disk.
        """
        try:
            if self.STORAGE_PATH.exists():
                with self.STORAGE_PATH.open("r", encoding="utf-8") as fp:
                    blob = json.load(fp)
                    self._counter = Counter(blob["palette_counts"])
                print(f"[ColorAnalyticsEngine] Restored {len(self._counter)} colors")
        except Exception as exc:
            # Corrupted file – best to start fresh rather than crash.
            print(f"[ColorAnalyticsEngine] State restoration failed: {exc!r}")

    def _persist_state(self) -> None:
        """
        Persist the current color counter to disk.  This function is intentionally
        lightweight to be called often.
        """
        try:
            self.STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
            payload = {"palette_counts": self._counter}
            tmp_path = self.STORAGE_PATH.with_suffix(".tmp")
            with tmp_path.open("w", encoding="utf-8") as fp:
                json.dump(payload, fp)
            tmp_path.replace(self.STORAGE_PATH)
        except Exception as exc:  # pragma: no cover
            print(f"[ColorAnalyticsEngine] Failed to persist state: {exc!r}")


###############################################################################
# Trend Suggestion Factory
###############################################################################


class CreativePrompt:
    """
    Value object passed to the UI layer containing suggestion details.
    """

    __slots__ = ("title", "description", "payload", "created_at")

    def __init__(
        self,
        title: str,
        description: str,
        payload: Optional[dict] = None,
    ) -> None:
        self.title = title
        self.description = description
        self.payload = payload or {}
        self.created_at: datetime = datetime.now(tz=timezone.utc)

    def __repr__(self) -> str:  # pragma: no cover
        return f"CreativePrompt({self.title!r})"


class TrendSuggestionFactory:
    """
    Factory that converts PaletteMetric snapshots into higher-level creative
    prompts shown to the user’s “Inspiration Feed”.
    """

    _MIN_COUNT_FOR_TREND = 5
    _TOP_N = 3

    def __init__(self) -> None:
        self._last_prompt: Optional[CreativePrompt] = None

    # Public --------------------------------------------------------------------

    def build_prompt(self, metric: PaletteMetric) -> Optional[CreativePrompt]:
        """
        Return a CreativePrompt if there is a novel suggestion, else None.
        """
        trending = self._extract_trending(metric)
        if not trending:
            return None

        title = "🔥 Trending Palette"
        cols = ", ".join(f"{c} ({n})" for c, n in trending)
        description = f"These colors are on fire: {cols}. Try them in your next remix!"
        prompt = CreativePrompt(title, description, payload={"trending": trending})

        if self._is_duplicate(prompt):
            return None
        self._last_prompt = prompt
        return prompt

    # Internal ------------------------------------------------------------------

    def _extract_trending(
        self, metric: PaletteMetric
    ) -> List[Tuple[str, int]]:
        """
        Pick the top N colors above a certain threshold.
        """
        return [
            (color, count)
            for color, count in metric.most_common[: self._TOP_N]
            if count >= self._MIN_COUNT_FOR_TREND
        ]

    def _is_duplicate(self, prompt: CreativePrompt) -> bool:
        """
        Rudimentary duplicate detection: check title and payload equality.
        """
        if not self._last_prompt:
            return False
        return (
            prompt.title == self._last_prompt.title
            and prompt.payload == self._last_prompt.payload
        )


###############################################################################
# Diagnostic & Self-Test Harness
###############################################################################

if __name__ == "__main__":  # pragma: no cover
    # Quick self-test when the module is executed directly.
    import random
    import string
    import time

    def random_hex() -> str:
        return "#" + "".join(random.choices("0123456789ABCDEF", k=6))

    # Observer that prints incoming metrics
    class PrinterObserver:
        def update(self, metric: PaletteMetric) -> None:
            print("[PrinterObserver]", metric.most_common[:3])

    engine = ColorAnalyticsEngine()
    engine.add_observer(PrinterObserver())

    # Simulate streaming cards
    for i in range(50):
        colors = [random_hex() for _ in range(random.randint(1, 4))]
        card = PrismCard(uid=f"card_{i}", colors=colors)
        engine.submit_card(card)
        time.sleep(0.05)

    # Force flush and show a creative prompt
    metric = engine.flush()
    prompt_factory = TrendSuggestionFactory()
    prompt = prompt_factory.build_prompt(metric)
    if prompt:
        print(prompt.title, "=>", prompt.description)

    engine.shutdown()
```