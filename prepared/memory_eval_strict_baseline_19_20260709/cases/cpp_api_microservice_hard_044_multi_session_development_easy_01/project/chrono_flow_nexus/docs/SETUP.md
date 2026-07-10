```md
# ChronoFlow Nexus – Setup Guide
Everything you need to bootstrap a **local development** or **production** instance of ChronoFlow Nexus—our high-performance C++ micro-service that delivers unified REST + GraphQL analytics for time-tracking and productivity insights.

---

## 1. Quick-start (TL;DR)

```bash
git clone https://github.com/your-org/chrono_flow_nexus.git
cd chrono_flow_nexus

# Spin up an entire dev cluster (API + Postgres + Redis) inside Docker
make dev-up

# Watch the logs
make tail

# Hit the health-check
curl -s http://localhost:8080/v1/health | jq
```

---

## 2. Prerequisites

| Dependency | Minimum Version | Why we need it |
|------------|----------------|----------------|
| CMake      | 3.22           | Modern tool-chain & presets |
| C++        | 20 (GCC 11 / Clang 14 / MSVC v143) | Concepts, `std::source_location`, ranges |
| Docker     | 24             | Containerized local stack |
| vcpkg      | 2023.10-22     | Cross-platform package manager |
| Python     | 3.9            | Developer tooling (`scripts/*.py`) |
| Git LFS    | latest         | Stores sample data fixtures |
| PostgreSQL | 15             | Primary data store |
| Redis      | 7              | Response caching & rate-limiting |

> macOS users: install Xcode 15 before attempting to compile, then run  
> `brew bundle` from the repo root to fetch Homebrew dependencies.

---

## 3. Directory Overview

```
chrono_flow_nexus/
  ├─ .cmake/                 # Toolchain and CMake presets
  ├─ config/                 # YAML configuration templates
  ├─ docker/                 # Dockerfiles & compose overrides
  ├─ graphql/                # SDL schema & resolvers
  ├─ scripts/                # Utility scripts (Python/Bash)
  ├─ src/                    # Production C++ code
  ├─ test/                   # Unit & integration tests
  ├─ docs/                   # MkDocs site (this file lives here)
  └─ vcpkg.json              # Declarative dependency list
```

---

## 4. Bootstrapping a Local Development Environment

### 4.1 Clone + Submodules

```bash
git clone --recurse-submodules https://github.com/your-org/chrono_flow_nexus.git
```

### 4.2 Install vcpkg Dependencies

```bash
./scripts/bootstrap_vcpkg.sh          # Local helper script
cmake --preset dev ‑-toolchain vcpkg  # Generates ./build
cmake --build build ‑j$(nproc)        # Compiles everything
```

`vcpkg.json` pins versions for:

* Boost (1.83) – networking, beast
* cpp-graphqlgen – GraphQL schema → C++ types
* nlohmann-json – JSON (REST)
* spdlog + fmt – structured logging
* openapi-generator – Code-gen for REST docs
* jaeger-tracing – distributed tracing

### 4.3 Environment Variables

Rename and tweak the sample:

```bash
cp config/.env.sample config/.env
```

Key variables:

```dotenv
CFN_PG_CONNECTION=postgresql://chrono:chrono@localhost:5432/chrono
CFN_REDIS_URI=redis://localhost:6379
CFN_HTTP_PORT=8080
CFN_RATE_LIMIT_PER_MIN=900
CFN_JAEGER_ENDPOINT=http://localhost:14268/api/traces
```

The binary auto-loads any `*.env` files located in `config/`.

### 4.4 Database Migration

```bash
make db-up          # Starts Postgres in Docker
make migrate        # Runs Flyway migrations
```

Migrations live in `infrastructure/sql/migrations/*`.

### 4.5 Running the Service

```bash
./build/bin/chrono_flow_nexus --config config/app.yaml
```

Hot-reload is provided by [`fswatch`](https://github.com/emcrisostomo/fswatch) and SIGHUP:  
changing `app.yaml` automatically updates rate limits, log levels, etc.

---

## 5. Dockerized Workflow

The repo ships with an opinionated `docker-compose.yml`.

```bash
make dev-up          # compose-up with hot-reload volumes
make dev-down        # tear it all down
make tail            # follow logs for all services
```

Services exposed:

| Container            | Port | Purpose                              |
|----------------------|------|--------------------------------------|
| chronoflow-nexus     | 8080 | REST/GraphQL API                     |
| postgres             | 5432 | DB                                   |
| redis                | 6379 | Caching & semaphore rate-limits      |
| jaeger               | 16686| Tracing UI                           |
| nginx-gateway        | 80   | API Gateway façade                   |

---

## 6. Production Build

```bash
cmake --preset release ‑DCFN_ENABLE_LTO=ON
cmake --build build/release ‑j$(nproc)
strip build/release/bin/chrono_flow_nexus
```

To publish a multi-arch image:

```bash
docker buildx bake --push
```

> Images follow semantic tags: `ghcr.io/your-org/chronoflow-nexus:{major}.{minor}.{patch}`

### 6.1 Systemd Unit

```ini
# /etc/systemd/system/chronoflow-nexus.service
[Unit]
Description=ChronoFlow Nexus API microservice
After=network.target postgres.service redis.service

[Service]
User=chronoflow
Group=chronoflow
EnvironmentFile=/etc/chronoflow/.env
ExecStart=/opt/chronoflow/bin/chrono_flow_nexus --config /etc/chronoflow/app.yaml
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chronoflow-nexus
```

---

## 7. Testing & Quality Gates

```bash
cmake --preset dev -DCFN_ENABLE_TESTS=ON
cmake --build build && ctest --test-dir build -V
```

Additional gates:

* `make clang-format`  – style guide
* `make clang-tidy`    – static analysis
* `make coverage`      – GCov + lcov HTML report
* `make bench`         – C++ Micro-benchmarks (Google Benchmark)

Pre-commit hooks ensure every push meets the bar.

---

## 8. API Exploration

Once the service is live:

REST (OpenAPI):
```
GET http://localhost:8080/v1/docs
```

GraphQL playground:
```
POST http://localhost:8080/graphql
```
Point your browser to `http://localhost:8080/graphiql` for an interactive UI.

---

## 9. Common Issues

1. **Build can’t find Boost.**  
   `export VCPKG_ROOT=~/vcpkg && ./scripts/bootstrap_vcpkg.sh`

2. **Database connection refused.**  
   Check `docker ps`—the Postgres container restarts if the volume is locked.

3. **Ports already in use.**  
   Another app is binding 8080; update `CFN_HTTP_PORT` in `.env`.

4. **SSL certificate errors in Docker** (corporate proxies).  
   Mount your CA bundle:  
   `docker-compose --file docker/docker-compose.yaml --file docker/docker-compose.proxy.yaml up`

---

## 10. Contribution Workflow

1. Fork → Feature branch  
2. `make dev-up`  
3. Write code + tests  
4. Lint: `make lint`  
5. Create PR → CI runs **Build / Test / Scan / Deploy-Preview**  
6. Review passes → squash & merge

---

## 11. Security Notes

* Secrets **never** go in Git—inject via Vault or Kubernetes Secrets.
* All outbound traffic is pinned via `TLSv1.3` (`libcurl` FIPS build).
* Compile flags: `-D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wl,-z,relro,-z,now`.

---

## 12. Further Reading

* Architecture decision records – `docs/adr/*.md`
* Domain model – `docs/domain/*.puml`
* Scalability playbook – `docs/ops/scaling.md`
* GraphQL schema – `graphql/schema.graphql`

Happy hacking—may your build times be short and your latencies even shorter! 🚀
```