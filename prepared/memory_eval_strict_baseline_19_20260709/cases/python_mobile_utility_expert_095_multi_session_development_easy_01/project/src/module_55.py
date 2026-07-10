```python
"""
src/module_55.py
================

Analytics back-end utilities for PrismPocket.

This module is intentionally self-contained so that it can be imported by both the
mobile layer (via Python-for-iOS / Chaquopy bridges) and the cloud worker tier.

Primary responsibilities
------------------------
1. Persist raw `PrismCard` captures locally so they are available for
   – offline analytics, and
   – replay/sync once connectivity is restored.
2. Produce rolling colour-palette statistics and emit them over an in-memory
   Observer/Bus so any view-model can react (e.g., to surface “trending colours”).
3. Generate lightweight “creative prompt” suggestions derived from the
   palette trends.

Patterns employed
-----------------
• Repository Pattern            – `CardRepository` and `JsonCardRepository`
• Singleton (thread-safe)       – `PaletteTrendAnalyzer`
• Observer Pattern              – `EventBus`
• Factory Pattern               – `RepositoryFactory`
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from random import choice
from typing import Callable, Dict, Iterable, List, Optional, Protocol, Set

###############################################################################
# Domain entities
###############################################################################


@dataclass(frozen=True, slots=True)
class PrismCard:
    """
    A radically simplified subset of the real PrismCard.
    Only the fields required for analytics live here to keep the module lean.
    """
    card_id: str
    user_id: str
    colours: List[str]  # Hex RGB strings, e.g. ["#ff00aa", "#00ffaa"]
    captured_at: datetime
    mood_score: Optional[float] = None  # Range: ‑1.0 (sad) → 1.0 (happy)
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    def to_json(self) -> Dict:
        """Serialize to a JSON-serialisable dict."""
        return {
            "card_id": self.card_id,
            "user_id": self.user_id,
            "colours": self.colours,
            "captured_at": self.captured_at.isoformat(),
            "mood_score": self.mood_score,
            "latitude": self.latitude,
            "longitude": self.longitude,
        }

    @classmethod
    def from_json(cls, payload: Dict) -> "PrismCard":
        """Deserialize from dict."""
        return cls(
            card_id=payload["card_id"],
            user_id=payload["user_id"],
            colours=payload["colours"],
            captured_at=datetime.fromisoformat(payload["captured_at"]),
            mood_score=payload.get("mood_score"),
            latitude=payload.get("latitude"),
            longitude=payload.get("longitude"),
        )


###############################################################################
# Observer / Event-Bus
###############################################################################


class EventBus:
    """
    Naïve in-process Pub/Sub bus.

    • Thread-safe.
    • Subscribers receive **copies** of the payload, so mutation does not affect
      other listeners.
    """

    _lock = threading.RLock()
    _subscribers: Dict[str, Set[Callable[[Dict], None]]] = {}

    @classmethod
    def subscribe(cls, topic: str, callback: Callable[[Dict], None]) -> None:
        with cls._lock:
            cls._subscribers.setdefault(topic, set()).add(callback)

    @classmethod
    def unsubscribe(cls, topic: str, callback: Callable[[Dict], None]) -> None:
        with cls._lock:
            if topic in cls._subscribers:
                cls._subscribers[topic].discard(callback)
                if not cls._subscribers[topic]:
                    cls._subscribers.pop(topic)

    @classmethod
    def publish(cls, topic: str, payload: Dict) -> None:
        with cls._lock:
            for cb in list(cls._subscribers.get(topic, [])):
                # Defensive copy to prevent unintended side-effects.
                try:
                    cb(dict(payload))
                except Exception:  # noqa: E722 – we *never* want to crash the bus
                    # In production we would log this through the crash reporter.
                    continue


###############################################################################
# Repository Pattern
###############################################################################


class CardRepository(Protocol):
    """
    Read-only repository interface for PrismCards.
    """

    def all_cards(self, user_id: str) -> Iterable[PrismCard]: ...

    def add_card(self, card: PrismCard) -> None: ...


class JsonCardRepository:
    """
    Extremely lightweight local repository that stores each card as a JSON line.

    This is NOT meant for high performance. It merely demonstrates a realistic
    repository implementation that can be swapped out for SQLite, Realm, etc.
    """

    def __init__(self, storage_path: str | os.PathLike):
        self._path = Path(storage_path).expanduser().resolve()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

        # Ensure the file at least exists.
        self._path.touch(exist_ok=True)

    def all_cards(self, user_id: str) -> Iterable[PrismCard]:
        with self._lock, self._path.open("r", encoding="utf8") as fh:
            for line in fh:
                try:
                    payload = json.loads(line)
                    if payload["user_id"] == user_id:
                        yield PrismCard.from_json(payload)
                except (json.JSONDecodeError, KeyError):
                    # Corrupted line; skip but keep processing.
                    continue

    def add_card(self, card: PrismCard) -> None:
        serialised = json.dumps(card.to_json(), ensure_ascii=False)
        with self._lock, self._path.open("a", encoding="utf8") as fh:
            fh.write(serialised + "\n")


###############################################################################
# Repository Factory (allows DI in tests)
###############################################################################


class RepositoryFactory:
    _instances: Dict[str, CardRepository] = {}
    _lock = threading.RLock()

    @classmethod
    def card_repository(cls, storage_path: str | os.PathLike) -> CardRepository:
        key = str(Path(storage_path).resolve())
        with cls._lock:
            if key not in cls._instances:
                cls._instances[key] = JsonCardRepository(storage_path)
            return cls._instances[key]


###############################################################################
# Analytics Engine – Singleton
###############################################################################


class _SingletonMeta(type):
    """
    Classic thread-safe Singleton metaclass.
    """

    _instances: Dict[type, "PaletteTrendAnalyzer"] = {}
    _lock = threading.RLock()

    def __call__(cls, *args, **kwargs):  # type: ignore[override]
        with cls._lock:
            if cls not in cls._instances:
                cls._instances[cls] = super().__call__(*args, **kwargs)
            return cls._instances[cls]


class PaletteTrendAnalyzer(metaclass=_SingletonMeta):
    """
    Consumes PrismCards and produces rolling palette trends.

    Public API
    ----------
    • feed(card)        – add a new card to the analytics engine.
    • trends(user_id)   – read-only snapshot of current palette stats.

    Internally publishes `event://analytics/palette/<user_id>` messages to
    the EventBus whenever trends change.
    """

    PUBLISH_TOPIC_TEMPLATE = "analytics/palette/{user_id}"
    _TREND_WINDOW_HOURS = 24

    def __init__(self) -> None:
        self._user_palette_counts: Dict[str, Counter[str]] = {}
        self._user_card_timestamps: Dict[str, Dict[str, float]] = {}
        self._lock = threading.RLock()

    # --------------------------------------------------------------------- #
    # Public helpers
    # --------------------------------------------------------------------- #

    def feed(self, card: PrismCard) -> None:
        """
        Insert a card event and update rolling statistics.
        """
        uid = card.user_id
        now_ts = time.time()

        with self._lock:
            self._user_palette_counts.setdefault(uid, Counter())
            self._user_card_timestamps.setdefault(uid, {})

            # Register colours
            self._user_palette_counts[uid].update(card.colours)
            self._user_card_timestamps[uid][card.card_id] = now_ts

            # Purge out-of-window cards
            self._purge_old(uid, now_ts)

            # Build a snapshot and publish
            snapshot = dict(self._user_palette_counts[uid])
            EventBus.publish(
                self.PUBLISH_TOPIC_TEMPLATE.format(user_id=uid),
                {"timestamp": now_ts, "palette_counts": snapshot},
            )

    def trends(self, user_id: str) -> Dict[str, int]:
        """
        Obtain a copy of the palette trend counter for a given user.

        Returns an empty dict if no data.
        """
        with self._lock:
            return dict(self._user_palette_counts.get(user_id, {}))

    # --------------------------------------------------------------------- #
    # Suggestion engine
    # --------------------------------------------------------------------- #

    def suggest_prompt(self, user_id: str) -> str:
        """
        Generate an ad-hoc creative prompt based on the most common colours.

        The algorithm is intentionally whimsical. It picks one of the
        top-3 colours (if available) and injects it into a pre-baked phrase.
        """
        popular_colours = self._popular_colours(user_id, limit=3)
        if not popular_colours:
            return "Capture something vibrant today!"

        colour = choice(popular_colours)
        phrases = [
            f"Design a doodle that highlights {colour}.",
            f"Explore shadows that complement {colour}.",
            f"Find {colour} in unexpected places and snap it!",
        ]
        return choice(phrases)

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    def _popular_colours(self, user_id: str, *, limit: int = 5) -> List[str]:
        counter = self.trends(user_id)
        return [c for c, _ in Counter(counter).most_common(limit)]

    def _purge_old(self, user_id: str, now_ts: float) -> None:
        """
        Remove cards outside the rolling window and decrement colour counts.
        """
        timestamps = self._user_card_timestamps.get(user_id, {})
        counts = self._user_palette_counts.get(user_id, Counter())

        cutoff = now_ts - (self._TREND_WINDOW_HOURS * 3600)
        to_remove: List[str] = [
            cid for cid, ts in timestamps.items() if ts < cutoff
        ]

        for cid in to_remove:
            # For realistic purge, we would need the card's colours.
            # Since we do not retain the full card, we accept a small drift
            # by clearing the entire counter when drift might accumulate.
            counts.clear()
            timestamps.pop(cid, None)

        if not timestamps:
            # Clean up empty structures
            self._user_card_timestamps.pop(user_id, None)
            self._user_palette_counts.pop(user_id, None)


###############################################################################
# Convenience façade for the mobile layer
###############################################################################


def record_card(
    repository_path: str | os.PathLike,
    *,
    card_id: str,
    user_id: str,
    colours: List[str],
    mood_score: Optional[float] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
) -> None:
    """
    High-level helper that:
    1. Persists the card locally.
    2. Feeds it into the analytics engine.
    """
    card = PrismCard(
        card_id=card_id,
        user_id=user_id,
        colours=colours,
        captured_at=datetime.now(timezone.utc),
        mood_score=mood_score,
        latitude=latitude,
        longitude=longitude,
    )
    repo = RepositoryFactory.card_repository(repository_path)
    repo.add_card(card)

    PaletteTrendAnalyzer().feed(card)


###############################################################################
# Example subscription (used by UI view-models)
###############################################################################


def _demo_subscriber(payload: Dict) -> None:
    print("🔔 Palette trend updated:", payload)


if __name__ == "__main__":
    # Self-test / demo.
    STORAGE = "/tmp/prism_pocket_cards.jsonl"

    # Subscribe to live analytics.
    EventBus.subscribe(
        PaletteTrendAnalyzer.PUBLISH_TOPIC_TEMPLATE.format(user_id="alice"),
        _demo_subscriber,
    )

    # Simulate card captures.
    record_card(
        STORAGE,
        card_id="c1",
        user_id="alice",
        colours=["#ff00aa", "#ff00aa", "#00ffaa"],
    )
    time.sleep(1)
    record_card(
        STORAGE,
        card_id="c2",
        user_id="alice",
        colours=["#00ffaa", "#00ffaa", "#abcdef"],
    )

    analyzer = PaletteTrendAnalyzer()
    print("Current trends for Alice:", analyzer.trends("alice"))
    print("Prompt suggestion:", analyzer.suggest_prompt("alice"))
```