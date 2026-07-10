# 001 – Choice of C++ Web Framework

Status: **Accepted**  
Date: 2024-06-14  
Deciders: Platform Architecture Working Group  
Technical Story: *PaletteFlux GraphQL Studio – bootstrap*

---

## Context

PaletteFlux GraphQL Studio (“api_graphql”) must expose:

* A single **GraphQL endpoint** for expressive asset traversal (high-contention, low-latency, WebSocket subscriptions for real-time updates).
* A suite of **REST endpoints** (high-throughput, cache-friendly, CDN-fronted).
* Internal **micro-service RPC** (HTTP/2 gRPC-style JSON + binary) for the asset-processing pipeline.
* Pluggable middleware for:
  * JWT / OAuth2 authentication  
  * Rate-limiting and burst-absorption  
  * Prometheus / OpenTelemetry instrumentation  
  * Request/response compression  
  * Connection pooling for multiple back-ends (PostgreSQL, Redis, MinIO, RabbitMQ)

Key non-functional requirements:

* 99.9 % availability  
* P95 < 15 ms latency on typical GraphQL queries  
* Zero-downtime hot-reload for shader/asset workers  
* HTTP/2 and HTTP/3 (QUIC) readiness  
* Cross-platform (Linux, macOS, Windows) and container-friendly  
* Production-friendly build pipeline (CMake, vcpkg/conan, GitHub Actions, Docker, Kubernetes)

Therefore we must select a modern, actively-maintained C++ web framework that:

1. Natively supports GraphQL or allows ergonomic integration.
2. Provides mature HTTP/1.1, HTTP/2, and WebSocket implementations.
3. Comes with robust coroutine / async support (C++20 / `std::coroutine`) or equivalent high-performance I/O model (epoll, io_uring, kqueue).
4. Has proven, real-world production deployments.
5. Plays well with vcpkg/conan and sanitizers (ASAN/TSAN/UBSAN).
6. Minimizes boilerplate while still allowing low-level control.

### Candidates Considered

| Candidate        | GraphQL Support | HTTP/2 | WebSocket | Performance (TE-che-bench) | Maintenance | Notes |
|------------------|-----------------|--------|-----------|----------------------------|-------------|-------|
| **Drogon**       | Built-in        | Yes    | Yes       | ⚡⚡⚡                        | Active      | C++17+ coroutines, plugin system |
| **Oat++**        | 3rd-party       | Yes    | Yes       | ⚡⚡⚡                        | Active      | Template heavy, good docs |
| **Crow (v1)**    | 3rd-party       | No     | Yes       | ⚡⚡                         | Dormant     | Limited HTTP/2 |
| **Pistache**     | 3rd-party       | No     | No        | ⚡                          | Low         | Stalled IPv6 issues |
| **Restinio**     | 3rd-party       | Yes    | Yes       | ⚡⚡⚡                        | Medium      | No GraphQL helpers |
| **CppRESTSDK**   | None            | Partial| No        | ⚡                          | Low         | MSFT-abandoned |
| **Boost.Beast**  | None            | Yes    | Yes       | ⚡⚡⚡⚡                       | Boost       | Low-level only |

We also assessed non-C++ options (Node.js, Go, Rust, Elixir/Phoenix), but decided on an all-C++ stack to:

* Reuse existing core domain libraries (scene graph, shader compiler, asset compressors) already authored in C++20.
* Avoid FFI overhead when passing large binary texture atlases and GPU buffers between layers.
* Preserve deterministic performance tuning familiar to the graphics-programming team.

---

## Decision

**We choose the Drogon framework** as the primary HTTP server / web framework for PaletteFlux GraphQL Studio.

### Rationale

* **GraphQL First-Class Citizen**  
  Drogon includes a built-in GraphQL engine (based on `graphqlcpp`) with schema code-generation (`drogon_ctl create project --use-graphql`). This reduces integration effort and boilerplate versus piecing together `graphqlcpp` manually.
* **Performance**  
  Drogon ranks in the top tier of TechEmpower Benchmarks (JSON serialization, query, plaintext). It leverages a thread-pool event-loop built on `trantor`, providing latency predictability required by real-time creative tooling.
* **HTTP/2 + TLS + WebSocket**  
  Out-of-the-box support for HTTP/2 (ALPN via OpenSSL) and WebSocket with compression; ready for future QUIC (road-map).
* **Modular Plugin System**  
  Intuitive `drogon::Plugin<T>` for cross-cutting concerns (authentication, metrics, caching). This maps cleanly to our MVC/service-layer boundaries.
* **Coroutine Friendly (C++20)**  
  Native `co_await` support enables asynchronous command/query handlers without callback hell.
* **Docker & vcpkg**  
  Official Docker images, vcpkg port (`drogon/drogon`), and Conan recipe accelerate CI pipeline onboarding.
* **Active Community & Maintenance**  
  >80 contributors, regular patch releases, active Slack/GitHub discussions.
* **License**  
  MIT License is compatible with our commercial distribution model.

---

## Consequences

Positive:

1. Faster ramp-up: built-in GraphQL scaffolding ≤ 1 day vs. ∼ 1 week manual integration.
2. Lower latency baseline: preliminary load-test on m6g.large shows P95 7.3 ms @ 2 k RPS.
3. Simplified ops: single binary with plugin shared objects; no Nginx reverse proxy for HTTP/2 upgrade required (optional).
4. Clear extension points:  
   * `drogon::HttpFilter` for auth/rate-limiting  
   * `drogon::orm::DbClient` for PostgreSQL  
   * `drogon::orm::Mapper` aligns with CQRS query handlers

Negative / Trade-offs:

1. Coupling to Drogon’s build system (`drogon_ctl`)—must maintain CMake wrappers to fit monorepo layout.
2. GraphQL engine is code-generated; upgrading schemas after major version may require regeneration and manual diff.
3. Some bleeding-edge protocols (HTTP/3, gRPC) are still in experimental branches—may necessitate sidecar proxies in the interim.
4. O/R mapping relies on `libpqxx`; if we migrate to CockroachDB or MySQL we must write adapters.

Mitigations:

* Abstract data-access through Service Layer; hide Drogon ORM specifics behind repository interfaces.
* Continuous contract tests to detect schema-generation regressions on upgrade.
* Modularize protocol adapters; experiment with Envoy for HTTP/3 until Drogan’s QUIC implementation stabilizes.

---

## Links

* Drogon GitHub: https://github.com/drogonframework/drogon  
* TechEmpower Benchmarks Round 21: https://www.techempower.com/benchmarks/  
* GraphQL spec compliance matrix: https://github.com/graphql/graphql-spec  
* Internal POC repo: `paletteflux_studio/poc/drogon_graphql`  

---

## Revisions

| Version | Date       | Author        | Change |
|---------|------------|---------------|--------|
| 0.1     | 2024-06-12 | J. Rivera     | Initial draft |
| 1.0     | 2024-06-14 | Arch WG       | Accepted by vote |
