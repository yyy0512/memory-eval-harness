```python
"""
vitalops_orchestrator.vitalops.coordinators.performance
-------------------------------------------------------

Coordinator responsible for:

1.  Subscribing to real-time performance metrics published onto the internal
    event-bus (Service-Mesh sidecars, Kubernetes metrics-server, etc.).
2.  Feeding the metrics through a configurable Chain-of-Responsibility of
    policies such as latency-based load balancing, CPU / memory autoscaling,
    or HIPAA-compliant alerting.
3.  Emitting orchestration commands (scale-out, traffic-shift, alerts) and
    persisting an auditable trail of all decisions.

The module purposefully *decouples* the orchestration logic from concrete
implementations of the transport and persistence layers via `typing.Protocol`
interfaces.  This keeps the core algorithm testable while allowing hospital
installations to swap underlying technology (e.g. NATS vs. Kafka, Prometheus
vs. Datadog) without refactoring.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import TracebackType
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
    Protocol,
    Sequence,
    Tuple,
    Type,
)

__all__ = [
    "PerformanceCoordinator",
    "PerformanceEvent",
    "PerformancePolicy",
    "LatencyPolicy",
    "CpuSaturationPolicy",
    "FallbackPolicy",
]


# --------------------------------------------------------------------------- #
#                                Protocol Stubs                               #
# --------------------------------------------------------------------------- #
# These remain minimal to keep the coordinator self-contained.  In the real
# code-base they are provided by other VitalOps components.


class EventBus(Protocol):
    """
    A very small projection of the event-bus interface expected by the
    PerformanceCoordinator.  It purposefully mirrors popular Python async
    messaging libraries (aio-pika, aiokafka, etc.) to ease integration.
    """

    async def subscribe(
        self, topic: str, group: str, handler: Callable[[Dict[str, Any]], Awaitable[None]]
    ) -> None: ...

    async def publish(self, topic: str, payload: Dict[str, Any]) -> None: ...


class AlertService(Protocol):
    async def send_alert(self, alert_id: str, message: str, metadata: Dict[str, Any]) -> None: ...


class ServiceMeshController(Protocol):
    async def shift_traffic(self, service: str, to_node: str) -> None: ...

    async def scale_service(self, service: str, replicas: int) -> None: ...


class ComplianceLogger(Protocol):
    async def audit(self, action: str, metadata: Dict[str, Any]) -> None: ...


# --------------------------------------------------------------------------- #
#                           Domain / Transport Objects                        #
# --------------------------------------------------------------------------- #


@dataclass(slots=True, frozen=True)
class PerformanceEvent:
    """
    Lightweight immutable value-object that describes a single metric update
    emitted by the monitoring stack.
    """

    service: str
    node: str
    cpu_pct: float
    mem_pct: float
    latency_ms_p50: float
    latency_ms_p99: float
    timestamp: datetime = field(default_factory=lambda: datetime.now(tz=timezone.utc))

    @staticmethod
    def from_raw(message: Dict[str, Any]) -> "PerformanceEvent":
        try:
            return PerformanceEvent(
                service=message["service"],
                node=message["node"],
                cpu_pct=float(message["cpu"]),
                mem_pct=float(message["memory"]),
                latency_ms_p50=float(message["latency"]["p50"]),
                latency_ms_p99=float(message["latency"]["p99"]),
                timestamp=datetime.fromtimestamp(message.get("ts", time.time()), tz=timezone.utc),
            )
        except (KeyError, TypeError, ValueError) as exc:  # pragma: no cover
            raise ValueError(f"Malformed performance message: {message}") from exc


# --------------------------------------------------------------------------- #
#                          Chain-of-Responsibility                             #
# --------------------------------------------------------------------------- #


class PerformancePolicy(Protocol):
    """
    Generic policy executed by the coordinator.  Implementation may:

    * Perform a check and *handle* the event (returning True) – short circuits.
    * Pass by returning False.
    * Raise a PolicyError to indicate a non-recoverable problem.
    """

    async def handle(self, event: PerformanceEvent) -> bool: ...


class PolicyError(RuntimeError):
    """Raised when a policy fails to execute cleanly."""


class LatencyPolicy:
    """
    Shifts traffic to least-busy node if P99 latency exceeds SLA.

    Example:
        SLA_P99_MS = 250
    """

    _SLA_P99_MS = 250

    def __init__(
        self,
        mesh: ServiceMeshController,
        alert_service: AlertService,
        logger: ComplianceLogger,
    ) -> None:
        self._mesh = mesh
        self._alert = alert_service
        self._audit = logger
        self._log = logging.getLogger(self.__class__.__name__)

    async def handle(self, event: PerformanceEvent) -> bool:  # type: ignore[override]
        if event.latency_ms_p99 <= self._SLA_P99_MS:
            return False  # Not my problem.

        self._log.warning(
            "Service %s latency SLA breached: %.2f ms P99 (node=%s)",
            event.service,
            event.latency_ms_p99,
            event.node,
        )

        # Business rule: find a cool node (simplified).
        target_node = f"{event.service}-node-cool"
        try:
            await self._mesh.shift_traffic(event.service, to_node=target_node)
            await self._audit.audit(
                "TRAFFIC_SHIFT",
                {
                    "service": event.service,
                    "from_node": event.node,
                    "to_node": target_node,
                    "latency_ms_p99": event.latency_ms_p99,
                },
            )
        except Exception as exc:
            msg = f"Failed to shift traffic for {event.service}: {exc}"
            self._log.exception(msg)
            raise PolicyError(msg) from exc

        await self._alert.send_alert(
            alert_id="LATENCY_SLA_BREACH",
            message=f"{event.service} P99 latency {event.latency_ms_p99:.0f} ms exceeds {self._SLA_P99_MS} ms",
            metadata={"service": event.service, "node": event.node, "p99": event.latency_ms_p99},
        )

        return True  # Handled.


class CpuSaturationPolicy:
    """
    Autoscale a clinical micro-service when CPU utilisation remains > 85%.

    The policy purposely implements a simplistic *stateless* check; a real
    implementation would incorporate a ring-buffer and/or PromQL query.
    """

    _THRESHOLD = 85.0
    _SCALE_STEP = 1

    def __init__(
        self,
        mesh: ServiceMeshController,
        alert_service: AlertService,
        logger: ComplianceLogger,
    ) -> None:
        self._mesh = mesh
        self._alert = alert_service
        self._audit = logger
        self._log = logging.getLogger(self.__class__.__name__)

    async def handle(self, event: PerformanceEvent) -> bool:  # type: ignore[override]
        if event.cpu_pct <= self._THRESHOLD:
            return False

        try:
            # Query current replica count (fake value for illustration).
            current_replicas = 2
            new_replicas = current_replicas + self._SCALE_STEP

            self._log.info(
                "Autoscaling %s from %s to %s replicas (CPU %.1f%%)",
                event.service,
                current_replicas,
                new_replicas,
                event.cpu_pct,
            )
            await self._mesh.scale_service(event.service, replicas=new_replicas)
            await self._audit.audit(
                "AUTOSCALE",
                {
                    "service": event.service,
                    "from": current_replicas,
                    "to": new_replicas,
                    "cpu_pct": event.cpu_pct,
                },
            )
        except Exception as exc:
            self._log.exception("Autoscale failed for %s: %s", event.service, exc)
            raise PolicyError from exc

        # No alert; SRE dashboard will pick up scaling event.
        return True


class FallbackPolicy:
    """
    Last chance logger – never *handles* but records that the event went
    through the entire pipeline without any action.
    """

    def __init__(self) -> None:
        self._log = logging.getLogger(self.__class__.__name__)

    async def handle(self, event: PerformanceEvent) -> bool:  # type: ignore[override]
        self._log.debug(
            "No policy matched for service=%s cpu=%.1f%% mem=%.1f%% p99=%.1fms",
            event.service,
            event.cpu_pct,
            event.mem_pct,
            event.latency_ms_p99,
        )
        return False


# --------------------------------------------------------------------------- #
#                          The Performance Coordinator                        #
# --------------------------------------------------------------------------- #


class PerformanceCoordinator:
    """
    ViewModel that wires together:
        * Event subscription (input)
        * Policy chain          (processing)
        * Command / alert emit  (output)

    It exposes a high-level `run()` coroutine that must be scheduled on the
    orchestrator's asyncio event-loop.
    """

    _SUBSCRIPTION_TOPIC = "metrics.performance"
    _CONSUMER_GROUP = "performance-coordinator"

    def __init__(
        self,
        bus: EventBus,
        mesh: ServiceMeshController,
        alert_service: AlertService,
        compliance_logger: ComplianceLogger,
        *,
        loop: Optional[asyncio.AbstractEventLoop] = None,
        policies: Optional[Sequence[PerformancePolicy]] = None,
    ) -> None:
        self._bus = bus
        self._loop = loop or asyncio.get_event_loop()
        self._log = logging.getLogger(self.__class__.__name__)

        self._policies: Tuple[PerformancePolicy, ...] = (
            tuple(policies)
            if policies
            else (
                LatencyPolicy(mesh, alert_service, compliance_logger),
                CpuSaturationPolicy(mesh, alert_service, compliance_logger),
                FallbackPolicy(),
            )
        )

        # Async primitives.
        self._stop_event = asyncio.Event()
        self._task: Optional[asyncio.Task[None]] = None

    # --------------------------------------------------------------------- #
    #                             Public API                                #
    # --------------------------------------------------------------------- #

    async def start(self) -> None:
        """
        Subscribe to the event bus and spin-up the main handler task.
        """
        self._log.info("Starting PerformanceCoordinator")
        self._task = self._loop.create_task(self._run(), name="PerformanceCoordinator")
        # Let the run-loop spawn the subscription _inside_ the persistent task
        # to ensure we resubscribe during reconnect if needed.

    async def stop(self) -> None:
        """
        Stop consuming events and wait for graceful shutdown.
        """
        self._log.info("Stopping PerformanceCoordinator")
        self._stop_event.set()
        if self._task:
            await self._task

    # ------------------------------------------------------------------ #
    #                          Internal Helpers                          #
    # ------------------------------------------------------------------ #

    async def _run(self) -> None:
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                await self._bus.subscribe(
                    topic=self._SUBSCRIPTION_TOPIC,
                    group=self._CONSUMER_GROUP,
                    handler=self._handle_raw_event,
                )
                # Block until stop.
                await self._stop_event.wait()
            except Exception:  # pragma: no cover  - reconnect loop
                self._log.exception("Subscription lost; retrying in %.1f sec", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _handle_raw_event(self, payload: Dict[str, Any]) -> None:
        """
        Callback wired to the messaging layer.  Converts to domain object then
        cascades through policies.
        """
        try:
            event = PerformanceEvent.from_raw(payload)
        except ValueError as exc:
            self._log.warning("Dropped malformed payload: %s", exc)
            return

        self._log.debug(
            "Processing event service=%s node=%s cpu=%.1f%% p99=%.1fms",
            event.service,
            event.node,
            event.cpu_pct,
            event.latency_ms_p99,
        )

        for policy in self._policies:
            try:
                handled = await policy.handle(event)
            except PolicyError as exc:
                self._log.error("Policy %s failed: %s", policy.__class__.__name__, exc)
                break  # Future: escalate to RecoveryCoordinator
            except Exception:  # pragma: no cover
                self._log.exception("Unexpected error in %s", policy.__class__.__name__)
                break

            if handled:
                self._log.debug("Event handled by %s", policy.__class__.__name__)
                break  # stop at first handler

    # ------------------------------------------------------------------ #
    #                           Context Manager                          #
    # ------------------------------------------------------------------ #

    async def __aenter__(self) -> "PerformanceCoordinator":
        await self.start()
        return self

    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> Optional[bool]:
        await self.stop()
        return None
```