```python
"""
vitalops_orchestrator.vitalops.core.logging
===========================================

Centralised logging utilities for the VitalOps Orchestrator.

Goals
-----
  • Provide opinionated, production-grade logging that is
    – HIPAA compliant (PHI redaction)
    – Structured (JSON) so that downstream log aggregation tools
      can parse it easily.
    – Correlation-ID aware, so that all log lines belonging to
      a single patient-safety transaction can be traced end-to-end.
  • Remain fully functional when deployed as an internal library
    (e.g. by gracefully degrading if optional dependencies such
    as *structlog* are not available).

Typical Usage
-------------
>>> from vitalops.core.logging import configure_logging, get_logger, correlation_id
>>> configure_logging(env="development")
>>> correlation_id.set("req-12345")
>>> log = get_logger(__name__)
>>> log.info("Compute resources balanced", service="e-rx")
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional

try:
    import structlog  # type: ignore
except ImportError:  # pragma: no cover
    structlog = None  # Fallback to stdlib logging


__all__ = [
    "configure_logging",
    "get_logger",
    "correlation_id",
    "hipaa_compliant_filter",
]


####################################################################################
# Context management
####################################################################################

correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)
"""
ContextVar holding the current correlation ID.

The value is automatically injected into every log record produced by
`get_logger` or any standard library logger once `configure_logging`
has been called.
"""


@contextmanager
def correlation_scope(corr_id: Optional[str] = None):
    """
    Context manager that temporarily sets the `correlation_id`.

    Example
    -------
    >>> with correlation_scope("abc"):
    ...     get_logger(__name__).info("inside")
    """
    token = correlation_id.set(corr_id or str(uuid.uuid4()))
    try:
        yield
    finally:
        correlation_id.reset(token)


####################################################################################
# PHI / HIPAA compliance utilities
####################################################################################

_DEFAULT_PHI_REGEX: re.Pattern = re.compile(
    r"(?P<ssn>\b\d{3}[- ]?\d{2}[- ]?\d{4}\b)|"
    r"(?P<mrn>\b[Oo]?[A-Za-z]\d{6,}\b)|"
    r"(?P<email>\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)"
)

_REDACTION_TEXT = "[REDACTED]"


def redact_phi(message: str, patterns: Iterable[re.Pattern] | None = None) -> str:
    """
    Redact PHI from the message using a list of regular expressions.

    Parameters
    ----------
    message : str
        The log message to be sanitized
    patterns : Iterable[re.Pattern], optional
        Custom regex patterns.  If omitted, a sane default is used.

    Returns
    -------
    str
        The sanitized log message.
    """
    patterns = patterns or (_DEFAULT_PHI_REGEX,)
    for pat in patterns:
        message = pat.sub(_REDACTION_TEXT, message)
    return message


class HIPAAFilter(logging.Filter):
    """
    Logging filter that redacts PHI from log messages in compliance with HIPAA.
    """

    __slots__ = ("_patterns",)

    def __init__(self, patterns: Iterable[re.Pattern] | None = None) -> None:
        super().__init__("hipaa_compliant_filter")
        self._patterns: List[re.Pattern] = list(patterns or (_DEFAULT_PHI_REGEX,))

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        # Redact the main message
        record.msg = redact_phi(str(record.getMessage()), self._patterns)

        # Redact args
        if record.args:
            redacted_args = []
            for arg in record.args:
                if isinstance(arg, str):
                    redacted_args.append(redact_phi(arg, self._patterns))
                else:
                    redacted_args.append(arg)
            record.args = tuple(redacted_args)

        # Redact structured extras
        for attr in ("extra",):
            if hasattr(record, attr):
                value = getattr(record, attr)
                if isinstance(value, Mapping):
                    setattr(record, attr, _sanitize_mapping(value, self._patterns))

        return True


hipaa_compliant_filter = HIPAAFilter()  # Singleton


def _sanitize_mapping(mapping: Mapping[str, Any], patterns: Iterable[re.Pattern]) -> Dict[str, Any]:
    """
    Recursively sanitize PHI within mapping values.
    """
    sanitized: Dict[str, Any] = {}
    for k, v in mapping.items():
        if isinstance(v, str):
            sanitized[k] = redact_phi(v, patterns)
        elif isinstance(v, Mapping):
            sanitized[k] = _sanitize_mapping(v, patterns)
        else:
            sanitized[k] = v
    return sanitized


####################################################################################
# Formatters
####################################################################################


class JsonFormatter(logging.Formatter):
    """
    JSON formatter compatible with Elastic/Kibana, Loki, Datadog, etc.
    """

    def __init__(self, *, default_time_format: str = "%Y-%m-%dT%H:%M:%S.%fZ", **kwargs: Any):
        super().__init__(**kwargs)
        self.default_time_format = default_time_format

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        record_dict = self._record_to_dict(record)
        return json.dumps(record_dict, ensure_ascii=False)

    # --------------------------------------------------------------------- #
    # Private helpers
    # --------------------------------------------------------------------- #

    def _record_to_dict(self, record: logging.LogRecord) -> Dict[str, Any]:
        """
        Convert a LogRecord into a dict suitable for JSON serialization.
        """
        # Base attributes from LogRecord as defined by stdlib
        base: Dict[str, Any] = {
            "timestamp": time.strftime(self.default_time_format, time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "pathname": record.pathname,
            "lineno": record.lineno,
            "thread": record.threadName,
            "process": record.processName,
        }

        # Optional correlation ID
        corr_id = correlation_id.get()
        if corr_id:
            base["correlation_id"] = corr_id

        # Standard extras
        for attr in ("service", "event_id", "patient_id"):
            if hasattr(record, attr):
                base[attr] = getattr(record, attr)

        # Include any user-provided extras from `LoggerAdapter` or structlog
        if hasattr(record, "extra") and isinstance(record.extra, Mapping):
            base.update(record.extra)  # type: ignore[arg-type]

        return base


####################################################################################
# Logger factory & configuration
####################################################################################

_DEFAULT_LOG_LEVEL = os.environ.get("VITALOPS_LOG_LEVEL", "INFO").upper()
_QUEUE: "queue.Queue[logging.LogRecord]" | None = None
_LISTENER: QueueListener | None = None
_INIT_LOCK = threading.Lock()
_CONFIGURED = False


def _create_handlers(
    *,
    env: str,
    log_dir: str | None = None,
    log_level: str = _DEFAULT_LOG_LEVEL,
) -> List[logging.Handler]:
    """
    Create synchronous handlers that will be wrapped by a QueueHandler for async.
    """
    log_level_int = logging.getLevelName(log_level)

    # Console
    console_formatter: logging.Formatter
    if env == "development":
        console_formatter = logging.Formatter(
            fmt="%(asctime)s [%(levelname)-8s] %(correlation_id)s %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
    else:
        console_formatter = JsonFormatter()

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(console_formatter)
    console.setLevel(log_level_int)

    # File
    handlers: List[logging.Handler] = [console]
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        logfile = os.path.join(log_dir, "vitalops.orchestrator.log")
        file_handler = RotatingFileHandler(logfile, maxBytes=50 * 1024 * 1024, backupCount=10)
        file_handler.setFormatter(JsonFormatter())
        file_handler.setLevel(log_level_int)
        handlers.append(file_handler)

    return handlers


def configure_logging(
    *,
    env: str = "production",
    log_dir: str | None = None,
    log_level: str = _DEFAULT_LOG_LEVEL,
    enable_phi_scrubbing: bool = True,
) -> None:
    """
    Configure the root logger exactly once (thread-safe).

    Parameters
    ----------
    env : str
        Either "development" (human readable) or "production" (JSON).
    log_dir : str, optional
        Directory path for rotating log file destinations.
    log_level : str
        Log level string (DEBUG, INFO, WARNING,…).
    enable_phi_scrubbing : bool
        If truthy, enable HIPAA redaction filter.
    """
    global _QUEUE, _LISTENER, _CONFIGURED

    with _INIT_LOCK:
        if _CONFIGURED:  # pragma: no cover
            return

        # ------------------------------------------------------------------ #
        # Root logger base configuration
        # ------------------------------------------------------------------ #
        logging.raiseExceptions = env == "development"  # Avoid noisy logging errors in prod

        root_logger = logging.getLogger()
        root_logger.setLevel(logging.getLevelName(log_level))

        # Reset any existing handlers (important for tests / re-config)
        for h in list(root_logger.handlers):
            root_logger.removeHandler(h)

        # ------------------------------------------------------------------ #
        # Handler setup with asynchronous queue
        # ------------------------------------------------------------------ #
        _QUEUE = queue.Queue(-1)
        queue_handler = QueueHandler(_QUEUE)  # type: ignore[arg-type]
        root_logger.addHandler(queue_handler)

        # Synchronous handlers that the listener will dispatch to
        handlers = _create_handlers(env=env, log_dir=log_dir, log_level=log_level)

        if enable_phi_scrubbing:
            for h in handlers:
                h.addFilter(hipaa_compliant_filter)

        _LISTENER = QueueListener(_QUEUE, *handlers, respect_handler_level=True)
        _LISTENER.start()

        # ------------------------------------------------------------------ #
        # Correlation ID injection via LogRecord factory
        # ------------------------------------------------------------------ #
        _patch_record_factory()

        # ------------------------------------------------------------------ #
        # (Optional) structlog integration
        # ------------------------------------------------------------------ #
        if structlog:
            _configure_structlog(env=env, log_level=log_level)

        _CONFIGURED = True
        root_logger.debug("Logging configured", extra={"env": env, "log_dir": log_dir})


def _patch_record_factory() -> None:
    """
    Extend the LogRecord factory so that the correlation-id is always injected.
    """

    old_factory = logging.getLogRecordFactory()

    def record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:  # noqa: D401
        record: logging.LogRecord = old_factory(*args, **kwargs)  # type: ignore[arg-type]
        record.correlation_id = correlation_id.get()
        return record

    logging.setLogRecordFactory(record_factory)


def _configure_structlog(*, env: str, log_level: str) -> None:  # pragma: no cover
    """
    Configure structlog so that it writes into the standard library ‑> QueueHandler.
    """
    timestamper = structlog.processors.TimeStamper(fmt="iso")
    processors: List[Any] = [
        structlog.threadlocal.merge_threadlocal,  # grab contextvars
        timestamper,
        _structlog_correlation_enricher,
        structlog.processors.format_exc_info,
        structlog.processors.dict_tracebacks,
        structlog.processors.JSONRenderer() if env == "production" else structlog.dev.ConsoleRenderer(),
    ]

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(log_level)),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def _structlog_correlation_enricher(logger: Any, method_name: str, event_dict: MutableMapping[str, Any]):
    """
    Processor that injects correlation_id into structlog events.
    """
    cid = correlation_id.get()
    if cid:
        event_dict["correlation_id"] = cid
    return event_dict


####################################################################################
# Public helper
####################################################################################


def get_logger(name: str | None = None) -> logging.Logger:
    """
    Retrieve a logger that’s pre-configured for the orchestrator codebase.

    This simply wraps `logging.getLogger` but guarantees that
    `configure_logging` is invoked at import time if the application
    forgot to do so.  (A best-effort attempt; full control scenarios
    such as unit tests may override this.)
    """
    if not _CONFIGURED:  # Lazy auto-configure for library usage
        configure_logging(env=os.getenv("VITALOPS_ENV", "production"))
    return logging.getLogger(name if name else "vitalops")
```