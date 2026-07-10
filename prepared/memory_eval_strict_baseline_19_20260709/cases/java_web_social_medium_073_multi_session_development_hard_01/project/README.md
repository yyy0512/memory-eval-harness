```markdown
# EduPulse – Live Learning Hub  

> A real-time, event-driven social-learning platform built with Java & Spring Boot

![Build](https://img.shields.io/github/actions/workflow/status/acme/edupulse-ci.yml?branch=main&label=build)
![Coverage](https://img.shields.io/codecov/c/github/acme/edupulse)
![License](https://img.shields.io/github/license/acme/edupulse)

EduPulse turns every micro-interaction in a virtual classroom—posting a “pulse”, submitting an answer, awarding a badge—into a **domain event** that travels through a lightweight message bus.  
The result: friction-free collaboration, adaptive learning analytics, and a cloud-native architecture that scales from a one-on-one tutoring session to a global MOOC.

---

## ✨ Key Features
| Domain | Highlights |
| ------ | ---------- |
| **Social Learning** | Pulses (micro-lessons), threaded discussions, emoji & badge reactions |
| **Assessments** | Auto-graded quizzes, rubric-driven peer reviews, assignment uploads |
| **Engagement** | Real-time notifications, live Q&A, progress streaks |
| **Monetization** | Stripe-backed checkout, coupon engine, instructor payouts |
| **Ops** | Centralized logging (OpenTelemetry), granular error handling, active feature flags |

---

## 🏛  Architectural Overview

```mermaid
graph LR
  subgraph Core Services
    U(UserSvc):::svc
    C(ContentSvc):::svc
    A(AssessmentSvc):::svc
    P(PaymentSvc):::svc
    N(NotificationSvc):::svc
  end

  subgraph Infra
    B[(Kafka)]:::msg
    DB[(PostgreSQL)]:::db
    S3[(MinIO)]:::storage
  end

  Browser -->|REST/WebSocket| Gateway
  Gateway -->|JWT| U
  Gateway -->|REST| C
  Gateway -->|REST| A
  Gateway -->|REST| P

  U --> DB
  C --> DB
  A --> DB
  P --> DB

  U --⟶|Domain Events| B
  C --⟶|Domain Events| B
  A --⟶|Domain Events| B
  P --⟶|Domain Events| B

  B --> N
  N -->|Email/SSE| Browser

  classDef svc fill:#edf6ff,stroke:#0366d6,stroke-width:1;
  classDef msg fill:#fff4e5,stroke:#f66a0a,stroke-width:1;
  classDef db  fill:#f0fff4,stroke:#28a745,stroke-width:1;
  classDef storage fill:#f0f8ff,stroke:#6f42c1,stroke-width:1;
```

### Patterns & Conventions

* **MVC + Service Layer** – Controllers are fat-free; business logic lives in `*Service` classes.
* **Domain Events** – Plain Java objects annotated with `@DomainEvent`; published through Spring Cloud Stream (Kafka binder).
* **ORM** – Hibernate/JPA with strict mapping rules, PostgreSQL as the default vendor.
* **Authentication Middleware** – Spring Security (JWT) & method-level `@PreAuthorize` guards.
* **Reactive Channels** – `ServerSentEvent` (SSE) for browser push & WebSockets for lightning-fast Q&A.
* **12-Factor App** – Externalized config (Spring Cloud Config), stateless services, container-ready (Docker).

---

## 🛠  Tech Stack

| Layer          | Tech                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| API Gateway    | Spring Cloud Gateway, Rate Limiter (Bucket4j)                           |
| Service Runtime| Spring Boot 3.x, Java 21                                               |
| Messaging      | Apache Kafka + Spring Cloud Stream                                      |
| Persistence    | PostgreSQL, Flyway (migrations), Hibernate ORM                          |
| Storage        | MinIO / AWS S3 (for assignment uploads, avatars)                        |
| Security       | Spring Security, JWT, OAuth2 (Google/LinkedIn)                          |
| Payments       | Stripe Java SDK                                                         |
| CI/CD          | GitHub Actions → Docker Hub → Kubernetes (Helm)                         |
| Observability  | OpenTelemetry, Grafana, Loki                                            |

---

## 🚀 Getting Started

### 1. Clone & Bootstrap
```bash
git clone https://github.com/acme/edupulse.git
cd edupulse
./mvnw clean verify      # Runs unit + integration tests
```

### 2. Run All Services (Dev Profile)
Requirements: Docker, Docker Compose v2

```bash
docker compose -f infrastructure/docker-compose.dev.yml up -d
./mvnw -pl :edupulse-gateway,:edupulse-user-svc,:edupulse-content-svc \
       -am spring-boot:run
```

Visit `http://localhost:8080/swagger-ui.html` for the aggregated OpenAPI explorer.

### 3. Smoke-test the Event Bus
```bash
curl -X POST http://localhost:8080/api/pulses \
  -H "Authorization: Bearer <jwt>" \
  -F "title=Binary Trees" \
  -F "body=Quick refresher on DFS" \
  -F "attachment=@btree.pdf"
# -> 201 Created

# domain-event topic should now contain PulseCreatedEvent
docker compose exec broker kafka-console-consumer \
  --bootstrap-server localhost:9092 --topic edupulse.events --from-beginning
```

---

## 🧑‍💻  Project Modules
| Module | Description |
| ------ | ----------- |
| `edupulse-common` | Event contracts, shared DTOs, validation annotations |
| `edupulse-gateway` | Auth, rate limiting, API composition, SSE router |
| `edupulse-user-svc` | Registration, profiles, social graph, JWT issuing |
| `edupulse-content-svc` | Pulse posting, comments, tags, search |
| `edupulse-assessment-svc` | Quizzes, assignments, auto-grading engine |
| `edupulse-payment-svc` | Stripe integration, subscription tiers |
| `edupulse-notification-svc` | Email, push, in-app notifications (listens to Kafka) |
| `infrastructure` | Docker Compose, local Kafka, PostgreSQL, MinIO |

---

## 🧪  Testing Strategy

1. **Unit Tests** – JUnit5 + AssertJ; 80% coverage gate enforced by JaCoCo.
2. **Component Tests** – Spring Boot slices (`@WebMvcTest`, `@DataJpaTest`) for service boundaries.
3. **Contract Tests** – Pact for provider & consumer contracts on event payloads.
4. **E2E Tests** – Cypress scripts in `e2e/` grace the UI & WS endpoints.
5. **Chaos Experiments** – Toxiproxy containers introduce latency & broker collapse.

---

## 📝  Coding Guidelines

* **Java 21** – Use records, sealed classes, `var` where clarity benefits.
* **Error Handling** – Prefer `ProblemDetail` (RFC 7807) responses; leverage `@ControllerAdvice`.
* **Null Safety** – Adopt `@NonNullApi` and Optional return types for missing values.
* **Logging** – `log.info` for business milestones, `log.error` for anomalies, **never** swallow exceptions.
* **Secrets** – Use Spring Vault or `docker secrets`; never commit `.env` or `.pem` keys.

---

## 📦  Release & Deployment

1. GitHub tag → `vX.Y.Z`
2. CI builds multi-arch images (`linux/amd64`,`linux/arm64`) & pushes to **ghcr.io/acme/edupulse/\***.
3. Helm chart bumped & signed; ArgoCD syncs staging → production.

---

## 🤝  Contributing

```bash
# create a new feature branch
git switch -c feat/<issue-id>-<brief-description>

# generate a conventional commit
npm exec -- commitizen
```

Pull requests require:
* 1️⃣  Passing CI
* 2️⃣  Minimum 2 reviewer approvals
* 3️⃣  ADR for architectural-level changes (see `/docs/adr/`)

---

## 📄  License

EduPulse is released under the **Apache License 2.0** – see [`LICENSE`](LICENSE).

---

### © 2024 EduPulse Project – Aiming to spark curiosity, one micro-pulse at a time.
```