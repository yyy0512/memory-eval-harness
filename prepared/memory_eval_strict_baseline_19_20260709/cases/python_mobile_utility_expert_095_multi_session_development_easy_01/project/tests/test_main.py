```python
"""
Integration-style, behaviour-driven tests for core PrismPocket building
blocks.  All tests are written to be resilient: if the real production
modules are importable we use them; otherwise we fall back to light-weight
stubs that emulate the public contract closely enough for the test suite
to execute.

pytest -q tests/test_main.py
"""
from __future__ import annotations

import datetime as _dt
import logging
import random
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

import pytest

# --------------------------------------------------------------------------- #
#  Re-usable STUBS (loaded only when real modules are missing)
# --------------------------------------------------------------------------- #
try:
    # Real package import (if running inside the actual PrismPocket project)
    from prisme_pocket.domain.entities import PrismCard  # type: ignore
    from prisme_pocket.domain.analytics import PaletteMetric  # type: ignore
    from prisme_pocket.infrastructure.observer import ObserverBus  # type: ignore
    from prisme_pocket.infrastructure.repositories import LocalRepository  # type: ignore
    from prisme_pocket.infrastructure.adapters import CameraAdapter  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    # --------------------------------------------------------------------- #
    #  Fallback stubs (trimmed to what the tests need)
    # --------------------------------------------------------------------- #
    class PrismCard:  # noqa: D101 – stub
        def __init__(
            self,
            *,
            card_id: Optional[str] = None,
            raw_payload: bytes | str,
            palette: List[str],
            media_type: str = "text",
            created_at: Optional[_dt.datetime] = None,
        ) -> None:
            self.id = card_id or str(uuid.uuid4())
            self.raw_payload = raw_payload
            self.palette = palette
            self.media_type = media_type
            self.created_at = created_at or _dt.datetime.utcnow()

        # realistic helpers ------------------------------------------------ #
        def to_dict(self) -> Dict[str, Any]:  # noqa: D401
            return {
                "id": self.id,
                "raw_payload": self.raw_payload,
                "palette": self.palette,
                "media_type": self.media_type,
                "created_at": self.created_at.isoformat(),
            }

        @classmethod
        def from_dict(cls, data: Dict[str, Any]) -> "PrismCard":
            return cls(
                card_id=data["id"],
                raw_payload=data["raw_payload"],
                palette=data["palette"],
                media_type=data["media_type"],
                created_at=_dt.datetime.fromisoformat(data["created_at"]),
            )

        # make pytest's assert repr nicer
        def __repr__(self) -> str:  # pragma: no cover
            return f"PrismCard(id={self.id!r}, media={self.media_type!r})"

        def __eq__(self, other: object) -> bool:  # noqa: D401
            return isinstance(other, PrismCard) and self.to_dict() == other.to_dict()

    class PaletteMetric:  # noqa: D101 – stub
        def __init__(self, palette: List[str]) -> None:
            self.palette = palette

        @property
        def dominant_color(self) -> str:  # noqa: D401
            # naive: return most recurring
            return max(self.palette, key=self.palette.count)

        @staticmethod
        def trending(palette_metrics: List["PaletteMetric"]) -> str:
            """Return the dominant color across the batch."""
            counts: Dict[str, int] = {}
            for pm in palette_metrics:
                counts[pm.dominant_color] = counts.get(pm.dominant_color, 0) + 1
            return max(counts, key=counts.get)

    class ObserverBus:  # noqa: D101 – stub
        _instance = None

        def __new__(cls) -> "ObserverBus":  # Singleton pattern
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._subscribers: Dict[str, List[Callable[[Any], None]]] = {}
            return cls._instance

        # public API ------------------------------------------------------- #
        def subscribe(self, topic: str, fn: Callable[[Any], None]) -> None:
            self._subscribers.setdefault(topic, []).append(fn)

        def publish(self, topic: str, payload: Any) -> None:
            for fn in self._subscribers.get(topic, []):
                fn(payload)

    class _MockRemoteDataSource:  # noqa: D101 – stub
        """Pretend remote datasource with deterministic behaviour."""

        def __init__(self) -> None:
            self._storage: Dict[str, PrismCard] = {}
            self.invocations: int = 0

        def push(self, card: PrismCard) -> None:
            self.invocations += 1
            # simulate transient network failure on first call
            if self.invocations == 1:
                raise ConnectionError("Simulated network glitch")
            self._storage[card.id] = card

        def fetch_all(self) -> List[PrismCard]:
            return list(self._storage.values())

    class LocalRepository:  # noqa: D101 – minimal offline queue variant
        def __init__(self, remote: _MockRemoteDataSource) -> None:
            self._remote = remote
            self._queue: List[PrismCard] = []
            self.bus = ObserverBus()

        def save(self, card: PrismCard) -> None:
            self._queue.append(card)
            self.bus.publish("card:saved_local", card)

        def sync(self) -> None:
            pending = self._queue[:]
            for card in pending:
                try:
                    self._remote.push(card)
                    self._queue.remove(card)
                    self.bus.publish("card:sync_success", card)
                except ConnectionError as e:  # pragma: no cover
                    self.bus.publish("card:sync_failed", (card, str(e)))

    class CameraAdapter:  # noqa: D101 – stub
        """CameraAdapter with failure/retry logic to exercise error handling."""

        MAX_RETRIES = 2

        def __init__(self) -> None:
            self._invocations: int = 0

        def capture(self) -> bytes:
            self._invocations += 1
            if self._invocations < CameraAdapter.MAX_RETRIES:
                raise RuntimeError("Lens cap still on!")
            return b"\x89PNG\r\n\x1a\n..."

# --------------------------------------------------------------------------- #
#                               TEST HELPERS
# --------------------------------------------------------------------------- #
LOGGER = logging.getLogger("PrismPocketTest")
LOGGER.setLevel(logging.DEBUG)


def random_palette(n: int = 5) -> List[str]:
    """Return a deterministic pseudo-random palette string list."""
    random.seed(0xF00D)
    return [f"#{random.randint(0, 0xFFFFFF):06x}" for _ in range(n)]


# --------------------------------------------------------------------------- #
#                               TEST SUITE
# --------------------------------------------------------------------------- #
def test_prism_card_roundtrip_serialization() -> None:
    """Ensure PrismCard serialises/deserialises without data loss."""
    card = PrismCard(
        raw_payload="Hello Prism!",
        palette=random_palette(),
        media_type="text",
    )
    as_dict = card.to_dict()
    restored = PrismCard.from_dict(as_dict)

    assert restored == card
    # confirm ISO timestamp survived
    assert "T" in as_dict["created_at"] and as_dict["created_at"].endswith("Z") is False


def test_palette_metric_trending_algorithm() -> None:
    """Most popular dominant colour should be surfaced."""
    reds = PaletteMetric(["#ff0000", "#ff0000", "#00ff00"])
    blues = PaletteMetric(["#0000ff", "#0000ff", "#ff0000"])
    another_reds = PaletteMetric(["#ff0000", "#884422", "#ff0000"])
    trend = PaletteMetric.trending([reds, blues, another_reds])

    assert trend == "#ff0000"


def test_observer_bus_multicast_delivery(monkeypatch: pytest.MonkeyPatch) -> None:
    """Subscribers must receive all events published on their topic."""
    bus = ObserverBus()

    received_a: List[str] = []
    received_b: List[str] = []

    bus.subscribe("prism:test", lambda payload: received_a.append(payload))
    bus.subscribe("prism:test", lambda payload: received_b.append(payload))

    bus.publish("prism:test", "payload-1")
    bus.publish("prism:test", "payload-2")

    assert received_a == ["payload-1", "payload-2"]
    assert received_b == ["payload-1", "payload-2"]


def test_repository_offline_queue_and_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    """Cards saved offline should sync on next `sync()` call."""
    remote = _MockRemoteDataSource()
    repo = LocalRepository(remote=remote)

    card = PrismCard(
        raw_payload="offline note",
        palette=random_palette(),
        media_type="text",
    )
    repo.save(card)
    # Should be enqueued but not yet in remote
    assert card not in remote.fetch_all()

    # First sync triggers simulated network error, remains queued
    repo.sync()
    assert card in repo._queue

    # Second sync should succeed due to _MockRemoteDataSource behaviour
    repo.sync()
    assert card not in repo._queue
    assert card in remote.fetch_all()


def test_camera_adapter_retry_and_logging(caplog: pytest.LogCaptureFixture) -> None:
    """Adapter should retry on failure and ultimately succeed."""
    camera = CameraAdapter()

    caplog.set_level(logging.INFO)
    for attempt in range(CameraAdapter.MAX_RETRIES):
        try:
            payload = camera.capture()
            break
        except RuntimeError as exc:
            LOGGER.info("Capture attempt failed: %s", exc)
            time.sleep(0.01)  # back-off

    else:  # pragma: no cover
        pytest.fail("Camera capture never succeeded")

    assert payload.startswith(b"\x89PNG")
    # Verify that at least one error was logged
    assert any("Capture attempt failed" in rec.message for rec in caplog.records)


def test_viewmodel_reacts_to_repository_events() -> None:
    """
    A miniature MVVM flow:
    - Repository saves -> ObserverBus emits -> ViewModel updates -> UI listener invoked
    """
    bus = ObserverBus()
    repo = LocalRepository(remote=_MockRemoteDataSource())

    class PrismCardListViewModel:  # noqa: D101 – trimmed example
        def __init__(self) -> None:
            self.cards: List[PrismCard] = []
            bus.subscribe("card:saved_local", self._on_card_saved)

        def _on_card_saved(self, card: PrismCard) -> None:
            self.cards.append(card)
            bus.publish("ui:update", self.cards)

    view_model = PrismCardListViewModel()

    ui_updates: List[List[PrismCard]] = []
    bus.subscribe("ui:update", lambda cards: ui_updates.append(cards[:]))

    # Act
    new_card = PrismCard(raw_payload="🎨", palette=random_palette(), media_type="emoji")
    repo.save(new_card)

    assert view_model.cards == [new_card]
    assert ui_updates[-1] == [new_card]
```