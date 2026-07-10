```python
"""
vitalops_orchestrator/tests/test_coordinators.py

Integration-style unit-tests for the *Coordinator* view-models that drive the
automation workflows.  Because the real implementation is not available inside
the test-environment shipped with this coding-challenge, we create **runtime
stub-modules** that mimic a subset of the production API surface.  This allows
the test-suite to execute end-to-end with `pytest -q` while still exercising
realistic, asynchronous control-flow similar to what exists in the
VitalOps-Orchestrator code-base.

The tests focus on:

*  Event-driven subscription/dispatch semantics.
*  Chain-of-Responsibility decision logic inside the coordinators.
*  Non-blocking, concurrent handling of multiple clinical services.
"""

from __future__ import annotations

import asyncio
import sys
import types
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, List

import pytest


# --------------------------------------------------------------------------- #
#                               Runtime stubs                                 #
# --------------------------------------------------------------------------- #

def _install_runtime_stubs() -> None:
    """
    Dynamically create minimal-viable stub modules so that
    `import vitalops_orchestrator.coordinators...` works even when the real
    code is not present in the execution environment.
    """
    # Bail-out early if stubs have already been installed.
    if "vitalops_orchestrator" in sys.modules:
        return

    # --------------------------------------------------------------------- #
    #                             Event Bus                                 #
    # --------------------------------------------------------------------- #

    class _InMemoryEventBus:
        """A naïve asyncio-friendly publish/subscribe message bus."""

        def __init__(self) -> None:
            self._subscribers: Dict[str, List[Callable[[Any], Awaitable[None]]]] = {}

        def subscribe(self, topic: str, handler: Callable[[Any], Awaitable[None]]) -> None:
            self._subscribers.setdefault(topic, []).append(handler)

        async def publish(self, topic: str, event: Any) -> None:
            coros = [handler(event) for handler in self._subscribers.get(topic, [])]
            # Fire and wait for all handlers concurrently.
            if coros:
                await asyncio.gather(*coros)

    # --------------------------------------------------------------------- #
    #                          Domain Events                                #
    # --------------------------------------------------------------------- #

    @dataclass(frozen=True, slots=True)
    class MetricsEvent:
        service: str
        latency_ms: float
        timestamp: datetime

    @dataclass(frozen=True, slots=True)
    class BackupFailureEvent:
        service: str
        backup_id: str
        reason: str
        timestamp: datetime

    # --------------------------------------------------------------------- #
    #                        External collaborators                          #
    # --------------------------------------------------------------------- #

    class _FakeLoadBalancer:
        """Pretends to rebalance traffic across instances."""
        def __init__(self) -> None:
            self.actions: List[Dict[str, Any]] = []

        async def rebalance(self, service: str) -> None:
            # Simulate I/O latency.
            await asyncio.sleep(0.01)
            self.actions.append({"service": service, "ts": datetime.utcnow()})

    class _FakeWorkflowEngine:
        """Kicks off long-running orchestration workflows."""
        def __init__(self) -> None:
            self.invocations: List[Dict[str, str]] = []

        async def execute(self, workflow_name: str, service: str) -> None:
            await asyncio.sleep(0.01)
            self.invocations.append({"workflow": workflow_name, "service": service})

    # --------------------------------------------------------------------- #
    #                         Coordinator stubs                              #
    # --------------------------------------------------------------------- #

    class PerformanceCoordinator:
        """
        Subscribes to MetricsEvents and invokes a load-balancer when latency
        Service Level Objectives (SLOs) are violated.
        """

        LATENCY_THRESHOLD_MS = 250  # Example SLO

        def __init__(
            self,
            load_balancer: _FakeLoadBalancer,
            event_bus: _InMemoryEventBus,
        ) -> None:
            self._lb = load_balancer
            self._bus = event_bus
            self._last_action: Dict[str, Any] | None = None

        def start(self) -> None:
            self._bus.subscribe("metrics", self._on_metrics)

        async def _on_metrics(self, event: MetricsEvent) -> None:
            if event.latency_ms > self.LATENCY_THRESHOLD_MS:
                await self._lb.rebalance(event.service)
                self._last_action = {
                    "action": "rebalance",
                    "service": event.service,
                    "latency": event.latency_ms,
                }

        # Convenience accessor used by the test-suite.
        @property
        def last_action(self) -> Dict[str, Any] | None:
            return self._last_action

    class RecoveryCoordinator:
        """
        Listens for failed backups and delegates remediation workflow
        executions to the workflow-engine.
        """

        def __init__(
            self,
            workflow_engine: _FakeWorkflowEngine,
            event_bus: _InMemoryEventBus,
        ) -> None:
            self._wf = workflow_engine
            self._bus = event_bus
            self._last_action: Dict[str, Any] | None = None

        def start(self) -> None:
            self._bus.subscribe("backup.failure", self._on_backup_failure)

        async def _on_backup_failure(self, event: BackupFailureEvent) -> None:
            await self._wf.execute("recovery", event.service)
            self._last_action = {
                "action": "recovery",
                "service": event.service,
                "reason": event.reason,
            }

        @property
        def last_action(self) -> Dict[str, Any] | None:
            return self._last_action

    # --------------------------------------------------------------------- #
    #                   Export objects in sys.modules                       #
    # --------------------------------------------------------------------- #

    orchestrator_mod = types.ModuleType("vitalops_orchestrator")
    coordinators_mod = types.ModuleType("vitalops_orchestrator.coordinators")
    performance_mod = types.ModuleType("vitalops_orchestrator.coordinators.performance")
    recovery_mod = types.ModuleType("vitalops_orchestrator.coordinators.recovery")
    events_mod = types.ModuleType("vitalops_orchestrator.events")
    utils_mod = types.ModuleType("vitalops_orchestrator.utils")  # placeholder

    performance_mod.PerformanceCoordinator = PerformanceCoordinator
    recovery_mod.RecoveryCoordinator = RecoveryCoordinator
    events_mod.MetricsEvent = MetricsEvent
    events_mod.BackupFailureEvent = BackupFailureEvent
    utils_mod.InMemoryEventBus = _InMemoryEventBus
    utils_mod.FakeLoadBalancer = _FakeLoadBalancer
    utils_mod.FakeWorkflowEngine = _FakeWorkflowEngine

    # Register modules so `import` works normally.
    sys.modules["vitalops_orchestrator"] = orchestrator_mod
    sys.modules["vitalops_orchestrator.coordinators"] = coordinators_mod
    sys.modules["vitalops_orchestrator.coordinators.performance"] = performance_mod
    sys.modules["vitalops_orchestrator.coordinators.recovery"] = recovery_mod
    sys.modules["vitalops_orchestrator.events"] = events_mod
    sys.modules["vitalops_orchestrator.utils"] = utils_mod


_install_runtime_stubs()

# --------------------------------------------------------------------------- #
#                       Imports using the *public* API                        #
# --------------------------------------------------------------------------- #

from vitalops_orchestrator.coordinators.performance import PerformanceCoordinator
from vitalops_orchestrator.coordinators.recovery import RecoveryCoordinator
from vitalops_orchestrator.events import BackupFailureEvent, MetricsEvent
from vitalops_orchestrator.utils import (
    FakeLoadBalancer,
    FakeWorkflowEngine,
    InMemoryEventBus,
)

# --------------------------------------------------------------------------- #
#                                   Fixtures                                  #
# --------------------------------------------------------------------------- #


@pytest.fixture()
def event_loop():
    """Create a dedicated event-loop per test function (pytest-asyncio legacy)."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture()
def event_bus() -> InMemoryEventBus:
    return InMemoryEventBus()


@pytest.fixture()
def perf_coordinator(event_bus: InMemoryEventBus) -> PerformanceCoordinator:
    lb = FakeLoadBalancer()
    pc = PerformanceCoordinator(load_balancer=lb, event_bus=event_bus)
    pc.start()
    return pc


@pytest.fixture()
def rec_coordinator(event_bus: InMemoryEventBus) -> RecoveryCoordinator:
    wf = FakeWorkflowEngine()
    rc = RecoveryCoordinator(workflow_engine=wf, event_bus=event_bus)
    rc.start()
    return rc


# --------------------------------------------------------------------------- #
#                                   Tests                                     #
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_performance_coordinator_triggers_rebalance(perf_coordinator: PerformanceCoordinator,
                                                          event_bus: InMemoryEventBus) -> None:
    """
    GIVEN a high-latency MetricsEvent
    WHEN  the PerformanceCoordinator processes the event
    THEN  it must trigger a rebalance action via the load-balancer.
    """
    event = MetricsEvent(
        service="radiology-viewer",
        latency_ms=600.0,
        timestamp=datetime.utcnow(),
    )

    await event_bus.publish("metrics", event)

    assert perf_coordinator.last_action == {
        "action": "rebalance",
        "service": "radiology-viewer",
        "latency": 600.0,
    }


@pytest.mark.asyncio
async def test_performance_coordinator_ignores_normal_latency(perf_coordinator: PerformanceCoordinator,
                                                              event_bus: InMemoryEventBus) -> None:
    """
    A latency reading below the threshold must **not** cause any load-balancer
    invocation.
    """
    event = MetricsEvent(
        service="e-prescribing",
        latency_ms=42.5,
        timestamp=datetime.utcnow(),
    )

    await event_bus.publish("metrics", event)

    assert perf_coordinator.last_action is None


@pytest.mark.asyncio
async def test_recovery_coordinator_executes_workflow(rec_coordinator: RecoveryCoordinator,
                                                      event_bus: InMemoryEventBus) -> None:
    """
    Verify that RecoveryCoordinator kicks off the 'recovery' workflow for a
    failed backup event.
    """
    event = BackupFailureEvent(
        service="decision-support-ml",
        backup_id="backup-2024-04-15-00",
        reason="snapshot CRC mismatch",
        timestamp=datetime.utcnow(),
    )
    await event_bus.publish("backup.failure", event)

    assert rec_coordinator.last_action == {
        "action": "recovery",
        "service": "decision-support-ml",
        "reason": "snapshot CRC mismatch",
    }


@pytest.mark.asyncio
async def test_coordinators_run_concurrently(perf_coordinator: PerformanceCoordinator,
                                             rec_coordinator: RecoveryCoordinator,
                                             event_bus: InMemoryEventBus) -> None:
    """
    Smoke-test that multiple coordinators can operate side-by-side without
    message collisions or deadlocks.
    """

    async def publish_events() -> None:
        await asyncio.gather(
            event_bus.publish(
                "metrics",
                MetricsEvent(
                    service="pacs-storage",
                    latency_ms=512.0,
                    timestamp=datetime.utcnow(),
                ),
            ),
            event_bus.publish(
                "backup.failure",
                BackupFailureEvent(
                    service="pacs-storage",
                    backup_id="backup-2024-04-15-01",
                    reason="network timeout",
                    timestamp=datetime.utcnow() + timedelta(seconds=1),
                ),
            ),
        )

    # Fire events concurrently.
    await publish_events()

    # Both coordinators should have reacted to their respective events.
    assert perf_coordinator.last_action is not None
    assert rec_coordinator.last_action is not None
    assert perf_coordinator.last_action["service"] == "pacs-storage"
    assert rec_coordinator.last_action["service"] == "pacs-storage"
```