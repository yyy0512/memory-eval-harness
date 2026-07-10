```python
"""
VitalOps Policy-Engine package public API.

The Policy-Engine provides a light‐weight, chain-of-responsibility
framework used by the orchestrator’s view-models (e.g.,
`PerformanceCoordinator`, `RecoveryCoordinator`) to verify that any
action taken is compliant with hospital SLAs, security requirements,
and HIPAA auditability.

Typical usage
-------------
>>> from vitalops.policy_engine import PolicyEngine
>>> engine = PolicyEngine.autodiscover()
>>> result = engine.evaluate(event=my_event)
>>> if result.failed:
...     logger.warning("Policy check failed, aborting workflow")

The package keeps *zero* external run-time dependencies other than the
Python standard-library, so that policies can run even during severe
outage scenarios when PyPI mirrors are unreachable.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import os
import pkgutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum, auto
from types import ModuleType
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    MutableMapping,
    Optional,
    Sequence,
    Tuple,
    Type,
    Union,
)

__all__ = [
    "PolicyOutcome",
    "PolicyResult",
    "PolicyContext",
    "Policy",
    "PolicyRegistry",
    "PolicyEngine",
    "policy_rule",
]

_LOGGER = logging.getLogger("vitalops.policy_engine")
_LOGGER.addHandler(logging.NullHandler())


# --------------------------------------------------------------------------- #
#                                Data objects                                 #
# --------------------------------------------------------------------------- #
class PolicyOutcome(Enum):
    """
    High-level decision that a policy may return.
    """

    PASS = auto()
    FAIL = auto()
    ERROR = auto()
    DEFER = auto()  # policy cannot decide yet; move on


@dataclass(slots=True, frozen=True)
class PolicyResult:
    """
    Immutable result container returned by every policy.
    """

    policy: str
    outcome: PolicyOutcome
    message: str = ""
    data: Mapping[str, Any] | None = None
    when: datetime = datetime.now(tz=timezone.utc)

    @property
    def succeeded(self) -> bool:
        return self.outcome is PolicyOutcome.PASS

    @property
    def failed(self) -> bool:
        return self.outcome is PolicyOutcome.FAIL

    @property
    def errored(self) -> bool:
        return self.outcome is PolicyOutcome.ERROR


class PolicyError(RuntimeError):
    """
    Raised for internal Policy-Engine errors (mis-configuration, etc).
    """

    pass


@dataclass(slots=True)
class PolicyContext:
    """
    The *only* mutable object a policy is allowed to touch.

    Keeping the context isolated makes the policy side-effect free
    (apart from logging).
    """

    event: Any  # The event object produced by the orchestrator
    metadata: Dict[str, Any]
    settings: Mapping[str, Any]
    # Thread-local scratch-pad for cross-policy communication
    scratch: Dict[str, Any]

    def __post_init__(self) -> None:
        # Provide a nice shorthand for timestamps
        self.metadata.setdefault("received_at", datetime.now(tz=timezone.utc))


# --------------------------------------------------------------------------- #
#                              Policy base-class                              #
# --------------------------------------------------------------------------- #
class Policy:
    """
    Abstract base-class for any custom policy.

    Sub-classes should either implement :meth:`evaluate` or supply
    a synchronous ``__call__``.  The default implementation simply
    delegates to :meth:`evaluate`.
    """

    #: Optional user-friendly name; defaults to the *class name*.
    name: str | None = None
    #: Semantic version allowing policy migrations (major.minor.patch).
    version: str = "1.0.0"
    #: Larger number == executed *earlier* in the chain
    priority: int = 100
    #: Whether a fail outcome should break the chain immediately
    stop_on_fail: bool = True

    def __call__(self, ctx: PolicyContext) -> PolicyResult:  # pragma: no cover
        return self.evaluate(ctx)

    # --------------------------------------------------------------------- #
    # The only method the implementer must override.
    # --------------------------------------------------------------------- #
    def evaluate(self, ctx: PolicyContext) -> PolicyResult:  # noqa: D401
        """
        Perform the policy evaluation.

        Notes
        -----
        A subclass that does not override this **must** implement
        ``__call__`` instead.

        The default implementation raises :class:`NotImplementedError`.
        """
        raise NotImplementedError

    # --------------------------------------------------------------------- #
    # Helper utilities for sub-classes
    # --------------------------------------------------------------------- #
    def result(
        self,
        outcome: PolicyOutcome,
        message: str = "",
        **data: Any,
    ) -> PolicyResult:
        """
        Shortcut for constructing :class:`PolicyResult`.
        """
        return PolicyResult(
            policy=self.display_name,
            outcome=outcome,
            message=message,
            data=data or None,
        )

    # --------------------------------------------------------------------- #
    # Properties
    # --------------------------------------------------------------------- #
    @property
    def display_name(self) -> str:
        return self.name or self.__class__.__name__

    @classmethod
    def fully_qualified_name(cls) -> str:
        return f"{cls.__module__}:{cls.__name__}"

    # --------------------------------------------------------------------- #
    # House-keeping
    # --------------------------------------------------------------------- #
    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} "
            f"name='{self.display_name}' priority={self.priority}>"
        )


# --------------------------------------------------------------------------- #
#                            Policy registration                              #
# --------------------------------------------------------------------------- #
class _ThreadSafeDict(MutableMapping[str, Type[Policy]]):
    """
    A dictionary wrapper that is safe for concurrent reads/writes.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._data: Dict[str, Type[Policy]] = {}

    # -------------------------------------------------------------- #
    # MutableMapping implementation
    # -------------------------------------------------------------- #
    def __getitem__(self, key: str) -> Type[Policy]:
        with self._lock:
            return self._data[key]

    def __setitem__(self, key: str, value: Type[Policy]) -> None:
        with self._lock:
            self._data[key] = value

    def __delitem__(self, key: str) -> None:
        with self._lock:
            del self._data[key]

    def __iter__(self):
        with self._lock:
            return iter(self._data.copy())

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    # -------------------------------------------------------------- #
    # Custom helpers
    # -------------------------------------------------------------- #
    def values_sorted(self) -> List[Type[Policy]]:
        with self._lock:
            return sorted(self._data.values(), key=lambda cls: -cls.priority)


class PolicyRegistry:
    """
    Holds the globally registered policy classes available to the
    orchestrator.

    The registry can *discover* plug-ins automatically by importing
    modules that expose the :func:`policy_rule` decorator or
    subclass :class:`Policy` and call :pymeth:`register`.
    """

    _POLICIES: _ThreadSafeDict = _ThreadSafeDict()

    # --------------------------------------------------------------------- #
    # Public API
    # --------------------------------------------------------------------- #
    @classmethod
    def register(
        cls,
        policy_cls: Type[Policy],
        allow_override: bool = False,
    ) -> None:
        """
        Register *policy_cls* globally.

        Parameters
        ----------
        policy_cls:
            The concrete subclass to register.
        allow_override:
            Whether an existing key may be overwritten.
        """
        key = policy_cls.fully_qualified_name()
        if not allow_override and key in cls._POLICIES:
            raise PolicyError(f"Policy '{key}' already registered")

        cls._POLICIES[key] = policy_cls
        _LOGGER.debug("Registered policy: %s", key)

    @classmethod
    def create_chain(
        cls,
        enabled: Optional[Sequence[str]] = None,
        disabled: Optional[Sequence[str]] = None,
    ) -> List[Policy]:
        """
        Instantiate policies according to *enabled*/*disabled* filters.
        """
        enabled_set = set(enabled or [])
        disabled_set = set(disabled or [])
        chain: List[Policy] = []

        for policy_cls in cls._POLICIES.values_sorted():
            qual_name = policy_cls.fully_qualified_name()
            if enabled_set and qual_name not in enabled_set:
                continue
            if qual_name in disabled_set:
                _LOGGER.info("Policy disabled via configuration: %s", qual_name)
                continue
            try:
                chain.append(policy_cls())  # type: ignore[arg-type]
            except Exception as exc:  # pragma: no cover
                _LOGGER.exception("Failed to instantiate policy '%s': %s", qual_name, exc)

        return chain

    # --------------------------------------------------------------------- #
    # Dynamic discovery helpers
    # --------------------------------------------------------------------- #
    @staticmethod
    def discover(packages: Iterable[str]) -> int:
        """
        Import all sub-modules in *packages* recursively looking
        for modules that register policies.

        Returns
        -------
        int
            Number of imported modules.
        """
        imported = 0
        for package_name in packages:
            try:
                pkg = importlib.import_module(package_name)
            except ModuleNotFoundError as exc:
                _LOGGER.warning("Policy package '%s' unavailable: %s", package_name, exc)
                continue

            for _, mod_name, is_pkg in pkgutil.walk_packages(pkg.__path__, pkg.__name__ + "."):
                try:
                    importlib.import_module(mod_name)
                    imported += 1
                except Exception as exc:  # pragma: no cover
                    _LOGGER.exception("Failed to import '%s': %s", mod_name, exc)
                # Skip descending into sub-packages; walk_packages handles recursion itself
        return imported


# --------------------------------------------------------------------------- #
#                       Declarative registration decorator                    #
# --------------------------------------------------------------------------- #
def policy_rule(
    *,
    name: str | None = None,
    version: str | None = None,
    priority: int | None = None,
    stop_on_fail: bool | None = None,
) -> Callable[[Type[Policy]], Type[Policy]]:
    """
    Declarative way to turn a plain class into a registered policy.

    Example
    -------
    >>> @policy_rule(priority=200)
    ... class HighCPUCheck(Policy):
    ...     def evaluate(self, ctx):
    ...         if ctx.event["cpu"] > 90:
    ...             return self.result(PolicyOutcome.FAIL, "CPU too high")
    ...         return self.result(PolicyOutcome.PASS)
    """

    def decorator(cls: Type[Policy]) -> Type[Policy]:
        if not issubclass(cls, Policy):
            raise TypeError("policy_rule decorator only supports subclasses of Policy")

        if name is not None:
            cls.name = name
        if version is not None:
            cls.version = version
        if priority is not None:
            cls.priority = priority
        if stop_on_fail is not None:
            cls.stop_on_fail = stop_on_fail

        PolicyRegistry.register(cls)
        return cls

    return decorator


# --------------------------------------------------------------------------- #
#                             Evaluation engine                               #
# --------------------------------------------------------------------------- #
class PolicyEngine:
    """
    Runtime engine that orchestrates the evaluation of a *policy chain*.
    """

    def __init__(
        self,
        policies: Sequence[Policy],
        max_workers: Optional[int] = None,
    ):
        if not policies:
            raise PolicyError("At least one policy must be provided")
        self._policies: Tuple[Policy, ...] = tuple(
            sorted(policies, key=lambda p: -p.priority)
        )
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers or min(32, os.cpu_count() or 1)
        )

    # --------------------------------------------------------------------- #
    # Factory helpers
    # --------------------------------------------------------------------- #
    @classmethod
    def autodiscover(
        cls,
        *,
        policy_packages: Optional[Iterable[str]] = None,
        enable_env: str = "VITALOPS_POLICIES_ENABLE",
        disable_env: str = "VITALOPS_POLICIES_DISABLE",
    ) -> "PolicyEngine":
        """
        Auto-discovers and constructs an engine instance.

        Policy plug-ins are searched in *policy_packages* (defaults to
        ``["vitalops.policy_rules"]``).  Policies can be enabled or
        disabled at run-time via environment variables that accept
        comma-separated fully-qualified names.
        """
        packages = list(policy_packages or ["vitalops.policy_rules"])
        imported = PolicyRegistry.discover(packages)
        _LOGGER.debug("Imported %s policy modules from %s", imported, packages)

        enabled = os.getenv(enable_env, "").split(",") if os.getenv(enable_env) else None
        disabled = os.getenv(disable_env, "").split(",") if os.getenv(disable_env) else None

        return cls(policies=PolicyRegistry.create_chain(enabled, disabled))

    # --------------------------------------------------------------------- #
    # Public evaluation API
    # --------------------------------------------------------------------- #
    def evaluate(
        self,
        event: Any,
        metadata: Optional[Mapping[str, Any]] = None,
        settings: Optional[Mapping[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> "EvaluationReport":
        """
        Evaluate *event* against all policies in the chain.

        Execution happens concurrently; order is maintained respecting
        priority by collecting futures accordingly.

        Parameters
        ----------
        timeout:
            Global timeout (in seconds) for the entire check.
        """
        ctx = PolicyContext(
            event=event,
            metadata=dict(metadata or {}),
            settings=dict(settings or {}),
            scratch={},
        )

        start = time.monotonic()
        futures = {
            self._executor.submit(policy, ctx): policy for policy in self._policies
        }

        results: List[PolicyResult] = []

        try:
            for future in as_completed(futures, timeout=timeout):
                policy = futures[future]
                try:
                    res: PolicyResult = future.result()
                except Exception as exc:  # pragma: no cover
                    _LOGGER.exception("Policy '%s' crashed: %s", policy.display_name, exc)
                    res = policy.result(
                        PolicyOutcome.ERROR,
                        message=str(exc) or "Unhandled exception",
                    )

                results.append(res)

                if res.failed and policy.stop_on_fail:
                    _LOGGER.info("Policy '%s' failed, aborting further checks", policy.display_name)
                    # Cancel remaining futures
                    for fut in futures:
                        if not fut.done():
                            fut.cancel()
                    break
        except Exception as exc:  # pragma: no cover
            _LOGGER.exception("Evaluation crashed: %s", exc)
            raise
        finally:
            # Ensure we clean up any dangling futures in case of early exit
            for fut in futures:
                if not fut.done():
                    fut.cancel()

        duration = time.monotonic() - start
        return EvaluationReport(results=sorted(results, key=lambda r: -self._policy_priority(r)), duration=duration)

    def shutdown(self, wait: bool = True) -> None:
        """
        Release thread-pool resources _gracefully_.

        The orchestrator will typically call this when shutting down its
        own worker process.
        """
        self._executor.shutdown(wait=wait)

    # --------------------------------------------------------------------- #
    # Internals
    # --------------------------------------------------------------------- #
    def _policy_priority(self, result: PolicyResult) -> int:
        """
        Helper to map a result back to its policy's priority.
        """
        for policy in self._policies:
            if policy.display_name == result.policy:
                return policy.priority
        # Fallback for unexpected edge cases
        return 0


@dataclass(slots=True, frozen=True)
class EvaluationReport:
    """
    Container summarising the outcome of a full policy evaluation run.
    """

    results: Sequence[PolicyResult]
    duration: float

    @property
    def passed(self) -> bool:
        return all(r.succeeded for r in self.results)

    @property
    def failed(self) -> bool:
        return any(r.failed for r in self.results)

    @property
    def errored(self) -> bool:
        return any(r.errored for r in self.results)

    def __iter__(self):
        yield from self.results

    # Pretty representation for log-files
    def __str__(self) -> str:
        lines = [
            f"EvaluationReport(duration={self.duration:.3f}s, "
            f"passed={self.passed}, failed={self.failed}, errored={self.errored})"
        ]
        for res in self.results:
            lines.append(f"  - {res.policy:<40} {res.outcome.name:>5}  {res.message}")
        return "\n".join(lines)


# --------------------------------------------------------------------------- #
#                               Self-test stub                                #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO)

    # Dummy in-file policy for demonstration
    @policy_rule(priority=150)
    class AlwaysPass(Policy):
        def evaluate(self, ctx):
            return self.result(PolicyOutcome.PASS, "Everything looks good")

    @policy_rule(priority=100, stop_on_fail=True)
    class AlwaysFail(Policy):
        def evaluate(self, ctx):
            return self.result(PolicyOutcome.FAIL, "Something is wrong")

    engine = PolicyEngine.autodiscover(policy_packages=[])
    report = engine.evaluate(event={"example": "data"})
    print(report)
    engine.shutdown()
```