```python
"""
src/module_81.py
===================================
Analytics subsystem for PrismPocket.

This module wires together a minimal yet
realistic analytics pipeline that receives domain
events from the global Observer bus, persists them
locally, and periodically syncs them with a cloud
workspace.  Palette-related statistics are
aggregated in-memory and exposed to view-models for
real-time trend visualisation.

Patterns applied:
    • Repository Pattern          – AnalyticsRepository
    • Factory Pattern             – DataSourceFactory
    • Singleton                   – AnalyticsOrchestrator
    • Observer / Pub-Sub Pattern  – ObserverBus (simplified)
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import enum
import json
import logging
import queue
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Optional

try:
    import requests  # type: ignore
except ImportError:  # pragma: no cover
    # Fallback stub so the module keeps working on systems
    # without requests (e.g. during CI without network).
    class _RequestsStub:  # pylint: disable=too-few-public-methods
        def post(self, *_args, **_kwargs):  # noqa: D401
            raise RuntimeError("requests package not available")

    requests = _RequestsStub()  # type: ignore

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #

_LOGGER = logging.getLogger("prism.analytics")
if not _LOGGER.handlers:
    _HANDLER = logging.StreamHandler()
    _HANDLER.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)s — %(message)s")
    )
    _LOGGER.addHandler(_HANDLER)
_LOGGER.setLevel(logging.INFO)

# --------------------------------------------------------------------------- #
# Observer Bus (very thin, app-level implementation lives elsewhere)
# --------------------------------------------------------------------------- #


class ObserverBus:
    """Publish/Subscribe message bus for domain events."""

    _subscribers: Dict[str, List]

    def __init__(self) -> None:
        self._subscribers = {}

    # Singleton-like access pattern for the bus ----------------------------- #

    _instance: Optional["ObserverBus"] = None
    _lock = threading.Lock()

    @classmethod
    def instance(cls) -> "ObserverBus":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
        return cls._instance

    # Public API ------------------------------------------------------------ #

    def subscribe(self, topic: str, callback) -> None:
        self._subscribers.setdefault(topic, []).append(callback)
        _LOGGER.debug("Subscriber added to topic '%s': %s", topic, callback)

    def publish(self, topic: str, message) -> None:
        for callback in self._subscribers.get(topic, []):
            try:
                callback(message)
            except Exception as exc:  # pragma: no cover
                _LOGGER.exception("Error delivering message to subscriber: %s", exc)


# --------------------------------------------------------------------------- #
# Analytics domain model
# --------------------------------------------------------------------------- #


class EventType(enum.Enum):
    CARD_CREATED = "CARD_CREATED"
    CARD_REMIXED = "CARD_REMIXED"
    CARD_SHARED = "CARD_SHARED"
    PALETTE_USED = "PALETTE_USED"
    USER_LOGIN = "USER_LOGIN"


class AnalyticsEvent:
    """
    Lightweight, serialisable event.

    Parameters
    ----------
    type : EventType
    payload : dict
        Event-specific details (e.g., palette colours, card_id…)
    ts : datetime
        Timestamp in UTC.
    """

    __slots__ = ("type", "payload", "ts")

    def __init__(
        self, type: EventType, payload: Dict[str, str | int | float], ts: Optional[_dt.datetime] = None
    ) -> None:
        self.type = type
        self.payload = payload
        self.ts = ts or _dt.datetime.utcnow()

    # --------------------------------------------------------------------- #
    # Serialisation helpers
    # --------------------------------------------------------------------- #

    def to_json(self) -> str:
        return json.dumps(
            {
                "type": self.type.value,
                "payload": self.payload,
                "ts": self.ts.isoformat(),
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_json(cls, raw: str) -> "AnalyticsEvent":
        data = json.loads(raw)
        return cls(
            EventType(data["type"]),
            payload=data["payload"],
            ts=_dt.datetime.fromisoformat(data["ts"]),
        )

    # --------------------------------------------------------------------- #

    def __repr__(self) -> str:  # pragma: no cover
        return f"<AnalyticsEvent {self.type} at {self.ts}>"

    # --------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# Repository & Data Source Layer
# --------------------------------------------------------------------------- #


class IAnalyticsDataSource(ABC):
    """Abstraction for any persistence mechanism (local / remote)."""

    @abstractmethod
    def persist_event(self, event: AnalyticsEvent) -> None:
        raise NotImplementedError

    @abstractmethod
    def fetch_events(self, limit: int | None = None) -> Iterable[AnalyticsEvent]:
        raise NotImplementedError

    @abstractmethod
    def flush(self) -> None:
        """Ensure previous operations are committed / transmitted."""
        raise NotImplementedError

    # --------------------------------------------------------------------- #

    def close(self) -> None:  # noqa: D401
        """Optional clean-up."""
        self.flush()


# --------------------------------------------------------------------------- #
# SQLite Implementation (local / offline-first)
# --------------------------------------------------------------------------- #


class SQLiteAnalyticsDataSource(IAnalyticsDataSource):
    _DB_FILENAME = "analytics.sqlite3"
    _TABLE_SCHEMA = """
        CREATE TABLE IF NOT EXISTS analytics_event
        (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            ts      TEXT    NOT NULL,
            type    TEXT    NOT NULL,
            payload TEXT    NOT NULL
        )
    """

    def __init__(self, base_dir: Path) -> None:
        self._path = base_dir / self._DB_FILENAME
        _LOGGER.debug("Initialising SQLite data source at %s", self._path)
        self._con = sqlite3.connect(str(self._path), check_same_thread=False)
        self._con.execute("PRAGMA journal_mode=WAL;")
        with self._con:
            self._con.execute(self._TABLE_SCHEMA)

    # ------------------------------------------------------------------ #

    def persist_event(self, event: AnalyticsEvent) -> None:
        with self._con:  # auto-commit transaction
            self._con.execute(
                "INSERT INTO analytics_event(ts, type, payload) VALUES (?, ?, ?)",
                (event.ts.isoformat(), event.type.value, json.dumps(event.payload)),
            )
        _LOGGER.debug("Persisted event to SQLite: %s", event.type)

    # ------------------------------------------------------------------ #

    def fetch_events(self, limit: int | None = None) -> Iterable[AnalyticsEvent]:
        cursor = self._con.cursor()
        sql = "SELECT ts, type, payload FROM analytics_event ORDER BY ts DESC"
        if limit:
            sql += f" LIMIT {limit}"
        for ts_str, type_str, payload_str in cursor.execute(sql):
            yield AnalyticsEvent(
                EventType(type_str),
                payload=json.loads(payload_str),
                ts=_dt.datetime.fromisoformat(ts_str),
            )

    # ------------------------------------------------------------------ #

    def flush(self) -> None:
        self._con.commit()
        _LOGGER.debug("SQLite commit executed.")

    # ------------------------------------------------------------------ #

    def close(self) -> None:
        self._con.commit()
        self._con.close()
        _LOGGER.debug("SQLite connection closed.")


# --------------------------------------------------------------------------- #
# Cloud Data Source (simple HTTP POST)
# --------------------------------------------------------------------------- #


class CloudAnalyticsDataSource(IAnalyticsDataSource):
    """Remote persistence against PrismPocket Cloud."""

    DEFAULT_ENDPOINT = "https://api.prismpocket.io/analytics/ingest"

    def __init__(self, endpoint: str = DEFAULT_ENDPOINT, api_key: Optional[str] = None) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key

    # ------------------------------------------------------------------ #

    def persist_event(self, event: AnalyticsEvent) -> None:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "PrismPocket/AnalyticsClient",
        }
        if self._api_key:
            headers["X-API-Key"] = self._api_key

        try:
            resp = requests.post(self._endpoint, data=event.to_json(), timeout=3, headers=headers)
            resp.raise_for_status()
            _LOGGER.debug("Event synced to cloud: %s", event.type)
        except Exception as exc:  # pragma: no cover
            # Network errors should not crash the app;
            # caller decides if retries are necessary.
            _LOGGER.warning("Failed to push analytics event: %s", exc)

    # ------------------------------------------------------------------ #

    def fetch_events(self, limit: int | None = None) -> Iterable[AnalyticsEvent]:
        raise NotImplementedError("Cloud backend is write-only in this client")

    # ------------------------------------------------------------------ #

    def flush(self) -> None:  # noqa: D401
        """No-op for stateless HTTP implementation."""


# --------------------------------------------------------------------------- #
# Factory
# --------------------------------------------------------------------------- #


class DataSourceFactory:
    """Create appropriate data source based on runtime environment."""

    @staticmethod
    def create_local(base_dir: Path | str = ".") -> IAnalyticsDataSource:
        return SQLiteAnalyticsDataSource(Path(base_dir))

    @staticmethod
    def create_cloud(endpoint: str | None = None, api_key: str | None = None) -> IAnalyticsDataSource:
        return CloudAnalyticsDataSource(endpoint or CloudAnalyticsDataSource.DEFAULT_ENDPOINT, api_key)


# --------------------------------------------------------------------------- #
# Repository aggregates one or more data sources
# --------------------------------------------------------------------------- #


class AnalyticsRepository:
    """Facade that multiplexes events to several data sinks."""

    def __init__(self, local_ds: IAnalyticsDataSource, remote_ds: Optional[IAnalyticsDataSource] = None) -> None:
        self._local = local_ds
        self._remote = remote_ds

    def record(self, event: AnalyticsEvent) -> None:
        # Always save locally for offline support.
        self._local.persist_event(event)

        # Fire-and-forget remote sync in separate thread to avoid UI stall.
        if self._remote:

            def _push() -> None:
                with contextlib.suppress(Exception):
                    self._remote.persist_event(event)

            threading.Thread(target=_push, daemon=True).start()

    # ------------------------------------------------------------------ #

    def recent_events(self, limit: int = 100) -> List[AnalyticsEvent]:
        return list(self._local.fetch_events(limit=limit))

    # ------------------------------------------------------------------ #

    def close(self) -> None:
        self._local.close()
        if self._remote:
            self._remote.close()


# --------------------------------------------------------------------------- #
# Analytics Orchestrator (Singleton, background worker)
# --------------------------------------------------------------------------- #


class _Singleton(type):
    """Thread-safe singleton metaclass."""

    _instances: Dict = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]


class AnalyticsOrchestrator(metaclass=_Singleton):
    """
    Central coordinator:
        • Subscribes to Observer bus ("analytics" topic)
        • Buffers events, writes through repository
        • Maintains palette usage stats in memory
    """

    _QUEUE_POLL_TIMEOUT = 0.5  # seconds

    def __init__(self, repository: Optional[AnalyticsRepository] = None) -> None:
        self._bus = ObserverBus.instance()
        self._queue: "queue.Queue[AnalyticsEvent]" = queue.Queue()
        self._palette_counter: Counter[str] = Counter()
        self._shutdown_flag = threading.Event()

        # initialise repository lazily if not provided
        self._repository = repository or AnalyticsRepository(
            local_ds=DataSourceFactory.create_local(Path.home() / ".prism"),
            remote_ds=DataSourceFactory.create_cloud(api_key=None),
        )

        # Thread that consumes queue
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

        # Subscribe to bus
        self._bus.subscribe("analytics", self._enqueue_event)
        _LOGGER.info("AnalyticsOrchestrator initialised and listening for events.")

    # ------------------------------------------------------------------ #

    # Message bus callback
    def _enqueue_event(self, event: AnalyticsEvent) -> None:
        self._queue.put(event)

    # Background loop
    def _run(self) -> None:  # noqa: D401
        while not self._shutdown_flag.is_set():
            try:
                event = self._queue.get(timeout=self._QUEUE_POLL_TIMEOUT)
                self._process(event)
            except queue.Empty:
                continue

    # ------------------------------------------------------------------ #

    def _process(self, event: AnalyticsEvent) -> None:
        # Update in-memory palette stats
        if event.type == EventType.PALETTE_USED and "colors" in event.payload:
            self._palette_counter.update(event.payload["colors"])

        # Persist
        try:
            self._repository.record(event)
        except Exception as exc:  # pragma: no cover
            _LOGGER.exception("Failed to record analytics event: %s", exc)

    # ------------------------------------------------------------------ #

    # Public API --------------------------------------------------------- #

    def publish_event(self, event: AnalyticsEvent) -> None:
        """
        Convenience wrapper used by high-level services:
        instantly push to Observer bus.
        """
        self._bus.publish("analytics", event)

    def get_trending_palette(self, limit: int = 5) -> List[str]:
        """Return list of hex colours ordered by usage frequency."""
        return [color for color, _ in self._palette_counter.most_common(limit)]

    # ------------------------------------------------------------------ #

    def shutdown(self, timeout: float = 2.0) -> None:
        """Flush buffers and stop worker thread."""
        self._shutdown_flag.set()
        self._worker.join(timeout=timeout)
        self._repository.close()
        _LOGGER.info("AnalyticsOrchestrator shutdown completed.")


# --------------------------------------------------------------------------- #
# Handy global shortcut
# --------------------------------------------------------------------------- #

analytics = AnalyticsOrchestrator()  # pylint: disable=invalid-name

# --------------------------------------------------------------------------- #
# Example usage (would be executed by application domain, not library code)
# --------------------------------------------------------------------------- #

if __name__ == "__main__":  # pragma: no cover
    # Simulate events
    analytics.publish_event(
        AnalyticsEvent(EventType.CARD_CREATED, {"card_id": "abc123", "mood": "chill"})
    )
    analytics.publish_event(
        AnalyticsEvent(EventType.PALETTE_USED, {"colors": ["#FF5733", "#2980B9"]})
    )
    time.sleep(1)  # Give worker some time
    print("Trending colours:", analytics.get_trending_palette())
    analytics.shutdown()
```