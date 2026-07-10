```python
"""
PrismPocket – Analytics Core
src/module_2.py
-------------------------------------------------
This module implements the real-time analytics engine that powers PrismPocket’s
creative insights (trending palettes, hotspot locations, global mood score).
It follows the Clean-Architecture concentric-ring principle: the analytics
engine sits in the ‘domain/service’ layer and is therefore UI-agnostic and free
of platform-specific dependencies.

Key patterns employed:
  • Observer   – TrendAnalyticsService subscribes to the global EventBus.
  • Singleton  – EventBus is globally unique across the runtime.
  • Factory    – AnalyticsServiceFactory builds concrete analytics services
                 based on supplied configuration.
  • Repository – LocalAnalyticsRepository persists snapshots for offline use.

This file purposefully contains no UI or OS-specific references; adapters in
outer layers take care of forwarding native events (camera, GPS, etc.) to the
EventBus and rendering the resulting analytics in the presentation layer.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from enum import Enum, auto
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Iterable, List, Optional, Set, Tuple

# --------------------------------------------------------------------------- #
# Configuration & Logging
# --------------------------------------------------------------------------- #

LOGGER_NAME = "prism_pocket.analytics"
logger = logging.getLogger(LOGGER_NAME)
if not logger.handlers:
    # Basic console handler. In production, the app’s bootstrapper configures
    # log routing; this prevents duplicate handlers during hot-reload/dev loops.
    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)-8s [%(name)s] %(message)s"
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Domain Entities
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class GeoLocation:
    """A lightweight geo-location value object."""
    lat: float
    lon: float

    def grid_hash(self, precision: float = 0.1) -> Tuple[int, int]:
        """
        Coarse grid-hash used to bucket locations for hotspot analytics.

        Args:
            precision: Size of grid bucket in degrees; lower = finer grid.

        Returns:
            Tuple representing the grid cell (lat_idx, lon_idx).
        """
        return (int(self.lat / precision), int(self.lon / precision))


@dataclass(frozen=True)
class PrismCard:
    """
    Core domain entity representing a user artifact in PrismPocket.
    Only the subset required for analytics is modeled here; full
    entity lives in the domain layer.
    """
    card_id: str
    user_id: str
    primary_colors: Tuple[str, ...]  # Hex strings, e.g. (“#FF0000”, “#00FF00”)
    mood: float                     # Range: ‑1.0 (negative) … 1.0 (positive)
    captured_at: datetime
    location: Optional[GeoLocation] = None

    def age(self, now: Optional[datetime] = None) -> timedelta:
        now = now or datetime.utcnow()
        return now - self.captured_at


# --------------------------------------------------------------------------- #
# Event Bus (Observer pattern, Singleton)
# --------------------------------------------------------------------------- #

class _SingletonMeta(type):
    """Thread-safe Singleton meta-class."""
    _instances: Dict["_SingletonMeta", Any] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class AnalyticsEvent(Enum):
    """Enumerates events relevant for analytics."""
    CARD_CREATED = auto()
    CARD_DELETED = auto()  # Future use
    CARD_UPDATED = auto()  # Future use


class EventBus(metaclass=_SingletonMeta):
    """
    A minimal, thread-safe publish/subscribe event bus. Observers receive
    strongly-typed analytics events plus payload dictionaries.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[AnalyticsEvent, Set[Callable[[Dict[str, Any]], None]]] = {}
        self._lock = threading.Lock()

    def subscribe(
        self,
        event: AnalyticsEvent,
        callback: Callable[[Dict[str, Any]], None],
    ) -> None:
        with self._lock:
            self._subscribers.setdefault(event, set()).add(callback)
            logger.debug("Subscribed '%s' to event %s. Total=%d",
                         callback.__qualname__, event, len(self._subscribers[event]))

    def unsubscribe(
        self,
        event: AnalyticsEvent,
        callback: Callable[[Dict[str, Any]], None],
    ) -> None:
        with self._lock:
            self._subscribers.get(event, set()).discard(callback)
            logger.debug("Unsubscribed '%s' from event %s",
                         callback.__qualname__, event)

    def publish(self, event: AnalyticsEvent, payload: Dict[str, Any]) -> None:
        """Dispatch an event to all current subscribers asynchronously."""
        with self._lock:
            callbacks = list(self._subscribers.get(event, set()))
        logger.debug("Publishing event %s to %d subscribers", event, len(callbacks))

        for cb in callbacks:
            # Dispatch on background thread to decouple publisher latency.
            threading.Thread(
                target=self._safe_invoke, args=(cb, payload), daemon=True
            ).start()

    @staticmethod
    def _safe_invoke(cb: Callable[[Dict[str, Any]], None], payload: Dict[str, Any]) -> None:
        """Invoke subscriber, swallowing uncaught errors to protect bus."""
        try:
            cb(payload)
        except Exception as exc:  # noqa: broad-except
            logger.error("Error in subscriber '%s': %s", cb.__qualname__, exc, exc_info=True)


# --------------------------------------------------------------------------- #
# Analytics Repository
# --------------------------------------------------------------------------- #

class LocalAnalyticsRepository:
    """
    A thin repository that persists analytics snapshots to local JSON files
    on the device’s file system. The outer data layer decides how/when these
    files are synced to the cloud workspace.
    """

    def __init__(self, base_dir: str | Path):
        self.base_dir = Path(base_dir).expanduser().resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        logger.debug("Analytics repository initialized at %s", self.base_dir)

    def save_snapshot(self, snapshot: Dict[str, Any]) -> None:
        filename = f"analytics_snapshot_{int(time.time() * 1000)}.json"
        path = self.base_dir / filename
        try:
            with path.open("w", encoding="utf-8") as fp:
                json.dump(snapshot, fp, ensure_ascii=False, indent=2, default=str)
            logger.info("Saved analytics snapshot: %s", path)
        except OSError as exc:
            logger.error("Unable to write snapshot to %s: %s", path, exc)

    def latest_snapshots(self, limit: int = 5) -> List[Dict[str, Any]]:
        files = sorted(
            (p for p in self.base_dir.glob("analytics_snapshot_*.json") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:limit]
        snapshots: List[Dict[str, Any]] = []
        for f in files:
            try:
                snapshots.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception as exc:  # noqa: broad-except
                logger.warning("Failed reading %s: %s", f, exc)
        return snapshots


# --------------------------------------------------------------------------- #
# Analytics Engine
# --------------------------------------------------------------------------- #

class TrendAnalyticsService:
    """
    Consumes PrismCard events and maintains running aggregates for:
      • Top color palettes (hex values)
      • Geographic hotspots (grid-hashed lat/lon buckets)
      • Global mood score (rolling average)
    Aggregates update in near-real-time and can be snapshotted on demand.
    """

    WINDOW_SIZE = 500               # Max events retained in sliding window
    SNAPSHOT_INTERVAL_SEC = 60 * 5  # Persist every 5 minutes

    def __init__(self, repository: LocalAnalyticsRepository) -> None:
        self._repo = repository
        self._cards: Deque[PrismCard] = deque(maxlen=self.WINDOW_SIZE)
        self._lock = threading.Lock()
        self._last_snapshot_ts = 0.0

        # Subscribe to event stream
        bus = EventBus()
        bus.subscribe(AnalyticsEvent.CARD_CREATED, self._on_card_created)

        logger.info("TrendAnalyticsService ready (window=%d)", self.WINDOW_SIZE)

    # --------------------------------------------------------------------- #
    # Event handling
    # --------------------------------------------------------------------- #

    def _on_card_created(self, payload: Dict[str, Any]) -> None:
        """
        Callback for CARD_CREATED events. Expects payload:
            { "card": <PrismCard as dict|object> }
        """
        try:
            card = self._parse_card_payload(payload.get("card"))
        except ValueError as exc:
            logger.warning("Discarding CARD_CREATED payload: %s", exc)
            return

        with self._lock:
            self._cards.append(card)
            logger.debug("Ingested card %s. Window size=%d", card.card_id, len(self._cards))

        self._maybe_snapshot()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def current_metrics(self) -> Dict[str, Any]:
        """
        Compute and return the latest analytics metrics.

        Returns:
            Dictionary JSON-serializable summary of analytics state.
        """
        with self._lock:
            cards_snapshot: List[PrismCard] = list(self._cards)

        now = datetime.utcnow()
        palette_counter: Counter[str] = Counter()
        location_counter: Counter[Tuple[int, int]] = Counter()
        mood_total: float = 0.0

        for card in cards_snapshot:
            palette_counter.update(card.primary_colors)
            if card.location:
                location_counter[card.location.grid_hash()] += 1
            mood_total += card.mood

        num_cards = len(cards_snapshot)
        avg_mood = round(mood_total / num_cards, 3) if num_cards else 0.0

        metrics = {
            "generated_at": now.isoformat() + "Z",
            "card_count": num_cards,
            "top_palettes": palette_counter.most_common(5),
            "hotspots": location_counter.most_common(5),
            "average_mood": avg_mood,
        }
        logger.debug("Computed metrics: %s", metrics)
        return metrics

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    def _parse_card_payload(self, payload: Any) -> PrismCard:
        """
        Validate and convert inbound card payload to a PrismCard instance.
        Accepts either a PrismCard object or a dict with correct keys.
        """
        if isinstance(payload, PrismCard):
            return payload

        if not isinstance(payload, dict):
            raise ValueError("Payload is not a dict nor PrismCard")

        required = {"card_id", "user_id", "primary_colors", "mood", "captured_at"}
        missing = required - set(payload.keys())
        if missing:
            raise ValueError(f"Missing fields: {missing}")

        try:
            card = PrismCard(
                card_id=str(payload["card_id"]),
                user_id=str(payload["user_id"]),
                primary_colors=tuple(payload["primary_colors"]),
                mood=float(payload["mood"]),
                captured_at=self._parse_dt(payload["captured_at"]),
                location=GeoLocation(**payload["location"])
                if payload.get("location")
                else None,
            )
            return card
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid card payload: {exc}") from exc

    @staticmethod
    def _parse_dt(value: Any) -> datetime:
        if isinstance(value, datetime):
            return value
        if isinstance(value, (float, int)):
            return datetime.utcfromtimestamp(value)
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                pass
        raise ValueError(f"Unsupported datetime value: {value!r}")

    def _maybe_snapshot(self) -> None:
        """
        Persist metrics periodically to ensure continuity across app restarts
        and to provide data for offline mode.
        """
        now_ts = time.time()
        if now_ts - self._last_snapshot_ts < self.SNAPSHOT_INTERVAL_SEC:
            return

        snapshot = self.current_metrics()
        self._repo.save_snapshot(snapshot)
        self._last_snapshot_ts = now_ts
        logger.debug("Snapshot persisted at %s", snapshot["generated_at"])


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #

class AnalyticsServiceFactory:
    """
    Responsible for creating configured instances of TrendAnalyticsService.
    """

    @staticmethod
    def create_default() -> TrendAnalyticsService:
        cache_dir = Path(os.getenv("PRISM_CACHE_DIR", "~/.prism_pocket/cache")).expanduser()
        repository = LocalAnalyticsRepository(cache_dir / "analytics")
        return TrendAnalyticsService(repository)


# --------------------------------------------------------------------------- #
# Example usage (executed only when run as script, not when imported)
# --------------------------------------------------------------------------- #

def _demo() -> None:
    """
    Spawn a local analytics service, publish random demo events, and
    print resulting metrics. Intended for quick manual testing.
    """
    service = AnalyticsServiceFactory.create_default()

    bus = EventBus()

    logger.info("Generating demo events …")
    colors = ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF"]
    for idx in range(60):
        card_payload = {
            "card_id": f"demo_{idx}",
            "user_id": "tester",
            "primary_colors": [colors[idx % len(colors)]],
            "mood": (-1.0 + 2 * ((idx % 10) / 10)),  # cyclical mood
            "captured_at": datetime.utcnow().isoformat() + "Z",
            "location": {"lat": 37.77 + (idx % 5) * 0.01, "lon": -122.4},
        }
        bus.publish(AnalyticsEvent.CARD_CREATED, {"card": card_payload})
        time.sleep(0.05)

    # Allow background threads to finish
    time.sleep(1)

    metrics = service.current_metrics()
    logger.info("Final metrics:\n%s", json.dumps(metrics, indent=2))


if __name__ == "__main__":
    _demo()
```