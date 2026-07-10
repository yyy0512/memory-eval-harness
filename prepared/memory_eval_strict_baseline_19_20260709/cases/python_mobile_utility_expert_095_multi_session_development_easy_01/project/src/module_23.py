"""
src/module_23.py
PrismPocket (mobile_utility) – Analytics Aggregator

This module implements the in-process color-analytics engine that powers
PrismPocket’s “trending palettes” insight surface.  It demonstrates several
architectural patterns used across the project:

• Singleton – A single AnalyticsEngine coordinates all metric updates.
• Observer  – An ObserverBus streams PrismCardEvent mutations to interested
              subscribers (e.g., ViewModels, cloud sync adapters).
• Factory   – MetricFactory wires up individual metric calculators so that the
              engine can remain open for extension, closed for modification.
• Clean, testable logic – Pure functions for statistical calculations make
              downstream unit-testing straightforward.

The engine is purposely decoupled from any GUI / platform layer; it can run in
a headless process, a background thread, or be embedded in unit-tests.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import threading
import time
from collections import Counter, defaultdict
from types import TracebackType
from typing import (
    Any,
    Callable,
    Coroutine,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Protocol,
    Sequence,
    Set,
    Tuple,
    Type,
    Union,
)

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.analytics")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] (%(name)s): %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_handler.setFormatter(_formatter)
logger.addHandler(_handler)
logger.propagate = False

# --------------------------------------------------------------------------- #
# Events & Domain DTOs
# --------------------------------------------------------------------------- #

@dataclasses.dataclass(frozen=True)
class PrismCardEvent:
    """
    Event emitted when a PrismCard is created or mutated.

    Attributes
    ----------
    card_id: str
        UUID of the PrismCard.
    colors: Sequence[str]
        Hex colors (#RRGGBB) detected or selected on the card.
    mood_score: float
        Sentiment analysis / ML-generated score in range [-1, +1].
    user_id: str
        Originating user for multi-account analytics segmentation.
    ts: float
        Epoch seconds when the event was recorded.
    """

    card_id: str
    colors: Sequence[str]
    mood_score: float
    user_id: str
    ts: float = dataclasses.field(default_factory=time.time)


@dataclasses.dataclass(frozen=True)
class AnalyticsSnapshot:
    """
    Immutable POJO representing the latest analytics state.

    Subscribers will receive a deep-copied snapshot so they can use it without
    worrying about concurrent mutation by the engine.
    """

    palette_frequency: Dict[str, int]  # hex_color -> usage count
    top_colors: List[Tuple[str, int]]  # (hex_color, usage) sorted desc
    average_mood: float
    last_updated: float


# --------------------------------------------------------------------------- #
# Observer Bus
# --------------------------------------------------------------------------- #

ObserverCallback = Callable[[Any], None]


class ObserverBus:
    """
    Extremely light-weight, in-process Observer / PubSub bus.

    The bus is thread-safe, making it suitable for UI and background contexts.
    """

    _instance: "ObserverBus" = None
    _lock = threading.Lock()

    def __new__(cls) -> "ObserverBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[str, Set[ObserverCallback]] = defaultdict(
                    set
                )
            return cls._instance

    # Public API ----------------------------------------------------------------

    def subscribe(self, topic: str, callback: ObserverCallback) -> None:
        """
        Subscribe to a topic. Callback will be called synchronously when an
        event is published on that topic.
        """
        if not callable(callback):
            raise TypeError("callback must be callable")
        self._subscribers[topic].add(callback)
        logger.debug("Subscribed '%s' to topic '%s'", callback, topic)

    def unsubscribe(self, topic: str, callback: ObserverCallback) -> None:
        """
        Remove the callback from the subscriber list for the given topic.
        """
        self._subscribers[topic].discard(callback)
        logger.debug("Unsubscribed '%s' from topic '%s'", callback, topic)

    def publish(self, topic: str, event: Any) -> None:
        """
        Publish an event synchronously to all subscribers of the topic.
        """
        for cb in list(self._subscribers[topic]):  # copy to avoid mutation issues
            try:
                cb(event)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Observer callback failed; topic=%s, cb=%s", topic, cb)


# --------------------------------------------------------------------------- #
# Metric Calculator Protocols & Implementations (Factory Pattern)
# --------------------------------------------------------------------------- #

class MetricCalculator(Protocol):
    """
    Strategy interface for any metric calculator.

    Implementations must be pure functions that accept the internal state
    *mutably* so that no unnecessary copies are created during hot paths.
    """

    def update(self, event: PrismCardEvent, state: "MutableAnalyticsState") -> None:
        ...

    def finalize(self, state: "MutableAnalyticsState") -> None:
        """
        Perform any post-processing on the shared state before a snapshot is
        taken. Called after each processing batch.
        """


@dataclasses.dataclass
class MutableAnalyticsState:
    """
    Internal, *mutable* representation of analytics state. Not exposed outside
    the engine.
    """

    palette_counter: Counter = dataclasses.field(default_factory=Counter)
    mood_sum: float = 0.0
    mood_count: int = 0

    # Derived fields (populated in finalize)
    top_colors: List[Tuple[str, int]] = dataclasses.field(default_factory=list)

    # Always store when last mutation happened
    last_updated: float = dataclasses.field(default_factory=time.time)


class PaletteFrequencyCalculator:
    """
    tallies how often each hex color shows up in PrismCards.
    """

    __slots__ = ()

    def update(self, event: PrismCardEvent, state: MutableAnalyticsState) -> None:
        state.palette_counter.update(event.colors)
        logger.debug("Palette counter updated with %s", event.colors)

    def finalize(self, state: MutableAnalyticsState) -> None:
        state.top_colors = state.palette_counter.most_common(8)
        logger.debug("Top colors updated: %s", state.top_colors)


class MoodScoreCalculator:
    """
    Calculates rolling average mood score.
    """

    __slots__ = ()

    def update(self, event: PrismCardEvent, state: MutableAnalyticsState) -> None:
        state.mood_sum += event.mood_score
        state.mood_count += 1
        logger.debug(
            "Mood updated: sum=%s, count=%s", state.mood_sum, state.mood_count
        )

    def finalize(self, state: MutableAnalyticsState) -> None:
        # No expensive operations – nothing to do here.
        pass


class MetricFactory:
    """
    Responsible for creating the set of metric calculators to be used by the
    AnalyticsEngine.
    """

    @staticmethod
    def create_default_calculators() -> List[MetricCalculator]:
        return [
            PaletteFrequencyCalculator(),
            MoodScoreCalculator(),
        ]


# --------------------------------------------------------------------------- #
# Analytics Engine (Singleton + Observer)
# --------------------------------------------------------------------------- #

class AnalyticsEngine:
    """
    Consumes PrismCardEvents and produces live AnalyticsSnapshot objects.

    Subscribers receive snapshots through the ObserverBus on the
    TOPIC_SNAPSHOT_UPDATED topic.
    """

    TOPIC_CARD_EVENT = "prism_card_event"
    TOPIC_SNAPSHOT_UPDATED = "analytics_snapshot"

    _instance: "AnalyticsEngine" = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs) -> "AnalyticsEngine":  # noqa: D401
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
            return cls._instance

    def __init__(
        self,
        *,
        bus: Optional[ObserverBus] = None,
        calculators: Optional[Iterable[MetricCalculator]] = None,
        process_interval: float = 0.3,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        """
        Parameters
        ----------
        bus: ObserverBus
            Allows dependency injection for unit-testing.
        calculators: Iterable[MetricCalculator]
            Custom calculators (defaults to the factory’s set).
        process_interval: float
            How often (seconds) to flush the event queue into metrics.
        loop: asyncio.AbstractEventLoop
            Asyncio loop to use for background task scheduling.
        """
        if hasattr(self, "_initialized") and self._initialized:
            return  # already initialized

        self._bus = bus or ObserverBus()
        self._calculators = list(
            calculators or MetricFactory.create_default_calculators()
        )
        self._state = MutableAnalyticsState()
        self._event_queue: "asyncio.Queue[PrismCardEvent]" = asyncio.Queue()

        self._process_interval = max(process_interval, 0.05)
        self._loop = loop or asyncio.get_event_loop()
        self._task: Optional["asyncio.Task[None]"] = None

        # Start background processing
        self._start_background_task()

        # Subscribe to card events
        self._bus.subscribe(self.TOPIC_CARD_EVENT, self._on_card_event)

        self._initialized = True
        logger.info("AnalyticsEngine initialized.")

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def snapshot(self) -> AnalyticsSnapshot:
        """
        Return an *immutable* snapshot of current analytics state.
        """
        average_mood = (
            self._state.mood_sum / self._state.mood_count
            if self._state.mood_count
            else 0.0
        )
        snapshot = AnalyticsSnapshot(
            palette_frequency=dict(self._state.palette_counter),
            top_colors=list(self._state.top_colors),
            average_mood=average_mood,
            last_updated=self._state.last_updated,
        )
        logger.debug("Snapshot produced: %s", snapshot)
        return snapshot

    # --------------------------------------------------------------------- #
    # Card Event Handling
    # --------------------------------------------------------------------- #

    def _on_card_event(self, event: PrismCardEvent) -> None:
        """
        Callback to handle incoming PrismCardEvent from ObserverBus.
        """
        try:
            self._event_queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest event to make room to avoid unlimited memory growth
            _ = self._event_queue.get_nowait()
            self._event_queue.put_nowait(event)
            logger.warning("Event queue full – dropping oldest to accommodate new one.")

    # --------------------------------------------------------------------- #
    # Background processing
    # --------------------------------------------------------------------- #

    def _start_background_task(self) -> None:
        """
        Start the background asyncio task that flushes the event queue.
        """
        if self._task is None or self._task.done():
            self._task = self._loop.create_task(self._event_consumer())
            logger.debug("Background analytics task scheduled.")

    async def _event_consumer(self) -> None:
        """
        Pull events off the queue, update calculators, and publish snapshot.
        """
        while True:
            try:
                # Wait for at least one event or until process_interval
                try:
                    event = await asyncio.wait_for(
                        self._event_queue.get(), timeout=self._process_interval
                    )
                    batch = [event]
                except asyncio.TimeoutError:
                    batch = []

                # Drain additional events quickly
                while not self._event_queue.empty():
                    batch.append(self._event_queue.get_nowait())

                if not batch:
                    continue  # No new events this cycle

                self._process_batch(batch)
                self._publish_snapshot()

            except asyncio.CancelledError:
                logger.info("AnalyticsEngine consumer cancelled; shutting down.")
                break
            except Exception:  # pylint: disable=broad-except
                logger.exception("Unhandled error in analytics consumer")

    def _process_batch(self, batch: Sequence[PrismCardEvent]) -> None:
        """
        Update calculators with a batch of events.
        """
        for event in batch:
            for calc in self._calculators:
                try:
                    calc.update(event, self._state)
                except Exception:  # pylint: disable=broad-except
                    logger.exception("Calculator %s failed during update.", calc)

        # finalize
        for calc in self._calculators:
            try:
                calc.finalize(self._state)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Calculator %s failed during finalize.", calc)

        self._state.last_updated = time.time()
        logger.debug(
            "Batch processed; events=%s, state=%s",
            len(batch),
            dataclasses.asdict(self._state),
        )

    def _publish_snapshot(self) -> None:
        """
        Publish snapshot to ObserverBus.
        """
        snapshot = self.snapshot()
        self._bus.publish(self.TOPIC_SNAPSHOT_UPDATED, snapshot)

    # --------------------------------------------------------------------- #
    # Context manager helpers – useful for testing
    # --------------------------------------------------------------------- #

    def __enter__(self) -> "AnalyticsEngine":
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> Optional[bool]:
        self.shutdown()
        return None

    # --------------------------------------------------------------------- #
    # Shutdown logic
    # --------------------------------------------------------------------- #

    def shutdown(self) -> None:
        """
        Stop background task and unsubscribe from bus (useful for teardown).
        """
        self._bus.unsubscribe(self.TOPIC_CARD_EVENT, self._on_card_event)
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("AnalyticsEngine shutdown complete.")


# --------------------------------------------------------------------------- #
# Convenience Helper for External Publishers
# --------------------------------------------------------------------------- #

def publish_prism_card_event(event: PrismCardEvent) -> None:
    """
    Helper function allowing external modules to publish events without
    importing ObserverBus directly.  It implicitly starts the engine so that
    metrics are available system-wide.
    """
    # Ensure engine is alive
    _ = AnalyticsEngine()
    ObserverBus().publish(AnalyticsEngine.TOPIC_CARD_EVENT, event)


# --------------------------------------------------------------------------- #
# __all__ – what we expose from this module
# --------------------------------------------------------------------------- #

__all__ = [
    # Data
    "PrismCardEvent",
    "AnalyticsSnapshot",
    # Bus & Engine
    "ObserverBus",
    "AnalyticsEngine",
    # Helpers
    "publish_prism_card_event",
]