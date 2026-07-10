```markdown
# QuestSmith API Reference
Version: 1.0.0  
Generated: 2024-05-26

QuestSmith is shipped as a **single, self-contained Python/Kivy bundle**.  
All packages live under the top-level namespace `questsmith`.  
The public surface is intentionally small—everything else is considered
internal and **subject to change without notice**.

---

## Contents
1. [Architecture Overview](#architecture-overview)  
2. [Core Domain Model](#core-domain-model)  
3. [Repositories](#repositories)  
4. [Event Bus](#event-bus)  
5. [Services & Factories](#services--factories)  
6. [ViewModels (MVVM)](#viewmodels-mvvm)  
7. [Error Handling](#error-handling)  
8. [Data Schema](#data-schema)  
9. [Extending QuestSmith](#extending-questsmith)  
10. [Testing Utilities](#testing-utilities)

---

## Architecture Overview

```text
+---------------------+
|  Kivy UI (Views)    |
+----------+----------+
           |
           v
+----------+----------+
| ViewModels (MVVM)   |  <-- Observes Repository & EventBus
+----------+----------+
           |
           v
+----------+----------+        +------------------+
| Repositories        |<------>| Service Factories|
|  (SQLite + Cache)   |        |  (Adapters)      |
+----------+----------+        +------------------+
           |
           v
+----------+----------+
|    Models           |
+---------------------+
```

* **Repository Pattern** centralizes all data operations (online & offline).  
* **Observer/Event Bus** decouples state change propagation.  
* **Factory Pattern** injects platform-specific adapters (IAP, GPS, etc.).  


---

## Core Domain Model

### `questsmith.models.quest.Quest`

```python
class QuestStatus(Enum):
    PENDING = "pending"
    ACTIVE  = "active"
    COMPLETE = "complete"
    FAILED   = "failed"

@dataclass
class Quest:
    """Immutable value object representing a single quest."""
    id: UUID
    title: str
    description: str
    due: datetime
    reward_xp: int
    reward_gold: int
    status: QuestStatus = field(default=QuestStatus.PENDING)
    created_at: datetime = field(default_factory=lambda: datetime.utcnow())
```

#### Key Characteristics
* **Immutable** – All operations create a *new* instance.
* **Serializable** – Provides `.to_dict()` / `.from_dict()` helpers (not shown).

---

## Repositories

### `questsmith.repositories.base.AbstractRepository`

```python
class AbstractRepository(Protocol):
    """Generic repository contract."""

    def add(self, model: ModelT) -> None: ...
    def update(self, model: ModelT) -> None: ...
    def delete(self, model_id: UUID) -> None: ...
    def get(self, model_id: UUID) -> ModelT: ...
    def list(self, *, filters: Mapping[str, Any] | None = None) -> list[ModelT]: ...
```

### `questsmith.repositories.quest.QuestRepository`

Responsible for all persistence and caching of `Quest` objects.

```python
class QuestRepository(AbstractRepository):
    """SQLite-backed quest storage with offline-first sync."""

    def add(self, model: Quest) -> None:
        ...
        self._event_bus.publish(QuestCreated(model))

    def complete(self, quest_id: UUID) -> Quest:
        """Mark a quest as complete and persist the change."""
        quest = self.get(quest_id)
        updated = replace(quest, status=QuestStatus.COMPLETE)
        self.update(updated)
        return updated
```

#### Usage Example

```python
repo = QuestRepository(sqlite_path="~/Library/questsmith.db",
                       event_bus=EventBus.shared())

quest = Quest(
    id=uuid4(),
    title="Morning Jog",
    description="Run 3km before 8 AM",
    due=datetime.now().replace(hour=8, minute=0, second=0),
    reward_xp=50,
    reward_gold=20,
)

repo.add(quest)
repo.complete(quest.id)
```

---

## Event Bus

### `questsmith.eventbus.EventBus`

A lightweight *synchronous* observer utility with thread-safe dispatch.

```python
class Event:
    """Base class for all domain events."""
    ts: datetime

class QuestCreated(Event):    quest: Quest
class QuestCompleted(Event):  quest: Quest
class QuestFailed(Event):     quest: Quest
```

```python
class EventBus:
    """Singleton message dispatcher."""

    _instance: ClassVar["EventBus"] | None = None

    @classmethod
    def shared(cls) -> "EventBus":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def subscribe(self, event_type: type[Event], handler: Callable[[Event], None]) -> Subscription:
        ...

    def publish(self, event: Event) -> None:
        ...
```

#### Thread-Safety

Under the hood, the bus is guarded by an `RLock`, making subscription and
publication safe from UI and background worker threads simultaneously.

---

## Services & Factories

### `questsmith.factories.ServiceFactory`

```python
class ServiceFactory:
    """Dynamic provider for platform services (GPS, IAP, etc.)."""

    _registry: dict[str, Callable[..., Any]] = {}

    @classmethod
    def register(cls, key: str, builder: Callable[..., Any]) -> None:
        cls._registry[key] = builder

    @classmethod
    def create(cls, key: str, **kwargs) -> Any:
        if key not in cls._registry:
            raise ServiceNotFound(f"Service '{key}' not registered.")
        return cls._registry[key](**kwargs)
```

Platform-specific packages (e.g. `questsmith_ios`) register at startup:

```python
from questsmith.factories import ServiceFactory
from questsmith_ios.location import IOSLocationService

ServiceFactory.register("location", lambda **kw: IOSLocationService(**kw))
```

---

## ViewModels (MVVM)

### `questsmith.viewmodels.quest.QuestViewModel`

```python
class QuestViewModel(Observable):
    """Bridges QuestRepository ↔ View."""

    def __init__(self, repo: QuestRepository) -> None:
        self._repo = repo
        self._quests: list[Quest] = []
        self.refresh()

        EventBus.shared().subscribe(QuestCreated, self._on_quest_event)
        EventBus.shared().subscribe(QuestCompleted, self._on_quest_event)

    @property
    def quests(self) -> list[Quest]:
        return self._quests

    def refresh(self) -> None:
        self._quests = self._repo.list()
        self.notify_observers()

    # -- private helpers -----------------------------------------------------

    def _on_quest_event(self, evt: Event) -> None:
        self.refresh()
```

View layer binds directly to public properties and reacts to
`notify_observers()` for automatic UI updates.

---

## Error Handling

All public methods raise `questsmith.errors.*` exceptions—**never raw** DB or
OS errors. Wrap calls in a `try/except` block to provide graceful degradation.

```python
try:
    repo.complete(quest_id)
except QuestNotFound as exc:
    logger.warning("Quest vanished: %s", exc)
except RepositoryOffline as exc:
    ui.notify("You're offline—updates will sync later.")
```

---

## Data Schema

SQLite file `questsmith.db` (auto-migrated):

```sql
CREATE TABLE quests (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    due         INTEGER,    -- Unix epoch
    reward_xp   INTEGER,
    reward_gold INTEGER,
    status      TEXT,
    created_at  INTEGER
);

CREATE INDEX idx_quests_due ON quests(due);
```

Schema migrations are handled by the lightweight
`questsmith.db.migrations` package (in-app, no Alembic).

---

## Extending QuestSmith

* Register a **new service** (e.g. Apple Health):
  ```python
  ServiceFactory.register("health", lambda: AppleHealthService())
  ```
* Add an **additional quest type**:
  1. Subclass `Quest`.
  2. Update `QuestRepository` serializer map.
  3. Emit custom `Quest<Type>Created` event.

---

## Testing Utilities

`questsmith.testing` provides helpers:

```python
@pytest.fixture()
def in_memory_repo():
    return QuestRepository(sqlite_path=":memory:",
                           event_bus=EventBus())

def test_add_quest(in_memory_repo):
    quest = Quest(...)
    in_memory_repo.add(quest)
    assert in_memory_repo.get(quest.id) == quest
```

Mocks for biometric auth, push notifications, and in-app purchases are
available via `questsmith.testing.doubles`.

---

## Changelog

*1.0.0* – Initial public release (core gameplay, sync, leaderboards).  

---

© 2024 Forge Studios.  
This document is licensed under CC BY-SA 4.0.
```