```python
"""
vitalops_orchestrator.vitalops.models.domain
===========================================

Domain-layer entities and value objects for the VitalOps Orchestrator
platform.  These models are **pure** business objects—they contain no
infrastructure or transport concerns and are therefore agnostic to
specific storage engines, message brokers, or user interfaces.  The
file purposefully focuses on:

* Patient context and workload metadata
* Clinical micro-service descriptions and run-time state
* Compliance/SLA policies and evaluation logic
* Lightweight domain-events that bubble changes up to the orchestration
  layer

Design goals
------------
1. Immutable value objects where feasible (to ease reasoning and
   thread-safety)
2. Rich behavior: entities contain business rules, not just data bags.
3. Interoperability: entities can be converted to/from raw dictionaries
   for persistence or wire-level transport without leaking dependencies
   (e.g., Pydantic or ORMs).
"""

from __future__ import annotations

import abc
import datetime as _dt
import enum
import threading
import types
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, MutableMapping, Optional, Protocol, Sequence, Set, Type, TypeVar

__all__ = [
    # Enumerations
    "MetricType",
    "ServiceStatus",
    # Exceptions
    "DomainError",
    "PolicyViolationError",
    # Value Objects
    "PerformanceMetric",
    # Entities
    "CompliancePolicy",
    "ClinicalService",
    "PatientContext",
    # Events + Bus
    "DomainEvent",
    "PolicyViolationEvent",
    "ServiceDegradedEvent",
    "EventBus",
]

# --------------------------------------------------------------------------- #
# Enumerations
# --------------------------------------------------------------------------- #


class MetricType(str, enum.Enum):
    """
    Canonical metric types tracked by the orchestrator.

    Note that *unit* is implied by the metric:
    * CPU -> percentage (0-100)
    * MEMORY -> MiB
    * LATENCY -> milliseconds
    """

    CPU = "cpu"
    MEMORY = "memory"
    LATENCY = "latency"
    THROUGHPUT = "throughput"
    ERROR_RATE = "error_rate"

    def __str__(self) -> str:
        return self.value


class ServiceStatus(str, enum.Enum):
    """Coarse-grained health of a **ClinicalService**."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    OUTAGE = "outage"
    UNKNOWN = "unknown"

    def __str__(self) -> str:
        return self.value


# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #


class DomainError(RuntimeError):
    """Base-class for domain-layer exceptions."""


class PolicyViolationError(DomainError):
    """
    Raised when a **CompliancePolicy** violation is detected that cannot be
    automatically remediated inside the domain layer.
    """


# --------------------------------------------------------------------------- #
# Value Objects
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class PerformanceMetric:
    """
    Immutable value object that carries a single observation for a service.
    """

    metric_type: MetricType
    value: float
    observed_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )

    def __post_init__(self) -> None:  # type: ignore[override]
        if self.value < 0:
            raise ValueError("Metric values must be non-negative")

    # ------------------------------------------------------------------ #
    # Helper/serialization utilities
    # ------------------------------------------------------------------ #
    def to_dict(self) -> Dict[str, Any]:
        return {
            "metric_type": str(self.metric_type),
            "value": self.value,
            "observed_at": self.observed_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "PerformanceMetric":
        return cls(
            metric_type=MetricType(data["metric_type"]),
            value=float(data["value"]),
            observed_at=_dt.datetime.fromisoformat(data["observed_at"]),
        )


# --------------------------------------------------------------------------- #
# Domain Events
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class DomainEvent(abc.ABC):
    """
    Base-class for all immutable domain events.  These events decouple
    domain-layer changes from side-effects executed by view-models or
    infrastructure handlers.
    """

    id: uuid.UUID = field(default_factory=uuid.uuid4)
    occurred_on: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )

    @abc.abstractmethod
    def routing_key(self) -> str:
        """
        A stable routing key that external systems (message brokers, in-process
        dispatcher) can use for subscription filtering.  Follows the pattern:
        `<bounded_context>.<aggregate>.<event_name>`
        """
        raise NotImplementedError


@dataclass(frozen=True, slots=True)
class ServiceDegradedEvent(DomainEvent):
    service_id: uuid.UUID
    metric_type: MetricType
    metric_value: float

    def routing_key(self) -> str:
        return f"vitalops.clinical_service.{self.service_id}.degraded"


@dataclass(frozen=True, slots=True)
class PolicyViolationEvent(DomainEvent):
    service_id: uuid.UUID
    policy_id: uuid.UUID
    violations: Mapping[MetricType, float]

    def routing_key(self) -> str:
        return f"vitalops.policy.{self.policy_id}.violation"


# --------------------------------------------------------------------------- #
# Simple In-Process Event Bus
# --------------------------------------------------------------------------- #


_T_Event = TypeVar("_T_Event", bound=DomainEvent)


class _EventListener(Protocol[_T_Event]):
    """Structural typing for event listeners."""

    def __call__(self, event: _T_Event) -> None: ...


class EventBus:
    """
    Thread-safe, in-process dispatcher intended for unit-testing and single-
    process deployments.  A fully-fledged implementation would be replaced by
    a message broker adapter (Kafka, NATS, RabbitMQ, etc.).
    """

    _listeners: MutableMapping[Type[DomainEvent], Set[_EventListener[Any]]]
    _lock: threading.Lock

    def __init__(self) -> None:
        self._listeners = defaultdict(set)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Subscription API
    # ------------------------------------------------------------------ #
    def subscribe(
        self, event_type: Type[_T_Event], listener: _EventListener[_T_Event]
    ) -> None:
        """
        Register a callable that will be invoked synchronously **in the same
        thread** as :py:meth:`publish`.
        """
        if not isinstance(listener, types.FunctionType) and not callable(listener):
            raise TypeError("Listener must be a callable")

        with self._lock:
            self._listeners[event_type].add(listener)  # type: ignore[arg-type]

    def unsubscribe(
        self, event_type: Type[_T_Event], listener: _EventListener[_T_Event]
    ) -> None:
        with self._lock:
            self._listeners[event_type].discard(listener)  # type: ignore[arg-type]

    # ------------------------------------------------------------------ #
    # Publish API
    # ------------------------------------------------------------------ #
    def publish(self, event: DomainEvent) -> None:
        """
        Invoke all listeners that subscribed to the *exact* type of ``event``.
        Event heirarchy is intentionally **not** walked for performance and
        determinism.
        """
        listeners: Iterable[_EventListener[Any]]
        with self._lock:
            listeners = tuple(self._listeners.get(type(event), set()))

        for listener in listeners:
            try:
                listener(event)  # type: ignore[arg-type]
            except Exception as exc:  # pragma: no cover
                # Production code would forward to a structured logger
                # but we avoid extra dependencies here.
                print(f"[EventBus] Unhandled exception in listener: {exc!r}")


# --------------------------------------------------------------------------- #
# Entities
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class CompliancePolicy:
    """
    Aggregate root that encapsulates a set of SLA thresholds.

    Policies are *mutable*, because thresholds may be tuned over time by SREs,
    but policy **identity** remains stable.
    """

    name: str
    description: str
    sla_thresholds: Dict[MetricType, float]
    evaluation_window: _dt.timedelta = field(
        default=_dt.timedelta(minutes=5),
        metadata={"unit": "seconds"},
    )
    policy_id: uuid.UUID = field(default_factory=uuid.uuid4)

    # ------------------------------ Behavior --------------------------- #
    def evaluate(
        self, metrics: Sequence[PerformanceMetric]
    ) -> Mapping[MetricType, float]:
        """
        Evaluate a batch of recent metrics and return any violations
        in the form ``{MetricType: observed_value}``.

        A value is considered violating **if the direction is worse** than the
        SLA.  Direction differ per metric:
            * CPU, MEMORY, LATENCY, ERROR_RATE: **lower** is better
            * THROUGHPUT: **higher** is better

        Returns an *empty* mapping if the policy is satisfied.
        """
        cutoff = _dt.datetime.now(tz=_dt.timezone.utc) - self.evaluation_window

        # Aggregate most recent value for each metric within the window
        latest: Dict[MetricType, PerformanceMetric] = {}
        for m in metrics:
            if m.observed_at < cutoff:
                continue
            # keep the **newest** observation
            if (prev := latest.get(m.metric_type)) is None or m.observed_at > prev.observed_at:
                latest[m.metric_type] = m

        violations: Dict[MetricType, float] = {}
        for mtype, threshold in self.sla_thresholds.items():
            if mtype not in latest:
                # No data points—treat as violation so orchestrator can trigger
                # fallback mechanisms (conservative approach)
                violations[mtype] = float("nan")
                continue

            observed = latest[mtype].value
            if mtype in {MetricType.THROUGHPUT}:
                if observed < threshold:  # higher is better
                    violations[mtype] = observed
            else:
                if observed > threshold:  # lower is better
                    violations[mtype] = observed

        return violations

    # ------------------------------ Serialization ---------------------- #
    def to_dict(self) -> Dict[str, Any]:
        return {
            "policy_id": str(self.policy_id),
            "name": self.name,
            "description": self.description,
            "sla_thresholds": {str(k): v for k, v in self.sla_thresholds.items()},
            "evaluation_window_seconds": int(self.evaluation_window.total_seconds()),
        }

    @classmethod
    def from_dict(cls, dct: Mapping[str, Any]) -> "CompliancePolicy":
        return cls(
            name=dct["name"],
            description=dct["description"],
            sla_thresholds={MetricType(k): float(v) for k, v in dct["sla_thresholds"].items()},
            evaluation_window=_dt.timedelta(seconds=int(dct["evaluation_window_seconds"])),
            policy_id=uuid.UUID(dct["policy_id"]),
        )


@dataclass(slots=True)
class ClinicalService:
    """
    Domain entity representing a micro-service that processes clinical
    transactions (e.g., e-prescribing, PACS viewer, sepsis risk scoring).

    This entity emits *domain events* when service health transitions
    or policy violations occur.
    """

    name: str
    version: str
    endpoints: List[str]
    policies: List[CompliancePolicy] = field(default_factory=list)
    service_id: uuid.UUID = field(default_factory=uuid.uuid4)
    status: ServiceStatus = field(default=ServiceStatus.UNKNOWN)
    _metrics_ring: List[PerformanceMetric] = field(default_factory=list, repr=False)

    # a singleton-like reference; in prod, would be injected.
    _event_bus: EventBus = field(default_factory=EventBus, repr=False, init=False)

    # ------------------------------ Metrics ---------------------------- #
    def record_metric(self, metric: PerformanceMetric) -> None:
        """
        Record a real-time observation for the service.  When the metric violates
        an SLA threshold, fire a **ServiceDegradedEvent**.
        """
        self._metrics_ring.append(metric)

        # Keep ring buffer bounded in memory
        if len(self._metrics_ring) > 1_024:
            # Drop the oldest half of entries
            del self._metrics_ring[:512]

        # ------------ Quick degradation detection -------------------- #
        threshold = self._quick_threshold(metric.metric_type)
        if (
            threshold is not None
            and (
                (metric.metric_type == MetricType.THROUGHPUT and metric.value < threshold)
                or (metric.metric_type != MetricType.THROUGHPUT and metric.value > threshold)
            )
        ):
            self.status = ServiceStatus.DEGRADED
            self._event_bus.publish(
                ServiceDegradedEvent(
                    service_id=self.service_id,
                    metric_type=metric.metric_type,
                    metric_value=metric.value,
                )
            )

    def _quick_threshold(self, mtype: MetricType) -> Optional[float]:
        """
        Fast path to fetch an SLA threshold without doing a full policy
        evaluation.  Used for real-time degradation triggers.
        """
        for pol in self.policies:
            if mtype in pol.sla_thresholds:
                return pol.sla_thresholds[mtype]
        return None

    # ------------------------------ Policy ---------------------------- #
    def evaluate_policies(self) -> None:
        """
        Evaluate all attached **CompliancePolicy** against the current metrics.
        Violations raise :class:`PolicyViolationError` and emit
        :class:`PolicyViolationEvent`.
        """
        for pol in self.policies:
            violations = pol.evaluate(self._metrics_ring)
            if violations:
                self.status = ServiceStatus.DEGRADED
                event = PolicyViolationEvent(
                    service_id=self.service_id,
                    policy_id=pol.policy_id,
                    violations=violations,
                )
                self._event_bus.publish(event)
                raise PolicyViolationError(
                    f"Policy '{pol.name}' violated for service '{self.name}': {violations}"
                )
        else:
            # Only mark healthy if we checked all policies and saw no violation
            self.status = ServiceStatus.HEALTHY

    # ------------------------------ Serialization ---------------------- #
    def to_dict(self) -> Dict[str, Any]:
        return {
            "service_id": str(self.service_id),
            "name": self.name,
            "version": self.version,
            "endpoints": list(self.endpoints),
            "status": str(self.status),
            "policies": [p.to_dict() for p in self.policies],
        }

    @classmethod
    def from_dict(cls, dct: Mapping[str, Any]) -> "ClinicalService":
        return cls(
            name=dct["name"],
            version=dct["version"],
            endpoints=list(dct["endpoints"]),
            policies=[CompliancePolicy.from_dict(p) for p in dct["policies"]],
            service_id=uuid.UUID(dct["service_id"]),
            status=ServiceStatus(dct["status"]),
        )


@dataclass(slots=True)
class PatientContext:
    """
    An execution context that groups **ClinicalService** instances involved in
    a patient-centric workflow.  The orchestrator may scale or move entire
    contexts to satisfy SLA or failover constraints.
    """

    mrn: str  # Medical Record Number (hospital unique)
    priority: int  # Lower number == higher acuity
    services: List[ClinicalService] = field(default_factory=list)
    patient_id: uuid.UUID = field(default_factory=uuid.uuid4)
    created_at: _dt.datetime = field(
        default_factory=lambda: _dt.datetime.now(tz=_dt.timezone.utc)
    )

    # ------------------------------ Behavior --------------------------- #
    def attach_service(self, service: ClinicalService) -> None:
        """
        Attach a **ClinicalService** to the patient context.
        """
        if service in self.services:
            return
        self.services.append(service)

    def detach_service(self, service: ClinicalService) -> None:
        if service not in self.services:
            raise DomainError(
                f"Service {service.name} not attached to patient context {self.mrn}"
            )
        self.services.remove(service)

    def aggregate_status(self) -> ServiceStatus:
        """
        Compute the overall health of the patient context based on the **worst**
        clinical service status.
        """
        if not self.services:
            return ServiceStatus.UNKNOWN

        if any(s.status == ServiceStatus.OUTAGE for s in self.services):
            return ServiceStatus.OUTAGE
        if any(s.status == ServiceStatus.DEGRADED for s in self.services):
            return ServiceStatus.DEGRADED
        if all(s.status == ServiceStatus.HEALTHY for s in self.services):
            return ServiceStatus.HEALTHY
        return ServiceStatus.UNKNOWN  # Fallback—mixed states

    # ------------------------------ Serialization ---------------------- #
    def to_dict(self) -> Dict[str, Any]:
        return {
            "patient_id": str(self.patient_id),
            "mrn": self.mrn,
            "priority": self.priority,
            "services": [srv.to_dict() for srv in self.services],
            "created_at": self.created_at.isoformat(),
        }

    @classmethod
    def from_dict(cls, dct: Mapping[str, Any]) -> "PatientContext":
        return cls(
            mrn=dct["mrn"],
            priority=int(dct["priority"]),
            services=[ClinicalService.from_dict(s) for s in dct["services"]],
            patient_id=uuid.UUID(dct["patient_id"]),
            created_at=_dt.datetime.fromisoformat(dct["created_at"]),
        )
```