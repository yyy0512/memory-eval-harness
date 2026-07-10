```python
"""
VitalOps Orchestrator – Package bootstrap
=========================================

This module boot-straps the VitalOps orchestration runtime whenever the
package is imported *or* when executed as a library entry-point by other
services (e.g. CLI, gunicorn worker, pytest).  The responsibilities of this
file are intentionally limited to:

1. Defining package-wide metadata (`__version__`, `__author__`, …)
2. Providing a thread-safe, in-process Event-Bus implementation that can be
   re-used by child modules without re-instantiation.
3. Loading and caching run-time configuration from *one* of several
   locations (environment variable, default YAML file, or built-in defaults).
4. Exposing a *very* small public API (`bootstrap`, `get_event_bus`,
   `get_settings`) so that call-sites have a single import path:

       from vitalops import bootstrap, get_event_bus, get_settings

Anything orchestration-domain specific **does not** belong here—those live in
their own packages (e.g. `vitalops.coordinators`, `vitalops.models`).

The code in this file should remain entirely side-effect free except for
deterministic logging and config loading that is required by the rest of the
system.
"""

from __future__ import annotations

import importlib.metadata as _importlib_metadata
import io
import json
import logging
import os
import pathlib
import threading
import time
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Callable, Dict, Iterable, List, MutableMapping, MutableSequence, Optional, Type, TypeVar

try:
    import yaml  # type: ignore
except ModuleNotFoundError:  # pragma: no cover – runtime dependency
    yaml = None  # type: ignore


__all__ = [
    "__version__",
    "bootstrap",
    "get_event_bus",
    "get_settings",
    "EventBus",
    "Settings",
    "VitalOpsError",
]

# --------------------------------------------------------------------------- #
# Package metadata                                                            #
# --------------------------------------------------------------------------- #

try:
    # `vitalops-orchestrator` is the name defined in pyproject.toml
    __version__: str = _importlib_metadata.version("vitalops-orchestrator")
except _importlib_metadata.PackageNotFoundError:  # pragma: no cover – editable mode
    __version__ = "0.0.0.dev0"

__author__: str = "VitalOps Engineering <eng@vitalops.example.com>"


# --------------------------------------------------------------------------- #
# Logging                                                                     #
# --------------------------------------------------------------------------- #

_log = logging.getLogger("vitalops")
if not _log.handlers:
    # If the root logger hasn't been configured by the application yet, do a
    # minimal configuration so that at least warnings/errors are visible.
    _log.setLevel(logging.INFO)
    _handler = logging.StreamHandler()  # noqa: WPS442
    _formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    _handler.setFormatter(_formatter)
    _log.addHandler(_handler)
    _log.propagate = False

T_Event = TypeVar("T_Event", bound="Event")


# --------------------------------------------------------------------------- #
# Exceptions                                                                  #
# --------------------------------------------------------------------------- #


class VitalOpsError(RuntimeError):
    """Base-class for any VitalOps specific runtime error."""


# --------------------------------------------------------------------------- #
# Event Bus (Observer Pattern)                                                #
# --------------------------------------------------------------------------- #


class Event:
    """
    Base-class for all in-process events emitted by the orchestrator.

    Sub-classes are free to add additional payload attributes, but they *must*
    remain serialisable to allow optional remote transports in the future.
    """

    __slots__ = ("source", "timestamp")

    def __init__(self, source: str) -> None:
        self.source: str = source
        self.timestamp: float = time.time()

    # --------------------------------------------------------------------- #
    # Utilities                                                             #
    # --------------------------------------------------------------------- #

    def to_dict(self) -> Dict[str, Any]:
        """Return a serialisable representation of the event."""
        return {"type": self.__class__.__name__, **self.__dict__}

    def __repr__(self) -> str:  # pragma: no cover
        return f"<{self.__class__.__name__} {json.dumps(self.to_dict())}>"


Subscriber = Callable[[Event], None]


class EventBus:
    """
    Thread-safe, in-process pub/sub event bus.

    The API is intentionally *very* small while still supporting the Observer
    pattern semantics needed by the orchestration runtime.
    """

    _lock: threading.RLock
    _subscribers: MutableMapping[Type[Event], MutableSequence[Subscriber]]

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers = {}

    # --------------------------------------------------------------------- #
    # Public interface                                                      #
    # --------------------------------------------------------------------- #

    def publish(self, event: Event) -> None:
        """Publish *event* synchronously to all interested subscribers."""
        if not isinstance(event, Event):
            raise TypeError("EventBus.publish() expects an Event instance")

        _log.debug("Publishing %s", event)
        with self._lock:
            subs: Iterable[Subscriber] = (
                list(self._subscribers.get(type(event), []))  # copy
            )

        for subscriber in subs:
            try:
                subscriber(event)
            except Exception:  # pragma: no cover – defensive logging
                _log.exception("Unhandled exception in subscriber %s", subscriber)

    def subscribe(self, event_cls: Type[T_Event], handler: Subscriber) -> Callable[[], None]:
        """
        Subscribe *handler* to *event_cls*.

        Returns a function that, when called, unsubscribes the handler again.
        """
        if not issubclass(event_cls, Event):
            raise TypeError("event_cls must be a subtype of Event")
        if not callable(handler):
            raise TypeError("handler must be callable")

        _log.debug("Subscribing %s to %s", handler, event_cls)
        with self._lock:
            self._subscribers.setdefault(event_cls, []).append(handler)

        def _unsubscribe() -> None:
            _log.debug("Unsubscribing %s from %s", handler, event_cls)
            with self._lock:
                self._subscribers.get(event_cls, []).remove(handler)

        return _unsubscribe

    def clear(self) -> None:
        """Remove *all* subscribers – intended for unit-test isolation only."""
        with self._lock:
            self._subscribers.clear()


# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Settings:
    """
    Immutable run-time settings used by the orchestrator.

    These settings are a *composed* view of defaults, config-file, and
    environment variables.  They are intentionally read-only to avoid
    accidental mutation at run-time.
    """

    # Logging
    log_level: str = "INFO"

    # Paths
    data_dir: pathlib.Path = pathlib.Path("/var/lib/vitalops")
    log_dir: pathlib.Path = pathlib.Path("/var/log/vitalops")

    # Service Mesh
    service_mesh_endpoint: str = "http://localhost:15000"

    # Compliance / Audit
    enable_audit_logging: bool = True

    # Custom override map (anything not covered above)
    extras: Dict[str, Any] = None  # type: ignore[assignment]

    # --------------------------------------------------------------------- #
    # Helpers                                                               #
    # --------------------------------------------------------------------- #

    @classmethod
    def from_sources(cls) -> "Settings":
        """
        Load and merge settings from defaults, YAML, and environment variables.

        Precedence: ENV VARS > YAML CONFIG > CLASS DEFAULTS
        """
        config_path_env = os.getenv("VITALOPS_CONFIG")
        default_path = pathlib.Path("/etc/vitalops/config.yaml")
        config_path = pathlib.Path(config_path_env) if config_path_env else default_path

        file_cfg: Dict[str, Any] = {}
        if config_path.exists():
            _log.debug("Loading config file from %s", config_path)
            if yaml is None:
                raise VitalOpsError(
                    f"YAML configuration '{config_path}' could not be loaded "
                    "because the optional dependency `PyYAML` is missing."
                )
            with io.open(config_path, "r", encoding="utf-8") as fh:
                file_cfg = yaml.safe_load(fh) or {}

        # Environment overrides
        env_cfg: Dict[str, Any] = {}
        for key in cls.__dataclass_fields__:  # type: ignore[attr-defined]
            env_key = f"VITALOPS_{key.upper()}"
            if env_key in os.environ:
                env_cfg[key] = os.environ[env_key]

        # Coerce lists/dicts if they were provided as JSON in ENV variables
        for key, value in list(env_cfg.items()):
            if isinstance(value, str) and (value.startswith("{") or value.startswith("[")):
                try:
                    env_cfg[key] = json.loads(value)
                except json.JSONDecodeError:
                    # keep as string but warn
                    _log.warning("Failed to JSON-decode environment variable %s", key)

        # Merge dictionaries – `extras` is treated explicitly
        merged: Dict[str, Any] = {**file_cfg, **env_cfg}  # precedence: env > file
        extras: Dict[str, Any] = merged.pop("extras", {})
        return cls(extras=extras, **merged)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Bootstrap API                                                               #
# --------------------------------------------------------------------------- #

# Global singletons (lazily initialised)
__settings_singleton: Optional[Settings] = None
__event_bus_singleton: Optional[EventBus] = None
__initialised_lock: threading.Lock = threading.Lock()


def get_settings() -> Settings:
    """
    Return the cached `Settings` instance, creating it on first use.

    This indirection is public so that unit-tests can monkeypatch settings
    *before* the rest of the application asks for them.
    """
    global __settings_singleton
    with __initialised_lock:
        if __settings_singleton is None:
            __settings_singleton = Settings.from_sources()
            # make logging consistent with config
            _log.setLevel(__settings_singleton.log_level.upper())
            _log.debug("Settings loaded: %s", __settings_singleton)
    return __settings_singleton


def get_event_bus() -> EventBus:
    """
    Return the shared, process-global EventBus instance.

    A singleton is sufficient for in-process communications.  When we support
    multi-process or clustered topologies, this function will be replaced by
    a thin wrapper that connects to the remote transport (e.g. NATS, Redis).
    """
    global __event_bus_singleton
    with __initialised_lock:
        if __event_bus_singleton is None:
            __event_bus_singleton = EventBus()
            _log.debug("EventBus initialised")
    return __event_bus_singleton


class _BootstrapContext:
    """
    Re-entrant context-manager that bootstraps VitalOps subsystems exactly once.

    The context-manager style is merely syntactic sugar so that call-sites can
    write::

        with vitalops.bootstrap():
            run_app()

    The enter/exit semantics are *idempotent*—exiting the context will *not*
    tear down global state to avoid surprises for other parts of the program.
    """

    _entered: bool = False

    def __enter__(self) -> "_BootstrapContext":  # noqa: D401
        if not self._entered:
            self._entered = True
            _log.debug("Bootstrapping VitalOps runtime...")
            get_settings()    # loads settings & configures logging
            get_event_bus()   # initialises the in-process event bus
            self._discover_plugins()
            _log.info("VitalOps runtime initialised (v%s)", __version__)
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> bool:
        if exc:
            _log.error("VitalOps encountered an unhandled exception", exc_info=exc)
        # Do *not* swallow exceptions
        return False

    # --------------------------------------------------------------------- #
    # Internal helpers                                                      #
    # --------------------------------------------------------------------- #

    @staticmethod
    def _discover_plugins() -> None:
        """
        Discover and register plugins (coordinators, policies, transports).

        Plugins are distributed via standard Python entry-points to decouple
        optional capabilities from the *core* package.  We iterate over
        `vitalops.plugins` and import them—import side-effects should perform
        the actual registration (SRP).
        """
        for entry_point in _importlib_metadata.entry_points().get("vitalops.plugins", []):
            try:
                _log.debug("Loading VitalOps plugin %s", entry_point.name)
                entry_point.load()
            except Exception:
                _log.exception("Failed to load VitalOps plugin '%s'", entry_point.name)


# --------------------------------------------------------------------------- #
# Public convenience alias                                                    #
# --------------------------------------------------------------------------- #

def bootstrap() -> _BootstrapContext:  # noqa: D401
    """
    Convenience wrapper that returns a re-entrant bootstrap context.

    Usage patterns:

        # 1. Simple (implicit teardown at program exit)
        from vitalops import bootstrap
        bootstrap()  # initialise once at import time

        # 2. Context-manager (explicit error handling)
        with bootstrap():
            run_app()

        # 3. Lazy usage in libraries
        def some_function():
            from vitalops import get_event_bus
            bus = get_event_bus()
            ...
    """
    return _BootstrapContext()


# Eager initialisation when *imported* by an application process, unless the
# caller explicitly opts-out via env var (useful for unit-tests).
if os.getenv("VITALOPS_DISABLE_AUTO_BOOTSTRAP", "").lower() not in {"1", "true"}:
    # We don't want to raise on bootstrap errors at import time; they'll surface
    # again upon first usage.
    try:
        bootstrap().__enter__()
    except Exception as exc:  # pragma: no cover – defensive
        _log.error("VitalOps auto-bootstrap failed: %s", exc, exc_info=exc)
```