```markdown
# VitalPulse CloudCare API – Developer Guide  
_AWS Serverless, HIPAA-Grade REST/GraphQL Platform_  

**Version**: v1 (stable)   |  **Last Updated**: 2024-06-08  
**Status**: GA   |  **Change Log**: See [`CHANGELOG.md`](../CHANGELOG.md)  

---

## Table of Contents
1. Introduction  
2. Authentication & Authorization  
3. Common Headers  
4. Error Model  
5. Rate Limiting  
6. Pagination  
7. Endpoints  
   * 7.1 Command (Write) APIs  
   * 7.2 Query (Read) APIs  
8. GraphQL Schema  
9. Java Quick-Start  
10. Troubleshooting & FAQs  

---

## 1. Introduction
VitalPulse CloudCare is a micro-orchestrated, serverless platform that lets hospitals, clinics, and tele-health vendors exchange real-time clinical data.  
Key characteristics:  
* **CQRS** – Command/Query segregation for predictable latency.  
* **Fine-Grained Access Control** – SMART on FHIR + OAuth 2.0 scopes.  
* **Audit-Grade** – All requests are tamper-proof logged to AWS QLDB.  
* **Versioning** – `/v1` GA, `/v2` beta, seamless vendor migration.  

---

## 2. Authentication & Authorization
The API uses the OAuth 2.0 Authorization Code flow with PKCE.

| Header | Example |
|--------|---------|
| `Authorization` | `Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6I...` |

Scopes are SMART on FHIR–compliant (e.g., `patient/*.write`, `patient/*.read`, `medication.write`).  
Token introspection lives at `POST /oauth2/introspect`.

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=4/JqCE...knd
&client_id=clinic-ehr
&redirect_uri=https://ehr.example.org/auth/callback
&code_verifier=9jzW...
```

---

## 3. Common Headers
| Header                   | Mandatory | Description                                  |
|--------------------------|-----------|----------------------------------------------|
| `X-Request-Id`           | No        | Correlates calls. UUID; echoed in responses. |
| `X-Api-Version`          | Yes       | (`v1`, `v2beta`) Requested API version.      |
| `Content-Type`           | Yes (POST/PUT) | `application/fhir+json; charset=utf-8`        |
| `Accept`                 | Yes       | `application/fhir+json` or `application/json`|
| `X-RateLimit-Precision`  | No        | `millisecond` for high-frequency telemetry.  |

---

## 4. Error Model
All non-2xx responses conform to the FHIR `OperationOutcome` resource.

```json
{
  "resourceType": "OperationOutcome",
  "issue": [{
    "severity": "error",
    "code": "invalid",
    "diagnostics": "Heart-rate value must be between 0 and 400 bpm."
  }]
}
```

| HTTP Code | FHIR `issue.code` | Meaning                               |
|-----------|------------------|---------------------------------------|
| 400       | `invalid`        | Validation failed (JSON Schema/FHIR). |
| 401       | `login`          | Missing/expired token.                |
| 403       | `forbidden`      | Scope insufficient.                   |
| 404       | `not-found`      | Resource missing.                     |
| 422       | `processing`     | Business rule violation.              |
| 429       | `throttled`      | Rate limit exceeded.                  |
| 500/502   | `exception`      | Server/internal error.                |

---

## 5. Rate Limiting
The platform enforces a token bucket per client.

| Header                | Description                   |
|-----------------------|-------------------------------|
| `X-RateLimit-Limit`   | Max requests in current slice |
| `X-RateLimit-Remaining` | Requests left                |
| `X-RateLimit-Reset`   | Epoch millis until refill     |

A `429` response contains a `Retry-After` header in milliseconds.

---

## 6. Pagination
Cursor-based (opaque).  
Request: `GET /v1/patients/123/vital-signs?cursor=abc&limit=200`  
Response contains:

```json
{
  "data": [ /* … */ ],
  "paging": {
    "next": "ZXlKbGJ...==",
    "previous": "T25SaG...=="
  }
}
```

---

## 7. Endpoints

### 7.1 Command (Write) APIs

#### POST `/v1/patients/{patientId}/vital-signs`
Ingest a batch (≤ 500) of vital-sign observations.

Request body – FHIR `Bundle` (`type: batch`).

```json
{
  "resourceType": "Bundle",
  "type": "batch",
  "entry": [{
    "resource": {
      "resourceType": "Observation",
      "status": "final",
      "category": [{
        "coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category","code": "vital-signs"}]
      }],
      "code": {
        "coding": [{"system": "http://loinc.org","code": "8867-4","display": "Heart rate"}]
      },
      "valueQuantity": {"value": 78,"unit": "beats/minute"}
    }
  }]
}
```

Successful response `201 Created` includes `Location` header pointing to the Batch-ID resource:
`Location: /v1/batches/3fa85f64-5717-4562-b3fc-2c963f66afa6`

---

#### POST `/v1/medication-orders`
Creates a clinician medication order.  
FHIR `MedicationRequest` resource expected.

---

### 7.2 Query (Read) APIs

#### GET `/v1/patients/{patientId}/vital-signs`
Query historic vitals.

Parameters:  
* `cursor` – optional; start position  
* `limit` – max 1–1000 (default 250)  
* `category` – filter: `heart-rate|blood-pressure|oxygen-sat`  
* `_since` – ISO-8601 timestamp filter  

---

## 8. GraphQL Schema (Excerpt)

```graphql
type Query {
  patient(id: ID!): Patient!
}

type Patient {
  id: ID!
  vitalSigns(
    cursor: String
    limit: Int = 250
    category: VitalCategory
  ): VitalSignConnection!
}

enum VitalCategory { HEART_RATE BLOOD_PRESSURE OXYGEN_SAT }
```

Endpoint: `POST /graphql`  
Content-Type: `application/graphql+json`.

---

## 9. Java Quick-Start

Below is a production-ready example using **Feign** and **Jackson** to publish vital-signs and query them back.  

```java
package com.vitalpulse.samples;

import feign.*;
import feign.jackson.JacksonEncoder;
import feign.jackson.JacksonDecoder;
import feign.slf4j.Slf4jLogger;
import feign.okhttp.OkHttpClient;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Demonstrates Command (POST) & Query (GET) against the VitalPulse CloudCare API.
 * Requires:   implementation "io.github.openfeign:feign-okhttp:12.5"
 *             implementation "io.github.openfeign:feign-slf4j:12.5"
 *             implementation "io.github.openfeign:feign-jackson:12.5"
 *             implementation "com.fasterxml.jackson.datatype:jackson-datatype-jsr310:2.15.2"
 */
public final class CloudCareClient {

    public interface CloudCareApi {

        @RequestLine("POST /v1/patients/{patientId}/vital-signs")
        @Headers({
                "Authorization: Bearer {token}",
                "Content-Type: application/fhir+json",
                "X-Api-Version: v1",
                "X-Request-Id: {requestId}"
        })
        void ingestVitals(@Param("patientId") String patientId,
                          @Param("token") String token,
                          @Param("requestId") String requestId,
                          VitalBundle bundle);

        @RequestLine("GET /v1/patients/{patientId}/vital-signs?limit={limit}")
        @Headers({
                "Authorization: Bearer {token}",
                "Accept: application/fhir+json",
                "X-Api-Version: v1"
        })
        VitalPage fetchVitals(@Param("patientId") String patientId,
                              @Param("limit") int limit,
                              @Param("token") String token);
    }

    /* MARSHALLING TYPES (subset) */

    public record VitalBundle(String resourceType, String type, List<Entry> entry) {
        public static VitalBundle singleObservation(Observation observation) {
            return new VitalBundle("Bundle", "batch", List.of(new Entry(observation)));
        }
    }

    public record Entry(Observation resource) { }

    public record Observation(
            String resourceType,
            String status,
            List<Category> category,
            Code code,
            Quantity valueQuantity,
            String effectiveDateTime
    ) {
        public static Observation heartRate(double bpm) {
            Category category = new Category(
                    List.of(new Coding("http://terminology.hl7.org/CodeSystem/observation-category", "vital-signs"))
            );
            Code code = new Code(
                    List.of(new Coding("http://loinc.org", "8867-4", "Heart rate"))
            );
            Quantity quantity = new Quantity(bpm, "beats/minute");
            return new Observation(
                    "Observation",
                    "final",
                    List.of(category),
                    code,
                    quantity,
                    Instant.now().toString()
            );
        }
    }

    public record Category(List<Coding> coding) { }
    public record Code(List<Coding> coding) { }
    public record Coding(String system, String code, String display) { }
    public record Quantity(double value, String unit) { }

    public record VitalPage(List<Map<String, Object>> data, Paging paging) { }
    public record Paging(String next, String previous) { }

    /* ===== Main Demo ===== */
    public static void main(String[] args) {
        String baseUrl = "https://api.cloudcare.vitalpulse.com";
        String oauthToken = System.getenv("VITALPULSE_TOKEN"); // Retrieve securely!
        if (oauthToken == null) {
            throw new IllegalStateException("Missing OAuth token; set VITALPULSE_TOKEN env var.");
        }

        CloudCareApi api = Feign.builder()
                .client(new OkHttpClient())
                .encoder(new JacksonEncoder())
                .decoder(new JacksonDecoder())
                .logger(new Slf4jLogger(CloudCareApi.class))
                .logLevel(Logger.Level.BASIC)
                .target(CloudCareApi.class, baseUrl);

        String patientId = "9a15c0cc-722b-4ca3-b804-3389cfa4d8c3";
        String requestId = UUID.randomUUID().toString();

        // 1. Build a single heart-rate observation
        Observation hr = Observation.heartRate(78);
        VitalBundle bundle = VitalBundle.singleObservation(hr);

        // 2. Ingest
        try {
            api.ingestVitals(patientId, oauthToken, requestId, bundle);
            System.out.printf("Vitals ingested (requestId=%s)%n", requestId);
        } catch (FeignException.FeignClientException e) {
            System.err.printf("Validation error: %s%n", e.contentUTF8());
            return;
        } catch (FeignException e) {
            System.err.printf("API call failed: %s%n", e.getMessage());
            return;
        }

        // 3. Query latest vitals
        VitalPage page = api.fetchVitals(patientId, 10, oauthToken);
        page.data().forEach(observation ->
                System.out.printf("Retrieved Observation ID=%s%n", observation.get("id"))
        );

        // 4. Handle pagination
        if (page.paging() != null && page.paging().next() != null) {
            System.out.println("More data available via cursor: " + page.paging().next());
        }
    }
}
```

---

## 10. Troubleshooting & FAQs
Q: I receive `429` even with low traffic.  
A: Verify you include the `X-Api-Version` and `X-Request-Id` headers; missing headers force per-request penalties.  

Q: What TLS versions are supported?  
A: TLS 1.2+ only; mutual-TLS is available for on-prem integrations (contact support).  

---

© 2024 VitalPulse Inc. – All rights reserved.
```