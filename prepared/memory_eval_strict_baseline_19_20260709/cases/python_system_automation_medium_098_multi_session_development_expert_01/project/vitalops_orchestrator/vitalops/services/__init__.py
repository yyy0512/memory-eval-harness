```python
"""
vitalops_orchestrator.vitalops.services
======================================

The *services* package is the backbone of the VitalOps Orchestrator runtime.
It provides an opinionated, yet flexible, dependency-injection container that
is responsible for the life-cycle, health monitoring, and dynamic discovery of
all first- and third-party services that participate in the automation fabric.

The module is intentionally placed inside ``__init__.py`` so higher-level code
can simply::

    from vitalops.services import svc, registry

without caring about the underlying package structure.

Key Features
------------

* Abstract, asyncio-driven ``BaseService`` with proper life-cycle management
* Thread-safe ``ServiceRegistry`` (singleton) for dependency injection
* ``@svc`` decorator for zero-boilerplate registration
* Built-in & plug-in discovery (via ``importlib.metadata`` entry-points)
* Rich logging & defensive error handling
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import sys
from abc import ABC, abstractmethod
from enum import Enum, auto
from threading import RLock
from types import ModuleType
from typing import Any, Dict, Optional, Type, TypeVar, Callable

try:
    from importlib import metadata as importlib_metadata  # Py ≥ 3.8
except ImportError:  # pragma: no cover
    import importlib_metadata  # type: ignore[no-redef]

__all__ = [
    "ServiceState",
    "BaseService",
    "ServiceRegistry",
    "svc",
    "registry",
    "load_builtin_services",
    "discover_plugins",
]

_LOG = logging.getLogger(__name__)

###############################################################################
# Service Life-Cycle Abstractions
###############################################################################


class ServiceState(Enum):
    """Enumerates the runtime state of a service."""

    INITIALIZED = auto()
    RUNNING = auto()
    STOPPED = auto()
    FAILED = auto()

    def is_running(self) -> bool:
        return self is ServiceState.RUNNING


class BaseService(ABC):
    """
    Abstract base class for long-running, asynchronous services.

    Sub-classes must implement :pymeth:`_run` – the coroutine that represents
    the main body of work – and *may* override :pymeth:`shutdown` for graceful
    cleanup (closing DB connections, flushing files, etc.).
    """

    #: Default amount of seconds to wait during `stop()` for the internal task
    #: to finish before being *force-cancelled*.
    DEFAULT_SHUTDOWN_TIMEOUT = 10

    def __init__(self, name: Optional[str] = None) -> None:
        self._name = name or self.__class__.__name__
        self._state = ServiceState.INITIALIZED
        self._task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #

    @property
    def name(self) -> str:
        """Human-friendly service name."""
        return self._name

    @property
    def state(self) -> ServiceState:
        """Current life-cycle state."""
        return self._state

    async def start(self) -> None:
        """
        Start the service if it is not already running.

        This schedules :pymeth:`_run` as a background task and protects against
        concurrent start attempts.
        """
        async with self._lock:
            if self._state.is_running():
                _LOG.debug("Service %s is already running", self._name)
                return

            loop = asyncio.get_running_loop()
            self._task = loop.create_task(self._safe_runner(), name=self._name)
            self._state = ServiceState.RUNNING
            _LOG.info("Service %s started", self._name)

    async def stop(self, timeout: float = DEFAULT_SHUTDOWN_TIMEOUT) -> None:
        """
        Gracefully stop the service.

        The service first gets a chance to run :pymeth:`shutdown`. Afterwards
        the background task is cancelled if still alive.
        """
        async with self._lock:
            if not self._state.is_running():
                return

            try:
                await self.shutdown()
            except Exception:  # pragma: no cover
                _LOG.exception("Unexpected error during shutdown of %s", self._name)

            if self._task:
                self._task.cancel()

                try:
                    await asyncio.wait_for(self._task, timeout=timeout)
                except asyncio.TimeoutError:  # pragma: no cover
                    _LOG.warning(
                        "Service %s did not shut down in %.1fs – killing",
                        self._name,
                        timeout,
                    )
                except asyncio.CancelledError:
                    pass

            self._state = ServiceState.STOPPED
            _LOG.info("Service %s stopped", self._name)

    async def restart(self) -> None:
        """Utility helper: stop ⟶ start."""
        await self.stop()
        await self.start()

    # --------------------------------------------------------------------- #
    # Hooks for sub-classes
    # --------------------------------------------------------------------- #

    @abstractmethod
    async def _run(self) -> None:  # pragma: no cover
        """Main coroutine executed inside the dedicated background task."""

    async def shutdown(self) -> None:
        """
        Override for graceful tear-down logic.

        Called right before the internal task is cancelled. The default
        implementation does nothing.
        """

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #

    async def _safe_runner(self) -> None:
        """
        Wraps :pymeth:`_run` to capture & log unhandled exceptions.

        If an unhandled exception escapes, the service transitions to the
        ``FAILED`` state.
        """
        try:
            await self._run()
        except asyncio.CancelledError:
            # Normal termination path – propagate to let stop() handle cleanup.
            raise
        except Exception:  # pragma: no cover
            self._state = ServiceState.FAILED
            _LOG.exception("Service %s crashed", self._name)
        else:
            # The internal coroutine ended without being cancelled; treat this
            # as a *normal* stop to avoid silent death.
            if self._state is ServiceState.RUNNING:
                _LOG.warning(
                    "Service %s exited unexpectedly – marking as STOPPED", self._name
                )
                self._state = ServiceState.STOPPED


###############################################################################
# Dependency-Injection Container
###############################################################################

T = TypeVar("T", bound="BaseService")


class ServiceRegistry:
    """
    Thread-safe singleton that stores and manages service instances.

    Rather than exposing the constructor, a *module-level* instance called
    :data:`registry` is provided for convenience.
    """

    _instance: Optional["ServiceRegistry"] = None
    _mtx = RLock()  # guarantees singleton creation AND registry mutations

    # ------------------------------------------------------------------ #
    # Singleton boilerplate
    # ------------------------------------------------------------------ #

    def __new__(cls) -> "ServiceRegistry":  # noqa: D401
        with cls._mtx:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._services: Dict[str, BaseService] = {}
        return cls._instance

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def register(self, service: BaseService, *, overwrite: bool = False) -> None:
        """
        Register a service instance with the container.

        Args:
            service: Instance to register.
            overwrite: Allow replacing an existing service with the same name.

        Raises:
            ValueError: If a service with the name already exists and
                        ``overwrite`` is ``False``.
        """
        with self._mtx:
            if not overwrite and service.name in self._services:
                raise ValueError(f"Service '{service.name}' already registered")
            self._services[service.name] = service
            _LOG.debug("Registered service %s", service.name)

    def get(self, name: str, default: Optional[T] = None) -> Optional[T]:
        """Retrieve a service by name."""
        return self._services.get(name, default)

    def require(self, name: str) -> BaseService:
        """
        Same as :pymeth:`get` but raises if the service is missing.

        Raises:
            KeyError: if the service is not registered.
        """
        try:
            return self._services[name]
        except KeyError:  # pragma: no cover
            raise KeyError(f"Service '{name}' is not registered")

    async def start_all(self) -> None:
        """Start all registered services (sequentially)."""
        _LOG.info("Starting %d services …", len(self._services))
        for service in self._services.values():
            await service.start()

    async def stop_all(self) -> None:
        """Stop all services (in reverse registration order)."""
        _LOG.info("Stopping services …")
        for service in reversed(list(self._services.values())):
            await service.stop()

    # Diagnostic helpers ------------------------------------------------ #

    def health_report(self) -> Dict[str, str]:
        """Return a dict mapping service → ``state`` string."""
        return {name: svc.state.name for name, svc in self._services.items()}

    def __iter__(self):
        return iter(self._services.values())

    def __contains__(self, name: str) -> bool:
        return name in self._services


# Module-level global instance
registry = ServiceRegistry()

###############################################################################
# Decorator Sugar
###############################################################################


def svc(
    _cls: Optional[Type[T]] = None,
    *,
    name: Optional[str] = None,
    auto_start: bool = False,
    overwrite: bool = False,
) -> Callable[[Type[T]], Type[T]]:
    """
    Class decorator that automatically registers the service with the registry.

    Examples
    --------
    >>> @svc
    ... class MetricsCollector(BaseService):
    ...     async def _run(self): ...
    """

    def decorator(cls: Type[T]) -> Type[T]:
        if not issubclass(cls, BaseService):
            raise TypeError("@svc can only be applied to subclasses of BaseService")

        instance: BaseService = cls(name=name or cls.__name__)
        registry.register(instance, overwrite=overwrite)

        if auto_start:  # defer to the next running loop iteration
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                _LOG.warning(
                    "auto_start=True but no running loop is present – "
                    "service %s will not be started automatically",
                    instance.name,
                )
            else:
                loop.call_soon(loop.create_task, instance.start())

        return cls

    # Support both @svc and @svc(...)
    return decorator if _cls is None else decorator(_cls)  # type: ignore[arg-type]


###############################################################################
# Dynamic Discovery
###############################################################################


def _safe_import(name: str) -> Optional[ModuleType]:
    """
    Import a module but swallow *ModuleNotFoundError* if the sub-module
    does not exist. Any other exception is re-raised.
    """
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:  # pragma: no cover
        _LOG.debug("Optional module %s not found (%s)", name, exc)
    return None


def load_builtin_services() -> None:
    """
    Import built-in service definitions shipped with VitalOps Orchestrator.

    Adding a new module to the ``vitalops.services`` package (e.g.
    ``vitalops.services.alerting``) that contains one or more ``@svc`` classes
    is enough for the registry to pick the services up.
    """
    _LOG.debug("Loading built-in service modules …")

    # Candidates can be discovered dynamically (pkg_resources walk_packages);
    # we keep it explicit to be extra-robust and cheap at import time.
    for sub_mod in (
        ".metrics",
        ".alerting",
        ".backup",
        ".deployment",
        ".loadbalancer",
    ):
        _safe_import(__name__ + sub_mod)


def discover_plugins(entry_group: str = "vitalops.services") -> None:
    """
    Discover 3rd-party service plug-ins via *entry points*.

    Developers can ship additional orchestration logic as wheels that declare
    in their ``setup.cfg``/``pyproject.toml``::

        [project.entry-points."vitalops.services"]
        my_custom = acme.hospital:CustomService

    Such services are transparently registered without changes to core code.
    """
    _LOG.debug("Discovering plug-ins for entry group '%s' …", entry_group)

    try:
        eps = importlib_metadata.entry_points(group=entry_group)
    except Exception as exc:  # pragma: no cover
        _LOG.error("Failed to read entry points: %s", exc)
        return

    for ep in eps:
        try:
            cls = ep.load()
        except Exception:  # pragma: no cover
            _LOG.exception("Failed to load entry point '%s'", ep.name)
            continue

        if not isinstance(cls, type) or not issubclass(cls, BaseService):
            _LOG.warning(
                "Entry point '%s' does not expose a BaseService subclass", ep.name
            )
            continue

        try:
            instance = cls()
            registry.register(instance)
            _LOG.info(
                "Plug-in service '%s' (class %s) successfully registered",
                ep.name,
                cls.__qualname__,
            )
        except Exception:  # pragma: no cover
            _LOG.exception("Failed to register plug-in service '%s'", ep.name)


###############################################################################
# Optional one-shot initializer
###############################################################################


def init_services(
    *,
    discover: bool = True,
    start_immediately: bool = False,
) -> None:
    """
    Convenience helper that performs the *typical* bootstrapping sequence:
    1. Import built-in service modules
    2. Detect & load plug-ins
    3. Optionally start all services right away

    This keeps the top-level ``main.py`` clean::

        import asyncio
        from vitalops.services import init_services, registry

        async def main():
            init_services(start_immediately=False)
            await registry.start_all()
            ...
    """
    load_builtin_services()

    if discover:
        discover_plugins()

    if start_immediately:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover
            _LOG.warning(
                "init_services(start_immediately=True) called outside "
                "an event loop – services will not auto-start"
            )
        else:
            loop.create_task(registry.start_all())


###############################################################################
# Eagerly load built-ins at import time for most entry points (tests, CLI, …)
###############################################################################

# In *library* context we do NOT start services automatically; that must be
# an explicit decision made by the application entry point.
load_builtin_services()

# Plug-ins are kept lazy to avoid surprising side effects when importing the
# package for metadata (e.g., sphinx autodoc, type checkers, …).
if "pytest" in sys.modules:  # pragma: no cover
    # During testing we want deterministic behaviour and no external plugins.
    _LOG.debug("Skipping plug-in discovery while under pytest")
else:
    discover_plugins()
```