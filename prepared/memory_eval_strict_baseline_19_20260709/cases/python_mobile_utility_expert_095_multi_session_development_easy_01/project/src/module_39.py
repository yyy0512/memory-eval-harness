```python
"""
PrismPocket – Sync Orchestrator
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

module_39.py centralises all logic required to push local mutations to the
PrismPocket Cloud Workspace *reliably* and *efficiently*.  It combines several
architectural patterns referenced in the project brief:

• Repository Pattern – `OfflineQueueRepository`
• Adapter Pattern      – `NetworkAdapter`
• Observer Pattern     – `EventBus`
• Factory Pattern      – `SyncTaskFactory`
• Singleton            – `SyncEngine` (thread-safe, lazily initialised)

The module purposefully keeps platform specific details at arm’s length.  All
external touch-points are expressed via narrow, test-friendly protocols so
mobile or desktop packaging layers can freely substitute their own bindings.

Author: AI Assistant
"""

from __future__ import annotations

import json
import logging
import queue
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Generator, List, Optional, Protocol, Type, Union
from uuid import uuid4

# --------------------------------------------------------------------------- #
# Logging configuration
# --------------------------------------------------------------------------- #
logger = logging.getLogger("prism.sync")
handler = logging.StreamHandler()
handler.setFormatter(
    logging.Formatter("%(asctime)s — %(name)s — %(levelname)s — %(message)s")
)
logger.addHandler(handler)
logger.setLevel(logging.INFO)


# --------------------------------------------------------------------------- #
# Domain placeholders (to be replaced by actual project domain entities)
# --------------------------------------------------------------------------- #
try:
    # Attempt to import real domain entities if present; otherwise define stubs.
    from prism.domain.entities import PrismCard, PaletteMetric, RemixSession  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    @dataclass(frozen=True)
    class PrismCard:
        id: str
        content: Dict[str, Any]
        last_modified: datetime

    @dataclass(frozen=True)
    class PaletteMetric:
        id: str
        palette: List[str]
        score: float
        captured_at: datetime

    @dataclass(frozen=True)
    class RemixSession:
        id: str
        card_id: str
        operations: List[Dict[str, Any]]
        started_at: datetime


SyncEntity = Union[PrismCard, PaletteMetric, RemixSession]


# --------------------------------------------------------------------------- #
# Event Bus (Observer Pattern)
# --------------------------------------------------------------------------- #
class EventBus:
    """
    Thread-safe observer bus.  Acts as an in-process pub/sub hub.
    """

    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[[Any], None]]] = {}
        self._lock = threading.RLock()

    def subscribe(self, event: str, callback: Callable[[Any], None]) -> None:
        with self._lock:
            self._subscribers.setdefault(event, []).append(callback)
            logger.debug("Subscriber added for event '%s'", event)

    def unsubscribe(self, event: str, callback: Callable[[Any], None]) -> None:
        with self._lock:
            callbacks = self._subscribers.get(event, [])
            if callback in callbacks:
                callbacks.remove(callback)
                logger.debug("Subscriber removed from event '%s'", event)

    def publish(self, event: str, payload: Any) -> None:
        # Copy subscriber list to avoid race conditions.
        with self._lock:
            subscribers = list(self._subscribers.get(event, []))
        logger.debug("Publishing event '%s' to %d subscriber(s)", event, len(subscribers))
        for callback in subscribers:
            try:
                callback(payload)
            except Exception:  # pragma: no cover
                logger.exception(
                    "Unhandled exception in subscriber while processing '%s'", event
                )


GLOBAL_EVENT_BUS = EventBus()


# --------------------------------------------------------------------------- #
# Repository Pattern – Offline Queue
# --------------------------------------------------------------------------- #
class OfflineQueueRepository:
    """
    Persists queued sync tasks to a lightweight SQLite DB so they survive
    app restarts or device reboots.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0
    );
    """

    def __init__(self, db_path: Path | str) -> None:
        self._db_path = Path(db_path).expanduser().resolve()
        self._lock = threading.RLock()
        logger.debug("Initialising OfflineQueueRepository at %s", self._db_path)
        self._ensure_schema()

    def _connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connection() as conn:
            conn.executescript(self._SCHEMA)

    def enqueue(self, entity: SyncEntity) -> str:
        task_id = str(uuid4())
        payload = json.dumps(asdict(entity), default=str)
        entity_type = type(entity).__name__
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO sync_queue (id, entity_type, payload, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (task_id, entity_type, payload, datetime.now(tz=timezone.utc).isoformat()),
            )
        logger.info("Enqueued %s with id %s", entity_type, task_id)
        GLOBAL_EVENT_BUS.publish("queue:added", {"task_id": task_id, "type": entity_type})
        return task_id

    def dequeue_batch(self, batch_size: int) -> List[Dict[str, Any]]:
        with self._lock, self._connection() as conn:
            cur = conn.execute(
                """
                SELECT id, entity_type, payload, retries
                FROM sync_queue
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (batch_size,),
            )
            rows = [dict(row) for row in cur.fetchall()]
        logger.debug("Dequeued batch of %d task(s)", len(rows))
        return rows

    def delete(self, task_id: str) -> None:
        with self._lock, self._connection() as conn:
            conn.execute("DELETE FROM sync_queue WHERE id = ?", (task_id,))
        logger.debug("Deleted task %s from queue", task_id)

    def increment_retry(self, task_id: str) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                "UPDATE sync_queue SET retries = retries + 1 WHERE id = ?", (task_id,)
            )
        logger.debug("Incremented retry counter for %s", task_id)


# --------------------------------------------------------------------------- #
# Network Adapter (Adapter Pattern)
# --------------------------------------------------------------------------- #
class NetworkAdapterProtocol(Protocol):
    """
    Defines the interface required by the sync engine for pushing data.
    """

    def push(self, endpoint: str, payload: Dict[str, Any]) -> None:
        ...


class HttpNetworkAdapter(NetworkAdapterProtocol):
    """
    Naïve HTTP adapter with exponential back-off.  Replace with real HTTP client
    (e.g., `httpx` or platform specific networking stack) in production.
    """

    BASE_URL = "https://api.prismpocket.app"

    def __init__(
        self,
        timeout: float = 10.0,
        max_retries: int = 5,
        backoff_factor: float = 0.3,
    ) -> None:
        self._timeout = timeout
        self._max_retries = max_retries
        self._backoff_factor = backoff_factor

    def push(self, endpoint: str, payload: Dict[str, Any]) -> None:
        import random  # Simulate network behaviour

        url = f"{self.BASE_URL}/{endpoint.lstrip('/')}"
        for attempt in range(1, self._max_retries + 1):
            try:
                # TODO: Replace simulation with real HTTP call.
                simulated_status = random.choice([201, 202, 500, 503])
                logger.debug("Attempt %d: POST %s -> status %d", attempt, url, simulated_status)
                if simulated_status >= 400:
                    raise IOError(f"Server responded with {simulated_status}")
                logger.info("Successfully pushed payload to %s", url)
                return
            except Exception as exc:
                logger.warning("Push failed (%s): %s", url, exc)
                if attempt == self._max_retries:
                    raise
                sleep_time = self._backoff_factor * 2 ** (attempt - 1)
                logger.debug("Retrying in %.2fs", sleep_time)
                time.sleep(sleep_time)


# --------------------------------------------------------------------------- #
# Factory Pattern – Sync Tasks
# --------------------------------------------------------------------------- #
@dataclass
class SyncTask(ABC):
    task_id: str
    entity: SyncEntity

    @abstractmethod
    def endpoint(self) -> str: ...

    @abstractmethod
    def payload(self) -> Dict[str, Any]: ...


@dataclass
class PrismCardSyncTask(SyncTask):
    def endpoint(self) -> str:
        return "v1/cards"

    def payload(self) -> Dict[str, Any]:
        return asdict(self.entity)  # type: ignore[attr-defined]


@dataclass
class PaletteMetricSyncTask(SyncTask):
    def endpoint(self) -> str:
        return "v1/metrics/palette"

    def payload(self) -> Dict[str, Any]:
        return asdict(self.entity)  # type: ignore[attr-defined]


@dataclass
class RemixSessionSyncTask(SyncTask):
    def endpoint(self) -> str:
        return "v1/remix/session"

    def payload(self) -> Dict[str, Any]:
        return asdict(self.entity)  # type: ignore[attr-defined]


class SyncTaskFactory:
    """
    Produces concrete `SyncTask` instances based on the domain entity passed.
    """

    _mapping: Dict[Type[SyncEntity], Type[SyncTask]] = {
        PrismCard: PrismCardSyncTask,
        PaletteMetric: PaletteMetricSyncTask,
        RemixSession: RemixSessionSyncTask,
    }

    @classmethod
    def create(cls, task_id: str, entity: SyncEntity) -> SyncTask:
        entity_type = type(entity)
        if entity_type not in cls._mapping:
            raise ValueError(f"Unsupported entity type: {entity_type}")
        task_cls = cls._mapping[entity_type]
        return task_cls(task_id=task_id, entity=entity)

    @classmethod
    def from_persisted(
        cls, task_id: str, entity_type: str, payload: str
    ) -> SyncTask:
        reverse = {t.__name__: e for e, t in cls._mapping.items()}
        if entity_type not in reverse:
            raise ValueError(f"Unknown persisted entity type: {entity_type}")
        entity_cls = reverse[entity_type]
        payload_dict = json.loads(payload)
        entity = entity_cls(**payload_dict)  # type: ignore[arg-type]
        return cls.create(task_id, entity)


# --------------------------------------------------------------------------- #
# Singleton – Sync Engine
# --------------------------------------------------------------------------- #
class _SyncEngineSingleton(type):
    _instance: Optional["SyncEngine"] = None
    _lock: threading.Lock = threading.Lock()

    def __call__(cls, *args: Any, **kwargs: Any) -> "SyncEngine":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__call__(*args, **kwargs)
            return cls._instance


class SyncEngine(metaclass=_SyncEngineSingleton):
    """
    Coordinates background synchronisation between local queue and cloud.
    """

    _FLUSH_INTERVAL = 15  # seconds
    _MAX_BATCH_SIZE = 10

    def __init__(
        self,
        repo: OfflineQueueRepository | None = None,
        adapter: NetworkAdapterProtocol | None = None,
    ) -> None:
        self._repo = repo or OfflineQueueRepository(Path.home() / ".prism_sync_queue.db")
        self._adapter = adapter or HttpNetworkAdapter()
        self._stop_event = threading.Event()
        self._runner_thread = threading.Thread(
            target=self._background_loop,
            name="PrismSyncThread",
            daemon=True,
        )

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def start(self) -> None:
        if not self._runner_thread.is_alive():
            logger.info("Starting SyncEngine background thread")
            self._runner_thread.start()

    def stop(self) -> None:
        logger.info("Stopping SyncEngine background thread")
        self._stop_event.set()
        self._runner_thread.join(timeout=5)

    def queue_entity(self, entity: SyncEntity) -> str:
        return self._repo.enqueue(entity)

    def flush(self) -> None:
        """
        Synchronously attempt to push entire queue right now.
        Primarily intended for test harnesses or explicit user action.
        """
        logger.info("Manual flush triggered")
        self._process_batch()

    # --------------------------------------------------------------------- #
    # Internal logic
    # --------------------------------------------------------------------- #
    def _background_loop(self) -> None:
        logger.debug("SyncEngine loop started")
        while not self._stop_event.is_set():
            try:
                self._process_batch()
            except Exception:  # pragma: no cover
                logger.exception("Unexpected error in sync loop")
            # Wait with jitter to reduce thundering herd if multiple instances
            wait = self._FLUSH_INTERVAL + (uuid4().int % 5)
            self._stop_event.wait(timeout=wait)
        logger.debug("SyncEngine loop terminated")

    def _process_batch(self) -> None:
        tasks = self._repo.dequeue_batch(self._MAX_BATCH_SIZE)
        if not tasks:
            logger.debug("No tasks to process")
            return

        logger.info("Processing %d queued task(s)", len(tasks))
        for row in tasks:
            task_id = row["id"]
            try:
                task = SyncTaskFactory.from_persisted(
                    task_id, row["entity_type"], row["payload"]
                )
                self._push(task)
                self._repo.delete(task_id)
                GLOBAL_EVENT_BUS.publish("queue:processed", {"task_id": task_id})
            except Exception as exc:
                logger.warning("Task %s failed: %s", task_id, exc)
                self._repo.increment_retry(task_id)
                GLOBAL_EVENT_BUS.publish(
                    "queue:failed", {"task_id": task_id, "error": str(exc)}
                )

    def _push(self, task: SyncTask) -> None:
        logger.debug("Pushing task %s to endpoint %s", task.task_id, task.endpoint())
        self._adapter.push(task.endpoint(), task.payload())


# --------------------------------------------------------------------------- #
# Convenience helpers
# --------------------------------------------------------------------------- #
_engine: SyncEngine | None = None
_engine_lock = threading.Lock()


def get_sync_engine() -> SyncEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = SyncEngine()
        return _engine


# --------------------------------------------------------------------------- #
# Quick self-test (if executed directly)
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    engine = get_sync_engine()
    engine.start()

    # Simulate entity capture
    card = PrismCard(id=str(uuid4()), content={"text": "Hello World"}, last_modified=datetime.now(tz=timezone.utc))
    engine.queue_entity(card)

    # Allow a couple of background cycles then stop.
    time.sleep(30)
    engine.stop()
```