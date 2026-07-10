from __future__ import annotations

import asyncio
import logging
import threading
from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import (
    Any,
    Callable,
    Deque,
    Dict,
    Iterable,
    List,
    MutableMapping,
    Optional,
    Set,
    Tuple,
)

logger = logging.getLogger("prism_pocket.analytics")
logging.basicConfig(level=logging.INFO)

# ------------------------------------------------------------------------------
# Domain stubs & ✨ place-holders ✨
# ------------------------------------------------------------------------------


@dataclass(frozen=True)
class PrismCard:
    """
    A *very* trimmed-down placeholder for the actual domain entity.

    Only the properties needed by this module are included.
    """

    card_id: str
    user_id: str
    created_at: datetime
    palette: List[str]  # Hex colors, e.g. ["#ffcc00", "#000000"]
    mood_score: float   # -1.0 (sad) .. 1.0 (happy)


class CardRepositoryProtocol:
    """Protocol the real CardRepository must follow."""

    async def stream_created_cards(self) -> Iterable[PrismCard]:
        ...

    async def fetch_recent_cards(
        self,
        since: datetime,
        *,
        limit: int = 1_000,
    ) -> List[PrismCard]:
        ...


# ------------------------------------------------------------------------------
# Observer mix-in (minimalistic, thread-safe)
# ------------------------------------------------------------------------------


class Observable:
    """
    A super-lean implementation of the Observer pattern.

    Subscribers receive events through the callable they provide.  Callbacks are
    invoked *in the event loop* thread.  Heavy work should therefore be off-
    loaded to executors or background tasks.
    """

    def __init__(self) -> None:
        self._subscribers: Set[Callable[[Any], None]] = set()
        self._lock = threading.RLock()

    def subscribe(self, callback: Callable[[Any], None]) -> None:
        with self._lock:
            self._subscribers.add(callback)
            logger.debug("Subscriber %s added", callback)

    def unsubscribe(self, callback: Callable[[Any], None]) -> None:
        with self._lock:
            self._subscribers.discard(callback)
            logger.debug("Subscriber %s removed", callback)

    def _notify(self, payload: Any) -> None:
        with self._lock:
            subs_snapshot = list(self._subscribers)

        for callback in subs_snapshot:
            try:
                callback(payload)
            except Exception:  # pragma: no cover
                logger.exception("Subscriber callback failure")


# ------------------------------------------------------------------------------
# Analytics DTOs
# ------------------------------------------------------------------------------


@dataclass(frozen=True)
class PaletteTrend:
    fingerprint: str
    occurrences: int
    example_colors: List[str]


@dataclass(frozen=True)
class MoodTrend:
    average_mood: float
    sample_size: int


@dataclass(frozen=True)
class TrendDigest:
    generated_at: datetime
    palettes: List[PaletteTrend]
    mood: MoodTrend


# ------------------------------------------------------------------------------
# Utility functions
# ------------------------------------------------------------------------------


def _hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        raise ValueError(f"Invalid hex color: {hex_color}")
    r, g, b = (
        int(hex_color[0:2], 16),
        int(hex_color[2:4], 16),
        int(hex_color[4:6], 16),
    )
    return r, g, b


def _rgb_to_hsl(r: int, g: int, b: int) -> Tuple[float, float, float]:
    """Return H, S, L ‑ each in range 0..1."""
    r_, g_, b_ = r / 255.0, g / 255.0, b / 255.0
    max_c, min_c = max(r_, g_, b_), min(r_, g_, b_)
    l = (max_c + min_c) / 2

    if max_c == min_c:
        h = s = 0.0  # achromatic
    else:
        d = max_c - min_c
        s = d / (2 - max_c - min_c) if l > 0.5 else d / (max_c + min_c)

        if max_c == r_:
            h = (g_ - b_) / d + (6 if g_ < b_ else 0)
        elif max_c == g_:
            h = (b_ - r_) / d + 2
        else:
            h = (r_ - g_) / d + 4
        h /= 6

    return h, s, l


def _fingerprint_palette(colors: List[str], hue_bucket_size: int = 30) -> str:
    """
    Reduce palette to a *fingerprint* string suitable for similarity comparison.

    Colors are converted to hue (0..360°).  Each hue is bucketed into segments of
    `hue_bucket_size` degrees.  The unique, sorted bucket IDs are concatenated.
    """
    buckets: Set[int] = set()

    for hex_color in colors:
        try:
            r, g, b = _hex_to_rgb(hex_color)
            h, _, _ = _rgb_to_hsl(r, g, b)
            hue_deg = int(round(h * 360))
            bucket_id = (hue_deg // hue_bucket_size) * hue_bucket_size
            buckets.add(bucket_id)
        except ValueError:
            logger.debug("Skipping invalid color %s", hex_color, exc_info=False)

    return "-".join(map(str, sorted(buckets)))


# ------------------------------------------------------------------------------
# TrendAnalyzer (Singleton)
# ------------------------------------------------------------------------------


class TrendAnalyzer(Observable):
    """
    Collects real-time card events and produces high-level trend digests.

    The analyzer keeps a sliding window of recent cards.  When enough mutations
    have been observed (or a scheduled checkpoint triggers),  it emits a
    `TrendDigest` via the Observable interface.
    """

    _INSTANCE: Optional["TrendAnalyzer"] = None
    _SLIDING_WINDOW = timedelta(hours=12)
    _CHECKPOINT_INTERVAL = timedelta(minutes=5)
    _MAX_WINDOW_SIZE = 5_000

    def __new__(
        cls,
        card_repo: Optional[CardRepositoryProtocol] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> "TrendAnalyzer":
        if cls._INSTANCE is None:
            cls._INSTANCE = super().__new__(cls)
        return cls._INSTANCE

    def __init__(
        self,
        card_repo: Optional[CardRepositoryProtocol] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        # Ensure idempotent initialisation
        if hasattr(self, "_initialised") and self._initialised:
            return

        super().__init__()
        self._initialised = True
        self._loop = loop or asyncio.get_event_loop()
        self._repo: Optional[CardRepositoryProtocol] = card_repo
        self._cards: Deque[PrismCard] = deque(maxlen=self._MAX_WINDOW_SIZE)
        self._stop_event = asyncio.Event()
        self._checkpoint_task: Optional[asyncio.Task] = None
        self._ingest_task: Optional[asyncio.Task] = None

        logger.debug("TrendAnalyzer initialised")

    # ------------------------------------------------------------------ Public

    def start(self) -> None:
        """
        Spawn background tasks that continuously ingest cards and compute trends.
        """
        if self._repo is None:
            raise RuntimeError("Card repository not configured")

        if self._checkpoint_task is None:
            self._checkpoint_task = self._loop.create_task(self._checkpoint_loop())
            self._ingest_task = self._loop.create_task(self._ingest_loop())
            logger.info("TrendAnalyzer background tasks started")

    def stop(self) -> None:
        """
        Gracefully stop background tasks.  May be restarted afterwards.
        """
        self._stop_event.set()
        for task in (self._checkpoint_task, self._ingest_task):
            if task:
                task.cancel()
        self._checkpoint_task = self._ingest_task = None
        self._stop_event.clear()
        logger.info("TrendAnalyzer stopped")

    # ------------------------------------------------------------ Async loops

    async def _ingest_loop(self) -> None:
        """
        Listen to the repository's card stream and push each item into window.
        """
        assert self._repo is not None  # mypy hint

        try:
            async for card in self._repo.stream_created_cards():
                self._append_card(card)
        except asyncio.CancelledError:
            logger.debug("Ingest loop cancelled")
            raise
        except Exception:  # pragma: no cover
            logger.exception("Ingest loop encountered fatal error")

    async def _checkpoint_loop(self) -> None:
        """
        Periodically compute trends and notify observers.
        """
        try:
            while not self._stop_event.is_set():
                await asyncio.sleep(self._CHECKPOINT_INTERVAL.total_seconds())
                digest = self._compute_digest()
                self._notify(digest)
        except asyncio.CancelledError:
            logger.debug("Checkpoint loop cancelled")
            raise

    # ------------------------------------------------------------- Processing

    def _append_card(self, card: PrismCard) -> None:
        """
        Add card to sliding window; purge outdated entries.
        """
        self._cards.append(card)
        threshold = datetime.utcnow() - self._SLIDING_WINDOW

        while self._cards and self._cards[0].created_at < threshold:
            self._cards.popleft()

        # Compute digest on significant mutations to keep observers lively
        if len(self._cards) % 50 == 0:
            digest = self._compute_digest()
            self._notify(digest)

    def _compute_digest(self) -> TrendDigest:
        """
        Produce a snapshot of current trends.
        """
        now = datetime.utcnow()
        threshold = now - self._SLIDING_WINDOW
        window_cards = [c for c in self._cards if c.created_at >= threshold]

        palette_counter: Counter[str] = Counter()
        mood_sum = 0.0

        for card in window_cards:
            fp = _fingerprint_palette(card.palette)
            if fp:
                palette_counter[fp] += 1
            mood_sum += card.mood_score

        top_palettes = palette_counter.most_common(5)
        palette_trends: List[PaletteTrend] = [
            PaletteTrend(
                fingerprint=fp,
                occurrences=count,
                example_colors=self._example_colors_for(fp, window_cards),
            )
            for fp, count in top_palettes
        ]

        avg_mood = mood_sum / len(window_cards) if window_cards else 0.0
        mood_trend = MoodTrend(average_mood=avg_mood, sample_size=len(window_cards))

        digest = TrendDigest(
            generated_at=now,
            palettes=palette_trends,
            mood=mood_trend,
        )

        logger.debug("TrendDigest generated (window=%s): %s", len(window_cards), digest)
        return digest

    # ----------------------------------------------------------- Prompt logic

    def suggest_prompt(self, user_id: str) -> str:
        """
        Generate a creative prompt tailored to the current trend landscape.

        NOTE: This heuristic is deliberately simple.  A real-world solution would
        use ML models and user preferences for richer output.
        """
        digest = self._compute_digest()

        if not digest.palettes:
            return "Capture something that defines *your* unique palette today!"

        top_palette = digest.palettes[0]
        mood = digest.mood.average_mood

        mood_descriptor = (
            "joyful"
            if mood > 0.3
            else "melancholic"
            if mood < -0.3
            else "contemplative"
        )
        colors = ", ".join(top_palette.example_colors[:3])

        prompt = (
            f"Feeling {mood_descriptor}? Craft a new PrismCard inspired by "
            f"the hues {colors}—let your imagination run wild!"
        )
        logger.debug("Prompt for user %s: %s", user_id, prompt)
        return prompt

    # ----------------------------------------------------------- Helper utils

    @staticmethod
    def _example_colors_for(
        fingerprint: str, cards: Iterable[PrismCard]
    ) -> List[str]:
        """
        Grab an example set of colors for a given fingerprint from the dataset.
        """
        for c in cards:
            if _fingerprint_palette(c.palette) == fingerprint:
                return c.palette[:5]
        return []

    # ----------------------------------------------------------- Configuration

    def reconfigure_repository(self, repo: CardRepositoryProtocol) -> None:
        """
        Hot-swap the card repository; typically used for tests or when changing
        storage back-ends at runtime.
        """
        if self._repo is repo:
            return
        if self._ingest_task:
            self.stop()  # Stop tasks linked to old repo
        self._repo = repo
        logger.info("TrendAnalyzer repository swapped")
        self.start()


# ------------------------------------------------------------------------------
# Convenience factory function
# ------------------------------------------------------------------------------


def get_trend_analyzer(
    repo: CardRepositoryProtocol,
    loop: Optional[asyncio.AbstractEventLoop] = None,
) -> TrendAnalyzer:
    """
    Factory to obtain the singleton TrendAnalyzer with the desired repository.
    """
    analyzer = TrendAnalyzer(repo, loop=loop)
    if repo is not None:
        analyzer.reconfigure_repository(repo)
    return analyzer


# ------------------------------------------------------------------------------
# When executed standalone, spin up a self-contained demo
# ------------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    import random
    import sys

    class MockRepo(CardRepositoryProtocol):
        async def stream_created_cards(self) -> Iterable[PrismCard]:
            """
            Emit random cards every second to exercise the analyzer.
            """
            while True:
                await asyncio.sleep(1)
                yield self._random_card()

        async def fetch_recent_cards(
            self,
            since: datetime,
            *,
            limit: int = 1_000,
        ) -> List[PrismCard]:
            return [self._random_card() for _ in range(10)]

        @staticmethod
        def _random_color() -> str:
            return "#{:06x}".format(random.randint(0, 0xFFFFFF))

        def _random_card(self) -> PrismCard:
            palette = [self._random_color() for _ in range(random.randint(2, 6))]
            return PrismCard(
                card_id=str(random.randint(1000, 9999)),
                user_id="demo",
                created_at=datetime.utcnow(),
                palette=palette,
                mood_score=random.uniform(-1.0, 1.0),
            )

    async def main() -> None:
        repo = MockRepo()
        analyzer = get_trend_analyzer(repo)

        def console_sink(digest: TrendDigest) -> None:
            logger.info("Digest: %s", digest)

        analyzer.subscribe(console_sink)
        analyzer.start()

        # Run for a short while then exit
        await asyncio.sleep(20)
        analyzer.stop()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
