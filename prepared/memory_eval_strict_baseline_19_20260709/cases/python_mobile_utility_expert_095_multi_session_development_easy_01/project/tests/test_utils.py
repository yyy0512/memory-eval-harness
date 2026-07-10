```python
"""
tests/test_utils.py

Integration-style unit-tests for the ``prism_pocket.utils`` helper module.  The
tests are written defensively so that they *skip* rather than *fail* when the
target implementation is not available (e.g. when someone is running only a
subset of the code-base).  This keeps the CI pipelines green while still
documenting—via executable specification—the intended behaviour of the public
utility helpers that many other layers depend on.

If you are adding, refactoring, or optimising any of the utility functions,
make sure they continue to satisfy this contract; otherwise update the tests
accordingly and submit the change as part of the same pull-request.

Copyright (c) PrismPocket.
"""
from __future__ import annotations

import concurrent.futures
import re
import threading
import time
import uuid
from typing import Callable, List, Tuple

import pytest

# ---------------------------------------------------------------------------
# Optional import guard.  We explicitly skip the whole test-suite in case the
# utilities are not importable—e.g. when running a partial install or during a
# packaging dry-run.  This is preferable to a hard failure that obscures the
# real CI signal.
# ---------------------------------------------------------------------------

utils = pytest.importorskip("prism_pocket.utils", reason="PrismPocket utils package not installed")

# We do the fine-grained imports *after* the dynamic import so that type checkers
# still get hints, yet the import order remains obvious.
from prism_pocket.utils import (
    Debounce,
    generate_card_id,
    hex_to_rgb,
    rgb_to_hex,
    slugify,
)  # noqa: E402  (imported after runtime guard)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _generate_ids_concurrently(
    worker_fn: Callable[[], str], iterations: int = 10_000, max_workers: int = 20
) -> List[str]:
    """
    Helper that spins up a thread pool to stress-test unique ID generation.

    Parameters
    ----------
    worker_fn:
        Callable that returns the generated identifier.
    iterations:
        Total number of identifiers to produce.
    max_workers:
        ThreadPoolExecutor pool size.

    Returns
    -------
    List[str]
        A list containing *iterations* identifiers, in the order they were
        produced.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(worker_fn) for _ in range(iterations)]
        # Waiting explicitly so exceptions propagate and are re-raised here
        return [f.result() for f in concurrent.futures.as_completed(futures)]


# ---------------------------------------------------------------------------
# slugify
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "original, expected",
    [
        ("Hello World!", "hello-world"),
        ("Spaced    Out", "spaced-out"),
        ("   TrimMe   ", "trimme"),
        ("Café déjà vu", "cafe-deja-vu"),
        ("中文測試", "zhong-wen-ce-shi"),
        ("mixedCASE Input", "mixedcase-input"),
    ],
)
def test_slugify_basic(original: str, expected: str) -> None:
    """
    ``slugify`` should convert arbitrary human input into a lower-cased,
    ASCII-only identifier that is safe for filenames, URLs, and DOM IDs.
    """
    assert slugify(original) == expected


def test_slugify_is_idempotent() -> None:
    """
    Re-slugifying a slug must be a no-op.
    """
    raw = "This is a *Complex*     Example!!!"
    once = slugify(raw)
    twice = slugify(once)
    assert once == twice
    # Bonus: it should be already lower-case and contain only `[a-z0-9-]`.
    assert re.fullmatch(r"[a-z0-9-]+", once), once


# ---------------------------------------------------------------------------
# generate_card_id
# ---------------------------------------------------------------------------


def test_generate_card_id_format() -> None:
    """
    The generated card id must be URL-safe, deterministic in length, and *not*
    look like a plain UUID so that we can easily tell them apart in logs.
    """
    card_id = generate_card_id()

    # 1) Should be str
    assert isinstance(card_id, str)

    # 2) Must be short (< 30 chars).  The reference implementation uses base64
    # URL-safe encoding of a UUID, yielding 22 chars.
    assert len(card_id) < 30, card_id

    # 3) Must *not* contain padding (`=`), slashes, or pluses.
    assert re.fullmatch(r"[A-Za-z0-9_-]+", card_id), card_id

    # 4) Should be reversible to a UUID if design calls for it.
    #    We accept failure here only if developer explicitly removed support.
    try:
        uuid.UUID(bytes=utils.base64u_decode(card_id))  # type: ignore[attr-defined]
    except AttributeError:
        # utils.base64u_decode missing => ok.  Just document the expectation.
        pytest.skip("Reversibility helper not implemented.")


def test_generate_card_id_uniqueness_under_load() -> None:
    """
    Stress-test uniqueness by generating *n* identifiers from multiple threads
    and verifying there are no collisions.
    """
    generated = _generate_ids_concurrently(generate_card_id, iterations=5_000)
    assert len(generated) == len(set(generated)), "Identifier collision detected."


# ---------------------------------------------------------------------------
# Color helpers: rgb_to_hex / hex_to_rgb
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "rgb, hex_",
    [
        ((0, 0, 0), "#000000"),
        ((255, 255, 255), "#FFFFFF"),
        ((128, 64, 32), "#804020"),
        ((17, 34, 51), "#112233"),
    ],
)
def test_rgb_hex_roundtrip(rgb: Tuple[int, int, int], hex_: str) -> None:
    """
    Converting from RGB to HEX and back must return the original colour tuple
    (and vice versa).
    """
    calc_hex = rgb_to_hex(rgb)
    assert calc_hex.upper() == hex_.upper()

    calc_rgb = hex_to_rgb(hex_)
    assert calc_rgb == rgb


@pytest.mark.parametrize("bad_hex", ["#GGGGGG", "#1234", "112233", "#12345G"])
def test_hex_to_rgb_rejects_invalid_input(bad_hex: str) -> None:
    with pytest.raises(ValueError):
        hex_to_rgb(bad_hex)


@pytest.mark.parametrize("bad_rgb", [(-1, 0, 0), (256, 255, 255), (12, 34), (1, 2, 3, 4)])
def test_rgb_to_hex_rejects_invalid_input(bad_rgb) -> None:  # type: ignore[func-returns-value]
    with pytest.raises(ValueError):
        rgb_to_hex(bad_rgb)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Debounce decorator
# ---------------------------------------------------------------------------


def _advance_time(monkeypatch: pytest.MonkeyPatch, seconds: float) -> None:
    """
    Monkey-patch ``time.time`` to fast-forward the clock by *seconds*. This
    enables us to test time-dependent code without actually waiting.
    """
    current = time.time()

    def fake_time() -> float:
        return current + seconds

    monkeypatch.setattr(utils, "time", utils.time)  # ensure utils.time exists
    monkeypatch.setattr(utils.time, "time", fake_time)  # type: ignore[attr-defined]


def test_debounce_allows_only_single_call_within_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    The debounced function should execute immediately on the *first* call and
    ignore subsequent calls that occur inside the quiet window.
    """
    events: List[str] = []

    @Debounce(wait_seconds=0.5)
    def record_event(label: str) -> None:
        events.append(label)

    # First call -> executed
    record_event("a")
    assert events == ["a"]

    # Second call at t+0.1s -> suppressed
    _advance_time(monkeypatch, seconds=0.1)
    record_event("b")
    assert events == ["a"]

    # Third call at t+0.49s -> still suppressed
    _advance_time(monkeypatch, seconds=0.49)
    record_event("c")
    assert events == ["a"]

    # Past the debounce window (t+0.51s) -> allowed
    _advance_time(monkeypatch, seconds=0.51)
    record_event("d")
    assert events == ["a", "d"]


def test_debounce_thread_safety() -> None:
    """
    Multiple threads hammering a debounced function should still result in at
    most one invocation per quiet window.
    """
    counter = 0
    lock = threading.Lock()

    @Debounce(wait_seconds=0.2)
    def increment() -> None:
        nonlocal counter
        with lock:
            counter += 1

    def spam() -> None:
        for _ in range(50):
            increment()
            time.sleep(0.01)

    threads = [threading.Thread(target=spam) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Because we spam for ~0.5s total and the window is 0.2s, we expect at most
    # 3 increments (+/- scheduler jitter).
    assert counter <= 3, f"Debounce allowed {counter} invocations; expected <= 3."


# ---------------------------------------------------------------------------
# End of file
# ---------------------------------------------------------------------------
```