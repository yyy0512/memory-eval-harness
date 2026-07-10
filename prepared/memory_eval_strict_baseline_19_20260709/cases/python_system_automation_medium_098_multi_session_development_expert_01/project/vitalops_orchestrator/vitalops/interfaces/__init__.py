```python
"""
VitalOps Orchestrator – Interface Layer
======================================

This package-level module acts as the façade and plugin-loader for every
*user-facing* interface exposed by the VitalOps Orchestrator.  Web dashboards,
CLI tools, Grafana data-sources, mobile push notifications, and any future UI
can be published as **InterfaceAdapter** subclasses and auto-discovered at
runtime via ``importlib.metadata.entry_points(group="vitalops.interfaces")``.

Responsibilities
----------------
1. Provide a common *Observer-Pattern* contract (`InterfaceAdapter`) so that
   ViewModels can stream events to multiple UI front-ends without tight
   coupling.
2. Offer a thread-safe *registry* for creating, retrieving, and broadcasting to
   interfaces at runtime.
3. Support *dynamic plugin loading* using Python packaging entry-points, giving
   downstream teams the ability to distribute their own interface modules
   (e.g., XDR feeds, voice assistants) without altering core code.
4. Ship a couple of built-in adapters (CLI & Grafana push gateway) that
   demonstrate how to implement a real interface while keeping heavy
   dependencies optional.

Usage Example
-------------

>>> from vitalops.interfaces import create_interface, broadcast_event
>>> grafana = create_interface("grafana")
>>> cli     = create_interface("cli")
>>> broadcast_event({"type": "ALERT", "payload": ...})  # fan-out

"""

from __future__ import annotations

import contextlib
import importlib
import logging
import os
import queue
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Type

try:
    # importlib.metadata is stdlib in 3.10+; use backport for earlier versions
    from importlib.metadata import entry_points, EntryPoint  # type: ignore
except ImportError:  # pragma: no cover
    from importlib_metadata import entry_points, EntryPoint  # type: ignore

__all__ = [
    "InterfaceError",
    "InterfaceAdapter",
    "register_interface",
    "create_interface",
    "get_interface",
    "available_interfaces",
    "broadcast_event",
]

_LOGGER = logging.getLogger("vitalops.interfaces")
_LOGGER.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #
class InterfaceError(RuntimeError):
    """Raised when an interface adapter cannot be loaded, started or used."""


# --------------------------------------------------------------------------- #
# Abstract Base Class
# --------------------------------------------------------------------------- #
class InterfaceAdapter(ABC):
    """
    Abstract base class for every user-facing interface adapter.

    Implementations must be *idempotent*; calling ``open`` or ``close`` multiple
    times should not raise.  The *event* being notified is expected to be a
    **dict** with a mandatory ``type`` field.
    """

    def __init__(self, **kwargs: Any) -> None:
        self._is_open = False
        self._lock = threading.RLock()
        self._config: Mapping[str, Any] = kwargs

    # --------------------------------------------------------------------- #
    # Life-cycle
    # --------------------------------------------------------------------- #
    def open(self) -> None:
        """Initialize resources (network sockets, file handles, etc.)."""
        with self._lock:
            if not self._is_open:
                self._open()
                self._is_open = True
                _LOGGER.info("%s interface opened.", self.name)

    def close(self) -> None:
        """Gracefully release resources."""
        with self._lock:
            if self._is_open:
                self._close()
                self._is_open = False
                _LOGGER.info("%s interface closed.", self.name)

    @abstractmethod
    def _open(self) -> None:  # pragma: no cover
        ...

    @abstractmethod
    def _close(self) -> None:  # pragma: no cover
        ...

    # --------------------------------------------------------------------- #
    # Observer API
    # --------------------------------------------------------------------- #
    @abstractmethod
    def notify(self, event: Mapping[str, Any]) -> None:  # pragma: no cover
        """
        Receive an event coming from a ViewModel.

        Implementations must *never* block longer than absolutely necessary.  If
        the operation can take time (network I/O), spawn background tasks or
        offload to a queue to keep orchestrator throughput high.
        """

    # --------------------------------------------------------------------- #
    # Properties
    # --------------------------------------------------------------------- #
    @property
    def name(self) -> str:
        return self.__class__.__name__.replace("Adapter", "").lower()

    # Convenience for context-manager usage
    def __enter__(self) -> "InterfaceAdapter":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


# --------------------------------------------------------------------------- #
# Registry / Plugin Loader
# --------------------------------------------------------------------------- #
_REGISTRY: MutableMapping[str, Type[InterfaceAdapter]] = {}
_INSTANCES: MutableMapping[str, InterfaceAdapter] = {}
_LOCK = threading.RLock()


def register_interface(name: str) -> Any:
    """
    Class decorator used by native interface implementations.

    Example:
        @register_interface("cli")
        class CLIAdapter(InterfaceAdapter):
            ...
    """

    def decorator(cls: Type[InterfaceAdapter]) -> Type[InterfaceAdapter]:
        if not issubclass(cls, InterfaceAdapter):
            raise InterfaceError(
                f"Cannot register '{cls.__name__}' – not an InterfaceAdapter."
            )
        with _LOCK:
            if name in _REGISTRY:
                raise InterfaceError(f"An interface named '{name}' is already registered")
            _REGISTRY[name] = cls
            _LOGGER.debug("Registered interface '%s' [%s]", name, cls.__name__)
        return cls

    return decorator


def _load_entry_point_plugins() -> None:
    """
    Discover and load 3rd-party InterfaceAdapter classes declared via
    ``setup.cfg`` / ``pyproject.toml``:

        [project.entry-points."vitalops.interfaces"]
        awesome_ui = vitalops_awesome_ui:AwesomeUIAdapter
    """
    eps = entry_points()
    for ep in eps.select(group="vitalops.interfaces"):  # type: ignore[attr-defined]
        name: str = ep.name  # e.g. "awesome_ui"
        if name in _REGISTRY:
            continue  # Do not override built-ins
        try:
            cls = ep.load()
            if not issubclass(cls, InterfaceAdapter):
                _LOGGER.warning("Entry-point '%s' does not inherit InterfaceAdapter", name)
                continue
            _REGISTRY[name] = cls
            _LOGGER.info("Loaded 3rd-party interface '%s' [%s]", name, cls.__name__)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            _LOGGER.error("Failed to load interface '%s': %s", name, exc)


def available_interfaces() -> List[str]:
    """Return a list of interface names that can be instantiated."""
    with _LOCK:
        return sorted(_REGISTRY.keys())


def get_interface(name: str) -> InterfaceAdapter:
    """
    Return a *singleton* instance of the requested interface.  The instance is
    lazily constructed on first call.
    """
    with _LOCK:
        if name not in _REGISTRY:
            raise InterfaceError(f"Unknown interface '{name}'. "
                                 f"Available are: {', '.join(available_interfaces())}")
        if name not in _INSTANCES:
            _INSTANCES[name] = _REGISTRY[name]()
            _INSTANCES[name].open()
        return _INSTANCES[name]


def create_interface(name: str, **kwargs: Any) -> InterfaceAdapter:
    """
    Create *and* return a **new** interface instance.  Useful when multiple
    independent instances of the same adapter are required (e.g., multi-tenant
    dashboards).  Unlike `get_interface`, this does not enforce a singleton.
    """
    with _LOCK:
        if name not in _REGISTRY:
            raise InterfaceError(f"Unknown interface '{name}'. "
                                 f"Available are: {', '.join(available_interfaces())}")
        instance = _REGISTRY[name](**kwargs)
        instance.open()
        return instance


def broadcast_event(event: Mapping[str, Any], *, suppress_errors: bool = True) -> None:
    """
    Fan-out an *event* to **all** currently open interface instances.

    Parameters
    ----------
    event : Mapping[str, Any]
        The event payload.  Must contain a 'type' key.
    suppress_errors : bool
        When *True* (default) exceptions raised by one interface will be logged
        and suppressed, so other interfaces still receive the event.
    """
    if "type" not in event:
        raise ValueError("Event must contain a 'type' field")

    with _LOCK:
        targets = list(_INSTANCES.values())

    for adapter in targets:
        try:
            adapter.notify(event)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            if suppress_errors:
                _LOGGER.exception(
                    "Interface '%s' failed to handle event %s: %s",
                    adapter.name,
                    event.get("type"),
                    exc,
                )
            else:
                raise


# --------------------------------------------------------------------------- #
# Built-in Interface Implementations
# --------------------------------------------------------------------------- #
@register_interface("cli")
class CLIAdapter(InterfaceAdapter):
    """
    Very lightweight **Command-Line Interface** adapter that prints events to
    stdout.  Intended as a reference implementation and for quick debugging.
    """

    _COLOR_MAP = {
        "ALERT": "\033[1;31m",  # red
        "INFO": "\033[0;37m",   # gray
        "METRIC": "\033[0;36m", # cyan
        "ENDC": "\033[0m",
    }

    def _open(self) -> None:
        _LOGGER.debug("CLIAdapter started.")

    def _close(self) -> None:
        _LOGGER.debug("CLIAdapter stopped.")

    def notify(self, event: Mapping[str, Any]) -> None:
        color = self._COLOR_MAP.get(event["type"], "")
        endc = self._COLOR_MAP["ENDC"] if color else ""
        print(f"{color}[{event['type']}] {event.get('message', event)}{endc}", flush=True)


@register_interface("grafana")
class GrafanaAdapter(InterfaceAdapter):
    """
    Pushes orchestrator metrics/events to a Prometheus Pushgateway which
    Grafana consumes.  Heavy network I/O is executed in a background thread so
    that `notify` is non-blocking.
    """

    DEFAULT_GATEWAY = os.getenv("VITALOPS_PUSHGATEWAY", "http://localhost:9091")

    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        self._gateway: str = kwargs.get("gateway", self.DEFAULT_GATEWAY)
        self._queue: "queue.Queue[Mapping[str, Any]]" = queue.Queue(maxsize=500)
        self._worker: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def _open(self) -> None:
        self._stop_event.clear()
        self._worker = threading.Thread(
            target=self._worker_loop, name="GrafanaAdapterWorker", daemon=True
        )
        self._worker.start()
        _LOGGER.debug("GrafanaAdapter worker thread started (gateway=%s)", self._gateway)

    def _close(self) -> None:
        self._stop_event.set()
        if self._worker and self._worker.is_alive():
            self._worker.join(timeout=3.0)
        _LOGGER.debug("GrafanaAdapter worker thread stopped.")

    def notify(self, event: Mapping[str, Any]) -> None:
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            _LOGGER.warning("GrafanaAdapter queue is full; dropping event: %s", event)

    # --------------------------------------------------------------------- #
    # Worker
    # --------------------------------------------------------------------- #
    def _worker_loop(self) -> None:
        import json
        import urllib.error
        import urllib.request

        while not self._stop_event.is_set():
            try:
                event = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue  # check stop flag

            # Convert event into line protocol or JSON expected by pushgateway
            payload = json.dumps(event).encode()
            req = urllib.request.Request(
                url=f"{self._gateway}/metrics/job/vitalops_orchestrator",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with contextlib.closing(urllib.request.urlopen(req, timeout=2.0)):
                    _LOGGER.debug("Pushed event to Pushgateway: %s", event.get("type"))
            except urllib.error.URLError as exc:
                _LOGGER.warning("Failed to push event to Pushgateway (%s): %s", self._gateway, exc)

            self._queue.task_done()


# --------------------------------------------------------------------------- #
# Initialize
# --------------------------------------------------------------------------- #
_load_entry_point_plugins()
_LOGGER.info("Interface subsystem initialised – available: %s", ", ".join(available_interfaces()))
```