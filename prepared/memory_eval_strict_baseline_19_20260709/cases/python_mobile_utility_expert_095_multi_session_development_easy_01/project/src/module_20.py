```python
"""
module_20.py

PrismPocket – Color Trend Analytics module
==========================================

This module contains a lightweight, yet production-grade implementation of the
ColorTrendAnalyzer component that powers “creative trend” insights in
PrismPocket.  It demonstrates:

* Observer Pattern — subscribes to an in-app EventBus for newly created
  PrismCard events.
* Singleton Pattern — ensures only a single analyzer instance exists per
  process.
* Repository Pattern — abstracts persistence of computed metrics behind a
  simple interface (LocalPaletteMetricRepository).
* Resilience & best practices — thread-safety, typed data-classes, logging, and
  defensive error handling.

The analyzer keeps a rolling window of palette usage counts, periodically
persists them to disk, and broadcasts `PaletteMetricUpdated` events that other
layers (e.g. ViewModels, prompt generators) can consume.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from pathlib import Path
from types import TracebackType
from typing import Iterable, List, Dict, Optional, Tuple, Type

# --------------------------------------------------------------------------- #
# Public data models
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class PrismCard:
    """
    Domain entity stub.  In production this lives in the domain layer; it is
    replicated here only for illustrative purposes.
    """
    card_id: str
    user_id: str
    palette: List[str]  # List of HEX color strings e.g. ["#FFAA00", "#1E90FF"]
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class PaletteMetric:
    """
    Aggregated usage metric for a color palette (normalized & sorted hexes).
    """
    palette_key: str            # e.g. "#1E90FF-#FFAA00"
    usage_count: int            # absolute count in the rolling window
    last_used: datetime         # when last seen
    momentum: float = 0.0       # exponential smoothing score


# --------------------------------------------------------------------------- #
# EventBus (very simplified)
# --------------------------------------------------------------------------- #

class Event:
    """ Marker base class for all events. """
    pass


class PrismCardCreated(Event):
    def __init__(self, card: PrismCard) -> None:
        self.card = card


class PaletteMetricUpdated(Event):
    def __init__(self, metrics: List[PaletteMetric]) -> None:
        self.metrics = metrics


class EventBus:
    """
    Thread-safe publisher/subscriber. Not production-grade but sufficient to
    showcase Observer usage.
    """
    def __init__(self) -> None:
        self._subscribers: Dict[type, List] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_type: Type[Event], handler) -> None:
        with self._lock:
            self._subscribers.setdefault(event_type, []).append(handler)

    def publish(self, event: Event) -> None:
        # copy to avoid mutation during iteration
        with self._lock:
            handlers = list(self._subscribers.get(type(event), []))
        for h in handlers:
            try:
                h(event)
            except Exception:  # pragma: no cover
                logging.exception("Unhandled error in event handler %s", h)


# --------------------------------------------------------------------------- #
# Repository (local JSON storage)
# --------------------------------------------------------------------------- #

class LocalPaletteMetricRepository:
    """
    Persists PaletteMetric objects as newline-delimited JSON for crash safety.
    """
    FILE_VERSION = 1

    def __init__(self, storage_path: Path) -> None:
        self._file = storage_path.expanduser().resolve()
        self._file.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def load(self) -> Dict[str, PaletteMetric]:
        if not self._file.exists():
            return {}
        with self._lock, self._file.open("r", encoding="utf-8") as fp:
            try:
                version_line = fp.readline()
                version = int(version_line.strip() or 0)
                if version != self.FILE_VERSION:
                    logging.warning("Metric file version mismatch (%s)", version)
                    return {}
                metrics: Dict[str, PaletteMetric] = {}
                for line in fp:
                    data = json.loads(line)
                    metrics[data["palette_key"]] = PaletteMetric(
                        palette_key=data["palette_key"],
                        usage_count=data["usage_count"],
                        last_used=datetime.fromisoformat(data["last_used"]),
                        momentum=data.get("momentum", 0.0),
                    )
                return metrics
            except Exception:
                logging.exception("Failed to load palette metrics.")
                return {}

    def save(self, metrics: Iterable[PaletteMetric]) -> None:
        tmp_path = self._file.with_suffix(".tmp")
        with self._lock, tmp_path.open("w", encoding="utf-8") as fp:
            fp.write(f"{self.FILE_VERSION}\n")
            for m in metrics:
                fp.write(json.dumps(asdict(m), default=str) + "\n")
        tmp_path.replace(self._file)


# --------------------------------------------------------------------------- #
# ColorTrendAnalyzer (Singleton + Observer)
# --------------------------------------------------------------------------- #

class _SingletonMeta(type):
    _instances: Dict[type, "ColorTrendAnalyzer"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class ColorTrendAnalyzer(metaclass=_SingletonMeta):
    """
    Consumes new PrismCards, updates rolling color palette metrics, and
    publishes PaletteMetricUpdated events.

    Design goals:
    1. Debounce heavy analytics to batch work.
    2. Thread-safe public API.
    3. Crash-safe persistence every N seconds.
    """

    ROLLING_WINDOW = timedelta(days=3)
    SMOOTHING_ALPHA = 0.2          # exponential moving average factor
    PERSIST_INTERVAL = 30          # seconds

    def __init__(
        self,
        event_bus: EventBus,
        repository: LocalPaletteMetricRepository,
        batch_size: int = 32,
    ) -> None:
        self._bus = event_bus
        self._repo = repository
        self._batch_size = batch_size

        # Internal state
        self._metrics: Dict[str, PaletteMetric] = self._repo.load()
        self._recent_cards: "deque[PrismCard]" = deque(maxlen=batch_size)
        self._card_lock = threading.RLock()
        self._stop_event = threading.Event()

        # Subscribe to new card events
        self._bus.subscribe(PrismCardCreated, self._on_card_created)

        # Background worker
        self._worker = threading.Thread(
            target=self._loop, daemon=True, name="ColorTrendAnalyzerWorker"
        )
        self._worker.start()
        logging.debug("ColorTrendAnalyzer initialized.")

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def shutdown(self, timeout: float = 5.0) -> None:
        """
        Flush metrics and shut down worker thread.
        """
        self._stop_event.set()
        self._worker.join(timeout=timeout)
        self._persist_metrics()

    # --------------------------------------------------------------------- #
    # EventBus handlers
    # --------------------------------------------------------------------- #

    def _on_card_created(self, event: PrismCardCreated) -> None:
        with self._card_lock:
            self._recent_cards.append(event.card)
        logging.debug("Received PrismCardCreated (%s)", event.card.card_id)

    # --------------------------------------------------------------------- #
    # Internal worker loop
    # --------------------------------------------------------------------- #

    def _loop(self) -> None:
        next_persist: float = time.monotonic() + self.PERSIST_INTERVAL
        while not self._stop_event.is_set():
            # Process batches every second
            time.sleep(1)
            self._consume_recent_cards()

            if time.monotonic() >= next_persist:
                self._persist_metrics()
                next_persist = time.monotonic() + self.PERSIST_INTERVAL

    def _consume_recent_cards(self) -> None:
        with self._card_lock:
            if not self._recent_cards:
                return
            cards: List[PrismCard] = list(self._recent_cards)
            self._recent_cards.clear()

        for card in cards:
            key = self._normalize_palette(card.palette)
            metric = self._metrics.get(key)
            if metric is None:
                metric = PaletteMetric(
                    palette_key=key,
                    usage_count=0,
                    last_used=card.created_at,
                    momentum=1.0,
                )
                self._metrics[key] = metric

            # Decay existing momentum
            metric.momentum = (
                self.SMOOTHING_ALPHA * 1
                + (1 - self.SMOOTHING_ALPHA) * metric.momentum
            )
            metric.usage_count += 1
            metric.last_used = card.created_at
            logging.debug("Updated metric %s -> %s", key, metric.usage_count)

        # Broadcast updated metrics
        self._publish_metrics()

    # --------------------------------------------------------------------- #
    # Helpers
    # --------------------------------------------------------------------- #

    @staticmethod
    def _normalize_palette(hexes: List[str]) -> str:
        """
        Deduplicate, upper-case, sort alphabetically, join with dash.
        """
        try:
            normalized = "-".join(sorted({h.upper() for h in hexes}))
            return normalized
        except Exception as exc:
            logging.exception("Failed to normalize palette %s: %s", hexes, exc)
            return "-".join(hexes)

    def _publish_metrics(self) -> None:
        # Filter metrics within the rolling window
        cutoff = datetime.utcnow() - self.ROLLING_WINDOW
        valid_metrics: List[PaletteMetric] = [
            m for m in self._metrics.values() if m.last_used >= cutoff
        ]
        if valid_metrics:
            self._bus.publish(PaletteMetricUpdated(valid_metrics))

    def _persist_metrics(self) -> None:
        try:
            self._repo.save(self._metrics.values())
            logging.debug("Persisted %d palette metrics.", len(self._metrics))
        except Exception:  # pragma: no cover
            logging.exception("Failed to persist palette metrics.")


# --------------------------------------------------------------------------- #
# Convenience factory
# --------------------------------------------------------------------------- #

def build_color_trend_analyzer(
    storage_dir: Optional[Path] = None,
    event_bus: Optional[EventBus] = None,
) -> ColorTrendAnalyzer:
    """
    Helper to create and wire up a ColorTrendAnalyzer with sensible defaults.
    """
    bus = event_bus or EventBus()
    storage = (storage_dir or Path("~/.prismpocket")).joinpath("palette_metrics.ndjson")
    repo = LocalPaletteMetricRepository(storage)

    analyzer = ColorTrendAnalyzer(bus, repo)
    return analyzer


# --------------------------------------------------------------------------- #
# Module test (run `python -m module_20` to see it working standalone)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(threadName)s] %(levelname)s %(message)s",
    )

    bus = EventBus()
    analyzer = build_color_trend_analyzer(event_bus=bus)

    # Simulate incoming cards
    bus.publish(
        PrismCardCreated(
            PrismCard(
                card_id="c1",
                user_id="u1",
                palette=["#ff0000", "#00FF00", "#0000FF"],
            )
        )
    )
    bus.publish(
        PrismCardCreated(
            PrismCard(
                card_id="c2",
                user_id="u2",
                palette=["#ff0000", "#00FF00"],  # same palette minus one
            )
        )
    )

    # Allow background processing
    time.sleep(2)
    analyzer.shutdown()
```