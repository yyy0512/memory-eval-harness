```markdown
<!--
  File: paletteflux_studio/docs/api/rest_v1.md
  Description: Complete API reference and best-practice notes for PaletteFlux
               REST v1 endpoints.  This Markdown file is auto-generated and
               intended to live alongside the code base so that IDEs and hosted
               documentation tooling (e.g. MkDocs, GitBook) can surface it.
-->

# PaletteFlux REST API — Version 1

PaletteFlux exposes a compact, cache-friendly REST surface for clients that
cannot—or do not wish to—consume the full GraphQL schema.  
Version 1 focuses on read-heavy workflows such as asset browsers, static site
generators, and CDN edge functions.

> All examples below are shown in **C++17** using the
> [`cpr`](https://github.com/libcpr/cpr) HTTP client and
> [`nlohmann::json`](https://github.com/nlohmann/json) for JSON parsing.  
> Both are permissively licensed and production-ready.

---

## Base URL

```
https://api.paletteflux.com/rest/v1
```

Every endpoint documented here is relative to the base URL.  
Production, staging, and canary clusters expose identical contracts—only the
hostname changes.

---

## Authentication

PaletteFlux uses short-lived JSON Web Tokens (JWT) obtained from the OAuth2
authorization server.  
Include the token as a `Bearer` value in the `Authorization` header.

```cpp
cpr::Response r = cpr::Get(cpr::Url{BASE_URL + "/assets"},
                           cpr::Bearer{token});  // token == "eyJhbGciOi..."
```

Tokens are validated at the API-gateway layer and refreshed via the standard
`/oauth/token` endpoint (not covered here).

---

## Global Response Envelope

Every successful call returns HTTP `2xx` and the following envelope:

```jsonc
{
  "data": <payload>,        // the typed resource(s)
  "meta": {
    "requestId": "a3e4...d12",
    "timestamp": "2024-06-07T21:15:33Z",
    "schema":   "rest.v1"
  }
}
```

On **error** the envelope looks like:

```jsonc
{
  "errors": [
    {
      "code":  "ASSET_NOT_FOUND",
      "title": "The requested asset does not exist",
      "detail": "No asset with id=a_158cba has been uploaded",
      "status": 404
    }
  ],
  "meta": {
    "requestId": "a3e4...d12",
    "timestamp": "2024-06-07T21:15:33Z",
    "schema":   "rest.v1"
  }
}
```

---

## Pagination

Endpoints that return collections support **cursor-based** pagination inspired
by Relay. The following query parameters are understood:

| Parameter | Type   | Description                    |
|-----------|--------|--------------------------------|
| `first`   | int    | Number of items to return      |
| `after`   | string | Base-64 cursor obtained prior  |

The `Link` response header exposes `next`, `prev`, and `self` URLs.

---

## Endpoints

### 1. `GET /assets`

Returns a paginated list of creative assets.

```
GET /assets?first=25
```

| Query Param | Type    | Optional | Description                        |
|-------------|---------|----------|------------------------------------|
| `type`      | string  | ✔        | Filter by subtype (`texture`, `shader`, `audio`)|
| `owner`     | uuid    | ✔        | Filter by creator ID               |

#### Example (C++)

```cpp
#include <cpr/cpr.h>
#include <nlohmann/json.hpp>
#include <iostream>

static constexpr auto BASE_URL = "https://api.paletteflux.com/rest/v1";

void listAssets(const std::string& token) {
    auto res = cpr::Get(
        cpr::Url{std::string(BASE_URL) + "/assets?first=10"},
        cpr::Bearer{token},
        cpr::Timeout{std::chrono::seconds{5}}
    );

    if (res.error) {
        throw std::runtime_error("Network error: " + res.error.message);
    }
    if (res.status_code != 200) {
        throw std::runtime_error("API error: " + std::to_string(res.status_code));
    }

    auto body = nlohmann::json::parse(res.text);
    for (const auto& asset : body["data"]) {
        std::cout << "• " << asset["id"] << "  " << asset["name"] << '\n';
    }
}
```

#### Response (truncated)

```jsonc
HTTP/1.1 200 OK
Link: <.../assets?after=Y3Vyc29yNTg=>; rel="next"

{
  "data": [
    {
      "id": "a_158cba",
      "name": "Brush — Watercolor Splatter",
      "type": "brush",
      "owner": "u_023fe1",
      "updatedAt": "2024-05-21T11:02:30Z"
    }
    /* 9 more items */
  ],
  "meta": { /* ... */ }
}
```

---

### 2. `GET /assets/{id}`

Retrieve a single asset by identifier.

```
GET /assets/a_158cba
```

#### Response

```jsonc
HTTP/1.1 200 OK
Cache-Control: max-age=3600, public

{
  "data": {
    "id": "a_158cba",
    "name": "Brush — Watercolor Splatter",
    "description": "High-res alpha brush for drips and splashes",
    "files": [
      { "url": "https://cdn.paletteflux.com/a_158cba.png", "variant": "2k" },
      { "url": "https://cdn.paletteflux.com/a_158cba_512.png", "variant": "512" }
    ],
    "createdAt": "2024-05-01T08:45:12Z",
    "updatedAt": "2024-05-21T11:02:30Z"
  },
  "meta": { /* ... */ }
}
```

---

### 3. `POST /assets/{id}/render`

Trigger a server-side rendering job (e.g., generate a MipMap atlas or GLSL code).

```
POST /assets/a_158cba/render
```

| Payload Field | Type    | Required | Description                       |
|---------------|---------|----------|-----------------------------------|
| `profile`     | string  | ✔        | Rendering profile (`webp`, `glsl`, `preview`) |
| `params`      | object  | ✔        | Profile-specific configuration    |

#### Request Example

```jsonc
{
  "profile": "preview",
  "params": {
    "background": "#00000000",
    "dpi": 72,
    "maxSize": 1024
  }
}
```

##### C++ Snippet

```cpp
void renderPreview(const std::string& token, const std::string& assetId) {
    nlohmann::json payload = {
        { "profile", "preview" },
        { "params", {
            { "background", "#00000000" },
            { "dpi", 72 },
            { "maxSize", 1024 }
        }}
    };

    auto res = cpr::Post(
        cpr::Url{BASE_URL + std::string("/assets/") + assetId + "/render"},
        cpr::Bearer{token},
        cpr::Header{{"Content-Type", "application/json"}},
        cpr::Body(payload.dump()),
        cpr::Timeout{std::chrono::seconds{30}}
    );

    if (res.status_code != 202) {
        throw std::runtime_error("Failed to enqueue job — status " +
                                 std::to_string(res.status_code));
    }

    // Job location is returned via Location header
    std::cout << "Render job accepted: " << res.header["Location"] << '\n';
}
```

#### Response

```
HTTP/1.1 202 Accepted
Location: /jobs/j_78e1f3
```

The job can be polled via `GET /jobs/{id}` (see Job API below).

---

### 4. `GET /scenes/{id}`

Composite scenes aggregate many assets.  
Clients typically render them locally or on workers.

```
GET /scenes/s_9941d1?include=assets
```

`include=assets` inlines the first **100** assets (sorted by Z-order).  
Further assets are referenced via `assetIds`.

---

## Jobs

Long-running tasks, such as transcoding or batch exports, are exposed with the
following endpoints:

| Method | Path          | Description           |
|--------|---------------|-----------------------|
| GET    | `/jobs/{id}`  | Poll job state        |
| DELETE | `/jobs/{id}`  | Cancel (best-effort)  |

`/jobs/{id}` returns:

```jsonc
{
  "data": {
    "id": "j_78e1f3",
    "state": "running",          // queued, running, success, error
    "progress": 0.61,            // 0-1
    "createdAt": "2024-06-07T21:02:17Z",
    "startedAt": "2024-06-07T21:02:18Z",
    "finishedAt": null,
    "result": null
  },
  "meta": { /* ... */ }
}
```

A **successful** job will embed `result`, e.g. the newly rendered URL.

---

## Error Reference

| HTTP | Code               | Message                         | Recoverable |
|------|--------------------|---------------------------------|-------------|
| 400  | `VALIDATION_FAIL`  | Input failed JSON-schema rules  | yes         |
| 401  | `UNAUTHENTICATED`  | Missing/invalid token           | yes         |
| 403  | `FORBIDDEN`        | Insufficient scopes             | maybe       |
| 404  | `ASSET_NOT_FOUND`  | Asset or endpoint missing       | no          |
| 409  | `CONFLICT`         | State conflict (ETag mismatch)  | yes         |
| 429  | `RATE_LIMIT`       | Global or user limit exceeded   | yes         |
| 500  | `SERVER_ERROR`     | Unhandled exception             | transient   |

The `Retry-After` header is set where applicable.

---

## Rate Limiting

PaletteFlux applies **token-bucket** throttling per user and per workspace.
Burst capacity is advertised via headers:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 996
X-RateLimit-Reset: 1717680000
```

We recommend an exponential back-off for 429s:

```cpp
std::size_t backoff = 1000; // millis
for (int attempt = 0; attempt < 5; ++attempt) {
    auto res = cpr::Get(/* ... */);
    if (res.status_code != 429) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(backoff));
    backoff *= 2;
}
```

---

## Changelog

| Date       | Change                                                     |
|------------|------------------------------------------------------------|
| 2024-06-07 | Initial public version                                     |
| 2024-06-08 | Added `/assets/{id}/render` and Job polling                |
| 2024-06-10 | Cursor pagination and `include` parameter for scenes       |

---

## Appendix A: Building the C++ Examples

The snippets compile on **C++17** and depend on:

```
cpr >= 1.9
nlohmann_json >= 3.11
```

Simple `CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.18)
project(paletteflux_examples LANGUAGES CXX)

find_package(cpr REQUIRED)
find_package(nlohmann_json REQUIRED)

add_executable(list_assets list_assets.cpp)
target_link_libraries(list_assets PRIVATE cpr::cpr nlohmann_json::nlohmann_json)
set_target_properties(list_assets PROPERTIES CXX_STANDARD 17 CXX_EXTENSIONS OFF)
```

---

Happy creating!  
For further questions ping us at `devrel@paletteflux.com` or open a discussion
on GitHub.
```