```python
"""
src/utils.py

Shared utility helpers for the QuestSmith mobile game.

This module purposefully stays free of heavyweight or platform–specific
dependencies (with the exception of Kivy’s very light ``kivy.utils.platform``)
so that every layer—repositories, analytics, background sync, view-models—can
import it without creating circular-build headaches.

Author: QuestSmith Team
"""

from __future__ import annotations

import json
import logging
import os
import random
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, TypeVar

try:  # Kivy isn’t a hard requirement for unit tests / CI.
    from kivy.utils import platform as _kivy_platform  # type: ignore
except Exception:  # pragma: no cover
    _kivy_platform = sys.platform

T = TypeVar("T")

# --------------------------------------------------------------------------- #
# Platform helpers
# --------------------------------------------------------------------------- #


def get_platform() -> str:
    """
    Returns QuestSmith’s canonical platform identifier.

    Values: ``android``, ``ios``, ``macos``, ``windows``, ``linux``.
    """
    p = _kivy_platform.lower()
    synonyms = {"macosx": "macos", "darwin": "macos"}
    return synonyms.get(p, p)


# --------------------------------------------------------------------------- #
# Path management
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AppPaths:
    """
    Lazily resolves (and, if requested, creates) the application’s critical
    directories in a cross-platform fashion.

    Usage:
        paths = AppPaths()
        paths.ensure()             # make sure directories exist
        cache_file = paths.cache / "sprite_sheet.png"
    """

    app_name: str = "QuestSmith"

    # --- Computed dirs ----------------------------------------------------- #

    @property
    def root(self) -> Path:
        p = get_platform()

        # Mobile: defer to Kivy’s user_data_dir (already sandbox-safe).
        if p in ("android", "ios"):
            # Imported lazily to avoid creating an App in unit tests.
            from kivy.app import App  # type: ignore

            return Path(App.get_running_app().user_data_dir)

        if p == "windows":
            return (
                Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming"))
                / self.app_name
            )

        if p == "macos":
            return Path.home() / "Library" / "Application Support" / self.app_name

        # Linux & everything else.
        return (
            Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share"))
            / self.app_name
        )

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def cache(self) -> Path:
        return self.root / "cache"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def config(self) -> Path:
        return self.root / "config"

    # --- Actions ----------------------------------------------------------- #

    def ensure(self) -> None:
        """Ensures that *all* service directories exist."""
        for directory in (self.data, self.cache, self.logs, self.config):
            directory.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- #
# Logging helpers
# --------------------------------------------------------------------------- #

_LOG_FORMAT = "%(asctime)s | %(levelname)5s | %(name)s | %(message)s"


def configure_logging(
    *,
    level: int = logging.INFO,
    max_bytes: int = 512 * 1024,
    backup_count: int = 3,
) -> None:
    """
    Configure the *root* logger exactly once.

    A console handler + file handler (rotating) are installed. Subsequent calls
    are no-ops, making the function idempotent.
    """
    if logging.getLogger().handlers:
        return  # Already configured.

    paths = AppPaths()
    paths.ensure()
    log_file = paths.logs / "questsmith.log"

    root = logging.getLogger()
    root.setLevel(level)

    # Console -------------------------------------------------------------- #
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(console)

    # File (rotating) ------------------------------------------------------ #
    file_handler = RotatingFileHandler(
        log_file, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
    )
    file_handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(file_handler)


# --------------------------------------------------------------------------- #
# JSON persistence
# --------------------------------------------------------------------------- #


def load_json(
    path: Path, *, default: Optional[T] = None, encoding: str = "utf-8"
) -> T:
    """
    Robustly loads JSON from *path*.

    • If the file is missing, *default* is persisted (if provided) and returned.
    • If the file is corrupt, it is overwritten with *default* (if provided).
    """
    if not path.exists():
        if default is None:
            raise FileNotFoundError(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        save_json(path, default, encoding=encoding)
        return default

    try:
        with path.open("r", encoding=encoding) as fp:
            return json.load(fp)
    except json.JSONDecodeError as exc:
        logging.getLogger(__name__).warning(
            "Corrupt JSON in %s – resetting. %s", path, exc
        )
        if default is None:
            raise
        save_json(path, default, encoding=encoding)
        return default


def save_json(path: Path, data: Any, *, encoding: str = "utf-8") -> None:
    """
    Persists *data* to *path* atomically: write to ``*.tmp`` then rename.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding=encoding) as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)
    tmp.replace(path)


# --------------------------------------------------------------------------- #
# Date / Time utilities
# --------------------------------------------------------------------------- #

_ISO_FMT = "%Y-%m-%dT%H:%M:%S.%fZ"


def utcnow() -> datetime:
    """Returns timezone-aware UTC now()."""
    return datetime.now(timezone.utc)


def isoformat(dt: datetime) -> str:
    """
    Serialises *dt* to canonical ISO-8601 (always in UTC, suffixed 'Z').
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime(_ISO_FMT)


def parse_iso(dt_str: str) -> datetime:
    """
    Parses ISO-8601 with liberal fallback to ``datetime.fromisoformat``.
    """
    try:
        return datetime.strptime(dt_str, _ISO_FMT).replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.fromisoformat(dt_str).astimezone(timezone.utc)


# --------------------------------------------------------------------------- #
# Decorators & concurrency helpers
# --------------------------------------------------------------------------- #


def synchronized(lock: Optional[threading.Lock] = None) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Function decorator that wraps *fn* inside a threading.Lock, guaranteeing that
    only one thread executes the body at a time.

    If *lock* is omitted a new dedicated lock is created per function.
    """

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        _lock = lock or threading.Lock()

        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> T:  # type: ignore
            with _lock:
                return fn(*args, **kwargs)

        return wrapper

    return decorator


def retry(
    exceptions: tuple[type[Exception], ...] = (Exception,),
    *,
    tries: int = 3,
    delay: float = 0.5,
    backoff: float = 2.0,
    jitter: float = 0.1,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Simple retry decorator with exponential backoff.

    Parameters
    ----------
    exceptions:
        A tuple of exceptions that trigger a retry.
    tries:
        Total attempts (initial call + retries).
    delay:
        Initial sleep delay (seconds).
    backoff:
        Multiplier applied to delay after each failure.
    jitter:
        Adds random(0, jitter) seconds to each delay.
    """

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        @wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> T:  # type: ignore
            _tries, _delay = tries, delay
            while _tries > 1:
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:
                    logging.getLogger(fn.__module__).warning(
                        "%s failed with %s – retrying in %.2fs (%d left)",
                        fn.__name__,
                        exc,
                        _delay,
                        _tries - 1,
                    )
                    time.sleep(_delay + random.uniform(0, jitter))
                    _tries -= 1
                    _delay *= backoff
            return fn(*args, **kwargs)  # final attempt

        return wrapper

    return decorator


def run_in_thread(fn: Callable[..., T]) -> Callable[..., threading.Thread]:
    """
    Decorator that launches *fn* in a daemon thread and returns
    the Thread handle to the caller.
    """

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> threading.Thread:  # type: ignore
        thread = threading.Thread(target=fn, args=args, kwargs=kwargs, daemon=True)
        thread.start()
        return thread

    return wrapper


# --------------------------------------------------------------------------- #
# Event bus (Observer pattern)
# --------------------------------------------------------------------------- #


class EventBus:
    """
    Lightweight, thread-safe in-memory pub-sub bus.

    Designed so that QuestSmith’s analytics engine, push-notification scheduler,
    and view-models can broadcast quest status changes without depending on a
    heavyweight reactor framework.
    """

    def __init__(self) -> None:
        self._subs: Dict[str, List[Callable[..., None]]] = {}
        self._lock = threading.RLock()

    # --- Subscription ----------------------------------------------------- #

    def subscribe(self, event: str, callback: Callable[..., None]) -> None:
        with self._lock:
            self._subs.setdefault(event, []).append(callback)

    def unsubscribe(self, event: str, callback: Callable[..., None]) -> None:
        with self._lock:
            callbacks = self._subs.get(event)
            if callbacks and callback in callbacks:
                callbacks.remove(callback)
                if not callbacks:
                    self._subs.pop(event, None)

    # --- Publishing ------------------------------------------------------- #

    def publish(self, event: str, *args: Any, **kwargs: Any) -> None:
        with self._lock:
            callbacks: Iterable[Callable[..., None]] = list(
                self._subs.get(event, [])
            )  # copy
        for cb in callbacks:
            try:
                cb(*args, **kwargs)
            except Exception:  # pragma: no cover
                logging.getLogger(__name__).exception(
                    "Unhandled exception in event handler %s for '%s'", cb, event
                )


# Global singleton for app-wide consumption.
global_event_bus = EventBus()

# --------------------------------------------------------------------------- #
# Misc. helpers
# --------------------------------------------------------------------------- #


@contextmanager
def time_block(name: str, logger: Optional[logging.Logger] = None):
    """
    Context manager that logs execution time for the enclosed block at DEBUG
    level. Handy for profiling hotspots without a profiler.

    Example:
        with time_block("sync cloud"):
            sync_cloud()
    """
    _log = logger or logging.getLogger(__name__)
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = (time.perf_counter() - start) * 1000  # ms
        _log.debug("⏱  %s took %.2f ms", name, elapsed)


def generate_token(length: int = 32) -> str:
    """
    Generates a cryptographically-secure random hexadecimal string.

    ``secrets`` is preferred but falls back to a manual implementation on
    antiquated Python builds (rare on mobile, but better safe).
    """
    try:
        import secrets

        return secrets.token_hex(length)
    except Exception:  # pragma: no cover
        import binascii

        return binascii.hexlify(os.urandom(length)).decode()


# --------------------------------------------------------------------------- #
# Public re-exports
# --------------------------------------------------------------------------- #

__all__ = [
    # Paths & platform
    "AppPaths",
    "get_platform",
    # Logging
    "configure_logging",
    # Persistence
    "load_json",
    "save_json",
    # Date / time
    "utcnow",
    "isoformat",
    "parse_iso",
    # Decorators & helpers
    "synchronized",
    "retry",
    "run_in_thread",
    "time_block",
    # Event bus
    "EventBus",
    "global_event_bus",
    # Misc.
    "generate_token",
]
```