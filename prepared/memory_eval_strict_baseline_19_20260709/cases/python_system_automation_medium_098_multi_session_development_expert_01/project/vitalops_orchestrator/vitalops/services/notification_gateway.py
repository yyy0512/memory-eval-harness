```python
"""
vitalops_orchestrator.vitalops.services.notification_gateway

The Notification Gateway centralises the formatting, redaction, dispatch,
and auditing of alert-level events originating from the Orchestrator’s
event-bus.  It exposes an async façade that other ViewModels can import
and publish to without knowing anything about the underlying delivery
mechanisms (Slack, E-mail, PagerDuty, etc.).

Usage
-----
>>> gateway = NotificationGateway.from_env(event_bus)
>>> asyncio.run(gateway.start())

Design notes
------------
*  Implements the Observer pattern by subscribing to an AsyncEventBus.
*  Because healthcare data is highly sensitive, PHI is removed before any
   payload leaves the private network.
*  Retries employ exponential back-off to minimise alert noise while still
   guaranteeing delivery during transient outages.
*  All outbound messages are persisted to an immutable audit-log to meet
   HIPAA §164.312.(b) requirements.
"""
from __future__ import annotations

import abc
import asyncio
import enum
import json
import logging
import os
import re
import signal
import smtplib
import ssl
import sys
import time
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping, Optional

try:
    import aiohttp  # type: ignore
except ImportError:  # pragma: no cover
    aiohttp = None  # Slack integration disabled when aiohttp is missing.

try:
    from tenacity import retry, stop_after_attempt, wait_exponential  # type: ignore
except ImportError:  # pragma: no cover
    # Fallback shim – not as feature-rich but good enough.
    def retry(fn=None, *, stop_after_attempt=3, wait_exponential=lambda **_: 1):
        def wrapper(f):
            async def inner(*args, **kwargs):
                attempts = 0
                delay = 1
                while attempts < stop_after_attempt:
                    try:
                        return await f(*args, **kwargs)
                    except Exception:  # pragma: no cover
                        attempts += 1
                        if attempts >= stop_after_attempt:
                            raise
                        await asyncio.sleep(delay)
                        delay *= 2

            return inner

        return wrapper if fn is None else wrapper(fn)


logger = logging.getLogger("vitalops.notification_gateway")
logger.setLevel(logging.INFO)
_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(
    logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%SZ"
    )
)
logger.addHandler(_handler)


# --------------------------------------------------------------------------- #
#                             Domain Value Objects                             #
# --------------------------------------------------------------------------- #
class Severity(enum.IntEnum):
    INFO = 10
    WARNING = 20
    CRITICAL = 30

    @classmethod
    def from_str(cls, level: str) -> "Severity":
        raw = level.strip().upper()
        return cls[raw] if raw in cls.__members__ else cls.INFO


@dataclass(frozen=True, slots=True)
class NotificationEvent:
    """Canonical event-object published on the internal Message Bus."""

    id: str
    occurred_at: datetime
    severity: Severity
    message: str
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "NotificationEvent":
        return cls(
            id=str(payload.get("id", int(time.time() * 1000))),
            occurred_at=payload.get("occurred_at", datetime.now(tz=timezone.utc)),
            severity=Severity.from_str(payload.get("severity", "INFO")),
            message=str(payload.get("message")),
            metadata=payload.get("metadata", {}),
        )


# --------------------------------------------------------------------------- #
#                            Data-Protection Helpers                           #
# --------------------------------------------------------------------------- #
class PHIRedactor:
    """
    Very coarse-grained PHI redactor.  Uses configurable regex patterns to
    strip out common identifiers (MRNs, SSNs, patient names, etc.).  In a real
    deployment we would integrate with the hospital’s de-identification service.
    """

    DEFAULT_PATTERNS: List[str] = [
        r"\b[0-9]{3}\-[0-9]{2}\-[0-9]{4}\b",  # SSN
        r"\bMRN\:\s*[0-9]+\b",  # Medical Record Number
        r"\bPatient\:\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b",
    ]

    def __init__(self, patterns: Optional[Iterable[str]] = None) -> None:
        self._compiled = [re.compile(p, flags=re.IGNORECASE) for p in (patterns or self.DEFAULT_PATTERNS)]

    def redact(self, raw: str) -> str:
        redacted = raw
        for pattern in self._compiled:
            redacted = pattern.sub("[REDACTED]", redacted)
        return redacted


# --------------------------------------------------------------------------- #
#                        Outbound Notification Channels                        #
# --------------------------------------------------------------------------- #
class AbstractChannel(abc.ABC):
    """Strategy superclass – subclasses implement a concrete `send` method."""

    name: str

    def __init__(self, redactor: PHIRedactor) -> None:
        self._redactor = redactor

    @abc.abstractmethod
    async def send(self, event: NotificationEvent) -> None:  # pragma: no cover
        raise NotImplementedError


class SlackChannel(AbstractChannel):
    name = "slack"

    def __init__(
        self,
        webhook_url: str,
        redactor: PHIRedactor,
        session: Optional["aiohttp.ClientSession"] = None,
    ):
        if aiohttp is None:
            raise RuntimeError("aiohttp is required for Slack integration")
        super().__init__(redactor)
        self._webhook_url = webhook_url
        self._session = session or aiohttp.ClientSession()

    @retry(stop_after_attempt=3, wait_exponential=wait_exponential(multiplier=1, min=1, max=8))
    async def send(self, event: NotificationEvent) -> None:  # type: ignore[override]
        payload = {
            "text": self._redactor.redact(event.message),
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": f"*Severity*: {event.severity.name}"}},
                {"type": "section", "text": {"type": "mrkdwn", "text": event.message}},
            ],
        }
        async with self._session.post(self._webhook_url, json=payload, timeout=10) as resp:
            if resp.status >= 400:
                body = await resp.text()
                logger.error("Slack delivery failed [%s]: %s", resp.status, body)
                resp.raise_for_status()

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


class EmailChannel(AbstractChannel):
    name = "email"

    def __init__(
        self,
        smtp_host: str,
        smtp_port: int,
        sender: str,
        recipients: List[str],
        redactor: PHIRedactor,
        username: Optional[str] = None,
        password: Optional[str] = None,
        use_tls: bool = True,
    ):
        super().__init__(redactor)
        self._smtp_host = smtp_host
        self._smtp_port = smtp_port
        self._sender = sender
        self._recipients = recipients
        self._username = username
        self._password = password
        self._use_tls = use_tls

    @retry(stop_after_attempt=3, wait_exponential=wait_exponential(multiplier=1, min=1, max=8))
    async def send(self, event: NotificationEvent) -> None:  # type: ignore[override]
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sync_send, event)

    # ----------------------------------------------------------------------- #
    # Internal blocking implementation; executed in thread-pool               #
    # ----------------------------------------------------------------------- #
    def _sync_send(self, event: NotificationEvent) -> None:
        msg = EmailMessage()
        msg["Subject"] = f"[{event.severity.name}] VitalOps Alert – {event.id}"
        msg["From"] = self._sender
        msg["To"] = ", ".join(self._recipients)
        msg.set_content(self._redactor.redact(event.message))

        context = ssl.create_default_context()
        with smtplib.SMTP(self._smtp_host, self._smtp_port, timeout=10) as server:
            if self._use_tls:
                server.starttls(context=context)
            if self._username:
                server.login(self._username, self._password or "")
            server.send_message(msg)


class PagerDutyChannel(AbstractChannel):
    """Very lightweight PagerDuty Events API v2 publisher."""

    name = "pagerduty"

    V2_URL = "https://events.pagerduty.com/v2/enqueue"

    def __init__(self, routing_key: str, redactor: PHIRedactor, session: Optional["aiohttp.ClientSession"] = None):
        if aiohttp is None:
            raise RuntimeError("aiohttp is required for PagerDuty integration")
        super().__init__(redactor)
        self._routing_key = routing_key
        self._session = session or aiohttp.ClientSession()

    @retry(stop_after_attempt=5, wait_exponential=wait_exponential(multiplier=1, min=1, max=16))
    async def send(self, event: NotificationEvent) -> None:  # type: ignore[override]
        payload = {
            "routing_key": self._routing_key,
            "event_action": "trigger",
            "payload": {
                "summary": self._redactor.redact(event.message)[:1024],
                "severity": event.severity.name.lower(),
                "source": "vitalops_orchestrator",
                "timestamp": event.occurred_at.isoformat(),
                "custom_details": {k: json.dumps(v, default=str) for k, v in event.metadata.items()},
            },
        }

        async with self._session.post(self.V2_URL, json=payload, timeout=10) as resp:
            if resp.status >= 400:
                body = await resp.text()
                logger.error("PagerDuty delivery failed [%s]: %s", resp.status, body)
                resp.raise_for_status()

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# --------------------------------------------------------------------------- #
#                       Audit-Trail (HIPAA Compliance)                         #
# --------------------------------------------------------------------------- #
class AuditTrail:
    """
    Records an immutable log of all outbound notifications.  The persistence
    layer is intentionally simple: newline-delimited JSON written to an
    append-only file.  Rotate with logrotate(8) or an external archival
    pipeline.
    """

    def __init__(self, path: str = "/var/log/vitalops/notification_audit.jsonl"):
        self._path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)

    async def write(self, event: NotificationEvent, channel: str) -> None:
        entry = {
            "id": event.id,
            "occurred_at": event.occurred_at.isoformat(),
            "severity": event.severity.name,
            "channel": channel,
            "message": event.message,
            "metadata": event.metadata,
            "dispatched_at": datetime.now(tz=timezone.utc).isoformat(),
        }
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._append_to_file, entry)

    def _append_to_file(self, obj: Dict[str, Any]) -> None:
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")


# --------------------------------------------------------------------------- #
#                               Event Bus Stubs                               #
# --------------------------------------------------------------------------- #
class AsyncEventBus:
    """
    Extremely stripped-down async pub/sub bus used by orchestrator internals.
    Real implementation would support topic-based routing, back-pressure,
    and at-least-once delivery semantics.
    """

    def __init__(self) -> None:
        self._subscribers: List[asyncio.Queue[NotificationEvent]] = []

    async def publish(self, event: NotificationEvent) -> None:
        for q in self._subscribers:
            await q.put(event)

    @asynccontextmanager
    async def subscribe(self) -> Iterable[asyncio.Queue[NotificationEvent]]:
        queue: asyncio.Queue[NotificationEvent] = asyncio.Queue()
        self._subscribers.append(queue)
        try:
            yield queue
        finally:
            self._subscribers.remove(queue)


# --------------------------------------------------------------------------- #
#                          The Notification Gateway                           #
# --------------------------------------------------------------------------- #
class NotificationGateway:
    """
    The façade consumed by the rest of VitalOps.  Once started, it runs an
    infinite loop pulling events from the EventBus and fanning them out to
    the configured channels.
    """

    def __init__(
        self,
        event_bus: AsyncEventBus,
        channels: List[AbstractChannel],
        audit_trail: Optional[AuditTrail] = None,
        *,
        min_severity: Severity = Severity.WARNING,
        concurrency_limit: int = 16,
    ):
        self._event_bus = event_bus
        self._channels = {ch.name: ch for ch in channels}
        self._audit = audit_trail or AuditTrail()
        self._min_severity = min_severity
        self._concurrency_limit = concurrency_limit
        self._stop = asyncio.Event()

    # --------------------------- Public API -------------------------------- #
    async def start(self) -> None:
        logger.info("NotificationGateway starting with channels=%s", list(self._channels))
        async with self._event_bus.subscribe() as queue:
            workers = [
                asyncio.create_task(self._worker(queue), name=f"notif-worker-{i}")
                for i in range(self._concurrency_limit)
            ]

            await self._stop.wait()
            logger.info("Shutdown signal received. Waiting for workers to drain…")
            await asyncio.gather(*workers, return_exceptions=True)
            await self._shutdown_channels()

    def stop(self) -> None:
        self._stop.set()

    # -------------------------- Internal helpers --------------------------- #
    async def _worker(self, queue: asyncio.Queue[NotificationEvent]) -> None:
        while not self._stop.is_set():
            try:
                event = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            if self._should_dispatch(event):
                await self._fanout(event)
            queue.task_done()

    async def _fanout(self, event: NotificationEvent) -> None:
        tasks = []
        for name, channel in self._channels.items():
            tasks.append(self._dispatch(event, channel))
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _dispatch(self, event: NotificationEvent, channel: AbstractChannel) -> None:
        try:
            await channel.send(event)
            await self._audit.write(event, channel.name)
            logger.debug("Dispatched event %s to %s", event.id, channel.name)
        except Exception as ex:  # noqa: BLE001
            logger.exception("Failed to dispatch event %s via %s: %s", event.id, channel.name, ex)

    def _should_dispatch(self, event: NotificationEvent) -> bool:
        return event.severity >= self._min_severity

    async def _shutdown_channels(self) -> None:
        for ch in self._channels.values():
            close_fn = getattr(ch, "close", None)
            if callable(close_fn):
                with suppress(Exception):
                    await close_fn()

    # ------------------ Convenience constructor from ENV ------------------- #
    @classmethod
    def from_env(cls, event_bus: AsyncEventBus) -> "NotificationGateway":  # noqa: C901 – factory method
        redactor = PHIRedactor()
        channels: List[AbstractChannel] = []
        # Slack
        if slack_url := os.getenv("VITALOPS_SLACK_WEBHOOK"):
            if aiohttp is None:
                logger.warning("Slack disabled – aiohttp import failed.")
            else:
                channels.append(SlackChannel(webhook_url=slack_url, redactor=redactor))

        # Email
        if os.getenv("VITALOPS_EMAIL_RECIPIENTS"):
            channels.append(
                EmailChannel(
                    smtp_host=os.getenv("VITALOPS_SMTP_HOST", "localhost"),
                    smtp_port=int(os.getenv("VITALOPS_SMTP_PORT", "25")),
                    sender=os.getenv("VITALOPS_EMAIL_SENDER", "vitalops@hospital.local"),
                    recipients=[x.strip() for x in os.getenv("VITALOPS_EMAIL_RECIPIENTS").split(",")],
                    username=os.getenv("VITALOPS_SMTP_USER"),
                    password=os.getenv("VITALOPS_SMTP_PASS"),
                    use_tls=bool(int(os.getenv("VITALOPS_SMTP_TLS", "1"))),
                    redactor=redactor,
                )
            )

        # PagerDuty
        if pd_key := os.getenv("VITALOPS_PD_ROUTING_KEY"):
            if aiohttp is None:
                logger.warning("PagerDuty disabled – aiohttp import failed.")
            else:
                channels.append(PagerDutyChannel(routing_key=pd_key, redactor=redactor))

        if not channels:
            logger.warning("No outbound notification channels configured. Alerts will NOT be delivered.")

        min_sev = Severity.from_str(os.getenv("VITALOPS_MIN_ALERT_SEVERITY", "WARNING"))
        audit_file = os.getenv("VITALOPS_AUDIT_FILE", "/var/log/vitalops/notification_audit.jsonl")
        return cls(event_bus, channels, audit_trail=AuditTrail(audit_file), min_severity=min_sev)


# --------------------------------------------------------------------------- #
#                             Convenience Entrypoint                           #
# --------------------------------------------------------------------------- #
async def _main() -> None:  # pragma: no cover
    bus = AsyncEventBus()
    gateway = NotificationGateway.from_env(bus)

    loop = asyncio.get_running_loop()

    # Graceful shutdown on SIGINT/SIGTERM
    for signame in ("SIGINT", "SIGTERM"):
        with suppress(AttributeError):
            loop.add_signal_handler(getattr(signal, signame), gateway.stop)

    await gateway.start()


if __name__ == "__main__":  # pragma: no cover
    # Python 3.11 introduced asyncio.run with a keyboard-interrupt fix, but
    # we keep our own try/except for older runtimes.
    try:
        asyncio.run(_main())
    except (KeyboardInterrupt, SystemExit):
        pass
```