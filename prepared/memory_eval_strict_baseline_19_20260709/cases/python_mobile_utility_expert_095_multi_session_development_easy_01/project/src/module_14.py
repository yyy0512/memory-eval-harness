```python
"""
PrismPocket – Analytics & Observer Infrastructure
-------------------------------------------------
This module wires together a small yet production-grade slice of
PrismPocket’s back-end service layer:

• EventBus (Observer pattern / thread-safe, singleton)
• AnalyticsEngine (domain service that calculates colour usage trends)
• EventRepository (SQLite-backed local storage, Repository pattern)
• AdapterFactory (Factory pattern for pluggable CrashReporter adapters)
• Defensive exception handling + crash-report uploads
"""

from __future__ import annotations

import json
import logging
import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Type

LOGGER = logging.getLogger("prism_pocket.analytics")
LOGGER.setLevel(logging.INFO)

# ---------------------------------------------------------------------------#
# Helper types & utilities
# ---------------------------------------------------------------------------#


@dataclass(frozen=True)
class AnalyticsEvent:
    """Value object representing an immutable analytics event."""
    name: str
    payload: Dict[str, Any]
    created_at: datetime = datetime.utcnow()


class SingletonMeta(type):
    """Thread-safe implementation of Singleton with lazy initialisation."""

    _instances: Dict[Type, "SingletonMeta"] = {}
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # noqa: D401
        if cls not in cls._instances:
            with cls._lock:
                if cls not in cls._instances:  # double-checked locking
                    cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


# ---------------------------------------------------------------------------#
# Crash Reporter (Adapter Pattern via Factory)
# ---------------------------------------------------------------------------#


class BaseCrashReporter(metaclass=SingletonMeta):
    """Abstract interface for crash reporting adapters."""

    def capture_exception(
        self, exc: BaseException, tb: Optional[TracebackType] = None
    ) -> None:
        raise NotImplementedError


class SentryCrashReporter(BaseCrashReporter):
    """Concrete adapter for Sentry or similar diagnostics platforms."""

    _dsn: str

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        LOGGER.debug("SentryCrashReporter initialised with DSN=%s", dsn)

    def capture_exception(
        self, exc: BaseException, tb: Optional[TracebackType] = None
    ) -> None:
        # Simulate remote transport
        LOGGER.error(
            "Captured exception for remote reporting: %s\nTraceback=%s", exc, tb
        )


class LocalCrashReporter(BaseCrashReporter):
    """Fallback crash reporter that logs to disk for offline devices."""

    def __init__(self, log_dir: Path = Path.home() / ".prism_pocket" / "crashes") -> None:
        self._log_dir = log_dir
        self._log_dir.mkdir(parents=True, exist_ok=True)
        LOGGER.debug("LocalCrashReporter will store crash logs in %s", log_dir)

    def capture_exception(
        self, exc: BaseException, tb: Optional[TracebackType] = None
    ) -> None:
        file_path = self._log_dir / f"crash_{int(time.time())}.log"
        with file_path.open("w") as fp:
            fp.write(f"{exc}\n\nTRACEBACK:\n{tb}")
        LOGGER.error("Crash information saved to %s", file_path)


class AdapterFactory:
    """Factory for producing adapter singletons."""

    _registry: Dict[str, Type[BaseCrashReporter]] = {
        "sentry": SentryCrashReporter,
        "local": LocalCrashReporter,
    }

    @classmethod
    def build_crash_reporter(cls, kind: str, **kwargs: Any) -> BaseCrashReporter:
        klass = cls._registry.get(kind.lower())
        if not klass:
            raise ValueError(f"CrashReporter kind={kind} is not registered.")
        return klass(**kwargs)


CRASH_REPORTER: BaseCrashReporter = AdapterFactory.build_crash_reporter("local")


def safely(fn: Callable[..., Any]) -> Callable[..., Any]:
    """
    Decorator that catches *any* exception raised by the wrapped callable
    and forwards it to the global crash reporter, guaranteeing that the
    surrounding app shell never explodes because of background analytics.
    """

    def wrapper(*args: Any, **kwargs: Any):  # noqa: D401
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # pylint: disable=broad-except
            LOGGER.exception("Unhandled exception in %s", fn.__name__)
            CRASH_REPORTER.capture_exception(exc)
            return None

    return wrapper


# ---------------------------------------------------------------------------#
# EventBus – Observer Pattern
# ---------------------------------------------------------------------------#


class EventBus(metaclass=SingletonMeta):
    """Thread-safe fan-out in-proc publish/subscribe bus for domain events."""

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[[Any], None]]] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_name: str, callback: Callable[[Any], None]) -> None:
        """Register a subscriber callback for the given event type."""
        with self._lock:
            self._subscribers.setdefault(event_name, []).append(callback)
        LOGGER.debug("Subscriber %s registered for '%s'", callback, event_name)

    def publish(self, event: AnalyticsEvent) -> None:
        """Push an analytics event to all interested listeners."""
        callbacks = self._subscribers.get(event.name, [])
        LOGGER.debug(
            "Publishing event '%s' to %d subscribers", event.name, len(callbacks)
        )
        for cb in list(callbacks):
            safely(cb)(event)


# ---------------------------------------------------------------------------#
# Repository Pattern for Local Storage
# ---------------------------------------------------------------------------#


class EventRepository(metaclass=SingletonMeta):
    """SQLite-backed repository for persisting AnalyticsEvent objects."""

    _DB_SCHEME: str = """
    CREATE TABLE IF NOT EXISTS analytics_events(
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL
    );
    """

    def __init__(self, db_path: Path | str = ":memory:") -> None:
        self._db_path = db_path
        self._conn = sqlite3.connect(
            self._db_path, check_same_thread=False, isolation_level=None
        )
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_schema()
        LOGGER.debug("EventRepository initialised with DB=%s", db_path)

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.executescript(self._DB_SCHEME)

    @contextmanager
    def _cursor(self) -> Iterable[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
            finally:
                cur.close()

    def save(self, event: AnalyticsEvent) -> None:
        with self._cursor() as cur:
            cur.execute(
                """
                INSERT INTO analytics_events(name, payload, created_at)
                VALUES(:name, :payload, :created_at)
                """,
                {
                    "name": event.name,
                    "payload": json.dumps(event.payload),
                    "created_at": event.created_at.isoformat(),
                },
            )
        LOGGER.debug("AnalyticsEvent '%s' persisted locally", event.name)

    def fetch_unsent(self, limit: int = 100) -> List[AnalyticsEvent]:
        with self._cursor() as cur:
            cur.execute(
                """
                SELECT name, payload, created_at
                FROM analytics_events
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
        return [
            AnalyticsEvent(
                name=row["name"],
                payload=json.loads(row["payload"]),
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in rows
        ]

    def delete_older_than(self, dt: datetime) -> None:
        with self._cursor() as cur:
            cur.execute(
                """
                DELETE FROM analytics_events
                WHERE created_at < :cutoff
                """,
                {"cutoff": dt.isoformat()},
            )
        LOGGER.debug("Pruned analytics events older than %s", dt.isoformat())


# ---------------------------------------------------------------------------#
# Analytics Engine
# ---------------------------------------------------------------------------#


class AnalyticsEngine(metaclass=SingletonMeta):
    """
    Consumes analytics events from the EventBus, computes metrics, persists
    raw events. Runs a background worker that flushes local storage to the
    cloud once network connectivity is detected.
    """

    _FLUSH_INTERVAL_SEC = 15

    def __init__(self) -> None:
        self._repo = EventRepository(Path.home() / ".prism_pocket" / "analytics.db")
        self._palette_usage: Dict[str, int] = {}
        self._worker_queue: queue.Queue[AnalyticsEvent] = queue.Queue(maxsize=1024)
        self._stop_event = threading.Event()

        EventBus().subscribe("palette_applied", self._enqueue)
        EventBus().subscribe("card_created", self._enqueue)

        self._worker_thread = threading.Thread(
            target=safely(self._background_worker),
            name="AnalyticsWorker",
            daemon=True,
        )
        self._worker_thread.start()
        LOGGER.info("AnalyticsEngine started with background worker thread.")

    def _enqueue(self, event: AnalyticsEvent) -> None:
        """Non-blocking enqueue; drops the event if the queue is full."""
        try:
            self._worker_queue.put_nowait(event)
        except queue.Full:
            LOGGER.warning("Analytics queue full; dropping event %s", event.name)

    @safely
    def _background_worker(self) -> None:
        """Consumes events and periodically flushes them to the cloud."""
        last_flush = time.time()
        while not self._stop_event.is_set():
            try:
                event: AnalyticsEvent = self._worker_queue.get(timeout=1)
                self._process_event(event)
            except queue.Empty:
                pass

            if time.time() - last_flush >= self._FLUSH_INTERVAL_SEC:
                self._flush_to_cloud()
                last_flush = time.time()

    # ------------------------------------------------------------------#
    # Domain-specific calculations
    # ------------------------------------------------------------------#

    def _process_event(self, event: AnalyticsEvent) -> None:
        LOGGER.debug("Processing AnalyticsEvent=%s", event)
        self._repo.save(event)

        if event.name == "palette_applied":
            palette_hex = event.payload.get("palette")
            if palette_hex:
                self._palette_usage[palette_hex] = (
                    self._palette_usage.get(palette_hex, 0) + 1
                )
                LOGGER.debug(
                    "Palette %s usage incremented to %d",
                    palette_hex,
                    self._palette_usage[palette_hex],
                )

    # ------------------------------------------------------------------#
    # Flush & sync
    # ------------------------------------------------------------------#

    @safely
    def _flush_to_cloud(self) -> None:
        """Pretend to send batched events to a remote analytics endpoint."""
        unsent = self._repo.fetch_unsent()
        if not unsent:
            return
        LOGGER.info("Flushing %d analytics events to cloud…", len(unsent))
        # Fake remote call
        time.sleep(0.25)

        # Remove sent records older than now-5min to keep DB tiny
        cutoff = datetime.utcnow()
        self._repo.delete_older_than(cutoff)
        LOGGER.debug("Analytics flush complete.")

    # ------------------------------------------------------------------#
    # Public API
    # ------------------------------------------------------------------#

    def most_popular_palettes(self, top_n: int = 5) -> List[Tuple[str, int]]:
        """Return the N most frequently used color palettes."""
        sorted_pairs = sorted(
            self._palette_usage.items(), key=lambda item: item[1], reverse=True
        )
        return sorted_pairs[:top_n]

    def shutdown(self) -> None:
        """Signal the background thread to stop gracefully."""
        self._stop_event.set()
        self._worker_thread.join(timeout=2)
        LOGGER.info("AnalyticsEngine shutdown complete.")


# ---------------------------------------------------------------------------#
# Module-initialisation side-effects
# ---------------------------------------------------------------------------#

# Side-effect: Create AnalyticsEngine singleton so that the *first* EventBus
# publication immediately has a consumer. This import-time side effect is
# acceptable here because analytics is orthogonal to the rest of the app.
_analytics_engine = AnalyticsEngine()

# ---------------------------------------------------------------------------#
# Test riff (will not execute inside production mobile shell)
# ---------------------------------------------------------------------------#

if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.DEBUG)

    # Simulate UI layer pushing events
    bus = EventBus()
    for _ in range(10):
        bus.publish(
            AnalyticsEvent(
                name="palette_applied",
                payload={"palette": "#FF5733-#FFC300"},
            )
        )
        bus.publish(
            AnalyticsEvent(
                name="card_created",
                payload={"card_id": "abc123"},
            )
        )

    # Wait long enough for background flushing
    time.sleep(AnalyticsEngine._FLUSH_INTERVAL_SEC + 2)

    # Display metrics
    LOGGER.info("Top palettes: %s", _analytics_engine.most_popular_palettes())
    _analytics_engine.shutdown()
```