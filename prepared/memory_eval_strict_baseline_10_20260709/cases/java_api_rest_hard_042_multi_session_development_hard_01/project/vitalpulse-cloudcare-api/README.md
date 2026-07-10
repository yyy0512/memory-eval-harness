```markdown
# VitalPulse CloudCare API

[![Build](https://github.com/vitalpulse/cloudcare-api/actions/workflows/ci.yml/badge.svg)](https://github.com/vitalpulse/cloudcare-api/actions)
[![License](https://img.shields.io/github/license/vitalpulse/cloudcare-api)](LICENSE)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=vitalpulse_cloudcare-api&metric=coverage)](https://sonarcloud.io/summary/new_code?id=vitalpulse_cloudcare-api)

VitalPulse **CloudCare API** is a serverless, micro-orchestrated REST/GraphQL platform that enables hospitals, ambulatory clinics and tele-health vendors to exchange real-time vital-sign streams, medication events and clinician orders.  
The platform is built on:

* **AWS Lambda** (Java 17 runtime)
* **Amazon API Gateway** (v2 HTTP + REST API)
* **Amazon DynamoDB** (single-table, CQRS pattern)
* **Amazon EventBridge** (domain events and audit trail)
* **CloudWatch** + **X-Ray** (observability & traces)
* **AWS WAF** / **Secrets Manager** / **KMS** (security)

---

## 1  Features

| Feature                     | Description                                                                                            |
|-----------------------------|--------------------------------------------------------------------------------------------------------|
| HIPAA-grade security        | SMART on FHIR, OAuth 2.0 w/ PKCE, fine-grained [FHIR Scopes](https://hl7.org/fhir/)                    |
| Command/Query separation    | Lambda partitioned into `*-command` (write) and `*-query` (read) functions                            |
| Versioned APIs              | `/v1` (stable), `/v2` (beta) via API Gateway stages & route selection expressions                     |
| Schema validation           | FHIR JSON schema validation (draft-07) with business rule enrichment                                  |
| Rate limiting               | Global & per-device quotas enforced via API Gateway, WAF, and DynamoDB adaptive capacity              |
| Cursor-based pagination     | Consistent, low-latency pagination for longitudinal records                                           |
| GraphQL overlay             | Consolidates multiple REST resources for clinician dashboards                                         |
| Audit-grade error handling  | Structured errors (RFC 7807) signed & persisted for litigation hold                                  |
| Observability               | CloudWatch dashboards, custom metrics, distributed tracing, Canary health checks                      |

---

## 2  Architecture Diagram

```text
┌──────────┐    HTTPS     ┌─────────────┐   invokes   ┌───────────────┐
│ Clients  │────────────►│ API Gateway │────────────►│ AWS Lambda(s) │
└──────────┘             └─────────────┘             └──────┬────────┘
                                         put/get events     │
                     ┌──────────────────────────────────────┼─────────┐
                     ▼                                      ▼         ▼
               ┌───────────────┐                    ┌────────────┐┌────────────┐
               │ DynamoDB CQRS │◄─Streams/Audit────►│EventBridge ││  S3 Archive│
               └───────────────┘                    └────────────┘└────────────┘
```

---

## 3  Getting Started

### 3.1 Prerequisites

* Java 17 SDK
* Maven 3.9+
* AWS CLI v2 (configured profile with sufficient permissions)
* Docker 20.10+ (for local testing)
* Node 18 (optional, GraphQL playground)

### 3.2 Clone & Bootstrap

```bash
git clone https://github.com/vitalpulse/cloudcare-api.git
cd cloudcare-api

# compile & run unit tests
mvn clean verify

# synthesize the CloudFormation template (AWS SAM)
sam build
```

### 3.3 Deploy to AWS Dev Account

```bash
sam deploy \
  --config-env dev \
  --region us-east-1 \
  --stack-name vitalpulse-cloudcare-dev \
  --resolve-s3 \
  --no-confirm-changeset
```

Post-deployment output shows REST endpoint & WebSocket URL:

```text
ApiUrl = https://abc123.execute-api.us-east-1.amazonaws.com/v1
GraphQlEndpoint = wss://xyz987.execute-api.us-east-1.amazonaws.com/graphql
```

---

## 4  Usage Examples

### 4.1 Create Patient Vitals Stream (REST)

```bash
curl -X POST "$ApiUrl/v1/patients/123/vitals" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/fhir+json" \
  -d @samples/vital-signs-bundle.json
```

### 4.2 Query Vitals with Pagination

```bash
curl "$ApiUrl/v1/patients/123/vitals?cursor=eyJzIjoxNj..." \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Response:

```jsonc
{
  "items": [ /* FHIR Observation resources */ ],
  "cursor": "eyJzIjoxNzAwNjY..."
}
```

### 4.3 GraphQL Batch Query

```graphql
subscription OnVitals($patientId: ID!) {
  onVitals(patientId: $patientId) {
    id
    code { text }
    valueQuantity { value unit }
    effectiveDateTime
  }
}
```

Connect via WebSocket:

```bash
wscat -c "$GraphQlEndpoint?token=$ACCESS_TOKEN"
```

---

## 5  Module Breakdown

```
api-rest/
├── domain/              → Value objects & aggregates (FHIR resources)
├── repository/          → DynamoDB adapter (single-table design)
├── service/             → CQRS service layer (command|query)
├── function/            → AWS Lambda entry points
├── graphql/             → Apollo federation-compliant schema & resolvers
└── common/              → Shared utils (validation, tracing, security)
```

---

## 6  Security & Compliance

1. OAuth 2.0 Authorization Code Grant w/ PKCE.  
2. JWT Access Tokens signed by AWS Cognito (RS256).  
3. Attribute-based access control (ABAC) enforced in Lambda authorizer.  
4. All PHI encrypted at rest (DynamoDB SSE-KMS) and in transit (TLS 1.2+).  
5. CloudTrail, EventBridge, and S3 Object Lock guarantee immutable audit logs.  

Refer to `docs/hipaa-compliance.md` for in-depth details.

---

## 7  Error Handling & Problem Details

Errors comply with RFC 7807. Example:

```json
{
  "type": "https://api.vitalpulse.com/errors/validation",
  "title": "Invalid FHIR payload",
  "status": 400,
  "detail": "Observation.effectiveDateTime must not be in the future.",
  "instance": "/v1/patients/123/vitals"
}
```

Each error is signed and published to `eventbridge:Bus/ComplianceAudit`.

---

## 8  Local Development

Start all Lambdas & API Gateway locally:

```bash
sam local start-api -p 3001
```

Tail logs:

```bash
sam logs -n vitals-query -t
```

Run integration tests:

```bash
mvn -Pintegration-test verify
```

---

## 9  Contributing

We welcome pull requests from the community.

1. Fork the repo & create feature branch
2. Run `mvn clean verify` to ensure tests pass
3. Submit PR with descriptive commit messages

All code must comply with our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## 10  License

VitalPulse CloudCare API is released under Apache License 2.0.  
See [LICENSE](LICENSE) for full text.
```