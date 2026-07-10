```markdown
# `@streampulse-nexus/service-media-orchestrator`

[![CI](https://github.com/streampulse-nexus/service-media-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/streampulse-nexus/service-media-orchestrator/actions)
[![npm (scoped)](https://img.shields.io/npm/v/@streampulse-nexus/service-media-orchestrator)](https://www.npmjs.com/package/@streampulse-nexus/service-media-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

High-performance orchestration service that coordinates media packet routing, adaptive load-balancing, health monitoring, and zero-trust enforcement for the **StreamPulse Nexus** networking platform.

---

## ✨ Highlights

- **Pluggable runtimes** – swap in custom `RouterDrivers`, `LoadBalancers`, and `SecurityGuards` without touching the core.
- **Event-Driven Core** – emits rich lifecycle events (`health`, `overload`, `failover`, `recovery`), perfect for dashboards & alerting hooks.
- **Command Chain** – propagates disaster-recovery commands through clusters for coordinated failover with millisecond accuracy.
- **Typed Config** – JSON-Schema-validated configuration ensures safe, declarative deployments.
- **Observability-First** – built-in Prometheus metrics, OpenTelemetry traces, and structured logs.

---

## 🔧 Installation

```bash
# via npm
npm install @streampulse-nexus/service-media-orchestrator

# or yarn
yarn add @streampulse-nexus/service-media-orchestrator
```

Requires Node.js **≥ 18**.  

---

## 🏁 Quick-Start

```js
import { MediaOrchestrator } from '@streampulse-nexus/service-media-orchestrator';
import { RoundRobinBalancer } from '@streampulse-nexus/strategies-round-robin';
import { JwtGuard } from '@streampulse-nexus/security-jwt';
import { WebRTCDriver } from '@streampulse-nexus/router-webrtc';

(async () => {
  // 1. Bootstrap orchestrator with desired strategy & guards
  const orchestrator = new MediaOrchestrator({
    driver: new WebRTCDriver(),
    balancer: new RoundRobinBalancer(),
    guards: [new JwtGuard({ issuer: 'https://idp.streampulse.io' })],
    mediaCacheTTL: 5_000,               // milliseconds
    healthProbeInterval: 10_000,        // milliseconds
  });

  // 2. Observe runtime events
  orchestrator.on('overload', ({ nodeId, load }) => {
    console.warn(`[⚠️ ] node ${nodeId} is overloaded: ${load}%`);
  });

  // 3. Start orchestration cycle
  await orchestrator.boot();

  // 4. Wire into your shutdown signal
  process.once('SIGTERM', async () => {
    await orchestrator.shutdown();
    process.exit(0);
  });
})();
```

---

## 📂 Directory Structure

```
packages/
  service-media-orchestrator/
  ├── src/
  │   ├── core/                 <— command chain, event bus, orchestrator
  │   ├── balancers/            <— built-in load-balancing strategies
  │   ├── drivers/              <— protocol-specific routers (WebRTC, SRT, HLS…)
  │   ├── guards/               <— authN/Z & zero-trust modules
  │   └── schema/               <— JSON-Schemas & TypeScript types
  ├── tests/                    <— integration & contract tests
  ├── README.md                 ✔︎ (this file)
  └── package.json
```

---

## 🏗️ Architecture

```mermaid
flowchart LR
  subgraph Cluster
    direction LR
    A[Ingress Router] -->|media packets| B(MediaOrchestrator)
    B --> C1[Edge Cache]
    B --> C2[Transcoder]
    B --> C3[Analytics]
    B -->|telemetry| D[Prometheus Pushgateway]
  end

  B -- emits --> E[Event Bus (Redis Streams)]
  E -- updates --> F[Dashboard]

  click B "https://github.com/streampulse-nexus/service-media-orchestrator/blob/main/src/core/MediaOrchestrator.ts"
```

---

## 📝 Configuration Reference

### Environment Variables

| Key                                | Default        | Description                                               |
| ---------------------------------- | -------------- | --------------------------------------------------------- |
| `SP_MO_DRIVER`                     | `webrtc`       | Which router driver to boot (`webrtc`, `srt`, `hls`…)     |
| `SP_MO_BALANCER`                   | `round-robin`  | Load-balancing algo (`round-robin`, `least-loaded`, etc.) |
| `SP_MO_HEALTH_INTERVAL_MS`         | `10000`        | How often to probe node health.                           |
| `SP_MO_CACHE_TTL_MS`               | `5000`         | Packet cache lifetime before eviction.                    |
| `SP_MO_SECURITY_GUARDS`            | `jwt`          | Comma-separated list of guard IDs to enable.              |
| `SP_MO_TELEMETRY_EXPORTER`         | `otlp`         | Where to push traces (`otlp`, `stdout`).                  |

All variables are **override-able** via CLI flags or config file:

```bash
streampulse-orchestrator --balancer least-loaded --health-interval 8000
```

### `MediaOrchestratorOptions` (TypeScript)

```ts
export interface MediaOrchestratorOptions {
  driver: RouterDriver;                   // strategy pattern
  balancer: LoadBalancer;                 // strategy pattern
  guards?: SecurityGuard[];               // zero-trust
  mediaCacheTTL?: number;                 // ms
  healthProbeInterval?: number;           // ms
  logger?: Logger;                        // pino-compatible
}
```

---

## 🔌 Plugin Authoring

Need a specialised load-balancer for a battle-royale final circle?  
Implement the minimal contract and register at runtime.

```ts
import { LoadBalancer, BalancerContext } from '@streampulse-nexus/service-media-orchestrator';

export class HeatMapBalancer implements LoadBalancer {
  id = 'heat-map';

  selectNode(ctx: BalancerContext) {
    // Simple demo: pick node with lowest combined CPU & audience heat
    return ctx.nodes
      .filter(n => n.status === 'healthy')
      .sort((a, b) => a.cpu + a.audienceHeat - (b.cpu + b.audienceHeat))[0];
  }
}
```

Then:

```js
orchestrator.registerBalancer(new HeatMapBalancer());
```

---

## 🔒 Security Model

1. **Zero-Trust** – Every packet validated against the configured `SecurityGuard`s (e.g., mTLS, JWT scopes).
2. **Principle of Least Privilege** – Guards implement fine-grained, role-based access enforced at the edge.
3. **Defense in Depth** – Drivers sandbox protocol parsing; WAF rules block malformed or malicious frames.

---

## 📈 Observability

- Exposes `/metrics` → Prometheus
- Pushes OpenTelemetry traces → OTLP Collector
- Structured logs (Pino) → any log aggregator (Loki, ELK, Splunk)

```bash
curl http://localhost:9305/metrics
```

PromQL example:

```promql
rate(stream_pulse_packets_total[1m]) by (node_id, stream_id)
```

---

## 🧪 Testing

```bash
# run unit + integration tests
npm test

# open coverage
npm run test:coverage
```

`tests/integration/orchestrator.e2e.ts` spins up an in-memory Redis instance and mocks router drivers to assert end-to-end flow.

---

## 🛠️ Development

```bash
git clone https://github.com/streampulse-nexus/streampulse-nexus.git
cd streampulse-nexus/packages/service-media-orchestrator

# bootstrap monorepo
pnpm i

# watch & rebuild on the fly
pnpm dev
```

Open http://localhost:9234/dashboard for the interactive dev dashboard.

---

## 🤝 Contributing

We love your input! Check the [contributing guide](./CONTRIBUTING.md) for how to
set up your dev environment, run linting, and propose PRs.

1. Fork the repo
2. Create your feature branch: `git checkout -b feat/my-cool-thing`
3. Commit your changes: `git commit -m 'feat: add my cool thing'`
4. Push to the branch: `git push origin feat/my-cool-thing`
5. Open a pull request

---

## 📜 License

`@streampulse-nexus/service-media-orchestrator` is released under the MIT License.

---

© StreamPulse Inc. All Rights Reserved.
```