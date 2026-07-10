```markdown
# VitalPulse CloudCare API – Setup Guide
The purpose of this document is to get new contributors **from zero to a fully-running stack**—locally or in AWS—in less than 15 minutes.  
It covers tooling, environment variables, build commands, and operational tips specific to this repository.

---

## 1. TL;DR (5 Commands)

```bash
# 1) Clone
git clone git@github.com:vitalpulse/cloudcare-api.git && cd cloudcare-api

# 2) Provision local infra (DynamoDB, API Gateway, S3, X-Ray) via LocalStack
make infra-up              # docker-compose under the hood

# 3) Build (Java 17, Gradle 8)
./gradlew clean build -x test

# 4) Start all Lambda functions behind local API Gateway emulator
make start-local           # sam local start-api & sam local start-lambda

# 5) Hit a health endpoint
curl http://localhost:3000/v1/health
```

If the response is `{"status":"UP"}` you are good to go.

---

## 2. Prerequisites

| Tool | Version (min) | Purpose |
|------|---------------|---------|
| JDK  | 17            | Compile Lambdas |
| Gradle | 8.x         | Build system (wrapper included) |
| Docker | 24.x        | Local infrastructure |
| AWS CLI | 2.x        | Deployment & SAM |
| AWS SAM CLI | 1.90+  | Local Lambda runtime / cloud deploy |
| Node | 20 LTS        | GraphQL playground assets & RateLimit test client |
| Make | any           | Convenience scripts |

> On macOS you can `brew bundle` from the repository root to install everything (see Brewfile).

---

## 3. Repository Layout (high-level)

```
.
├── api-rest (Gradle multi-module)
│   ├── command-service   # write side CQRS
│   ├── query-service     # read side CQRS
│   ├── graphql-gateway   # federated GraphQL facade
│   ├── shared-kernel     # DTOs, validation, errors
│   └── build.gradle.kts
├── infra
│   ├── sam-template.yaml # AWS SAM template
│   └── docker-compose.yml
└── docs
    └── setup-guide.md
```

---

## 4. Building the Services

```bash
./gradlew clean build             # compiles, runs unit tests, and creates shaded JARs
./gradlew :query-service:test     # run tests for a single module
./gradlew spotlessCheck           # code style
```

Artifacts are placed under `build/dist/*.zip` for each module, ready for Lambda deployment.

---

## 5. Local Infrastructure

We use **LocalStack** to emulate AWS services and **Testcontainers** inside integration tests.

### 5.1 docker-compose excerpt

```yaml
version: "3.8"
services:
  localstack:
    image: localstack/localstack:3.1
    environment:
      - SERVICES=lambda,dynamodb,apigateway,s3,cloudwatch,logs
      - DEFAULT_REGION=us-east-1
      - DYNAMODB_SHARE_DB=1
    ports:
      - "4566:4566"
      - "4510-4559:4510-4559"
    healthcheck:
      test: ["CMD", "awslocal", "dynamodb", "list-tables"]
      interval: 5s
      retries: 5
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.89.0
    volumes:
      - ./infra/otel-config.yml:/etc/otel/config.yaml
    ports:
      - "4317:4317"
      - "4318:4318"
```

Start/stop:

```bash
make infra-up      # docker compose up -d
make infra-down    # docker compose down -v
```

### 5.2 SAM Local

```bash
sam build    --template infra/sam-template.yaml
sam local start-api -p 3000
sam local start-lambda
```

---

## 6. Environment Variables

Each Lambda is injected via AWS Parameter Store; local values are loaded from `.env.local`.  

| Key | Description | Example |
|-----|-------------|---------|
| STAGE | Deployment stage | `dev` / `qa` / `prod` |
| JWT_PUBLIC_KEY | SMART on FHIR public JWK | _(multiline)_ |
| RATE_LIMIT_RPS | Default requests-per-second per API key | `30` |
| DYNAMODB_TABLE_PREFIX | Table name prefix | `vp_dev_` |
| OTEL_EXPORTER_OTLP_ENDPOINT | OTEL collector endpoint | `http://localhost:4317` |

Load locally:

```bash
cp .env.sample .env.local
source .env.local
```

---

## 7. Deploying to AWS

```bash
# Set target account + region
export AWS_PROFILE=vitalpulse-dev
export AWS_REGION=us-east-1

sam deploy \
  --template-file infra/sam-template.yaml \
  --stack-name vp-cloudcare-api \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Stage=dev TablePrefix=vp_dev_
```

Post-deploy, the script prints the base URL, e.g.  
`https://abcde12345.execute-api.us-east-1.amazonaws.com/dev`.

---

## 8. Running Integration & Contract Tests

We leverage **JUnit 5 + Testcontainers**. The Gradle profile `integrationTest` is wired to spin up:

* DynamoDB Local
* LocalStack Lambda executor
* WireMock server for external FHIR system

```bash
./gradlew integrationTest
```

> Integration tests run in CI against ephemeral containers; no AWS credentials are required.

---

## 9. Database Migrations (DynamoDB)

Schema is managed as code via **CloudFormation** (SAM template).  
Seed data can be loaded:

```bash
aws dynamodb batch-write-item \
  --request-items file://infra/seeds/patients.json \
  --endpoint-url http://localhost:4566
```

---

## 10. Observability

* **Logs** – CloudWatch Logs, structured in JSON using Logback encoder  
* **Metrics** – Micrometer → CloudWatch / Prometheus (when running locally)  
* **Tracing** – AWS X-Ray in prod; OTEL collector + Jaeger locally  

To view traces locally:

```bash
docker run -d -p16686:16686 jaegertracing/all-in-one:1.50
open http://localhost:16686
```

---

## 11. Security & Compliance

1. OAuth 2.0 / SMART on FHIR flows enforced by `AuthorizerLambda`.
2. All DynamoDB tables encrypted (KMS); S3 buckets → SSE-S3.
3. API Gateway WAF blocks common OWASP threats.
4. PHI never stored in logs (structured sanitizer middleware).
5. Pen-test reports live under `/docs/security`.

---

## 12. Rate Limiting (Per-Client)

Located in `api-rest/shared-kernel/src/main/java/.../RateLimiter.java`.

Example of 30 RPS limit with token bucket:

```java
RateLimiter limiter = TokenBucketRateLimiter.newBuilder()
    .bucketId(clientId)
    .capacity(30)
    .refillTokens(30, Duration.ofSeconds(1))
    .build();
```

In local dev you can hit `/v1/telemetry` rapidly and observe `429 Too Many Requests` after the threshold.

---

## 13. Cleaning up AWS Resources

```bash
sam delete \
  --stack-name vp-cloudcare-api \
  --no-prompts
```

---

## 14. Common Issues / Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Unable to import module handler` | Ensure you built with the same JDK target (17) as Lambda runtime. |
| 5XX errors on LocalStack | `make infra-down && make infra-up` (LocalStack flakiness). |
| `docker: no space left on device` | `docker system prune -af --volumes`. |

---

## 15. Glossary

* **CQRS** – Command Query Responsibility Segregation  
* **FHIR** – Fast Healthcare Interoperability Resources  
* **SAM** – Serverless Application Model  
* **PHI** – Protected Health Information  

---

Happy coding & feel free to open a PR for any discrepancies!  
_— The VitalPulse Engineering Team_
```