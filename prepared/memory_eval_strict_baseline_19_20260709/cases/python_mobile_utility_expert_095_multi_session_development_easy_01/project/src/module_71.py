```python
"""
src/module_71.py
PrismPocket – Palette analytics engine & observable dispatcher.

This module implements a production–ready, thread-safe palette–metric engine
that listens to PrismCard mutation events, extracts color-palette usage
signals, aggregates them in real-time, and publishes high-level analytics
snapshots back onto the app-wide Observer bus.

Patterns employed
-----------------
* Singleton (PaletteMetricEngine)
* Observer (subscription to global EventBus, internal listeners)
* Factory  (MetricSnapshotFactory)
* Repository (in-memory PaletteMetricRepository)

Note
----
Other building blocks (Domain entities, EventBus, etc.) are expected to exist
elsewhere in the code-base.  Lightweight fallbacks / stubs are provided to keep
this module functional when imported in isolation (e.g. during unit tests).
"""
from __future__ import annotations

import logging
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from enum import Enum, auto
from typing import Dict, Iterable, List, Mapping, Optional, Set

# =============================================================================
# Compatibility layer – stubs for external dependencies
# =============================================================================
try:
    # Real implementation should live in `prism_pocket.core.bus`
    from prism_pocket.core.bus import EventBus, Event, EventListener
except ModuleNotFoundError:  # pragma: no cover – unit-test fallback
    class Event(Enum):
        """Generic event placeholder."""
        PRISM_CARD_SAVED = auto()
        PRISM_CARD_DELETED = auto()

    class EventListener:
        """Listener interface stub."""
        def __call__(self, event: Event, **payload): ...

    class EventBus:
        """A naïve thread-safe pub/sub bus for local testing."""

        _listeners: Dict[Event, Set[EventListener]] = defaultdict(set)
        _lock = threading.RLock()

        @classmethod
        def subscribe(cls, event: Event, listener: EventListener) -> None:
            with cls._lock:
                cls._listeners[event].add(listener)

        @classmethod
        def publish(cls, event: Event, **payload) -> None:
            with cls._lock:
                for listener in tuple(cls._listeners[event]):
                    try:
                        listener(event, **payload)
                    except Exception:  # pragma: no cover
                        logging.exception("Listener %s failed for %s", listener, event)

# =============================================================================
# Logger configuration
# =============================================================================
logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())

# =============================================================================
# Domain models
# =============================================================================
@dataclass(frozen=True)
class PaletteMetric:
    """
    Immutable record representing aggregated usage data for a color palette.
    """
    palette_hash: str                 # Hash of the palette colors (e.g., md5)
    colors: List[str]                 # Hex colors, e.g. ['#FF0000', '#00FF00']
    usage_count: int                  # How many times the palette appeared
    last_used_at: datetime            # Last time this palette was observed
    unique_users: Set[str] = field(default_factory=set)


@dataclass(frozen=True)
class PaletteSnapshot:
    """
    A read-only analytics snapshot published on the EventBus.
    """
    generated_at: datetime
    top_palettes: List[PaletteMetric]
    total_unique_palettes: int
    total_cards_processed: int


# =============================================================================
# Repository – in-memory implementation (could be swapped for SQL/NoSQL)
# =============================================================================
class PaletteMetricRepository:
    """
    Repository handling CRUD for PaletteMetric records.

    Thread-safe, but not persisted across process restarts.
    """
    _lock = threading.RLock()

    def __init__(self) -> None:
        self._metrics: Dict[str, PaletteMetric] = {}
        self._total_cards_processed = 0

    # ---------- Public API --------------------------------------------------
    def increment_usage(
        self,
        palette_hash: str,
        colors: List[str],
        user_id: str,
        *,
        increment: int = 1,
    ) -> PaletteMetric:
        """
        Increment usage metrics for the given palette.  Creates a new record if
        necessary and returns the updated metric.
        """
        now = datetime.utcnow()
        with self._lock:
            metric = self._metrics.get(palette_hash)
            if metric is None:
                metric = PaletteMetric(
                    palette_hash=palette_hash,
                    colors=colors,
                    usage_count=0,
                    last_used_at=now,
                    unique_users=set(),
                )

            updated_metric = PaletteMetric(
                palette_hash=metric.palette_hash,
                colors=metric.colors,
                usage_count=metric.usage_count + increment,
                last_used_at=now,
                unique_users=metric.unique_users | {user_id},
            )
            self._metrics[palette_hash] = updated_metric
            self._total_cards_processed += 1
            logger.debug("Metric updated: %s", asdict(updated_metric))
            return updated_metric

    def top_n(self, n: int = 5) -> List[PaletteMetric]:
        """
        Return the N most-used palettes.
        """
        with self._lock:
            return sorted(
                self._metrics.values(),
                key=lambda m: (m.usage_count, m.last_used_at),
                reverse=True,
            )[:n]

    # ---------- Aggregate / Stats ------------------------------------------
    def total_unique_palettes(self) -> int:
        with self._lock:
            return len(self._metrics)

    def total_cards_processed(self) -> int:
        with self._lock:
            return self._total_cards_processed


# =============================================================================
# Snapshot factory
# =============================================================================
class MetricSnapshotFactory:
    """
    Factory responsible for converting raw repository data into serialisable
    PaletteSnapshot DTOs.
    """

    @staticmethod
    def create(repo: PaletteMetricRepository) -> PaletteSnapshot:
        snapshot = PaletteSnapshot(
            generated_at=datetime.utcnow(),
            top_palettes=repo.top_n(),
            total_unique_palettes=repo.total_unique_palettes(),
            total_cards_processed=repo.total_cards_processed(),
        )
        logger.debug("Snapshot created: %s", asdict(snapshot))
        return snapshot


# =============================================================================
# Singleton meta
# =============================================================================
class _SingletonMeta(type):
    """Basic thread-safe Singleton metaclass."""

    _instances: Dict[type, "PaletteMetricEngine"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:  # Double-checked locking
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# =============================================================================
# PaletteMetricEngine – Main service
# =============================================================================
class PaletteMetricEngine(metaclass=_SingletonMeta):
    """
    Central analytics engine that:
      1. Listens to EventBus for PrismCard events
      2. Updates repository with palette usage data
      3. Periodically emits PaletteSnapshot events
    """

    _PUBLISH_INTERVAL = timedelta(seconds=10)  # Tunable in config

    def __init__(self, bus: EventBus | None = None):
        self._repo = PaletteMetricRepository()
        self._bus = bus or EventBus  # Default to global bus
        self._last_publish_at = datetime.utcnow()
        self._running = False
        self._thread: Optional[threading.Thread] = None

        self._subscribe_to_events()

    # ---------- Public API --------------------------------------------------
    def start(self) -> None:
        """Start background publishing loop."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._publisher_loop,
            name="PaletteMetricPublisher",
            daemon=True,
        )
        self._thread.start()
        logger.info("PaletteMetricEngine started")

    def stop(self) -> None:
        """Stop background loop and wait for thread to finish."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=self._PUBLISH_INTERVAL.total_seconds())
            self._thread = None
        logger.info("PaletteMetricEngine stopped")

    # ---------- Event subscription -----------------------------------------
    def _subscribe_to_events(self) -> None:
        self._bus.subscribe(Event.PRISM_CARD_SAVED, self._on_card_saved)
        # We ignore deletions; could decrease metrics if needed
        logger.debug("PaletteMetricEngine subscribed to card events")

    # ---------- Event handlers ---------------------------------------------
    def _on_card_saved(self, event: Event, **payload) -> None:
        """
        Handler for PRISM_CARD_SAVED events.

        Expected payload:
            card_id: str
            user_id: str
            palette: List[str]  # list of hex colors
        """
        try:
            card_id: str = payload["card_id"]
            user_id: str = payload["user_id"]
            colors: List[str] = payload["palette"]
        except KeyError as exc:  # pragma: no cover
            logger.warning("Malformed payload for %s: %s", event, payload)
            return

        palette_hash = self._hash_palette(colors)

        self._repo.increment_usage(
            palette_hash=palette_hash,
            colors=colors,
            user_id=user_id,
        )
        logger.debug(
            "Card %s by user %s processed for palette %s",
            card_id,
            user_id,
            palette_hash,
        )

        # Decide whether we should publish a snapshot immediately
        now = datetime.utcnow()
        if now - self._last_publish_at >= self._PUBLISH_INTERVAL:
            self._publish_snapshot()

    # ---------- Background loop --------------------------------------------
    def _publisher_loop(self) -> None:  # pragma: no cover – realtime loop
        while self._running:
            time.sleep(self._PUBLISH_INTERVAL.total_seconds())
            self._publish_snapshot()

    def _publish_snapshot(self) -> None:
        snapshot = MetricSnapshotFactory.create(self._repo)
        self._bus.publish(Event("PALETTE_SNAPSHOT_GENERATED"), snapshot=snapshot)
        self._last_publish_at = datetime.utcnow()
        logger.info(
            "Palette snapshot published (%d unique, %d cards)",
            snapshot.total_unique_palettes,
            snapshot.total_cards_processed,
        )

    # ---------- Helpers -----------------------------------------------------
    @staticmethod
    def _hash_palette(colors: Iterable[str]) -> str:
        """
        Generate a deterministic hash for a palette.  The algorithm is designed
        to be stable across platforms, while being fast enough for realtime use.
        """
        import hashlib

        normalized = ",".join(sorted(c.lower() for c in colors))
        return hashlib.md5(normalized.encode("utf-8"), usedforsecurity=False).hexdigest()


# =============================================================================
# Module-level convenience function
# =============================================================================
_engine_instance: Optional[PaletteMetricEngine] = None
_engine_lock = threading.Lock()


def get_palette_metric_engine() -> PaletteMetricEngine:
    """
    Lazily create and return the singleton PaletteMetricEngine.
    Intended to be used by application bootstrap code.
    """
    global _engine_instance
    if _engine_instance is None:
        with _engine_lock:
            if _engine_instance is None:
                _engine_instance = PaletteMetricEngine()
    return _engine_instance
```