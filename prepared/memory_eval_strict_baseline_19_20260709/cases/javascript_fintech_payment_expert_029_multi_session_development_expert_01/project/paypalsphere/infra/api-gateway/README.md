```markdown
# PayPalsphere – API Gateway  
_Source: `paypalsphere/infra/api-gateway`_

The **API Gateway** is the single ingress point for every first-party or third-party client talking to the PayPalSphere backend.  
It implements the _Back-End-For-Front-End_ (BFF) pattern, GraphQL federation, real-time WebSocket subscriptions, distributed tracing, threat-layer security, and policy-based routing to downstream micro-services (Accounts, KYC, Risk, Transactions, Compliance, Social-Graph, Notification, Settlement).

---

## ✨ Key Responsibilities
| Capability            | Details |
| --------------------- | ------- |
| Protocol Multiplexing | Serves REST, GraphQL, WebSockets on the same origin. |
| AuthN/AuthZ           | Verifies OAuth 2.1/JWT tokens, mTLS, and Circle-level ACL claims. |
| Policy Enforcement    | Rate limiting, IP reputation, geo-fencing, PCI & GDPR redaction. |
| Federation            | Stitches bounded-context GraphQL schemas into a single graph. |
| Observability         | OpenTelemetry tracing, log correlation, and Prometheus metrics. |
| Resilience            | Circuit-breakers, retries with jitter, and bulkheads. |
| Security-by-Design    | CSP headers, HSTS, field-level encryption for PII, automatic key rotation. |

---

## 🏗️ Tech Stack

| Layer             | Choice                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| Runtime           | Node.js 18 LTS (`--experimental-modules`)                                             |
| HTTP              | [Fastify](https://www.fastify.io/) + [undici](https://github.com/nodejs/undici)       |
| GraphQL           | [Mercurius](https://github.com/mercurius-js/mercurius) with Federation v2             |
| Auth              | [OAuth 2.1](https://oauth.net/2), [OIDC](https://openid.net/connect/), JWKS rotation |
| Telemetry         | [OpenTelemetry JS](https://opentelemetry.io/) auto-instrumentation                   |
| Config            | [convict](https://github.com/mozilla/node-convict) schema validation                  |
| Secrets           | AWS Secrets Manager / HashiCorp Vault (pluggable)                                     |
| CI/CD             | GitHub Actions → Terraform (Infra) → AWS ECS Fargate / Kubernetes                     |

---

## 🚀 Quick Start (Local Dev)

```bash
# 1. clone repository
git clone git@github.com:paypalsphere/infra-api-gateway.git
cd infra-api-gateway

# 2. bootstrap
corepack enable && pnpm install

# 3. spin up local mocks (nats, postgres, redis, tempo, prom, jaeger...)
docker compose up -d

# 4. run gateway with hot reload
pnpm dev
```

The gateway by default listens on `https://localhost:4010` and auto-generates TLS certificates via `mkcert`.

---

## 🌿 Environment Variables

All configuration is strictly typed and validated at boot via [convict].  
Create a `.env` in project root or inject variables in your container orchestrator:

```dotenv
# HTTP & TLS
PORT=4010
HOST=0.0.0.0
TLS_KEY_PATH=certs/localhost-key.pem
TLS_CERT_PATH=certs/localhost.pem

# Auth
OIDC_ISSUER_URL=https://auth.paypalsphere.dev
OIDC_AUDIENCE=paypalsphere-api
JWKS_URI=https://auth.paypalsphere.dev/.well-known/jwks.json

# Downstream Services
SERVICE_ACCOUNTS_URL=http://accounts:7001
SERVICE_KYC_URL=http://kyc:7002
SERVICE_RISK_URL=http://risk:7003
# …

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
PROMETHEUS_PORT=9464
```

---

## 🗂️ Project Structure

```
infra/api-gateway
├─ src/
│  ├─ plugins/            # Fastify plugins (auth, otel, rateLimit, etc.)
│  ├─ routes/             # REST endpoints (health, version)
│  ├─ graphql/
│  │  ├─ schemas/         # SDL documents, auto-merged
│  │  └─ loaders/         # DataLoaders for N+1 avoidance
│  ├─ utils/              # Shared helpers (httpClient, logger, etc.)
│  └─ index.js            # Root bootstrap
├─ tests/
├─ docker/
│  └─ Dockerfile
└─ docker-compose.yml
```

---

## 📄 Example Code Snippets

### `src/index.js` – Bootstrap & Server Lifecycle

```js
import fastify from 'fastify';
import mercurius from 'mercurius';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import { registerOtel } from './plugins/otel.js';
import { authPlugin } from './plugins/auth.js';
import { federationSchema } from './graphql/schema.js';
import { logger } from './utils/logger.js';
import config from './utils/config.js';

export async function buildServer(opts = {}) {
  const app = fastify({
    logger,
    disableRequestLogging: false,
    trustProxy: true,
    ...opts
  });

  // --- Security Headers & CORS
  await app.register(fastifyHelmet, { global: true });
  await app.register(fastifyCors, {
    origin: [/\.paypalsphere\.dev$/, /localhost:\d+/],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id']
  });

  // --- Observability
  await app.register(registerOtel);

  // --- Authentication & RBAC
  await app.register(authPlugin);

  // --- GraphQL Federated Gateway
  await app.register(mercurius, {
    federationMetadata: true,
    schema: federationSchema,
    graphiql: config.isDev,
    subscription: true,
    context: (req, res) => ({
      user: req.user, // set by authPlugin
      requestId: req.id
    }),
    jit: 1
  });

  // --- Health Check
  app.get('/healthz', async (_req, reply) => reply.send({ status: 'ok' }));

  return app;
}

if (process.env.NODE_ENV !== 'test') {
  buildServer()
    .then(app =>
      app.listen({ port: config.get('port'), host: config.get('host') })
    )
    .catch(err => {
      app.log.error(err);
      process.exit(1);
    });
}
```

### `src/plugins/auth.js` – JWT Verification & Circle-Scoped ACL

```js
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createRateLimiter } from './rateLimit.js';
import config from '../utils/config.js';

const JWKS = createRemoteJWKSet(new URL(config.get('jwksUri')));

export const authPlugin = fp(async (app) => {
  const rateLimiter = createRateLimiter({
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: req => req.headers['authorization'] || req.ip
  });

  app.addHook('preHandler', async (req, _reply) => {
    // Basic “public route” bypass
    if (req.routerPath === '/healthz') return;

    await rateLimiter.consume(req); // anti-brute-force

    const header = req.headers['authorization'];
    if (!header) throw app.httpErrors.unauthorized('Missing Authorization header');

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer') throw app.httpErrors.unauthorized('Invalid auth scheme');

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: config.get('oidc.issuer'),
        audience: config.get('oidc.audience')
      });

      // Custom domain logic: circle membership/ACL claims
      if (!payload['circle_id']) {
        throw new Error('circle_id claim is required');
      }

      req.user = {
        id: payload.sub,
        circleId: payload['circle_id'],
        scope: payload.scope?.split(' ') ?? []
      };
    } catch (err) {
      // granulate error message without leaking internals
      app.log.warn({ err }, 'Auth failed');
      throw app.httpErrors.unauthorized('Invalid or expired token');
    }
  });
});
```

### `src/utils/httpClient.js` – Typed, Resilient HTTP Client

```js
import { request } from 'undici';
import { CircuitBreaker } from 'opossum';
import config from './config.js';
import { logger } from './logger.js';

const breakerOptions = {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000
};

export async function callService(serviceName, { pathname, method = 'GET', ...opts }) {
  const baseUrl = config.get(`services.${serviceName}.url`);
  const targetUrl = new URL(pathname, baseUrl);

  const breaker = CircuitBreaker(async () => {
    const res = await request(targetUrl, { method, ...opts });
    if (res.statusCode >= 500) {
      const body = await res.body.text();
      throw new Error(`[${serviceName}] Upstream error: ${res.statusCode} → ${body}`);
    }
    return res.body.json();
  }, breakerOptions);

  breaker
    .on('open', () => logger.warn(`${serviceName} circuit opened`))
    .on('halfOpen', () => logger.info(`${serviceName} circuit half-open`))
    .on('close', () => logger.info(`${serviceName} circuit closed`));

  return breaker.fire();
}
```

---

## ✔️ Running Tests

```bash
pnpm test              # jest + mercurius plugin unit tests
pnpm test:e2e          # k6 smoke suite against docker-compose stack
pnpm test:security     # npm audit + snyk + dependency-check
```

---

## 📈 Observability

1. Traces are shipped to **Tempo** via OTLP; visualise in Grafana at `http://localhost:3000`.
2. Metrics are scraped by **Prometheus**; dashboards under `grafana/dashboards/api-gateway.json`.
3. Logs are structured JSON (ecs-v1) out-of-the-box; pipe to Loki, Elastic, or CloudWatch.

---

## ♻️ Deployment

The gateway ships a hardened multi-arch image (`linux/amd64`, `linux/arm64`).

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/paypalsphere/api-gateway:1.2.3 \
  --push .
```

A `Terraform` module (`infra/terraform/api-gateway`) exposes:
- `health/alb` for public traffic.
- `internal/nlb` for east-west service mesh.
- IAM roles with least-privilege (read Secrets Manager, publish to SNS).

---

## 🔐 Security Practices

- Automatic OWASP ASVS self-tests on every build.
- `server-timing` header stripped in production.
- DNSSEC + TLS 1.3 enforced (AEAD ciphers only).
- All cookies `SameSite=Lax; Secure; HttpOnly`.
- Secrets rotated through HashiCorp Vault TTL < 24h.

---

## 📝 Changelog (excerpt)

| Version | Date       | Notes                                                |
| ------- | ---------- | ---------------------------------------------------- |
| 1.2.3   | 2024-05-22 | Added Graceful Shutdown; upgraded Fastify v4.26. | 
| 1.2.2   | 2024-05-14 | CSP tightening, Sentry breadcrumb integration.       |
| 1.2.1   | 2024-05-02 | GraphQL Fed v2, subscriptions with NATS transport.   |

Full log in `CHANGELOG.md`.

---

## ❓ FAQ

**Why not Kong / Tyk / Envoy?**  
We evaluated managed gateways, but a custom Node.js BFF yields tighter coupling with GraphQL federation, lower latency for chatty social-payment queries, and first-class observability tailored to our domain events.

**Is it production-grade?**  
Yes. This gateway handles constant ~5k rps with p99 < 120 ms in EU-West.  
Chaos experiments (latency injection, kill pod) are part of the nightly pipeline.

---

## Contributing

1. Fork → feature branch (`feat/gate-xyz`)  
2. `pnpm test` && `pnpm lint --fix`  
3. Open PR with _[api-gateway]_ prefix  
4. Wait for 2 approvals + green CI

See `CODE_OF_CONDUCT.md` and `SECURITY.md` for more information.

---

© 2024 PayPalSphere – We turn payments into conversations 🚀
```