```markdown
# PaletteFlux GraphQL Studio — C++ Setup Guide
Welcome to the PaletteFlux GraphQL Studio SDK for C++.  
This guide walks you through compiling the SDK, configuring credentials, and executing
your first creative workflow against the PaletteFlux API-gateway.

---

## 1. Prerequisites
| Requirement | Version | Notes |
|-------------|---------|-------|
| CMake       | ≥ 3.18  | Modern CMake is required for FetchContent. |
| C++         | ≥ 20    | The SDK uses `std::source_location`, `std::span`, and coroutines. |
| OpenSSL     | ≥ 1.1   | TLS for HTTPS requests. |
| pkg-config  |         | Convenience for finding OpenSSL & zlib. |

> ℹ️  On Debian/Ubuntu:
> ```bash
> sudo apt-get update
> sudo apt-get install build-essential cmake pkg-config libssl-dev zlib1g-dev
> ```

---

## 2. Cloning the Repository
The SDK lives inside the monorepo but is completely standalone.

```bash
git clone --depth 1 https://github.com/PaletteFlux/api_graphql.git
cd api_graphql/cpp
```

---

## 3. Building the SDK

### 3.1 One-liner
```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target paletteflux-sdk
sudo cmake --install build
```

### 3.2 CMakeLists.txt Overview
The top-level `CMakeLists.txt` already exposes an **installable** target named
`paletteflux-sdk`.  Internally it pulls in the following dependencies:

* `httplib`      – single-header HTTP/HTTPS client  
* `nlohmann_json`– JSON (runtime) and compile-time JSON schema validation  
* `inja`         – high-performance templating for query DSL  
* `spdlog`       – structured logging  

The entire dependency graph is resolved via CMake `FetchContent` and vendored
under `<build>/_deps`.  Nothing touches your global system paths.

---

## 4. Authenticating

Create a file called `~/.config/paletteflux/credentials.json`:

```jsonc
{
  "client_id":     "studio_demo",
  "client_secret": "replace-me",
  "endpoint":      "https://studio-api.paletteflux.com/graphql",
  "rest_base":     "https://studio-api.paletteflux.com"
}
```

The SDK will lazily read & cache this document on first use.
You can override the location via the env-var `PALETTEFLUX_CONFIG`.

---

## 5. Boilerplate Client

The minimal program below demonstrates:

* Bootstrapping the client
* Querying paginated assets
* Executing a mutation
* Robust error handling

Create `examples/minimal_client.cpp`:

```cpp
/**
 *  @file   minimal_client.cpp
 *  @brief  Demonstrates PaletteFlux GraphQL usage in C++
 *
 *  Build with:
 *      g++ -std=c++20 minimal_client.cpp -lpaletteflux-sdk -o minimal_client
 */

#include <paletteflux/client.hpp>   // Public one-stop header for the SDK
#include <paletteflux/utils/cli.hpp>
#include <cstdlib>                  // std::exit

// Convenience alias
namespace pf = paletteflux;

int main(int argc, char** argv)
try
{
    pf::log::init();   // ──> spdlog sinks + pattern from $PF_LOG_FORMAT

    // 1. Instantiate a configured client (reads credentials.json)
    pf::Client studio = pf::Client::load_from_default();

    // 2. Build a paginated query — the embedded DSL is type-safe
    const std::string_view PagedAssets = R"gql(
        query ($first: Int!, $after: String) {
            assets(first: $first, after: $after) {
                edges {
                    node {
                        id
                        name
                        updatedAt
                        previewUrl
                    }
                    cursor
                }
                pageInfo {
                    endCursor
                    hasNextPage
                }
            }
        }
    )gql";

    pf::Variables vars;
    vars["first"] = 5;     // Fetch 5 assets per page
    vars["after"] = nullptr;

    pf::Result result = studio.graphql(PagedAssets, vars);

    if (result.contains_errors())
    {
        // Pretty-print the entire error envelope
        pf::cerr_json(result.errors());
        return EXIT_FAILURE;
    }

    // Deserialize into strongly-typed view structs
    auto assetsPage = result.data()["assets"];

    pf::log::info("Fetched {} assets", assetsPage["edges"].size());
    for (const auto& edge : assetsPage["edges"])
    {
        const auto& node = edge["node"];
        pf::log::info("• {} – {}", node["id"].get<std::string>(),
                                node["name"].get<std::string>());
    }

    // 3. Mutation example – create a new brush stroke layer
    const std::string_view CreateStroke = R"gql(
        mutation($input: CreateStrokeInput!) {
            createStroke(input: $input) {
                stroke {
                    id
                    path
                    color
                    opacity
                }
                clientMutationId
            }
        }
    )gql";

    pf::json strokeInput = {
        {"path",    "M10 10 C 20 20, 40 20, 50 10"},
        {"color",   "#EE5599"},
        {"opacity", 0.87},
        {"clientMutationId", pf::uuid()}
    };

    vars.clear();
    vars["input"] = std::move(strokeInput);

    result = studio.graphql(CreateStroke, vars);
    result.throw_on_errors();   // Converts GraphQL errors -> C++ exceptions

    pf::json created = result.data()["createStroke"]["stroke"];
    pf::log::info("New stroke created: id={} color={}",
                  created["id"].get<std::string>(),
                  created["color"].get<std::string>());

    return EXIT_SUCCESS;
}
catch (const pf::http_error& ex)
{
    pf::log::error("HTTP error [{}]: {}", ex.status_code(), ex.what());
    return EXIT_FAILURE;
}
catch (const pf::graphql_error& ex)
{
    pf::log::error("GraphQL error: {}", ex.what());
    return EXIT_FAILURE;
}
catch (const std::exception& ex)
{
    pf::log::critical("Unhandled exception: {}", ex.what());
    return EXIT_FAILURE;
}

```

### 5.1 Building the Example
Inside the repository root:

```bash
cmake -S . -B build -DEXAMPLES=ON
cmake --build build --target minimal_client
./build/examples/minimal_client
```

---

## 6. Advanced Topics

### 6.1 Streaming Queries With Coroutines
The SDK exposes coroutine-based streaming via `pf::Client::stream()` which returns
`generator<pf::Result>`.  This is perfect for real-time dashboards:

```cpp
for co_await (auto chunk : studio.stream(LIVE_LAYER_METRICS)) {
    if (chunk.contains_errors()) {
        pf::log::warn("Metrics error: {}", chunk.first_error().message);
        continue;
    }
    renderMetrics(chunk.data());
}
```

### 6.2 Response Caching
Activate the built-in LRU cache (default: 1 024 entries) via:

```cpp
pf::ClientConfig cfg;
cfg.cache_capacity = 4096;
cfg.cache_ttl      = std::chrono::minutes{5};

pf::Client studio(cfg);
```

Cache keys are automatically derived from the SHA-256 digest of the query body
plus sorted variables.  Mutations and `@noCache` directives bypass the store.

### 6.3 Monitoring Hooks
All public API calls emit OpenTelemetry spans (when compiled with
`-DPF_USE_TELEMETRY=ON`).  Attach your exporter of choice by overriding:

```cpp
pf::telemetry::init(std::make_unique<pf::otel::JaegerExporter>("studio"));
```

Traces include:

* `graphql.resolve`  – per-field resolver timings  
* `rest.request`     – HTTP method / path / status  
* `decode.asset`     – binary → JSON or GLSL conversions  

---

## 7. Troubleshooting

| Symptom                                   | Fix |
|-------------------------------------------|-----|
| `SSL routines:...certificate verify failed` | Ensure `/etc/ssl/certs/` is up-to-date or set `PF_SSL_CA_FILE`. |
| `undefined reference to 'SSL_read'`       | Link order matters: `-lpaletteflux-sdk -lssl -lcrypto`. |
| Timeout when querying large assets        | Increase `pf::ClientConfig::timeout`; default is 10 s. |
| REST 429—Rate limit exceeded              | Exponential backoff helper: `pf::RetryPolicy::standard()`. |

---

## 8. Next Steps
* Read the [Pagination & Relay Guide](./pagination_relay.md)
* Explore [Shader Node Recipes](../recipes/shader_nodes.md)
* Contribute by opening an issue or PR — we ❤️ community input!

---

© PaletteFlux Labs. This document is licensed under CC-BY-SA-4.0.
```