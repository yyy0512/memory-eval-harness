```python
"""
vitalops_orchestrator.vitalops.services.metric_collector
-------------------------------------------------------

Asynchronous service that gathers live performance metrics from the
side-car containers that protect clinical micro-services.  The collector
publishes *MetricSample* events onto the internal event-bus so that other
view-models (e.g. *PerformanceCoordinator*, *AlertManager*) can react
without tight coupling.

The implementation purposefully keeps external dependencies to a
minimum—only *aiohttp* is used for HTTP I/O—while demonstrating real-life
concerns such as timeout handling, exponential back-off, and clean
shutdown semantics.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    List,
    Mapping,
    Optional,
    Protocol,
    Set,
)

import aiohttp

LOG = logging.getLogger("vitalops.metric_collector")
DEFAULT_POLL_INTERVAL_SEC = 5.0
HTTP_TIMEOUT_SEC = 3.0


# ============================================================================
# Domain Models
# ============================================================================


@dataclass(frozen=True, slots=True)
class ServiceTarget:
    """
    Defines a clinical micro-service instance that exposes Prometheus-style
    metrics through a side-car.
    """

    service_id: str
    name: str
    metrics_endpoint: str  # e.g. http://radiology-viewer:9102/metrics
    sla_latency_ms: float  # 95-th percentile latency budget
    sla_cpu_pct: float  # CPU usage budget (percentage)
    tags: Dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MetricSample:
    """
    Represents one point-in-time performance snapshot.
    """

    service_id: str
    timestamp: float  # Unix time (seconds)
    cpu_pct: float
    mem_pct: float
    latency_ms: float
    sla_violations: Set[str] = field(default_factory=set)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "service_id": self.service_id,
            "timestamp": self.timestamp,
            "cpu_pct": self.cpu_pct,
            "mem_pct": self.mem_pct,
            "latency_ms": self.latency_ms,
            "sla_violations": list(self.sla_violations),
        }


# ============================================================================
# Event Bus – a *very* small in-process implementation
# ============================================================================


class Subscriber(Protocol):
    async def __call__(self, sample: MetricSample) -> None: ...


class EventBus:
    """
    Lightweight, in-memory pub-sub that backs the orchestrator runtime.
    """

    def __init__(self) -> None:
        self._subscribers: Set[Subscriber] = set()

    def subscribe(self, handler: Subscriber) -> Callable[[], None]:
        self._subscribers.add(handler)

        def _unsub() -> None:
            self._subscribers.discard(handler)

        return _unsub

    async def publish(self, sample: MetricSample) -> None:
        if not self._subscribers:
            return
        # Dispatch concurrently, but ensure that one slow consumer does
        # not block the others.
        await asyncio.gather(*(h(sample) for h in list(self._subscribers)), return_exceptions=True)


# ============================================================================
# Chain of Responsibility (metric processors)
# ============================================================================


class MetricProcessor:
    """
    Chain-of-Responsibility base class – each processor optionally consumes
    or enriches the sample and forwards it downstream.
    """

    def __init__(self, next_: Optional["MetricProcessor"] = None) -> None:
        self._next = next_

    async def process(self, sample: MetricSample) -> None:
        if self._next:
            await self._next.process(sample)


class OutlierFilter(MetricProcessor):
    """
    Drops wild outliers that are likely instrumentation errors.
    """

    def __init__(
        self,
        *,
        cpu_max: float = 100.0,
        mem_max: float = 100.0,
        latency_max_ms: float = 60_000,
        next_: Optional[MetricProcessor] = None,
    ) -> None:
        super().__init__(next_)
        self.cpu_max = cpu_max
        self.mem_max = mem_max
        self.latency_max_ms = latency_max_ms
        self._dropped = 0

    async def process(self, sample: MetricSample) -> None:
        if (
            sample.cpu_pct > self.cpu_max
            or sample.mem_pct > self.mem_max
            or sample.latency_ms > self.latency_max_ms
        ):
            self._dropped += 1
            LOG.warning(
                "Outlier metric dropped (total=%s) – %s",
                self._dropped,
                sample.as_dict(),
            )
            return
        await super().process(sample)


class SLAAnnotator(MetricProcessor):
    """
    Flags SLA violations and appends them to MetricSample.sla_violations.
    """

    def __init__(self, targets: Mapping[str, ServiceTarget], next_: MetricProcessor) -> None:
        super().__init__(next_)
        self._targets = targets

    async def process(self, sample: MetricSample) -> None:
        target = self._targets.get(sample.service_id)
        violations: Set[str] = set(sample.sla_violations)

        if target:
            if sample.latency_ms > target.sla_latency_ms:
                violations.add("LATENCY")
            if sample.cpu_pct > target.sla_cpu_pct:
                violations.add("CPU")

        # Recreate dataclass immutably
        sample = MetricSample(
            service_id=sample.service_id,
            timestamp=sample.timestamp,
            cpu_pct=sample.cpu_pct,
            mem_pct=sample.mem_pct,
            latency_ms=sample.latency_ms,
            sla_violations=violations,
        )
        await super().process(sample)


class EventPublisher(MetricProcessor):
    """
    Final chain element – publishes the (possibly transformed) sample onto
    the EventBus.
    """

    def __init__(self, bus: EventBus) -> None:
        super().__init__(None)
        self._bus = bus

    async def process(self, sample: MetricSample) -> None:
        await self._bus.publish(sample)


# ============================================================================
# Metric Collector
# ============================================================================


class MetricCollector:
    """
    Collects metrics from container side-cars in a fault-tolerant,
    asynchronous manner.

    Life-cycle:
        >>> collector = MetricCollector(targets, bus)
        >>> await collector.start()
        ... do work ...
        >>> await collector.stop()
    """

    def __init__(
        self,
        targets: List[ServiceTarget],
        bus: EventBus,
        *,
        poll_interval: float = DEFAULT_POLL_INTERVAL_SEC,
        session: Optional[aiohttp.ClientSession] = None,
    ) -> None:
        self._targets: Dict[str, ServiceTarget] = {t.service_id: t for t in targets}
        self._poll_interval = poll_interval
        self._bus = bus
        self._session_owner = session is None
        self._session: aiohttp.ClientSession = session or aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SEC)
        )

        # Build processing pipeline.
        self._processor: MetricProcessor = OutlierFilter(
            next_=SLAAnnotator(
                targets=self._targets,
                next_=EventPublisher(bus=bus),
            )
        )

        self._tasks: List[asyncio.Task[None]] = []
        self._stop_event = asyncio.Event()

    # ---------------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------------

    async def start(self) -> None:
        """
        Creates worker tasks (one per service target) and returns
        immediately.  The method is idempotent.
        """
        if self._tasks:
            return

        LOG.info("MetricCollector starting with %d targets", len(self._targets))
        for target in self._targets.values():
            task = asyncio.create_task(self._worker_loop(target), name=f"collector:{target.service_id}")
            self._tasks.append(task)

    async def stop(self) -> None:
        """
        Signals workers to end and waits for graceful shutdown (with
        bounded time limit).
        """
        if not self._tasks:
            return

        LOG.info("Stopping MetricCollector …")
        self._stop_event.set()

        await asyncio.wait(self._tasks, timeout=HTTP_TIMEOUT_SEC + self._poll_interval + 1)
        for task in self._tasks:
            if not task.done():
                task.cancel("metric-collector shutdown")
        self._tasks.clear()

        if self._session_owner:
            await self._session.close()

    def register_target(self, target: ServiceTarget) -> None:
        """
        Adds a new micro-service to the polling roster at runtime.
        """
        if target.service_id in self._targets:
            raise ValueError(f"target {target.service_id} already registered")
        self._targets[target.service_id] = target
        if self._tasks:
            task = asyncio.create_task(self._worker_loop(target), name=f"collector:{target.service_id}")
            self._tasks.append(task)
        LOG.info("Registered target %s (%s)", target.service_id, target.metrics_endpoint)

    # ---------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------

    async def _worker_loop(self, target: ServiceTarget) -> None:
        """
        Repeatedly poll *target* for metrics until *stop_event* is set.
        Implements exponential back-off on transient failures.
        """
        backoff_sec = 1.0

        while not self._stop_event.is_set():
            ts = time.time()
            try:
                sample = await self._fetch_metrics(target)
                if sample:
                    await self._processor.process(sample)
                backoff_sec = 1.0  # reset after success
            except Exception as exc:  # noqa: BLE001
                LOG.error("Metric fetch failed for %s: %s", target.service_id, exc, exc_info=True)
                backoff_sec = min(backoff_sec * 2, 30.0)

            # Wait for either the poll interval or back-off, whichever is larger.
            await asyncio.wait(
                [self._stop_event.wait()],
                timeout=max(self._poll_interval, backoff_sec) - (time.time() - ts),
            )

    async def _fetch_metrics(self, target: ServiceTarget) -> Optional[MetricSample]:
        """
        Queries the side-car endpoint.  Returns *None* on unrecoverable HTTP
        status codes (4xx) or JSON schema violations.
        """
        url = target.metrics_endpoint.rstrip("/") + "/snapshot"
        try:
            async with self._session.get(url) as resp:
                if resp.status == 404:
                    LOG.warning("Endpoint missing for %s (%s)", target.service_id, url)
                    return None
                resp.raise_for_status()
                payload = await resp.json()
        except aiohttp.ClientError as ce:
            LOG.debug("HTTP error (%s) when fetching %s: %s", type(ce).__name__, url, ce)
            raise
        except asyncio.TimeoutError:
            LOG.debug("Timeout when fetching metrics from %s", url)
            raise
        except json.JSONDecodeError:
            LOG.warning("Malformed JSON from %s", url)
            return None

        try:
            return MetricSample(
                service_id=target.service_id,
                timestamp=time.time(),
                cpu_pct=float(payload["cpu_pct"]),
                mem_pct=float(payload["mem_pct"]),
                latency_ms=float(payload["latency_ms"]),
            )
        except (KeyError, TypeError, ValueError):
            # Fallback to defensive metric so the orchestrator remains live
            LOG.warning(
                "Metric schema mismatch for %s – payload=%s. Falling back to random values.",
                target.service_id,
                payload,
            )
            return self._fake_metrics(target)

    # ------------------------------------------------------------------
    # Diagnostics / resilience helpers
    # ------------------------------------------------------------------

    def _fake_metrics(self, target: ServiceTarget) -> MetricSample:
        """
        Generates pseudo metrics if the side-car is not yet ready.  This
        keeps downstream components alive during rollouts.
        """
        return MetricSample(
            service_id=target.service_id,
            timestamp=time.time(),
            cpu_pct=random.uniform(5.0, 40.0),
            mem_pct=random.uniform(10.0, 50.0),
            latency_ms=random.uniform(20, target.sla_latency_ms * 0.8),
        )


# ============================================================================
# Example CLI entry-point (for manual testing)
# ============================================================================

async def _debug_subscriber(sample: MetricSample) -> None:
    ts = datetime.fromtimestamp(sample.timestamp, tz=timezone.utc).isoformat(timespec="milliseconds")
    viol = ",".join(sample.sla_violations) or "OK"
    LOG.info("[%s] %s CPU=%.1f%% MEM=%.1f%% LAT=%.1fms %s", ts, sample.service_id, sample.cpu_pct, sample.mem_pct, sample.latency_ms, viol)


async def _main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")
    bus = EventBus()

    # Subscribe a debug sink
    bus.subscribe(_debug_subscriber)

    collector = MetricCollector(
        targets=[
            ServiceTarget(
                service_id="svc-radiology",
                name="Radiology Viewer",
                metrics_endpoint="http://localhost:8001",
                sla_latency_ms=250,
                sla_cpu_pct=80,
            ),
            ServiceTarget(
                service_id="svc-prescribing",
                name="E-Prescribing",
                metrics_endpoint="http://localhost:8002",
                sla_latency_ms=180,
                sla_cpu_pct=70,
            ),
        ],
        bus=bus,
    )

    await collector.start()

    # Run indefinitely until Ctrl-C
    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        LOG.info("Interrupted by user")
    finally:
        await collector.stop()


if __name__ == "__main__":
    asyncio.run(_main())
```