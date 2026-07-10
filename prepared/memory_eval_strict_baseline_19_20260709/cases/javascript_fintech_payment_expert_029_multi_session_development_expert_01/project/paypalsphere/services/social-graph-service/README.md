```markdown
# Social Graph Service (SGS)
PayPalsphere › Micro-services › Social Graph

The **Social Graph Service (SGS)** is the source-of-truth for all user–to–user and user–to–circle relationships across the PayPalsphere ecosystem.  
It answers the question: *“Who can see, react to, or be notified about a given payment event?”* and persists every change as an immutable domain event to guarantee auditability, historical replay, and real-time fan-out to downstream services (Notification, Risk, KYC, etc.).

---

## Table of Contents
1. [Responsibilities](#responsibilities)
2. [Architecture](#architecture)
3. [Domain Model](#domain-model)
4. [API Reference](#api-reference)
5. [Domain Events](#domain-events)
6. [Run Locally](#run-locally)
7. [Testing](#testing)
8. [Observability](#observability)
9. [Security](#security)
10. [Deployment](#deployment)
11. [Contributing](#contributing)

---

## Responsibilities
✔️ Maintain directed graph of `User`, `Circle`, and `Merchant` nodes  
✔️ Enforce relationship policies (RBAC, consent, block lists)  
✔️ Emit **event-sourced** mutations (`FriendAdded`, `CircleLeft`, …)  
✔️ Serve **CQRS Query API** (low-latency reads from read-optimized Neo4j projections)  
✔️ Publish **graph projections** to other bounded contexts (e.g. Notifications Service fan-out lists)  

---

## Architecture
```mermaid
graph TD
  subgraph Write Side
    A[Command API (Express + Joi)] -->|validates| B[(Kafka Topic: sg.write)]
    B --> C[Event Store (PostgreSQL)]
    C --> D(Outbox Dispatcher)
    D -->|publish| E{Kafka}
  end

  subgraph Read Side
    E --> F[Projector (Kafka Consumer)]
    F --> G((Neo4j Read Model))
    G --> H[Query API (Apollo GraphQL)]
  end

  style A fill:#fefefe,stroke:#333,stroke-width:1px
  style H fill:#fefefe,stroke:#333,stroke-width:1px
```

• Written in **TypeScript 5.x** (Node 18 LTS)  
• Message backbone: **Kafka** (`confluent-kafka-node`)  
• Event Store: **PostgreSQL 15** (`typeorm` w/ [event-sourcing kit](https://github.com/jetbasrawi/node-event-sourcing))  
• Read Model: **Neo4j 5** (`neo4j-driver`)  
• Containerization: **Docker+Compose**  
• Observability: **OpenTelemetry**, **Prometheus**, **Grafana**  

---

## Domain Model
```plaintext
(:User { id, handle, kycLevel, reputationScore })
(:Circle { id, name, visibility })   // visibility: PUBLIC | PRIVATE
(:Merchant { id, name, acquirerBIN })

Relationships:
  (:User)-[:FOLLOWS]->(:User)
  (:User)-[:BLOCKS]->(:User)
  (:User)-[:MEMBER_OF { role }]->(:Circle)      // role: ADMIN | MODERATOR | MEMBER
  (:Circle)-[:OWNS]->(:Merchant)
  (:User)-[:TRUSTS { score }]->(:Merchant)
```

---

## API Reference
All endpoints are prefixed with `/v1/social-graph`.

### Command API (REST)
| Method | Endpoint                         | Description                                         | Auth | Idempotency-Key |
|--------|----------------------------------|-----------------------------------------------------|------|-----------------|
| POST   | `/users/{userId}/friends`        | Send/accept friend request                          | ✔️   | Optional        |
| DELETE | `/users/{userId}/friends/{id}`   | Remove friendship                                   | ✔️   | Optional        |
| POST   | `/circles`                       | Create new circle                                   | ✔️   | Required        |
| PATCH  | `/circles/{circleId}`            | Update circle metadata (name, visibility)           | ✔️   | Optional        |
| POST   | `/circles/{circleId}/members`    | Add member(s)                                       | ✔️   | Required        |
| DELETE | `/circles/{circleId}/members`    | Leave / remove member (self or admin)               | ✔️   | Optional        |

Error codes follow RFC 9457 (Problem Details). Sample error:
```json
{
  "type": "https://docs.paypalsphere.com/errors/relationship-constraint",
  "title": "Relationship constraint violated",
  "status": 409,
  "detail": "User has exceeded the max pending friend requests (50).",
  "instance": "/v1/social-graph/users/42/friends"
}
```

### Query API (GraphQL)
```graphql
# Get circles I can post in
query MyCircles {
  myCircles {
    id
    name
    membership { role joinedAt }
  }
}

# Suggest people I may know
query SuggestedFriends($first: Int!) {
  suggestedFriends(first: $first) {
    id
    handle
    mutualFriendsCount
  }
}
```

---

## Domain Events
| Event Name           | Version | Description                          |
|----------------------|---------|--------------------------------------|
| `FriendAdded`        | v1      | Two users became friends             |
| `FriendRemoved`      | v1      | Friendship revoked                   |
| `CircleCreated`      | v1      | New circle instantiated              |
| `CircleMemberJoined` | v1      | User joined a circle                 |
| `CircleMemberLeft`   | v1      | User left/was removed from circle    |

Example `CircleMemberJoined` payload:
```jsonc
{
  "eventId": "e7f5c128-101f-49a0-96e1-84ff6a112c8a",
  "aggregateId": "circle:5e925c",
  "name": "CircleMemberJoined",
  "version": 1,
  "timestamp": "2023-11-04T12:45:33.803Z",
  "data": {
    "circleId": "5e925c",
    "userId": "42",
    "actor": "42",        // who triggered the command
    "role": "MEMBER"
  },
  "metadata": {
    "traceId": "4afae5a87d6be12c",
    "vertexVersion": 4
  }
}
```

---

## Run Locally
Prerequisites: `Docker` ≥ 24, `Node` ≥ 18, `npm` ≥ 9

1. Copy example env:
   ```bash
   cp .env.sample .env.local
   ```
2. Start infra + services:
   ```bash
   docker compose -f compose.local.yml up -d
   ```
3. Install dependencies & run dev mode (hot-reload):
   ```bash
   npm ci
   npm run dev
   ```

### Important Environment Variables
| Variable                     | Default                | Description                              |
|------------------------------|------------------------|------------------------------------------|
| `PSSG_PORT`                  | `7000`                 | Express server port                      |
| `PSSG_DB_URL`                | `postgres://…`         | PostgreSQL (event-store) DSN             |
| `PSSG_NEO4J_URI`             | `bolt://localhost:7687`| Neo4j read model URI                     |
| `PSSG_KAFKA_BROKERS`         | `kafka:9092`           | Comma-separated list                     |
| `PSSG_OTEL_EXPORTER_OTLP`    | `http://otel:4318`     | OpenTelemetry collector                  |
| `PSSG_JWT_PUBLIC_KEY_PATH`   | `./certs/jwt.pub`      | RS256 public key for auth validation     |

---

## Testing
Unit tests (`jest`) live beside the modules they cover.  
Contract & integration tests (`pactum`, `testcontainers`) are under `test/`.

Run all tests with coverage:
```bash
npm test -- --coverage
```

Trigger watch mode:
```bash
npm run test:watch
```

---

## Observability
• HTTP metrics: `/metrics` (Prometheus)  
• Health endpoints:
  - `/health/live`  – liveness probe  
  - `/health/ready` – readiness probe  
• Trace export via **OpenTelemetry SDK** → **Jaeger**  

Logs are JSON structured (pino), correlated with `traceId` + `spanId`.

---

## Security
1. Mutual TLS enforced on Kafka consumers/producers  
2. JWT validation (RS256) + KYC level claims  
3. All PII fields encrypted at rest via **AES-256-GCM** envelope keys  
4. Graph traversal queries gated by `PolicyEngine` (OPA Rego)  
5. Built-time SCA via **npm-audit-ci**; runtime sandboxed via **vm2** (for any user-submitted graph algorithms)  

---

## Deployment
The service is stateless; scale horizontal behind the provided Kubernetes `Deployment`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: social-graph-service
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
  template:
    spec:
      containers:
        - name: sgs
          image: ghcr.io/paypalsphere/social-graph:${GIT_SHA}
          envFrom:
            - secretRef: { name: sgs-prod-env }
          resources:
            requests: { cpu: "200m", memory: "256Mi" }
            limits:   { cpu: "500m", memory: "512Mi" }
          livenessProbe:
            httpGet: { path: /health/live, port: 7000 }
            initialDelaySeconds: 10
          readinessProbe:
            httpGet: { path: /health/ready, port: 7000 }
            initialDelaySeconds: 10
```

Rolling migrations for the event store are handled via `npm run migrate`.

---

## Contributing
1. Branch from `main` using `feature/<ticket-id>-short-desc`.  
2. Ensure `npm run lint && npm run test` passes.  
3. Submit pull request with descriptive title + linked Jira ticket.  
4. At least **1 approving review** + **green CI** required before merge.

> **Code-of-Conduct**: Be kind, respect privacy, no dark patterns.

---

© 2023-2024 PayPalsphere • All rights reserved
```