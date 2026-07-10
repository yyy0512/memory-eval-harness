```markdown
# QuestSmith: Productivity RPG Forge
[![license](https://img.shields.io/github/license/your-org/questsmith)](LICENSE)
[![build](https://github.com/your-org/questsmith/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/questsmith/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/your-org/questsmith/branch/main/graph/badge.svg)](https://codecov.io/gh/your-org/questsmith)

QuestSmith turns your everyday tasks, habits, and events into a **mobile RPG adventure**.  
Forge quests from calendar items, reminders, or location triggers—complete them in real life to earn loot, XP, and achievements in the game world.

---

## Table of Contents
1. [Why QuestSmith?](#why-questsmith)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Quick Start](#quick-start)
5. [Folder Structure](#folder-structure)
6. [Code Samples](#code-samples)
7. [Contributing](#contributing)
8. [License](#license)

---

## Why QuestSmith?
Traditional productivity apps track tasks; QuestSmith rewards them. By **gamifying** daily routines with an adaptive difficulty system, social leaderboards, and real-time analytics, QuestSmith keeps you motivated and accountable—_even when you’re offline_.

* **Intrinsic Motivation** – Level-up mechanics and meaningful narrative arcs.
* **Adaptive Difficulty** – Quests dynamically scale to match your consistency.
* **Seamless Integration** – Calendar, reminders, biometrics, and location services are wrapped in Python adapters, so the core logic stays pure and portable.

---

## Features
| Category              | Highlights                                                         |
|-----------------------|--------------------------------------------------------------------|
| Gameplay              | Leveling, crafting, cosmetic skins, loot crates                    |
| Productivity Utility  | Calendar sync, habit streaks, Pomodoro timer                       |
| Security & Privacy    | Biometric unlock, offline-first SQLite store                       |
| Social                | Friend lists, co-op quests, cross-platform leaderboards            |
| Platform Services     | Push notifications, crash reporting, in-app purchases, sharing     |

---

## Architecture
QuestSmith is a **single-process Kivy application** built around five key patterns:

1. **MVVM** – Clean separation between UI, Presentation Logic, and Models.
2. **Repository Pattern** – Centralized data access (SQLite) via `QuestRepository`.
3. **Observer Pattern** – `EventBus` notifies UI and services of quest state changes.
4. **Factory Pattern** – Swappable service providers (`LocationFactory`, `CrashReporterFactory`, etc.).
5. **Adapter Pattern** – Lightweight wrappers for platform APIs to keep the core domain platform-agnostic.

```
core/
├── adapters/          # Platform wrappers (location, IAP, sharing, biometrics)
├── analytics/         # Real-time insights and difficulty balancer
├── data/              # Repository layer & SQLite helpers
├── domain/            # Pure business logic (quests, rewards, inventory)
├── ui/                # Kivy views + view-models (MVVM)
└── utils/             # Common utilities & error handling
```

---

## Quick Start

### 1. Prerequisites
* Python 3.10+
* Poetry 1.5+
* Kivy 2.3+
* Android SDK / Xcode (for mobile builds)

### 2. Clone & Install
```bash
git clone https://github.com/your-org/questsmith.git
cd questsmith
poetry install --all-extras
```

### 3. Run on Desktop
```bash
poetry run questsmith
```

### 4. Build for Android (Kivy-MD + Buildozer)
```bash
poetry run buildozer android debug
adb install bin/QuestSmith-debug.apk
```

### 5. Run Unit Tests
```bash
poetry run pytest -q
```

---

## Folder Structure
```
questsmith/
│
├── core/                     # Application code
│   ├── adapters/             # Platform adapters (LocationAdapter, CrashReporter...)
│   ├── analytics/            # Engagement metrics & adaptive difficulty
│   ├── data/                 # Repository layer & database migrations
│   ├── domain/               # Pure Python game logic
│   ├── ui/                   # Kivy views, viewmodels, widgets
│   └── utils/                # Logging, error handling, time helpers
│
├── assets/                   # Images, sound, localisation
├── scripts/                  # Dev-ops & build scripts
├── tests/                    # Pytest suite with fixtures & mocks
└── buildozer.spec            # Android build configuration
```

---

## Code Samples

### Creating a Quest from a Calendar Event
```python
from datetime import datetime, timedelta

from core.domain.models import Quest, Reward
from core.data.repositories import QuestRepository
from core.event_bus import EventBus, QuestCreated

repo = QuestRepository()
bus = EventBus()

def forge_calendar_event(event):
    """Convert a synced calendar event into an in-game quest."""
    quest = Quest(
        id=event.uid,
        title=event.summary,
        description=event.description,
        due_date=event.start,
        reward=Reward(
            xp=25,
            gold=15,
            materials={"iron_ore": 2}
        ),
        location=event.location  # Optional GPS coords
    )
    repo.add(quest)
    bus.publish(QuestCreated(quest_id=quest.id))

# Example usage
calendar_event = CalendarEvent(
    uid="meet-123",
    summary="Team Stand-up",
    description="Daily sync with the dev team.",
    start=datetime.now() + timedelta(hours=1),
    location=None,
)
forge_calendar_event(calendar_event)
```

### Observing Quest Completion
```python
from core.event_bus import EventBus, QuestCompleted

def on_quest_completed(event: QuestCompleted) -> None:
    """Reward the player & schedule a confetti animation."""
    reward = repo.claim_reward(event.quest_id)
    show_reward_dialog(reward)
    analytics.track("quest_completed", quest_id=event.quest_id)

EventBus().subscribe(QuestCompleted, on_quest_completed)
```

### Repository Unit Test (Pytest)
```python
import pytest
from datetime import datetime

from core.data.repositories import QuestRepository
from core.domain.models import Quest

@pytest.fixture
def repo(tmp_path):
    return QuestRepository(db_path=tmp_path / "test.db")

def test_add_and_get_quest(repo):
    quest = Quest(
        id="unit1",
        title="Write Tests",
        description="Add coverage to repository layer.",
        due_date=datetime.utcnow(),
    )
    repo.add(quest)
    fetched = repo.get("unit1")
    assert fetched.title == "Write Tests"
```

---

## Contributing
Pull requests are welcome! Please follow the [CONTRIBUTING](CONTRIBUTING.md) guide.

1. Fork the repo & create your feature branch (`git checkout -b feature/awesome`).
2. Commit your changes with conventional commits.
3. Ensure the test suite passes (`poetry run pytest`).
4. Create a PR against `main`.

We value inclusivity and adhere to a [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License
QuestSmith is released under the MIT License.  
© 2023–Present QuestSmith Contributors
```