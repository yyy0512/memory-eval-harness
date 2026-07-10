```python
"""
src/module_62.py

PrismPocket – Event Bus (Observer Pattern implementation)
=========================================================

This module contains a production-grade, asyncio-powered event bus that powers
the PrismPocket Observer layer.  The bus is implemented as a *lazy* singleton
so that any part of the codebase can call `get_event_bus()` and obtain the
same instance.  It supports:

• Synchronous and asynchronous subscribers
• Strong typing of event objects
• Back-pressure via bounded asyncio.Queue
• Persistence hooks for offline queue replay
• Robust logging and error handling

The implementation purposefully avoids hard-wiring storage or network
concerns—those responsibilities belong to adapter layers in keeping with Clean
Architecture.  However, extension points (`EventStorageProtocol`) are provided
for such integrations.

Usage
-----

>>> from src.module_62 import get_event_bus, EventType, Event
>>> bus = get_event_bus()
>>>
>>> async def on_palette_metric(event: Event) -> None:
...     print("Received metric:", event.payload)
...
>>> bus.subscribe(EventType.PALETTE_METRIC_COMPUTED, on_palette_metric)
>>> await bus.publish(Event(
...     type=EventType.PALETTE_METRIC_COMPUTED,
...     payload={'dominant': '#ffcc00'},
... ))
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from abc import ABC, abstractmethod
from collections import defaultdict
from contextlib import suppress
from dataclasses import dataclass, field
from enum import Enum, auto
from inspect import iscoroutinefunction
from typing import Any, Awaitable, Callable, Coroutine, Dict, List, MutableMapping, Set

__all__ = [
    "EventType",
    "Event",
    "EventBus",
    "get_event_bus",
    "EventStorageProtocol",
]

# --------------------------------------------------------------------------- #
# Logging setup
# --------------------------------------------------------------------------- #

logger = logging.getLogger("prism_pocket.event_bus")
if not logger.handlers:
    # Configure root handler only once regardless of multiple imports
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)s [%(name)s]: %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    logger.addHandler(handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Domain objects
# --------------------------------------------------------------------------- #


class EventType(Enum):
    """
    Enumerates all first-class events inside PrismPocket.

    NOTE: Keep this list synced with analytics dashboards and push topics.
    """

    PRISM_CARD_CREATED = auto()
    PRISM_CARD_UPDATED = auto()
    PRISM_CARD_DELETED = auto()

    PALETTE_METRIC_COMPUTED = auto()
    REMIX_SESSION_STARTED = auto()
    REMIX_SESSION_ENDED = auto()

    SYNC_COMPLETED = auto()
    SYNC_FAILED = auto()

    # Generic events
    APP_FOREGROUNDED = auto()
    APP_BACKGROUNDED = auto()


@dataclass(slots=True, frozen=True)
class Event:
    """
    Core envelope transported over the bus.

    Attributes
    ----------
    id: str
        Globally unique identifier of the event.
    type: EventType
        Event semantic identifier.
    payload: Dict[str, Any]
        Arbitrary JSON-serializable data.
    timestamp: float
        Unix epoch time in seconds.
    """

    type: EventType
    payload: Dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
# Storage plug-in interface
# --------------------------------------------------------------------------- #


class EventStorageProtocol(ABC):
    """
    Optional persistence layer for offline queue replay.

    A concrete implementation could forward events to SQLite, CoreData, or a
    remote cache.  The EventBus does NOT depend on any specific storage;
    instead the adapter is injected at runtime by the platform layer.
    """

    @abstractmethod
    async def store(self, event: Event) -> None:  # pragma: no cover
        ...

    @abstractmethod
    async def load_unpublished(self) -> List[Event]:  # pragma: no cover
        ...

    @abstractmethod
    async def mark_published(self, event_id: str) -> None:  # pragma: no cover
        ...


# --------------------------------------------------------------------------- #
# EventBus implementation
# --------------------------------------------------------------------------- #


class EventBus:
    """
    Central asynchronous pub/sub hub.

    Implementation details
    ----------------------
    • Uses a single asyncio.Queue to serialize the write-path and guarantee
      FIFO order.
    • Supports both coroutine functions and synchronous callables as
      subscribers; synchronous functions run in a thread-pool to avoid
      blocking the loop.
    • Thread-safe `publish()` thanks to `asyncio.run_coroutine_threadsafe`.
    • Shut-down friendly: the background dispatcher task can be cancelled
      cleanly via `close()`.
    """

    _instance: "EventBus | None" = None
    _lock: asyncio.Lock = asyncio.Lock()  # Guards singleton instantiation

    QUEUE_MAXSIZE = 1024  # back-pressure

    def __init__(
        self,
        *,
        loop: asyncio.AbstractEventLoop | None = None,
        storage: EventStorageProtocol | None = None,
    ) -> None:
        if EventBus._instance:
            raise RuntimeError("EventBus is a singleton; use get_event_bus()")

        self._loop = loop or asyncio.get_event_loop()
        self._queue: asyncio.Queue[Event] = asyncio.Queue(
            maxsize=self.QUEUE_MAXSIZE, loop=self._loop
        )

        # Map[EventType, Set[Callable]]
        self._subscribers: MutableMapping[EventType, Set[Callable[[Event], Any]]] = (
            defaultdict(set)
        )

        self._storage = storage
        self._dispatcher_task: asyncio.Task[None] | None = None
        self._closed: bool = False

        EventBus._instance = self

    # --------------------------------------------------------------------- #
    # Life-cycle management
    # --------------------------------------------------------------------- #

    async def start(self) -> None:
        """
        Start the background dispatcher coroutine and replay offline queue.
        """
        if self._dispatcher_task:
            return  # already running

        logger.info("Starting EventBus…")
        self._dispatcher_task = self._loop.create_task(self._dispatcher())

        # Replay offline queue
        if self._storage:
            with suppress(Exception):
                pending = await self._storage.load_unpublished()
                for event in pending:
                    await self._queue.put(event)

    async def close(self) -> None:
        """
        Cancel dispatcher and wait for graceful termination.
        """
        if self._closed:
            return

        self._closed = True
        logger.info("Shutting down EventBus…")
        if self._dispatcher_task:
            self._dispatcher_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._dispatcher_task

        await self._queue.join()  # ensure all tasks done

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    def subscribe(
        self,
        event_type: EventType,
        callback: Callable[[Event], Awaitable[Any] | Any],
    ) -> None:
        """
        Register `callback` for `event_type`.

        The callback may be either a coroutine function (`async def`) or a
        regular function.  Duplicate subscriptions are ignored.
        """
        if self._closed:
            raise RuntimeError("EventBus is closed")

        self._subscribers[event_type].add(callback)
        logger.debug(
            "Subscriber %s registered for %s", callback.__qualname__, event_type.name
        )

    def unsubscribe(
        self,
        event_type: EventType,
        callback: Callable[[Event], Awaitable[Any] | Any],
    ) -> None:
        """
        Remove previously registered callback.

        Failure to be idempotent will not raise.
        """
        self._subscribers[event_type].discard(callback)
        logger.debug(
            "Subscriber %s unregistered from %s",
            callback.__qualname__,
            event_type.name,
        )

    async def publish(self, event: Event) -> None:
        """
        Enqueue an event for asynchronous fan-out.

        May raise `asyncio.QueueFull` if back-pressure exceeded.
        """
        if self._closed:
            raise RuntimeError("EventBus is closed")

        if self._storage:
            # Persist for offline replay _before_ enqueue to avoid data loss
            with suppress(Exception):
                await self._storage.store(event)

        await self._queue.put(event)
        logger.debug("Published event %s to queue (size=%d)", event.id, self._queue.qsize())

    # --------------------------------------------------------------------- #
    # Internal helpers
    # --------------------------------------------------------------------- #

    async def _dispatcher(self) -> None:
        """
        Background worker that pops events and invokes subscribers.
        """
        logger.info("EventBus dispatcher started")
        while not self._closed:
            try:
                event: Event = await self._queue.get()
                await self._fan_out(event)

                # Mark as delivered in storage layer
                if self._storage:
                    with suppress(Exception):
                        await self._storage.mark_published(event.id)

            except asyncio.CancelledError:
                break
            except Exception:  # pragma: no cover
                logger.exception("Fatal exception in EventBus dispatcher")
            finally:
                self._queue.task_done()

        logger.info("EventBus dispatcher exited")

    async def _fan_out(self, event: Event) -> None:
        """
        Invoke all subscribers registered for event.type.
        """
        callbacks = self._subscribers.get(event.type, set()).copy()
        if not callbacks:
            logger.debug("No subscribers for %s", event.type.name)
            return

        logger.debug(
            "Dispatching event %s to %d subscriber(s)",
            event.id,
            len(callbacks),
        )

        for callback in callbacks:
            try:
                if iscoroutinefunction(callback):
                    await callback(event)
                else:
                    # Offload sync handlers to default executor
                    await self._loop.run_in_executor(None, callback, event)
            except Exception:  # pragma: no cover
                logger.exception(
                    "Error in subscriber %s for event %s",
                    callback.__qualname__,
                    event.type.name,
                )

    # --------------------------------------------------------------------- #
    # Singleton helpers
    # --------------------------------------------------------------------- #

    @classmethod
    async def _get_or_create_async(cls) -> "EventBus":
        async with cls._lock:
            if cls._instance is None:
                cls._instance = EventBus()
                await cls._instance.start()
            return cls._instance

    @classmethod
    def get_instance(cls) -> "EventBus":
        """
        Synchronous accessor for situations where the caller is already inside
        the running event loop.

        If called from a thread without an active loop, creates one
        transparently (e.g., during unit tests).
        """
        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        future: "asyncio.Future[EventBus]" = asyncio.run_coroutine_threadsafe(
            cls._get_or_create_async(), loop
        )
        return future.result()


# --------------------------------------------------------------------------- #
# Convenience module-level accessor
# --------------------------------------------------------------------------- #


def get_event_bus() -> EventBus:
    """
    Retrieve the global EventBus instance.

    Alias around `EventBus.get_instance()` for brevity.
    """
    return EventBus.get_instance()
