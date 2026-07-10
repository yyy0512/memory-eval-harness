```markdown
# 🛂 PayPalsphere – KYC Service

> Status: **Stable – Production**  
> Service Name: `@paypalsphere/kyc-service`  
> Tech Stack: **Node.js 20**, **TypeScript 5.x**, **Fastify**, **KafkaJS**, **PostgreSQL (Timescale)**, **Redis**  
> Bounded Context: **KYC** (Know-Your-Customer)

The **KYC Service** is the authoritative source of identity verification for the PayPalsphere ecosystem.  
It orchestrates user onboarding, document verification, sanctions screening, and continuous monitoring, exposing a REST/GraphQL API, an **Events** stream (Kafka), and an **internal command bus** (CQRS).

---

## ✨ Key Capabilities

| Capability                   | Description                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Document Verification        | Integrates with SumSub and Onfido to validate IDs, passports, selfies, etc.    |
| Sanctions & PEP Screening    | Realtime checks against OFAC, EU, UN, and Politically Exposed Persons lists.   |
| Continuous Monitoring        | Scheduled re-screening and adverse-media detection, streamed as domain events. |
| Field-Level Encryption       | Personally identifiable information (PII) is encrypted with per-tenant keys.   |
| Audit Trail & Replay         | Every command & event persisted as an immutable record in the Event Store.     |
| Fine-Grained Access Control  | Role-Based Access + ABAC tags, validated by policy engine (`@authzed/spicedb`).|
| SLA-Aware Webhooks           | External partners can subscribe to verification outcomes with signed payloads. |

---

## 🔧 Running Locally

```bash
pnpm i          # Installs dependencies
cp .env.sample .env
pnpm dev        # Starts Fastify REST API on http://localhost:7001
```

`.env.sample` highlights critical variables:

```dotenv
POSTGRES_URL=postgres://kyc_user:kyc_pass@localhost:5432/kyc
REDIS_URL=redis://localhost:6379/0
KAFKA_BROKERS=localhost:9092
ENCRYPTION_MASTER_KEY=base64:RSOtKzU+YHd0...
ONFIDO_TOKEN=***
SUMSUB_SECRET=***
```

---

## 🛠️ Service Architecture

```mermaid
flowchart LR
    subgraph API Layer
        HTTP[Fastify REST + GraphQL]
    end
    subgraph CommandService
        CMD[Command Handler] --> EVS[Event Store (PostgreSQL)]
        EVS --> PROJ[Projection Builder]
    end
    subgraph QueryService
        PROJ --> RDS[(Read DB \n Timescale/Redis)]
    end
    HTTP --> CMD
    RDS --> HTTP
    CMD -- "→ KAFKA" --> BROKER[(Kafka Topic: kyc.events)]
    BROKER --> Other[Risk, Compliance, Settlement, Social]
```

---

## 📑 Domain-Driven Design

### Commands

| Command                          | Payload (Key)              | Responsibility                               |
| -------------------------------- | -------------------------- | -------------------------------------------- |
| `CreateKycProfileCommand`        | `userId`, `legalName`      | Initialises a KYC profile after sign-up.     |
| `SubmitDocumentCommand`          | `profileId`, `document`    | Persists & submits doc to external vendors.  |
| `RefreshScreeningCommand`        | `profileId`                | Triggers scheduled re-screening checks.      |
| `UpdateKycStatusCommand`         | `profileId`, `newStatus`   | Sets KYC status (approved / rejected / hold) |

### Events

| Event                              | When Emitted                                 |
| ---------------------------------- | -------------------------------------------- |
| `KycProfileCreatedEvent`           | Profile persisted.                           |
| `DocumentVerificationStartedEvent` | Document forwarded to 3rd-party provider.    |
| `DocumentVerifiedEvent`            | Document verification passed.                |
| `KycStatusChangedEvent`            | Status transitions to **APPROVED** / etc.    |
| `ScreeningRefreshedEvent`          | Post scheduled sanctions refresh.            |

---

## 📡 Public REST API

```http
POST /v1/kyc                         # Create a new KYC profile
GET  /v1/kyc/{profileId}             # Fetch profile (masked)
POST /v1/kyc/{profileId}/documents   # Upload identity documents (multipart/form-data)
GET  /v1/kyc/{profileId}/status      # Current verification status
```

### Example: Creating a KYC Profile

```bash
curl -X POST https://api.paypalsphere.com/v1/kyc \
     -H "Authorization: Bearer <user-jwt>" \
     -H "Content-Type: application/json" \
     -d '{"legalName":"Ada Lovelace"}'
```

Expected response:

```jsonc
{
  "profileId": "9f1b1025-ce8d-4353-97d8-82bf5ab1e7c4",
  "status": "PENDING_DOCUMENTS"
}
```

---

## 📝 Integration Example (Node.js)

The following snippet demonstrates how a downstream service can listen for **KYC events** and react to `KycStatusChangedEvent`:

```ts
// risk-service/src/consumers/kycStatusConsumer.ts
import { Kafka, EachMessagePayload } from 'kafkajs';
import { evaluateUserRisk } from '../risk-engine';

const kafka = new Kafka({
  clientId: 'risk-service',
  brokers : process.env.KAFKA_BROKERS!.split(',')
});

const consumer = kafka.consumer({ groupId: 'risk-kyc-consumer' });

async function run() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'kyc.events', fromBeginning: false });

  await consumer.run({
    autoCommit: true,
    eachMessage: async ({ message }: EachMessagePayload) => {
      try {
        const event = JSON.parse(message.value!.toString()) as KycStatusChangedEvent;

        if (event.type !== 'KycStatusChangedEvent') return;

        await evaluateUserRisk(event.payload.profileId, event.payload.newStatus);
        console.info(`Risk recalculated for profile ${event.payload.profileId}`);
      } catch (e) {
        // Ensure failed messages are retried using the DLQ pattern
        console.error('Failed to process KYC event', e);
      }
    }
  });
}

run().catch(console.error);

// Domain contract for type-safety
interface KycStatusChangedEvent {
  id: string;
  type: 'KycStatusChangedEvent';
  payload: {
    profileId: string;
    newStatus: 'APPROVED' | 'REJECTED' | 'ON_HOLD';
    occurredAt: string;
  };
}
```

---

## 🧪 Testing

### Unit Tests

```ts
// kyc-service/tests/unit/createKycProfile.spec.ts
import fastify from 'fastify';
import kycroutes from '../../src/routes/kyc.routes';
import { createTestContext } from '../helpers/context';

describe('POST /v1/kyc', () => {
  const app = fastify().register(kycroutes);
  const ctx = createTestContext(app);

  it('should create a new KYC profile', async () => {
    const res = await ctx.request()
      .post('/v1/kyc')
      .set('Authorization', `Bearer ${ctx.tokens.user}`)
      .send({ legalName: 'Grace Hopper' });

    expect(res.statusCode).toBe(201);
    expect(res.body.status).toBe('PENDING_DOCUMENTS');
  });
});
```

### Contract Tests (Pact)

Contract tests ensure that other bounded contexts receive valid event schemas.

```bash
pnpm pact:verify          # Consumer and provider contract run
```

---

## 🛡️ Security Considerations

1. **PII Encryption**: All passport numbers, SSNs, selfies, and raw documents are encrypted at rest (AES-256-GCM).  
2. **Field-Level Access Policies**: Only the **Compliance Officer** role may request unmasked PII data.  
3. **Rate Limiting**: `/documents` endpoint is throttled (`@fastify/rate-limit`) to mitigate brute-force uploads.  
4. **Audit Logging**: Every API call is logged via [@paypalsphere/audit-streamer] → Cloud-storage bucket (WORM).  

---

## 🚀 Deployment

A typical production deployment uses **Helm** charts:

```yaml
# charts/kyc/values.yaml
image:
  repository: ghcr.io/paypalsphere/kyc-service
  tag: 2.3.1

resources:
  requests:
    cpu: "200m"
    memory: "512Mi"
  limits:
    cpu: "500m"
    memory: "1Gi"

env:
  - name: NODE_ENV
    value: "production"
  - name: KAFKA_BROKERS
    value: "kafka-0.kafka:9092,kafka-1.kafka:9092"
```

---

## 🗄️ Database Schema (Timescale)

```sql
CREATE TABLE kyc_events (
  id          UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  version     INT  NOT NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT create_hypertable('kyc_events', 'occurred_at');
```

---

## 🔄 Event Replay

Replay events to rebuild projections:

```bash
pnpm ts-node scripts/replay.ts --aggregate_id 9f1b1025-ce8d-4353-97d8-82bf5ab1e7c4
```

`scripts/replay.ts` fetches events from `kyc_events` and re-hydrates the in-memory model, emitting them back onto the projection builder—crucial for forensic investigations and **“relive your onboarding”** user stories.

---

## 🤝 Contributing

```bash
git clone git@github.com:PayPalsphere/fintech_payment.git
cd services/kyc-service
pnpm i
pnpm test --watch
```

We welcome pull requests! Please read our [contributing guide](../CONTRIBUTING.md) for code style, commit conventions, and DCO sign-off.

---

## 📝 License

Copyright © PayPalsphere.

Distributed under the **Apache-2.0** license. See `LICENSE` for more information.
```