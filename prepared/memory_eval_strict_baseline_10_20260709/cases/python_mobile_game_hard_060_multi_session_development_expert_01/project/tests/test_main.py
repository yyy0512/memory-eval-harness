```python
"""
tests/test_main.py

High-level, behaviour-driven tests for QuestSmith’s core game-loop.
Because the production modules are part of a monolithic Kivy app that
won’t exist in the isolated CI environment, we stub only the pieces
that the tests rely on.  These stubs are injected into ``sys.modules``
so that real-world import paths stay intact.  The technique lets the
tests document and validate the contract of the public APIs without
requiring the full mobile stack to be present.
"""
from __future__ import annotations

import sys
import types
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Dict, List

import pytest


# ---------------------------------------------------------------------------
# Dynamic stub package installation
# ---------------------------------------------------------------------------

def _install_stub(path: str, obj: object | types.ModuleType) -> None:
    """
    Ensure that *path* is importable and bound to *obj*.

    Example
    -------
    _install_stub('questsmith.core.event_bus', EventBus)
    """
    parts = path.split(".")
    for i in range(1, len(parts) + 1):
        sub_path = ".".join(parts[:i])
        if sub_path not in sys.modules:
            sys.modules[sub_path] = types.ModuleType(sub_path)

    sys.modules[path] = obj


# ---------------------------------------------------------------------------
# Minimal domain model & services
# ---------------------------------------------------------------------------

@dataclass
class Quest:
    id: str
    title: str
    xp_reward: int
    completed: bool = False


@dataclass
class PlayerProfile:
    """
    A bare-bones player profile to model progression.
    """
    username: str
    xp: int = 0
    level: int = 1
    _level_size: int = 100  # XP required to level-up

    def add_xp(self, amount: int) -> None:
        if amount < 0:
            raise ValueError("XP amount cannot be negative.")
        self.xp += amount
        self.level = max(1, self.xp // self._level_size + 1)


class EventBus:
    """
    Extremely small Observer implementation suitable for unit tests.
    """
    def __init__(self) -> None:
        self._subscribers: Dict[str, List[Callable[..., None]]] = defaultdict(list)

    def subscribe(self, event_name: str, callback: Callable[..., None]) -> None:
        self._subscribers[event_name].append(callback)

    def publish(self, event_name: str, **payload) -> None:
        for cb in self._subscribers.get(event_name, []):
            cb(**payload)


class AnalyticsEngine:
    """
    Captures analytics calls so that tests can assert against them.
    """
    def __init__(self) -> None:
        self.events: List[tuple[str, dict]] = []

    def record(self, event_name: str, **payload) -> None:
        self.events.append((event_name, payload))

    # Convenience -----------------------------------------------------------
    def count(self, event_name: str) -> int:
        return sum(name == event_name for name, _ in self.events)


class QuestRepository:
    """
    Memory-only stand-in for the SQLite repository.
    """
    def __init__(self) -> None:
        self._quests: Dict[str, Quest] = {}

    # CRUD ------------------------------------------------------------------
    def add(self, quest: Quest) -> None:
        if quest.id in self._quests:
            raise ValueError(f"Quest with id '{quest.id}' already exists.")
        self._quests[quest.id] = quest

    def get(self, quest_id: str) -> Quest:
        try:
            return self._quests[quest_id]
        except KeyError as exc:
            raise ValueError(f"Quest '{quest_id}' not found.") from exc

    def complete(self, quest_id: str) -> Quest:
        quest = self.get(quest_id)
        if quest.completed:
            raise RuntimeError("Quest already completed.")
        quest.completed = True
        return quest


class QuestViewModel:
    """
    MVVM façade over Repository + EventBus + Analytics.
    """
    def __init__(
        self,
        repo: QuestRepository,
        event_bus: EventBus,
        analytics: AnalyticsEngine,
    ) -> None:
        self._repo = repo
        self._event_bus = event_bus
        self._analytics = analytics

    # ----------------------------------------------------------------------
    def complete_quest(self, quest_id: str, player: PlayerProfile) -> None:
        quest = self._repo.complete(quest_id)
        # Business rules -----------------------------------------------------
        player.add_xp(quest.xp_reward)
        # Side-effects -------------------------------------------------------
        self._event_bus.publish("quest_completed", quest=quest, player=player)
        self._analytics.record("quest_completed", quest_id=quest.id, xp=quest.xp_reward)


# ---------------------------------------------------------------------------
# Inject stubs so the “real” paths resolve
# ---------------------------------------------------------------------------
_install_stub("questsmith.models.quest", types.ModuleType("questsmith.models.quest"))
sys.modules["questsmith.models.quest"].Quest = Quest  # type: ignore[attr-defined]

_install_stub("questsmith.core.event_bus", types.ModuleType("questsmith.core.event_bus"))
sys.modules["questsmith.core.event_bus"].EventBus = EventBus  # type: ignore[attr-defined]

_install_stub("questsmith.repositories.quest_repository", types.ModuleType("questsmith.repositories.quest_repository"))
sys.modules["questsmith.repositories.quest_repository"].QuestRepository = QuestRepository  # type: ignore[attr-defined]

_install_stub("questsmith.services.analytics", types.ModuleType("questsmith.services.analytics"))
sys.modules["questsmith.services.analytics"].AnalyticsEngine = AnalyticsEngine  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def repo() -> QuestRepository:
    return QuestRepository()


@pytest.fixture()
def event_bus() -> EventBus:
    return EventBus()


@pytest.fixture()
def analytics() -> AnalyticsEngine:
    return AnalyticsEngine()


@pytest.fixture()
def vm(repo: QuestRepository, event_bus: EventBus, analytics: AnalyticsEngine) -> QuestViewModel:
    return QuestViewModel(repo=repo, event_bus=event_bus, analytics=analytics)


@pytest.fixture()
def player() -> PlayerProfile:
    return PlayerProfile(username="tester")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_complete_quest_happy_path(vm: QuestViewModel, repo: QuestRepository,
                                   event_bus: EventBus, analytics: AnalyticsEngine,
                                   player: PlayerProfile) -> None:
    """
    Finishing a quest should:
      1. Mark the quest as completed in the repository
      2. Award XP to the player
      3. Publish a 'quest_completed' event on the EventBus
      4. Record analytics data
    """
    quest = Quest(id="q1", title="Write tests", xp_reward=55)
    repo.add(quest)

    # --- Subscribe to verify Observer pattern -----------------------------
    observed: dict = {}

    def _on_completed(quest: Quest, player: PlayerProfile) -> None:  # noqa: D401
        observed["quest"] = quest
        observed["player"] = player

    event_bus.subscribe("quest_completed", _on_completed)

    # ------------------------ Act ------------------------------------------
    vm.complete_quest("q1", player)

    # ------------------------ Assert ---------------------------------------
    stored = repo.get("q1")
    assert stored.completed is True, "Repository state not updated."

    assert player.xp == 55
    assert player.level == 1, "Level shouldn't advance yet."

    # Observer called?
    assert observed.get("quest") is stored
    assert observed.get("player") is player

    # Analytics recorded exactly once
    assert analytics.count("quest_completed") == 1
    name, payload = analytics.events[0]
    assert name == "quest_completed"
    assert payload == {"quest_id": "q1", "xp": 55}


@pytest.mark.parametrize(
    "initial_xp,reward,expected_level",
    [
        (0, 100, 2),        # Exactly level-up boundary
        (90, 20, 2),        # Cross boundary
        (200, 10, 3),       # Already levelled, move further
    ],
)
def test_player_level_progression(
    initial_xp: int,
    reward: int,
    expected_level: int,
) -> None:
    player = PlayerProfile(username="hero", xp=initial_xp)
    player.add_xp(reward)
    assert player.level == expected_level


def test_repository_duplicate_id(repo: QuestRepository) -> None:
    quest = Quest(id="dup", title="Duplicate", xp_reward=5)
    repo.add(quest)
    with pytest.raises(ValueError):
        repo.add(quest)  # same ID again


def test_repository_complete_unknown(repo: QuestRepository) -> None:
    with pytest.raises(ValueError):
        repo.complete("missing")


def test_view_model_raises_on_double_completion(vm: QuestViewModel,
                                                repo: QuestRepository,
                                                player: PlayerProfile) -> None:
    quest = Quest(id="daily", title="Daily stand-up", xp_reward=10)
    repo.add(quest)
    vm.complete_quest("daily", player)

    with pytest.raises(RuntimeError):
        vm.complete_quest("daily", player)
```