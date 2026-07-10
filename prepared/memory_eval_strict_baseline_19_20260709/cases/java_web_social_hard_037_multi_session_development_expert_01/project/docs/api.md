```markdown
# CircleConnect Nexus – Public REST API v1
Author: CircleConnect Nexus Engineering  
Last updated: 2024-05-29

---

## Overview
CircleConnect Nexus exposes a versioned, JSON-over-HTTPS interface that enables third-party applications to:

* Create & manage Circles (community work-spaces)
* Post messages, files, polls, and events
* Launch micro-funding campaigns (Pledges) powered by Stripe
* Retrieve activity feeds in real-time via Server-Sent Events (SSE)
* Query influence scores, votes, and analytics

All endpoints are namespaced under  
`https://api.circleconnect.io/api/v1/**`  
and secured with **OAuth 2.1 Bearer tokens** (RFC 6750). TLS 1.3 is enforced; requests over `http://` are rejected with `426 Upgrade Required`.

> NOTE: Examples below use cURL and a fully-typed Java 17 client implemented with Spring’s `WebClient`. All snippets compile and can be copy-pasted into your application.

---

## Authentication

### OAuth 2.1 — Authorization Code Flow
```text
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded
```
Form params | Description
------------|------------
`grant_type=authorization_code` | (Fixed)
`code` | Temporary user code received from `/oauth2/authorize`
`redirect_uri` | Must match registered callback
`client_id` | Issued by CircleConnect
`code_verifier` | For PKCE

Successful response:
```json
HTTP/1.1 200 OK
{
  "access_token":"eyJhbGci...snip",
  "token_type":"Bearer",
  "expires_in":3600,
  "refresh_token":"8xLOxBtZp8"
}
```

### Java – Token Exchange Example
```java
package io.circleconnect.examples.auth;

import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

public final class OAuthTokenClient {

    private final WebClient client = WebClient.builder()
            .baseUrl("https://api.circleconnect.io")
            .defaultHeader("Content-Type", "application/x-www-form-urlencoded")
            .build();

    public Mono<TokenResponse> exchangeCode(String authCode, String codeVerifier) {
        return client.post()
                .uri("/oauth2/token")
                .body(BodyInserters
                        .fromFormData("grant_type", "authorization_code")
                        .with("code", authCode)
                        .with("redirect_uri", "https://myapp.io/callback")
                        .with("client_id", System.getenv("CIRCLE_CLIENT_ID"))
                        .with("code_verifier", codeVerifier))
                .retrieve()
                .bodyToMono(TokenResponse.class);
    }

    public record TokenResponse(
            String access_token,
            String token_type,
            long   expires_in,
            String refresh_token
    ) {}
}
```

---

## Global Response Envelope

Successful business responses (2xx) are wrapped in the envelope below; errors follow RFC 7807 (`application/problem+json`).

```json
{
  "meta": {
    "requestId": "9e3b54d7-18c9-4b23-b7d0-138aa73c8d6e",
    "timestamp": "2024-05-29T10:15:42Z"
  },
  "data": { /* domain payload */ }
}
```

---

## Endpoints

### 1. Circles

#### 1.1 Create Circle — POST `/circles`
Scope: `circle.write`

Request Body
```json
{
  "name": "Book Club 2024",
  "description": "Monthly reads & meetups",
  "visibility": "PRIVATE"   // PUBLIC | PRIVATE
}
```

cURL
```bash
curl -X POST https://api.circleconnect.io/api/v1/circles \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d @create-circle.json
```

Success (201)
```json
{
  "meta": { ... },
  "data": {
    "id": "cl-7f313980",
    "slug": "book-club-2024",
    "ownerUserId": "usr-1b3a12",
    "createdAt": "2024-05-29T10:16:03Z"
  }
}
```

Java – Service Integration
```java
package io.circleconnect.examples.circle;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;

public record CreateCircleRequest(
        @NotBlank @Size(max = 80) String name,
        @Size(max = 2000)          String description,
        Visibility                 visibility
) {
    public enum Visibility { PUBLIC, PRIVATE }
}

public record CircleResponse(
        String  id,
        String  slug,
        String  ownerUserId,
        Instant createdAt
) {}
```

```java
import io.circleconnect.examples.auth.OAuthTokenClient.TokenResponse;
import reactor.core.publisher.Mono;

public final class CircleApiClient {

    private final WebClient client;

    public CircleApiClient(TokenResponse token) {
        this.client = WebClient.builder()
                .baseUrl("https://api.circleconnect.io/api/v1")
                .defaultHeader("Authorization", "Bearer " + token.access_token())
                .defaultHeader("Content-Type", "application/json")
                .build();
    }

    public Mono<CircleResponse> createCircle(CreateCircleRequest req) {
        return client.post()
                .uri("/circles")
                .bodyValue(req)
                .retrieve()
                .bodyToMono(CircleResponse.class);
    }
}
```

#### 1.2 List Member Circles — GET `/circles`
Query Params | Type | Default | Description
-------------|------|---------|-------------
`page`       | int  | 0       | zero-based
`size`       | int  | 20      | max 100

Returns `Page<CircleSummary>`.

---

### 2. Posts

#### 2.1 Create Post — POST `/circles/{circleId}/posts`
Body
```json
{
  "type": "TEXT",           // TEXT | POLL | MEDIA
  "content": "Don't forget our meeting this Friday!",
  "attachments": []
}
```

Successful response includes `postId`, `version` (for optimistic locking).

Server-Sent Events for live feeds:
`GET /circles/{id}/posts/stream`  
`Accept: text/event-stream`

---

### 3. Events

* `POST /circles/{id}/events` — schedule new event  
  Required fields: `title`, `startsAt`, optional `recurrence`

* `PATCH /events/{eventId}` — partial update with JSON Patch (`application/json-patch+json`)

* `DELETE /events/{eventId}` — soft-delete; audit log entry persisted.

---

### 4. Pledges

Payment intent creation is proxied to Stripe. The flow:

1. `POST /circles/{id}/pledges` – returns `clientSecret`
2. Client confirms card via Stripe.js
3. CircleConnect receives webhook → updates pledge status

Pledge resource:
```json
{
  "id": "pl-90af5bd1",
  "circleId": "cl-7f313980",
  "targetAmount": 250.00,
  "currency": "USD",
  "amountCollected": 78.50,
  "status": "ACTIVE",   // ACTIVE | SUCCESS | FAILED | CANCELED
  "expiresAt": "2024-06-30T23:59:59Z"
}
```

---

## Error Handling

All errors use RFC 7807 Problem Details:
```json
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
{
  "type": "https://api.circleconnect.io/problems/resource-not-found",
  "title": "Resource Not Found",
  "status": 404,
  "detail": "Circle cl-doesnotexist was not found",
  "instance": "/api/v1/circles/cl-doesnotexist"
}
```
Common error types:
Code | Title | Notes
-----|-------|------
400  | Validation Failed | See `errors[]` array for field violations
401  | Unauthorized | Missing/invalid token
403  | Forbidden | Scope missing or user blocked
409  | Conflict | Optimistic-lock mismatch, duplicate slug, etc.
429  | Rate Limit | Exceeded per-IP policy (100 req/min)
500  | Internal Error | Server fault, `requestId` included

---

## Advanced Topics

### Pagination
Spring HATEOAS style rel links:
```json
"_links": {
  "self":  { "href": ".../circles?page=1&size=20" },
  "next":  { "href": ".../circles?page=2&size=20" },
  "prev":  { "href": ".../circles?page=0&size=20" }
}
```

### Webhooks
Register at `POST /developer/webhooks`. Supported events:  
`pledge.succeeded`, `member.joined`, `circle.archived`.

### Idempotency
Provide `Idempotency-Key` header on POST/PUT to guarantee at-most-once execution.

---

## Appendix A – OpenAPI Artifact
The full machine-readable spec is published daily:
```
https://api.circleconnect.io/spec/v1/openapi.yml
```
Download & import into Swagger-UI or Postman.

---

© 2024 CircleConnect Inc. All rights reserved.
```