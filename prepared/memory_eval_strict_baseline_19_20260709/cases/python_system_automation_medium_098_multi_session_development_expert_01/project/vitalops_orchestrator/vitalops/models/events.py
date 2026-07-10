```python
"""
vitalops_orchestrator.vitalops.models.events
============================================

Domain-event definitions used across VitalOps Orchestrator.

The file contains:

    • A strongly-typed, Pydantic-based `DomainEvent` base-class that provides:
        – UUID event IDs
        – RFC-3339 timestamps
        – Automatic (de-)serialization helpers
        – Validation via pydantic

    • Concrete event implementations covering the primary orchestration
      concerns (metric ingestion, anomaly detection, maintenance, deployment,
      and backup).

    • A simple event-registry that enables dynamic reconstruction of events
      received over the wire (e.g. Kafka, NATS, HTTP CloudEvent, etc.).

The intent is to allow all layers of the application (ViewModels, message
brokers, storage backends, UI consumers) to rely on a forward-compatible,
well-validated contract whenever publishing or handling domain events.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from enum import Enum
from typing import Any, ClassVar, Dict, List, Mapping, MutableMapping, Optional, Type

from pydantic import BaseModel, Field, validator

__all__ = [
    # Enums
    "EventCategory",
    "SeverityLevel",
    "DeploymentStrategy",
    # Base class
    "DomainEvent",
    # Concrete events
    "MetricCollected",
    "AnomalyDetected",
    "MaintenanceWindowScheduled",
    "DeploymentRequested",
    "BackupCompleted",
    # Helpers
    "deserialize_event",
]


# --------------------------------------------------------------------------- #
# Helper Enums
# --------------------------------------------------------------------------- #


class EventCategory(str, Enum):
    """Categorisation of events used for routing and analytics."""

    METRIC = "metric"
    ANOMALY = "anomaly"
    MAINTENANCE = "maintenance"
    DEPLOYMENT = "deployment"
    BACKUP = "backup"
    AUDIT = "audit"
    OTHER = "other"


class SeverityLevel(str, Enum):
    """Severity level used primarily for anomaly events."""

    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class DeploymentStrategy(str, Enum):
    """Permissible deployment strategies for a micro-service rollout."""

    ROLLING = "rolling"
    BLUE_GREEN = "blue_green"
    CANARY = "canary"
    HOT_SWAP = "hot_swap"


# --------------------------------------------------------------------------- #
# Event Registry
# --------------------------------------------------------------------------- #

_EVENT_REGISTRY: Dict[str, Type["DomainEvent"]] = {}


def _register_event(cls: Type["DomainEvent"]) -> Type["DomainEvent"]:
    """Class decorator that registers the event class in the global registry."""
    if cls.event_name in _EVENT_REGISTRY:
        raise RuntimeError(
            f"Duplicate event name '{cls.event_name}' detected while "
            f"registering event class '{cls.__name__}'."
        )
    _EVENT_REGISTRY[cls.event_name] = cls
    return cls


# --------------------------------------------------------------------------- #
# Base Event
# --------------------------------------------------------------------------- #


class DomainEvent(BaseModel):
    """
    The foundational class for all domain events.

    Attributes
    ----------
    event_id:
        A globally unique identifier for the event instance.
    occurred_at:
        UTC timestamp adhering to RFC-3339 format.
    category:
        Broad category used for routing/subscription filtering.
    aggregate_id:
        Identifier of the domain aggregate referenced by the event
        (e.g. service name, patient ID, deployment ID).
    correlation_id:
        Identifier that logically groups a collection of events pertaining
        to the same workflow (optional).
    source:
        Human- or system-readable string denoting who/what generated the event.
    version:
        Schema version for evolution support.
    """

    event_id: uuid.UUID = Field(default_factory=uuid.uuid4, alias="id")
    occurred_at: datetime = Field(
        default_factory=lambda: datetime.utcnow().replace(tzinfo=None)
    )
    category: EventCategory
    aggregate_id: str
    correlation_id: Optional[uuid.UUID] = None
    source: str = "vitalops.orchestrator"
    version: int = 1

    # Each subclass MUST override
    event_name: ClassVar[str] = "domain_event"

    # Pydantic config
    class Config:
        allow_population_by_field_name = True
        json_encoders = {uuid.UUID: str, datetime: lambda dt: dt.isoformat() + "Z"}
        validate_assignment = True

    # --------------------------------------------------------------------- #
    # Serialization helpers
    # --------------------------------------------------------------------- #

    def to_dict(self, *, include_meta: bool = True) -> Dict[str, Any]:
        """
        Returns a dict representation with built-in encoders applied.

        Parameters
        ----------
        include_meta:
            If False, strips fields common to `DomainEvent` to yield only the
            payload specific to the concrete subclass. Useful for analytics.
        """
        raw = self.dict(by_alias=True)
        if not include_meta:
            meta_keys = DomainEvent.__fields__.keys()
            return {k: v for k, v in raw.items() if k not in meta_keys}
        return raw

    def to_json(self) -> str:
        """
        Serializes the event to JSON, embedding type metadata so that
        `deserialize_event()` can rebuild the appropriate subclass.
        """
        payload: MutableMapping[str, Any] = self.to_dict(include_meta=True)
        payload["type"] = self.event_name
        return json.dumps(payload, default=str)

    # --------------------------------------------------------------------- #
    # Validators
    # --------------------------------------------------------------------- #

    @validator("occurred_at", pre=True, always=True)
    def _ensure_datetime_is_utc(cls, v: datetime) -> datetime:
        if v.tzinfo is not None:
            # Convert to naive UTC for consistency
            return v.astimezone(tz=None).replace(tzinfo=None)
        return v


# --------------------------------------------------------------------------- #
# Concrete Events
# --------------------------------------------------------------------------- #


@_register_event
class MetricCollected(DomainEvent):
    """Represents a single metric ingestion."""

    event_name: ClassVar[str] = "metric_collected"

    service_name: str
    metric_name: str
    value: float
    unit: str
    tags: List[str] = Field(default_factory=list)

    category: EventCategory = Field(default=EventCategory.METRIC, const=True)


@_register_event
class AnomalyDetected(DomainEvent):
    """Captures a deviation from expected operational parameters."""

    event_name: ClassVar[str] = "anomaly_detected"

    service_name: str
    description: str
    metrics: Mapping[str, float]
    severity: SeverityLevel

    category: EventCategory = Field(default=EventCategory.ANOMALY, const=True)


@_register_event
class MaintenanceWindowScheduled(DomainEvent):
    """Announces a planned maintenance window within the cluster."""

    event_name: ClassVar[str] = "maintenance_window_scheduled"

    window_id: str
    start_time: datetime
    end_time: datetime
    affected_services: List[str]
    reason: str

    category: EventCategory = Field(default=EventCategory.MAINTENANCE, const=True)

    # Order guarantee for consistent JSON
    class Config(DomainEvent.Config):
        fields = {"start_time": "start", "end_time": "end"}


@_register_event
class DeploymentRequested(DomainEvent):
    """Indicates that a new deployment workflow has been triggered."""

    event_name: ClassVar[str] = "deployment_requested"

    deployment_id: str
    service_name: str
    version: str
    strategy: DeploymentStrategy
    requested_by: str

    category: EventCategory = Field(default=EventCategory.DEPLOYMENT, const=True)


@_register_event
class BackupCompleted(DomainEvent):
    """Emitted once a backup operation has finished."""

    event_name: ClassVar[str] = "backup_completed"

    backup_id: str
    target: str
    success: bool
    duration_seconds: float
    artifacts: List[str] = Field(default_factory=list)
    log_ref: Optional[str] = None

    category: EventCategory = Field(default=EventCategory.BACKUP, const=True)

    @validator("duration_seconds")
    def _must_be_positive(cls, v: float) -> float:
        if v < 0:
            raise ValueError("duration_seconds must be non-negative")
        return v


# --------------------------------------------------------------------------- #
# Public helper functions
# --------------------------------------------------------------------------- #


def deserialize_event(raw: str | Mapping[str, Any]) -> DomainEvent:
    """
    Rebuilds a concrete `DomainEvent` subclass from a raw payload.

    Parameters
    ----------
    raw:
        Either a JSON string or a dict that contains a `"type"` key, which must
        map to one of the registered `event_name`s.

    Returns
    -------
    DomainEvent
        An instantiated, validated event object.

    Raises
    ------
    ValueError
        If the payload is missing `type` or the event type is unknown.
    """

    if isinstance(raw, str):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON payload") from exc
    else:
        payload = dict(raw)  # defensive copy

    try:
        event_type = payload.pop("type")
    except KeyError as exc:
        raise ValueError("Event payload missing required 'type' field") from exc

    try:
        event_cls = _EVENT_REGISTRY[event_type]
    except KeyError as exc:
        raise ValueError(f"Unknown event type '{event_type}'") from exc

    try:
        return event_cls(**payload)  # type: ignore[arg-type]
    except Exception as exc:  # pydantic raises ValidationError
        raise ValueError(f"Payload invalid for event '{event_type}': {exc}") from exc
```