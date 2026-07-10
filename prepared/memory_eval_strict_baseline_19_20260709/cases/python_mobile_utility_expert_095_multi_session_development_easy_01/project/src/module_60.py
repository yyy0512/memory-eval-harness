from __future__ import annotations

import json
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean
from typing import Callable, Dict, Generator, Iterable, List, Optional, Tuple, TypeVar
from uuid import uuid4
from dataclasses import dataclass, field

T = TypeVar("T")
RGBTuple = Tuple[int, int, int]  # (R, G, B)


# -----------------------------------------------------------------------------
# Domain Layer
# -----------------------------------------------------------------------------
@dataclass(frozen=True)
class PrismCard:
    """
    A domain entity representing a single creative capture inside PrismPocket.

    Attributes
    ----------
    id : str
        Unique identifier for the card.
    content_type : str
        Category of content (e.g. "text", "photo", "voice", "sketch").
    colors : List[str]
        List of HEX colors (e.g. "#FFAABB") extracted from the card.
    location : Optional[Tuple[float, float]]
        GPS coordinates in (latitude, longitude) if available.
    created_at : float
        Unix timestamp in seconds.
    """
    id: str
    content_type: str
    colors: List[str]
    location: Optional[Tuple[float, float]]
    created_at: float = field(default_factory=lambda: time.time())


@dataclass(frozen=True)
class PaletteMetric:
    """
    Immutable analytics snapshot for a collection of PrismCards.
    """
    timestamp: float
    most_used_colors: List[str]
    mood_score: float
    hotspot_locations: List[Tuple[float, float]]


# -----------------------------------------------------------------------------
# Infrastructure Layer – Observer Bus
# -----------------------------------------------------------------------------
class ObserverBus:
    """
    A lightweight, thread-safe pub/sub message bus.

    Components register callbacks for specific topics and
    publishers emit events without needing direct references
    to subscribers, enabling loose coupling across layers.
    """

    _instance: "ObserverBus" = None
    _lock = threading.Lock()

    def __new__(cls) -> "ObserverBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)  # type: ignore
                cls._instance._topics: Dict[str, List[Callable[[T], None]]] = defaultdict(list)
                cls._instance._topics_lock = threading.Lock()
            return cls._instance

    # Public API ----------------------------------------------------------------
    def subscribe(self, topic: str, callback: Callable[[T], None]) -> None:
        """
        Subscribe to a topic. Callback will be invoked for every published event.
        """
        with self._topics_lock:
            self._topics[topic].append(callback)

    def unsubscribe(self, topic: str, callback: Callable[[T], None]) -> None:
        """
        Remove an existing subscription; no error if not registered.
        """
        with self._topics_lock:
            if topic in self._topics and callback in self._topics[topic]:
                self._topics[topic].remove(callback)

    def publish(self, topic: str, payload: T) -> None:
        """
        Publish an event for a given topic. This is non-blocking for the publisher:
        each subscriber runs in its own daemon thread.
        """
        with self._topics_lock:
            subscribers = list(self._topics.get(topic, []))  # snapshot to avoid races
        for callback in subscribers:
            threading.Thread(target=callback, args=(payload,), daemon=True).start()


# -----------------------------------------------------------------------------
# Analytics Layer
# -----------------------------------------------------------------------------
class PaletteMetricAggregator:
    """
    Observes PrismCard events and maintains rolling analytics on color usage,
    mood score, and geolocation hotspots.
    """

    _singleton: "PaletteMetricAggregator" = None
    _singleton_lock = threading.Lock()

    AGGREGATION_WINDOW_SECONDS = 60 * 5  # 5-minute sliding window
    BUS_TOPIC_NEW_CARD = "domain.prism_card.created"
    BUS_TOPIC_METRIC_COMPUTED = "analytics.palette_metric.updated"

    def __new__(cls, *args, **kwargs) -> "PaletteMetricAggregator":
        with cls._singleton_lock:
            if cls._singleton is None:
                cls._singleton = super().__new__(cls)
                cls._singleton._init_internal_state()
            return cls._singleton

    # Private helpers ----------------------------------------------------------
    def _init_internal_state(self) -> None:
        self._cards: List[PrismCard] = []
        self._cards_lock = threading.Lock()
        self._output_path = Path.home() / ".prism_pocket" / "palette_metrics.json"
        self._output_path.parent.mkdir(parents=True, exist_ok=True)

        bus = ObserverBus()
        bus.subscribe(self.BUS_TOPIC_NEW_CARD, self._on_new_card)

        # Kick-off housekeeping thread
        threading.Thread(target=self._periodic_cleanup, daemon=True).start()

    def _on_new_card(self, card: PrismCard) -> None:
        """
        Callback when a new PrismCard is created. Adds the card to the aggregation
        window and recomputes metrics.
        """
        with self._cards_lock:
            self._cards.append(card)
        self._emit_metrics()

    def _periodic_cleanup(self) -> None:
        """
        Repeatedly evicts cards that fall outside the aggregation window.
        """
        while True:
            time.sleep(30)  # run every 30s
            cutoff = time.time() - self.AGGREGATION_WINDOW_SECONDS
            with self._cards_lock:
                original_len = len(self._cards)
                self._cards = [c for c in self._cards if c.created_at >= cutoff]
                if len(self._cards) != original_len:
                    self._emit_metrics()

    # Metrics computation ------------------------------------------------------
    def _emit_metrics(self) -> None:
        """
        Compute current metrics and publish them. Persist to disk for on-device
        widgets and offline dashboards.
        """
        snapshot = self._compute_metrics()
        bus = ObserverBus()
        bus.publish(self.BUS_TOPIC_METRIC_COMPUTED, snapshot)
        self._persist(snapshot)

    def _compute_metrics(self) -> PaletteMetric:
        """
        Heavy-weight, synchronous CPU work to crunch numbers. Called while
        holding no locks to minimize blocking.
        """
        with self._cards_lock:
            cards_snapshot = list(self._cards)

        color_counter: Counter[str] = Counter()
        brightness_values: List[float] = []
        locations: List[Tuple[float, float]] = []

        for card in cards_snapshot:
            color_counter.update(card.colors)
            brightness_values.extend(_hex_brightness(c) for c in card.colors)
            if card.location:
                locations.append(card.location)

        most_common_colors = [col for col, _ in color_counter.most_common(5)]
        mood_score = round(mean(brightness_values), 3) if brightness_values else 0.0
        hotspot_locations = _cluster_locations(locations, threshold_km=1.0)

        return PaletteMetric(
            timestamp=time.time(),
            most_used_colors=most_common_colors,
            mood_score=mood_score,
            hotspot_locations=hotspot_locations,
        )

    # Persistence --------------------------------------------------------------
    def _persist(self, metric: PaletteMetric) -> None:
        """
        Write the latest metric snapshot to a JSON file. Failures are non-fatal
        and logged for crash reporting analysis.
        """
        try:
            data = {
                "timestamp": metric.timestamp,
                "most_used_colors": metric.most_used_colors,
                "mood_score": metric.mood_score,
                "hotspot_locations": metric.hotspot_locations,
            }
            with self._output_path.open("w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as exc:  # pragma: no cover
            # In production we'd hook into Crashlytics, Sentry, etc.
            print(f"[PaletteMetricAggregator] Failed to persist metrics: {exc}")


# -----------------------------------------------------------------------------
# Utility Functions
# -----------------------------------------------------------------------------
def _hex_brightness(hex_color: str) -> float:
    """
    Approximate perceived brightness from a HEX color string in the range [0, 1].
    Uses the ITU-R BT.709 formula.
    """
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return 0.5  # Default neutral brightness
    r, g, b = tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0


def _cluster_locations(
    points: Iterable[Tuple[float, float]], *, threshold_km: float
) -> List[Tuple[float, float]]:
    """
    Very naive clustering: groups points that are within `threshold_km`
    of each other into the same cluster and returns cluster centroids.
    """
    points = list(points)
    if not points:
        return []

    clusters: List[List[Tuple[float, float]]] = []

    for pt in points:
        added = False
        for cluster in clusters:
            if _haversine_km(cluster[0], pt) <= threshold_km:
                cluster.append(pt)
                added = True
                break
        if not added:
            clusters.append([pt])

    centroids = [
        (mean([p[0] for p in cluster]), mean([p[1] for p in cluster]))
        for cluster in clusters
    ]
    return centroids


def _haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """
    Great-circle distance between two points on Earth.
    """
    from math import asin, cos, radians, sin, sqrt

    lat1, lon1 = a
    lat2, lon2 = b

    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    lat1 = radians(lat1)
    lat2 = radians(lat2)

    hav = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 6371.0 * 2 * asin(sqrt(hav))


# -----------------------------------------------------------------------------
# Factory Function (Factory Pattern)
# -----------------------------------------------------------------------------
def provide_palette_metric_aggregator() -> PaletteMetricAggregator:
    """
    Factory wrapper to obtain the singleton instance. Abstracting the creation
    behind this function allows dependency injection containers or unit tests
    to swap implementations if needed.
    """
    return PaletteMetricAggregator()


# -----------------------------------------------------------------------------
# CLI / Manual Testing Harness
# -----------------------------------------------------------------------------
def _simulate_card_stream(aggregator: PaletteMetricAggregator, num_cards: int = 100) -> None:
    """
    Simulate random card creation events to validate aggregator behavior from
    the command line. This is *not* part of production but helpful for devs.
    """
    import random

    bus = ObserverBus()

    def demo_listener(metric: PaletteMetric) -> None:
        print(
            f"[METRIC] @ {time.strftime('%H:%M:%S', time.localtime(metric.timestamp))} "
            f"colors={metric.most_used_colors} mood={metric.mood_score:.2f} "
            f"hotspots={len(metric.hotspot_locations)}"
        )

    bus.subscribe(PaletteMetricAggregator.BUS_TOPIC_METRIC_COMPUTED, demo_listener)

    palette = ["#FF5733", "#33FF57", "#3357FF", "#F0F0F0", "#0F0F0F"]
    for _ in range(num_cards):
        colors = random.sample(palette, k=random.randint(1, 4))
        location = (
            (37.7749 + random.uniform(-0.01, 0.01), -122.4194 + random.uniform(-0.01, 0.01))
            if random.random() < 0.7
            else None
        )
        card = PrismCard(
            id=str(uuid4()),
            content_type=random.choice(["photo", "text", "voice", "sketch"]),
            colors=colors,
            location=location,
        )
        bus.publish(PaletteMetricAggregator.BUS_TOPIC_NEW_CARD, card)
        time.sleep(random.uniform(0.05, 0.2))


if __name__ == "__main__":
    agg = provide_palette_metric_aggregator()
    _simulate_card_stream(agg, num_cards=50)