```python
"""
PrismPocket – Palette Analytics Module
--------------------------------------

This module wires the Observer pattern to an in-app analytics routine that keeps
track of the most popular colour palettes used across all prism cards.  The
metrics power discovery features such as “Trending Palettes” and contextual
creative prompts.

Key components
==============

EventBus                – Thread-safe singleton, pub/sub message hub
PrismCard               – Minimal domain model representation
PaletteMetricRepository – Repository (with local persistence) for palette counts
PaletteTrendAnalyzer    – Observer that updates metrics from card events

The module purposefully keeps I/O concerns inside the repository so that the
rest of the codebase remains pure and trivially unit-testable.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Callable, DefaultDict, Dict, Iterable, List, Sequence, Tuple, Type

LOGGER = logging.getLogger("prism_pocket.palette_analytics")
LOGGER.setLevel(logging.INFO)

# ----------------------------- Domain / Events ----------------------------- #


class ImmutableTuple(tuple):
    """Helper to guarantee hashability for colour lists."""

    def __hash__(self) -> int:  # pylint: disable=useless-super-delegation
        return super().__hash__()


class PrismCard:
    """
    Minimal domain representation of a PrismCard.

    In the real codebase this class would be imported from ``core.domain`` but
    we provide a lightweight stand-in here to keep the module self-contained.
    """

    __slots__ = ("card_id", "user_id", "palette", "created_at", "updated_at")

    def __init__(
        self,
        card_id: str,
        user_id: str,
        palette: Sequence[str],
        *,
        created_at: datetime | None = None,
        updated_at: datetime | None = None,
    ) -> None:
        # Basic validation
        if not palette:
            raise ValueError("Palette cannot be empty.")
        if any(not c.startswith("#") or len(c) not in (4, 7) for c in palette):
            raise ValueError(f"Invalid colour codes in {palette!r}")

        self.card_id: str = card_id
        self.user_id: str = user_id
        self.palette: ImmutableTuple = ImmutableTuple(palette)
        now = datetime.utcnow()
        self.created_at: datetime = created_at or now
        self.updated_at: datetime = updated_at or now

    # Convenience methods (equality needed for unit-tests)
    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, PrismCard)
            and self.card_id == other.card_id
            and self.palette == other.palette
        )

    def __repr__(self) -> str:
        return (
            f"PrismCard(id={self.card_id!r}, user={self.user_id!r}, "
            f"palette={list(self.palette)!r})"
        )


class CardEvent:
    """Base class for events emitted from the Repository layer."""

    __slots__ = ("card", "timestamp")

    def __init__(self, card: PrismCard) -> None:
        self.card: PrismCard = card
        self.timestamp: datetime = datetime.utcnow()


class CardCreatedEvent(CardEvent):
    """Event fired whenever a new card hits the local repository."""


class CardUpdatedEvent(CardEvent):
    """Event fired whenever an existing card was remixed/updated."""


# --------------------------- Observer / Event Bus --------------------------- #


Subscriber = Callable[[CardEvent], None]


class EventBus:
    """
    Thread-safe singleton implementing a lightweight Observer (pub/sub) bus. It
    can be used app-wide to decouple producers and consumers.
    """

    _instance: "EventBus | None" = None
    _instance_lock = threading.Lock()

    # --------------------------------------------------------------------- #
    # Singleton boilerplate
    # --------------------------------------------------------------------- #
    def __new__(cls) -> "EventBus":  # noqa: D401
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._subscribers = defaultdict(list)  # type: ignore
                    cls._instance._bus_lock = threading.RLock()  # type: ignore
        return cls._instance

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    def subscribe(self, event_type: Type[CardEvent], subscriber: Subscriber) -> None:
        """
        Subscribe a callable to specific event type.

        The callable must accept exactly one positional argument – the event
        instance. Duplicate registrations are ignored.
        """
        with self._bus_lock:
            subs: List[Subscriber] = self._subscribers[event_type]
            if subscriber not in subs:
                subs.append(subscriber)
                LOGGER.debug(
                    "Subscriber %s added to %s", subscriber.__qualname__, event_type.__name__
                )

    def unsubscribe(self, event_type: Type[CardEvent], subscriber: Subscriber) -> None:
        """Remove subscriber from the event stream (if previously registered)."""
        with self._bus_lock:
            try:
                self._subscribers[event_type].remove(subscriber)
                LOGGER.debug(
                    "Subscriber %s removed from %s",
                    subscriber.__qualname__,
                    event_type.__name__,
                )
            except ValueError:
                LOGGER.warning(
                    "Tried to remove non-existent subscriber %s from %s",
                    subscriber,
                    event_type,
                )

    def publish(self, event: CardEvent) -> None:
        """Send event to all subscribers whose registered type matches."""
        with self._bus_lock:
            for event_type, subs in self._subscribers.items():
                if isinstance(event, event_type):
                    for subscriber in list(subs):  # copy to prevent mid-iteration edits
                        try:
                            subscriber(event)
                        except Exception as exc:  # pylint: disable=broad-except
                            LOGGER.exception(
                                "Error while notifying subscriber %s: %s",
                                subscriber,
                                exc,
                            )


# ---------------------------- Analytics / Storage --------------------------- #


class PaletteMetricRepository:
    """
    Repository that stores palette occurrence counts.

    Persistence is backed by a local JSON file so that metrics survive app
    restarts.  Call :py:meth:`sync` periodically (or on app close) to flush
    in-memory counters to disk.
    """

    _DEFAULT_PATH = Path.home() / ".prism_pocket" / "palette_metrics.json"

    def __init__(self, persistence_path: Path | None = None) -> None:
        self._persistence_path: Path = persistence_path or self._DEFAULT_PATH
        self._counter: Counter[Tuple[str, ...]] = Counter()
        self._lock = threading.RLock()

        self._persistence_path.parent.mkdir(parents=True, exist_ok=True)
        self._load_from_disk()

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #
    def increment(self, palette: Sequence[str]) -> None:
        """
        Increment usage count for the given colour palette.

        A palette is internally normalised to a tuple of lower-cased hex codes
        sorted in ascending order.  This ensures that duplicates with different
        ordering are considered equal.
        """
        key = self._normalise(palette)
        with self._lock:
            self._counter[key] += 1
            LOGGER.debug("Palette %s incremented to %d", key, self._counter[key])

    def top_palettes(self, limit: int = 5) -> List[Tuple[Tuple[str, ...], int]]:
        """
        Return the most commonly used palettes along with their hit counts.
        """
        with self._lock:
            return self._counter.most_common(limit)

    def reset(self) -> None:
        """Danger-zone helper — clears *all* tracked metrics."""
        with self._lock:
            self._counter.clear()
        LOGGER.warning("Palette metrics reset issued.")

    def sync(self) -> None:
        """
        Flush in-memory counter to disk.  The operation is idempotent and safe
        to call from multiple threads.
        """
        with self._lock:
            serialized: Dict[str, int] = {"|".join(key): count for key, count in self._counter.items()}
            tmp_path = self._persistence_path.with_suffix(".tmp")

            try:
                tmp_path.write_text(json.dumps(serialized, indent=2, sort_keys=True))
                tmp_path.replace(self._persistence_path)
                LOGGER.debug("Palette metrics persisted to %s", self._persistence_path)
            except OSError as exc:
                LOGGER.exception("Failed writing palette metrics: %s", exc)

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #
    def _load_from_disk(self) -> None:
        """Load previously saved metrics into the in-memory counter."""
        try:
            raw = self._persistence_path.read_text()
            data = json.loads(raw)
        except FileNotFoundError:
            LOGGER.info("No existing palette metrics found — starting fresh.")
            return
        except (OSError, json.JSONDecodeError) as exc:
            LOGGER.error("Corrupted palette metrics file: %s", exc)
            return

        with self._lock:
            for key, count in data.items():
                palette_tuple = tuple(key.split("|"))
                if all(color.startswith("#") for color in palette_tuple):
                    self._counter[palette_tuple] = int(count)
            LOGGER.info("Loaded %d palette metrics from disk.", len(self._counter))

    @staticmethod
    def _normalise(palette: Sequence[str]) -> Tuple[str, ...]:
        return tuple(sorted(c.lower() for c in palette))


# ------------------------- Analytics Observer Routine ----------------------- #


class PaletteTrendAnalyzer:
    """
    Observer that listens to card creation/update events and updates palette
    usage metrics in near real-time.
    """

    def __init__(self, repository: PaletteMetricRepository | None = None) -> None:
        self._repo = repository or PaletteMetricRepository()
        self._bus = EventBus()
        self._bus.subscribe(CardCreatedEvent, self._handle_card_event)
        self._bus.subscribe(CardUpdatedEvent, self._handle_card_event)
        LOGGER.info("PaletteTrendAnalyzer initialised and subscribed to card events.")

    # ------------------------------------------------------------------ #
    # Event handlers
    # ------------------------------------------------------------------ #
    def _handle_card_event(self, event: CardEvent) -> None:
        """
        Extract palette from the card and feed repository.  All heavy lifting is
        delegated to the repository for decoupling/testing ease.
        """
        try:
            self._repo.increment(event.card.palette)
            LOGGER.debug("Processed %s for card %s", type(event).__name__, event.card.card_id)
        except Exception as exc:  # pylint: disable=broad-except
            LOGGER.exception("Failed processing palette analytics: %s", exc)

    # ------------------------------------------------------------------ #
    # Public helpers (used by ViewModels, prompts engine, etc.)
    # ------------------------------------------------------------------ #
    def top_palettes(self, limit: int = 5) -> List[Tuple[Tuple[str, ...], int]]:
        return self._repo.top_palettes(limit)

    def shutdown(self) -> None:
        """
        Flush metrics to disk and unsubscribe from the bus.  Must be called from
        the application layer when analytics is no longer needed.
        """
        self._repo.sync()
        self._bus.unsubscribe(CardCreatedEvent, self._handle_card_event)
        self._bus.unsubscribe(CardUpdatedEvent, self._handle_card_event)
        LOGGER.info("PaletteTrendAnalyzer shutdown complete.")


# ------------------------------ Example Usage ------------------------------- #
# The below block is intentionally guarded so that importing the module won't
# execute the sample code.  In real production code, tests would live in
# dedicated test modules; here it's meant as a quick sanity check.
if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)

    analyzer = PaletteTrendAnalyzer()
    bus = EventBus()

    # Simulate card lifecycle events
    card1 = PrismCard("card_001", "user_a", ["#ff0000", "#00ff00", "#0000ff"])
    card2 = PrismCard("card_002", "user_b", ["#ff0000", "#00ff00", "#0000ff"])
    card3 = PrismCard("card_003", "user_c", ["#ffffff"])

    bus.publish(CardCreatedEvent(card1))
    bus.publish(CardCreatedEvent(card2))
    bus.publish(CardCreatedEvent(card3))

    print("Top Palettes:", analyzer.top_palettes(limit=3))

    analyzer.shutdown()
```