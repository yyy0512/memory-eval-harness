```markdown
# VitalOps Orchestrator – API Guide
The VitalOps Orchestrator is an **event-driven automation fabric** purpose-built for private-cloud Electronic Medical-Record (EMR) workloads.  
This guide explains how to embed, extend and operate the Python SDK that ships with the orchestrator.

---

## Contents
1. [Quick Start](#quick-start)
2. [Runtime Architecture](#runtime-architecture)
3. [Event Bus API](#event-bus-api)
4. [Policy Pipeline API](#policy-pipeline-api)
5. [Coordinator ViewModels](#coordinator-viewmodels)
6. [Extending the Orchestrator](#extending-the-orchestrator)
7. [Observability & Metrics](#observability--metrics)
8. [CLI Reference](#cli-reference)
9. [Error Handling & Troubleshooting](#error-handling--troubleshooting)

---

## Quick Start
Below is the **minimal working example** that listens for a `ClinicalServiceDegraded` event and triggers a targeted workload recovery:

```python
from vitalops_orchestrator.bus import EventBus, events
from vitalops_orchestrator.coordinators import RecoveryCoordinator
from vitalops_orchestrator.policy import AntiAffinityPolicy

bus = EventBus()

# 1️⃣ Register a coordinator
recovery = RecoveryCoordinator(bus)

# 2️⃣ Inject a custom policy into the chain
recovery.add_policy(AntiAffinityPolicy(max_services_per_node=3))

# 3️⃣ Activate the bus
bus.run_async()

# 4️⃣ Simulate a degraded service
bus.publish(events.ClinicalServiceDegraded(service_id="svc-radiology-viewer"))
```

Run it:

```console
$ python -m examples.recovery_example
[13:32:55] ⛑  RecoveryCoordinator⟩ Initiating remediation for svc-radiology-viewer
[13:32:55] ✅  AntiAffinityPolicy⟩ migrated instance to node-42
```

---

## Runtime Architecture
```
┌──────────────┐    Event Stream     ┌──────────────┐
│  Containers  │ ───────────────────▶│  Event Bus   │──┐
└──────────────┘                    └──────────────┘  │
                                                     ▼
                                               ┌──────────────┐
                                               │ Coordinators │──┐
                                               └──────────────┘  │
                                     Chain-of-Responsibility    ▼
                                               ┌──────────────┐
                                               │   Policies   │
                                               └──────────────┘
```

• **Event Bus** – in-memory or Redis-backed pub/sub layer  
• **Coordinators** – MVVM “ViewModels” that react to domain events  
• **Policies** – encapsulate discrete compliance or operational rules  

---

## Event Bus API
### Signature
```python
class EventBus:
    def subscribe(self, event_type: Type[E], callback: Callback) -> Subscription
    def publish(self, event: DomainEvent) -> None
    def run_async(self, *extra_tasks: Awaitable) -> asyncio.Task
```

### Example – Multiple Consumers
```python
from vitalops_orchestrator.bus import EventBus
from vitalops_orchestrator.events import PACSLatencyExceeded, SepsisPredictionDegraded

bus = EventBus()

def pagerduty_alert(evt: PACSLatencyExceeded) -> None:
    pagerduty.trigger("PACS latency critical", details=evt.__dict__)

def log_anomaly(evt: SepsisPredictionDegraded) -> None:
    logger.warning("Sepsis ML degraded → %s", evt.service_id)

bus.subscribe(PACSLatencyExceeded, pagerduty_alert)
bus.subscribe(SepsisPredictionDegraded, log_anomaly)
```

---

## Policy Pipeline API
Policies are chained at runtime:

```python
from vitalops_orchestrator.policy import BasePolicy

class EmergencyOverridePolicy(BasePolicy):
    """
    Pre-empts all other policies if patient-safety SLA is breached.
    """
    def evaluate(self, context: PatientContext) -> PolicyResult:
        if context.is_critical():
            return self.Result(action="OVERRIDE", reason="Patient code red")
        return self.Result.pass_()
```

Attach to any coordinator:

```python
coordinator.add_policy(EmergencyOverridePolicy())
```

Policies can `return`:
• `PASS` – allow subsequent policies  
• `DENY` – block the chain  
• custom action payloads

---

## Coordinator ViewModels
Built-ins:

| Coordinator             | Purpose                                    |
| ------------------------| ------------------------------------------ |
| `PerformanceCoordinator`| Balances workloads across nodes            |
| `RecoveryCoordinator`   | Handles fail-over & restarts               |
| `DeploymentCoordinator` | Blue-Green & Canary orchestration          |

### Custom Coordinator Skeleton
```python
from vitalops_orchestrator.coordinators import BaseCoordinator
from vitalops_orchestrator.events import UpgradeWindowOpened

class ComplianceCoordinator(BaseCoordinator[UpgradeWindowOpened]):
    """
    Disables deployments if compliance evidence is stale.
    """

    subscribe_to = [UpgradeWindowOpened]

    async def handle(self, event: UpgradeWindowOpened) -> None:
        if not audit_repo.has_current_evidence():
            self.logger.warning("Evidence stale – blocking deployment")
            return
        await self.trigger_deployment(event)
```

---

## Extending the Orchestrator
1. **New Event** – subclass `DomainEvent`  
2. **Policy Plugin** – subclass `BasePolicy`, register via entry-points `vitalops.policies`  
3. **Third-party Metrics** – implement `MetricProvider` interface  

Entry-points (`pyproject.toml`):
```toml
[project.entry-points."vitalops.policies"]
emergency = "hospital_plugins.emergency:EmergencyOverridePolicy"
```

---

## Observability & Metrics
All coordinators emit OpenTelemetry traces.  

Enable the **Prometheus exporter**:

```python
from vitalops_orchestrator.telemetry import enable_prometheus

enable_prometheus(host="0.0.0.0", port=9109)
```

Check `localhost:9109/metrics`:

```
vitalops_recovery_actions_total{service="svc-radiology-viewer"} 7
```

---

## CLI Reference
```
$ vitalops --help
Usage: vitalops [OPTIONS] COMMAND [ARGS]...

Commands:
  run          Start orchestrator with given config
  policy-list  Show active policy chain
  event-push   Publish an ad-hoc event
```

### Dry-Run a Maintenance Window
```console
$ vitalops run --config ./configs/maintenance.yaml --dry-run
```

---

## Error Handling & Troubleshooting
| Symptom                          | Diagnostic Command                            | Resolution                              |
|----------------------------------|-----------------------------------------------|-----------------------------------------|
| Coordinator never fires          | `vitalops event-push --trace`                 | Verify `subscribe_to` type matches      |
| Policy chain is stuck            | `vitalops policy-list --verbose`              | Re-order or remove blocking policy      |
| High CPU in event loop           | `py-spy top --pid $(pgrep -f vitalops)`       | Check for synchronous I/O in handlers   |

Enable **debug logging**:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

---

© 2024 VitalOps, Inc. – API v3.7
```