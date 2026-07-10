```markdown
# PrismPocket — Public API Reference  
*Version: 1.5.0*  
*Status: Stable*

> PrismPocket is an “augmented utility sketchbook” that turns everyday
> captures into color-rich, shareable *prism cards*.  
> This document enumerates the core Python API used by mobile clients,
> plug-in authors, and backend services.

---

## Table of Contents

1. Quick-Start
2. Architectural Primer
3. Domain Layer
   - PrismCard
   - PaletteMetric
   - RemixSession
4. Repository Layer
   - PrismCardRepository
   - MetricRepository
5. Observer Bus
6. Adapter Layer
   - CameraAdapter
   - BiometricAdapter
   - PushAdapter
7. View-Model Layer
8. Factory & Singleton Utilities
9. Cloud Sync Endpoints
10. Error Handling Strategy
11. Extension Points
12. Changelog

---

## 1. Quick-Start

```python
from prismpocket.domain.entities import PrismCard
from prismpocket.infrastructure.repositories import PrismCardRepository
from prismpocket.observer import observer_bus
from prismpocket.factories import create_local_card

repo = PrismCardRepository.local()  # Factory chooses optimal storage engine
new_card = create_local_card(
    title="Park Sketch",
    media_path="/tmp/sketch.png",
    palette=["#F0A", "#0AF"]
)

repo.save(new_card)

# Subscribe to mutating events
def on_card_saved(event):
    print(f"[{event.timestamp}] Saved: {event.card.id}")

observer_bus.subscribe("card.saved", on_card_saved)
```

---

## 2. Architectural Primer

PrismPocket applies *Clean Architecture* within an *MVVM* presentation
shell:

```
 ┌──────────────┐
 │   UI Layer   │  (SwiftUI / Jetpack Compose)
 └──────────────┘
         │
 ┌──────────────┐
 │ View-Models  │  (pydantic models + RxPy Observables)
 └──────────────┘
         │
 ┌──────────────┐
 │ Repositories │  (Local & Cloud, offline-first)
 └──────────────┘
         │
 ┌──────────────┐
 │   Adapters   │  (Camera, Push, Biometric, etc.)
 └──────────────┘
         │
 ┌──────────────┐
 │   Domain     │  (Pure Python, fully testable)
 └──────────────┘
```

---

## 3. Domain Layer

### 3.1 `PrismCard`

```python
# prismpocket/domain/entities.py
from __future__ import annotations
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    Immutable value object representing a single creative capture.
    
    Attributes
    ----------
    id : uuid.UUID
        Unique identifier for the card.
    title : str
        Human-friendly label.
    media_path : str
        Local or remote URI to the asset.
    palette : List[str]
        HEX color codes extracted or chosen.
    created_at : datetime
        UTC timestamp of initial capture.
    location : Optional[tuple[float, float]]
        (lat, lon) if geotagged.
    """
    title: str
    media_path: str
    palette: List[str]
    id: uuid.UUID = field(default_factory=uuid.uuid4)
    created_at: datetime = field(default_factory=datetime.utcnow)
    location: Optional[tuple[float, float]] = None

    @property
    def dominant_color(self) -> str:
        """Return the top color from the palette."""
        return self.palette[0] if self.palette else "#000000"

    def remix(self, *, filters: Optional[List[str]] = None) -> "PrismCard":
        """
        Generate a remixed clone with optional filter stack.
        """
        if filters is None:
            filters = []
        new_title = f"{self.title} (Remix)"
        new_palette = self.palette.copy()
        # Example mutation: append filter labels to palette
        new_palette.extend(filters)
        return PrismCard(
            title=new_title,
            media_path=self.media_path,
            palette=new_palette,
            location=self.location
        )
```

### 3.2 `PaletteMetric`

```python
@dataclass(slots=True)
class PaletteMetric:
    palette: List[str]
    popularity: int = 0      # # of public uses
    mood_score: float = 0.0  # AI-inferred emotional valence
```

### 3.3 `RemixSession`

```python
class RemixSession:
    """
    Aggregate root tracking a collaborative remix flow.
    """
    def __init__(self, host_card: PrismCard):
        self._host = host_card
        self._changes: list[PrismCard] = []

    def apply(self, remix_card: PrismCard) -> None:
        self._changes.append(remix_card)

    @property
    def history(self) -> tuple[PrismCard, ...]:
        return tuple(self._changes)
```

---

## 4. Repository Layer

All repositories must comply with the following Protocol:

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class PrismCardRepo(Protocol):
    def save(self, card: PrismCard) -> PrismCard: ...
    def delete(self, card_id: uuid.UUID) -> None: ...
    def get(self, card_id: uuid.UUID) -> PrismCard | None: ...
    def list(self, *, limit: int = 100) -> list[PrismCard]: ...
```

### 4.1 `PrismCardRepository`

```python
# prismpocket/infrastructure/repositories.py
import json
from pathlib import Path
from threading import RLock
from prismpocket.observer import observer_bus

class PrismCardRepository:
    """
    Thread-safe implementation that persists to JSON, then syncs to cloud.
    """

    _lock = RLock()

    def __init__(self, storage_root: Path):
        self._root = storage_root
        self._root.mkdir(parents=True, exist_ok=True)

    # Factory helpers
    @classmethod
    def local(cls) -> "PrismCardRepository":
        from appdirs import user_data_dir
        return cls(Path(user_data_dir("PrismPocket")) / "cards")

    @classmethod
    def in_memory(cls) -> "PrismCardRepository":
        from tempfile import TemporaryDirectory
        return cls(Path(TemporaryDirectory().name))

    # --- CRUD ops ----------------------------------------------------------
    def save(self, card: PrismCard) -> PrismCard:
        with self._lock:
            fp = self._root / f"{card.id}.json"
            fp.write_text(json.dumps(card.__dict__, default=str))
        observer_bus.emit("card.saved", card=card)
        return card

    def delete(self, card_id: uuid.UUID) -> None:
        with self._lock:
            fp = self._root / f"{card_id}.json"
            if fp.exists():
                fp.unlink(missing_ok=True)
                observer_bus.emit("card.deleted", card_id=card_id)

    def get(self, card_id: uuid.UUID) -> PrismCard | None:
        fp = self._root / f"{card_id}.json"
        if not fp.exists():
            return None
        data = json.loads(fp.read_text())
        return PrismCard(**data)

    def list(self, *, limit: int = 100) -> list[PrismCard]:
        cards: list[PrismCard] = []
        for fp in sorted(self._root.glob("*.json"))[:limit]:
            cards.append(self.get(uuid.UUID(fp.stem)))
        return cards
```

---

## 5. Observer Bus

```python
# prismpocket/observer.py
import time
from collections import defaultdict
from typing import Callable, Any

class _ObserverBus:
    """
    Simple synchronous event dispatcher.
    """
    def __init__(self):
        self._handlers: dict[str, list[Callable[..., Any]]] = defaultdict(list)

    def subscribe(self, topic: str, handler: Callable[..., Any]) -> None:
        self._handlers[topic].append(handler)

    def emit(self, topic: str, /, **payload: Any) -> None:
        event = {"topic": topic, "timestamp": time.time(), **payload}
        for handler in self._handlers.get(topic, ()):
            try:
                handler(event)
            except Exception as exc:    # noqa: BLE001
                # Ensure one faulty handler won't break the chain
                print(f"[ObserverBus] handler error on {topic}: {exc}")

observer_bus = _ObserverBus()
```

---

## 6. Adapter Layer

### 6.1 CameraAdapter

```python
class CameraAdapter:
    """
    Facade around platform camera API.
    """
    def capture_photo(self, *, quality: int = 80) -> str:
        """
        Launch native camera, capture photo, return local path.
        """
        # On iOS/Android this is forwarded to native plugin
        raise NotImplementedError("Platform-specific implementation required")
```

### 6.2 BiometricAdapter

```python
class BiometricAdapter(metaclass=Singleton):
    """
    Used for secure notebooks that require biometric unlock.
    """
    _initialized = False

    def __init__(self):
        if BiometricAdapter._initialized:
            return
        # Heavy init code here...
        BiometricAdapter._initialized = True

    def authenticate(self) -> bool:
        """
        Return True if fingerprint/FaceID succeeds.
        """
        raise NotImplementedError
```

### 6.3 PushAdapter

```python
class PushAdapter:
    """
    Schedules local notifications and registers remote push tokens.
    """
    def register_token(self, token: str) -> None: ...
    def schedule_local(self, title: str, body: str, when: datetime): ...
```

---

## 7. View-Model Layer

```python
# prismpocket/viewmodels/card_vm.py
from rx.subject import BehaviorSubject

class CardViewModel:
    """
    Reactive wrapper that feeds UI-ready state to SwiftUI/Compose.
    """
    def __init__(self, repo: PrismCardRepository):
        self._repo = repo
        self.cards = BehaviorSubject([])  # List[PrismCard]
        self.refresh()

        observer_bus.subscribe("card.saved", lambda _: self.refresh())
        observer_bus.subscribe("card.deleted", lambda _: self.refresh())

    def refresh(self) -> None:
        self.cards.on_next(self._repo.list())

    def create_card(self, **kwargs) -> PrismCard:
        card = PrismCard(**kwargs)
        return self._repo.save(card)
```

---

## 8. Factory & Singleton Utilities

```python
# prismpocket/factories.py
def create_local_card(*, title: str, media_path: str, palette: list[str]) -> PrismCard:
    """
    Convenience factory to inject defaults and validations.
    """
    if not palette:
        raise ValueError("Palette must contain at least one HEX value")
    return PrismCard(title=title, media_path=media_path, palette=palette)
```

Singleton pattern mix-in:

```python
class Singleton(type):
    _instances: dict[type, object] = {}
    def __call__(cls, *args, **kwargs):
        if cls not in cls._instances:
            cls._instances[cls] = super().__call__(*args, **kwargs)
        return cls._instances[cls]
```

---

## 9. Cloud Sync Endpoints

`POST /v1/cards`  
Ingest or update a PrismCard.  

Request body:

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "title": "Park Sketch",
  "media_url": "https://cdn.prismpocket.app/asset/abc.jpeg",
  "palette": ["#FF0088", "#8800FF"],
  "created_at": "2024-03-18T12:34:56Z"
}
```

`GET /v1/cards/{id}` → 200 OK | 404 Not Found

Additional endpoints: `/palettes`, `/metrics`, `/suggestions`.

---

## 10. Error Handling Strategy

- Domain layer raises *ValueError* or *EntityError* (subclass of Exception).
- Repositories wrap I/O exceptions in *RepositoryError*.
- Adapters propagate platform errors untouched but are logged centrally
  via the CrashReporter singleton.
- ObserverBus protects the pipeline by catching and printing handler
  exceptions (non-fatal).

---

## 11. Extension Points

1. **Custom Filters**  
   Implement `AbstractFilter` (see `prismpocket/filters/base.py`) and
   register via `FilterRegistry.register()`.

2. **Storage Engines**  
   Adhere to `PrismCardRepo` protocol and pass instance to
   `CardViewModel`.

3. **Analytics Pipelines**  
   Subscribe to Observer topics and push anonymized events to an
   external provider.

---

## 12. Changelog

### 1.5.0
- Public Observer Bus now thread-safe.
- Added `PaletteMetric.mood_score`.
- Repository factory can create in-memory stores.

### 1.4.2
- CrashReporter integration with Sentry.
- CameraAdapter supports 60 fps burst mode.

---
© 2024 PrismPocket Labs
```