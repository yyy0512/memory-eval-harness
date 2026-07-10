```python
"""
PrismPocket – module_44.py
---------------------------------
Palette trend analysis and live–update broadcasting for PrismPocket.

This module sits in the “application” ring of the Clean Architecture stack.
It listens to PrismCard mutations published on the global Observer bus,
computes trending colour palettes asynchronously, persists interim results
to local storage for crash-safe recovery, and exposes a read-only API to
view-models that surface “creative trends” to the user interface.

Patterns employed
-----------------
• SingletonMeta         – Ensures one analyser instance app-wide
• Observer Pattern      – Subscribes to PrismCardRepository event bus
• Repository Pattern    – Persists snapshots via LocalTrendRepository
• Factory Pattern       – `get_palette_trend_analyzer()` helper
• ThreadPoolExecutor    – Non-blocking background computation
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

# ------------------------------------------------------------------------------
# Dependency fallbacks (duck stubs).
# In production these would come from the core domain modules.
# ------------------------------------------------------------------------------

try:
    from prism_pocket.domain.entities import PrismCard  # type: ignore
    from prism_pocket.domain.entities import PaletteMetric  # type: ignore
except ModuleNotFoundError:  # pragma: no cover — editor/CI friendliness
    from dataclasses import dataclass, field

    @dataclass(frozen=True, slots=True)
    class PrismCard:  # noqa: D401
        """Minimal stub for static-type satisfaction."""
        uid: str
        colours: List[str]
        created_at: float  # POSIX timestamp
        mood_score: float = 0.0

    @dataclass(slots=True)
    class PaletteMetric:
        palette: Tuple[str, ...]
        count: int
        last_seen: float = field(default_factory=time.time)

# ------------------------------------------------------------------------------
# Logger configuration
# ------------------------------------------------------------------------------

_LOGGER = logging.getLogger("prism_pocket.analytics.palette")
_LOGGER.addHandler(logging.NullHandler())

# ------------------------------------------------------------------------------
# Exceptions
# ------------------------------------------------------------------------------


class TrendComputationError(RuntimeError):
    """Raised when palette trend computation fails."""


# ------------------------------------------------------------------------------
# Observer Bus Interface
# ------------------------------------------------------------------------------

class Event:
    """Generic event wrapper for repository broadcasts."""
    def __init__(self, topic: str, payload: object):
        self.topic = topic
        self.payload = payload
        self.timestamp = time.time()


class Observer:
    """Abstract observer contract."""
    def update(self, event: Event) -> None:  # noqa: D401
        """Receive an event from the observable."""


class Observable:
    """Thread-safe observable implementation."""
    def __init__(self) -> None:
        self._observers: List[Observer] = []
        self._lock = threading.RLock()

    def register(self, obs: Observer) -> None:
        with self._lock:
            if obs not in self._observers:
                self._observers.append(obs)
                _LOGGER.debug("Observer registered: %s", obs)

    def unregister(self, obs: Observer) -> None:
        with self._lock:
            with suppress(ValueError):
                self._observers.remove(obs)
                _LOGGER.debug("Observer unregistered: %s", obs)

    def notify(self, event: Event) -> None:
        with self._lock:
            observers_snapshot = list(self._observers)
        for obs in observers_snapshot:
            try:
                obs.update(event)
            except Exception as exc:  # pragma: no cover
                _LOGGER.exception("Observer %s failed during notify: %s", obs, exc)


# ------------------------------------------------------------------------------
# Local repository – crash-safe persistence layer
# ------------------------------------------------------------------------------

class LocalTrendRepository:
    """
    Persists trend snapshots to local JSON for offline replay and crash recovery.
    """
    _FILE_NAME = "palette_trend_snapshot.json"

    def __init__(self, storage_dir: Path | None = None) -> None:
        self._storage_dir = storage_dir or Path.home() / ".prism_pocket"
        self._storage_dir.mkdir(parents=True, exist_ok=True)
        self._file_path = self._storage_dir / self._FILE_NAME
        _LOGGER.debug("LocalTrendRepository initialised at %s", self._file_path)

    # Public API ----------------------------------------------------------------

    def save(self, snapshot: Dict[str, int]) -> None:
        """
        Persist snapshot atomically by writing to a temporary file then renaming.
        """
        tmp_path = self._file_path.with_suffix(".tmp")
        try:
            tmp_path.write_text(json.dumps(snapshot))
            tmp_path.replace(self._file_path)
            _LOGGER.debug("Trend snapshot saved: %s", self._file_path)
        except Exception as exc:
            _LOGGER.exception("Failed to persist trend snapshot: %s", exc)

    def load(self) -> Dict[str, int]:
        """
        Load snapshot if present, otherwise return empty counter dict.
        """
        if not self._file_path.exists():
            return {}
        try:
            data = json.loads(self._file_path.read_text())
            _LOGGER.debug("Trend snapshot loaded from disk")
            return {tuple(k.split(",")): v for k, v in data.items()}
        except Exception as exc:
            _LOGGER.error("Corrupted trend snapshot encountered: %s; purging", exc)
            with suppress(FileNotFoundError):
                self._file_path.unlink(missing_ok=True)
            return {}

    # Utilities -----------------------------------------------------------------

    @staticmethod
    def serialise_palette(palette: Tuple[str, ...]) -> str:
        return ",".join(palette)


# ------------------------------------------------------------------------------
# Singleton metaclass
# ------------------------------------------------------------------------------

class SingletonMeta(type):
    """Thread-safe, lazy Singleton metaclass."""
    _instances: Dict[type, object] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:
                    inst = super().__call__(*args, **kwargs)
                    cls._instances[cls] = inst
        return cls._instances[cls]


# ------------------------------------------------------------------------------
# PaletteTrendAnalyzer
# ------------------------------------------------------------------------------

class PaletteTrendAnalyzer(Observer, metaclass=SingletonMeta):
    """
    Consumes PrismCard mutation events, maintains colour palette popularity
    counters, periodically computes trending palettes, and exposes lightweight
    read APIs to upper layers.
    """

    # Configuration
    _TOP_K = 5                 # Number of palettes to surface
    _PALETTE_SIZE = 3          # Colours considered per palette
    _COMPUTE_DEBOUNCE_S = 1.0  # Minimum delay between heavy computations
    _SNAPSHOT_TTL_S = 10.0     # How long a snapshot is considered “fresh”

    def __init__(
        self,
        observable_repo: Observable | None = None,
        storage_repo: LocalTrendRepository | None = None,
        executor: ThreadPoolExecutor | None = None,
    ) -> None:
        self._observable_repo = observable_repo
        self._storage_repo = storage_repo or LocalTrendRepository()
        self._palette_counter: Counter[Tuple[str, ...]] = Counter(
            self._storage_repo.load()
        )
        self._snapshot: List[PaletteMetric] = []
        self._snapshot_ts: float = 0.0
        self._compute_lock = threading.RLock()
        self._last_compute_request = 0.0
        self._executor = executor or ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="palette_analyzer",
        )
        _LOGGER.info("PaletteTrendAnalyzer initialised with %d palettes in cache",
                     len(self._palette_counter))

        if self._observable_repo:
            self._observable_repo.register(self)

    # Observer interface --------------------------------------------------------

    def update(self, event: Event) -> None:
        """Called by PrismCardRepository whenever cards mutate."""
        if event.topic != "prism_card_added":
            return

        card: PrismCard = event.payload
        _LOGGER.debug("Received PrismCard event: %s", card)

        try:
            self._register_card(card)
        except Exception as exc:  # pragma: no cover
            _LOGGER.exception("Failed registering card: %s", exc)

    # Immediate API (public) ----------------------------------------------------

    def get_trending_palettes(self) -> List[PaletteMetric]:
        """
        Returns top-K trending palettes, computing them if stale. Will never
        block the UI thread longer than necessary thanks to snapshot TTL.
        """
        if (time.time() - self._snapshot_ts) > self._SNAPSHOT_TTL_S:
            _LOGGER.debug("Trend snapshot stale → scheduling computation")
            self._schedule_compute()

        with self._compute_lock:
            return list(self._snapshot)

    # Internal helpers ----------------------------------------------------------

    def _register_card(self, card: PrismCard) -> None:
        """
        Extract palettes from card and increment counters. Afterwards, throttle
        compute requests to avoid hammering the executor on rapid fire events.
        """
        palettes = self._extract_palettes(card.colours)
        _LOGGER.debug("Extracted %d palette(s) from card %s", len(palettes), card.uid)

        for palette in palettes:
            self._palette_counter[palette] += 1

        # Persist incrementally for crash-safety
        serialised = {
            LocalTrendRepository.serialise_palette(p): c
            for p, c in self._palette_counter.items()
        }
        self._storage_repo.save(serialised)

        now = time.time()
        if now - self._last_compute_request >= self._COMPUTE_DEBOUNCE_S:
            self._last_compute_request = now
            self._schedule_compute()

    def _extract_palettes(self, colours: Iterable[str]) -> List[Tuple[str, ...]]:
        """
        Returns all unique, sorted palettes of length `_PALETTE_SIZE` that can be
        derived from the given colour sequence. For simplicity, we use sliding
        windows. Real implementation could be more advanced (e.g., clustering).
        """
        colours = list(dict.fromkeys(colours))  # preserve order, ensure unique
        if len(colours) < self._PALETTE_SIZE:
            return []

        palettes: List[Tuple[str, ...]] = []
        for idx in range(len(colours) - self._PALETTE_SIZE + 1):
            window = tuple(colours[idx : idx + self._PALETTE_SIZE])
            palettes.append(window)
        return palettes

    # Asynchronous computation --------------------------------------------------

    def _schedule_compute(self) -> None:
        """Offloads heavy ranking computation to the background executor."""
        future: Future[List[PaletteMetric]] = self._executor.submit(self._compute_trends)
        future.add_done_callback(self._on_compute_finished)

    def _compute_trends(self) -> List[PaletteMetric]:
        """
        Heavy computation: sorts palettes by usage and returns top-K.
        May raise TrendComputationError which will be handled by the callback.
        """
        try:
            most_common = self._palette_counter.most_common(self._TOP_K)
            _LOGGER.debug("Computed most_common palettes: %s", most_common)
            return [
                PaletteMetric(palette=palette, count=count, last_seen=time.time())
                for palette, count in most_common
            ]
        except Exception as exc as _exc:  # noqa: E722
            raise TrendComputationError("Failed during trend sorting") from _exc

    def _on_compute_finished(self, future: Future[List[PaletteMetric]]) -> None:
        """Callback executed in executor thread once compute completes."""
        try:
            result = future.result()
        except TrendComputationError as exc:
            _LOGGER.error("Trend computation error: %s", exc)
            return
        except Exception as exc:  # pragma: no cover
            _LOGGER.exception("Unexpected exception computing trends: %s", exc)
            return

        with self._compute_lock:
            self._snapshot = result
            self._snapshot_ts = time.time()
            _LOGGER.info("Palette trend snapshot updated with %d entries",
                         len(self._snapshot))

    # Shutdown handling ---------------------------------------------------------

    def shutdown(self) -> None:
        """Cleanly shuts down executor and detaches from observable bus."""
        if self._observable_repo:
            self._observable_repo.unregister(self)
        self._executor.shutdown(wait=False)
        _LOGGER.info("PaletteTrendAnalyzer shutdown complete")


# ------------------------------------------------------------------------------
# Factory function
# ------------------------------------------------------------------------------

def get_palette_trend_analyzer(
    observable_repo: Observable | None = None,
) -> PaletteTrendAnalyzer:
    """
    Factory entry-point for DI. Guarantees single instance across the
    application while allowing unit tests to override dependencies.
    """
    return PaletteTrendAnalyzer(observable_repo=observable_repo)


# ------------------------------------------------------------------------------
# Module test-run utility
# ------------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)
    repo = Observable()
    analyzer = get_palette_trend_analyzer(repo)

    # Simulate incoming PrismCards
    cards = [
        PrismCard(uid="1", colours=["#FF0000", "#00FF00", "#0000FF"], created_at=time.time()),
        PrismCard(uid="2", colours=["#FF0000", "#FFFF00", "#0000FF"], created_at=time.time()),
        PrismCard(uid="3", colours=["#00FF00", "#FF00FF", "#0000FF"], created_at=time.time()),
    ]

    for card in cards:
        repo.notify(Event(topic="prism_card_added", payload=card))
        time.sleep(0.2)

    time.sleep(2)
    print("Trending palettes:", analyzer.get_trending_palettes())
    analyzer.shutdown()
```