```markdown
# Settlement Service – PayPalsphere

> Micro-service responsible for orchestrating and executing multi-party settlements inside a **Circle**.  
> Implements **CQRS** + **Event Sourcing**, is **PCI-DSS** compliant, and uses the **Saga Pattern** to coordinate long-running social payments.

---

## ✨ Responsibilities

1. Receive _settlement instructions_ originating from:
   - Split expense finalisation  
   - Group fund disbursement  
   - Circle-to-circle transfers
2. Validate regulatory & risk constraints in real-time (KYC, AML, Sanctions, Velocity).
3. Convert currency and calculate network fees transparently.
4. Persist intent events (`SettlementRequested`, `SettlementAccepted`, …).
5. Trigger downstream clearing & posting into the **Ledger Service**.
6. Emit audit logs and user-facing notifications.

---

## 🗂️ Folder Structure (excerpt)

```
settlement-service
├── src
│   ├── application     # Commands, queries, DTOs
│   ├── domain          # Aggregates, value objects, domain exceptions
│   ├── infrastructure  # Adapters (DB, message bus, encryption)
│   ├── presentation    # REST + gRPC controllers
│   └── saga            # Coordinators & compensating actions
├── tests               # Unit & contract tests
├── docker
│   └── docker-compose.yml
└── README.md
```

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for coding standards.

---

## ⚙️ Tech Stack

| Layer            | Technology                       |
| ---------------- | -------------------------------- |
| Runtime          | Node.js 20 LTS (TypeScript)      |
| Framework        | Fastify 4.x + Zod validation     |
| Data Storage     | PostgreSQL 15 (event store)      |
| Message Broker   | RabbitMQ 3.x (AMQP 0-9-1)        |
| Observability    | OpenTelemetry + Grafana Loki     |
| Secrets & Keys   | Hashicorp Vault                  |
| CI / CD          | GitHub Actions + ArgoCD          |

---

## 🏗️ Architecture Deep Dive

### 1. Event Sourcing & CQRS

```
/* simplified flow */

Client → POST /settlements
        → CommandBus.dispatch(SettlementRequestCommand)
        → Domain validations
        → EventStore.append(SettlementRequested)
        → Saga kicks-off
```

**Read models** (_denormalised views_) are updated asynchronously via projectors consuming the exact same event stream.

### 2. Saga Pattern

| Step | Event / Action                   | Owner                 |
| ---- | -------------------------------- | --------------------- |
| 1    | `SettlementRequested`            | Settlement Service    |
| 2    | `kyc.verify` request             | KYC Service           |
| 3    | `risk.score` request             | Risk Service          |
| 4    | `SettlementAccepted` or `Rejected` | Settlement Service    |
| 5    | `ledger.post`                    | Ledger Service        |
| 6    | `SettlementExecuted`             | Settlement Service    |
| 7    | `NotifyCircle`                   | Notification Service  |

Compensating actions are defined for every step (e.g., `RevertLedgerPosting`).

---

## 🔐 Security

- End-to-end field-level AES-GCM encryption using Vault-managed keys.
- JWT access tokens + mTLS between micro-services.
- Real-time sanctions screening & transaction velocity checks.
- GDPR compliant data minimisation & right-to-erasure helpers.

---

## 📑 API Reference

### POST /v1/settlements

Initiate a new group settlement.

```
curl -X POST https://api.paypalsphere.io/v1/settlements \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
        "circleId": "c123",
        "currency": "EUR",
        "participants": [
          { "memberId": "u1", "amount": "22.50" },
          { "memberId": "u2", "amount": "22.50" }
        ],
        "memo": "Dinner at La Pergola"
      }'
```

Responses

| Code | Description                |
| ---- | -------------------------- |
| 202  | Settlement accepted async. |
| 400  | Validation error.          |
| 409  | Duplicate request.         |
| 422  | Risk / compliance blocked. |

### GET /v1/settlements/{id}

Returns current status + timeline of domain events.

---

## 📤 Domain Events

```ts
// src/domain/events.ts

export interface SettlementRequested {
  id: string;            // ULID
  circleId: string;
  currency: ISO4217;
  totalAmount: string;   // DECIMAL(19,4)
  requestedBy: string;   // user id
  timestamp: ISO8601;
  participants: Array<{
    memberId: string;
    amount: string;
  }>;
  meta?: Record<string, any>; // e.g., social tags
}

export interface SettlementExecuted {
  id: string;
  ledgerTxId: string;
  executedAt: ISO8601;
}

export type SettlementEvent =
  | { type: 'SettlementRequested'; data: SettlementRequested }
  | { type: 'SettlementExecuted'; data: SettlementExecuted }
  | { type: 'SettlementFailed'; data: { id: string; reason: string } };
```

Event messages are signed (`JSON Web Signature`) and published to `exchange=settlement.events`.

---

## 🛠️ Environment Variables

| Name                           | Default        | Description                           |
| ------------------------------ | -------------- | ------------------------------------- |
| `NODE_ENV`                     | `development`  | `production` / `test`                 |
| `PORT`                         | `4008`         | HTTP Port                             |
| `DATABASE_URL`                 | —              | PostgreSQL DSN                        |
| `AMQP_URL`                     | —              | RabbitMQ connection string            |
| `VAULT_ADDR`                   | —              | Vault endpoint                        |
| `O11Y_EXPORTER_OTLP_ENDPOINT`  | —              | OTLP collector                        |
| `JWT_PUBLIC_KEY`               | —              | PEM for verifying incoming tokens     |

Create `.env.local` with the above keys when running locally.

---

## 🚀 Running Locally

Pre-requisites: Docker + Node.js 20

```bash
# 1. Boot local infra
cd docker && docker-compose up -d

# 2. Install deps
pnpm install

# 3. Migrate + seed event store
pnpm db:migrate && pnpm db:seed

# 4. Start service (dev mode with hot reload)
pnpm start:dev
```

Service should now be reachable at `http://localhost:4008/v1/health`.

---

## 🧪 Tests

```
# Unit & domain tests
pnpm test

# Contract tests with Pact
pnpm test:contract
```

Coverage thresholds: **85 % statements / 90 % critical paths**.

---

## 📈 Observability

- **Metrics**: `settlement_duration_seconds`, `settlement_failure_total`.
- **Logs**: structured JSON (Pino) shipped to Grafana Loki.
- **Tracing**: W3C Trace Context. View in Jaeger.

---

## 🔄 CI/CD

1. PR triggers:
   - Lint + Unit tests  
   - Static security scan (Semgrep, npm audit)
2. Merge to `main`:
   - Build Docker image  
   - Run integration tests on ephemeral environment  
   - Tag + push to GHCR (`ghcr.io/paypalsphere/settlement-service:<sha>`)
3. ArgoCD deploys to Kubernetes (blue/green).

---

## 🆘 Troubleshooting

| Symptom                    | Possible Cause                    | Quick Fix                                |
| -------------------------- | --------------------------------- | ---------------------------------------- |
| `422 UNPROCESSABLE ENTITY` | Risk engine flagged transaction   | Check Risk Service logs, override via UI |
| Stuck in `PENDING` state   | Downstream ledger timeout         | Verify `ledger.*` queue backlog          |
| `503 Service Unavailable`  | Database connection exhaustion    | Tune `PG_MAX_CONNECTIONS`                |

---

## 🤝 Contributing

1. Fork & create a feature branch.  
2. Run `pnpm lint:fix` before committing.  
3. Submit a pull request describing your change and related ticket.

---

## 🗒️ Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

---

© PayPalsphere – All rights reserved.  
This project is licensed under the `BUSL-1.1` license.
```