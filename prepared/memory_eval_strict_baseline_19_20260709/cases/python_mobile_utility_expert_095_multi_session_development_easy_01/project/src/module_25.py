```python
"""
src/module_25.py

Central event-stream infrastructure and colour-trend analytics for PrismPocket.
The module contains a lightweight, concurrency-safe Observer bus as well as a
domain-level PaletteMetricAggregator that listens for PrismCard-related events
and updates palette-usage statistics in (near) real-time.

Architectural roles
-------------------
* EventBus                 : Cross-layer Observer/Publisher (Observer Pattern)
* PaletteMetricAggregator  : Domain service, subscribes to EventBus
* StorageAdapter           : Local persistence for aggregator state
* SingletonMeta            : Guarantees singletons across interpreter instance
* Factory functions        : hide construction details from callers

Both synchronous and asynchronous subscriber callables are supported.  All I/O
(e.g., snapshot writes) is executed on background threads so that the critical
path remains non-blocking for the UI layer on mobile.
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, asdict
from functools import wraps
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Set,
    Type,
    TypeVar,
    Union,
)

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #

LOGGER = logging.getLogger("prism_pocket.analytics")
if not LOGGER.handlers:
    # Prevent duplicate handlers in case of repeated imports (e.g., unit tests)
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            "[%(levelname)s] %(asctime)s - %(name)s - %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    LOGGER.addHandler(_handler)
    LOGGER.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Typing helpers                                                              #
# --------------------------------------------------------------------------- #

TEvent = TypeVar("TEvent", bound="EventBase")
TCallable = TypeVar("TCallable", bound=Callable[..., Union[None, Awaitable[None]]])

# --------------------------------------------------------------------------- #
# Singleton meta                                                              #
# --------------------------------------------------------------------------- #


class SingletonMeta(type):
    """
    Thread-safe Singleton metaclass.

    Ensures that *exactly one* instance exists per subclass.  The implementation
    uses a per-class re-entrant lock to guarantee safe first-time initialisation
    under heavy multi-threaded load (common on Android & iOS runtimes).
    """

    _instances: Dict[Type[Any], Any] = {}
    _locks: Dict[Type[Any], threading.RLock] = {}

    def __call__(cls, *args: Any, **kwargs: Any) -> Any:  # noqa: D401
        if cls not in cls._instances:
            # Lazily create a lock only when first needed
            lock = cls._locks.setdefault(cls, threading.RLock())
            with lock:
                if cls not in cls._instances:
                    LOGGER.debug("Creating singleton instance for %s", cls.__name__)
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# --------------------------------------------------------------------------- #
# Event system                                                                #
# --------------------------------------------------------------------------- #


class EventBase:
    """Base class for all domain-level events."""

    __slots__ = ("timestamp",)

    def __init__(self) -> None:
        self.timestamp: float = time.time()


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    A minimal representation of PrismPocket's core entity for the purpose of
    analytics.  The full object lives in the domain layer.
    """

    card_id: str
    colors: List[str]  # HEX codes like ['#FFA500', '#AABBCC']
    author_id: str
    created_at: float = field(default_factory=lambda: time.time())


# Prism card CRUD events ----------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PrismCardCreatedEvent(EventBase):
    card: PrismCard


@dataclass(frozen=True, slots=True)
class PrismCardUpdatedEvent(EventBase):
    card: PrismCard


# EventBus implementation ---------------------------------------------------- #


class EventBus(metaclass=SingletonMeta):
    """
    Concurrency-safe Observer bus used throughout PrismPocket.  Subscribers may
    register callback functions (sync or async) for *specific* event classes.
    """

    _subscribers: MutableMapping[Type[EventBase], Set[TCallable]]
    _executor: ThreadPoolExecutor
    _lock: threading.RLock

    def __init__(self, max_workers: int = 4) -> None:
        self._subscribers = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="prism-eventbus",
        )
        LOGGER.debug("EventBus initialised with max_workers=%d", max_workers)

    # Subscription API ------------------------------------------------------- #

    def subscribe(
        self, event_type: Type[TEvent], callback: TCallable, /, *, replay: bool = False
    ) -> None:
        """
        Register a subscriber callback for the given `event_type`.

        Args:
            event_type: Concrete subclass of `EventBase`.
            callback  : Callable that accepts a single argument (the event).  May
                        be synchronous or `async def`.
            replay    : If `True`, the callback is immediately invoked with the
                        most recently published event of this type, if any.
        """
        if not issubclass(event_type, EventBase):
            raise TypeError("event_type must be subclass of EventBase")

        if not callable(callback):
            raise TypeError("callback must be callable")

        with self._lock:
            LOGGER.debug(
                "Subscribing %s to %s",
                getattr(callback, "__qualname__", repr(callback)),
                event_type.__name__,
            )
            self._subscribers.setdefault(event_type, set()).add(callback)

        if replay:
            self._replay_last_event(event_type, callback)

    def unsubscribe(self, event_type: Type[TEvent], callback: TCallable) -> None:
        """Remove a previously registered subscriber."""
        with self._lock:
            self._subscribers.get(event_type, set()).discard(callback)
            LOGGER.debug(
                "Unsubscribed %s from %s",
                getattr(callback, "__qualname__", repr(callback)),
                event_type.__name__,
            )

    # Publish API ------------------------------------------------------------ #

    def publish(self, event: EventBase) -> None:
        """
        Publish `event` to all subscribers.

        Each subscriber is executed on either the current asyncio loop (if it is
        an `async def`) or the worker thread pool (for regular callables).
        """
        event_type = type(event)

        with self._lock:
            callbacks = list(self._subscribers.get(event_type, set()))

        LOGGER.debug(
            "Publishing %s to %d subscriber(s)", event_type.__name__, len(callbacks)
        )

        for cb in callbacks:
            if asyncio.iscoroutinefunction(cb):
                asyncio.create_task(self._dispatch_async(cb, event))
            else:
                self._executor.submit(self._dispatch_sync, cb, event)

        # Persist last event for potential replay
        self._cache_last_event(event)

    # Internal helpers ------------------------------------------------------- #

    _last_events: Dict[Type[EventBase], EventBase] = {}

    def _cache_last_event(self, event: EventBase) -> None:
        """Retain the most recent event for each type (used by `replay`)."""
        self._last_events[type(event)] = event

    def _replay_last_event(self, event_type: Type[TEvent], callback: TCallable) -> None:
        """Invoke callback immediately with the last cached event of a type."""
        event = self._last_events.get(event_type)
        if event is None:
            return

        if asyncio.iscoroutinefunction(callback):
            asyncio.create_task(self._dispatch_async(callback, event))
        else:
            self._executor.submit(self._dispatch_sync, callback, event)

    @staticmethod
    def _dispatch_sync(callback: Callable[[EventBase], None], event: EventBase) -> None:
        try:
            callback(event)
        except Exception:  # pragma: no cover  # noqa: BLE001
            LOGGER.exception("Subscriber %s failed during sync dispatch", callback)

    @staticmethod
    async def _dispatch_async(
        callback: Callable[[EventBase], Awaitable[None]], event: EventBase
    ) -> None:
        try:
            await callback(event)
        except Exception:  # pragma: no cover  # noqa: BLE001
            LOGGER.exception("Subscriber %s failed during async dispatch", callback)


# --------------------------------------------------------------------------- #
# Analytics: PaletteMetricAggregator                                          #
# --------------------------------------------------------------------------- #


class StorageAdapter:
    """
    Very small local storage adapter that writes metric snapshots to a JSON file
    in <home>/PrismPocket/metrics_palette.json.  Meant to be swapped out with a
    more robust repository on mobile (e.g., SQLite via Kivy, CoreData, etc.).
    """

    FILE_PATH = (
        pathlib.Path.home()
        / "PrismPocket"
        / "metrics_palette.json"  # Persisted between app launches
    )

    _io_lock = threading.RLock()

    @classmethod
    def save(cls, data: Dict[str, Any]) -> None:
        cls.FILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with cls._io_lock, cls.FILE_PATH.open("w", encoding="utf-8") as fp:
            json.dump(data, fp, indent=2)
            LOGGER.debug("Saved palette metrics snapshot (%d items)", len(data))

    @classmethod
    def load(cls) -> Dict[str, Any]:
        if not cls.FILE_PATH.exists():
            return {}
        with cls._io_lock, cls.FILE_PATH.open("r", encoding="utf-8") as fp:
            LOGGER.debug("Loaded palette metrics snapshot")
            return json.load(fp)


class PaletteMetricAggregator(metaclass=SingletonMeta):
    """
    Aggregates colour palette usage across all PrismCards.  Relies on EventBus
    for change notifications.  Periodically persists its internal state via
    StorageAdapter so that analytics survive process death on mobile platforms.
    """

    def __init__(
        self,
        *,
        bus: Optional[EventBus] = None,
        snapshot_interval: int = 300,  # seconds
        top_k: int = 10,
    ) -> None:
        self._bus = bus or EventBus()
        self._colour_counter: Counter[str] = Counter(StorageAdapter.load())
        self._lock = threading.RLock()
        self._top_k = top_k

        # Start background snapshot scheduler
        self._stop_event = threading.Event()
        self._snapshot_thread = threading.Thread(
            target=self._run_snapshotter,
            name="PrismPaletteSnapshotter",
            daemon=True,
            args=(snapshot_interval,),
        )
        self._snapshot_thread.start()

        # Event subscriptions
        self._bus.subscribe(PrismCardCreatedEvent, self._on_card_event)
        self._bus.subscribe(PrismCardUpdatedEvent, self._on_card_event)

    # Public API ------------------------------------------------------------- #

    def get_top_palettes(self, n: Optional[int] = None) -> List[str]:
        """
        Return the `n` most frequently used colours across all cards.

        Args:
            n: Optional integer; falls back to the default `top_k` value.

        Returns:
            List of HEX colour strings ordered by descending frequency.
        """
        n = n or self._top_k
        with self._lock:
            top = [clr for clr, _ in self._colour_counter.most_common(n)]
            LOGGER.debug("Top %d palettes requested: %s", n, top)
            return top

    # Event handlers --------------------------------------------------------- #

    def _on_card_event(self, evt: Union[PrismCardCreatedEvent, PrismCardUpdatedEvent]):
        """Increment colour counters for each colour present in the card."""
        card = evt.card
        with self._lock:
            self._colour_counter.update(card.colors)
            LOGGER.debug(
                "Processed card %s; updated colour counts (total unique=%d)",
                card.card_id,
                len(self._colour_counter),
            )

    # Snapshot persistence --------------------------------------------------- #

    def _run_snapshotter(self, interval: int) -> None:
        LOGGER.info("PaletteMetricAggregator snapshotter started (interval=%ds)", interval)
        while not self._stop_event.wait(timeout=interval):
            self._persist_snapshot()

    def _persist_snapshot(self) -> None:
        with self._lock:
            payload = dict(self._colour_counter)
        try:
            StorageAdapter.save(payload)
        except Exception:  # pragma: no cover  # noqa: BLE001
            LOGGER.exception("Failed to persist palette metrics snapshot")

    # Lifecycle -------------------------------------------------------------- #

    def shutdown(self) -> None:
        """Flush state to disk and cleanly shut down background threads."""
        self._stop_event.set()
        self._snapshot_thread.join(timeout=3.0)
        self._persist_snapshot()
        self._bus.unsubscribe(PrismCardCreatedEvent, self._on_card_event)
        self._bus.unsubscribe(PrismCardUpdatedEvent, self._on_card_event)
        LOGGER.info("PaletteMetricAggregator shut down completed")


# --------------------------------------------------------------------------- #
# Factory helpers                                                             #
# --------------------------------------------------------------------------- #


def get_event_bus() -> EventBus:
    """Factory wrapper that hides underlying Singleton semantics."""
    return EventBus()


def get_palette_metric_aggregator() -> PaletteMetricAggregator:
    """Factory wrapper that hides underlying Singleton semantics."""
    return PaletteMetricAggregator()


# --------------------------------------------------------------------------- #
# Example usage (guarded for import safety)                                   #
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    # Illustrative usage only – this block is *not* executed by the mobile app
    bus = get_event_bus()
    aggregator = get_palette_metric_aggregator()

    # Create a few fake events
    for _idx in range(5):
        card = PrismCard(
            card_id=f"card-{_idx}",
            colors=["#FF0000", "#00FF00", "#0000FF"][: (_idx % 3) + 1],
            author_id="user-123",
        )
        bus.publish(PrismCardCreatedEvent(card=card))

    print("Top palettes:", aggregator.get_top_palettes())

    # Graceful shutdown
    aggregator.shutdown()
    # Give the EventBus time to flush in-flight tasks
    time.sleep(0.2)
```