```python
"""
vitalops.coordinators
====================

Package bootstrap for all *Coordinator* view-models that drive VitalOps
automation workflows.

Responsibilities
----------------
1. Provide a *single source of truth* registry that maps coordinator names to
   their concrete, importable classes.
2. Support implicit, **lazy discovery** of any sub-modules located under the
   ``vitalops.coordinators`` namespace (or an external plugin path specified
   via the ``VITALOPS_PLUGIN_PATH`` environment variable).
3. Expose convenience helpers so that upstream layers (CLI, REST API, event
   bus) can *resolve* and *instantiate* coordinators without depending on the
   concrete implementation.
4. Keep the API thread-safe and production-ready with proper error handling.

The module intentionally keeps *all* public symbols in ``__all__`` so that
``from vitalops.coordinators import *`` remains predictable.

NOTE:
-----
Although the built-in registry can automatically discover and register classes
while importing sub-modules, coordinators are encouraged to use the
``@coordinator`` decorator for explicit registration so that they remain usable
in isolation and during unit tests (where auto-discovery might be disabled).
"""

from __future__ import annotations

import importlib
import logging
import os
import pkgutil
import sys
import threading
from types import ModuleType
from typing import Any, Callable, Dict, Iterable, Mapping, MutableMapping, Type, TypeVar

__all__ = [
    # Exceptions
    "CoordinatorError",
    "CoordinatorLookupError",
    "CoordinatorRegistrationError",
    # Decorators / helpers
    "coordinator",
    "get_coordinator_cls",
    "create_coordinator",
    "discover_coordinators",
    # Core classes
    "BaseCoordinator",
    "CoordinatorRegistry",
    "registry",
]

_T = TypeVar("_T")
_LOGGER = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# Exceptions
# -----------------------------------------------------------------------------
class CoordinatorError(RuntimeError):
    """Base exception for all coordinator-related failures."""


class CoordinatorRegistrationError(CoordinatorError):
    """Raised when a coordinator cannot be registered (duplicate, invalid)."""


class CoordinatorLookupError(CoordinatorError):
    """Raised when a coordinator cannot be found in the registry."""


# -----------------------------------------------------------------------------
# Coordinator Registry (thread-safe singleton)
# -----------------------------------------------------------------------------
class CoordinatorRegistry:
    """
    Thread-safe registry responsible for keeping track of all *Coordinator*
    derivatives available to the Automation Fabric at runtime.
    """

    # We voluntarily keep a *single* process-wide instance.  A different
    # instance would be pathological because coordinators are referenced by
    # name in JSON/YAML policy files and event payloads.
    _instance: "CoordinatorRegistry | None" = None
    _lock: "threading.RLock[str]" = threading.RLock()

    def __new__(cls) -> "CoordinatorRegistry":  # noqa: D401, N804
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._coordinators: MutableMapping[str, Type["BaseCoordinator"]] = (
                    {}
                )
            return cls._instance

    # ----------------------------------------------------------------------
    # Public API
    # ----------------------------------------------------------------------
    def register(self, name: str, cls: Type["BaseCoordinator"]) -> None:
        """
        Register a coordinator **class** under the given name.

        Parameters
        ----------
        name:
            Canonical identifier used in event payloads (`"performance"`,
            `"recovery"`, …).
        cls:
            The *concrete* subclass implementing :class:`BaseCoordinator`.
        """
        with self._lock:
            _LOGGER.debug("Attempting to register coordinator '%s' -> %s", name, cls)
            if name in self._coordinators and self._coordinators[name] is not cls:
                raise CoordinatorRegistrationError(
                    f"Coordinator name '{name}' already mapped to "
                    f"{self._coordinators[name]!r}"
                )
            self._coordinators[name] = cls
            _LOGGER.debug("Registered coordinator '%s' successfully", name)

    def get(self, name: str) -> Type["BaseCoordinator"]:
        """Return the coordinator class registered under *name*."""
        try:
            return self._coordinators[name]
        except KeyError as exc:
            raise CoordinatorLookupError(f"Unknown coordinator '{name}'") from exc

    def all(self) -> Mapping[str, Type["BaseCoordinator"]]:
        """Return a *snapshot* dict with all registered coordinators."""
        # We expose a *shallow copy* to protect the internal mapping
        return dict(self._coordinators)

    def __contains__(self, item: str) -> bool:  # noqa: D401
        return item in self._coordinators

    # Optional convenience for interactive sessions
    def __repr__(self) -> str:  # noqa: D401
        return f"<CoordinatorRegistry ({len(self._coordinators)} registered)>"


# Public, module-level registry instance
registry = CoordinatorRegistry()


# -----------------------------------------------------------------------------
# Base class & decorator
# -----------------------------------------------------------------------------
class BaseCoordinator:
    """
    All coordinators must inherit from this base class and implement at least
    `start()` and `stop()`.

    Child classes **must** be side-effect free in their constructor so that
    they can be instantiated eagerly (e.g., when CLI displays `--help`).
    """

    name: str | None = None  # Override in child classes

    def __init__(self, **kwargs: Any) -> None:  # noqa: D401
        self._config: Dict[str, Any] = kwargs
        self._running = threading.Event()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:  # noqa: D401
        """
        Start the coordinator loop.

        Child classes should *quickly* return to avoid blocking the event
        loop.  Long-running logic must be scheduled in a worker thread or
        an asyncio task (depending on the application's concurrency model).
        """
        raise NotImplementedError

    def stop(self) -> None:  # noqa: D401
        """Gracefully stop the coordinator."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Observer / Event handling
    # ------------------------------------------------------------------
    def handle_event(self, event: Mapping[str, Any]) -> None:
        """
        Handle an incoming automation event.

        Parameters
        ----------
        event:
            A dictionary following the VitalOps Event Contract:
            {
                "id": "uuid4",
                "timestamp": "...",
                "type": "performance.metric",
                "payload": {...}
            }
        """
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def __enter__(self) -> "BaseCoordinator":  # noqa: D401
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: D401
        self.stop()

    # ------------------------------------------------------------------
    # Introspection sugar
    # ------------------------------------------------------------------
    def __repr__(self) -> str:  # noqa: D401
        return f"<{self.__class__.__name__}(running={self._running.is_set()})>"


def coordinator(name: str | None = None) -> Callable[[Type[_T]], Type[_T]]:
    """
    Class decorator that automatically registers the decorated coordinator
    into the global :data:`registry`.

    Usage
    -----
    >>> @coordinator("performance")
    ... class PerformanceCoordinator(BaseCoordinator):
    ...     ...

    If *name* is omitted, the decorator will look for a `name` attribute on the
    class or fall back to the **snake-case** version of the class name.
    """

    def _decorator(cls: Type[_T]) -> Type[_T]:
        if not issubclass(cls, BaseCoordinator):
            raise CoordinatorRegistrationError(
                f"Class {cls.__qualname__} must inherit from BaseCoordinator"
            )

        # Determine canonical name
        canonical = name or getattr(cls, "name", None)
        if not canonical:
            # Convert `SomeCoordinator` -> "some"
            canonical = cls.__name__.replace("Coordinator", "")
            canonical = _camel_to_snake(canonical)
        registry.register(canonical, cls)
        return cls

    return _decorator


# -----------------------------------------------------------------------------
# Public helper functions
# -----------------------------------------------------------------------------
def get_coordinator_cls(name: str) -> Type[BaseCoordinator]:
    """Return the coordinator *class* associated with *name*."""
    return registry.get(name)


def create_coordinator(name: str, **kwargs: Any) -> BaseCoordinator:
    """
    Instantiate the coordinator associated with *name*.

    Additional keyword arguments are forwarded to the class constructor.
    """
    cls = get_coordinator_cls(name)
    return cls(**kwargs)


def discover_coordinators(
    extra_paths: Iterable[str] | None = None, *, reload_modules: bool = False
) -> None:
    """
    Import all sub-modules under ``vitalops.coordinators`` to trigger
    `@coordinator` decorators and populate the registry.

    This function can be safely called multiple times; subsequent calls will be
    *no-ops* unless *reload_modules* is set to *True*.

    Parameters
    ----------
    extra_paths:
        Iterable of additional paths (directories) that might contain user-
        defined coordinator plugins (e.g., */opt/vitalops/plugins*).
    reload_modules:
        Force re-loading previously imported modules.  Useful mainly for unit
        tests and interactive development.
    """
    explored_paths = set()

    def _import_module(fullname: str) -> None:
        if fullname in sys.modules and not reload_modules:
            return
        try:
            _LOGGER.debug("Importing coordinator module: %s", fullname)
            importlib.import_module(fullname)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Failed to import coordinator module '%s'", fullname)

    # Discover *internal* coordinators (package resources)
    for mod_info in pkgutil.walk_packages(__path__, prefix=f"{__name__}."):
        _import_module(mod_info.name)
        explored_paths.add(mod_info.module_finder.path)

    # Discover *external* plugins
    plugin_paths = list(extra_paths or [])
    env_path = os.getenv("VITALOPS_PLUGIN_PATH")
    if env_path:
        plugin_paths.extend(env_path.split(os.pathsep))

    for path in plugin_paths:
        if not os.path.isdir(path):
            _LOGGER.warning("Plugin path '%s' does not exist or is not a directory", path)
            continue
        for mod_info in pkgutil.walk_packages([path], prefix="vitalops_plugins."):
            _import_module(mod_info.name)
    _LOGGER.info("Coordinator discovery complete: %d registered", len(registry.all()))


# -----------------------------------------------------------------------------
# Internal utilities
# -----------------------------------------------------------------------------
def _camel_to_snake(name: str) -> str:
    """Convert CamelCase to snake_case."""
    import re

    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


# -----------------------------------------------------------------------------
# Automatic discovery at import-time (optional)
# -----------------------------------------------------------------------------
# By default we *eagerly* discover built-in coordinators so that the registry is
# ready as soon as the package is imported.  External plugins still need an
# explicit call to `discover_coordinators(extra_paths=…)`.
try:
    discover_coordinators()
except Exception:  # noqa: BLE001
    # Do not prevent the application from starting; discovery can be retried later.
    _LOGGER.exception("Coordinator auto-discovery failed during package import")
```