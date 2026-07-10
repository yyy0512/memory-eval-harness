```python
"""
vitalops_orchestrator.vitalops.policy_engine.chain
==================================================

Implements the chain-of-responsibility that evaluates one or more
`Policy` objects against a live `PolicyContext`.  The chain short-circuits
on the first hard failure but will accumulate soft warnings so the
caller receives a holistic view of the overall posture.

The public façade is the `PolicyEngine` class, which is normally
instantiated by the event-driven Orchestrator coordinator(s).  A
vanilla example:

    engine = PolicyEngine.from_entrypoints("vitalops.policies")
    result = await engine.evaluate(context)

The implementation purposefully avoids any imports from medical-domain
packages so that the policy engine remains generic and testable.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import sys
import types
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Awaitable, Callable, Final, List, Optional, Protocol

try:
    # Python 3.10+
    from importlib.metadata import entry_points, EntryPoint
except ImportError:  # pragma: no cover
    # Python ≤3.7
    from importlib_metadata import entry_points, EntryPoint  # type: ignore

__all__: Final = [
    "PolicyOutcome",
    "PolicyResult",
    "PolicyContext",
    "Policy",
    "AsyncPolicy",
    "PolicyChain",
    "PolicyEngine",
]


LOGGER = logging.getLogger(__name__)
DEFAULT_TIMEOUT_SECONDS: Final = 30


# ---------------------------------------------------------------------------#
#                           Core DTOs / value objects                        #
# ---------------------------------------------------------------------------#
class PolicyOutcome(Enum):
    """
    The overall status of an individual policy evaluation.
    """

    PASSED = auto()
    WARNING = auto()
    FAILED = auto()

    @property
    def is_terminal(self) -> bool:
        """
        Whether the evaluation chain should stop after this outcome.
        """
        return self is PolicyOutcome.FAILED


@dataclass(slots=True, frozen=True)
class PolicyResult:
    """
    The output of a single `Policy` evaluation.
    """

    name: str
    outcome: PolicyOutcome
    message: str
    remediation_actions: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:  # pragma: no cover
        """
        Validate fields after dataclass creation.
        """
        if not self.name:
            raise ValueError("PolicyResult requires non-empty 'name'.")


@dataclass(slots=True)
class PolicyContext:
    """
    Immutable-ish snapshot of all information that policies need.
    Coordinators assemble this from live telemetry and domain models.
    """

    correlation_id: str
    # generic metrics container, specifics depend on the caller
    metrics: dict[str, Any] = field(default_factory=dict)
    service_metadata: dict[str, Any] = field(default_factory=dict)
    # user may inject additional custom attributes
    extra: dict[str, Any] = field(default_factory=dict)

    # The context is considered *read-only* for the policies.
    def get(self, key: str, default: Any | None = None) -> Any | None:
        return self.metrics.get(key) or self.service_metadata.get(key) or self.extra.get(key, default)


# ---------------------------------------------------------------------------#
#                               Policy interfaces                            #
# ---------------------------------------------------------------------------#
class SupportsSync(Protocol):
    def evaluate(self, context: PolicyContext) -> PolicyResult:  # noqa: D401
        """
        Synchronously evaluate the policy.
        """


class SupportsAsync(Protocol):
    async def evaluate(self, context: PolicyContext) -> PolicyResult:  # noqa: D401
        """
        Asynchronously evaluate the policy.
        """


class Policy:
    """
    Base class helper for synchronous policies.
    Sub-classes must implement `evaluate`.
    """

    name: str = ""

    # Sub-classes must override
    def evaluate(self, context: PolicyContext) -> PolicyResult:  # pragma: no cover
        raise NotImplementedError


class AsyncPolicy:
    """
    Base class helper for asynchronous policies.
    Sub-classes must implement `evaluate`.
    """

    name: str = ""

    async def evaluate(self, context: PolicyContext) -> PolicyResult:  # pragma: no cover
        raise NotImplementedError


# ---------------------------------------------------------------------------#
#                               Chain runtime                                #
# ---------------------------------------------------------------------------#
class PolicyChain:
    """
    Internal: wraps an *ordered* list of policies (mixed sync/async)
    and evaluates them sequentially.
    """

    _policies: Sequence[object]

    def __init__(self, policies: Iterable[object]) -> None:
        self._policies = tuple(policies)
        if not self._policies:
            raise ValueError("PolicyChain requires at least one policy.")
        for p in self._policies:
            if not _is_policy(p):
                raise TypeError(f"{p} does not implement the policy interface")

    async def run(self, context: PolicyContext, *, timeout: float | None = None) -> List[PolicyResult]:
        """
        Evaluate the chain against the supplied context.

        The chain stops on the first FAILED outcome.  WARNINGS continue.

        Parameters
        ----------
        context:
            Snapshot of the environment.
        timeout:
            Optional timeout applied to each *individual* policy,
            not the chain as a whole.  If omitted, the global
            DEFAULT_TIMEOUT_SECONDS applies.

        Returns
        -------
        list[PolicyResult]
            Ordered results corresponding to the policies executed.
        """
        results: list[PolicyResult] = []
        timeout = timeout or DEFAULT_TIMEOUT_SECONDS

        for policy in self._policies:
            try:
                res: PolicyResult
                if asyncio.iscoroutinefunction(policy.evaluate):  # type: ignore[attr-defined]
                    res = await asyncio.wait_for(  # type: ignore[arg-type]
                        policy.evaluate(context), timeout=timeout  # type: ignore[misc]
                    )
                else:
                    # execute sync code in a thread to avoid blocking loop
                    loop = asyncio.get_running_loop()
                    res = await asyncio.wait_for(
                        loop.run_in_executor(None, policy.evaluate, context), timeout=timeout
                    )
            except asyncio.TimeoutError:
                LOGGER.error("Policy %s timed-out after %s seconds.", _policy_name(policy), timeout)
                res = PolicyResult(
                    name=_policy_name(policy),
                    outcome=PolicyOutcome.FAILED,
                    message=f"Evaluation timed-out after {timeout} s",
                )
            except Exception as exc:  # pragma: no cover
                LOGGER.exception("Unhandled exception in policy %s", _policy_name(policy))
                res = PolicyResult(
                    name=_policy_name(policy),
                    outcome=PolicyOutcome.FAILED,
                    message=f"Unhandled exception: {exc}",
                )

            results.append(res)
            if res.outcome.is_terminal:
                LOGGER.debug("Termination due to policy failure: %s", res.name)
                break

        return results


# ---------------------------------------------------------------------------#
#                            Public policy engine                            #
# ---------------------------------------------------------------------------#
class PolicyEngine:
    """
    Factory/helper that discovers policies (via entrypoints or explicit list),
    materialises them, and exposes an async `evaluate` API.
    """

    def __init__(self, chain: PolicyChain) -> None:
        self._chain = chain

    # ------------------------------------------------------------------#
    #                       Factory convenience APIs                     #
    # ------------------------------------------------------------------#
    @classmethod
    def from_entrypoints(cls, group: str, *, ignore_import_errors: bool = True) -> "PolicyEngine":
        """
        Discover policy providers via `importlib.metadata` entry-points.

        Each entry-point must expose either:
            * an *instance* that implements Sync/Async evaluate
            * a *callable* returning such an instance
            * a *class* (which will be instantiated with no args)

        Parameters
        ----------
        group:
            Entrypoint group name (e.g. "vitalops.policies")
        ignore_import_errors:
            If `True` (default) import failures are logged and skipped.
            Otherwise, exceptions bubble up.
        """
        LOGGER.debug("Loading policies from entry-points group='%s'", group)
        discovered: list[object] = []
        eps: Iterable[EntryPoint]
        if sys.version_info >= (3, 10):  # py3.10+ API returning Mapping
            eps = entry_points(group=group)  # type: ignore[arg-type]
        else:  # pragma: no cover
            eps = entry_points().get(group, ())

        for ep in eps:
            try:
                obj = ep.load()
                if inspect.isclass(obj):
                    obj = obj()  # type: ignore[operator]
                elif callable(obj) and not _is_policy(obj):
                    # call a factory returning policy
                    obj = obj()
                discovered.append(obj)
            except Exception:
                msg = "Failed to load policy from entrypoint '%s'"
                if ignore_import_errors:
                    LOGGER.exception(msg, ep.name)
                    continue
                raise RuntimeError(msg % ep.name) from None

        if not discovered:
            raise RuntimeError("No policies discovered in group '%s'." % group)

        return cls(PolicyChain(discovered))

    @classmethod
    def from_module(cls, dotted_path: str, *, attribute: str | None = None) -> "PolicyEngine":
        """
        Import a module containing policies and collect public attributes
        that satisfy the Policy protocol.

        Parameters
        ----------
        dotted_path:
            e.g. "vitalops.policy_library.latency"
        attribute:
            Optional attribute name that yields the iterable of policies.
            If omitted, engine will introspect the module’s globals.
        """
        LOGGER.debug("Loading policies from module '%s'", dotted_path)
        module = importlib.import_module(dotted_path)

        if attribute is not None:
            policies = getattr(module, attribute)
            if callable(policies):
                policies = policies()
        else:
            policies = [
                v for v in vars(module).values() if _is_policy(v) or _is_policy_instance(v)
            ]

        return cls(PolicyChain(policies))

    # ------------------------------------------------------------------#
    #                             Core API                               #
    # ------------------------------------------------------------------#
    async def evaluate(
        self,
        context: PolicyContext,
        *,
        timeout_per_policy: float | None = None,
    ) -> List[PolicyResult]:
        """
        Execute the configured chain.

        Parameters
        ----------
        context:
            PolicyContext to evaluate
        timeout_per_policy:
            Optional float seconds; if omitted the global default is used.

        Returns
        -------
        list[PolicyResult]
        """
        LOGGER.info(
            "Evaluating %d policies for correlation-id=%s",
            len(self._chain._policies),  # noqa: SLF001
            context.correlation_id,
        )
        return await self._chain.run(context, timeout=timeout_per_policy)


# ---------------------------------------------------------------------------#
#                              Helper utilities                              #
# ---------------------------------------------------------------------------#
def _is_policy(obj: object) -> bool:
    """
    Returns True when the object provides either the sync or async
    `evaluate` method with the correct signature.
    """
    if inspect.isclass(obj):
        # class itself cannot be evaluated; must be instantiated
        return False
    return _is_policy_instance(obj)


def _is_policy_instance(instance: object) -> bool:
    evaluate = getattr(instance, "evaluate", None)
    if evaluate is None:
        return False

    if not callable(evaluate):
        return False

    sig = inspect.signature(evaluate)
    params = list(sig.parameters.values())
    # First arg must be context
    if not params or params[0].annotation not in (PolicyContext, inspect._empty):  # type: ignore[attr-defined]
        return False
    # Return annotation is optional but if present must be PolicyResult
    if sig.return_annotation not in (PolicyResult, Awaitable[PolicyResult], inspect._empty):
        return False

    return True


def _policy_name(policy: object) -> str:
    """
    Best-effort attempt at getting a human-readable policy name.
    """
    if isinstance(policy, (Policy, AsyncPolicy)):
        return policy.name or policy.__class__.__name__
    return getattr(policy, "__name__", str(policy))


# ---------------------------------------------------------------------------#
#                           Example built-in policy                          #
# ---------------------------------------------------------------------------#
# NOTE:
#   This built-in policy serves as a reference implementation and a
#   convenient default for unit/integration testing.  Real deployments
#   typically discover their own domain-specific policies via
#   entry-points and will disable/remove this sample.


class CpuSaturationPolicy(Policy):
    """
    Fails when CPU utilisation ≥ 90 % for 3 consecutive samples.
    Uses synchronous evaluation to demonstrate both codepaths.
    """

    name = "cpu_saturation"

    def evaluate(self, context: PolicyContext) -> PolicyResult:  # noqa: D401
        metrics = context.metrics
        window = metrics.get("cpu_utilisation_window", [])  # list of floats
        if len(window) < 3:
            return PolicyResult(
                name=self.name,
                outcome=PolicyOutcome.WARNING,
                message="Insufficient datapoints for CPU saturation policy",
            )

        if all(val >= 90.0 for val in window[-3:]):
            return PolicyResult(
                name=self.name,
                outcome=PolicyOutcome.FAILED,
                message=f"CPU saturated: last values={window[-3:]}",
                remediation_actions=("ScaleUp", "RedistributeWorkload"),
            )

        return PolicyResult(
            name=self.name,
            outcome=PolicyOutcome.PASSED,
            message="CPU utilisation within thresholds",
        )


class LatencySpikePolicy(AsyncPolicy):
    """
    Example *async* policy—e.g. remote query to distributed tracing backend.
    """

    name = "latency_spike"

    async def evaluate(self, context: PolicyContext) -> PolicyResult:  # noqa: D401
        latency_window = context.metrics.get("request_latency_ms", [])
        await asyncio.sleep(0)  # simulate async I/O

        if len(latency_window) >= 5 and max(latency_window[-5:]) > 1000:
            return PolicyResult(
                name=self.name,
                outcome=PolicyOutcome.WARNING,
                message="Transient latency spike detected",
                remediation_actions=("OpenCircuitBreaker",),
            )

        return PolicyResult(
            name=self.name, outcome=PolicyOutcome.PASSED, message="Latency within thresholds"
        )


def _builtin_policy_instances() -> list[object]:
    """
    Convenience accessor used by unit tests; not part of public API.
    """
    return [CpuSaturationPolicy(), LatencySpikePolicy()]
```