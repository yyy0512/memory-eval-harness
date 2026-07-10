```markdown
# StreamPulse Nexus

[![CI](https://github.com/streampulse/streampulse-nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/streampulse/streampulse-nexus/actions)
[![Coverage Status](https://coveralls.io/repos/github/streampulse/streampulse-nexus/badge.svg?branch=main)](https://coveralls.io/github/streampulse/streampulse-nexus?branch=main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Carrier-grade, component-based networking for high-energy, interactive entertainment streams.

---

## Table of Contents

1. [Features](#features)
2. [Quick Start](#quick-start)
3. [Architecture](#architecture)
4. [Usage Examples](#usage-examples)
5. [Configuration](#configuration)
6. [Development Setup](#development-setup)
7. [Contributing](#contributing)
8. [License](#license)

---

## Features

| Domain                     | Highlights                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| **System Monitoring**      | Distributed health probes, pulse aggregation, hot-path latency audits                        |
| **Security Scanning**      | Zero-trust perimeter, CVE drift detection, token sealing & automated rotation                |
| **Backup & Recovery**      | Continuous media snapshotting, region-aware cold storage, cluster-wide fail-forward commands |
| **Configuration Management** | Declarative runtime graphs, shadow launches, canary weights, Git-ops sync                  |
| **Alerting**               | Rule + ML hybrid detectors, on-call escalations, situational playbooks                        |

---

## Quick Start

StreamPulse Nexus is released on **npm** and requires **Node.js 18+**.

```bash
# ⏳ Install core + official plugins
npm install @streampulse/nexus \
            @streampulse/plugin-transcoder \
            @streampulse/plugin-edge-cache \
            @streampulse/plugin-analytics
```

Spin up a local topology:

```bash
npx nexus up \
  --topology examples/topology.local.yml \
  --env ./examples/.env.local
```

---

## Architecture

```mermaid
flowchart TD
    subgraph Ingress
        A1(WebRTC) --> R1
        A2(RTMP)   --> R1
        A3(SRT)    --> R1
    end

    R1(Media Router) -->|Event Bus| B1(In-Mem Broker)
    B1 -->|Observer| D1([Dashboards])
    B1 -->|Command|  F1(Recovery Ctrl)
    B1 -->|Strategy| L1(Load Balancer)

    subgraph Edge
        L1 --> E1(Edge Cache)
        E1 -->|Scale Out| E2(Edge Cache)
    end

    L1 --> T1(Transcoder)
    T1 --> O1(Egress Mux)
    O1 --> Users
```

### Design Patterns

* **Observer** – Routers publish health & traffic deltas to dashboards.
* **Event-Driven** – Packet pipelines communicate through an internal broker (NATS by default).
* **Command** – Disaster-recovery orchestrator issues rollback commands that traverse clusters.
* **Strategy** – Load balancer swaps algorithms based on audience heat-maps or show format.
* **Chain-of-Responsibility** – Security scanners cascade token validation, anomaly inspection,
  and rate-limiting.

---

## Usage Examples

### 1. Minimal Boot

```js
// index.js
import { Nexus } from '@streampulse/nexus';
import TranscoderPlugin from '@streampulse/plugin-transcoder';

// 1. Initialize core
const nexus = new Nexus({
  broker: { driver: 'nats', url: process.env.NATS_URL },
  logger: { level: 'info' }
});

// 2. Register plugins
nexus.use(new TranscoderPlugin({
  preset: '1080p@60',
  poolSize: 5
}));

// 3. Start services
(async () => {
  try {
    await nexus.start();
    nexus.logger.info('🚀  Nexus is live!');
  } catch (err) {
    nexus.logger.fatal(err, 'Boot failed');
    process.exit(1);
  }
})();
```

### 2. Custom Load-Balancing Strategy

```js
import { createStrategy } from '@streampulse/nexus';

export const BattleRoyaleStrategy = createStrategy({
  name: 'battleRoyale',
  description: 'Prioritize low-latency shards for final circles.',
  pick (nodes, context) {
    const hot = context.telemetry.hotZones; // e.g., {us-east-1: 0.75, eu-west-1: 0.12, ...}
    return nodes.sort((a, b) => (hot[a.region] ?? 0) - (hot[b.region] ?? 0));
  }
});
```

Register via CLI:

```bash
npx nexus strategy add --file ./battle-royale.js
```

---

## Configuration

StreamPulse Nexus is **configuration-first**. A production deployment is defined as a
declarative topology file:

```yaml
# topology.prod.yml
---
version: v1
ingress:
  webrtc:
    bind: '0.0.0.0:443'
    cert: '/etc/ssl/fullchain.pem'
  rtmp:
    bind: '0.0.0.0:1935'

edge:
  cache:
    replicas: 8
    provider: cdn77
transcoder:
  presets:
    - 1080p@60
    - 720p@60
  poolSize: 40
loadBalancer:
  strategy: battleRoyale
broker:
  driver: nats
  url: nats://nats-prod:4222
alerts:
  - rule: 'latency_ms > 1200'
    severity: critical
    playbook: latency-spike
backup:
  snapshotInterval: 15m
  provider: aws
  bucket: streampulse-prod-media
```

Apply changes safely:

```bash
npx nexus deploy --file topology.prod.yml --canary 10%
```

---

## Development Setup

```bash
# Clone repo
git clone https://github.com/streampulse/streampulse-nexus.git
cd streampulse-nexus

# 🔧  Install root dependencies
npm ci

# 🧪  Run tests
npm test

# 🌐  Spin up local stack (Docker)
docker compose -f docker/docker-compose.dev.yml up
```

### Useful npm Scripts

| Script              | Purpose                                |
| ------------------- | -------------------------------------- |
| `npm run dev`       | Hot-reload core services               |
| `npm run lint`      | Lints codebase via ESLint + Prettier   |
| `npm run test`      | Executes Jest + C8 coverage            |
| `npm run release`   | Semantic-release automation            |

---

## Contributing

We :heart: PRs!

1. Fork → Branch → Commit (conventional commits please)
2. `npm run lint && npm test`
3. Push & open a pull request.
4. A maintainer will review, request changes if necessary, and merge.

Need help? Join `#nexus-dev` on our
[Discord server](https://discord.gg/streampulse).

---

## License

MIT © StreamPulse Ltd & Contributors
```
