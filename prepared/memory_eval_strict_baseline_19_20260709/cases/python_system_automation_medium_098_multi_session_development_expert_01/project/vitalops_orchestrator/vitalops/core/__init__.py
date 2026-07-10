```python
"""
vitalops.core
=============

Core bootstrap, dependency wiring, and public-facing API surface for
the VitalOps Orchestrator.  Importing this package **does not** start
any background tasks automatically.  Instead, call :func:`bootstrap`
with a path (or dict) containing runtime configuration to begin event
processing.

The module intentionally hides the underlying implementation details
from consumers—SRE dashboards, CLI tooling, or clinical service mesh
side-cars—while exposing only the abstractions required to publish /
subscribe to orchestration events.

Example
-------
>>> from vitalops.core import bootstrap, bus
>>> bootstrap("/etc/vitalops.yml")
>>> bus.publish("svc.perf.high_latency", container_id="rx-svc-12", latency_ms=412)

All events published through :data:`bus` will be routed to the
Chain-of-Responsibility pipelines registered during bootstrap.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, List, MutableMapping, Optional

try:
    # PyYAML is optional (easier for local dev); JSON fallback is provided
    import yaml
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore

__all__ = [
    "bootstrap",
    "shutdown",
    "bus",
    "get_settings",
    "BootstrapError",
    "Settings",
]

__version__: str = "2.3.0"  # Update via CI release pipeline

###############################################################################
# Logging helpers
###############################################################################

class _PHIRedactor(logging.Filter):
    """
    HIPAA compliance requires that no Protected Health Information (PHI)
    be written to non-encrypted log sinks.  This filter performs simple
    heuristic redaction (name, MRN, phone) and can be extended to plug
    in a proper NLP pipeline for advanced detection.
    """

    _REDACTION = "***REDACTED***"

    # very naive patterns for illustration purposes only
    _NAME_KEYS = {"first_name", "last_name", "patient_name"}
    _MRN_KEYS = {"mrn", "medical_record_number"}
    _PHONE_KEYS = {"phone", "phone_number", "tel"}

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, MutableMapping):
            record.args = self._clean_dict(record.args)  # type: ignore
        elif isinstance(record.args, tuple):
            # Convert tuple->list to allow mutation, then convert back.
            args_list = list(record.args)
            record.args = tuple(self._clean_value(v) for v in args_list)  # type: ignore

        record.msg = self._clean_value(record.msg)
        return True

    def _clean_dict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            k: self._REDACTION if self._should_redact(k) else self._clean_value(v)
            for k, v in payload.items()
        }

    def _clean_value(self, v: Any) -> Any:
        if isinstance(v, dict):
            return self._clean_dict(v)
        if isinstance(v, (list, tuple, set)):
            return type(v)(self._clean_value(i) for i in v)
        if isinstance(v, str) and self._contains_phi_like_tokens(v):
            return self._REDACTION
        return v

    def _should_redact(self, key: str) -> bool:
        return key.lower() in (
            *self._NAME_KEYS,
            *self._MRN_KEYS,
            *self._PHONE_KEYS,
        )

    def _contains_phi_like_tokens(self, s: str) -> bool:
        # Dummy heuristic: 8+ consecutive digits may be MRN / phone
        return any(char.isdigit() for char in s) and len(s) >= 8


def _configure_logging(debug: bool) -> None:
    """Create a sane default structured logger."""
    level = logging.DEBUG if debug else logging.INFO
    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        fmt="%(asctime)s|%(levelname)s|%(name)s|%(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    handler.setFormatter(formatter)
    handler.addFilter(_PHIRedactor())
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)
    # Reduce noise from dependencies
    logging.getLogger("urllib3").setLevel(logging.WARNING)


###############################################################################
# Configuration handling
###############################################################################

@dataclass(frozen=True)
class Settings:
    """
    Immutable runtime settings object.

    All values are loaded from (in order of precedence):
    1. Keyword arguments passed directly to :func:`bootstrap`
    2. Environment variables (prefixed with 'VITALOPS_')
    3. YAML/JSON configuration file
    4. Built-in defaults
    """

    debug: bool = False
    event_loop_policy: str = "asyncio"  # or "uvloop"
    max_concurrent_tasks: int = 256
    config_file: Optional[Path] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(
        cls,
        path: Optional[os.PathLike] = None,
        **overrides: Any,
    ) -> "Settings":
        # 1) file (optional)
        file_payload: Dict[str, Any] = {}
        cfg_path: Optional[Path] = Path(path) if path else None
        if cfg_path:
            if not cfg_path.exists():
                raise FileNotFoundError(cfg_path)
            if cfg_path.suffix.lower() in {".yml", ".yaml"} and yaml:
                file_payload = yaml.safe_load(cfg_path.read_text()) or {}
            else:
                # Assume JSON
                file_payload = json.loads(cfg_path.read_text())
        # 2) env vars
        env_payload = {
            k[9:].lower(): cls._parse_env_value(v)
            for k, v in os.environ.items()
            if k.startswith("VITALOPS_")
        }
        # 3) combine
        merged: Dict[str, Any] = {
            **file_payload,
            **env_payload,
            **overrides,
        }
        if cfg_path and "config_file" not in merged:
            merged["config_file"] = cfg_path

        # Validate simple invariants
        if merged.get("max_concurrent_tasks", 0) <= 0:
            raise ValueError("max_concurrent_tasks must be > 0")

        return cls(**merged)  # type: ignore[arg-type]

    @staticmethod
    def _parse_env_value(raw: str) -> Any:
        lowered = raw.lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
        if raw.isdigit():
            return int(raw)
        try:
            return float(raw)
        except ValueError:
            return raw


###############################################################################
# Event bus (Observer pattern) – simplified for demonstration
###############################################################################

_SubHandler = Callable[..., Awaitable[None]] | Callable[..., None]


class _EventBus:
    """In-process pub/sub bus with coroutine support."""

    def __init__(self) -> None:
        self._subs: Dict[str, List[_SubHandler]] = {}
        self._lock = threading.Lock()
        self._logger = logging.getLogger(self.__class__.__name__)

    # --------------------------------------------------------------------- #
    # Subscription management
    # --------------------------------------------------------------------- #

    def subscribe(self, topic: str, handler: _SubHandler) -> None:
        """
        Register a subscriber for *topic*.  Wildcards are not supported
        inside topic names; use hierarchical naming e.g. ``svc.perf.*``
        in application code if needed.
        """
        if not callable(handler):
            raise TypeError("handler must be callable")
        with self._lock:
            self._subs.setdefault(topic, []).append(handler)
        self._logger.debug("Subscribed %s to '%s'", handler, topic)

    def unsubscribe(self, topic: str, handler: _SubHandler) -> None:
        with self._lock:
            handlers = self._subs.get(topic, [])
            try:
                handlers.remove(handler)
                self._logger.debug("Unsubscribed %s from '%s'", handler, topic)
            except ValueError:
                self._logger.warning(
                    "Attempted to unsubscribe handler not found: %s", handler
                )

    # --------------------------------------------------------------------- #
    # Publishing
    # --------------------------------------------------------------------- #

    def publish(self, topic: str, **payload: Any) -> None:
        """
        Publish an event synchronously (fire-and-forget).  Async handlers
        will be scheduled on the running loop without awaiting.
        """
        handlers = self._subs.get(topic, [])
        if not handlers:
            self._logger.debug("No subscribers for topic '%s'", topic)
            return

        self._logger.debug("Publishing '%s' to %d handlers", topic, len(handlers))
        loop = None
        for h in handlers:
            try:
                if asyncio.iscoroutinefunction(h):
                    loop = loop or asyncio.get_running_loop()
                    loop.create_task(h(**payload))  # type: ignore[arg-type]
                else:
                    h(**payload)  # type: ignore[operator,arg-type]
            except Exception:
                self._logger.exception("Handler failure (topic=%s, handler=%s)", topic, h)

    # --------------------------------------------------------------------- #
    # Introspection helpers
    # --------------------------------------------------------------------- #

    def topics(self) -> Iterable[str]:
        with self._lock:
            return tuple(self._subs.keys())

    def subscribers(self, topic: str) -> Iterable[_SubHandler]:
        with self._lock:
            return tuple(self._subs.get(topic, []))


###############################################################################
# Bootstrap / shutdown orchestration
###############################################################################

class BootstrapError(RuntimeError):
    """Raised if :func:`bootstrap` fails in an unrecoverable manner."""


_bootstrapped = False
_settings: Optional[Settings] = None
bus: _EventBus = _EventBus()


def bootstrap(
    config: Optional[os.PathLike | Dict[str, Any]] = None,
    **overrides: Any,
) -> Settings:
    """
    Initialize core framework pieces.  Safe to call multiple times; only
    the first invocation has an effect (subsequent calls return the same
    :class:`Settings` object).

    Parameters
    ----------
    config:
        Path to JSON/YAML config file **or** dict-like object with
        configuration keys.
    **overrides:
        Highest-precedence overrides.

    Returns
    -------
    Settings
        The frozen runtime settings instance.
    """
    global _bootstrapped, _settings

    if _bootstrapped:
        assert _settings is not None
        return _settings

    try:
        file_path: Optional[os.PathLike] = None
        initial: Dict[str, Any] = {}
        if isinstance(config, (str, os.PathLike)):
            file_path = config
        elif isinstance(config, dict):
            initial = config
        elif config is not None:
            raise TypeError("config must be path-like, dict, or None")

        _settings = Settings.load(file_path, **initial, **overrides)
        _configure_logging(_settings.debug)
        _configure_event_loop_policy(_settings.event_loop_policy)
        _register_core_subscriptions()
        _bootstrapped = True
        logging.getLogger(__name__).info("VitalOps core bootstrapped")
        return _settings
    except Exception as exc:
        raise BootstrapError("VitalOps bootstrap failed") from exc


def shutdown() -> None:
    """
    Attempt to gracefully shut down the event bus and other async tasks.
    This function is **idempotent** and can be used from application
    exit handlers or test teardown.
    """
    global _bootstrapped, _settings
    if not _bootstrapped:
        return

    logging.getLogger(__name__).info("Shutting down VitalOps core")
    # No active resources to clean up in this simplified example, but in
    # production this would drain queues, cancel tasks, flush metrics, etc.
    _bootstrapped = False
    _settings = None
    # Clear subscriptions to avoid memory leaks in test suites
    bus._subs.clear()


###############################################################################
# Helpers
###############################################################################

def get_settings() -> Settings:
    """
    Returns
    -------
    Settings
        The current runtime settings.  Raises :class:`BootstrapError`
        if :func:`bootstrap` was not called beforehand.
    """
    if _settings is None:
        raise BootstrapError("VitalOps has not been bootstrapped yet")
    return _settings


def _configure_event_loop_policy(policy_name: str) -> None:
    """
    Optionally switch the underlying asyncio event loop to a policy
    optimized for high-throughput (e.g. uvloop).  Fallback to default
    Python event loop if uvloop is not installed.
    """
    logger = logging.getLogger(__name__)
    if policy_name == "uvloop":
        try:
            import uvloop  # type: ignore
            asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
            logger.debug("Using uvloop event loop policy")
        except ImportError:
            logger.warning("uvloop requested but not installed; using default policy")


def _register_core_subscriptions() -> None:
    """
    Wire low-level observers that are required for internal operation,
    such as metrics collection or trace logging.  Applications may
    register their own subscribers afterwards.
    """

    async def _trace_logger(**payload: Any) -> None:
        logging.getLogger("EventTrace").debug("event=%r payload=%r", payload.get("topic"), payload)

    bus.subscribe("trace.*", _trace_logger)  # Example wildcard usage in documentation


###############################################################################
# On-import side effects? None – explicit bootstrap is required.
###############################################################################
```