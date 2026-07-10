```markdown
# ChronoFlow Nexus — API Guide  
*Last updated: 2024-05-29*  

> ChronoFlow Nexus is a high-performance C++ micro-service that consolidates time-tracking, task analytics, and team workload signals under a single, versioned API surface.  
> This document **is the canonical reference for integrators**—it captures every public REST route, GraphQL entry-point, and cross-cutting concern (authentication, pagination, rate-limits, caching, and observability).

---

## Contents
1. Getting Started  
2. Authentication & Authorization  
3. Service Discovery & Versioning  
4. REST Endpoints  
5. GraphQL Schema  
6. Pagination & Filtering  
7. Rate Limiting  
8. Response Caching  
9. Event Webhooks  
10. Error Handling  
11. Client Code Examples (C++)  
12. FAQ  

---

## 1 – Getting Started

The API can be consumed over **HTTP/2** with **TLS 1.3** (mandatory in production). Sandbox & staging targets are also exposed via HTTPS but may run on reduced infrastructure.

| Environment | Base URL |
|-------------|----------|
| Production  | `https://api.chrono.example.com/v1` |
| Staging     | `https://staging.api.chrono.example.com/v1` |
| Sandbox     | `https://sandbox.api.chrono.example.com/v1` |

> Traffic **must** be routed through ChronoFlow’s API Gateway. The gateway handles authentication, rate-limiting, protocol negotiation, canary releases, and on-the-fly schema upgrades.

---

## 2 – Authentication & Authorization

ChronoFlow uses **JSON Web Tokens (JWT)** signed with RS256.

1. `POST /auth/token` – exchange your client credentials for a short-lived access token.  
2. Include `Authorization: Bearer <token>` for subsequent requests.  
3. Tokens expire after **15 minutes**; refresh tokens last **24 hours**.

**Scopes**

| Scope | Description |
|-------|-------------|
| `tasks:read`  | Read task data |
| `tasks:write` | Create / update / delete tasks |
| `analytics:read` | Access time-series analytics |
| `admin` | Administrative access |

> Fine-grained scopes let you issue tokens for service accounts that only do *exactly* what is required.

---

## 3 – Service Discovery & Versioning

### Semantic Versioning

The public contract follows **SemVer** (`MAJOR.MINOR.PATCH`):

* A bump in **MAJOR** introduces breaking changes.  
* **MINOR** adds backwards-compatible functionality.  
* **PATCH** fixes defects.

```http
GET /v1/tasks/…
```

When a new version is released (`/v2`), the predecessor stays operational for **18 months**.

---

## 4 – REST Endpoints

### 4.1 Tasks

Retrieve paginated tasks:

```http
GET /v1/tasks?assignee=me&state=open&page=1&pageSize=50
Accept: application/json
```

Response (200):

```json
{
  "meta": {
    "page": 1,
    "pageSize": 50,
    "totalPages": 3,
    "next": "/v1/tasks?assignee=me&state=open&page=2&pageSize=50"
  },
  "data": [
    {
      "id": "task_24e3889d",
      "title": "Implement caching middleware",
      "state": "open",
      "estimateMinutes": 420,
      "createdAt": "2024-05-02T14:33:11Z"
    }
  ]
}
```

#### Create task

```http
POST /v1/tasks
Content-Type: application/json
```

Body:

```json
{
  "title": "Write API guide",
  "estimateMinutes": 90,
  "assigneeId": "user_c42c6dda"
}
```

Success (201):

```json
{
  "id": "task_b1a74f23",
  "links": { "self": "/v1/tasks/task_b1a74f23" }
}
```

### 4.2 Time-Entries

```
GET /v1/time-entries?from=2024-05-01&to=2024-05-31
```

Returns tracked intervals, enriched with task mapping.

### 4.3 Analytics

```
GET /v1/analytics/flow-state?user=me&period=last-7d
```

Delivers KPIs:

```json
{
  "focusRatio": 0.73,
  "contextSwitches": 14,
  "timeOnTaskMinutes": 2280
}
```

---

## 5 – GraphQL Schema

ChronoFlow ships a comprehensive GraphQL surface @ `/v1/graphql`.

```graphql
# Retrieve a single developer’s focus metrics
query Focus($userId: ID!, $days: Int!) {
  user(id: $userId) {
    focusAnalytics(lastDays: $days) {
      date
      focusRatio
      deepWorkMinutes
    }
  }
}
```

Variables:

```json
{ "userId": "user_c42c6dda", "days": 7 }
```

Sample response:

```json
{
  "data": {
    "user": {
      "focusAnalytics": [
        { "date": "2024-05-23", "focusRatio": 0.68, "deepWorkMinutes": 264 },
        { "date": "2024-05-24", "focusRatio": 0.71, "deepWorkMinutes": 284 }
      ]
    }
  }
}
```

### Schema SDL (excerpt)

```graphql
type Query {
  task(id: ID!): Task
  tasks(filter: TaskFilter, pagination: Pagination!): TaskConnection!
  analytics(userId: ID!, period: Period!): Analytics!
}

type Task {
  id: ID!
  title: String!
  state: TaskState!
  estimateMinutes: Int
  assignee: User!
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

---

## 6 – Pagination & Filtering

The REST layer uses **cursor** or **page-based** strategies depending on resource type. `tasks` adopt page-based pagination; analytics use cursor-based.

Header `X-Has-More` is `true` when additional results are available.

GraphQL implements [Relay](https://relay.dev/) connections:

```graphql
{
  tasks(pagination:{first:50, after:"opaqueCursor"}) {
    edges { node { id title } }
    pageInfo { hasNextPage endCursor }
  }
}
```

---

## 7 – Rate Limiting

ChronoFlow Nexus enforces a token bucket:

* 2500 requests / 5-minute window / client  
* Burstable to 200 requests instantly  

Headers:

```
X-RateLimit-Limit: 2500
X-RateLimit-Remaining: 1842
X-RateLimit-Reset: 1717008000
```

429 responses include a `Retry-After` header (seconds).

---

## 8 – Response Caching

Read-heavy endpoints (`GET /v1/analytics/**`, `GET /v1/tasks`) are cached for **30 seconds** by default.

Headers:

```
Cache-Control: public, max-age=30, stale-while-revalidate=15
ETag: "a79007b8201"
```

The gateway also supports [RFC 5861] *stale-while-revalidate*, meaning stale data can be served for 15 seconds while the cache refreshes asynchronously.

GraphQL caching leverages persisted-queries & automatic persisted operations (APQ) keyed on SHA-256 of the query string.

---

## 9 – Event Webhooks

ChronoFlow can push events to your service:

```
POST https://<your-endpoint>/chrono/webhook
Content-Type: application/cloudevents+json
specversion: "1.0"
type: "com.chronoflow.task.updated"
```

Verify signature header `X-Chrono-Signature` using your shared Webhook Secret.

---

## 10 – Error Handling

Errors adhere to [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) (Problem Details):

```json
{
  "type": "https://docs.chrono.example.com/errors/validation_error",
  "title": "Payload validation failed",
  "status": 400,
  "detail": "Field 'title' must not be empty",
  "instance": "/v1/tasks",
  "correlationId": "req_89db2bf0"
}
```

| Status | Meaning | Retries? |
|--------|---------|----------|
| 400    | Client input invalid | ❌ |
| 401    | Missing/invalid token | ❌ |
| 403    | Insufficient scope   | ✱ (after permission fix) |
| 404    | Resource not found   | ❌ |
| 409    | Conflict             | ✱ (idempotent clients) |
| 429    | Rate limit exceeded  | ✔ (after `Retry-After`) |
| 5xx    | Server error         | ✔ (exponential back-off) |

---

## 11 – Client Code Examples (C++)

Below is a minimal but production-ready snippet using **Boost.Beast** & **Boost.JSON**.  It:

1. Authenticates (JWT token retrieval)  
2. Fetches paginated tasks  
3. Implements retry logic with exponential back-off  

```cpp
// ChronoFlowClient.hpp
#pragma once

#include <boost/beast/http.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/json.hpp>
#include <boost/asio/steady_timer.hpp>

#include <chrono>
#include <string>
#include <vector>

namespace chrono_flow::client {

class ClientError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct Task {
    std::string id;
    std::string title;
    std::string state;
    int         estimateMinutes;
};

// ----------------------------------------------------------------
// ChronoFlowClient
// ----------------------------------------------------------------
class ChronoFlowClient final {
public:
    ChronoFlowClient(boost::asio::io_context& io,
                     boost::asio::ssl::context& ssl,
                     std::string clientId,
                     std::string clientSecret,
                     std::string apiBase = "api.chrono.example.com",
                     std::chrono::milliseconds timeout = std::chrono::seconds(10));

    std::vector<Task> listTasks(int page, int pageSize);

private:
    // Networking helpers
    boost::json::value postUrlencoded(const std::string& target,
                                      const std::string& body);
    boost::json::value getJson(const std::string& target,
                               int               remainingRetries = 3);

    void ensureToken();

    // Members
    boost::asio::io_context&        io_;
    boost::asio::ssl::context&      ssl_;
    std::string                     clientId_;
    std::string                     clientSecret_;
    std::string                     apiBase_;
    std::string                     jwtToken_;
    std::chrono::steady_clock::time_point tokenExpiry_;
    std::chrono::milliseconds       timeout_;
};

} // namespace chrono_flow::client
```

```cpp
// ChronoFlowClient.cpp
#include "ChronoFlowClient.hpp"
#include <boost/beast/ssl.hpp>
#include <boost/beast/version.hpp>
#include <boost/beast/core/flat_buffer.hpp>
#include <boost/beast/http/string_body.hpp>
#include <boost/url/encode.hpp>

using namespace chrono_flow::client;
namespace http = boost::beast::http;

static auto now() { return std::chrono::steady_clock::now(); }

ChronoFlowClient::ChronoFlowClient(boost::asio::io_context& io,
                                   boost::asio::ssl::context& ssl,
                                   std::string clientId,
                                   std::string clientSecret,
                                   std::string apiBase,
                                   std::chrono::milliseconds timeout)
    : io_(io)
    , ssl_(ssl)
    , clientId_(std::move(clientId))
    , clientSecret_(std::move(clientSecret))
    , apiBase_(std::move(apiBase))
    , timeout_(timeout) {}

void ChronoFlowClient::ensureToken() {
    if (!jwtToken_.empty() && now() < tokenExpiry_ - std::chrono::seconds(10))
        return; // still valid

    const std::string body = "clientId="   + boost::urls::encode_component(clientId_)   +
                             "&clientSecret=" + boost::urls::encode_component(clientSecret_);

    auto val = postUrlencoded("/auth/token", body);
    jwtToken_   = boost::json::value_to<std::string>(val.at("accessToken"));
    const int expSec = boost::json::value_to<int>(val.at("expiresIn"));
    tokenExpiry_ = now() + std::chrono::seconds(expSec);
}

boost::json::value ChronoFlowClient::postUrlencoded(const std::string& target,
                                                    const std::string& body) {
    // For brevity, the SSL handshake, DNS resolution, and connection pooling
    // are abstracted away behind beast::ssl_stream + helper utils not shown.
    // Production code should reuse connections and handle SNI/ALPN.
    boost::beast::ssl_stream<boost::beast::tcp_stream> stream(io_, ssl_);
    // ... resolve and connect ...

    http::request<http::string_body> req{http::verb::post, target, 11};
    req.set(http::field::host, apiBase_);
    req.set(http::field::content_type, "application/x-www-form-urlencoded");
    req.set(http::field::user_agent,  "ChronoFlowCPP/1.0");
    req.body() = body;
    req.prepare_payload();

    http::write(stream, req);

    boost::beast::flat_buffer buffer;
    http::response<http::string_body> res;
    http::read(stream, buffer, res);

    if (res.result() != http::status::ok) {
        throw ClientError("Token endpoint failed: " + res.reason().to_string());
    }

    return boost::json::parse(res.body());
}

boost::json::value ChronoFlowClient::getJson(const std::string& target,
                                             int remainingRetries) {
    ensureToken();

    boost::beast::ssl_stream<boost::beast::tcp_stream> stream(io_, ssl_);
    http::request<http::empty_body> req{http::verb::get, target, 11};
    req.set(http::field::host, apiBase_);
    req.set(http::field::authorization, "Bearer " + jwtToken_);
    req.set(http::field::accept, "application/json");
    req.set(http::field::user_agent, "ChronoFlowCPP/1.0");

    http::write(stream, req);

    boost::beast::flat_buffer buffer;
    http::response<http::string_body> res;
    http::read(stream, buffer, res);

    if (res.result() == http::status::too_many_requests && remainingRetries > 0) {
        auto retryAfter = res.base().has(http::field::retry_after)
                              ? std::stoi(res.base()[http::field::retry_after].to_string())
                              : 1;
        std::this_thread::sleep_for(std::chrono::seconds(retryAfter));
        return getJson(target, remainingRetries - 1);
    }
    if (res.result() >= http::status::bad_request) {
        throw ClientError("GET " + target + " failed: " + res.reason().to_string());
    }
    return boost::json::parse(res.body());
}

std::vector<Task> ChronoFlowClient::listTasks(int page, int pageSize) {
    const std::string uri = "/v1/tasks?page=" + std::to_string(page) +
                            "&pageSize=" + std::to_string(pageSize);

    auto json = getJson(uri);
    std::vector<Task> out;
    for (auto& item : json.at("data").as_array()) {
        out.push_back(Task{
            .id              = boost::json::value_to<std::string>(item.at("id")),
            .title           = boost::json::value_to<std::string>(item.at("title")),
            .state           = boost::json::value_to<std::string>(item.at("state")),
            .estimateMinutes = boost::json::value_to<int>(item.at("estimateMinutes"))
        });
    }
    return out;
}
```

Usage:

```cpp
#include "ChronoFlowClient.hpp"
#include <boost/asio.hpp>
#include <boost/asio/ssl.hpp>
#include <iostream>

int main() {
    boost::asio::io_context io;
    boost::asio::ssl::context sslCtx{boost::asio::ssl::context::tls_client};
    sslCtx.set_default_verify_paths();

    chrono_flow::client::ChronoFlowClient cli(
        io, sslCtx,
        "demo-client-id",
        "super-secret");

    const auto tasks = cli.listTasks(/*page*/1, /*pageSize*/25);
    for (const auto& t : tasks)
        std::cout << t.id << " → " << t.title << '\n';
}
```

Compile:

```bash
g++ -std=c++20 -O3 -lboost_system -lssl -lcrypto \
    ChronoFlowClient.cpp demo.cpp -o demo
```

---

## 12 – FAQ

**Q:** *Which HTTP version do you recommend?*  
**A:** HTTP/2 for multiplexing; HTTP/1.1 still works.  

**Q:** *Do you support gRPC?*  
**A:** gRPC is available *internally* between Nexus micro-services. The public edge remains REST + GraphQL.  

**Q:** *How do breaking changes get announced?*  
**A:** At least 60 days in advance via developer bulletin, API Changelog, and the `/v1/status` feed.

---

## Contributing Feedback

Have suggestions? File an issue in our public GitHub or e-mail `api@chrono.example.com`.

---

© 2024 ChronoFlow Inc. All rights reserved.
```