```python
"""
vitalops.policy_engine.handlers
================================

Chain-of-Responsibility implementation for the VitalOps Policy Engine.

The module exposes:

    • PolicyEvent                – Immutable data sent by upstream publishers
    • PolicyDecision             – Result produced by a PolicyHandler
    • BasePolicyHandler          – Abstract async handler with CoR wiring helpers
    • Concrete handlers          – PerformancePolicyHandler, BackupPolicyHandler,
                                   DeploymentPolicyHandler
    • PolicyHandlerRegistry      – Runtime registry/dispatcher used by the
                                   Orchestrator’s event-bus subscribers

The concrete handlers included here are *reference implementations* intended to
show realistic business logic; in production they may call external services
(e.g., service-mesh sidecars or EMR APIs).  All handlers are asyncio-friendly
and make heavy use of type hints for IDE support.

The module does not depend on any frameworks other than the Python standard
library, so unit tests can import it without additional requirements.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum, auto
from typing import Any, Awaitable, Callable, Dict, Optional

LOGGER = logging.getLogger("vitalops.policy_engine.handlers")


class PolicyEngineError(RuntimeError):
    """Base exception raised by the policy-engine handlers."""


class UnsupportedEventError(PolicyEngineError):
    """Raised when a handler cannot process a received event type."""


class PolicyEventType(Enum):
    """Types of events recognised by the Policy Engine."""

    PERFORMANCE_METRIC = auto()
    BACKUP_WINDOW = auto()
    DEPLOYMENT_REQUEST = auto()
    HEARTBEAT = auto()
    UNKNOWN = auto()


@dataclass(frozen=True, slots=True)
class PolicyEvent:
    """Immutable envelope object that travels through the policy pipeline."""

    event_type: PolicyEventType
    payload: Dict[str, Any]
    source: str
    created_at: datetime = field(
        default_factory=lambda: datetime.now(tz=timezone.utc),
    )

    def __post_init__(self) -> None:  # pragma: no cover
        LOGGER.debug("PolicyEvent created: %s", self)


@dataclass(slots=True)
class PolicyDecision:
    """
    Decision returned by a PolicyHandler.

    Attributes
    ----------
    accepted  – Whether the handler accepted the event
    action    – The action to be executed by orchestration workflows
    metadata  – Arbitrary additional information
    """

    accepted: bool
    action: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    decided_at: datetime = field(
        default_factory=lambda: datetime.now(tz=timezone.utc),
    )


class BasePolicyHandler:
    """
    Abstract element of the Chain of Responsibility.

    Sub-classes must implement the `evaluate` coroutine.  They may call
    `self._pass_to_next()` when they decide *not* to act on the event.
    """

    _next: Optional["BasePolicyHandler"] = None

    def set_next(self, handler: "BasePolicyHandler") -> "BasePolicyHandler":
        """
        Wire the next handler in the chain.

        Returns the argument to allow fluent chaining:
            chain = A().set_next(B()).set_next(C())
        """
        self._next = handler
        return handler

    async def handle(self, event: PolicyEvent) -> PolicyDecision:
        """
        Orchestrates evaluation + optional forwarding to the next handler.

        Should not be overridden by sub-classes; override `evaluate()` instead.
        """
        LOGGER.debug("%s received event %s", self.__class__.__name__, event)
        try:
            decision = await asyncio.wait_for(
                self.evaluate(event), timeout=self.timeout_seconds
            )
        except asyncio.TimeoutError as exc:
            LOGGER.error(
                "%s evaluation timed out after %ss – %s",
                self.__class__.__name__,
                self.timeout_seconds,
                exc,
            )
            raise PolicyEngineError("Handler evaluation timeout") from exc

        if decision.accepted:
            LOGGER.info(
                "%s accepted event %s with action=%s",
                self.__class__.__name__,
                event.event_type,
                decision.action,
            )
            return decision

        LOGGER.debug(
            "%s declined event %s – forwarding to next handler",
            self.__class__.__name__,
            event.event_type,
        )
        return await self._pass_to_next(event)

    # --------------------------------------------------------------------- #
    # Implementation details
    # --------------------------------------------------------------------- #

    timeout_seconds: int = 5  # default evaluation deadline

    async def evaluate(self, event: PolicyEvent) -> PolicyDecision:  # noqa: D401
        """Analyze a PolicyEvent and return a PolicyDecision (MUST override)."""
        raise NotImplementedError

    async def _pass_to_next(self, event: PolicyEvent) -> PolicyDecision:
        """Forward the event to the next handler or return a default decision."""
        if not self._next:
            LOGGER.warning(
                "End of handler chain reached – no handler accepted event %s",
                event.event_type,
            )
            return PolicyDecision(
                accepted=False,
                metadata={"reason": "unhandled_event"},
            )
        return await self._next.handle(event)

    # Python’s __call__ can be convenient syntactic sugar for some users
    async def __call__(self, event: PolicyEvent) -> PolicyDecision:
        return await self.handle(event)


# ========================================================================= #
# Concrete policy handlers
# ========================================================================= #


class PerformancePolicyHandler(BasePolicyHandler):
    """
    Decides whether to trigger load balancing based on performance metrics.

    Expects payload to contain:
        • service_name
        • metric_name
        • metric_value
        • threshold
    """

    timeout_seconds = 3

    async def evaluate(self, event: PolicyEvent) -> PolicyDecision:
        if event.event_type is not PolicyEventType.PERFORMANCE_METRIC:
            return PolicyDecision(accepted=False)

        try:
            service = event.payload["service_name"]
            metric_name = event.payload["metric_name"]
            metric_value: float = float(event.payload["metric_value"])
            threshold: float = float(event.payload["threshold"])
        except (KeyError, ValueError) as exc:
            LOGGER.error("Malformed performance metric event: %s", exc, exc_info=True)
            raise PolicyEngineError("Invalid performance metric payload") from exc

        LOGGER.debug(
            "Evaluating metric '%s' for service '%s' %.2f/%.2f",
            metric_name,
            service,
            metric_value,
            threshold,
        )

        if metric_value > threshold:
            action = f"invoke_load_balancer:{service}"
            metadata = {
                "metric_name": metric_name,
                "observed": metric_value,
                "threshold": threshold,
            }
            return PolicyDecision(True, action=action, metadata=metadata)

        return PolicyDecision(accepted=False)


class BackupPolicyHandler(BasePolicyHandler):
    """
    Launches backup workflows during defined maintenance windows.

    Payload contract:
        • service_name
        • scheduled_start (UTC timestamp, ISO 8601)
    """

    async def evaluate(self, event: PolicyEvent) -> PolicyDecision:
        if event.event_type is not PolicyEventType.BACKUP_WINDOW:
            return PolicyDecision(accepted=False)

        try:
            service = event.payload["service_name"]
            scheduled_start_str = event.payload["scheduled_start"]
            scheduled_start = datetime.fromisoformat(scheduled_start_str)
        except (KeyError, ValueError) as exc:
            LOGGER.error("Malformed backup event payload: %s", exc, exc_info=True)
            raise PolicyEngineError("Invalid backup payload") from exc

        now = datetime.now(tz=timezone.utc)
        seconds_until_start = (scheduled_start - now).total_seconds()

        LOGGER.debug(
            "Backup window for service '%s' begins in %.1fs",
            service,
            seconds_until_start,
        )

        if seconds_until_start < 0:
            LOGGER.warning(
                "Received past backup window for service '%s' – ignoring", service
            )
            return PolicyDecision(accepted=False)

        # Allow 60-second grace period so we don’t start backups too early
        if seconds_until_start <= 60:
            action = f"trigger_backup:{service}"
            return PolicyDecision(
                True,
                action=action,
                metadata={"scheduled_start": scheduled_start_str},
            )

        # Backup is scheduled but not imminent -> pass down the chain
        return PolicyDecision(accepted=False)


class DeploymentPolicyHandler(BasePolicyHandler):
    """
    Handles deployment requests for new container images.

    Payload contract:
        • service_name
        • image_tag
        • canary_percent (optional)
    """

    timeout_seconds = 10  # deployments may involve querying registries

    async def evaluate(self, event: PolicyEvent) -> PolicyDecision:
        if event.event_type is not PolicyEventType.DEPLOYMENT_REQUEST:
            return PolicyDecision(accepted=False)

        service = event.payload.get("service_name")
        image_tag = event.payload.get("image_tag")
        canary_percent = int(event.payload.get("canary_percent", 10))

        if not service or not image_tag:
            raise PolicyEngineError("Deployment payload missing required fields")

        # Example of a blocking I/O call replaced by asyncio.sleep()
        await asyncio.sleep(0.1)  # simulate registry interrogation

        LOGGER.info(
            "New deployment requested: %s (image %s, canary %d%%)",
            service,
            image_tag,
            canary_percent,
        )
        action = f"deploy_image:{service}:{image_tag}:{canary_percent}"
        metadata = {"strategy": "canary", "percent": canary_percent}

        return PolicyDecision(True, action=action, metadata=metadata)


# ========================================================================= #
# Registry / Dispatcher
# ========================================================================= #


class PolicyHandlerRegistry:
    """
    Runtime registry that owns the *head* of the handler chain.

    The registry is mutable; handlers can be added at runtime, which is useful
    for plug-in modules or feature-flags.  The `dispatch()` coroutine is the
    single entry-point used by external components.
    """

    def __init__(self) -> None:
        # Ensure there is at least a fallback end-of-chain handler
        self._head: BasePolicyHandler = _FallbackPolicyHandler()

    # ------------------------------------------------------------------ #
    # Chain manipulation helpers
    # ------------------------------------------------------------------ #

    def add_handler(self, handler: BasePolicyHandler) -> None:
        """
        Insert a PolicyHandler at the *beginning* of the chain.

        New handlers have higher priority than previously registered ones.
        """
        handler.set_next(self._head)
        self._head = handler
        LOGGER.debug("Added handler %s to registry head", handler.__class__.__name__)

    def build_default_chain(self) -> None:
        """Convenience helper to register the built-in handlers in order."""
        self.add_handler(DeploymentPolicyHandler())
        self.add_handler(BackupPolicyHandler())
        self.add_handler(PerformancePolicyHandler())

    # ------------------------------------------------------------------ #
    # Event dispatch
    # ------------------------------------------------------------------ #

    async def dispatch(self, event: PolicyEvent) -> PolicyDecision:
        """
        Asynchronously dispatch `event` through the handler chain.

        Raises PolicyEngineError on failures in handler code.
        """
        start = time.perf_counter()
        decision = await self._head.handle(event)
        duration = (time.perf_counter() - start) * 1000
        LOGGER.debug(
            "Dispatch of %s completed in %.1fms – accepted=%s",
            event.event_type,
            duration,
            decision.accepted,
        )
        return decision


# ========================================================================= #
# Private helpers
# ========================================================================= #


class _FallbackPolicyHandler(BasePolicyHandler):
    """Last-chance handler that refuses *all* events."""

    async def evaluate(self, event: PolicyEvent) -> PolicyDecision:  # noqa: D401
        LOGGER.debug("Fallback handler invoked for event %s; rejecting", event)
        return PolicyDecision(
            accepted=False,
            metadata={
                "reason": "end_of_chain",
                "event_type": event.event_type.name,
            },
        )


# ========================================================================= #
# Convenience singleton (optional)
# ========================================================================= #

default_registry: PolicyHandlerRegistry = PolicyHandlerRegistry()
default_registry.build_default_chain()

# ========================================================================= #
# End of module
# ========================================================================= #
```