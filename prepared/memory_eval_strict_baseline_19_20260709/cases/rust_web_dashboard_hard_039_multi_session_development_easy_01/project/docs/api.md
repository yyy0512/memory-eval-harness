```markdown
# ChromaticCanvas Control Center – REST API Guide
Welcome to the public API reference for **ChromaticCanvas Control Center** (CCC).  
This document describes every stable HTTP endpoint exposed by the server crate
`chromatic_canvas_api` and shows you how to consume it safely from Rust, curl,
or any other HTTPS-capable client. You can always request the latest machine
readable schema at:

```
GET /api/v1/openapi.json
Content-Type: application/json
```

The server adheres to the
[OpenAPI 3.1](https://spec.openapis.org/) specification and is implemented with
[`actix-web`](https://actix.rs/) and the strongly-typed routing layer
`paperclip`. Every response is wrapped in a [`ResultEnvelope`](#result-envelope)
to provide **consistent error semantics**.

---

## Versioning
All routes are prefixed with the API version (`/api/v1`). Breaking changes
result in a new major version (`/api/v2`, …). Deprecations are announced 60 days
in advance via the `Sunset` header and the dashboard’s in-app changelog.

---

## Authentication

### Strategy
CCC ships with a hybrid session model:

* **Bearer JWT** – stateless, recommended for native/mobile clients.
* **Signed Cookie** – automatic for SPA/Yew front-end.

Both point to the same refresh-token store, backed by PostgreSQL +
`redis-cluster` for O(1) revocation.

### Login
```
POST /api/v1/auth/login
Content-Type: application/json
```

Request Body:
```json
{
  "email": "avery@studio.io",
  "password": "••••••••"
}
```

Successful Response `200 OK`:
```json
{
  "access_token": "<jwt>",
  "expires_in": 900,
  "refresh_token": "<uuid>",
  "user": {
    "id": "u_4830a8d7",
    "name": "Avery Painter",
    "avatar_url": "https://cdn.ccc.io/u/u_4830a8d7.png"
  }
}
```

Rust Example (`reqwest` + `serde_json`):

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct Login {
    email: String,
    password: String,
}

#[derive(Deserialize, Debug)]
struct LoginResp {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
    user: UserMeta,
}

#[derive(Deserialize, Debug)]
struct UserMeta {
    id: String,
    name: String,
    avatar_url: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let client = Client::new();
    let payload = Login {
        email: "avery@studio.io".into(),
        password: std::env::var("CCC_PASS")?,
    };

    let resp = client
        .post("https://dashboard.chromaticcanvas.com/api/v1/auth/login")
        .json(&payload)
        .send()
        .await?
        .error_for_status()?     // map non-2xx into reqwest::Error
        .json::<LoginResp>()
        .await?;

    println!("Logged in ⇒ {:?}", resp);
    Ok(())
}
```

---

## Pagination & Filtering
List endpoints implement **cursor-based pagination** via:

* `?limit=<1-100>`
* `?after=<opaque_cursor>` – exclusive
* `?filter[status]=published` – optional typed filters

The response always carries:

```
Link: <…?after=<cursor>&limit=25>; rel="next"
```

---

## Result Envelope
```json
{
  "ok": true,
  "data": { /* payload or null */ },
  "error": null,
  "trace_id": "ddf2e6249b984e6b"
}
```
If `ok` is `false`, `data` is `null` and `error` is a
[`ProblemDetails`](https://datatracker.ietf.org/doc/html/rfc9457) object.

---

## Endpoints

### Assets

| Method | URI | Description                                    |
|--------|-----|------------------------------------------------|
| `GET`  | `/api/v1/assets` | List all assets you can access     |
| `POST` | `/api/v1/assets` | Upload a new creative asset        |
| `GET`  | `/api/v1/assets/{id}` | Fetch metadata                |
| `PUT`  | `/api/v1/assets/{id}` | Mutate metadata/tags          |
| `DELETE` | `/api/v1/assets/{id}` | Soft-delete (trash)         |
| `GET`  | `/api/v1/assets/{id}/download` | Stream binary file   |

#### Upload
```
POST /api/v1/assets
Content-Type: multipart/form-data; boundary=----CCCBoundary
Authorization: Bearer <jwt>
```

Parts:

| Field      | Type       | Required | Notes                                  |
|------------|------------|----------|----------------------------------------|
| `file`     | `binary`   | ✓        | Up to 2 GiB per asset                  |
| `fileType` | `string`   | ✓        | E.g. `image/png`, `video/mp4`          |
| `title`    | `string`   | ✓        | Human-readable                         |
| `tags`     | `string[]` | ✗        | JSON array (`["concept", "v1"]`)       |

Successful Response `201 Created`  
`Location: /api/v1/assets/a_792fdaf0db`

Example `curl`:
```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/home/avery/work/render.png" \
  -F "fileType=image/png" \
  -F "title=Hero mockup" \
  https://dashboard.chromaticcanvas.com/api/v1/assets
```

---

### Projects

Projects combine assets, timelines, and billing.

| Method | URI | Notes |
|--------|-----|-------|
| `GET` | `/api/v1/projects` | Paginated list |
| `POST` | `/api/v1/projects` | Create new |
| `GET` | `/api/v1/projects/{id}` | Detail view |
| `GET` | `/api/v1/projects/{id}/timeline` | Sorted events |
| `POST` | `/api/v1/projects/{id}/invite` | Share with collaborator |

`/timeline` entries include `event_type` (upload, comment, payment), `actor`,
`payload`, and UTC `ts`.

---

### Realtime Notifications (WebSocket)

```
GET wss://dashboard.chromaticcanvas.com/api/v1/ws?token=<jwt>
```

Once connected, the server upgrades to the [WebSocket] protocol and begins
streaming `ServerSent` messages:

```json
{
  "kind": "AssetProcessed",
  "asset_id": "a_792fdaf0db",
  "percentage": 100,
  "ts": "2024-05-29T14:02:13.511Z"
}
```

Error frames are emitted as `kind = "Error"` envelopes and the connection is
closed with an appropriate code (`4003` = Auth Expired, `4008` = Rate-Limited).

---

## Error Codes

| HTTP | App Code | Meaning                                       | Retry? |
|------|----------|-----------------------------------------------|--------|
| `400` | `VAL001` | Validation failed (see `details`)            | No |
| `401` | `AUTH001` | Invalid/expired token                       | Yes |
| `403` | `AUTH101` | Missing required role                       | No |
| `404` | `GEN404` | Resource not found                           | No |
| `429` | `RATE001` | Rate limit exceeded                         | After `Retry-After` |
| `500` | `SRV500` | Unhandled server error (trace ID available)  | Yes |

---

## Rate Limits
Default bucket: **400 requests / minute** (sliding window).  
Exceeding the quota returns `429 Too Many Requests` with:

```
X-RateLimit-Limit: 400
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1716996845
```

You can request higher quotas via support.

---

## Example: Building an Asset Search Client in Rust

Below is a fully-async example that demonstrates:

* Mandatory auth token
* Cursor pagination
* Strongly-typed deserialization
* Error bubbling via `thiserror`

```rust
//! src/bin/search_assets.rs
use anyhow::Context;
use chrono::{DateTime, Utc};
use reqwest::{Client, Url};
use serde::Deserialize;
use thiserror::Error;

const ORIGIN: &str = "https://dashboard.chromaticcanvas.com";

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    ok: bool,
    data: Option<T>,
    error: Option<ApiError>,
    trace_id: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    code: String,
    message: String,
    details: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    id: String,
    title: String,
    file_type: String,
    created_at: DateTime<Utc>,
    preview_url: Url,
    tags: Vec<String>,
}

#[derive(Debug, Error)]
enum SearchErr {
    #[error("api: {0:?}")]
    Api(ApiError),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

async fn search_assets(client: &Client, token: &str, q: &str) -> Result<Vec<Asset>, SearchErr> {
    let url = format!("{ORIGIN}/api/v1/assets?filter[title]={q}&limit=50");
    let resp: Envelope<Vec<Asset>> = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    match resp.ok {
        true => Ok(resp.data.unwrap_or_default()),
        false => Err(SearchErr::Api(resp.error.unwrap())),
    }
}

#[tokio::main]
async fn main() -> Result<(), SearchErr> {
    dotenvy::dotenv().ok();
    let token = std::env::var("CCC_TOKEN").context("CCC_TOKEN not set")?;
    let client = Client::builder()
        .user_agent("ccc-cli/1.0") // required per ToS
        .build()?;

    for asset in search_assets(&client, &token, "moodboard").await? {
        println!("🖼️  {}  [{}]", asset.title, asset.id);
    }
    Ok(())
}
```

Compile:

```bash
cargo run -p ccc-cli --bin search_assets
```

---

## SDKs
The team maintains first-party helper crates:

* `chromatic_canvas_sdk` – idiomatic, typed Rust client (async)
* `chromatic_canvas_cli` – cross-platform binary built with `clap`
* `chromatic_canvas_js` – generated TypeScript SDK via OpenAPI

---

## Changelog (snippet)

* **v1.8.0** – Added `/projects/{id}/invite`, bumped default quota
* **v1.7.3** – Support for multi-factor auth, FIDO2
* **v1.7.0** – WebSocket notifications GA
* **v1.6.0** – Introduced cursor pagination
* **v1.5.0** – Initial public release

---

## Troubleshooting & Support
1. Inspect the `trace_id` returned with every envelope. Paste it in #ops-help.
2. Confirm `X-Ray` (AWS) shows green for the upstream dependency.
3. Use `RUST_LOG=chromatic_canvas_api=debug` locally to reproduce.
4. Open tickets via the Control Center → “Help → Submit diagnostics”.

Happy painting! 🎨  
— The Chromatic Canvas Team
```