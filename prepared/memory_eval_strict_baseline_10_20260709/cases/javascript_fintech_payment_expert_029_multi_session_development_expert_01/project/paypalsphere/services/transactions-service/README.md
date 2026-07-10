```markdown
# `@paypalsphere/transactions-service`

The **Transactions Service** is the source-of-truth for all monetary movements in the PayPalsphere ecosystem.  
It is responsible for:

1. **Command & Event Handling**  
   – Accepting canonical _Commands_ (`CreateTransaction`, `InitiateSplit`, `SettleDebt`, …)  
   – Emitting strongly-typed _Domain Events_ (`TransactionCreated`, `TransactionAuthorized`, `TransactionSettled`, …)

2. **Orchestration**  
   – Coordinating with the **KYC**, **Risk**, **Compliance**, **FX**, **Wallet**, and **Settlement** services via synchronous (gRPC) and asynchronous (NATS JetStream) channels.  
   – Implementing **Saga** patterns for long-running workflows—e.g. a multi-currency, multi-party group expense.

3. **State Management**  
   – Maintaining an **immutable event store** (PostgreSQL + logical decoding)  
   – Exposing a **CQRS read model** in MongoDB optimized for timeline feeds and reporting dashboards.

4. **Security & Compliance**  
   – Field-level encryption (AES-256-GCM) for PII & PCI-DSS scoped attributes.  
   – Fine-grained **ABAC** (Attribute-Based Access Control) policies enforced via [@paypalsphere/policy-engine](../policy-engine).  
   – Real-time audit log streaming to **AWS S3 Glacier**.

---

## Table of Contents
- [Getting Started](#getting-started)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Command & Event Schema](#command--event-schema)
- [RESTful Gateway](#restful-gateway)
- [Saga Flows](#saga-flows)
- [Testing](#testing)
- [Production Checklist](#production-checklist)
- [Contributing](#contributing)
- [License](#license)

---

## Getting Started

```bash
# monorepo root
pnpm i

# build protobuf definitions shared across services
pnpm proto:build

# start the transactions service & dependencies
cd services/transactions-service
pnpm dev
```

> The service spins up with live-reloading (via `ts-node-dev`) and attaches to the shared
> local NATS JetStream, PostgreSQL, and MongoDB containers orchestrated by `docker-compose`.

---

## Local Development

### Docker-Compose
```bash
docker compose -f ./infra/docker-compose.yml up -d
```

Services
- `nats` (JetStream enabled)
- `postgres` (logical decoding ON)
- `mongodb`
- `vault` (for envelopes / DEKs)
- `localstack` (S3 Glacier emulation)

### Useful Scripts
```bash
# services/transactions-service

pnpm lint              # eslint + prettier
pnpm test:unit         # vitest + instanbul
pnpm test:e2e          # pact + supertest + docker compose
pnpm db:migrate        # drizzle-kit migrations for event store
pnpm db:seed           # seeds demo data
pnpm proto:gen         # regenerate gRPC ts bindings
```

---

## Environment Variables

| Name | Description | Example |
| ---- | ----------- | ------- |
| `NODE_ENV` | runtime env | `development` |
| `PORT` | REST gateway port | `7104` |
| `GRPC_PORT` | gRPC service port | `7105` |
| `NATS_URL` | JetStream connection | `nats://localhost:4222` |
| `PG_CONN` | Event Store DSN | `postgres://pp_dev:secret@localhost:5432/pp_transactions` |
| `MONGO_URI` | Read model DSN | `mongodb://localhost:27017/pp_transactions_read` |
| `VAULT_ADDR` | HashiCorp Vault | `http://localhost:8200` |
| `VAULT_TOKEN` | Vault token | `root` |
| `JWT_PUBLIC_KEY` | JWK for ABAC | _multi-line base64_ |
| `SERVICE_NAME` | Service Identifier | `transactions-service` |

> Use `.env.sample` as a template.

---

## Command & Event Schema

All messages follow the [AsyncAPI 2.6.0](https://www.asyncapi.com/) spec defined under `./asyncapi/transactions.yaml`.

### Example — `CreateTransaction` Command
```jsonc
{
  "id": "cmd-013e7d36",
  "type": "CreateTransaction",
  "timestamp": 1687600123456,
  "actor": {
    "userId": "usr_98ab31",
    "circleId": "crc_12f09c"
  },
  "payload": {
    "amount": { "value": "42.50", "currency": "EUR" },
    "memo": "Dinner at La Capannina",
    "participants": [
      { "userId": "usr_98ab31", "share": "21.25" },
      { "userId": "usr_22dd76", "share": "21.25" }
    ],
    "privacy": "friends"
  },
  "meta": {
    "traceId": "2182d5b8-e306-4f55-aa62-2e9d9f15844e"
  }
}
```

### Outgoing — `TransactionAuthorized` Event
```jsonc
{
  "id": "evt-fd88344c",
  "correlationId": "cmd-013e7d36",
  "type": "TransactionAuthorized",
  "timestamp": 1687600127481,
  "payload": {
    "transactionId": "txn_4bce726c",
    "status": "AUTHORIZED"
  }
}
```

---

## RESTful Gateway

Although internal components interact over gRPC & NATS, a BFF (GraphQL) consumes an HTTP façade for mobile clients.

```
POST   /v1/transactions                    – create new transaction
GET    /v1/transactions/:transactionId     – fetch single transaction (read model)
GET    /v1/circles/:circleId/ledger        – paginated ledger for circle
POST   /v1/transactions/:id/settle         – trigger settlement
GET    /v1/health                          – liveness / readiness
```

Sample cURL:
```bash
curl -X POST http://localhost:7104/v1/transactions \
  -H "Authorization: Bearer $MOBILE_JWT" \
  -H "Content-Type: application/json" \
  -d '{
        "amount": { "value": "9.99", "currency": "USD" },
        "memo": "Spotify Family",
        "participants": [
            { "userId": "usr_1", "share": "3.33" },
            { "userId": "usr_2", "share": "3.33" },
            { "userId": "usr_3", "share": "3.33" }
        ],
        "privacy": "private"
      }'
```

---

## Saga Flows

### Group Expense Authorization (Happy Path)

```mermaid
sequenceDiagram
    participant Mobile
    participant REST
    participant TX_CMD as Transactions CMD-Handler
    participant KYC
    participant RISK
    participant FX
    participant WALLET
    participant AUDIT

    Mobile->>REST: POST /transactions
    REST->>TX_CMD: CreateTransaction
    TX_CMD->>KYC: VerifyParties
    KYC-->>TX_CMD: KYCVerified
    TX_CMD->>RISK: AssessTransaction
    RISK-->>TX_CMD: RiskScore<50
    TX_CMD->>FX: LockRate (if multi-currency)
    FX-->>TX_CMD: RateLocked
    TX_CMD->>WALLET: AuthorizeHold
    WALLET-->>TX_CMD: HoldAuthorized
    TX_CMD->>AUDIT: TransactionAuthorized
    TX_CMD-->>REST: 201 CREATED
```

Failure compensation steps are modeled in the `saga/compensation.spec.ts`.

---

## Testing

```bash
# Unit tests
pnpm test:unit

# End-to-End contract tests (Pact)
pnpm test:e2e
```

Coverage threshold: **90 %** lines / branches.

---

## Production Checklist

- [x] Zero-downtime rollout via **Kubernetes blue/green**.  
- [x] **Vault** auto-unseal & lease renewal for encryption keys.  
- [x] **mTLS** enforced on all gRPC channels (`SPIFFE` IDs).  
- [x] **OPA** sidecar for dynamic ABAC policy evaluation.  
- [x] **Prometheus** metrics and **OpenTelemetry** traces exported to **AWS X-Ray**.  
- [x] **PDB** (Pod Disruption Budget) + **HPA** tuned from load tests.  
- [x] GDPR/CCPA data subject deletion via **cryptographic erasure** (DEK rotation).

---

## Contributing

1. Fork & branch (`git checkout -b feat/my-enhancement`)
2. Commit using **Conventional Commits**.
3. Run `pnpm test:unit && pnpm lint`.
4. Open a PR against `dev` with a clear description & screenshots/diagrams where appropriate.
5. One Core Maintainer + one Domain SME approval required.

---

## License

Apache-2.0 © PayPalsphere Contributors
```