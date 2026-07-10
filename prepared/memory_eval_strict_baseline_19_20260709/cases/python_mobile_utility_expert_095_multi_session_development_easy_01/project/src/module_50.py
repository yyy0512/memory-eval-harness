```python
"""
module_50.py

PrismPocket – Palette Metric Aggregator
---------------------------------------
Collects, aggregates, and synchronises colour-palette usage metrics that are
emitted by the application’s event-bus whenever a user captures or remixes a
`PrismCard`.  The service persists metrics locally (SQLite) so that they are
available offline, and periodically syncs the backlog to a cloud workspace.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Tuple

# --------------------------------------------------------------------------- #
# Logging configuration                                                       #
# --------------------------------------------------------------------------- #
logger = logging.getLogger("prismPocket.analytics.palette")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
)
logger.addHandler(_handler)

# --------------------------------------------------------------------------- #
# Observer / Event Bus abstractions                                           #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Event:
    """
    Generic event container used by the simple observer bus.
    """

    name: str
    payload: Dict[str, Any]
    timestamp: datetime = field(default_factory=datetime.utcnow)


class EventHandler(Protocol):
    """
    Signature for functions that handle events broadcast by the observer bus.
    """

    def __call__(self, event: Event) -> None: ...


class IEventBus(Protocol):
    """
    Minimal interface required by `PaletteMetricAggregator` to integrate with
    an application-wide observer bus.
    """

    def subscribe(self, event_name: str, handler: EventHandler) -> None: ...

    def unsubscribe(self, event_name: str, handler: EventHandler) -> None: ...


class SimpleEventBus:
    """
    Thread-safe, in-memory event bus (fallback for unit tests or CLI usage).
    NOT intended for production use in the mobile shell.
    """

    def __init__(self) -> None:
        self._handlers: Dict[str, List[EventHandler]] = {}
        self._lock = threading.RLock()

    def subscribe(self, event_name: str, handler: EventHandler) -> None:
        with self._lock:
            self._handlers.setdefault(event_name, []).append(handler)
            logger.debug("Handler %s subscribed to '%s'", handler, event_name)

    def unsubscribe(self, event_name: str, handler: EventHandler) -> None:
        with self._lock:
            if event_name in self._handlers:
                self._handlers[event_name].remove(handler)
                logger.debug("Handler %s unsubscribed from '%s'", handler, event_name)

    def publish(self, event: Event) -> None:
        """
        Broadcast an event to every subscribed handler. Handlers are invoked
        synchronously in the caller’s thread. Exceptions are logged but do not
        halt propagation.
        """
        with self._lock:
            handlers = list(self._handlers.get(event.name, ()))

        for handler in handlers:
            try:
                handler(event)
            except Exception:  # pragma: no cover
                logger.exception("Unhandled exception in %s for event %s", handler, event)


# --------------------------------------------------------------------------- #
# Infrastructure – Database helpers                                           #
# --------------------------------------------------------------------------- #


class _DatabaseConnectionFactory:
    """
    Lazily creates SQLite connections pointing to the analytics DB. A single
    connection *per thread* is held via `threading.local` to avoid cross-thread
    concurrency issues while still allowing concurrent reads from multiple UI
    threads.
    """

    _thread_local = threading.local()

    def __init__(self, db_file: Path) -> None:
        self._db_file = db_file
        self._db_file.parent.mkdir(parents=True, exist_ok=True)
        logger.debug("Palette metric DB initialised at %s", db_file)

    def connection(self) -> sqlite3.Connection:
        conn: Optional[sqlite3.Connection] = getattr(
            self._thread_local, "conn", None
        )
        if conn is None:
            conn = sqlite3.connect(
                self._db_file, check_same_thread=False, isolation_level=None
            )  # autocommit
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            self._prepare_schema(conn)
            self._thread_local.conn = conn
            logger.debug("Created new SQLite connection in thread %s", threading.get_ident())
        return conn

    @staticmethod
    def _prepare_schema(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS palette_metrics (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id  TEXT NOT NULL,
                palette  TEXT NOT NULL,        -- JSON list of colour strings
                ts       DATETIME NOT NULL,
                synced   INTEGER DEFAULT 0     -- 0 = pending, 1 = uploaded
            );
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_palette_metrics_synced ON palette_metrics (synced);"
        )


# --------------------------------------------------------------------------- #
# Infrastructure – Cloud sync adapter (stub)                                  #
# --------------------------------------------------------------------------- #


class CloudSyncError(RuntimeError):
    """Raised when cloud sync permanently fails."""


class CloudSyncAdapter:
    """
    Very small wrapper around network IO to push palette metrics to the Prism
    Pocket cloud workspace.  The actual HTTP implementation is deliberately
    omitted – this stub simulates transient network failures and retries.
    """

    RETRY_BACKOFF = (1, 2, 5)  # seconds

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url

    def send_palette_metrics(
        self, metrics: List[Dict[str, Any]]
    ) -> None:
        """
        Push a JSON array of palette metrics to the remote analytics endpoint.
        Errors are raised only when all retries have failed.
        """
        for attempt, backoff in enumerate((*self.RETRY_BACKOFF, None), start=1):
            try:
                # TODO: Replace with real HTTP POST call, e.g. using httpx/aiohttp.
                self._simulate_network_call(metrics)
                logger.info("Uploaded %d palette metric(s) to cloud", len(metrics))
                return
            except ConnectionError as exc:  # pragma: no cover
                if backoff is None:
                    logger.error(
                        "Giving up uploading palette metrics after %d attempts", attempt
                    )
                    raise CloudSyncError from exc
                logger.warning(
                    "Network failure (attempt %d/%d) – retrying in %ss",
                    attempt,
                    len(self.RETRY_BACKOFF) + 1,
                    backoff,
                )
                time.sleep(backoff)

    # --------------------------------------------------------------------- #
    # Internal helpers                                                      #
    # --------------------------------------------------------------------- #

    @staticmethod
    def _simulate_network_call(metrics: List[Dict[str, Any]]) -> None:
        """
        Simulates network behaviour for demonstration purposes.
        """
        if os.getenv("PRISMPOCKET_NET_OFFLINE") == "1":
            raise ConnectionError("Simulated offline mode")


# --------------------------------------------------------------------------- #
# Domain – Palette Metric Aggregator                                          #
# --------------------------------------------------------------------------- #


class _SingletonMeta(type):
    """
    Thread-safe singleton implementation via metaclass.  The first subclass to
    be instantiated wins; subsequent calls return the same instance.
    """

    _instances: Dict[type, "PaletteMetricAggregator"] = {}
    _lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any):  # type: ignore[override]
        with cls._lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)
                cls._instances[cls] = instance
            return cls._instances[cls]


class PaletteMetricAggregator(metaclass=_SingletonMeta):
    """
    Central service that listens for *palette_applied* events, persists the
    palette to a local store, and exposes query / sync APIs.
    """

    FLUSH_INTERVAL_SEC = 60

    # Event names emitted by View-Models / Repositories
    EVT_PALETTE_APPLIED = "palette_applied"

    def __init__(
        self,
        event_bus: Optional[IEventBus] = None,
        db_path: Optional[Path] = None,
        cloud_adapter: Optional[CloudSyncAdapter] = None,
    ) -> None:
        self._bus = event_bus or SimpleEventBus()
        self._db_factory = _DatabaseConnectionFactory(
            db_path
            or Path.home()
            / ".prism_pocket"
            / "analytics"
            / "palette_metrics.db"
        )
        self._cloud = cloud_adapter or CloudSyncAdapter(
            base_url="https://api.prismpocket.io/analytics"
        )

        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(
            target=self._flush_loop, name="PaletteMetricFlusher", daemon=True
        )

        # Subscribe to bus
        self._bus.subscribe(self.EVT_PALETTE_APPLIED, self._on_palette_applied)
        logger.info("PaletteMetricAggregator initialised and subscribed to '%s'", self.EVT_PALETTE_APPLIED)

        # Kick off background flush
        self._flush_thread.start()

    # --------------------------------------------------------------------- #
    # Event handlers                                                        #
    # --------------------------------------------------------------------- #

    def _on_palette_applied(self, event: Event) -> None:
        """
        Handler invoked whenever a user applies or modifies a colour palette on
        a PrismCard. Expects payload:

            {
                "card_id": "<uuid>",
                "palette": ["#00AAFF", "#FFC107", ...]  # 1-10 colours
            }
        """
        card_id = event.payload.get("card_id")
        palette = event.payload.get("palette")

        if not card_id or not isinstance(card_id, str):
            logger.warning("Invalid event payload – missing 'card_id'")
            return
        if not self._is_palette_valid(palette):
            logger.warning("Rejected palette for card %s – invalid colours: %s", card_id, palette)
            return

        try:
            self._insert_palette_metric(card_id, palette)
            logger.debug("Recorded palette for card %s: %s", card_id, palette)
        except Exception:  # pragma: no cover
            logger.exception("Failed to persist palette metric for card %s", card_id)

    # --------------------------------------------------------------------- #
    # Public API                                                            #
    # --------------------------------------------------------------------- #

    def query_top_palettes(
        self, *, since_days: int = 7, limit: int = 5
    ) -> List[Tuple[Tuple[str, ...], int]]:
        """
        Return the most frequently used palettes seen over the requested time
        range.  Because palettes are variable length, we treat each palette as
        a tuple of colours – order matters – and aggregate by identical tuples.
        """
        since = datetime.utcnow() - timedelta(days=since_days)
        sql = """
            SELECT palette
            FROM palette_metrics
            WHERE ts >= ?
        """
        rows = [json.loads(row[0]) for row in self._db_factory.connection().execute(sql, (since.isoformat(),))]
        counter: Counter[Tuple[str, ...]] = Counter(tuple(item) for item in rows)
        top = counter.most_common(limit)
        logger.info("Computed top %d palettes over last %d days", limit, since_days)
        return top

    def shutdown(self) -> None:
        """
        Flush pending metrics and stop the background sync thread.  Must be
        called explicitly from the app’s shutdown hook to avoid dangling
        threads when running in desktop tests or CLI utilities.
        """
        logger.info("Shutting down PaletteMetricAggregator")
        self._stop_event.set()
        self._flush_thread.join(self.FLUSH_INTERVAL_SEC + 5)
        self._flush_pending_metrics()

        # Unsubscribe from event bus
        self._bus.unsubscribe(self.EVT_PALETTE_APPLIED, self._on_palette_applied)

    # --------------------------------------------------------------------- #
    # Internal – Persistence                                                #
    # --------------------------------------------------------------------- #

    def _insert_palette_metric(self, card_id: str, palette: List[str]) -> None:
        conn = self._db_factory.connection()
        conn.execute(
            """
            INSERT INTO palette_metrics (card_id, palette, ts)
            VALUES (?, ?, ?)
            """,
            (card_id, json.dumps(palette), datetime.utcnow().isoformat()),
        )

    # --------------------------------------------------------------------- #
    # Internal – Sync loop                                                  #
    # --------------------------------------------------------------------- #

    def _flush_loop(self) -> None:
        """
        Background loop that flushes unsynced metrics at a fixed interval until
        shutdown is requested.
        """
        logger.debug("PaletteMetricAggregator background flush thread started")
        while not self._stop_event.is_set():
            self._flush_pending_metrics()
            self._stop_event.wait(self.FLUSH_INTERVAL_SEC)
        logger.debug("PaletteMetricAggregator background flush thread terminated")

    def _flush_pending_metrics(self) -> None:
        """
        Upload unsynced metrics to the remote workspace, marking them as synced
        upon success. Errors are handled gracefully: sync is retried on next
        pass without discarding data.
        """
        conn = self._db_factory.connection()
        with self._transaction(conn):
            rows = list(
                conn.execute(
                    "SELECT id, card_id, palette, ts FROM palette_metrics WHERE synced = 0 LIMIT 256"
                )
            )
            if not rows:
                return

            payload = [
                {
                    "id": row[0],
                    "card_id": row[1],
                    "palette": json.loads(row[2]),
                    "timestamp": row[3],
                }
                for row in rows
            ]

            try:
                self._cloud.send_palette_metrics(payload)
            except CloudSyncError:
                logger.warning("Palette metric upload failed – will retry later")
                return
            else:
                ids = [row["id"] for row in payload]
                conn.executemany(
                    "UPDATE palette_metrics SET synced = 1 WHERE id = ?",
                    [(id_,) for id_ in ids],
                )
                logger.debug("Marked %d palette metric(s) as synced", len(ids))

    @contextmanager
    def _transaction(self, conn: sqlite3.Connection):
        """
        Context-manager that wraps DB operations in a transaction (`BEGIN` /
        `COMMIT`). Rolls back on unhandled exceptions.
        """
        try:
            conn.execute("BEGIN;")
            yield
            conn.execute("COMMIT;")
        except Exception:
            conn.execute("ROLLBACK;")
            raise

    # --------------------------------------------------------------------- #
    # Validation helpers                                                    #
    # --------------------------------------------------------------------- #

    @staticmethod
    def _is_palette_valid(palette: Any) -> bool:
        """
        Basic validation ensuring a palette is a list of 1-10 hex colour
        strings (#RRGGBB).
        """
        if not isinstance(palette, list) or not (1 <= len(palette) <= 10):
            return False
        return all(isinstance(c, str) and PaletteMetricAggregator._is_hex_color(c) for c in palette)

    @staticmethod
    def _is_hex_color(value: str) -> bool:
        if len(value) != 7 or not value.startswith("#"):
            return False
        try:
            int(value[1:], 16)
        except ValueError:
            return False
        return True


# --------------------------------------------------------------------------- #
# Convenience exports                                                         #
# --------------------------------------------------------------------------- #
__all__ = [
    "PaletteMetricAggregator",
    "SimpleEventBus",
    "Event",
]
```