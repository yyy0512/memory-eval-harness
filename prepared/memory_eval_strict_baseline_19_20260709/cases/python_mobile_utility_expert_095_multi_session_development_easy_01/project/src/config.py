```python
"""
PrismPocket – Configuration Module
==================================

This module centralises application configuration for the PrismPocket mobile
suite.  The configuration model follows a layered-override strategy:

1. Hard-coded library defaults
2. Optional `.env` file in project root or supplied path
3. Process environment variables
4. Optional runtime overrides passed as a `dict` or remote JSON

At runtime the Config object behaves as a thread-safe Singleton so that the
entire application tree sees a coherent snapshot.  A minimal Observer bus
allows interested parties (analytics, crash reporter, etc.) to react to hot
reloads, which is handy for in-app debug consoles or remote A/B feature flags.

Architecture notes
------------------
*   MVVM view-models should treat Config as *read-only*.
*   Domain / data layers may watch for reloads to pick up things like
    credentials rotation or URL changes.
*   Platform adapters MUST NOT mutate Config – they may only register observers
    to refresh their own internal state.

Usage
-----
    >>> from src.config import Config
    >>> cfg = Config()                 # Singleton retrieval
    >>> cfg.analytics.enabled
    True
    >>> cfg.reload()                  # Re-parse env / disk, notify observers
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Optional

_LOG = logging.getLogger(__name__)
_ENV_FILE_CANDIDATES = (".env", "env.local")

Observer = Callable[["Config"], None]
_JSONDict = Dict[str, Any]


def _try_load_dotenv(dotenv_path: Optional[Path] = None) -> Dict[str, str]:
    """
    Parse a dotenv file (if python-dotenv is available).  Falls back to manual
    parsing on stripped down runtimes where extra wheels are undesirable.
    """
    variables: Dict[str, str] = {}
    candidate = dotenv_path

    if candidate is None:
        for fname in _ENV_FILE_CANDIDATES:
            path = Path.cwd() / fname
            if path.exists():
                candidate = path
                break

    if candidate is None or not candidate.exists():
        _LOG.debug("No dotenv file discovered, skipping.")
        return variables

    try:
        from dotenv import dotenv_values  # type: ignore
        variables.update({k: v for k, v in dotenv_values(candidate).items() if v is not None})
        _LOG.debug("Loaded %d env vars from dotenv via python-dotenv.", len(variables))
        return variables
    except ImportError:
        _LOG.info("python-dotenv not installed – falling back to naive parser.")

    # Minimalistic parser – supports KEY=VALUE lines, ignores export & comments
    try:
        with candidate.open() as f:
            for raw in f:
                raw = raw.strip()
                if not raw or raw.startswith("#"):
                    continue
                if raw.lower().startswith("export "):
                    raw = raw[7:]
                if "=" not in raw:
                    continue
                k, v = raw.split("=", 1)
                variables[k.strip()] = v.strip().strip('"').strip("'")
        _LOG.debug("Loaded %d env vars from dotenv via naive parser.", len(variables))
    except Exception as exc:  # pragma: no cover
        _LOG.warning("Failed to parse dotenv file %s: %s", candidate, exc)

    return variables


@dataclass(frozen=True)
class AppConfig:
    name: str = "PrismPocket"
    version: str = "1.0.0"
    environment: str = "production"  # dev | staging | production
    debug: bool = False
    platform: str = field(
        default_factory=lambda: (
            "ios" if os.getenv("KIVY_BUILD") == "ios"
            else "android" if os.getenv("KIVY_BUILD") == "android"
            else "desktop"
        )
    )

    def asdict(self) -> _JSONDict:  # noqa: D401 – simple wrapper
        return _safe_dataclass_to_dict(self)


@dataclass(frozen=True)
class NetworkConfig:
    api_base_url: str = "https://api.prismpocket.app/v1"
    timeout_sec: int = 15
    max_retries: int = 2
    ssl_verify: bool = True

    def asdict(self) -> _JSONDict:
        return _safe_dataclass_to_dict(self)


@dataclass(frozen=True)
class AnalyticsConfig:
    enabled: bool = True
    endpoint: str = "https://analytics.prismpocket.app/ingest"
    api_key: str = "REDACTED"

    def asdict(self) -> _JSONDict:
        # Mask api_key when serialising
        d = _safe_dataclass_to_dict(self)
        if d.get("api_key"):
            d["api_key"] = "******"
        return d


@dataclass(frozen=True)
class StorageConfig:
    local_root: Path = field(default_factory=lambda: Path.home() / ".prismpocket")
    cache_size_mb: int = 128
    encryption_key: str = "REDACTED"

    def asdict(self) -> _JSONDict:
        d = _safe_dataclass_to_dict(self)
        if d.get("encryption_key"):
            d["encryption_key"] = "******"
        d["local_root"] = str(d["local_root"])
        return d


@dataclass(frozen=True)
class SocialConfig:
    enabled: bool = True
    share_endpoint: str = "https://social.prismpocket.app/share"

    def asdict(self) -> _JSONDict:
        return _safe_dataclass_to_dict(self)


@dataclass(frozen=True)
class CrashReportingConfig:
    enabled: bool = True
    dsn: str = "https://public@sentry.io/123456"
    sample_rate: float = 0.1

    def asdict(self) -> _JSONDict:
        d = _safe_dataclass_to_dict(self)
        if d.get("dsn"):
            d["dsn"] = d["dsn"][:16] + "..."
        return d


def _safe_dataclass_to_dict(dc: Any) -> Dict[str, Any]:
    """
    Recursively convert dataclass -> dict without exposing secrets by default.
    Collections remain mutable for caller convenience, but some secrets are
    masked upstream in asdict() of each component.
    """
    from dataclasses import is_dataclass, fields  # late import

    if not is_dataclass(dc):
        return {}

    result: Dict[str, Any] = {}
    for f in fields(dc):
        v = getattr(dc, f.name)
        if is_dataclass(v):
            result[f.name] = _safe_dataclass_to_dict(v)
        elif isinstance(v, Path):
            result[f.name] = str(v)
        else:
            result[f.name] = v
    return result


class Config:  # pylint: disable=too-few-public-methods
    """
    Thread-safe Singleton façade around the various *Config dataclasses.
    """

    _instance: Optional["Config"] = None
    _lock = threading.RLock()

    # ----------- Static API -------------------------------------------------

    def __new__(cls, *args: Any, **kwargs: Any) -> "Config":  # noqa: D401
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialised = False
            return cls._instance

    # ----------- Public API --------------------------------------------------

    # NOTE: we don't use dataclass here because __setattr__ customisation
    def __init__(
        self,
        dotenv_path: Optional[Path] = None,
        runtime_overrides: Optional[_JSONDict] = None,
    ) -> None:
        # Guarantee idempotent in Singleton
        if self._initialised:
            return
        self._observers: List[Observer] = []

        # Baseline defaults
        self.app = AppConfig()
        self.network = NetworkConfig()
        self.analytics = AnalyticsConfig()
        self.storage = StorageConfig()
        self.social = SocialConfig()
        self.crash = CrashReportingConfig()

        # Build final config
        self._load_env(dotenv_path)
        self._apply_overrides(runtime_overrides or {})
        self._initialised = True
        _LOG.debug("Configuration initialised: %s", self.repr_safe())

    # ----------------- Mutation / Observer ----------------------------------

    def reload(
        self,
        dotenv_path: Optional[Path] = None,
        runtime_overrides: Optional[_JSONDict] = None,
    ) -> None:
        """
        Re-read disk / environment and notify observers on change. Callers can
        supply additional overrides which will be applied atomically. No
        exceptions bubble out – fatal issues are logged and ignored.
        """
        with self._lock:
            try:
                old_repr = self.repr_safe()
                self._load_env(dotenv_path)
                self._apply_overrides(runtime_overrides or {})
                if self.repr_safe() != old_repr:
                    self._notify_observers()
                    _LOG.info("Configuration hot-reloaded.")
            except Exception as exc:  # pragma: no cover
                _LOG.error("Failed to reload configuration: %s", exc, exc_info=True)

    def register_observer(self, callback: Observer) -> None:
        """
        Register a callback that receives the Config instance when reload occurs.
        """
        if not callable(callback):
            raise TypeError("Observer must be callable")
        with self._lock:
            self._observers.append(callback)
            _LOG.debug("Observer %s registered.", callback)

    # ----------------- Introspection ----------------------------------------

    def repr_safe(self) -> _JSONDict:
        """
        Serialise the current config with secrets masked.
        """
        return {
            "app": self.app.asdict(),
            "network": self.network.asdict(),
            "analytics": self.analytics.asdict(),
            "storage": self.storage.asdict(),
            "social": self.social.asdict(),
            "crash": self.crash.asdict(),
        }

    def to_json(self, *, pretty: bool = False) -> str:
        """
        Dump safe representation as JSON – useful for debug consoles.
        """
        kwargs = {"indent": 2, "sort_keys": True} if pretty else {}
        return json.dumps(self.repr_safe(), **kwargs)

    # ----------------- Internal helpers -------------------------------------

    def _notify_observers(self) -> None:
        """
        Notify registered observers in the order they were added.  Exceptions
        are isolated per observer so that one misbehaving listener does not
        break the chain.
        """
        for cb in list(self._observers):
            try:
                cb(self)
            except Exception as exc:  # pragma: no cover
                _LOG.warning("Config observer %s raised: %s", cb, exc)

    # ---- env / override application ----------------------------------------

    _ENV_PREFIX = "PRISM_"  # Namespace to avoid collisions

    def _load_env(self, dotenv_path: Optional[Path] = None) -> None:
        """
        Merge `.env` and process environment variables into config.
        Expected pattern is `PRISM_NETWORK_API_BASE_URL`, etc.
        """
        env_vars = {**_try_load_dotenv(dotenv_path), **os.environ}
        # Filter for namespaced keys
        env_vars = {
            k[len(self._ENV_PREFIX) :]: v  # strip prefix
            for k, v in env_vars.items()
            if k.startswith(self._ENV_PREFIX)
        }

        if not env_vars:
            _LOG.debug("No relevant PrismPocket env vars found.")
            return

        structured: Dict[str, Dict[str, str]] = {}
        for key, value in env_vars.items():
            parts = key.lower().split("_", 1)
            if len(parts) != 2:
                continue
            section, attr = parts
            structured.setdefault(section, {})[attr] = value

        self._apply_overrides(structured)

    def _apply_overrides(self, overrides: _JSONDict) -> None:
        """
        Walk provided override dict and mutate dataclass instances immutably
        (i.e., create new dataclass copies).  Unknown keys are ignored.
        """
        if not overrides:
            return

        _LOG.debug("Applying config overrides: %s", overrides)
        mapping: Dict[str, Any] = {
            "app": self.app,
            "network": self.network,
            "analytics": self.analytics,
            "storage": self.storage,
            "social": self.social,
            "crash": self.crash,
        }

        mutated: Dict[str, Any] = {}
        for section, attrs in overrides.items():
            if section not in mapping:
                _LOG.debug("Unknown config section '%s' skipped.", section)
                continue
            current = mapping[section]
            if not isinstance(attrs, dict):
                _LOG.warning("Section '%s' override must be a dict, got %s.", section, type(attrs))
                continue
            try:
                # Build new dataclass with replaced fields
                new_obj = type(current)(**{**current.__dict__, **attrs})
                mutated[section] = new_obj
            except TypeError as exc:
                _LOG.warning("Failed to override config section '%s': %s", section, exc)

        # Atomically replace mutated sections
        for section, new_obj in mutated.items():
            object.__setattr__(self, section, new_obj)

    # ----------------- Dunder helpers ---------------------------------------

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Config {self.app.environment}@{self.app.version}>"

    # Forbid attribute creation post-initialisation to avoid typos
    def __setattr__(self, name: str, value: Any) -> None:  # noqa: D401
        if getattr(self, "_initialised", False) and not hasattr(self, name):
            raise AttributeError(f"Cannot create new attribute '{name}'.")
        super().__setattr__(name, value)

    # Immutable mapping view usable by others
    @property
    def as_mapping(self) -> MappingProxyType:
        """
        Read-only dict-like view of the safe representation.
        """
        return MappingProxyType(self.repr_safe())


# --------------------------------------------------------------------------- #
#                         Module initialisation                               #
# --------------------------------------------------------------------------- #

# Create eager singleton so top-level imports elsewhere are covered, but allow
# lazy reloads subsequently.
Config()  # noqa: E305  – intentionally called for side-effects
```