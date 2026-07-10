```markdown
# 🛎️ PayPalsphere – Notification Service

The **Notification Service** is a stateless, event-driven micro-service responsible for delivering real-time messages (push, e-mail, SMS, in-app) to PayPalsphere users, circles, and external webhooks.  
It is designed to be **horizontally scalable**, **pluggable**, and **event-sourced** so that every notification can be audited, re-played, or **GDPR-deleted** on demand.

---

## 📜 Table of Contents
1. [Key Responsibilities](#key-responsibilities)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Event Contracts](#event-contracts)
5. [Public REST API](#public-rest-api)
6. [Quick Start](#quick-start)
7. [Configuration](#configuration)
8. [Local Development](#local-development)
9. [Testing](#testing)
10. [Observability](#observability)
11. [Security](#security)
12. [Extending the Service](#extending-the-service)
13. [Contributing](#contributing)
14. [License](#license)

---

## Key Responsibilities

- Subscribe to **Domain Events** (Kafka) from bounded contexts (KYC, Payments, Risk, Settlement, Social Graph).
- Persist notification `Intent` and `DeliveryAttempt` events via **Event Sourcing** (PostgreSQL + Kafka).
- Enforce **Security-by-Design** principles (encryption, RBAC scopes, tenant isolation).
- Fan-out messages through registered **channels** (FCM, APNS, SMTP, Twilio, WebSocket gateway).
- Provide an **idempotent REST API** for on-demand notifications (admin panels, automated tooling).
- Stream **delivery metrics** and **audit logs** to the central **Audit Trail Service**.

---

## Tech Stack

| Layer              | Technology                           |
| ------------------ | ------------------------------------ |
| Runtime            | Node.js 18 + TypeScript 5            |
| Frameworks         | Fastify, Zod, KafkaJS                |
| Event Store        | PostgreSQL (`notification_events`)   |
| Messaging Bus      | Apache Kafka (`notification` topic)  |
| Channels           | Firebase (FCM), Apple (APNS), SMTP, Twilio, WebSocket Gateway |
| Observability      | OpenTelemetry, Prometheus, Grafana   |
| Security           | JOSE (JWS/JWE), AWS KMS, OPA (OPA-JS)|
| Testing            | Vitest, Testcontainers, Nock         |

---

## Architecture

```mermaid
flowchart TD
    A[Domain Event<br />(e.g. PaymentSettled)] -- Kafka --> B(Notifier<br/>Consumer)
    B --> C[Command<br/>"SendNotification"]
    C --> D{Event Store<br/>PostgreSQL}
    D -->|Append| E[NotificationIntent]
    E --> F[Channel Fan-out<br/>Workers]
    F --> G[(FCM)]
    F --> H[(APNS)]
    F --> I[(SMTP)]
    F --> J[(Twilio)]
    F --> K[(WebSocket)]
    F --> L[(3rd-party Webhook)]
    G & H & I & J & K & L --> M[DeliveryAttempt Events]
    M --> D
    M --> N>Audit Trail<br/>Service]
```

At-least-once semantics are guaranteed via Kafka offsets and event sourcing; **idempotency keys** prevent duplicates.

---

## Event Contracts

All contracts are versioned using **Avro** (subject = `notification.<name>.v<major>`).

### `NotificationIntent`

```json
{
  "type": "record",
  "name": "NotificationIntent",
  "namespace": "notification.v1",
  "fields": [
    { "name": "intentId", "type": "string" },
    { "name": "triggerEvent", "type": "string" },
    { "name": "recipientIds", "type": { "type": "array", "items": "string" } },
    { "name": "channel", "type": ["null", "string"], "default": null },
    { "name": "payload", "type": "string" },
    { "name": "createdAt", "type": { "type": "long", "logicalType": "timestamp-millis" } }
  ]
}
```

### `DeliveryAttempt`

```json
{
  "type": "record",
  "name": "DeliveryAttempt",
  "namespace": "notification.v1",
  "fields": [
    { "name": "intentId", "type": "string" },
    { "name": "attemptId", "type": "string" },
    { "name": "channel", "type": "string" },
    { "name": "status", "type": { "type": "enum", "name": "Status", "symbols": ["PENDING", "SENT", "FAILED"] } },
    { "name": "failureReason", "type": ["null", "string"], "default": null },
    { "name": "attemptedAt", "type": { "type": "long", "logicalType": "timestamp-millis" } }
  ]
}
```

---

## Public REST API

> All endpoints are scoped under `/api/v1/notifications`.  
> Requires either a **JWT** with `notifications:write` scope or an **HMAC** signature header for service-to-service calls.

| Method | Path                            | Description                         |
| ------ | ------------------------------ | ----------------------------------- |
| POST   | `/`                            | Create & dispatch a notification    |
| GET    | `/intent/:intentId`            | Retrieve intent + delivery attempts |
| POST   | `/webhook/register`            | Register an outbound webhook        |
| DELETE | `/webhook/:webhookId`          | Deregister webhook                  |

Example request:

```bash
curl -X POST https://notif.paypalsphere.io/api/v1/notifications \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "recipientIds": ["user_123", "user_456"],
        "template": "CIRCLE_EXPENSE_SETTLED",
        "variables": { "circleName": "Italy Trip" },
        "channel": "PUSH"
      }'
```

---

## Quick Start

```bash
# 1. Clone
git clone git@github.com:paypalsphere/notification-service.git
cd notification-service

# 2. Bootstrap
pnpm install # ⬅ uses .npmrc with internal registry

# 3. Start required infrastructure (Kafka, Postgres, MailHog, LocalStack)
pnpm dev:infra   # => docker compose up -d

# 4. Run the service
pnpm dev         # => ts-node src/index.ts
```

A Swagger UI will be available at `http://localhost:4004/docs`.

---

## Configuration

| Variable                   | Default            | Description                                   |
| -------------------------- | ------------------ | --------------------------------------------- |
| `PORT`                     | `4004`             | HTTP port                                     |
| `KAFKA_BROKERS`            | `localhost:9092`   | Comma-separated broker list                   |
| `PG_CONN`                  | `postgres://…`     | Event store connection URI                    |
| `FCM_KEY`                  | –                  | Firebase Cloud Messaging key                  |
| `APNS_CERT`                | –                  | Apple Push certificate (base64)               |
| `SMTP_URI`                 | `smtp://localhost`| Mail server URI (for dev: MailHog)            |
| `TWILIO_SID/SECRET`        | –                  | Twilio credentials                            |
| `OPA_POLICY_BUNDLE_URL`    | –                  | URL to signed OPA bundle                      |
| `LOG_LEVEL`                | `info`             | pino log level                                |
| `OTEL_EXPORTER_OTLP_URL`   | `http://localhost:4318` | OTEL collector                               |

Secrets should be managed via **AWS Secrets Manager** or **Vault** in production; never commit them to VCS.

---

## Local Development

1. Start infra with `pnpm dev:infra`.
2. Run consumer and API with `pnpm dev`.
3. Produce sample event:

   ```bash
   node scripts/publish-demo-event.js PaymentSettled
   ```

4. Open Grafana at `http://localhost:3000` (user/pass: admin/admin). Dashboard: `Notification – Delivery`.

Hot-reloading is enabled via `ts-node-dev`.

---

## Testing

```bash
# Unit + integration (+ coverage)
pnpm test

# E2E – spins up ephemeral Docker infra via Testcontainers
pnpm test:e2e
```

Coverage **>= 90 %** is required by CI; otherwise the build fails.

---

## Observability

- **Logs**: JSON Pino logs shipped to AWS CloudWatch → Loki.
- **Metrics**: Prometheus `@opentelemetry/metrics` export (e.g. `notification_delivery_duration_seconds`).
- **Traces**: OTLP gRPC to Tempo (span = `SendNotificationSaga`).

Alerts are defined in `./infrastructure/alerting/notification_alerts.yml`.

---

## Security

1. **Encryption at Rest**: Event payloads are encrypted with **AES-256-GCM** keys managed by **AWS KMS**.
2. **Field-level Encryption**: PII such as e-mail/phone is individually encrypted before persistence.
3. **OPA Policies**: Access to `/api/*` routed through OPA sidecar; RBAC enforced at **claim** level.
4. **Rate Limiting**: Leaky-bucket (Redis) with per-tenant and global caps.
5. **Idempotency**: `Idempotency-Key` header is mandatory for POST `/` in public API.

---

## Extending the Service

1. Add a new **channel adapter** under `src/adapters/<channel-name>.ts` implementing the `NotificationChannel` interface:

   ```ts
   export interface NotificationChannel {
     name: Channel;
     send(payload: ChannelPayload): Promise<DeliveryReceipt>;
   }
   ```

2. Register the adapter in `src/bootstrap/channelRegistry.ts`.
3. Write unit tests + contract tests (`contract-tests/<channel-name>.spec.ts`).
4. Update **Swagger** and **Avro** schemas if API changes.
5. Submit a PR → automated CI (lint, type-check, tests, SonarQube, OPA validation).

---

## Contributing

We follow the **GitHub Flow** with **Conventional Commits**.

```bash
git checkout -b feat/signal-template-editor
pnpm cz           # commit with commitizen
git push -u origin feat/signal-template-editor
```

Open a PR; maintainers will review within 24 h.

---

## License

Distributed under the **MIT License**.  
© 2024 PayPalsphere Contributors
```