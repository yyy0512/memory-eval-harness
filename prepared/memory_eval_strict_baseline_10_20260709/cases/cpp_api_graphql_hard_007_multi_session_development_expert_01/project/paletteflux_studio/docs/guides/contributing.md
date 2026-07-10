<!--
/*
 * PaletteFlux GraphQL Studio – Contributing Guide
 * ------------------------------------------------
 * Copyright (c) 2024 PaletteFlux
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
-->

# Contributing to PaletteFlux GraphQL Studio

Welcome — we’re excited that you want to contribute!  
This document walks you through the workflow, code-style, testing strategy, and
CI/CD checks used in **PaletteFlux GraphQL Studio**.  
The core runtime is modern **C++20** with a service layer exposing GraphQL and
REST gateways.

> **TL;DR**
> 1. Fork ➜ branch ➜ code ➜ format ➜ test ➜ pull-request  
> 2. Follow the commit & PR templates  
> 3. All code must compile with `-std=c++20 -Werror -pedantic` and pass
>    `./scripts/run_ci_locally.sh`  

---

## 1. Repository Overview

```
/api_graphql
├── cmake/                 # CMake toolchain, compiler options
├── pfx/                   # Main source (controllers, models, services, …)
├── tests/                 # Catch2 unit & integration tests
├── scripts/               # Dev utilities (format, lint, local CI)
└── docs/                  # Public docs (you are here)
```

---

## 2. Development Environment

### 2.1 Toolchain

| Tool             | Minimum Version | Installation Hint                    |
| ---------------- | --------------- | ------------------------------------ |
| CMake            | 3.23            | `brew`, `apt`, or official binaries  |
| Clang / GCC      | 14 / 11         | Enable C++20 support                 |
| Conan            | 2.0             | Dependency manager                   |
| Python           | 3.9             | Scripts & pre-commit hooks           |
| clang-format     | 15              | Automatic code formatting            |
| clang-tidy       | 15              | Static analysis                      |

```bash
# macOS
brew install cmake llvm conan python@3.11

# Ubuntu
sudo apt-get install -y cmake clang-15 clang-tidy-15 clang-format-15 \
                        gcc-11 g++-11 python3 python3-pip
pip3 install conan==2.*
```

### 2.2 Clone & Build

```bash
git clone --recursive https://github.com/<your-username>/api_graphql.git
cd api_graphql
conan profile detect --force
conan install . -of build/debug -s build_type=Debug --build=missing
cmake -S . -B build/debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build/debug -j $(nproc)
ctest --test-dir build/debug --output-on-failure
```

---

## 3. Branching & Release Model

We follow a lightweight variant of **Git Flow**:

* `main`   — stable, version-tagged releases  
* `develop` — integration branch (always green)  
* `feature/<ticket>`   — short-lived feature branches  
* `hotfix/<ticket>`   — critical fixes for `main`  

Please rebase (**not** merge) onto `develop` before opening a PR to keep a
linear history.

---

## 4. Commit Message Convention

We use the conventional commits specification with an extended scope list.

```
<type>(<scope>): <subject>

<body>
```

Types: feat, fix, refactor, docs, chore, build, ci, style, test.

Example:

```
feat(controller): add incremental frame scheduler

The new scheduler batches micro-tasks based on GPU idle time and
reduces average frame latency by ~6 ms on mid-tier hardware.

Closes: #231
```

---

## 5. C++ Coding Standards

* C++20 (`<concepts>`, `<source_location>`, Ranges, Coroutines)
* Google C++ style with project-specific overrides (see `.clang-format`)
* All headers use `#pragma once` and an include guard fallback
* Namespaces follow `pfx::<layer>` (e.g., `pfx::controller`)

### 5.1 Example Header Skeleton

```cpp
#pragma once
#ifndef PFX_CONTROLLER_RENDERCONTROLLER_HPP_
#define PFX_CONTROLLER_RENDERCONTROLLER_HPP_

#include <chrono>
#include <gsl/gsl>
#include <pfx/controller/BaseController.hpp>
#include <pfx/service/CommandBus.hpp>
#include <pfx/service/QueryBus.hpp>

namespace pfx::controller {

class RenderController final : public BaseController {
public:
    struct RenderParams {
        gsl::not_null<const model::SceneGraph*> sceneGraph;
        std::chrono::milliseconds frameBudget{16};
    };

    RenderController(service::CommandBus& commandBus,
                     service::QueryBus&   queryBus);

    // Non-copyable
    RenderController(const RenderController&)            = delete;
    RenderController& operator=(const RenderController&) = delete;

    // Movable
    RenderController(RenderController&&) noexcept            = default;
    RenderController& operator=(RenderController&&) noexcept = default;

    ~RenderController() override = default;

    void renderFrame(const RenderParams& params) const;
};

} // namespace pfx::controller

#endif // PFX_CONTROLLER_RENDERCONTROLLER_HPP_
```

### 5.2 Error Handling

* Use `<expected>` (via `tl::expected` until standardized) for recoverable errors.
* Throw `pfx::core::LogicError` or `RuntimeError` only for programmer
  mistakes or unrecoverable states.
* Never use bare `assert()` in production code; prefer `Expects/Ensures`
  from **GSL**.

```cpp
auto bytes = fileSystem.read(path)
    .and_then([](std::vector<std::byte>&& data) -> tl::expected<Texture, Error> {
        return Texture::decode(std::move(data));
    })
    .value_or_throw();
```

---

## 6. Formatting, Linting & Static Analysis

Pre-commit hooks enforce:

1. `clang-format` (`.clang-format`)
2. `clang-tidy`   (`.clang-tidy`)
3. License header check  
4. Spell checker for docs

Install hooks:

```bash
pip install pre-commit
pre-commit install
```

Run manually:

```bash
pre-commit run --all-files
```

---

## 7. Testing Strategy

* **Unit tests** — Catch2 v3, placed in `tests/` mirroring source tree  
* **Integration tests** — Spin-up in-memory HTTP/GraphQL servers  
* **Property tests** — RapidCheck (fuzzing scene-graph invariants)  
* **Performance budgets** — Google Benchmark, auto-regressed in CI  

### 7.1 Unit Test Example

```cpp
#include <catch2/catch_test_macros.hpp>
#include <pfx/controller/RenderController.hpp>
#include <pfx/testing/FakeCommandBus.hpp>
#include <pfx/testing/FakeQueryBus.hpp>

using namespace pfx;

TEST_CASE("RenderController renders a frame within budget", "[render]") {
    testing::FakeCommandBus cmdBus;
    testing::FakeQueryBus   qryBus;

    controller::RenderController rc{cmdBus, qryBus};
    controller::RenderController::RenderParams params{
        .sceneGraph  = gsl::make_not_null(new model::SceneGraph{}),
        .frameBudget = std::chrono::milliseconds{10}
    };

    REQUIRE_NOTHROW(rc.renderFrame(params));
}
```

Run all tests:

```bash
ctest --output-on-failure --parallel $(nproc)
```

---

## 8. Continuous Integration

All pull requests trigger GitHub Actions:

1. Configure & build (`Debug`, `Release`)
2. Run unit/integration tests
3. Execute `clang-tidy`
4. Upload code-coverage to Codecov
5. Generate and deploy API docs (Doxygen + Sphinx) on `main`

You can mirror the pipeline locally:

```bash
./scripts/run_ci_locally.sh
```

---

## 9. Documentation

* API docs live under `docs/api/`, generated via Doxygen (`make docs`).
* User guides and tutorials are Markdown + Mermaid.
* GraphQL schema docs are auto-exported with `graphql-cli`.

---

## 10. Pull Request Checklist

- [ ] Title follows conventional commits
- [ ] Code builds on Linux, macOS, and Windows
- [ ] Unit tests added/updated
- [ ] All linters pass (`pre-commit run --all-files`)
- [ ] Documentation updated
- [ ] No TODOs / commented-out code in final diff

---

## 11. Community & Support

* GitHub Issues — bug reports & feature requests  
* Discord `#paletteflux-dev` — real-time chat  
* Discussions tab — Q&A, RFCs

---

## 12. Credits & Contributors

PaletteFlux GraphQL Studio is an open, community-driven effort.  
We gratefully acknowledge everyone who submits code, tests, reviews, or docs.

```text
                                      ┌───────────────────┐
                                      │  THANK YOU & ♥︎  │
                                      └───────────────────┘
```

Happy hacking!