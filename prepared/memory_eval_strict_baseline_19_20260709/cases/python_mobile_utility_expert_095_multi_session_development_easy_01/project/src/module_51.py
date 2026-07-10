```python
"""
src/module_51.py

Palette-centric analytics processor for PrismPocket.

This module listens to domain events describing mutations on `PrismCard`
instances, extracts the prominent colors, and persists palette-usage
metrics to the analytics repository that is appropriate for the runtime
environment (cloud, local, or mock).

It demonstrates:
    • Observer pattern (simple, in-process event bus)
    • Factory pattern (repository resolver)
    • Clean-architecture boundaries (domain → data → platform)
    • Async IO with graceful degradation & crash reporting hooks
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as _dt
import logging
import os
import random
import sys
import uuid
from dataclasses import dataclass, field
from enum import Enum
from types import TracebackType
from typing import (
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Set,
    Tuple,
    Type,
)

try:
    # Preferred async HTTP client.
    import aiohttp
except ImportError:  # pragma: no cover
    aiohttp = None  # type: ignore

try:
    # Optional local DB cache.
    import aiosqlite
except ImportError:  # pragma: no cover
    aiosqlite = None  # type: ignore

__all__ = [
    "PrismCard",
    "PaletteMetric",
    "CardEvent",
    "EventBus",
    "AnalyticsRepository",
    "CloudAnalyticsRepository",
    "LocalAnalyticsRepository",
    "PaletteAnalyticsProcessor",
]


###############################################################################
# Logger setup
###############################################################################

_LOGGER = logging.getLogger("prism_pocket.analytics.palette")
_HANDLER = logging.StreamHandler(stream=sys.stdout)
_HANDLER.setFormatter(
    logging.Formatter("[%(asctime)s] (%(levelname)s) %(name)s: %(message)s")
)
_LOGGER.addHandler(_HANDLER)
_LOGGER.setLevel(logging.INFO)


###############################################################################
# Domain stubs (would reside in `prism_pocket.domain` in the real project)
###############################################################################


@dataclass(frozen=True)
class PrismCard:
    """
    A minimal subset of the real domain entity.

    In production this object is more sophisticated and resides in the
    domain layer. Here we only preserve attributes that matter for
    palette analytics.
    """

    card_id: str
    user_id: str
    mime_type: str  # e.g. 'image/jpeg'
    content_uri: str  # local or remote path
    created_at: _dt.datetime
    updated_at: _dt.datetime
    # Raw RGB tuples for already-extracted palette, if available.
    palette: Optional[List[Tuple[int, int, int]]] = None


###############################################################################
# Palette metric value object
###############################################################################


@dataclass(frozen=True)
class PaletteMetric:
    """
    Value object encapsulating a palette metric entry.
    """

    uid: str
    user_id: str
    dominant_color_hex: str
    secondary_color_hex: Optional[str]
    source_card_id: str
    generated_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )


###############################################################################
# Event system (very light-weight Observer bus)
###############################################################################


class CardEventType(str, Enum):
    """
    Type of changes that may interest observers.
    """

    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"


@dataclass(frozen=True)
class CardEvent:
    """
    DTO published on the EventBus whenever a PrismCard mutates.
    """

    event_type: CardEventType
    card: PrismCard
    correlation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    published_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )


Subscriber = Callable[[CardEvent], Awaitable[None]]


class EventBus:
    """
    Very simple in-process event bus (Singleton).

    In the real codebase we might use RxPy, asyncio streams, or
    a dedicated library, but this suffices to demo the Observer pattern.
    """

    _instance: Optional["EventBus"] = None
    _subscribers: Dict[CardEventType, Set[Subscriber]]

    def __new__(cls) -> "EventBus":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._subscribers = {t: set() for t in CardEventType}
            _LOGGER.debug("EventBus singleton initialized.")
        return cls._instance

    def subscribe(self, event_type: CardEventType, coro: Subscriber) -> None:
        _LOGGER.debug("Subscriber %s registered for %s", coro, event_type)
        self._subscribers[event_type].add(coro)

    def unsubscribe(self, event_type: CardEventType, coro: Subscriber) -> None:
        with contextlib.suppress(KeyError):
            self._subscribers[event_type].remove(coro)
            _LOGGER.debug("Subscriber %s unregistered from %s", coro, event_type)

    async def publish(self, event: CardEvent) -> None:
        """
        Fan-out the event to interested subscribers. Every subscriber
        is awaited concurrently.
        """
        _LOGGER.debug(
            "Publishing event %s '%s' to %d subscribers.",
            event.event_type.value,
            event.correlation_id,
            len(self._subscribers[event.event_type]),
        )
        if not self._subscribers[event.event_type]:
            return

        await asyncio.gather(
            *(subscriber(event) for subscriber in self._subscribers[event.event_type]),
            return_exceptions=True,
        )


###############################################################################
# Repository abstraction and concrete implementations
###############################################################################


class AnalyticsRepository(Protocol):
    """
    Port/interface for analytics persistence.

    The processor depends on this abstraction, not on concrete DB/HTTP.
    """

    async def record_palette_metric(self, metric: PaletteMetric) -> None: ...


class CloudAnalyticsRepository:
    """
    Persists metrics to a remote HTTP endpoint.
    """

    _session: aiohttp.ClientSession
    _endpoint: str

    def __init__(self, endpoint: str, session: Optional[aiohttp.ClientSession] = None):
        if aiohttp is None:
            raise RuntimeError("aiohttp is required for CloudAnalyticsRepository")
        self._endpoint = endpoint.rstrip("/")
        self._session = session or aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))

    async def record_palette_metric(self, metric: PaletteMetric) -> None:
        payload = {
            "uid": metric.uid,
            "user_id": metric.user_id,
            "dominant_color_hex": metric.dominant_color_hex,
            "secondary_color_hex": metric.secondary_color_hex,
            "source_card_id": metric.source_card_id,
            "generated_at": metric.generated_at.isoformat(),
        }

        try:
            async with self._session.post(
                f"{self._endpoint}/palette_metrics",
                json=payload,
            ) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    _LOGGER.error(
                        "Failed to record metric (%s): %s %s", resp.status, text, payload
                    )
                else:
                    _LOGGER.debug("Metric recorded successfully: %s", payload)
        except Exception as exc:  # pragma: no cover
            # Bubble up to caller for crash reporter.
            _LOGGER.exception("Error while sending palette metric: %s", exc)
            raise

    async def close(self) -> None:
        await self._session.close()

    # Context-manager helpers make resource handling easier for call-sites.
    async def __aenter__(self) -> "CloudAnalyticsRepository":
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        await self.close()


class LocalAnalyticsRepository:
    """
    Persists metrics to a local SQLite database.

    Auto-creates the schema if missing. Only enabled if `aiosqlite` is
    importable; otherwise fallback to a no-op implementation.
    """

    _db_path: str
    _conn: Optional["aiosqlite.Connection"]

    def __init__(self, db_path: str = "prism_pocket_metrics.db"):
        if aiosqlite is None:
            raise RuntimeError("aiosqlite not available for LocalAnalyticsRepository")
        self._db_path = db_path
        self._conn = None

    async def _ensure_connection(self) -> None:
        if self._conn is None:
            self._conn = await aiosqlite.connect(self._db_path)
            await self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS palette_metric (
                    uid TEXT PRIMARY KEY,
                    user_id TEXT,
                    dominant_color_hex TEXT,
                    secondary_color_hex TEXT,
                    source_card_id TEXT,
                    generated_at TEXT
                )"""
            )
            await self._conn.commit()

    async def record_palette_metric(self, metric: PaletteMetric) -> None:
        await self._ensure_connection()
        assert self._conn is not None  # typing aid
        await self._conn.execute(
            """
            INSERT OR IGNORE INTO palette_metric
            (uid, user_id, dominant_color_hex, secondary_color_hex, source_card_id, generated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                metric.uid,
                metric.user_id,
                metric.dominant_color_hex,
                metric.secondary_color_hex,
                metric.source_card_id,
                metric.generated_at.isoformat(),
            ),
        )
        await self._conn.commit()
        _LOGGER.debug("Metric recorded locally: %s", metric)

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()

    async def __aenter__(self) -> "LocalAnalyticsRepository":
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        await self.close()


###############################################################################
# Repository factory
###############################################################################


def get_analytics_repository() -> AnalyticsRepository:
    """
    Factory. Decides at runtime which repository implementation to use.

    Precedence:
        1. If environment variable PRISM_ENV=TEST → use in-memory mock
        2. If PRISM_ANALYTICS_ENDPOINT is defined → Cloud
        3. Fallback to local SQLite
    """

    prism_env = os.environ.get("PRISM_ENV", "").upper()
    endpoint = os.environ.get("PRISM_ANALYTICS_ENDPOINT")

    if prism_env == "TEST":

        class _InMemoryRepository:
            _storage: List[PaletteMetric] = []

            async def record_palette_metric(self, metric: PaletteMetric) -> None:
                self._storage.append(metric)
                _LOGGER.debug("Metric stored in-memory (test): %s", metric)

        return _InMemoryRepository()

    if endpoint:
        _LOGGER.info("Using CloudAnalyticsRepository(%s)", endpoint)
        return CloudAnalyticsRepository(endpoint=endpoint)

    if aiosqlite is not None:
        _LOGGER.info("Using LocalAnalyticsRepository (SQLite).")
        return LocalAnalyticsRepository()

    _LOGGER.warning(
        "No analytics repository available. Metrics will be discarded."
    )

    class _NoOpRepository:
        async def record_palette_metric(self, metric: PaletteMetric) -> None:
            _LOGGER.debug("Discarding metric (noop): %s", metric)

    return _NoOpRepository()


###############################################################################
# Crash reporter (adapter stub)
###############################################################################


class CrashReporter:
    """
    Very small façade around an assumed native crash reporting SDK.

    In production this would bridge to Sentry, Firebase Crashlytics,
    or similar services.
    """

    @staticmethod
    def capture_exception(exc: BaseException) -> None:
        _LOGGER.error("Captured exception for crash reporting: %s", exc, exc_info=exc)


###############################################################################
# Palette extraction helper
###############################################################################


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def _extract_palette_stub(uri: str, k: int = 5) -> List[Tuple[int, int, int]]:
    """
    Placeholder for expensive image analysis.

    To keep the demo self-contained we fake palette extraction with
    deterministic random values based on the URI.
    """
    random.seed(uri)
    return [tuple(random.randint(0, 255) for _ in range(3)) for _ in range(k)]


def _dominant_colors(palette: List[Tuple[int, int, int]]) -> Tuple[str, Optional[str]]:
    """
    Very basic heuristic: assume first color is dominant, second is secondary.
    """
    hexes = [_rgb_to_hex(rgb) for rgb in palette[:2]]
    if len(hexes) == 1:
        hexes.append(None)
    return hexes[0], hexes[1]


###############################################################################
# Palette analytics processor
###############################################################################


class PaletteAnalyticsProcessor:
    """
    High-level component orchestrating palette analytics.

    Responsibilities:
        1. Subscribe to card events.
        2. Extract palette (or reuse cached palette).
        3. Distill palette metric(s).
        4. Persist via repository.
        5. Gracefully handle failures & report crashes.
    """

    _repo: AnalyticsRepository
    _bus: EventBus
    _task_pool: Set["asyncio.Task[None]"]

    def __init__(self, repo: Optional[AnalyticsRepository] = None):
        self._repo = repo or get_analytics_repository()
        self._bus = EventBus()
        self._task_pool = set()

        self._bus.subscribe(CardEventType.CREATED, self._handle_event)
        self._bus.subscribe(CardEventType.UPDATED, self._handle_event)
        _LOGGER.info("PaletteAnalyticsProcessor initialized and subscribed to events.")

    async def _handle_event(self, event: CardEvent) -> None:
        """
        Entry point invoked by the event bus.

        Offload heavy work to a background task so the bus remains snappy.
        """
        task = asyncio.create_task(self._process_event(event), name=f"palette_{event.correlation_id}")
        self._task_pool.add(task)
        task.add_done_callback(self._task_pool.discard)

    async def _process_event(self, event: CardEvent) -> None:
        if event.event_type not in (CardEventType.CREATED, CardEventType.UPDATED):
            # Palette analysis not needed for deletions.
            return
        card = event.card
        try:
            palette = card.palette or _extract_palette_stub(card.content_uri)
            dom, sec = _dominant_colors(palette)
            metric = PaletteMetric(
                uid=str(uuid.uuid4()),
                user_id=card.user_id,
                dominant_color_hex=dom,
                secondary_color_hex=sec,
                source_card_id=card.card_id,
            )
            await self._repo.record_palette_metric(metric)
            _LOGGER.info(
                "[%s] Palette metric persisted (%s, %s)",
                card.card_id,
                dom,
                sec or "None",
            )
        except Exception as exc:  # pragma: no cover
            CrashReporter.capture_exception(exc)

    async def drain(self, timeout: float | None = None) -> None:
        """
        Await completion of all spawned tasks (mainly for tests/shutdown).
        """
        if not self._task_pool:
            return

        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait(self._task_pool, timeout=timeout)

    def shutdown(self) -> None:
        """
        Unsubscribe from the bus and allow GC.
        """
        self._bus.unsubscribe(CardEventType.CREATED, self._handle_event)
        self._bus.unsubscribe(CardEventType.UPDATED, self._handle_event)
        _LOGGER.info("PaletteAnalyticsProcessor unsubscribed and shut down.")


###############################################################################
# Example usage (only executed when run directly)
###############################################################################

if __name__ == "__main__":  # pragma: no cover

    async def _demo() -> None:
        processor = PaletteAnalyticsProcessor()
        bus = EventBus()

        # Simulate new card creation.
        card = PrismCard(
            card_id="123",
            user_id="user-42",
            mime_type="image/jpeg",
            content_uri="file:///tmp/photo.jpg",
            created_at=_dt.datetime.now(tz=_dt.timezone.utc),
            updated_at=_dt.datetime.now(tz=_dt.timezone.utc),
        )

        await bus.publish(CardEvent(event_type=CardEventType.CREATED, card=card))

        # Give the processor a bit of time.
        await processor.drain(timeout=2)

        # Clean exit.
        processor.shutdown()

    asyncio.run(_demo())
```