```markdown
# LambdaUtility Orchestrator – Setup Guide
System Automation Suite – *“Zero-idle, Zero-drama Ops.”*

This document explains how to bootstrap a workstation or CI runner so it can build, test, and deploy a C-based AWS Lambda that conforms to the LambdaUtility Orchestrator conventions.

---

## 1  Prerequisites

| Tool             | Minimum Version | Purpose                                   |
|------------------|-----------------|-------------------------------------------|
| CMake            | 3.18            | Cross-platform build generation           |
| GCC / Clang      | GCC 10 / Clang 13| C17-compliant compilation                |
| Docker           | 24.x            | Reproducible, Amazon Linux 2 build image  |
| AWS CLI v2       | Latest          | Deployment & parameter store integration  |
| jq               | 1.6             | JSON processing in helper scripts         |
| Python           | 3.9             | Glue scripts, test harness                |

```bash
# macOS (Homebrew)
brew install cmake gcc awscli jq python

# Ubuntu
sudo apt-get update -y
sudo apt-get install -y cmake gcc clang awscli jq python3 python3-pip
```

---

## 2  Clone & Sub-module Init

```bash
git clone https://github.com/acme-corp/lambdautility-orchestrator.git
cd lambdautility-orchestrator
git submodule update --init --recursive
```

---

## 3  Directory Layout (High-level)

```
LambdaUtilityOrchestrator/
├── build-scripts/           # Docker build & deploy helpers
├── cmake/                   # CMake toolchain + modules
├── lambdas/                 # Each Lambda's source lives here
│   ├── config_push/
│   ├── backup_snapshot/
│   └── …                    # etc.
├── libs/                    # Shared static libs (logging, json, http)
├── docs/                    # Documentation (you are here)
└── tests/                   # Unit & integration tests
```

---

## 4  One-shot Build (Local)

Compile **all** lambdas into static binaries placed in `out/`.  
Artifacts are automatically stripped and compressed via `upx` for minimal cold-start latency.

```bash
./build-scripts/build_all.sh
```

> build_all.sh is a thin wrapper around `docker buildx bake` so the build is completely dockerized; no host compiler pollution.

---

## 5  Per-Lambda Development Workflow

Below is a *real* example for the “configuration push” lambda:

```
lambdas/config_push/
├── CMakeLists.txt
├── config_push.c
└── include/
    └── config_push.h
```

### 5.1 Build

```bash
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
cmake --build . -j$(nproc)
```

### 5.2 Run Unit Tests

```bash
ctest --output-on-failure
```

### 5.3 Invoke Locally

```bash
./simulate \
  --binary ./config_push \
  --event  ../../events/config_push.sample.json
```

`simulate` is a tiny Python wrapper that replicates the Lambda Runtime API.

### 5.4 Deploy

```bash
./build-scripts/deploy.sh config_push \
  --stage  prod \
  --region us-east-1
```

Deployment steps:

1. Re-build release binary (`-O2 -static -s` flags).
2. Package into ZIP.
3. Upload → `aws lambda update-function-code`.
4. Publish new version and move the `PROD` alias.

---

## 6  Environment Variables & Secrets

The project standardizes on SSM Parameter Store paths:

```
/lambdautility/{lambda_name}/{stage}/VAR_NAME
```

A helper fetches and injects them at init time:

```c
#include "secrets.h"

void load_runtime_config(runtime_cfg_t *cfg)
{
    /*
     * Fail-fast: missing parameter is fatal.
     */
    cfg->grafana_url = get_ssm_or_die("GRAFANA_URL");
    cfg->slack_token = get_ssm_or_die("SLACK_TOKEN");
}
```

---

## 7  CI/CD (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ "main" ]

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build & Test
        run: ./build-scripts/build_all.sh && ./build-scripts/test_all.sh
      - name: Upload Coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage.info
```

---

## 8  Sample C Lambda (Minimal Pattern)

```c
// lambdas/performance_metrics/performance_metrics.c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "lambda_runtime.h"
#include "metrics.h"
#include "json.h"

/*
 * Handler signature required by the Lambda bootstrap.
 */
int lambda_handler(const char *event_json,
                   lambda_context_t *ctx,
                   char       **response_json)
{
    (void)ctx;  // Unused in this example

    metrics_t m;
    if (!parse_metrics_event(event_json, &m)) {
        *response_json = strdup("{\"status\":\"bad_event\"}");
        return LAMBDA_ERR_BAD_INPUT;
    }

    if (push_metrics(&m) != 0) {
        *response_json = strdup("{\"status\":\"push_failed\"}");
        return LAMBDA_ERR_RUNTIME;
    }

    *response_json = strdup("{\"status\":\"ok\"}");
    return LAMBDA_OK;
}
```

> NOTE: `lambda_runtime.h` is a thin, shared wrapper that exposes the AWS Lambda C Runtime ABI and a small set of helpers (logging, JSON parsing, and SSM integration).

---

## 9  Troubleshooting

| Symptom                            | Probable Cause                        | Fix                         |
|------------------------------------|---------------------------------------|-----------------------------|
| `./binary: not found` inside Lambda| Not compiled `-static`                | Rebuild with `-static`      |
| `error while loading shared libs`  | Same as above                         | See above                   |
| `InvalidClientTokenId` on deploy   | AWS creds expired / wrong profile     | `aws sts get-caller-identity`|
| Cold-start > 800 ms                | Binary > 15 MB or heavy init code     | Strip, UPX, lazy-init       |

---

## 10  Clean-up

```bash
./build-scripts/teardown.sh       # Removes all generated build images
aws lambda delete-function \
  --function-name <name> \
  --region us-east-1
```

---

Happy automating! 🚀
```