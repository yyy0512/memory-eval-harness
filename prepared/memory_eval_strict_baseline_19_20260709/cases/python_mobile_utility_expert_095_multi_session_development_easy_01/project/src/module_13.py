```python
"""
src/module_13.py
================

Analytics engine and infrastructure for PrismPocket.

This module implements:

1. MetricCalculatorFactory – Factory Pattern provider for concrete metric
   calculators.
2. Concrete calculator implementations (palette frequency, mood score).
3. ColorAnalyticsRepository – persistence layer (Repository Pattern) that
   stores and retrieves analytics records in a lightweight SQLite DB.
4. AnalyticsEngine – domain-level Singleton that orchestrates metric
   computation, storage, and Observer notifications.

The code intentionally avoids UI-level concerns and platform-specific
details so it can be shared across iOS/Android deployments.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Protocol, Sequence

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
_handler.setFormatter(_formatter)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Domain entities (minimal local stubs to decouple from upstream packages)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Minimal representation of a PrismCard required for analytics processing.

    Attributes
    ----------
    id : str
        Unique identifier (uuid string).
    palette : Sequence[str]
        Sequence of color hex codes (e.g. '#FF8844').
    created_at : float
        Unix timestamp (UTC) of card creation.
    mood_vector : Sequence[float]
        Pre-computed sentiment vector from ML pipeline (range [-1, 1]).
    """

    id: str
    palette: Sequence[str]
    created_at: float
    mood_vector: Sequence[float]


@dataclass(frozen=True, slots=True)
class PaletteMetric:
    """
    Stored metric row describing palette usage frequency.

    Attributes
    ----------
    color : str
        Hex color code.
    hits : int
        Number of occurrences across all cards.
    last_updated : float
        Unix timestamp.
    """

    color: str
    hits: int
    last_updated: float = field(default_factory=time.time)


@dataclass(frozen=True, slots=True)
class MoodMetric:
    """
    Stored metric row capturing overall platform mood score.

    Attributes
    ----------
    score : float
        Aggregate mood score (-1.0 = very negative, 1.0 = very positive).
    sample_size : int
        Number of prism cards used in the computation.
    last_updated : float
        Unix timestamp.
    """

    score: float
    sample_size: int
    last_updated: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
# Observer protocol
# --------------------------------------------------------------------------- #


class MetricUpdateObserver(Protocol):
    """
    Observer interface to receive metric updates.
    """

    def notify_metric_update(self, metric_name: str, payload: dict) -> None: ...


# --------------------------------------------------------------------------- #
# Metric calculators
# --------------------------------------------------------------------------- #


class AbstractMetricCalculator(ABC):
    """
    Abstract base class for metric calculators.
    """

    @abstractmethod
    def calculate(self, cards: Iterable[PrismCard]) -> dict:
        """
        Calculates metric(s) for the provided PrismCards.

        Returns
        -------
        dict
            A JSON-serialisable dict representing the metric(s).
        """
        raise NotImplementedError


class PaletteFrequencyCalculator(AbstractMetricCalculator):
    """
    Counts occurrences of each color in user palettes.
    """

    def calculate(self, cards: Iterable[PrismCard]) -> dict:
        counter: Counter[str] = Counter()
        for card in cards:
            counter.update(card.palette)
        logger.debug("PaletteFrequencyCalculator counter: %s", counter)
        return {
            "type": "palette_frequency",
            "data": [
                PaletteMetric(color=c, hits=h). __dict__  # serialize dataclass
                for c, h in counter.items()
            ],
        }


class MoodScoreCalculator(AbstractMetricCalculator):
    """
    Computes the average mood across all PrismCards.
    """

    def calculate(self, cards: Iterable[PrismCard]) -> dict:
        total_score = 0.0
        sample_size = 0
        for card in cards:
            if not card.mood_vector:
                continue
            # A simple heuristic: average the vector components, then add.
            local_score = sum(card.mood_vector) / len(card.mood_vector)
            total_score += local_score
            sample_size += 1

        score = total_score / sample_size if sample_size else 0.0
        logger.debug(
            "MoodScoreCalculator: score=%s sample_size=%s", score, sample_size
        )
        return {
            "type": "mood_score",
            "data": MoodMetric(score=score, sample_size=sample_size).__dict__,
        }


# --------------------------------------------------------------------------- #
# MetricCalculatorFactory
# --------------------------------------------------------------------------- #


class MetricCalculatorFactory:
    """
    Factory for obtaining MetricCalculators by name.
    """

    _registry: Dict[str, AbstractMetricCalculator] = {
        "palette_frequency": PaletteFrequencyCalculator(),
        "mood_score": MoodScoreCalculator(),
    }

    @classmethod
    def get_calculator(cls, name: str) -> AbstractMetricCalculator:
        try:
            return cls._registry[name]
        except KeyError as exc:
            raise ValueError(f"Unknown calculator '{name}'.") from exc

    @classmethod
    def available(cls) -> List[str]:
        return list(cls._registry.keys())


# --------------------------------------------------------------------------- #
# Repository
# --------------------------------------------------------------------------- #


class ColorAnalyticsRepository:
    """
    SQLite-based repository for analytics metrics.

    The database lives under the application's user-writable dir
    (e.g., mobile sandbox or ~/.prism_pocket).
    """

    _DB_NAME = "analytics.db"
    _LOCK = threading.RLock()

    def __init__(self, base_dir: Path | None = None) -> None:
        self._base_dir = (
            base_dir or Path.home() / ".prism_pocket" / "data"
        )
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = self._base_dir / self._DB_NAME
        self._initialize()

    # --------------------------------------------------------------------- #
    # Private helpers
    # --------------------------------------------------------------------- #

    def _initialize(self) -> None:
        with self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS palette_metrics (
                    color TEXT PRIMARY KEY,
                    hits INTEGER NOT NULL,
                    last_updated REAL NOT NULL
                );
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS mood_metrics (
                    id INTEGER PRIMARY KEY CHECK (id = 0),
                    score REAL NOT NULL,
                    sample_size INTEGER NOT NULL,
                    last_updated REAL NOT NULL
                );
                """
            )
            conn.commit()
        logger.debug("Initialized analytics DB at %s", self._db_path)

    def _get_conn(self) -> sqlite3.Connection:
        # check_same_thread=False allows calls from different threads,
        # RLock ensures atomicity at Python level.
        return sqlite3.connect(
            self._db_path, detect_types=sqlite3.PARSE_DECLTYPES, check_same_thread=False
        )

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def persist_palette_metrics(self, metrics: List[PaletteMetric]) -> None:
        with self._LOCK, self._get_conn() as conn:
            cursor = conn.cursor()
            records = [
                (m.color, m.hits, m.last_updated) for m in metrics
            ]
            cursor.executemany(
                """
                INSERT INTO palette_metrics (color, hits, last_updated)
                VALUES (?, ?, ?)
                ON CONFLICT(color)
                DO UPDATE SET
                    hits = excluded.hits,
                    last_updated = excluded.last_updated;
                """,
                records,
            )
            conn.commit()
        logger.info("Persisted %d palette metrics.", len(metrics))

    def persist_mood_metric(self, metric: MoodMetric) -> None:
        with self._LOCK, self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO mood_metrics (id, score, sample_size, last_updated)
                VALUES (0, ?, ?, ?)
                ON CONFLICT(id)
                DO UPDATE SET
                    score = excluded.score,
                    sample_size = excluded.sample_size,
                    last_updated = excluded.last_updated;
                """,
                (metric.score, metric.sample_size, metric.last_updated),
            )
            conn.commit()
        logger.info("Persisted mood metric (score=%.3f).", metric.score)

    def fetch_palette_metrics(self) -> List[PaletteMetric]:
        with self._LOCK, self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT color, hits, last_updated FROM palette_metrics;"
            )
            rows = cursor.fetchall()
            return [
                PaletteMetric(*row) for row in rows
            ]

    def fetch_mood_metric(self) -> MoodMetric | None:
        with self._LOCK, self._get_conn() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT score, sample_size, last_updated FROM mood_metrics WHERE id = 0;"
            )
            row = cursor.fetchone()
            return MoodMetric(*row) if row else None


# --------------------------------------------------------------------------- #
# AnalyticsEngine (Singleton)
# --------------------------------------------------------------------------- #


class AnalyticsEngine:
    """
    Singleton service responsible for orchestrating analytics calculation,
    persistence, and Observer notifications.
    """

    _instance: "AnalyticsEngine | None" = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    # ------------------------------------------------------------------ #
    # Initialisation
    # ------------------------------------------------------------------ #

    def __init__(self, repo: ColorAnalyticsRepository | None = None) -> None:
        # avoid resetting on subsequent calls
        if getattr(self, "_initialized", False):
            return
        self._initialized = True
        self._repo = repo or ColorAnalyticsRepository()
        self._observers: List[MetricUpdateObserver] = []
        self._obs_lock = threading.RLock()
        logger.info("AnalyticsEngine initialized.")

    # ------------------------------------------------------------------ #
    # Observer management
    # ------------------------------------------------------------------ #

    def register_observer(self, obs: MetricUpdateObserver) -> None:
        with self._obs_lock:
            if obs not in self._observers:
                self._observers.append(obs)

    def unregister_observer(self, obs: MetricUpdateObserver) -> None:
        with self._obs_lock:
            if obs in self._observers:
                self._observers.remove(obs)

    def _notify(self, metric_name: str, payload: dict) -> None:
        with self._obs_lock:
            observers = list(self._observers)
        for obs in observers:
            try:
                obs.notify_metric_update(metric_name, payload)
            except Exception:  # pylint: disable=broad-except
                logger.exception(
                    "Observer %s raised during notify_metric_update.",
                    obs.__class__.__name__,
                )

    # ------------------------------------------------------------------ #
    # Core computation
    # ------------------------------------------------------------------ #

    def compute_and_persist(
        self,
        cards: Iterable[PrismCard],
        metrics: Sequence[str] | None = None,
    ) -> None:
        """
        Compute the requested metric(s) for the provided cards,
        persist them, and notify observers.

        Parameters
        ----------
        cards : Iterable[PrismCard]
            PrismCards over which to compute.
        metrics : Sequence[str] | None
            Names from MetricCalculatorFactory.available(). If None,
            compute all.
        """
        metrics = metrics or MetricCalculatorFactory.available()
        cache_cards = list(cards)  # materialize in memory

        for metric_name in metrics:
            calculator = MetricCalculatorFactory.get_calculator(metric_name)
            try:
                result = calculator.calculate(cache_cards)
                self._persist(metric_name, result["data"])
                self._notify(metric_name, result)
                logger.info("Computed metric '%s'.", metric_name)
            except Exception as exc:  # pylint: disable=broad-except
                logger.exception("Failed computing metric '%s': %s", metric_name, exc)

    # ------------------------------------------------------------------ #
    # Persistence routing
    # ------------------------------------------------------------------ #

    def _persist(self, metric_name: str, data: dict | list) -> None:
        """
        Route data to repository store based on metric name.
        """
        if metric_name == "palette_frequency":
            assert isinstance(data, list)
            self._repo.persist_palette_metrics(
                [PaletteMetric(**row) for row in data]
            )
        elif metric_name == "mood_score":
            assert isinstance(data, dict)
            self._repo.persist_mood_metric(MoodMetric(**data))
        else:
            logger.warning("No persistence route for metric '%s'.", metric_name)


# --------------------------------------------------------------------------- #
# Example stub (executed only when running module directly)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    import uuid
    import random

    # Generate mock cards
    MOCK_COLORS = ["#FF0000", "#00FF00", "#0000FF", "#FFFF00"]
    cards: List[PrismCard] = []

    for _ in range(100):
        cards.append(
            PrismCard(
                id=str(uuid.uuid4()),
                palette=random.choices(MOCK_COLORS, k=3),
                created_at=time.time(),
                mood_vector=[random.uniform(-1, 1) for _ in range(5)],
            )
        )

    # Simple observer that dumps updates
    class PrintObserver:
        def notify_metric_update(self, metric_name: str, payload: dict) -> None:
            print(f"[observer] {metric_name}: {payload}")

    engine = AnalyticsEngine()
    engine.register_observer(PrintObserver())
    engine.compute_and_persist(cards)
```