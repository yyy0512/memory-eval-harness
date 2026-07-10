```markdown
# 📂 `@paypalsphere/accounts-service`

The **Accounts Service** is the system of record for user‐centric identity, profile, and wallet metadata inside the **PayPalsphere** ecosystem.  
It owns:

* Creation and life-cycle management of **Accounts**  
* Event‐sourced state transitions that can be replayed for auditing & social storytelling  
* Field-level encryption / hashing of PII in compliance with GDPR & PCI-DSS  
* Role & consent enforcement published as ACL side-tables for downstream micro-services  
* Integration points for **KYC**, **Risk**, **Compliance**, **Social Graph**, **Notification**, and **Settlement** contexts

> NOTE: The service is implemented with **Node.js 18 LTS**, **TypeScript**, **NestJS**, **Prisma**, and **Apache Kafka**.

---

## 🌐 Table of Contents
1. [High-level Architecture](#high-level-architecture)
2. [Tech-stack](#tech-stack)
3. [Getting Started](#getting-started)
4. [Environment Variables](#environment-variables)
5. [Running the Service](#running-the-service)
6. [API Reference](#api-reference)
7. [Domain Events](#domain-events)
8. [Testing](#testing)
9. [Observability](#observability)
10. [Security Considerations](#security-considerations)
11. [Contributing](#contributing)
12. [License](#license)

---

## 🗺️ High-level Architecture
```
                                ┌──────────────────┐
                                │  public-api-gw   │
                                └────────┬─────────┘
                                         ▼
                                ┌──────────────────┐
                                │ accounts-service │◄─┐
                                └────────┬─────────┘  │
         ┌──────────────────────┐        │            │
         │      event-bus       │◄───────┘            │
         └────────┬─────────────┘        emits        │
                  │                 ┌─────────────────┴─────────────────┐
                  │                 │      kyc-service / risk / …       │
                  │                 └───────────────────────────────────┘
                  ▼
          ┌────────────┐
          │  event-db  │  (PostgreSQL + Kafka log)
          └────────────┘
```

The service follows **CQRS + Event Sourcing**:
* **Command Handlers** validate intent, enforce invariants, then emit immutable *Account** events.
* **Event Handlers** mutate read-models (PostgreSQL) & push integration events to **Kafka**.
* Long-running transactions (e.g. multi-currency wallet provisioning) are coordinated by **Sagas**.

---

## 🛠️ Tech-stack
| Layer            | Technology                                    |
| ---------------- | --------------------------------------------- |
| Runtime          | Node.js 18 (Alpine)                           |
| Framework        | NestJS 10 ‑ modular architecture              |
| Data Modeling    | Prisma ORM (PostgreSQL)                       |
| Event Store      | Kafka 3.x (confluent schema registry)         |
| AuthZ / RBAC     | CASL + Keycloak (OpenID Connect)              |
| Secrets          | Hashicorp Vault                               |
| Tests            | Jest + Supertest                              |
| CI/CD            | GitHub Actions → Docker Buildx → ArgoCD       |

---

## 🚀 Getting Started

```bash
# 1. Clone
git clone git@github.com:paypalsphere/paypalsphere.git
cd services/accounts-service

# 2. Install
npm ci

# 3. Provision infrastructure (local)
docker compose -f docker-compose.dev.yml up -d

# 4. Migrate + seed
npm run db:migrate
npm run db:seed

# 5. Start service with hot-reload
npm run start:dev
```

---

## 🔑 Environment Variables

| Variable                     | Description                                              | Example                             |
| ---------------------------- | -------------------------------------------------------- | ----------------------------------- |
| `NODE_ENV`                   | Runtime environment                                      | `development`                       |
| `PORT`                       | HTTP port                                                | `4000`                              |
| `DATABASE_URL`               | PostgreSQL DSN (Prisma)                                  | `postgresql://…`                    |
| `KAFKA_BROKERS`              | Comma-separated broker list                              | `localhost:19092`                   |
| `JWT_PUBLIC_KEY`             | PEM-encoded public key for access-token verification     | `-----BEGIN PUBLIC KEY-----…`       |
| `PII_ENCRYPTION_KEY`         | AES-256 key (32 bytes) for field-level encryption        | `base64:6v3IPx…`                    |
| `VAULT_ADDR`                 | Vault URL                                               | `http://vault:8200`                 |
| `LOG_LEVEL`                  | Winston log level                                        | `info`                              |

> See `.env.example` for the full list.

---

## 🏃‍♀️ Running the Service

### Local (Node)
```bash
npm run start:dev             # watch mode
npm run start:prod            # transpiled dist
```

### Docker
```bash
docker build -t paypalsphere/accounts-service:latest .
docker run --env-file .env -p 4000:4000 paypalsphere/accounts-service
```

### Kubernetes (ArgoCD)
Helm chart lives in `deploy/helm/accounts-service`.

```bash
helm upgrade --install accounts-service ./deploy/helm/accounts-service \
  --values ./deploy/helm/values/local.yaml
```

---

## 📖 API Reference

### `POST /v1/accounts`
Creates a new logical account along with an empty wallet.

Request body (JSON):
```jsonc
{
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@paypalsphere.dev",
  "country": "GB"
}
```

Successful response (201):
```jsonc
{
  "accountId": "acc_94de4e9d",
  "status": "PENDING_KYC",
  "createdAt": "2023-10-25T12:34:56.789Z"
}
```

### `GET /v1/accounts/:id`
Fetch the latest *read model* projection.

### `PATCH /v1/accounts/:id`
Supports partial update of non-PII profile attributes.

### Error Contract
```jsonc
{
  "statusCode": 422,
  "error": "Unprocessable Entity",
  "message": [
    {
      "field": "email",
      "constraint": "isEmail"
    }
  ],
  "timestamp": "2023-10-25T12:34:56.789Z",
  "requestId": "req_01h47h1p9s2"
}
```

> All endpoints are documented via **OpenAPI 3** (`/docs` Swagger UI).

---

## 📦 Domain Events

| Event name                    | Channel         | Schema ID                    | Description                               |
| ----------------------------- | --------------- | ---------------------------- | ----------------------------------------- |
| `AccountCreated`              | `accounts.out`  | `v1.AccountCreated`          | Fired after successful validation         |
| `KycRequested`                | `kyc.in`        | `v1.KycRequested`            | Triggered once account reaches threshold  |
| `AccountStatusChanged`        | `accounts.out`  | `v1.AccountStatusChanged`    | When status transitions (e.g. ACTIVE)     |
| `AccountClosed`               | `accounts.out`  | `v1.AccountClosed`           | Soft-delete + compliance retention window |

```typescript
// src/events/schemas/v1/account-created.schema.ts
export interface AccountCreated {
  accountId: string;
  emailHash: string;          // SHA-256(hex) of canonical email
  country: string;
  createdAt: string;          // ISO-8601
}
```

---

## 🧪 Testing

```bash
# unit tests (Jest)
npm run test

# e2e contract tests
npm run test:e2e

# coverage
npm run test:cov
```

CI gate requires `>= 95 %` statements coverage.

---

## 📊 Observability

* **Winston** structured logging (JSON) → Loki  
* **OpenTelemetry** traces (HTTP + Kafka) → Tempo  
* **Prometheus** metrics via `/metrics` (NestJS Prom middleware)  
* Health checks at `/health` comply with CNCF **/healthz** spec

---

## 🛡️ Security Considerations
1. Secrets are injected at runtime via Vault Agent sidecar; never committed.  
2. PII fields (`firstName`, `lastName`, `dateOfBirth`, `ssn`) are AES-256-GCM encrypted _at rest_.  
3. All commands undergo Keep-It-Clean validation & **OWASP** sanitization.  
4. Rate limiting & **HMAC** signed requests for internal service-to-service calls.  
5. Fine-grained **CASL** based authorization backed by **OPA** policies.

---

## 📌 Example: Consuming the API

```javascript
import axios from 'axios';

const client = axios.create({
  baseURL: process.env.ACCOUNTS_URL ?? 'http://localhost:4000/v1',
  timeout: 5_000,
});

/**
 * Create a new account and poll until ACTIVE
 */
export async function onboardUser(payload) {
  try {
    const { data } = await client.post('/accounts', payload);

    // Poll status
    while (true) {
      const res = await client.get(`/accounts/${data.accountId}`);
      if (res.data.status === 'ACTIVE') return res.data;
      await new Promise(r => setTimeout(r, 2_000));
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error('Onboarding failed', err.response?.data ?? err.message);
    }
    throw err;
  }
}
```

---

## 🤝 Contributing
1. Fork → Feature Branch → PR.  
2. Commit messages follow **Conventional Commits** (`feat:`, `fix:`, `chore:`…).  
3. All PRs must pass lint (`npm run lint`), tests, coverage, and **commit-lint**.

---

## 📝 License
`Apache-2.0 © PayPalsphere Contributors`

---

### Changelog
See [CHANGELOG.md](CHANGELOG.md) for semantic versioned releases.
```