# `@streampulse/service-ingress-gateway`

The Ingress Gateway is the edge-facing entry point of StreamPulse Nexus.  
It accepts **RTMP/HLS/DASH**, **web-socket**, and **gRPC** traffic, validates and routes it to the correct downstream service (transcoder, chat shard, telemetry collector, etc.) while enforcing zero-trust policies and performing dynamic load-balancing.

```
           ┌─────────────────────────────┐
Viewer --> │  Ingress Gateway (this pkg) │──┐─────────────┐
           └─────────────────────────────┘  │             │
                       ▲                    ▼             ▼
         JWT/OAuth2    │               Media Router   Telemetry Bus
                       │
                 Policy Engine
```

The package lives under `streampulse-nexus/packages/service-ingress-gateway`.

---

## Features

* Pluggable load-balancing **Strategy** (`roundRobin`, `geoAware`, `audienceHeatMap`)
* Declarative policy engine powered by Open Policy Agent (**OPA**)
* gRPC-based health probes with auto-quarantine & re-join
* Integrated **rate-limiter** and **DDoS shield**
* Auto-registration with the service discovery mesh (Consul / etcd)
* Emits structured **OpenTelemetry** events for real-time dashboards
* Hot-reload of TLS certificates and configuration (`SIGHUP` or fs-watch)

---

## Quick-Start

```bash
# 1. Install dependencies
pnpm i --filter @streampulse/service-ingress-gateway...

# 2. Run with default config (dev)
pnpm --filter @streampulse/service-ingress-gateway start
```

### Programmatic usage

```ts
import { createIngressGateway, HeatMapStrategy } from '@streampulse/service-ingress-gateway';
import { InMemoryEngine } from '@streampulse/policy-engine-memory';

(async () => {
  const gateway = await createIngressGateway({
    port: 443,
    balancer: new HeatMapStrategy(),
    policyEngine: new InMemoryEngine(),
    tls: {
      cert: fs.readFileSync('/etc/streampulse/cert.pem'),
      key:  fs.readFileSync('/etc/streampulse/key.pem')
    }
  });

  await gateway.start();
})();
```

---

## Configuration

| ENV Variable                       | Default         | Description                                           |
|----------------------------------- |-----------------|-------------------------------------------------------|
| `SP_GATEWAY_PORT`                  | `443`           | Public port                                           |
| `SP_GATEWAY_TLS_CERT_PATH`         | *(required)*    | Path to PEM cert                                      |
| `SP_GATEWAY_TLS_KEY_PATH`          | *(required)*    | Path to PEM key                                       |
| `SP_GATEWAY_BALANCER_STRATEGY`     | `roundRobin`    | Load-balancer strategy                                |
| `SP_GATEWAY_MAX_CONNECTIONS`       | `20000`         | Hard cap on concurrent sockets                        |
| `SP_GATEWAY_RATE_LIMIT_RPS`        | `300`           | Global requests / sec per client IP                   |
| `SP_GATEWAY_OPA_ENDPOINT`          | `http://opa:8181/v1/data` | OPA decision API                           |
| `SP_GATEWAY_DISCOVERY_ENDPOINT`    | `consul:8500`   | Service discovery host                                |

A full, typed config can be exported for documentation:

```bash
pnpm streampulse:ingress-gateway config:scaffold > ingress.example.yaml
```

---

## API Surface

### `createIngressGateway(options): Promise<Gateway>`

| Option                  | Type                                               | Required | Description |
|-------------------------|----------------------------------------------------|----------|-------------|
| `port`                  | `number`                                           | ✔        | Public listening port |
| `balancer`              | `LoadBalancerStrategy`                             | ✔        | Strategy pattern instance |
| `policyEngine`          | `PolicyEngine`                                     | ✔        | Adapter that resolves `isAllowed(request)` |
| `tls`                   | `{ cert: Buffer; key: Buffer }`                    | ✔        | TLS materials |
| `maxConnections`        | `number`                                           |          | Safety valve |
| `logger`                | `PinoLogger`                                       |          | Custom logger instance |

### Strategy contract

```ts
export interface LoadBalancerStrategy {
  /**
   * Decide which downstream cluster the ingress packet
   * should be forwarded to.
   */
  pickNode(packetMeta: PacketMeta): DownstreamNode;
  
  /**
   * Optional hook fired when downstream node health-checks fail.
   */
  onNodeDown?(node: DownstreamNode): void;
}
```

A reference implementation (`RoundRobinStrategy`) is shipped and used by default.

---

## Observability

* **Metrics** → exposed on `/metrics` (Prometheus)
* **Traces**  → OpenTelemetry exporter (`OTLP/gRPC`)
* **Logs**    → [Pino](https://github.com/pinojs/pino) + ECS structured output

> All three pillars share the same correlation IDs (`x-stream-trace-id`).

---

## Security model

1. Client handshake → mTLS (optional), TLS 1.3 by default  
2. JWT/OAuth2 tokens parsed & validated (Audience = `streampulse`)  
3. Request metadata piped into OPA for fine-grained decisions  
4. Rate-limiter & `fail2ban`-style reputation store  
5. Pluggable `WebApplicationFirewall` for custom signatures  
6. Continuous CVE scanning via `grype` (CI) and `npm audit`

---

## Development

```bash
# Run unit tests
pnpm --filter @streampulse/service-ingress-gateway test

# Lint & type-check
pnpm --filter @streampulse/service-ingress-gateway lint
pnpm --filter @streampulse/service-ingress-gateway typecheck

# Start in watch-mode with hot reload
pnpm --filter @streampulse/service-ingress-gateway dev
```

---

## Contributing

1. Fork 🍴 / PR ✅ / review ✍️  
2. Follow the **Conventional Commits** spec (`feat:`, `fix:` …)  
3. Run `pnpm ci` before pushing to ensure green CI

---

## License

Apache-2.0 © StreamPulse Inc.