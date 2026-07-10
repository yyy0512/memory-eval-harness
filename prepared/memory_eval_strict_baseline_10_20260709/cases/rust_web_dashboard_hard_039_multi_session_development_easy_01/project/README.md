```markdown
# 🎨 ChromaticCanvas Control Center

![Rust](https://img.shields.io/badge/Rust-1.76%2B-orange?logo=rust)
![CI](https://github.com/ChromaticCanvas/control-center/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/ChromaticCanvas/control-center)
![WebAssembly](https://img.shields.io/badge/WASM-ready-blueviolet?logo=webassembly)

ChromaticCanvas Control Center is an advanced, component-driven **web dashboard** written _entirely_ in Rust.  
It empowers visual artists, design studios, and interactive agencies to orchestrate creative assets, live project data, and client interactions from a single, secure hub.

> Every tile, graph, or widget is treated as a **“color swatch” component** that can be remixed or themed at runtime, mirroring the way a creative professional layers strokes on an actual canvas.

---

## ✨ Feature Highlights

| Category         | Key Capabilities                                                                                  |
|------------------|---------------------------------------------------------------------------------------------------|
| Dashboard        | Modular “swatch” components, drag-and-drop uploads, real-time analytics, AI color suggestions     |
| Architecture     | Component-first design, MVC rendering pipeline, RESTful service layer, pluggable middleware       |
| Security         | JWT auth, TLS (HTTPS), CSRF protection, rate limiting, OAuth2 provider support                    |
| Performance      | Actix-Web + Tokio, lazy-loaded WASM, chunked streaming, connection pooling                        |
| Integrations     | Stripe (payments), ElasticSearch (search), Postgres / SQLite (SQLx), Redis cache, S3-compatible   |
| Toolchain        | Cargo Workspaces, Trunk, Tailwind-inspired styling (DaisyUI), GitHub Actions, Dependabot          |

---

## 🗺️ Table of Contents

1. Quick Start
2. Architecture Overview
3. Example Code Walkthrough
4. Development & Tooling
5. Testing
6. Security Notes
7. Contributing
8. License

---

## 🚀 Quick Start

Clone the repo and launch the **full-stack** dev environment in under 60 s.

```bash
# 1. Bootstrap workspace
git clone https://github.com/ChromaticCanvas/control-center.git
cd control-center
cp .env.example .env               # edit values as needed

# 2. Start backend (API + workers)
cargo run -p cc-backend

# 3. In another shell, build & watch the frontend (WASM)
trunk serve --open --features dev

# 4. Visit dashboard
# http://localhost:8080
```

> Requirements: `rustup`, `wasm32-unknown-unknown`, `trunk`, `tailwindcss`, and a running Postgres 15+ instance.

---

## 🏗️ Architecture Overview

```text
 ┌────────────┐   HTTP  ┌───────────────┐      PG / Redis / S3
 │  Browser    │◀────────▶  Actix-Web   │◀────────────────────→ Data Stores
 │  (Yew+WASM) │          │  (cc-api)   │
 └────────────┘          └─────▲────────┘
                               │
                               │ MVC Service Layer
                               ▼
                      ┌────────────────────┐
                      │   Domain Logic     │
                      └─────────▲──────────┘
                                │ Events / Jobs
                        ┌───────┴────────┐
                        │  Tokio Workers │
                        └────────────────┘
```

### Crate Layout

```
control-center/
├─ crates/
│  ├─ cc-api/          # REST endpoints & middleware
│  ├─ cc-domain/       # Core business logic & types
│  ├─ cc-db/           # SQLx migrations, Repo abstraction
│  ├─ cc-workers/      # Async jobs: thumbnails, emails
│  └─ cc-web/          # Yew SPA (WASM)
└─ Cargo.toml
```

Each crate is **independently testable** and **version-lock free**.

---

## 🧩 Example Code Walkthrough

### 1. Swatch Component (Yew)

```rust
use yew::prelude::*;

#[derive(Properties, PartialEq)]
pub struct SwatchProps {
    pub title: String,
    #[prop_or_default]
    pub on_click: Callback<()>,
}

#[function_component(Swatch)]
pub fn swatch(props: &SwatchProps) -> Html {
    let clicked = {
        let cb = props.on_click.clone();
        Callback::from(move |_| cb.emit(()))
    };

    html! {
        <div
            class="shadow-lg p-4 rounded-md bg-gradient-to-r from-purple-500 to-pink-500
                   text-white cursor-pointer hover:opacity-90 transition-opacity duration-200"
            onclick={clicked}
        >
            <h3 class="font-semibold tracking-wide text-lg">{ &props.title }</h3>
        </div>
    }
}
```

### 2. REST Endpoint (Actix-Web)

```rust
use actix_web::{get, HttpResponse, Responder, web};
use cc_domain::projects::{ProjectId, ProjectService};
use crate::error::ApiError;

#[get("/api/projects/{id}")]
async fn get_project(
    svc: web::Data<ProjectService>,
    path: web::Path<ProjectId>,
) -> Result<impl Responder, ApiError> {
    let project = svc.fetch_one(*path).await?;
    Ok(HttpResponse::Ok().json(project))
}
```

### 3. Domain Service (cc-domain)

```rust
use sqlx::PgPool;
use anyhow::Result;
use crate::entities::Project;

#[derive(Clone)]
pub struct ProjectService {
    pool: PgPool,
}

impl ProjectService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn fetch_one(&self, id: i32) -> Result<Project> {
        let rec = sqlx::query_as!(
            Project,
            r#"SELECT id, name, status, created_at FROM projects WHERE id = $1"#,
            id,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(rec)
    }
}
```

---

## 🛠️ Development & Tooling

| Tool        | Usage                                                         |
|-------------|---------------------------------------------------------------|
| `cargo nextest` | Parallel unit/integration tests                            |
| `cargo sqlx`    | Compile-time checked migrations                            |
| `trunk`         | WASM build & live-reload                                   |
| `tailwindcss`   | Utility-first CSS generation                               |
| `just`          | Task runner (see `justfile`)                               |

### Common Tasks

```bash
# Check all crates (including WASM) with Clippy & fmt
just lint

# Apply database migrations
just migrate

# Seed dev fixtures
just seed

# Run OpenAPI doc server
just docs
```

---

## ✅ Testing

We ship three test tiers:

1. **Unit** (logic & utils)  
2. **Web** (API endpoints via `awc` client)  
3. **E2E** (headless Playwright hitting the compiled WASM app)

Run all with:

```bash
cargo nextest run --all-features
```

Coverage (grcov) must remain `> 85 %` before merging to `main`.

---

## 🔒 Security Notes

• All external traffic terminates at **TLS** (Rustls).  
• **JWT** with rotated signing keys stored in Redis.  
• Strict `Content-Security-Policy` & `SameSite=Lax` cookies.  
• Built-in **rate limiting** via [Governor] and automatic IP banning.  
• Regular **SAST** (`cargo audit`, `cargo deny`) in CI.

> Found a vulnerability? Email **security@chromaticcanvas.io** (GPG keys in `/SECURITY.md`).

---

## 🤝 Contributing

1. Fork the repo and create your branch (`git checkout -b feat/my-feature`)  
2. Run `just precommit` (fmt, clippy, tests, lint, wasm)  
3. Commit & push (`git commit -am 'Add cool feature' && git push origin`)  
4. Open a PR — PR template ensures checklists are met.

All contributions require a DCO sign-off. See `CONTRIBUTING.md`.

---

## 📄 License

Licensed under **Apache-2.0**.  
Copyright © 2024-present ChromaticCanvas.

---

## 💌 Contact

Twitter `@ChromaticCanvas` • Discord `#chromaticcanvas` • hello@chromaticcanvas.io
```
