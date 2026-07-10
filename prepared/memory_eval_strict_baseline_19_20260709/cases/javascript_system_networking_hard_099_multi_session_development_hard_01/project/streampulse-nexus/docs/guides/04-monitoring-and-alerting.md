```markdown
# Monitoring & Alerting Guide

StreamPulse Nexus ships with a built-in observability stack that gives operators a
real-time view into every packet, frame and message flowing through the mesh.
This document explains how to instrument a component, expose metrics,
configure thresholds and wire-up alert channels.

> All examples are written in JavaScript (Node 14 LTS +) and assume you have
> installed the official `@streampulse/nexus-observability` package.

---

## 1. Observability Architecture

```
          ┌──────────────┐
          │  Component A │──┐
          └──────────────┘  │      ╔════════════════╗
          ┌──────────────┐  │      ║   Event Bus    ║
          │  Component B │──┤─────►║ (NATS/Redis)   ║
          └──────────────┘  │      ╚════════════════╝
                            │               │
          ┌──────────────┐  │               ▼
          │  Component C │──┘      ╔════════════════╗
          └──────────────┘         ║  Metric Sinks  ║───► Prometheus / InfluxDB
                                   ╚════════════════╝
                                            │
                                            ▼
                                   ╔════════════════╗
                                   ║  Notifier Hub  ║───► Slack / PagerDuty / SMTP
                                   ╚════════════════╝
```

1. **Metric Collector** – Aggregates counters, gauges and histograms.
2. **Event Bus** – Publishes structured events (`HealthChanged`, `ShardHot`,
   `CapacityDegraded`).
3. **Alert Engine** – Evaluates user-defined rules and dispatches to notifiers.

---

## 2. Quick-Start Example

Below is a minimal example that exposes health metrics for a custom **Ingress
Gateway** and triggers a Slack alert when the moving average of the 1-minute CPU
load exceeds 85 % for 2 minutes.

```bash
npm i @streampulse/nexus-observability @streampulse/nexus-notifier-slack
```

```javascript
// ingress-monitor.js
import os from 'node:os';
import { setInterval } from 'node:timers';
import {
  MetricRegistry,
  Gauge,
  SlidingWindowAggregator,
  AlertEngine,
  RuleEvaluator,
} from '@streampulse/nexus-observability';
import { SlackNotifier } from '@streampulse/nexus-notifier-slack';

/**
 * Metric registry shared by the whole process.
 */
const registry = new MetricRegistry();

/**
 * 1. Register a gauge that samples the current CPU load.
 */
const cpuLoadGauge = new Gauge({
  name:    'system_cpu_load_1m',
  help:    '1-minute load average divided by CPU core count',
  collect: () => os.loadavg()[0] / os.cpus().length,
});

registry.register(cpuLoadGauge);

/**
 * 2. Aggregate the last two minutes (120 s) with 12 buckets (10 s each)
 *    so that we can compute `avg(1m)` and `avg(2m)`.
 */
const cpuAggregator = new SlidingWindowAggregator(cpuLoadGauge, {
  window: 120_000,
  buckets: 12,
});
registry.register(cpuAggregator);

/**
 * 3. Configure Slack notifier
 */
const slackNotifier = new SlackNotifier({
  token:  process.env.SLACK_BOT_TOKEN,
  channel: '#nexus-ops',
});

/**
 * 4. Create alert engine, add a rule and start processing
 */
const alertEngine = new AlertEngine();
alertEngine.useNotifier(slackNotifier);

// Rule syntax is PromQL-ish but evaluated locally
alertEngine.addRule(
  RuleEvaluator.when('avg(1m) > 0.85 for 2m')
    .on(cpuAggregator)
    .withLabel('severity', 'critical')
    .withSummary('CPU saturation on ${host}')
    .withDescription(
      'CPU load (${value}) has been above 85 % for the last 2 minutes on ${host}.'
    )
);

alertEngine.start();     // Begins polling aggregators
registry.startScraping(); // Exposes `/metrics` on :9100 by default

console.log('Ingress monitor running on port 9100...');
```

---

## 3. Instrumentation Cheat-Sheet

| Metric                    | Class      | When to use it                        |
| ------------------------- | ---------- | ------------------------------------- |
| Counter                   | Counter    | Monotonically increasing values (e.g., packets sent) |
| Gauge                     | Gauge      | Instantaneous value (e.g., CPU, heap usage)          |
| Histogram / Summary       | Histogram  | Distribution of latencies or sizes                   |
| Event                     | `bus.emit` | Discrete state change (e.g., `ShardMigrated`)        |

### Example: Recording Frame Latency

```javascript
import { Histogram } from '@streampulse/nexus-observability';

const frameLatency = new Histogram({
  name: 'media_frame_latency_ms',
  help: 'End-to-end latency of media frames in milliseconds',
  buckets: [5, 10, 20, 50, 100, 200, 500],
});

export function recordFrame(startTimeNs) {
  const latencyMs = (process.hrtime.bigint() - startTimeNs) / 1_000_000n;
  frameLatency.observe(Number(latencyMs));
}
```

---

## 4. Distributed Tracing

StreamPulse uses the W3C Trace Context. Any span created with the
`@streampulse/nexus-observability` tracer propagates headers:

```javascript
import { tracer } from '@streampulse/nexus-observability';

export async function forwardPacket(packet, nextHop) {
  return tracer.startActiveSpan('forwardPacket', async (span) => {
    span.setAttribute('packet.id', packet.id);
    await nextHop.send(packet);   // downstream will keep the trace
  });
}
```

Trace data can be exported to Jaeger or Tempo via OTLP:

```yaml
tracing:
  exporter: otlp
  endpoint: tempo-gw.internal:4317
  serviceName: ingress-gateway
```

---

## 5. Alerting Deep-Dive

### 5.1 Event-Bus Alerting

Component failures that trigger *state* transitions are better expressed as
events instead of polling metrics. Every node hosts an internal
`EventEmitter`-compatible bus, which fans-out to the global NATS cluster.

```javascript
import { eventBus } from '@streampulse/nexus-core';

eventBus.emit('ShardHot', {
  shardId:  'shard-eu-3',
  viewers:  42_500,
  capacity: 40_000,
  at:       Date.now(),
});
```

The alert engine can subscribe to these event streams:

```javascript
alertEngine.onEvent('ShardHot', ({ shardId, viewers, capacity }) => {
  if (viewers > capacity) {
    alertEngine.notifyAll({
      summary:     `Shard ${shardId} overloaded`,
      description: `${viewers}/${capacity} viewers`,
      labels:      { severity: 'warning', shardId },
    });
  }
});
```

---

### 5.2 Writing a Custom Notifier

Need OpsGenie? XOR-encrypted SMS? Implement the `Notifier` interface:

```javascript
import { Notifier } from '@streampulse/nexus-observability';

/**
 * Sends alerts as signed JSON blobs to a webhook that speaks
 * the "MegaPage" protocol (hypothetical example).
 */
export class MegaPageNotifier extends Notifier {
  constructor({ endpoint, secret }) {
    super('megapage');
    this.endpoint = endpoint;
    this.secret   = secret;
  }

  /**
   * @param {import('@streampulse/nexus-observability').AlertMessage} msg
   */
  async dispatch(msg) {
    const signedPayload = sign(JSON.stringify(msg), this.secret);
    const res = await fetch(this.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ payload: signedPayload }),
    });

    if (!res.ok) {
      // Let the alert engine decide whether to retry
      throw new Error(`MegaPage responded ${res.status}`);
    }
  }
}
```

Register at runtime:

```javascript
alertEngine.useNotifier(
  new MegaPageNotifier({
    endpoint: 'https://pager.internal/api/v1/alert',
    secret:   process.env.MEGAPAGE_SECRET,
  })
);
```

---

## 6. Declarative Configuration

Operators typically won’t hard-code alerts. Place YAML in
`/etc/streampulse/nexus-monitoring.yml`:

```yaml
collectors:
  - type: prom-scraper
    port: 9100

aggregators:
  - name: cpuUtil
    source: system_cpu_load_1m
    window: 120s
    buckets: 12

rules:
  - expr: 'avg(cpuUtil, 1m) > 0.85 for 2m'
    summary: 'CPU saturation on ${host}'
    description: |
      CPU load has been above 85 % for 2 consecutive minutes
      on ${host}. Verify scaling policy and traffic spikes.
    severity: critical
    notify: [slack, pagerduty]

notifiers:
  - id: slack
    type: slack
    token: ${SLACK_BOT_TOKEN}
    channel: '#nexus-ops'
  - id: pagerduty
    type: pagerduty
    routingKey: ${PD_ROUTING_KEY}
```

Load at startup:

```javascript
import { bootstrapMonitoring } from '@streampulse/nexus-observability';
await bootstrapMonitoring('/etc/streampulse/nexus-monitoring.yml');
```

---

## 7. CLI Cheat-Sheet

```bash
# List active metrics & their last scrape time
nexus-monitoring ls

# Validate config file before deploy
nexus-monitoring lint ./nexus-monitoring.yml

# Tail alert stream (great for smoke tests)
nexus-monitoring tail --since 10m
```

---

## 8. End-to-End Test

The repository includes a Jest integration test that spins up a local
Prometheus + Alertmanager + Slack mock:

```bash
npm run test:monitoring
```

---

## 9. Troubleshooting

• **Metric missing?** Ensure the component has called
`registry.register(metric)` *and* the collector scrape interval (default 15 s)
has elapsed.

• **Duplicate alerts?** Confirm you are not registering the same `Notifier`
twice―inspect `alertEngine.diagnostics().notifiers`.

• **High cardinality?** Avoid unbounded label values (`userId`, `sessionId`). Use
sampling or aggregation before export.

---

## 10. Best Practices Checklist

- [x] One histogram for each critical latency path, capped buckets.
- [x] Emit an event instead of a gauge for discrete incidents.
- [x] Never block the hot path—metrics must be non-blocking.
- [x] Surface your component version via `build_info` gauge.
- [x] Keep alert descriptions actionable, not just metrics math.

Happy streaming! 🎧
```