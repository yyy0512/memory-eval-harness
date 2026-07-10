```python
"""
src/module_18.py

PaletteAnalyticsService
=======================

This module implements the PaletteAnalyticsService: a singleton, observable
service that derives real-time, windowed color-palette trends from an incoming
stream of PrismCard entities.  The service embraces key PrismPocket
architecture patterns:

• Repository Pattern – decouples persistence from domain logic
• Observer Pattern   – publishes analytics updates to interested subscribers
• Singleton          – ensures only one analytics engine is active
• Clean Architecture – depends only on core abstractions, never frameworks

The service is intentionally thread-safe and mindful of mobile constraints
(e.g., battery life, intermittent connectivity).  All heavy work is pushed
off the UI thread and guarded with sensible fallbacks.
"""

from __future__ import annotations

import collections
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Iterable, List, MutableMapping, Protocol, Set, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

_LOGGER = logging.getLogger("prism_pocket.analytics.palette")
_LOGGER.addHandler(logging.NullHandler())

# --------------------------------------------------------------------------- #
# Domain Models (minimal, local stand-ins)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Color:
    """Value object representing an RGB color as a hex string (e.g., '#FFAA00')."""

    hex_code: str

    def __post_init__(self) -> None:
        if not self.hex_code.startswith("#") or len(self.hex_code) != 7:
            raise ValueError(f"Invalid hex color: {self.hex_code}")


@dataclass(frozen=True, slots=True)
class PrismCard:
    """Simplified domain entity – enough to demonstrate analytics."""

    card_id: str
    palette: Tuple[Color, ...]
    created_utc: datetime
    latitude: float | None = None
    longitude: float | None = None
    mood_score: float | None = None  # 0.0 → 1.0


@dataclass(slots=True)
class PaletteMetric:
    """Aggregate metric for a unique color palette."""

    palette_key: Tuple[str, ...]  # Normalised, sorted hex codes
    count: int = 0

    def increment(self) -> None:
        self.count += 1


# --------------------------------------------------------------------------- #
# Repository & Observer Abstractions
# --------------------------------------------------------------------------- #


class CardRepository(Protocol):
    """Contract for a repository that can stream PrismCard insertions."""

    def stream(self, start_from: datetime | None = None) -> Iterable[PrismCard]: ...


class AnalyticsObserver(Protocol):
    """Contract for consumers that want palette metric updates."""

    def on_palette_metrics(
        self, metrics: List[PaletteMetric], published_at: datetime
    ) -> None: ...


# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #


class PaletteAnalyticsError(RuntimeError):
    """Raised when the analytics service fails irrecoverably."""


# --------------------------------------------------------------------------- #
# Analytics Service
# --------------------------------------------------------------------------- #


class PaletteAnalyticsService:
    """
    Real-time analytic engine that discovers trending color palettes.

    Usage
    -----
        service = PaletteAnalyticsService.get_instance(repository)
        service.register(my_view_model)
        service.start()
        ...
        service.stop()
    """

    _instance_lock = threading.Lock()
    _instance: "PaletteAnalyticsService | None" = None

    DEFAULT_TIME_WINDOW = timedelta(hours=24)
    _POLL_SLEEP_S = 0.05  # yield slice to event loop/thread scheduler

    # --------------------------- Singleton API --------------------------- #

    @classmethod
    def get_instance(
        cls,
        repository: CardRepository | None = None,
    ) -> "PaletteAnalyticsService":
        with cls._instance_lock:
            if cls._instance is None:
                if repository is None:
                    raise ValueError(
                        "First invocation must provide a CardRepository."
                    )
                cls._instance = cls(repository=repository)
            return cls._instance

    # --------------------------- Init / State --------------------------- #

    def __init__(self, repository: CardRepository) -> None:
        self._repository = repository
        self._observers: Set[AnalyticsObserver] = set()

        self._buffer: Deque[PrismCard] = collections.deque()
        self._metrics: MutableMapping[Tuple[str, ...], PaletteMetric] = {}
        self._metrics_lock = threading.RLock()

        self._running = threading.Event()
        self._worker: threading.Thread | None = None

    # --------------------------- Public API ----------------------------- #

    def register(self, observer: AnalyticsObserver) -> None:
        """Subscribe to palette metric updates."""
        self._observers.add(observer)

    def unregister(self, observer: AnalyticsObserver) -> None:
        """Unsubscribe from updates."""
        self._observers.discard(observer)

    def start(self) -> None:
        """Start the background analytics worker."""
        if self._running.is_set():
            _LOGGER.debug("PaletteAnalyticsService already running.")
            return

        _LOGGER.info("Starting PaletteAnalyticsService")
        self._running.set()
        self._worker = threading.Thread(
            target=self._run_forever,
            name="PaletteAnalyticsWorker",
            daemon=True,
        )
        self._worker.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        """Signal the worker to stop and optionally wait for completion."""
        if not self._running.is_set():
            return
        _LOGGER.info("Stopping PaletteAnalyticsService")
        self._running.clear()
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=timeout)

    # --------------------------- Worker Loop ---------------------------- #

    def _run_forever(self) -> None:
        try:
            # Start streaming cards from now – we are not retroactive.
            for card in self._repository.stream(start_from=datetime.now(timezone.utc)):
                if not self._running.is_set():
                    break
                self._ingest_card(card)
                time.sleep(self._POLL_SLEEP_S)
        except Exception as exc:
            _LOGGER.exception("Analytics worker crashed: %s", exc)
            raise PaletteAnalyticsError("Worker crashed") from exc

    # --------------------------- Ingestion ------------------------------ #

    def _ingest_card(self, card: PrismCard) -> None:
        """
        Consume a new PrismCard, maintain the rolling window, recompute metrics,
        and notify observers if necessary.
        """
        with self._metrics_lock:
            self._buffer.append(card)
            self._trim_buffer()
            updated = self._update_metrics(card)
        if updated:
            self._publish_metrics()

    def _trim_buffer(self) -> None:
        """Drop cards outside the time window to enforce sliding window logic."""
        now = datetime.now(timezone.utc)
        cutoff = now - self.DEFAULT_TIME_WINDOW
        while self._buffer and self._buffer[0].created_utc < cutoff:
            expired = self._buffer.popleft()
            key = self._palette_key(expired.palette)
            metric = self._metrics.get(key)
            if metric:
                metric.count -= 1
                if metric.count <= 0:
                    self._metrics.pop(key, None)

    def _update_metrics(self, card: PrismCard) -> bool:
        """
        Increment counts for the incoming card palette.
        Returns True if overall metrics changed significantly.
        """
        key = self._palette_key(card.palette)
        metric = self._metrics.get(key)
        if metric is None:
            metric = PaletteMetric(palette_key=key, count=1)
            self._metrics[key] = metric
            _LOGGER.debug("New palette discovered: %s", key)
            return True
        else:
            before = metric.count
            metric.increment()
            _LOGGER.debug("Palette %s occurrence %d → %d", key, before, metric.count)
            # Simple heuristic: publish if a group hits powers of two
            return self._is_power_of_two(metric.count)

    @staticmethod
    def _is_power_of_two(n: int) -> bool:
        return n != 0 and (n & (n - 1) == 0)

    # --------------------------- Publish -------------------------------- #

    def _publish_metrics(self) -> None:
        """Send an immutable copy of current metrics to all subscribers."""
        snapshot = sorted(
            (PaletteMetric(palette_key=k, count=m.count) for k, m in self._metrics.items()),
            key=lambda m: m.count,
            reverse=True,
        )
        timestamp = datetime.now(timezone.utc)
        _LOGGER.debug("Publishing %d palette metrics at %s", len(snapshot), timestamp)

        # Dispatch on observers in a non-blocking fashion
        for observer in list(self._observers):
            try:
                observer.on_palette_metrics(snapshot, timestamp)
            except Exception as exc:
                _LOGGER.error("Observer %s failed: %s", observer, exc)

    # --------------------------- Helpers -------------------------------- #

    @staticmethod
    def _palette_key(palette: Tuple[Color, ...]) -> Tuple[str, ...]:
        """
        Normalize palette to an ordered tuple of hex strings.
        Sorting ensures ['#000', '#FFF'] is the same as ['#FFF', '#000'].
        """
        return tuple(sorted(color.hex_code.upper() for color in palette))

    # --------------------------- Debug / Diagnostics -------------------- #

    def dump_state(self) -> Dict[str, int]:
        """Return current metric counts – helpful for unit tests."""
        with self._metrics_lock:
            return {k: m.count for k, m in self._metrics.items()}


# --------------------------------------------------------------------------- #
# Stand-in In-Memory Repository (for dev & unit tests only)
# --------------------------------------------------------------------------- #


class _InMemoryCardRepository(CardRepository):
    """
    A naïve in-memory repository that yields cards appended via `append`.
    Useful for local tests or debug sessions.
    """

    def __init__(self) -> None:
        self._queue: Deque[PrismCard] = collections.deque()
        self._condition = threading.Condition()

    # Repository API ----------------------------------------------------- #

    def stream(self, start_from: datetime | None = None) -> Iterable[PrismCard]:
        idx = 0
        while True:
            with self._condition:
                while idx >= len(self._queue):
                    self._condition.wait(timeout=0.5)
                    if not threading.main_thread().is_alive():
                        return
                card = self._queue[idx]
                idx += 1
            yield card

    # Public convenience ------------------------------------------------- #

    def append(self, card: PrismCard) -> None:
        with self._condition:
            self._queue.append(card)
            self._condition.notify_all()


# --------------------------------------------------------------------------- #
# Example Execution
# --------------------------------------------------------------------------- #

# The following block is only executed when running this module as a script,
# it is *not* executed when imported by production code or unit tests.

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(levelname)s] %(message)s")

    # Build test data
    def hex2color(*codes: str) -> Tuple[Color, ...]:
        return tuple(Color(code) for code in codes)

    repo = _InMemoryCardRepository()
    service = PaletteAnalyticsService.get_instance(repo)

    class _DebugObserver:
        def on_palette_metrics(self, metrics: List[PaletteMetric], published_at: datetime) -> None:
            print(f"Analytics @ {published_at.isoformat(timespec='seconds')}")
            for m in metrics[:5]:
                print(f"  {m.palette_key} → {m.count}")

    service.register(_DebugObserver())
    service.start()

    # Simulate feeding cards
    for i in range(1, 21):
        palette = hex2color("#FF0000", "#00FF00") if i % 2 == 0 else hex2color("#0000FF")
        card = PrismCard(
            card_id=f"card-{i}",
            palette=palette,
            created_utc=datetime.now(timezone.utc),
        )
        repo.append(card)
        time.sleep(0.2)

    service.stop()
```