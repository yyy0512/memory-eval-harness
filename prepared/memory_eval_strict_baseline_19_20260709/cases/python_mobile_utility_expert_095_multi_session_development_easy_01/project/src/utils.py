```python
"""
src/utils.py
PrismPocket – mobile_utility
=================================

This module centralises *cross-cutting* utilities that are required by more
than one concentric ring of PrismPocket’s Clean Architecture stack.
Everything in here must remain free of platform-specific dependencies
(keep it *pure python*) so that it can be imported by both business-layer
and adapter-layer code without creating cyclic or binary-compatibility
issues on iOS or Android.

Utilities included
------------------
• Logging bootstrap with environment-aware log level
• Singleton metaclass + AppConfig runtime configuration registry
• Custom JSON encoder that handles dataclasses / datetime / Path / UUID
• ULID-like identifier generator (lexicographically sortable)
• String helpers (slugify)
• Colour helpers (hex ⇄ rgb, WCAG contrast ratio, text-colour picker)
• Async helpers (retry decorator with exp. back-off, gather with
  concurrency limit, thread-pool bridge)

Author  : PrismPocket Engineering Team
License : MIT
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import datetime as _dt
import functools
import json
import logging
import math
import os
import pathlib
import random
import re
import secrets
import string
import threading
import time
import types
import typing as _t
import uuid
from concurrent.futures import ThreadPoolExecutor

__all__ = [
    # logging
    "get_logger",
    # config
    "AppConfig",
    # JSON
    "PrismJSONEncoder",
    "json_dumps",
    # ids / strings
    "generate_ulid",
    "slugify",
    # colours
    "hex_to_rgb",
    "rgb_to_hex",
    "relative_luminance",
    "contrast_ratio",
    "pick_text_color",
    # async helpers
    "retry_async",
    "gather_limited",
    "run_sync_in_executor",
]

################################################################################
# Logging helpers
################################################################################


_DEFAULT_LOG_FORMAT = (
    "[%(asctime)s] [%(levelname)8s] "
    "[%(name)s] "
    "[%(filename)s:%(lineno)d] — %(message)s"
)

_logging_lock = threading.Lock()
_logger_configured = False


def _configure_root_logger() -> None:
    """
    Configure the *root* logger exactly once.  Subsequent calls become NO-OPs.
    """
    global _logger_configured
    with _logging_lock:
        if _logger_configured:  # pragma: no cover
            return

        level_name = os.getenv("PRISM_LOG_LEVEL", "").upper()
        level = getattr(logging, level_name, logging.INFO)
        logging.basicConfig(
            level=level,
            format=_DEFAULT_LOG_FORMAT,
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        _logger_configured = True


def get_logger(name: str | None = None) -> logging.Logger:
    """
    Get a *module-level* logger that is pre-configured with sensible defaults.

    Example
    -------
    >>> log = get_logger(__name__)
    >>> log.info("Hello, prism!")
    """
    _configure_root_logger()
    return logging.getLogger(name or __name__)


################################################################################
# Singleton-flavoured runtime configuration
################################################################################


class _SingletonMeta(type):
    """
    A thread-safe Singleton implementation using a classic meta-class.  Each
    subclass receives exactly one shared instance for the lifetime of the
    interpreter.  Useful for lightweight, read-mostly registries.
    """

    _instances: dict[type, object] = {}
    _lock = threading.Lock()

    def __call__(cls, *args, **kwargs):  # noqa: D401
        with cls._lock:
            if cls not in cls._instances:
                instance = super().__call__(*args, **kwargs)  # type: ignore[arg-type]
                cls._instances[cls] = instance
            return cls._instances[cls]


class AppConfig(metaclass=_SingletonMeta):
    """
    Runtime configuration that can be queried from anywhere without passing
    a thousand parameters down the call-stack.

    Priority order for value resolution:
        1. Explicit *kwarg* in `__init__` / `reload`
        2. Environment variable  (e.g.  PRISM_API_ENDPOINT)
        3. Hard-coded default

    This object is *intentionally mutable* so that test-suites can patch
    values at runtime without needing monkey-patching.
    """

    # ──────────────────────────────────────────────────────────────────── #
    # Defaults
    # ──────────────────────────────────────────────────────────────────── #
    _DEFAULTS: dict[str, _t.Any] = {
        "debug": False,
        "api_endpoint": "https://api.prismpocket.io",
        "analytics_enabled": True,
        "offline_cache_dir": str(pathlib.Path.home() / ".prism" / "cache"),
        "crash_reporting": True,
    }

    def __init__(self, **overrides: _t.Any) -> None:
        self._values: dict[str, _t.Any] = {}
        self.reload(**overrides)

    # Public API -------------------------------------------------------- #

    def reload(self, **overrides: _t.Any) -> None:
        """
        Refresh values from the environment and/or explicit overrides.
        """
        self._values.clear()

        for key, default in self._DEFAULTS.items():
            env_key = f"PRISM_{key.upper()}"
            value = overrides.get(key, os.getenv(env_key, default))

            # Cast env strings to expected types
            if isinstance(default, bool):
                value = str(value).lower() in {"1", "true", "yes", "on"}
            elif isinstance(default, int):
                value = int(value)
            elif isinstance(default, float):
                value = float(value)

            self._values[key] = value

    # Fancy attribute access ------------------------------------------- #

    def __getattr__(self, item: str) -> _t.Any:  # noqa: D401
        try:
            return self._values[item]
        except KeyError as exc:  # pragma: no cover
            raise AttributeError(item) from exc

    def __setattr__(self, key: str, value: _t.Any) -> None:
        if key in {"_values"}:
            return super().__setattr__(key, value)
        self._values[key] = value

    # Misc ------------------------------------------------------------- #

    def __repr__(self) -> str:  # pragma: no cover
        class_name = self.__class__.__name__
        key_vals = ", ".join(f"{k}={v!r}" for k, v in self._values.items())
        return f"{class_name}({key_vals})"


################################################################################
# JSON helpers
################################################################################


class PrismJSONEncoder(json.JSONEncoder):
    """
    Smart JSON encoder that supports the most common value types we use
    across the project (dataclasses, Path, datetime, UUID, …).

    `json_dumps` below is a convenience wrapper that pre-configures the
    encoder so that call-sites do not need to remember keyword arguments.
    """

    def default(self, o: _t.Any) -> _t.Any:  # noqa: D401
        if dataclasses.is_dataclass(o):
            return dataclasses.asdict(o)
        if isinstance(o, (_dt.datetime, _dt.date)):
            return o.isoformat()
        if isinstance(o, pathlib.Path):
            return str(o)
        if isinstance(o, uuid.UUID):
            return str(o)
        if isinstance(o, set):
            return list(o)
        return super().default(o)


def json_dumps(
    obj: _t.Any,
    *,
    indent: int | None = None,
    sort_keys: bool = False,
    ensure_ascii: bool = False,
) -> str:
    """
    Serialise *obj* to JSON with our custom encoder.
    """
    return json.dumps(
        obj,
        cls=PrismJSONEncoder,
        indent=indent,
        sort_keys=sort_keys,
        ensure_ascii=ensure_ascii,
    )


################################################################################
# Identifiers & strings
################################################################################


_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # no I/L/O/U
_ULID_LOCK = threading.Lock()
_LAST_ULID_TIME = 0


def _encode_base32(value: int, pad: int) -> str:
    chars = []
    for _ in range(pad):
        value, idx = divmod(value, 32)
        chars.append(_BASE32_ALPHABET[idx])
    return "".join(reversed(chars))


def generate_ulid() -> str:
    """
    Generate a ULID-compatible 26-character identifier that is
    *lexicographically sortable* (first 48 bits are the timestamp).

    We do not rely on the external `ulid-python` package to keep the
    dependency tree minimal.
    """
    global _LAST_ULID_TIME
    with _ULID_LOCK:
        millis = int(time.time() * 1_000)

        # Guarantee monotonicity in the same millisecond
        if millis <= _LAST_ULID_TIME:
            millis = _LAST_ULID_TIME + 1
        _LAST_ULID_TIME = millis

    timestamp_part = _encode_base32(millis, 10)
    randomness_part = _encode_base32(secrets.randbits(80), 16)
    return f"{timestamp_part}{randomness_part}"


_SLUG_RX = re.compile(r"[^a-z0-9]+")


def slugify(text: str, *, max_length: int = 80) -> str:
    """
    Convert *text* into a URL- and filename-friendly slug.

    Example
    -------
    >>> slugify("Hello, PrismPocket!")  # -> 'hello-prismpocket'
    """
    text = text.lower()
    text = _SLUG_RX.sub("-", text).strip("-")
    text = re.sub(r"-{2,}", "-", text)  # collapse duplicates
    return text[:max_length]


################################################################################
# Colour helpers
################################################################################


def hex_to_rgb(hex_colour: str) -> tuple[int, int, int]:
    """
    Convert a HEX colour (e.g. '#ff00ff' or 'ff00ff') to an RGB tuple.
    """
    hex_colour = hex_colour.lstrip("#")
    if len(hex_colour) == 3:  # shorthand notation (#f0f)
        hex_colour = "".join(ch * 2 for ch in hex_colour)
    if len(hex_colour) != 6:
        raise ValueError(f"Invalid HEX colour: {hex_colour!r}")
    r, g, b = (
        int(hex_colour[i : i + 2], 16) for i in (0, 2, 4)  # noqa: E203
    )
    return r, g, b


def rgb_to_hex(rgb: tuple[int, int, int], *, prefix: str = "#") -> str:
    """
    Convert an RGB tuple back to HEX.
    """
    r, g, b = rgb
    for channel in (r, g, b):
        if not 0 <= channel <= 255:
            raise ValueError(f"RGB channel out of range: {channel!r}")
    return f"{prefix}{r:02x}{g:02x}{b:02x}"


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    """
    Calculate the *relative luminance* as defined by WCAG 2.0.
    """
    def _channel(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = map(_channel, rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(
    fg_rgb: tuple[int, int, int],
    bg_rgb: tuple[int, int, int],
) -> float:
    """
    Calculate the contrast ratio between *foreground* and *background*
    colours.  A ratio ≥ 4.5 is recommended for small text.
    """
    l1 = relative_luminance(fg_rgb) + 0.05
    l2 = relative_luminance(bg_rgb) + 0.05
    return max(l1, l2) / min(l1, l2)


def pick_text_color(
    background_hex: str,
    *,
    light_color: str = "#FFFFFF",
    dark_color: str = "#000000",
) -> str:
    """
    Given a background HEX colour, pick either *light_color* or *dark_color*
    to ensure a minimum contrast ratio of 4.5 (WCAG AA).
    """
    bg_rgb = hex_to_rgb(background_hex)
    light_rgb = hex_to_rgb(light_color)
    dark_rgb = hex_to_rgb(dark_color)

    if contrast_ratio(light_rgb, bg_rgb) >= 4.5:
        return light_color
    return dark_color


################################################################################
# Async / concurrency helpers
################################################################################


def retry_async(
    *,
    attempts: int = 3,
    delay: float = 0.25,
    backoff: float = 2.0,
    jitter: float = 0.1,
    exceptions: tuple[type[Exception], ...] = (Exception,),
) -> _t.Callable[[ _t.Callable[ _t.P, _t.Awaitable[_t.T] ] ], _t.Callable[ _t.P, _t.Awaitable[_t.T] ]]:
    """
    Decorator for *async* callables that retries upon failure with
    exponential back-off and optional jitter.

    Example
    -------
    >>> @retry_async(attempts=5, delay=0.1)
    ... async def fetch_remote():
    ...     ...
    """
    def decorator(func: _t.Callable[_t.P, _t.Awaitable[_t.T]]) -> _t.Callable[_t.P, _t.Awaitable[_t.T]]:
        @functools.wraps(func)
        async def wrapper(*args: _t.P.args, **kwargs: _t.P.kwargs) -> _t.T:
            last_exc: Exception | None = None
            for attempt in range(1, attempts + 1):
                try:
                    return await func(*args, **kwargs)
                except exceptions as exc:  # type: ignore[misc]
                    last_exc = exc
                    if attempt == attempts:
                        raise
                    wait_time = delay * (backoff ** (attempt - 1))
                    wait_time += random.uniform(-jitter, jitter)
                    wait_time = max(0, wait_time)
                    await asyncio.sleep(wait_time)
            # Should never reach this
            assert last_exc is not None  # pragma: no cover
            raise last_exc  # noqa: B904

        return wrapper

    return decorator


async def gather_limited(
    *coros: _t.Awaitable[_t.T],
    limit: int = 10,
    return_exceptions: bool = False,
) -> list[_t.T]:
    """
    `asyncio.gather` alternative that limits *concurrency*.

    Example
    -------
    >>> results = await gather_limited(*aws, limit=3)
    """
    semaphore = asyncio.Semaphore(limit)

    async def _runner(coro: _t.Awaitable[_t.T]) -> _t.T:
        async with semaphore:
            return await coro

    wrapped = [_runner(c) for c in coros]
    return await asyncio.gather(*wrapped, return_exceptions=return_exceptions)  # type: ignore[arg-type]


_thread_pool: ThreadPoolExecutor | None = None
_thread_pool_lock = threading.Lock()


def _ensure_thread_pool() -> ThreadPoolExecutor:
    global _thread_pool
    with _thread_pool_lock:
        if _thread_pool is None:  # pragma: no cover
            _thread_pool = ThreadPoolExecutor(
                max_workers=min(32, (os.cpu_count() or 1) * 5),
                thread_name_prefix="PrismPool",
            )
        return _thread_pool


async def run_sync_in_executor(func: _t.Callable[..., _t.T], *args: _t.Any, **kwargs: _t.Any) -> _t.T:
    """
    Run a CPU-bound or blocking *sync* function in PrismPocket’s shared
    thread pool, returning an *async* awaitable.

    Example
    -------
    >>> size = await run_sync_in_executor(os.path.getsize, "/path/to/file")
    """
    loop = asyncio.get_running_loop()
    executor = _ensure_thread_pool()
    return await loop.run_in_executor(executor, functools.partial(func, *args, **kwargs))


################################################################################
# Module self-test (only executed via `python -m src.utils`)
################################################################################


if __name__ == "__main__":  # pragma: no cover
    log = get_logger("utils-selftest")
    log.info("Self-test started…")

    # ULID sanity
    ids = [generate_ulid() for _ in range(3)]
    assert ids == sorted(ids), "ULIDs must be lexicographically sortable"
    log.info("ULID ✓")

    # Colour helpers
    bg = "#3366ff"
    txt = pick_text_color(bg)
    log.info("Colour pick: bg=%s • text=%s", bg, txt)

    # Async retry / gather demo
    async def _demo() -> None:
        counter = {"fail": 0}

        @retry_async(attempts=3, delay=0.05)
        async def flaky() -> str:
            counter["fail"] += 1
            if counter["fail"] < 2:
                raise RuntimeError("flaky!")
            return "ok"

        res = await flaky()
        assert res == "ok"
        await gather_limited(*(asyncio.sleep(0.01) for _ in range(20)), limit=5)

    asyncio.run(_demo())
    log.info("Async helpers ✓")
    log.info("All tests passed!")
```