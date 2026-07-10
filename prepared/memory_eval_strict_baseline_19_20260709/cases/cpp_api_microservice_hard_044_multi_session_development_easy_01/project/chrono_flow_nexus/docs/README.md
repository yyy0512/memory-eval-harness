```markdown
<p align="center">
  <img height="140" src="https://raw.githubusercontent.com/chronoflow/nexus/main/.github/assets/logo.svg" alt="ChronoFlow Nexus Logo"/>
  <h1 align="center">ChronoFlow Nexus</h1>
  <p align="center">
    High-performance C++ microservice for time-tracking, task analytics, and team workload insights.
  </p>
</p>

[![CI](https://github.com/chronoflow/nexus/actions/workflows/ci.yml/badge.svg)](https://github.com/chronoflow/nexus/actions/workflows/ci.yml)
[![Coverage Status](https://codecov.io/gh/chronoflow/nexus/branch/main/graph/badge.svg)](https://codecov.io/gh/chronoflow/nexus)
[![License](https://img.shields.io/github/license/chronoflow/nexus)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/chronoflow/nexus)](https://hub.docker.com/r/chronoflow/nexus)

---

ChronoFlow Nexus unifies time-tracking, task analytics, and flow-state metrics behind an ultra-low-latency ***versioned*** API.  
It delivers both REST and GraphQL interfaces, supports adaptive rate-limiting, response caching, and offers **first-class observability** out of the box.

```
Transport  ─┐
            │     REST / GraphQL
Interface ──┼──►  Controllers, DTOs
            │
Application ─┼──►  CQRS, Orchestrators, Policies
            │
Domain ─────┼──►  Aggregates, Value Objects, Domain Events
            │
Infrastructure►   DB, Cache, Message Broker, External APIs
```

-------------------------------------------------------------------------------

## ✨ Feature Highlights

* 🔌 Dual API surface (JSON:API & GraphQL 16.0)
* ⚡ Ultra-fast: ~70 µs p99 latency @ 5 k rps on commodity hardware
* 🧠 Real-time focus analytics (context switch frequency, flow-state interruptions)
* 🔒 OAuth 2.1 / OpenID Connect with built-in rate-limit buckets
* 🔭 Observable: OTLP tracing, Prometheus metrics, JSON log enrichment
* ⏱ 3-tier adaptive caching (in-process LRU ➜ Redis ➜ CDN)
* 🗄️ Soft multi-tenant with tenant-scoped sharding policy
* 📦 Zero-downtime **blue/green** deployments via API gateway façade

## 🏗️ Quick Start

### 1. Prerequisites

* C++20-capable compiler (GCC 12+, Clang 14+, MSVC 19.3+)
* CMake 3.24+
* Conan 2.0 (dependency manager)
* Docker 20.10+ (for infrastructure stack)

### 2. Clone & Bootstrap

```bash
git clone https://github.com/chronoflow/nexus.git
cd nexus
./scripts/bootstrap.sh        # fetch submodules + conan profile detection
docker compose up -d infra    # Postgres, Redis, Jaeger, Nginx gateway
```

### 3. Build & Run

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
./build/bin/chrono_flow_nexus --config=config/local.yml
```

The service becomes available at `http://localhost:8080/api/v1`.

## 🖥️ REST Example

```
GET /api/v1/users/42/flow-stats?interval=7d HTTP/1.1
Host: localhost:8080
Authorization: Bearer <token>
```

Response:

```json
{
  "userId": 42,
  "interval": "2023-10-22T00:00:00Z/2023-10-29T00:00:00Z",
  "deepWorkHours": 32.4,
  "contextSwitches": 18,
  "focusRate": 78.3,
  "interruptions": [
    { "timestamp": "2023-10-24T13:04:52Z", "type": "meeting" },
    { "timestamp": "2023-10-25T16:22:19Z", "type": "notification" }
  ]
}
```

### Pagination (RFC 8288 style)

```
GET /api/v1/tasks?limit=25&cursor=eyJpZCI6MTAwMX0= HTTP/1.1
Link: <.../tasks?cursor=eyJpZCI6MTAxOH0=&limit=25>; rel="next"
```

## 🔎 GraphQL Example

```graphql
query WeeklySnapshot($user: ID!, $from: DateTime!, $to: DateTime!) {
  flowSnapshot(userId: $user, from: $from, to: $to) {
    deepWorkHours
    contextSwitchFrequency
    taskBreakdown {
      project
      taskType
      duration
    }
  }
}
```

curl:

```bash
curl -X POST http://localhost:8080/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @- <<'EOF'
{
  "query": "query($u:ID!, $f:DateTime!, $t:DateTime!){ flowSnapshot(userId:$u, from:$f, to:$t){ deepWorkHours contextSwitchFrequency } }",
  "variables": {
    "u": "42",
    "f": "2023-10-22T00:00:00Z",
    "t": "2023-10-29T00:00:00Z"
  }
}
EOF
```

## 🛠️ C++ Client Snippet

```cpp
#include <nexus/client/RestClient.hpp>
#include <iostream>

int main()
{
    using namespace chrono::nexus::client;

    try {
        RestClient client{
            RestClient::Config{
                .baseUrl = "http://localhost:8080",
                .authProvider = std::make_shared<OAuthProvider>("client_id", "client_secret")
            }
        };

        auto stats = client
            .path("api/v1")
            .path("users")
            .path(42)
            .path("flow-stats")
            .query("interval", "7d")
            .get<dto::FlowStats>();

        std::cout << "Focus rate ⇒ " << stats.focusRate << "%\n";
    }
    catch (const RestError& e) {
        std::cerr << "REST error: " << e.what() << '\n';
    }
}
```

The above snippet relies on the thin-header C++ client shipped in `nexus/sdk/`.  
See `sdk/README.md` for full documentation.

## 🌐 Configuration

Configuration is YAML-based (with environment overrides) and validated at startup.

```yaml
server:
  host: 0.0.0.0
  port: 8080
  cors:
    origins: ["*"]
    max_age: 3600

database:
  dsn: postgres://nexus:password@db:5432/nexus
  pool_size: 20

cache:
  redis_uri: redis://cache:6379/0
  ttl_seconds: 300

security:
  oauth:
    issuer: https://auth.mycorp.io
    audience: chronoflow-nexus
```

Environment variables may override any leaf value by matching the key path in uppercase:
`NEXUS__DATABASE__DSN="postgres://..."`.

## 🚥 Observability

ChronoFlow Nexus ships with an opinionated OTEL pipeline:

* **Traces** ➜ Jaeger (`/traces`)
* **Metrics** ➜ Prometheus (`/metrics`)
* **Logs**   ➜ Loki (`/logs`)

Enable debug traces locally:

```bash
export NEXUS__OTLP__ENDPOINT=http://localhost:4318
export NEXUS__LOG_LEVEL=trace
```

## 🩹 Common Issues

| Symptom                              | Cause / Fix                                                   |
|--------------------------------------|---------------------------------------------------------------|
| `HTTP 429 Too Many Requests`         | Rate-limit exceeded. Check `X-RateLimit-*` headers.           |
| Startup fails with `migrations…`     | DB not available / wrong DSN. Re-run `docker compose up -d`. |
| `jwt: invalid audience`              | Verify `security.oauth.audience` matches token's `aud`.      |

## 🧪 Development

```bash
# Run unit tests + static analysis
./scripts/test.sh

# Hot-reload service (compile-less REST & GraphQL changes)
watchexec --restart --exts cpp,hpp,yml,graphql -w src -- ./scripts/run_local.sh
```

Static analysis enforced:

* clang-tidy (Modernize, Readability, Bugprone)
* cpp-core-guidelines
* include-what-you-use

## 🤝 Contributing

1. Fork ➜ Create feature branch (`git checkout -b feat/amazing`)
2. Commit as Conventional Commits (`feat: add amazing`)
3. Ensure `./scripts/test.sh` passes
4. PR into `dev` branch

All contributors must read the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📜 License

ChronoFlow Nexus is released under the **MIT License**.  
© 2024 ChronoFlow Org.

---
*Crafted with focus by the ChronoFlow team. Keep flowing!*  
```