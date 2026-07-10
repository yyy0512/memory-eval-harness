```python
"""
PrismPocket – Palette Analytics Engine
--------------------------------------

This module houses the production-grade implementation responsible for
real-time aggregation of palette metrics emitted by `PrismCard` mutations.
It relies exclusively on in-process observability (Observer pattern) and
persists results to the device’s local sandbox so that they can be surfaced
later by the analytics dashboard view model.

The engine is intentionally headless: no UI bindings, no platform APIs.  
All external concerns are delegated to adapters (e.g., CameraAdapter,
PushAdapter) or upper-layer coordinators (MVVM’s ViewModels).

Key Components
~~~~~~~~~~~~~~
1. EventBus                – lightweight, thread-safe publish-subscribe hub
2. PaletteMetric           – domain entity representing aggregated palettes
3. MetricRepository        – JSON-backed repository for persistent metrics
4. PaletteAnalyticsEngine  – concrete Observer performing live aggregation
5. AnalyticsEngineFactory  – factory ensuring singleton instantiation
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

# ------------------------------------------------------------------------------
# Logging configuration
# ------------------------------------------------------------------------------

logger = logging.getLogger("PrismPocket.Analytics.PaletteEngine")
logger.setLevel(logging.INFO)


# ------------------------------------------------------------------------------
# Domain entities
# ------------------------------------------------------------------------------

@dataclass(frozen=True)
class PrismCard:
    """A minimal representation of a PrismCard used by the analytics layer."""
    uid: str
    # The card’s dominant RGB colors captured at creation ¶(0-255 each).
    palette: Tuple[Tuple[int, int, int], ...]


@dataclass
class PaletteMetric:
    """
    Domain model that tracks how often a given color palette occurs across all
    cards. The palette is stored as a normalized hex string tuple for JSON
    friendliness.
    """
    palette_key: Tuple[str, ...]
    hits: int
    last_seen_epoch: float

    def to_json(self) -> Dict:
        return asdict(self)

    @staticmethod
    def from_json(payload: Dict) -> "PaletteMetric":
        return PaletteMetric(
            palette_key=tuple(payload["palette_key"]),
            hits=payload["hits"],
            last_seen_epoch=payload["last_seen_epoch"],
        )


# ------------------------------------------------------------------------------
# Observer bus
# ------------------------------------------------------------------------------

class EventBus:
    """
    Thread-safe in-process publish-subscribe hub.  
    A single global instance is shared across the process.
    """

    _lock = threading.RLock()
    _subscribers: Dict[str, List[Callable]] = defaultdict(list)

    @classmethod
    def subscribe(cls, topic: str, callback: Callable) -> None:
        with cls._lock:
            cls._subscribers[topic].append(callback)
            logger.debug("Subscribed to topic=%s: %s", topic, callback)

    @classmethod
    def unsubscribe(cls, topic: str, callback: Callable) -> None:
        with cls._lock:
            cls._subscribers[topic].remove(callback)
            logger.debug("Unsubscribed from topic=%s: %s", topic, callback)

    @classmethod
    def emit(cls, topic: str, *args, **kwargs) -> None:
        with cls._lock:
            listeners = list(cls._subscribers.get(topic, []))
        logger.debug("Emitting event to %d listeners on topic=%s", len(listeners), topic)
        for cb in listeners:
            try:
                cb(*args, **kwargs)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Listener raised on topic=%s: %s", topic, exc)


# Event topics
EVENT_CARD_MUTATED = "card_mutated"  # Fired when a card is created or updated
EVENT_METRICS_FLUSHED = "metrics_flushed"


# ------------------------------------------------------------------------------
# Repository
# ------------------------------------------------------------------------------

class MetricRepository:
    """
    JSON-backed repository that persists PaletteMetrics to local storage.
    All file IO is executed on a background thread to avoid blocking UI.
    """

    _IO_LOCK = threading.RLock()

    def __init__(self, storage_dir: Path) -> None:
        self._storage_dir = storage_dir.expanduser().resolve()
        self._storage_dir.mkdir(parents=True, exist_ok=True)
        self._file_path = self._storage_dir / "palette_metrics.json"
        logger.debug("MetricRepository initialized at %s", self._file_path)

    # Public API ----------------------------------------------------------------

    def load(self) -> Dict[Tuple[str, ...], PaletteMetric]:
        """
        Load palette metrics from disk.  
        Returns an empty dict if the file is missing or corrupted.
        """
        if not self._file_path.exists():
            logger.info("Metric file not found, returning empty metrics.")
            return {}

        try:
            with self._IO_LOCK, self._file_path.open("r", encoding="utf-8") as fp:
                payload = json.load(fp)
            metrics = {
                tuple(k): PaletteMetric.from_json(v) for k, v in payload.items()
            }
            logger.info("Loaded %d metrics from storage.", len(metrics))
            return metrics
        except Exception as exc:  # pylint: disable=broad-except
            logger.exception("Failed to load metrics, starting fresh: %s", exc)
            return {}

    def save(self, metrics: Dict[Tuple[str, ...], PaletteMetric]) -> None:
        """Persist metrics to disk (fire-and-forget)."""
        def _write():
            try:
                serializable = {k: v.to_json() for k, v in metrics.items()}
                with self._IO_LOCK, self._file_path.open("w", encoding="utf-8") as fp:
                    json.dump(serializable, fp, ensure_ascii=False, indent=2)
                logger.info("Persisted %d metrics to storage.", len(metrics))
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Failed to save metrics: %s", exc)

        threading.Thread(target=_write, name="MetricRepoWriter", daemon=True).start()


# ------------------------------------------------------------------------------
# Analytics engine
# ------------------------------------------------------------------------------

class PaletteAnalyticsEngine:
    """
    Aggregates PrismCard palettes in real-time and updates PaletteMetrics.
    The engine subscribes to EventBus events and keeps in-memory counters
    which are periodically flushed to the repository.
    """

    _FLUSH_INTERVAL_SEC = 15

    # Singleton state ----------------------------------------------------------
    _instance: "PaletteAnalyticsEngine | None" = None
    _instance_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "PaletteAnalyticsEngine":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = PaletteAnalyticsEngine()
            return cls._instance

    # Initialization -----------------------------------------------------------

    def __init__(self) -> None:
        if PaletteAnalyticsEngine._instance is not None:
            raise RuntimeError("Use PaletteAnalyticsEngine.get_instance()")

        self._repo = MetricRepository(Path.home() / ".prismpocket")
        self._metrics: Dict[Tuple[str, ...], PaletteMetric] = self._repo.load()
        self._counter: Counter[Tuple[str, ...]] = Counter()

        self._flush_timer: threading.Timer | None = None
        self._shutdown_event = threading.Event()

        # Subscribe to card mutation events
        EventBus.subscribe(EVENT_CARD_MUTATED, self._on_card_mutated)

        logger.info("PaletteAnalyticsEngine initialized with %d persisted metrics.",
                    len(self._metrics))

        # Kick off periodic background flush
        self._schedule_flush()

    # Event handlers -----------------------------------------------------------

    def _on_card_mutated(self, card: PrismCard) -> None:
        palette_key = self._normalize_palette(card.palette)
        logger.debug("Processing card %s with palette_key=%s", card.uid, palette_key)
        self._counter[palette_key] += 1

    # Internal helpers ---------------------------------------------------------

    @staticmethod
    def _normalize_palette(
        palette: Sequence[Tuple[int, int, int]],
    ) -> Tuple[str, ...]:
        """
        Normalize palette to a tuple of hex strings sorted by hue.  Ensures that
        physically identical palettes map to the same key even if ordering
        differs.
        """
        hex_colors = [f"#{r:02X}{g:02X}{b:02X}" for r, g, b in palette]
        # Sort by hue for deterministic keys
        sorted_hex = tuple(sorted(hex_colors))
        logger.debug("Normalized palette %s -> %s", hex_colors, sorted_hex)
        return sorted_hex

    # Flush procedure ----------------------------------------------------------

    def _schedule_flush(self) -> None:
        if self._shutdown_event.is_set():
            return

        self._flush_timer = threading.Timer(
            self._FLUSH_INTERVAL_SEC, self._flush_metrics
        )
        self._flush_timer.setDaemon(True)
        self._flush_timer.start()
        logger.debug("Scheduled next metrics flush in %d seconds.",
                     self._FLUSH_INTERVAL_SEC)

    def _flush_metrics(self) -> None:
        """Apply aggregated counts to metrics and persist them."""
        if not self._counter:
            self._schedule_flush()
            return

        logger.info("Flushing %d palette count(s) to metrics.", len(self._counter))

        ts = time.time()
        for palette_key, delta in self._counter.items():
            metric = self._metrics.get(palette_key)
            if metric is None:
                metric = PaletteMetric(
                    palette_key=palette_key, hits=0, last_seen_epoch=ts
                )
                self._metrics[palette_key] = metric
            metric.hits += delta
            metric.last_seen_epoch = ts
            logger.debug("Updated metric %s -> hits=%d", palette_key, metric.hits)

        # Clear temporary counter
        self._counter.clear()

        # Persist
        self._repo.save(self._metrics)

        # Broadcast flush event for any interested ViewModels
        EventBus.emit(EVENT_METRICS_FLUSHED, list(self._metrics.values()))

        # Schedule next flush
        self._schedule_flush()

    # Public control -----------------------------------------------------------

    def shutdown(self) -> None:
        """
        Flush all pending data and detach from EventBus.  
        Should be called by the application delegate on termination.
        """
        logger.info("Shutting down PaletteAnalyticsEngine …")
        self._shutdown_event.set()

        if self._flush_timer:
            self._flush_timer.cancel()
        self._flush_metrics()  # synchronous flush

        EventBus.unsubscribe(EVENT_CARD_MUTATED, self._on_card_mutated)
        logger.info("PaletteAnalyticsEngine shut down.")


# ------------------------------------------------------------------------------
# Factory (for DI / tests)
# ------------------------------------------------------------------------------

class AnalyticsEngineFactory:
    """
    Factory that returns the process-wide singleton. Kept separate to support
    dependency injection in tests (mocking, swap-in sandbox repository, etc.).
    """

    @staticmethod
    def provide_palette_engine() -> PaletteAnalyticsEngine:
        return PaletteAnalyticsEngine.get_instance()


# ------------------------------------------------------------------------------
# Example adapter usage (would normally live in a different layer)
# ------------------------------------------------------------------------------

def save_prism_card(card: PrismCard) -> None:
    """
    Example function mimicking a repository save operation that emits
    a mutation event so the analytics engine can listen in.
    """
    logger.info("Saving PrismCard %s …", card.uid)
    # … actual storage logic elided …
    EventBus.emit(EVENT_CARD_MUTATED, card)


# ------------------------------------------------------------------------------
# Self-test / demonstration (executed only when run as script)
# ------------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG,
                        format="%(levelname)-8s %(name)s: %(message)s")

    engine = AnalyticsEngineFactory.provide_palette_engine()

    try:
        # Generate synthetic cards
        test_cards = [
            PrismCard(uid="card-0001", palette=((255, 0, 0), (0, 255, 0))),
            PrismCard(uid="card-0002", palette=((0, 255, 0), (255, 0, 0))),
            PrismCard(uid="card-0003", palette=((0, 0, 255),)),
        ]
        for card in test_cards:
            save_prism_card(card)

        # Allow some time for flush
        time.sleep(PaletteAnalyticsEngine._FLUSH_INTERVAL_SEC + 2)
    finally:
        engine.shutdown()
```