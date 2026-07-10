```markdown
# PaletteFlux GraphQL Studio (`api_graphql`)
Creative-centric API platform for digital artists, game designers, and interactive storytellers  
*(C++17 / CMake / vcpkg / Conan)*  

[![CI](https://github.com/paletteflux/studio/actions/workflows/ci.yml/badge.svg)](https://github.com/paletteflux/studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=paletteflux_studio&metric=coverage)](https://sonarcloud.io/dashboard?id=paletteflux_studio)

---

## 1. Project Pitch
PaletteFlux GraphQL Studio exposes **real-time composition** and **remix pipelines** for multilayer visual assets over a single GraphQL endpoint while preserving compatibility with REST-oriented clients through *curated, cache-friendly* views.  
The runtime is built around a **strict MVC core**:

| Layer        | Responsibilities                                                                   |
|--------------|------------------------------------------------------------------------------------|
| **Model**    | Asset metadata, binary payloads, version graphs, ACLs                              |
| **View**     | Materialized views serialized to JSON, PNG atlases, GLSL snippets                  |
| **Controller**| Orchestrates command / query buses, validates input, emits domain events          |

Key engineering pillars:

* Service Layer + Command/Query Separation
* Pagination & Response Caching (ETag + HTTP 2 Server-Push)
* Schema versioning & deprecation paths
* Built-in structured monitoring (OpenTelemetry) & audit logging
* API-Gateway friendly (rate-limits, JWT authz, CORS contracts)

---

## 2. Quick Start (Developers)

### 2.1 Prerequisites
* CMake ≥ 3.20
* C++17-capable compiler (Clang 14 / GCC 11 / MSVC v143)
* [`vcpkg`](https://github.com/microsoft/vcpkg) *or* [`conan`](https://conan.io) for dependencies
* Node ≥ 18 (for playground UI & GraphQL schema stitching)
* PostgreSQL 14 / SQLite 3.40 (meta store)
* Redis ≥ 7 (cache & pub/sub, optional)

### 2.2 Clone & Build
```bash
git clone https://github.com/paletteflux/studio.git && cd studio
# bootstrap dependencies
./bootstrap.sh        # fetches vcpkg / conan and pins versions
# configure
cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=cmake/toolchains/vcpkg.cmake -DPALETTEFLUX_ENABLE_TESTS=ON
# build
cmake --build build --target all -j$(nproc)
# run unit + integration tests
ctest --test-dir build --output-on-failure
```

### 2.3 Launch Dev Cluster
```bash
docker compose -f docker/docker-compose.dev.yml up -d
# GraphQL Playground (Apollo) → http://localhost:4000/graphql
# REST Gateway              → http://localhost:8080/v1/
```

---

## 3. Code Tour

```
├── include/pfx            # Public C++ headers
│   ├── client             # High-level GraphQL / REST client
│   ├── core               # MVC, CQRS infrastructure
│   └── schema             # Generated C++ types from GraphQL schema
├── src
│   ├── client             # gRPC / HTTP adapters
│   ├── core               # Command bus, query bus, controllers
│   ├── graphql            # Resolver implementations
│   ├── monitoring         # OTEL exporters, Prometheus scrapers
│   └── rest               # Legacy REST controllers
└── tests                  # Catch2 + approval tests
```

---

## 4. Minimal C++ Example
```cpp
// file: examples/basic_upload.cpp
#include <pfx/client/StudioClient.hpp>
#include <pfx/core/AssetPayload.hpp>
#include <iostream>

using namespace pfx;

int main() try
{
    // StudioClient auto-retrieves JWT token from ~/.config/pfx/credentials.json
    auto client = client::StudioClient::create({
        .graphql_endpoint = "https://studio.paletteflux.io/graphql",
        .rest_endpoint    = "https://studio.paletteflux.io/v1"
    });

    // 1) Upload a new shader node via GraphQL mutation
    auto createReq = gql::CreateShaderNodeInput{
        .displayName   = "Volumetric Fog",
        .glslSource    = core::readFile("assets/shaders/volumetric_fog.glsl"),
        .authorId      = "user:eve",
        .tags          = { "fog", "volumetric", "environment" }
    };
    auto shaderNodeId = client->createShaderNode(createReq);

    // 2) Fetch paginated dependencies (REST fallback)
    auto deps = client->getDependencies(shaderNodeId, { .page = 0, .pageSize = 32 });
    std::cout << "dependencies: " << deps.size() << '\n';

    // 3) Stream flattened GLSL snippet for immediate compilation
    auto glslBundle = client->streamGlsl(shaderNodeId);
    std::cout << "bundle hash: " << glslBundle.etag << '\n';
}
catch (const std::exception& ex)
{
    std::cerr << "[error] " << ex.what() << '\n';
    return EXIT_FAILURE;
}
```

Compile example:
```bash
g++ -std=c++17 -Iinclude examples/basic_upload.cpp -o basic_upload \
    $(pkg-config --cflags --libs libcurl uuid) \
    -lpfx_studio_client -lssl -lcrypto
```

---

## 5. GraphQL Cheat-Sheet

```graphql
# List latest published assets (cursor-based pagination)
query LatestAssets($after: String) {
  assets(first: 10, after: $after, filter: { status: PUBLISHED }) {
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        kind            # SHADER_NODE, BRUSH_STROKE, SOUND_LAYER, ...
        displayName
        version         # Semantic version string
        createdAt
        previewUrl
      }
    }
  }
}

# Mutation – apply remix to multiple assets
mutation Remix($input: RemixAssetsInput!) {
  remixAssets(input: $input) {
    remixId
    compositePreviewUrl
    changelog
  }
}
```

---

## 6. Monitoring & Observability
PaletteFlux emits [OpenTelemetry](https://opentelemetry.io/) traces, metrics, and logs.

| Exporter        | Port  | Endpoint                                  |
|-----------------|-------|-------------------------------------------|
| OTLP (gRPC)     | 4317  | `0.0.0.0:4317`                            |
| Prometheus      | 9464  | `/metrics` (HTTP)                        |
| Jaeger (UDP)    | 6831  | `jaeger-agent` docker service             |

Enable locally:
```bash
export PFX_OTLP_ENDPOINT="http://localhost:4317"
export PFX_ENABLE_PROM=true
```

---

## 7. Versioning Strategy
* **GraphQL schema** follows [Apollo federation](https://www.apollographql.com/docs/federation/) with `@deprecated` tags and `v{major}` prefix namespaces.  
* **REST endpoints** are semver-prefixed (`/v1`, `/v2`) and shielded by an API Gateway for dark-launch.

Migration utilities live under `tools/migrations/`.

---

## 8. Contribution Guide
1. Fork and create a topic branch (`feature/<name>`).  
2. Run `./scripts/format.sh` (clang-format + markdown-lint).  
3. Write/extend tests in `tests/`.  
4. Submit Pull Request; ensure CI passes and coverage ≥ 85 %.  

Bug/feature requests → GitHub Issues with *repro* steps.

---

## 9. License
Released under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

> “Art is never finished, only abandoned.” – Leonardo da Vinci  
> *With PaletteFlux, you can always revisit the canvas.*
```