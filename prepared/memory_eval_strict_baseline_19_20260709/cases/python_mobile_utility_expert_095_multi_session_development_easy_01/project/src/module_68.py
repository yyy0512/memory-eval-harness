```python
"""
src/module_68.py

PrismPocket – State Mutation / Analytics Event-Bus

This module implements a lightweight, thread–safe Observer bus that streams
domain mutations (e.g., PrismCardSaved, PaletteMetricUpdated) from lower-level
repositories up to view-models and ancillary pipelines such as the analytics
engine.  The design purposefully avoids heavyweight dependencies so that it
runs identically in CPython, PyPy, and the mobile-embedded Python runtimes
used by PrismPocket’s iOS / Android shells.

Key features
------------
1. Singleton EventBus with topic-based publish / subscribe
2. In-memory + persistent offline queue with automatic replay
3. Thread-safe subscription management using weak references
4. Integrated, pluggable analytics sink
5. Back-pressure & drop-policy safeguards to avoid UI jank
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
import uuid
import weakref
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Callable, Dict, Iterable, List, Optional, Protocol, Type, TypeVar

__all__ = ["EventBus", "PrismEvent", "Subscription"]

# Configure root logger for the module
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


###############################################################################
#                                 Domain Events                               #
###############################################################################


@dataclass(frozen=True, slots=True)
class PrismEvent:
    """
    Base class for events flowing through the EventBus.

    Subclasses may add domain-specific fields, but _must_ remain JSON-serialisable
    to participate in offline persistence / replay.
    """

    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: float = field(default_factory=lambda: time.time())
    topic: str = field(default="generic")
    payload: Dict[str, "JSONType"] = field(default_factory=dict)
    metadata: Dict[str, "JSONType"] = field(default_factory=dict)

    def to_json(self) -> str:
        """Serialize event to JSON for disk persistence."""
        return json.dumps(self.__dict__, separators=(",", ":"), ensure_ascii=False)

    @classmethod
    def from_json(cls: Type["PrismEvent"], raw: str) -> "PrismEvent":
        """Rehydrate event from JSON string."""
        data = json.loads(raw)
        return cls(**data)  # type: ignore[arg-type]


###############################################################################
#                           Observer Bus – Singleton                          #
###############################################################################

Predicate = Callable[[PrismEvent], bool]
T = TypeVar("T", bound="Disposable")


class Disposable(Protocol):
    """Interface for objects that can be disposed / torn down."""

    def dispose(self) -> None: ...


class Subscription(Disposable):
    """
    Handle returned to the caller when subscribing to the EventBus.

    Allows unsubscribing via `.dispose()`; supports `with` statement.
    """

    __slots__ = ("_bus_ref", "_token", "_is_disposed", "_lock")

    def __init__(self, bus: "EventBus", token: str) -> None:
        self._bus_ref: weakref.ReferenceType[EventBus] = weakref.ref(bus)
        self._token = token
        self._is_disposed = False
        self._lock = threading.Lock()

    # --------------------------------------------------------------------- #
    # Context-manager support                                               #
    # --------------------------------------------------------------------- #
    def __enter__(self: T) -> T:
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> Optional[bool]:
        self.dispose()
        return None  # Propagate exceptions

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #
    def dispose(self) -> None:
        with self._lock:
            if self._is_disposed:
                return
            bus = self._bus_ref()
            if bus is not None:
                bus._unsubscribe(self._token)  # pylint: disable=protected-access
            self._is_disposed = True


class _SingletonMeta(type):
    """Thread-safe, lazy Singleton implementation."""

    _instance: Optional["EventBus"] = None
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    # pylint: disable=not-callable
                    cls._instance = super().__call__(*args, **kwargs)
        return cls._instance


class EventBus(metaclass=_SingletonMeta):
    """
    Central event dispatcher used across the application.

    Events are queued in a non-blocking fashion and dispatched on a worker
    thread to safeguard UI responsiveness.
    """

    # ------------------------------------------------------------------ #
    # Construction / Bootstrapping                                       #
    # ------------------------------------------------------------------ #
    def __init__(
        self,
        *,
        offline_path: Optional[Path] = None,
        queue_maxsize: int = 1_024,
        worker_name: str = "PrismPocket.EventBus",
    ) -> None:
        self._subscribers: Dict[str, Dict[str, "SubscriptionCtx"]] = {}
        self._queue: "queue.Queue[PrismEvent]" = queue.Queue(maxsize=queue_maxsize)
        self._queue_maxsize = queue_maxsize
        self._lock = threading.RLock()  # Protects _subscribers
        self._offline_path = (
            offline_path
            if offline_path is not None
            else Path.home()
            / ".prism_pocket"
            / "offline_queue.ndjson"
        )
        self._offline_path.parent.mkdir(parents=True, exist_ok=True)

        # Background worker thread
        self._worker = threading.Thread(
            name=worker_name, target=self._dispatcher_loop, daemon=True
        )
        self._worker.start()

        # Replay any persisted events on cold start
        self._replay_persisted()

    # ------------------------------------------------------------------ #
    # Subscription handling                                              #
    # ------------------------------------------------------------------ #
    def subscribe(
        self,
        topic: str,
        callback: Callable[[PrismEvent], None],
        *,
        predicate: Optional[Predicate] = None,
        replay_offline: bool = True,
    ) -> Subscription:
        """
        Subscribe to a topic.

        Parameters
        ----------
        topic
            Namespace to listen to.  Wildcards are NOT supported; the caller
            may subscribe to multiple topics if needed.
        callback
            Callable that consumes the emitted events.
        predicate
            Optional filter to run per event.
        replay_offline
            When true, queued offline events for the topic are replayed to the
            subscriber immediately after registration.
        """
        if not callable(callback):
            raise TypeError("callback must be callable")

        token = uuid.uuid4().hex
        ctx = SubscriptionCtx(callback=callback, predicate=predicate)

        with self._lock:
            self._subscribers.setdefault(topic, {})[token] = ctx
            logger.debug(
                "Subscriber added – topic=%s subscriber=%s total=%d",
                topic,
                token,
                len(self._subscribers[topic]),
            )

        sub = Subscription(self, token)

        if replay_offline:
            # Deliver offline events on a background thread to not block caller
            threading.Thread(
                target=self._replay_for_topic,
                args=(topic, callback, predicate),
                name=f"Replay-{topic}-{token}",
                daemon=True,
            ).start()

        return sub

    def _unsubscribe(self, token: str) -> None:
        with self._lock:
            for topic, bucket in list(self._subscribers.items()):
                if token in bucket:
                    del bucket[token]
                    logger.debug("Subscriber removed – topic=%s subscriber=%s", topic, token)
                    if not bucket:
                        self._subscribers.pop(topic, None)
                    return

    # ------------------------------------------------------------------ #
    # Publishing                                                         #
    # ------------------------------------------------------------------ #
    def publish(self, event: PrismEvent, *, offline_safe: bool = True) -> None:
        """
        Publish an event into the bus.

        Non-blocking; will be dropped with a warning if the internal queue is
        backed-up to its maximum size.
        """
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            logger.warning(
                "Event queue full (max=%d). Event dropped: %s", self._queue_maxsize, event
            )
            if offline_safe:
                self._persist_event(event)  # Attempt persistence even if queue saturated

    # ------------------------------------------------------------------ #
    # Internal – Dispatcher                                              #
    # ------------------------------------------------------------------ #
    def _dispatcher_loop(self) -> None:
        """Worker thread loop that drains queue and fan-outs to subscribers."""
        logger.info("EventBus dispatcher thread started")
        while True:
            try:
                event = self._queue.get()
                if event is None:  # Poison pill (not used but conceptually supported)
                    logger.info("Dispatcher received shutdown signal")
                    break
                self._fan_out(event)
            except Exception:  # pylint: disable=broad-except
                logger.exception("Unhandled error in dispatcher; continuing")

    def _fan_out(self, event: PrismEvent) -> None:
        """Deliver event to relevant subscribers with predicate filtering."""
        with self._lock:
            subscribers = dict(self._subscribers.get(event.topic, {}))  # Snapshot

        if not subscribers:
            # No live subscribers – persist event if offline-safe
            self._persist_event(event)
            return

        for token, ctx in subscribers.items():
            try:
                if ctx.predicate is None or ctx.predicate(event):
                    ctx.callback(event)
            except Exception:  # pylint: disable=broad-except
                # If a subscriber misbehaves we continue delivering to others
                logger.exception("Error delivering event to subscriber %s. Dropping.", token)

    # ------------------------------------------------------------------ #
    # Offline Persistence & Replay                                       #
    # ------------------------------------------------------------------ #
    def _persist_event(self, event: PrismEvent) -> None:
        """Append event to NDJSON file for later replay."""
        try:
            with self._offline_path.open("a", encoding="utf-8") as fh:
                fh.write(event.to_json() + "\n")
            logger.debug("Event persisted for offline replay: %s", event.event_id)
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to persist event to disk")

    def _replay_persisted(self) -> None:
        """Replay all persisted events into the queue at startup."""
        if not self._offline_path.exists():
            return
        try:
            with self._offline_path.open("r+", encoding="utf-8") as fh:
                lines = fh.readlines()
                fh.truncate(0)  # Wipe file after reading
            for raw in lines:
                try:
                    event = PrismEvent.from_json(raw.strip())
                    self.publish(event, offline_safe=False)  # Already persisted
                except Exception:  # pylint: disable=broad-except
                    logger.exception("Corrupted event in offline queue: %s", raw)
            logger.info("Replayed %d persisted events", len(lines))
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to replay persisted events")

    def _replay_for_topic(
        self,
        topic: str,
        callback: Callable[[PrismEvent], None],
        predicate: Optional[Predicate],
    ) -> None:
        """
        Selectively replay offline events for a new subscriber.

        This method reads the NDJSON file _without_ mutating it; events remain
        persisted so that subsequent subscribers also receive them until at
        least one live consumer acknowledges completion (future work).
        """
        if not self._offline_path.exists():
            return
        try:
            with self._offline_path.open(encoding="utf-8") as fh:
                for raw in fh:
                    try:
                        event = PrismEvent.from_json(raw.strip())
                        if event.topic != topic:
                            continue
                        if predicate is not None and not predicate(event):
                            continue
                        callback(event)
                    except Exception:  # pylint: disable=broad-except
                        logger.exception("Corrupted event during selective replay")
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to replay events for topic=%s", topic)


###############################################################################
#                            Helper Data Structures                           #
###############################################################################


class SubscriptionCtx:
    """Internal bag that holds callback and predicate for a subscriber."""

    __slots__ = ("callback", "predicate")

    def __init__(self, callback: Callable[[PrismEvent], None], predicate: Optional[Predicate]):
        self.callback = callback
        self.predicate = predicate


###############################################################################
#                              Analytics Sink                                 #
###############################################################################

class _AnalyticsAggregator:
    """
    Simple in-process aggregator that keeps counts of event types and topics.

    This is a placeholder for a more sophisticated streaming pipeline.  Every
    N seconds (default N=60), it flushes stats to a JSON file, which can later
    be hoovered into the cloud service when connectivity is available.
    """

    _FLUSH_INTERVAL_SEC = 60

    def __init__(self, flush_path: Optional[Path] = None) -> None:
        self._counts: Dict[str, int] = {}
        self._lock = threading.Lock()
        self._flush_path = (
            flush_path
            if flush_path is not None
            else Path.home() / ".prism_pocket" / "analytics_snapshot.json"
        )
        self._flush_path.parent.mkdir(parents=True, exist_ok=True)

        threading.Thread(
            target=self._flush_loop, name="PrismPocket.Analytics", daemon=True
        ).start()

        # Register with the event bus
        EventBus().subscribe(
            topic="*",
            callback=self._on_event,
            predicate=None,
            replay_offline=False,
        )

    # ------------------------------------------------------------------ #
    # Event consumption                                                  #
    # ------------------------------------------------------------------ #
    def _on_event(self, event: PrismEvent) -> None:
        key = f"{event.topic}"
        with self._lock:
            self._counts[key] = self._counts.get(key, 0) + 1

    # ------------------------------------------------------------------ #
    # Persistence loop                                                   #
    # ------------------------------------------------------------------ #
    def _flush_loop(self) -> None:
        while True:
            time.sleep(self._FLUSH_INTERVAL_SEC)
            self._flush_to_disk()

    def _flush_to_disk(self) -> None:
        snapshot = {
            "timestamp": datetime.utcnow().isoformat(),
            "counts": {},
        }
        with self._lock:
            snapshot["counts"] = dict(self._counts)
            # Prevent unbounded growth
            self._counts.clear()
        try:
            with self._flush_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
            logger.debug("Analytics snapshot flushed to %s", self._flush_path)
        except Exception:  # pylint: disable=broad-except
            logger.exception("Failed to flush analytics snapshot")


###############################################################################
#                           JSON type aliasing                                #
###############################################################################

JSONType = TypeVar(
    "JSONType",
    str,
    int,
    float,
    bool,
    None,
    Dict[str, "JSONType"],  # type: ignore  # Recursive types
    List["JSONType"],       # type: ignore
)

# Prime the analytics aggregator upon module import
_ANALYTICS_AGGREGATOR = _AnalyticsAggregator()  # noqa: CAPS
```