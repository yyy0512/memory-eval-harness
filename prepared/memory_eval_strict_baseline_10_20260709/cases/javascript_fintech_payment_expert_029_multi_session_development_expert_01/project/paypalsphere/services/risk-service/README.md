```markdown
# PayPalsphere ▸ Risk Service

The **Risk Service** is the real-time fraud detection and risk-scoring engine for the PayPalsphere ecosystem.  
It consumes domain events emitted from bounded contexts such as `transactions`, `kyc`, `accounts`, and `social-graph` to build a multi-dimensional risk profile for every user, circle, and transaction in the system.  

Key responsibilities:

| Responsibility                        | Pattern / Tech | Source / Sink                                |
|--------------------------------------|---------------|----------------------------------------------|
| Risk scoring & fraud screening       | Event Sourcing, CQRS | Kafka topics: `transaction.created`, `kyc.verified`, `circle.activity.*` |
| Dynamic rules evaluation & ML models | Node.js (TypeScript), TensorFlow.js | Redis, S3 for feature cache & model storage |
| Regulatory checks (AML, Sanctions)   | Saga Pattern  | Down-stream command → `compliance-service` |
| Decision streaming & audit trail     | Outbox Pattern | Kafka topic: `risk.decision`; Cold storage (S3) |

---

## ℹ️  Service Summary

|               |                                              |
|---------------|----------------------------------------------|
| Language      | Node.js 18.x (TypeScript)                    |
| Build Tool    | pnpm ^8                                      |
| Runtime       | Docker + Kubernetes (Helm chart provided)    |
| DB / Cache    | PostgreSQL (event store), Redis (feature cache) |
| Messaging     | Apache Kafka                                 |
| Observability | OpenTelemetry, Prometheus, Grafana dashboard |
| Security      | Envelope encryption (AWS KMS), mTLS, OPA     |

---

## 🏗  Local Development

```bash
# 1⃣  Install dependencies
pnpm i

# 2⃣  Bring up local stack (Postgres, Redis, Kafka, etc.)
docker compose -f docker-compose.local.yml up -d

# 3⃣  Compile TypeScript & start service with hot-reload
pnpm dev
```

Environment variables required (`.env` file):

```dotenv
# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=pp-risk-svc-local

# Postgres
PG_HOST=localhost
PG_PORT=5432
PG_DB=risk_service
PG_USER=postgres
PG_PASSWORD=postgres

# Redis
REDIS_URL=redis://localhost:6379

# Models
MODEL_BUCKET=pp-risk-models
MODEL_REFRESH_CRON=0 */1 * * *  # refresh hourly

# Misc
NODE_ENV=development
SERVICE_PORT=7004
```

---

## 🛰  Event Contracts

### Inbound

| Topic                    | Event Name              | Version | Description                             |
|--------------------------|-------------------------|---------|-----------------------------------------|
| `transaction.created`    | `TransactionCreated`    | v1      | Emitted after a new transaction intent  |
| `kyc.verified`           | `KycVerified`           | v1      | Emits when KYC passes                   |
| `circle.activity.member` | `CircleMemberActivity`  | v1      | Social signals from circles             |

All inbound events adhere to the shared [Event Envelope](../_shared/README.md#event-envelope) contract.

### Outbound

| Topic              | Event Name           | Version | Consumer(s)                  |
|--------------------|----------------------|---------|------------------------------|
| `risk.decision`    | `RiskDecisionMade`   | v1      | `compliance-service`, `transactions-service` |
| `risk.recalculate` | `RiskRecalculateCmd` | v1      | Self (saga continuation)     |

---

## 🧩  High-Level Architecture

```ascii
                       ┌─────────────┐   Kafka    ┌─────────────────┐
                       │  KYC Svc    │───────────▶│  Risk Svc       │
                       └─────────────┘            │                 │
              ┌──────────────────┐                │  Rules Engine   │
   Users ────▶│ Transaction Svc  │──── Kafka ────▶│  ML Scorer      │
              └──────────────────┘                │  Sanctions API  │
                       ▲                          │  Saga Manager   │
                       │ risk.decision            └──────┬──────────┘
                       │                              Outbox
                       ▼
            ┌──────────────────┐
            │ Compliance Svc   │
            └──────────────────┘
```

---

## 🔑  Core Concepts

1. **Incremental Feature Store**  
   All signals are transformed into reusable _features_ stored in Redis with TTLs.  
   Example: `user:42:tx_volume_24h`, `circle:7:chargeback_ratio_30d`.

2. **Pluggable Rule DSL**  
   YAML-based rule sets allow fraud analysts to hot-swap conditions without code redeploys.

3. **ML Scorer Pipeline**  
   TensorFlow.js models are loaded from S3 on boot & hot-reloaded hourly via CRON.

4. **Risk Decision**  
   Each decision includes a reason tree:
   ```jsonc
   {
     "score": 782,
     "decision": "FLAGGED_FOR_REVIEW",
     "rules": [
       { "id": "AML_001", "result": true },
       { "id": "SOCIAL_ANOMALY_SCORE", "value": 0.91 }
     ]
   }
   ```

---

## 🧪  Test Suite

```bash
# Entire suite (unit + integration)
pnpm test

# Watch mode
pnpm test -- --watch
```

Technologies:  
• Jest + ts-jest for unit tests  
• TestContainers for disposable Kafka / Postgres containers  
• nyc (Istanbul) for coverage reports  

---

## ⚙️  Example: Publishing a Transaction for Scoring

```ts
import { Kafka } from 'kafkajs';
import { v4 as uuid } from 'uuid';
import { signEnvelope } from '@paypalsphere/sdk-signature';

const kafka = new Kafka({ brokers: ['localhost:9092'], clientId: 'example-producer' });
const producer = kafka.producer();

(async () => {
  await producer.connect();

  const envelope = signEnvelope({
    id: uuid(),
    type: 'TransactionCreated',
    specversion: '1.0',
    service: 'transaction-service',
    timestamp: new Date().toISOString(),
    data: {
      transactionId: uuid(),
      amount: 152.35,
      currency: 'USD',
      senderId: 42,
      receiverId: 99,
      circleId: 7
    }
  });

  await producer.send({
    topic: 'transaction.created',
    messages: [{ key: envelope.data.transactionId, value: JSON.stringify(envelope) }]
  });

  console.log('Transaction event sent for risk assessment 🚀');
})();
```

---

## 🛡  Security Notes

• All PII is field-level encrypted using the platform-wide AES-256 + KMS envelope scheme.  
• Service-to-service communication is secured via mTLS (SPIFFE identities).  
• Open Policy Agent (OPA) side-car enforces dynamic RBAC for any debug / admin endpoints.  

---

## 🗺  Folder Structure (excerpt)

```
risk-service
├── src
│   ├── app.ts          # Express HTTP + GRPC bootstrap
│   ├── handlers
│   │   ├── transaction.created.handler.ts
│   │   └── kyc.verified.handler.ts
│   ├── rules
│   │   ├── dsl          # YAML rulesets
│   │   └── engine.ts
│   ├── models          # ML models loader
│   ├── sagas           # Saga orchestrations
│   └── ...
├── test                # Jest tests
├── Dockerfile
├── helm
│   └── risk-service
└── README.md           # ← You are here
```

---

## 📈  Observability

Metric examples (Prometheus):

| Metric Name                | Type   | Labels                       |
|----------------------------|--------|------------------------------|
| `risk_events_consumed`     | Counter| topic, partition             |
| `risk_score_duration_ms`   | Histogram | model, decision           |
| `risk_decision_total`      | Counter| decision_type                |

Logs are shipped via Fluent Bit to the centralized Grafana Loki stack.  
Traces use OpenTelemetry OTLP exporter → Tempo.

---

## 🚀  Deployment

CI/CD (GitHub Actions):

1. Type-check, lint, test  
2. Build Docker image & push to GHCR  
3. Helm upgrade on `dev` namespace → Canary  
4. After 95% SLO for 30m, promote to `prod`  

Rollback is automated by Helm + ArgoCD health checks.

---

## 🤝  Contributing

1. Fork & clone repo
2. Create feature branch
3. Ensure `pnpm test` passes & coverage ≥ 85%
4. Open PR, fill template. 🍀

---

© 2024 PayPalsphere, Inc. All rights reserved.
```