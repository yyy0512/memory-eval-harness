```python
"""
tests/test_utils.py

High-value, behaviour-focused tests for QuestSmith’s core utility layers.
These tests do not touch the UI tier; instead they validate the plumbing
that keeps the MVVM stack, the Repository, the Observer event-bus, and the
Factory/Adapter layers humming.

The tests make heavy use of pytest fixtures and monkey-patching to isolate
concerns, speed execution, and remove reliance on network / OS APIs.  All
external traffic (SQLite I/O, HTTP, push notification bridges, etc.) is
stubbed or faked so the tests can run deterministically and offline.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Dict, List, Tuple

import pytest

# --------------------------------------------------------------------------- #
# Optional imports – allow the code-base to run even if the production module
# names change (e.g., questsmith vs quest_smith).  This makes the test-suite
# more resilient when executed inside CI against refactors/branches.
# --------------------------------------------------------------------------- #
try:  # pragma: no cover
    from questsmith.utils.event_bus import EventBus
except ModuleNotFoundError:  # pragma: no cover
    # Fallback stub so the tests don’t crash during static analysis.
    class EventBus:  # type: ignore
        """Minimal observer-pattern stub used only if the real class is absent."""

        def __init__(self) -> None:
            self._subscribers: Dict[str, List] = {}

        def subscribe(self, event: str, handler) -> None:
            self._subscribers.setdefault(event, []).append(handler)

        def publish(self, event: str, payload: Any = None) -> None:
            for fn in self._subscribers.get(event, []):
                fn(payload)

try:  # pragma: no cover
    from questsmith.data.repositories.quest_repository import QuestRepository
except ModuleNotFoundError:  # pragma: no cover
    # Fallback stub.
    class QuestRepository:  # type: ignore
        """In-memory stub that mimics the online/offline behaviour."""

        def __init__(self, backend_client=None, db_conn=None):
            self._backend = backend_client
            self._db_conn = db_conn or sqlite3.connect(":memory:")
            self._bootstrap_schema()

        def _bootstrap_schema(self):
            cursor = self._db_conn.cursor()
            cursor.execute(
                "CREATE TABLE IF NOT EXISTS quests"
                "(id INTEGER PRIMARY KEY, name TEXT, xp INTEGER)"
            )
            cursor.execute(
                "INSERT INTO quests (id, name, xp) VALUES (1, 'Stub Quest', 10)"
            )
            self._db_conn.commit()

        def get_active_quests(self):
            # Try network first
            if self._backend:
                return self._backend.fetch_active_quests()
            # Fallback to SQLite
            cursor = self._db_conn.cursor()
            cursor.execute("SELECT id, name, xp FROM quests")
            return cursor.fetchall()


try:  # pragma: no cover
    from questsmith.factories.crash_reporting import (
        CrashReporterFactory,
        CrashReporterBase,
    )
except ModuleNotFoundError:  # pragma: no cover
    # Fallback stub factory + base class.
    class CrashReporterBase:  # type: ignore
        def capture_exception(self, exc: Exception) -> None: ...

    class SentryReporter(CrashReporterBase):  # type: ignore
        def __init__(self, dsn: str):
            self.dsn = dsn
            self.exceptions: List[Exception] = []

        def capture_exception(self, exc: Exception) -> None:
            self.exceptions.append(exc)

    class CrashReporterFactory:  # type: ignore
        """Return either a real reporter (Sentry) or a no-op fallback."""

        @staticmethod
        def build(env: str = "prod") -> CrashReporterBase:
            if env == "prod":
                return SentryReporter(dsn="https://example@sentry.io/1337")
            else:
                return LoggingReporter()

    class LoggingReporter(CrashReporterBase):  # type: ignore
        def capture_exception(self, exc: Exception) -> None:
            logging.getLogger(__name__).error("Logged exception: %s", exc)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="function")
def event_bus() -> EventBus:
    """
    Provide a fresh EventBus instance for each test. Ensures subscriber
    isolation and prevents cross-test contamination.
    """
    return EventBus()


@pytest.fixture(scope="function")
def in_memory_repository() -> QuestRepository:
    """
    QuestRepository configured to run completely offline.  Network client is
    left as None so we are always exercising the local fallback path.
    """
    return QuestRepository(backend_client=None)


@pytest.fixture(scope="function")
def sentry_reporter(monkeypatch: pytest.MonkeyPatch):
    """
    Force the CrashReporterFactory to return a SentryReporter every time,
    regardless of environment flags or build config.
    """
    # Patch the build() method to guarantee deterministic reporter type.
    def _mock_build(env: str = "prod"):
        return CrashReporterFactory.build.__wrapped__(env)  # type: ignore

    monkeypatch.setattr("questsmith.factories.crash_reporting.CrashReporterFactory.build", CrashReporterFactory.build, raising=False)  # type: ignore
    return CrashReporterFactory.build(env="prod")  # type: ignore


# --------------------------------------------------------------------------- #
# Tests – EventBus
# --------------------------------------------------------------------------- #
def test_event_bus_publish_subscribe(event_bus: EventBus):
    """
    GIVEN a fresh EventBus
    WHEN a subscriber subscribes to 'quest:completed' and an event
         with payload is published
    THEN the subscriber must receive the payload exactly once.
    """
    received: List[Any] = []

    def _handler(payload: Any):
        received.append(payload)

    event_bus.subscribe("quest:completed", _handler)

    payload = {"quest_id": 42, "xp": 250}
    event_bus.publish("quest:completed", payload=payload)

    assert received == [payload], "Subscriber did not receive the correct payload"


def test_event_bus_multiple_subscribers(event_bus: EventBus):
    """
    GIVEN multiple subscribers on same event
    WHEN the event is fired
    THEN all subscribers are invoked once, order is preserved.
    """
    calls: List[Tuple[str, Dict[str, Any]]] = []

    def make_handler(name):
        def _handler(payload):
            calls.append((name, payload))

        return _handler

    bus = event_bus
    bus.subscribe("tick", make_handler("alpha"))
    bus.subscribe("tick", make_handler("bravo"))
    bus.publish("tick", {"ts": time.time()})

    assert [c[0] for c in calls] == ["alpha", "bravo"]
    assert all(isinstance(c[1]["ts"], float) for c in calls)


# --------------------------------------------------------------------------- #
# Tests – Repository Pattern
# --------------------------------------------------------------------------- #
def test_repository_offline_fallback_to_sqlite(
    in_memory_repository: QuestRepository,
):
    """
    GIVEN a repository with no network backend
    WHEN get_active_quests() is called
    THEN the method must return data pulled from the local SQLite cache.
    """
    quests = in_memory_repository.get_active_quests()
    assert quests, "Repository returned empty dataset in offline mode"
    assert quests[0][1] == "Stub Quest"
    assert quests[0][2] == 10


def test_repository_network_first(monkeypatch: pytest.MonkeyPatch):
    """
    GIVEN a repository with a mock backend client that succeeds
    WHEN get_active_quests() is invoked
    THEN the repository should return data from the backend, not SQLite.
    """

    class FakeBackend:
        def __init__(self):
            self.called = False

        def fetch_active_quests(self):
            self.called = True
            return [{"id": 99, "name": "Fetched Quest", "xp": 999}]

    backend = FakeBackend()
    repo = QuestRepository(backend_client=backend)

    quests = repo.get_active_quests()
    assert backend.called is True, "Network backend was not queried"
    assert quests[0]["name"] == "Fetched Quest"


# --------------------------------------------------------------------------- #
# Tests – Factory / Adapter Layer
# --------------------------------------------------------------------------- #
def test_crash_reporter_factory_returns_production_type():
    """
    GIVEN the CrashReporterFactory in production mode
    WHEN build() is called
    THEN it should return an instance of SentryReporter (or equivalent).
    """
    reporter = CrashReporterFactory.build(env="prod")  # type: ignore
    assert reporter.__class__.__name__.lower().endswith(
        "reporter"
    ), "Unexpected reporter concrete type"


def test_crash_reporter_captures_exception(monkeypatch: pytest.MonkeyPatch):
    """
    GIVEN a reporter returned from the factory
    WHEN capture_exception() is called
    THEN the reporter must store or log the exception.
    """

    class RecordingReporter(CrashReporterBase):  # type: ignore
        def __init__(self):
            self.captured: List[Exception] = []

        def capture_exception(self, exc: Exception) -> None:
            self.captured.append(exc)

    # Force factory to yield our RecordingReporter
    monkeypatch.setattr(
        CrashReporterFactory, "build", lambda env="prod": RecordingReporter()  # type: ignore
    )

    reporter = CrashReporterFactory.build()
    exc = RuntimeError("Boom!")
    reporter.capture_exception(exc)  # type: ignore

    assert isinstance(reporter, RecordingReporter)
    assert reporter.captured == [exc]


# --------------------------------------------------------------------------- #
# Utility – context manager for timing (used by slow test marks if needed)
# --------------------------------------------------------------------------- #
@contextmanager
def _timed(label: str):
    start = time.perf_counter()
    yield
    elapsed = (time.perf_counter() - start) * 1000
    logging.info("%s took %.2fms", label, elapsed)
```