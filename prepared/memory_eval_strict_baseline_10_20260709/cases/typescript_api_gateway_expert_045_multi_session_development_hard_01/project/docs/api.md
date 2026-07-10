<!--
  SocialPulse Gateway – API Documentation
  =======================================

  This document is generated and maintained alongside the TypeScript code-base.
  It intentionally duplicates key runtime contracts (DTOs, error envelopes,
  pagination cursors, etc.) so that contributors can reason about the public
  surface without spelunking through source files.

  IMPORTANT: Keep this file in sync with any breaking changes or version bumps.
-->

# SocialPulse Gateway – Public API

SocialPulse Gateway (a.k.a. `api_gateway`) sits between first-party clients/partners and an internal fleet of micro-services.  
It exposes two first-class entry-points:

1. **REST** – easier for non-GraphQL consumers and cache-friendly for CDN edge nodes.  
2. **GraphQL** – preferred for modern clients requiring fine-grained field selection and real-time subscriptions.

Both entry-points are **fully typed** (OpenAPI 3.1 / GraphQL SDL) and **discoverable at runtime** (`/openapi.json`, `/graphql`).

---

## 🎯 Quick Start

```bash
# Assuming a local dev cluster (Docker Compose) is running

# Get your feed (REST)
curl -H "Authorization: Bearer <JWT>" \
     "http://localhost:8080/v1/timeline?limit=20"

# Run a GraphQL query
curl -H "Authorization: Bearer <JWT>" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ me { id handle latestPosts(limit: 10) { id body } } }"}' \
     http://localhost:8080/graphql
```

---

## 🔐 Authentication & Authorization

| Mechanism           | Header/Field          | Notes                                                          |
|---------------------|-----------------------|----------------------------------------------------------------|
| OAuth2 Bearer Token | `Authorization: Bearer <JWT>` | Issued by the Auth-Service (`/auth/token`). Contains `sub`, `scope`, `iat`, `exp`. |
| API Key (server-to-server) | `X-API-KEY`            | For trusted partners. Rotated every 30 days.                   |
| Guest Session Token | `X-ANON-TOKEN`        | Short-lived (~6 hrs) token enabling limited read-only access. |

If missing/invalid, the gateway will return:

```jsonc
{
  "error": "UNAUTHENTICATED",
  "message": "A valid Authorization header is required",
  "statusCode": 401,
  "timestamp": "2024-03-21T14:25:31.021Z",
  "traceId": "a3c1e2c9d6ef41bb"
}
```

---

## 🚦 Rate Limits

```
Authenticated users      500 req / 10 s sliding window
Guest sessions           200 req / 10 s
Partner API key          3 000 req / 10 s
```

Exceeded limits respond with `429 TOO MANY REQUESTS` + `Retry-After` header.

---

## 🧭 Versioning Strategy

* **URI-based** (`/v1/…`, `/v2/…`) for REST.  
* **Field deprecation** for GraphQL (SDL `@deprecated(reason: "...")`).  
* **Semantic Versioning** governs breaking changes (> MAJOR).  
* Grace period: **90 days** after new major goes GA – both versions are served concurrently.

Example:

```
GET /v1/timeline            → ranking engine V1
GET /v2/timeline?algo=V2    → ranking engine V2 (beta)
```

---

## 🗄️ Pagination

The gateway employs **cursor-based pagination**:

```jsonc
{
  "data": [ /* …results… */ ],
  "paging": {
    "nextCursor": "bGltaXQ6MjA=",      // opaque, base64-encoded
    "previousCursor": "b2Zmc2V0OjI=",
    "hasNext": true,
    "hasPrevious": false
  }
}
```

---

## 🧩 Error Envelope

All errors (REST **and** GraphQL) conform to a unified envelope for observability:

```jsonc
{
  "error": "RESOURCE_NOT_FOUND",
  "message": "Post 2b480d not found",
  "statusCode": 404,
  "timestamp": "2024-03-21T14:27:10.720Z",
  "traceId": "93e4fd6778434430"
}
```

`traceId` (W3C Trace-Context) helps correlate logs across distributed services.

---

## 🛤️ REST Endpoints (v1)

Endpoint list is auto-generated via TypeScript decorators & `@nestjs/swagger`.  
Below is a curated subset.

### GET /v1/timeline

Retrieve a ranked activity feed for the current user.

| Parameter | In   | Type    | Required | Description                                  |
|-----------|------|---------|----------|----------------------------------------------|
| `limit`   | `query` | `number` | No (default 20, max 100) | How many items to fetch |
| `cursor`  | `query` | `string` | No | Opaque cursor returned by previous page |

Responses:

* `200 OK` – see `TimelineDto` below  
* `401 UNAUTHENTICATED`  
* `429 TOO MANY REQUESTS`

```typescript
// DTO definition (kept in sync with ../src/application/dto/timeline.dto.ts)
export interface TimelineDto {
  data: Array<
    | PostDto
    | StoryDto
    | LiveChatDto
  >;
  paging: CursorPaging;
}
```

Example response (truncated):

```jsonc
{
  "data": [
    {
      "type": "POST",
      "id": "af12e3",
      "author": { "id": "u887", "handle": "codelover" },
      "body": "👋 Hello world!",
      "reactions": { "like": 12, "laugh": 1 },
      "createdAt": "2024-03-21T13:45:11.310Z"
    }
  ],
  "paging": { "nextCursor": "bGltaXQ6MjA=", "hasNext": true }
}
```

---

### POST /v1/posts

Create a new post.

| Parameter | In    | Type   | Required | Description       |
|-----------|-------|--------|----------|-------------------|
| body      | `body`| `PostCreatePayload` | Yes | Post content |

`PostCreatePayload`:

```typescript
export interface PostCreatePayload {
  body: string;               // Markdown-flavored text (max 5 000 chars)
  mediaIds?: string[];        // Optional images/videos previously uploaded
  visibility?: "PUBLIC" | "FOLLOWERS" | "PRIVATE"; // Default: PUBLIC
}
```

Responses:

* `201 CREATED`
* `400 BAD REQUEST` – validation errors
* `413 PAYLOAD TOO LARGE` – body > 5 000 chars
* `429 TOO MANY REQUESTS`

---

### GET /v1/users/:userId

Fetch public profile.

| Parameter | In   | Type   | Required |
|-----------|------|--------|----------|
| `userId`  | path | string | Yes      |

---

## ♾️ GraphQL

Endpoint: `/graphql` (POST & WebSocket for subscriptions).  
Schema is **code-first** (NestJS + `@nestjs/graphql`). SDL excerpt:

```graphql
"""
A user on the platform
"""
type User {
  id: ID!
  handle: String!
  displayName: String
  avatarUrl: String
  bio: String
  latestPosts(limit: Int = 10): [Post!]!
  followers(first: Int = 20, after: Cursor): UserConnection! @deprecated(reason: "Use followerListV2")
}

type Query {
  me: User!
  user(id: ID!): User
  timeline(limit: Int = 20, cursor: Cursor): Timeline!
}

type Mutation {
  createPost(input: PostCreateInput!): Post! @rateLimit(max: 20, window: "1m")
}

type Subscription {
  postCreated: Post!
  reactionAdded(postId: ID!): Reaction!
}

"""
A Cursor for pagination, base64 encoded string.
"""
scalar Cursor
```

---

## 🔄 Caching

High fan-out GET requests leverage `Redis` (distributed LRU, TTL 15 s).  
Cache key includes:

```
prefix:timeline:v1:{userId}:{cursor}:{limit}
```

Bust strategies:

1. **Write-through** – new post triggers invalidation for followers’ timelines.  
2. **Event-driven** – message bus (`kafka.timeline.events`) instructs the gateway to flush.

---

## 📈 Observability

* **Structured Logging** – Pino w/ ECS format → ElasticSearch.  
* **Metrics** – Prometheus (`/metrics`) + Grafana dashboards.  
* **Tracing** – OpenTelemetry + Jaeger (100% sampled on dev, 5% prod).  
* **Health Checks** – `/healthz` (fast), `/readyz` (deep, incl. downstream).  

---

## 🧪 Testing Sandbox

A disposable environment (`api-sandbox.socialpulse.dev`) auto-deploys each main branch commit.  
Use `X-SANDBOX-TOKEN` (GitHub OIDC) for authentication.

---

## 📚 Change Log (excerpt)

| Version | Date       | Highlights                                  |
|---------|------------|---------------------------------------------|
| 1.3.0   | 2024-03-20 | GraphQL Subscriptions GA, `/v1/posts` media support |
| 1.2.2   | 2024-02-28 | Rate-limit adjustments, error envelope v2   |
| 1.2.0   | 2024-02-14 | Response caching for timelines             |
| 1.1.0   | 2023-12-10 | Introduced `/v1/stories`                    |
| 1.0.0   | 2023-11-01 | Initial public release                      |

---

## 🆘 Support

* Slack: `#socialpulse-api-gateway`
* Email: `platform@socialpulse.dev`
* Status Page: [status.socialpulse.dev](https://status.socialpulse.dev)

Enjoy building with SocialPulse!