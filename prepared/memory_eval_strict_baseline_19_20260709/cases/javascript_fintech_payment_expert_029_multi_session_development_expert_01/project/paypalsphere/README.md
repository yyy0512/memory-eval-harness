```markdown
# PayPalsphere &nbsp;![](https://img.shields.io/badge/build-passing-brightgreen) ![](https://img.shields.io/badge/coverage-92%25-green) ![](https://img.shields.io/badge/license-MIT-blue)

> A socially-driven fintech payment ecosystem that turns every transaction into a shared moment.

---

## TL;DR

```bash
# 1. Clone
git clone https://github.com/paypalsphere/paypalsphere.git && cd paypalsphere

# 2. Seed .env
cp .env.example .env && vi .env

# 3. Boot the stack
docker compose up --build -d

# 4. Access the gateway
open http://localhost:8080
```

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Solution Architecture](#solution-architecture)
3. [Directory Layout](#directory-layout)
4. [Running Locally](#running-locally)
5. [Environment Variables](#environment-variables)
6. [Developer Guide](#developer-guide)
7. [Testing](#testing)
8. [Security](#security)
9. [Audit & Compliance](#audit--compliance)
10. [Contributing](#contributing)
11. [License](#license)

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| Circles | Social construct grouping users around a common purpose (friends, family, club, DAO, etc.). |
| Transaction Feed | Timeline of payments, comments, emoji-reactions, and tagged media. |
| CQRS + Event Sourcing | Every intent (`Command`) yields one or more immutable `Event`s that shape the read-models. |
| Saga Orchestration | Long-running, distributed workflows (e.g., collective fundraising) coordinated via the `saga-orchestrator` service. |
| Security-by-Design | Field-level encryption, attribute-based access control, consent tracking, and continuous compliance scanning. |

---

## Solution Architecture

```mermaid
flowchart LR
    A[API Gateway] -->|GraphQL & REST| B[Accounts MFE]
    A --> C[KYC MFE]
    A --> D[Risk MFE]
    A --> E[Transactions MFE]
    A --> F[Social MFE]
    A --> G[Settlement MFE]
    A --> H[Notification MFE]

    subgraph EventBus[NATS JetStream]
        X1(( )) 
    end

    B --> X1
    C --> X1
    D --> X1
    E --> X1
    F --> X1
    G --> X1
    H --> X1

    subgraph Storage
        S1[(PostgreSQL)]
        S2[(DynamoDB ES Snapshots)]
        S3[(ScyllaDB Read Models)]
        S4[[S3 Audit Vault]]
    end

    X1 --> S2
    B --> S1
    E --> S1
    H --> S3
    X1 --> S4
```

### Micro-Frontends & Matching Micro-Services

| Bounded Context | Frontend Package | Service Package | Port | Tech |
|-----------------|------------------|-----------------|------|------|
| Accounts        | `@pp/accounts-ui`| `accounts-svc`  | `7001` | React + NestJS |
| KYC             | `@pp/kyc-ui`     | `kyc-svc`       | `7002` | Vue + Go |
| Risk            | `@pp/risk-ui`    | `risk-svc`      | `7003` | Svelte + Rust |
| Transactions    | `@pp/tx-ui`      | `tx-svc`        | `7004` | React + Kotlin |
| Social Graph    | `@pp/social-ui`  | `social-svc`    | `7005` | Angular + Node |
| Notification    | `@pp/notify-ui`  | `notify-svc`    | `7006` | Lit + Elixir |
| Settlement      | `@pp/settle-ui`  | `settle-svc`    | `7007` | Solid + Python |

---

## Directory Layout

```bash
.
├── apps/
│   ├── accounts-svc/          # NestJS CQRS service
│   ├── kyc-svc/               # Go Fiber micro-service
│   ├── ...
│   └── gateway/               # BFF (GraphQL + REST)
├── packages/
│   ├── shared-kernel/         # Event schemas, value objects, policies
│   ├── saga-orchestrator/     # Long-running workflows
│   └── audit-trail/           # Signed logging
├── infrastructure/
│   ├── docker/                # Dockerfiles & compose
│   └── terraform/             # IaC for AWS
├── docs/                      # ADRs, diagrams, RFCs
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

---

## Running Locally

### Prerequisites

* Node.js `>=20`
* Docker `>=24`
* pnpm `>=8`
* `direnv` (optional, for environment injection)

### Quick Start

```bash
pnpm i
docker compose up --build   # Boots DBs, NATS, and all micro-services
```

The API Gateway will be reachable at:

```
REST  : http://localhost:8080/api
GraphQL Playground: http://localhost:8080/graphql
```

### Seeding Demo Data

```bash
pnpm exec ts-node scripts/seed-database.ts --profile=demo
```

---

## Environment Variables

`.env.example` (excerpt):

```bash
NODE_ENV=development
JWT_PRIVATE_KEY_PATH=./certs/jwt_priv.pem
DATABASE_URL=postgres://pp:dev@localhost:5432/paypalsphere
NATS_URL=nats://localhost:4222
REDIS_URL=redis://localhost:6379
KMS_ENDPOINT=http://localhost:8200
ENCRYPTION_MASTER_KEY=base64:XXXXXXXXXXXXXXXX
```

> Use `scripts/generate-keys.sh` to create fresh RSA key pairs for JWT and envelope encryption.

---

## Developer Guide

### Commands

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Live-reload services (uses Nx graph) |
| `pnpm build` | Production build for all packages |
| `pnpm lint` | ESLint + Prettier |
| `pnpm test` | Jest unit tests |
| `pnpm test:e2e` | Playwright E2E |
| `pnpm docs` | Generate typedoc to `docs/api` |
| `pnpm migrate` | Run Prisma migrations |

### Branching

1. `main` – production releases, protected.
2. `develop` – integration.
3. `feature/*` – new capabilities.
4. `fix/*` – hot-fixes.

### Commit Convention

We enforce [Conventional Commits](https://www.conventionalcommits.org/) via `husky + commitlint`.

### API Stub

```http
POST /api/v1/transactions
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "circleId": "c123",
  "amount": "42.50",
  "currency": "USD",
  "memo": "Dinner @ La Piazza 🍕",
  "split": {
    "mode": "EQUAL",
    "members": ["u001", "u002", "u003"]
  }
}
```

Successful response (`201 Created`):

```json
{
  "transactionId": "tx_01HX4A0J...",
  "status": "PENDING_KYC",
  "events": [
    {
      "type": "TransactionInitiated",
      "timestamp": "2024-05-24T09:41:22.224Z"
    }
  ]
}
```

---

## Testing

```bash
# unit
pnpm test --runInBand --coverage

# integration (spins dockerised deps)
pnpm nx run-many --target test:integration

# e2e (headless)
pnpm test:e2e
```

> **Tip:** All services share the in-memory `@pp/testing-toolkit` for mocks & fixtures.

---

## Security

1. Field-level encryption via [age-encryption](https://github.com/FiloSottile/age).
2. JWT proof-of-possession and *signed* URLs.
3. ABAC enforced by Oso; policies live in `packages/policies`.
4. Continuous SCA (`pnpm audit` + Snyk); report gates CI.
5. Static analysis (`semgrep`) scans every PR.

If you find a vulnerability, **_do not create a public issue_**—e-mail `security@paypalsphere.io` instead.

---

## Audit & Compliance

* All domain events are hashed (BLAKE3) and streamed to the `audit-trail` service.
* Hourly Merkle roots are anchored on Bitcoin & ETH (see `infra/anchoring/`).
* SOC2 Type-II attestation files are kept in a private S3 bucket (`audit-vault`).

---

## Contributing

We :heart: contributions!

1. Fork & create a feature branch.
2. Follow the [developer guide](#developer-guide).
3. Ensure `pnpm test` passes and coverage ≥ 90%.
4. Open a PR; the template will guide you.

> Legal note: By submitting code, you agree that your work will be released under the MIT license.

---

## License

MIT © 2024-present PayPalsphere Inc.

---

### Meta

```
Fintech ≈ Payments + Community + Storytelling
```
```