```python
"""
vitalops.models
===============

Domain-level objects for the VitalOps Orchestrator.  These models are the
authoritative representation of medical-computing concepts *independent* of any
orchestration, UI, or persistence concerns.  They are designed to be validated,
serialised and versioned consistently across the platform.

This file intentionally lives at ``vitalops/models/__init__.py`` so that it can
serve as a single import-point for every model and for the model-registry used
by dynamic plugins and by the event-driven bus.

Example
-------
>>> from vitalops.models import ClinicalService
>>> service = ClinicalService(
...     service_type="radiology_viewer",
...     version="3.1.4",
...     owner_team="imaging-sre",
...     endpoints=["https://viewer.internal:8443/healthz"],
... )
>>> service.json(indent=2)
{
  "id": "1d2ed3b0-b6e4-4b1f-86c6-2abd8b2090e0",
  "service_type": "radiology_viewer",
  "version": "3.1.4",
  "owner_team": "imaging-sre",
  "endpoints": [
    "https://viewer.internal:8443/healthz"
  ],
  "metadata": {}
}

All models subclass :class:`VitalOpsModel` which provides:

* `model_dump()` / `model_dump_json()` helpers
* Safe redaction utilities that remove PHI / PII
* A registry mechanism for dynamic look-ups
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from enum import Enum
from typing import Any, Callable, ClassVar, Dict, List, MutableMapping, Type, TypeVar

try:
    # pydantic>=1.10 is a hard dependency for validation & parsing.
    from pydantic import BaseModel, Field, ValidationError, root_validator, validator
except ImportError as exc:  # pragma: no cover
    raise RuntimeError(
        "The 'pydantic' package is required by vitalops.models.\n"
        "Install with `pip install pydantic`."
    ) from exc

logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())

# -----------------------------------------------------------------------------
# Shared Enum types
# -----------------------------------------------------------------------------


class ClinicalServiceType(str, Enum):
    """Enumeration of first-class clinical micro-services."""

    E_PRESCRIBING = "e_prescribing"
    RADIOLOGY_VIEWER = "radiology_viewer"
    DECISION_SUPPORT_ENGINE = "decision_support_engine"
    SEPSIS_PREDICTION = "sepsis_prediction"


class PolicyLevel(str, Enum):
    """Severity / enforcement levels for compliance policies."""

    ADVISORY = "advisory"
    MANDATORY = "mandatory"
    CRITICAL = "critical"


# -----------------------------------------------------------------------------
# Model base & registry helpers
# -----------------------------------------------------------------------------

M = TypeVar("M", bound="VitalOpsModel")


class VitalOpsModel(BaseModel):
    """
    Root base-class for every domain model in VitalOps.

    Configuration flags enforce a strict schema to avoid accidental field drift
    between services.  Runtime assignment is validated to protect against
    concurrent code paths that mutate rich objects in-place.
    """

    id: uuid.UUID = Field(default_factory=uuid.uuid4)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # --- pydantic Config -----------------------------------------------------
    class Config:
        allow_population_by_field_name = True
        anystr_strip_whitespace = True
        extra = "forbid"
        validate_assignment = True
        frozen = False
        json_encoders = {datetime: lambda dt: dt.isoformat() + "Z"}  # UTC

    # -------------------------------------------------------------------------
    # Registry logic
    # -------------------------------------------------------------------------

    # Populated by `register_model` decorator below.
    _registry: ClassVar[Dict[str, Type["VitalOpsModel"]]] = {}

    @classmethod
    def model_name(cls) -> str:
        return cls.__name__

    @classmethod
    def register(cls: Type[M]) -> Type[M]:
        """
        Register the model class for dynamic look-ups.

        Registered models can be de-serialised via :func:`model_from_json` even
        when the concrete class is not explicitly imported.
        """
        name = cls.model_name()
        if name in cls._registry:
            logger.warning("Model %s already registered, overriding.", name)
        cls._registry[name] = cls
        return cls

    # -------------------------------------------------------------------------
    # Serialisation helpers
    # -------------------------------------------------------------------------

    def model_dump(self, *, redacted: bool = False) -> Dict[str, Any]:  # noqa: D401
        """
        Return a `dict` representation.  Set ``redacted=True`` to remove
        potential PHI/PII, e.g. when sending events outside the private cloud.
        """
        data = super().dict()
        if redacted:
            self._apply_redaction(data)
        return data

    def model_dump_json(self, **kwargs: Any) -> str:
        """Serialise to canonical JSON string."""
        return json.dumps(self.model_dump(), **kwargs)

    # -------------------------------------------------------------------------
    # PHI/PII Redaction
    # -------------------------------------------------------------------------

    REDACTED_PLACEHOLDER: ClassVar[str] = "***REDACTED***"

    @classmethod
    def _apply_redaction(cls, mapping: MutableMapping[str, Any]) -> None:
        """
        In-place redaction logic.  Subclasses can override
        :meth:`_phi_redaction_keys` to control which keys are sensitive.
        """
        for key in cls._phi_redaction_keys():
            if key in mapping:
                mapping[key] = cls.REDACTED_PLACEHOLDER

    @classmethod
    def _phi_redaction_keys(cls) -> List[str]:
        """List of sensitive field names which should be removed before export."""
        return []

    # -------------------------------------------------------------------------
    # Guarantees
    # -------------------------------------------------------------------------

    def __hash__(self) -> int:
        # Ensure models remain hashable for observer pattern subscriptions.
        return hash(self.id)

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.__class__.__name__}<{self.id}>"

    # -------------------------------------------------------------------------
    # Functional helpers
    # -------------------------------------------------------------------------

    def copy_with(self: M, **updates: Any) -> M:
        """
        Return a *new* instance with updates applied, preserving immutability
        semantics even though `validate_assignment=True` allows mutation.
        """
        return self.copy(update=updates)


def register_model(cls: Type[M]) -> Type[M]:
    """
    Decorator for registering a model class with the global registry.

    Usage
    -----
    >>> @register_model
    ... class Foo(VitalOpsModel):
    ...     ...
    """
    return cls.register()


# -----------------------------------------------------------------------------
# Concrete domain models
# -----------------------------------------------------------------------------


@register_model
class PatientContext(VitalOpsModel):
    """Snapshot of a patient interaction relevant to compute orchestration."""

    patient_id: str = Field(..., min_length=3, max_length=64, regex=r"^[A-Za-z0-9\-_]+$")
    location: str = Field(..., description="E.g. 'ICU-3-Bed-14'")
    acuity_level: int = Field(..., ge=1, le=5)
    current_services: List[ClinicalServiceType]

    # ---------------------------------------------------------------------
    # Validation
    # ---------------------------------------------------------------------
    _validate_services_len = validator("current_services", allow_reuse=True)(
        lambda v: v or (_ for _ in ()).throw(  # raise ValueError if empty list
            ValueError("At least one service must be active for a PatientContext.")
        )
    )

    # ---------------------------------------------------------------------
    # Redaction
    # ---------------------------------------------------------------------
    @classmethod
    def _phi_redaction_keys(cls) -> List[str]:
        # Only patient_id is considered PHI here.
        return ["patient_id"]


@register_model
class ClinicalService(VitalOpsModel):
    """Compute entity that implements one of the clinical workloads."""

    service_type: ClinicalServiceType
    version: str = Field(..., regex=r"^\d+\.\d+\.\d+$")
    owner_team: str
    endpoints: List[str] = Field(..., min_items=1)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    # ---------------------------------------------------------------------
    # Validation
    # ---------------------------------------------------------------------
    @root_validator(skip_on_failure=True)
    def _validate_endpoints(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        endpoints: List[str] = values.get("endpoints", [])
        for ep in endpoints:
            if not ep.startswith("http"):
                raise ValueError(f"Endpoint '{ep}' must be http/https.")
        return values


@register_model
class CompliancePolicy(VitalOpsModel):
    """Policy document used by compliance and remediation coordinators."""

    name: str
    description: str
    level: PolicyLevel
    rules: Dict[str, Any]

    # ---------------------------------------------------------------------
    # Compliance evaluation
    # ---------------------------------------------------------------------
    def is_compliant(self, subject: ClinicalService, metrics: Dict[str, Any]) -> bool:
        """
        Evaluate compliance for the given service and metric snapshot.

        The algorithm below is intentionally simple (rule key must exist and be
        truthy) but can be extended via plugin dispatch or expression engines.
        """
        logger.debug(
            "Evaluating policy '%s' (%s) against service '%s'",
            self.name,
            self.level,
            subject.id,
        )

        for rule_key, requirement in self.rules.items():
            actual = metrics.get(rule_key)

            if isinstance(requirement, Callable):  # functional rule
                try:
                    if not requirement(actual):
                        logger.debug("Rule '%s' failed functional evaluation.", rule_key)
                        return False
                except Exception as exc:
                    logger.error(
                        "Compliance rule '%s' raised error: %s. Marking non-compliant.",
                        rule_key,
                        exc,
                    )
                    return False
            else:  # literal equality
                if actual != requirement:
                    logger.debug(
                        "Rule '%s' failed: expected %r, got %r", rule_key, requirement, actual
                    )
                    return False

        logger.debug("Service '%s' is compliant with policy '%s'.", subject.id, self.name)
        return True


# -----------------------------------------------------------------------------
# Dynamic (de)serialisation helpers
# -----------------------------------------------------------------------------


def model_from_dict(data: Dict[str, Any]) -> VitalOpsModel:
    """
    Deserialize a model from a raw mapping that *must* contain the key
    ``"__type__"`` which identifies the model class.
    """
    try:
        model_type = data["__type__"]
    except KeyError as exc:
        raise ValueError("Missing '__type__' key for dynamic deserialisation.") from exc

    model_cls = VitalOpsModel._registry.get(model_type)
    if model_cls is None:
        raise ValueError(f"Unknown model type '{model_type}'. Have you imported it?")

    # Remove the helper key before instantiation.
    payload = {k: v for k, v in data.items() if k != "__type__"}
    try:
        return model_cls.parse_obj(payload)
    except ValidationError as exc:  # pragma: no cover
        logger.error("Validation failed for type %s: %s", model_type, exc)
        raise


def model_from_json(payload: str | bytes) -> VitalOpsModel:
    """
    Parse JSON payload into a registered :class:`VitalOpsModel`.  Expects the
    embedded ``"__type__"`` field.
    """
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8")

    return model_from_dict(json.loads(payload))


def model_to_dict(instance: VitalOpsModel, *, include_type: bool = True) -> Dict[str, Any]:
    """Dump model to mapping, optionally embedding the ``__type__`` marker."""
    blob = instance.model_dump()
    if include_type:
        blob["__type__"] = instance.__class__.model_name()
    return blob


def model_to_json(instance: VitalOpsModel, **kwargs: Any) -> str:
    """Serialise model to JSON string with the embedded ``__type__`` marker."""
    return json.dumps(model_to_dict(instance), **kwargs)


# -----------------------------------------------------------------------------
# Public exports
# -----------------------------------------------------------------------------

__all__ = [
    # Base
    "VitalOpsModel",
    "register_model",
    # Enums
    "ClinicalServiceType",
    "PolicyLevel",
    # Models
    "PatientContext",
    "ClinicalService",
    "CompliancePolicy",
    # Serialization helpers
    "model_from_dict",
    "model_from_json",
    "model_to_dict",
    "model_to_json",
]
```