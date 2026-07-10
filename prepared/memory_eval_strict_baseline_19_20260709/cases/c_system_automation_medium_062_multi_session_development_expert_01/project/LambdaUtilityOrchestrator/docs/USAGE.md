```markdown
# LambdaUtility Orchestrator – USAGE

Welcome to **LambdaUtility Orchestrator** – a serverless systems-automation suite
implemented entirely in C.  This document is a practical, copy-paste-ready guide
that covers environment setup, compilation, deployment, testing, and
troubleshooting.

> **TL;DR**
> ```bash
> make init            # one-time: bootstrap submodules & toolchains
> make all             # build every Lambda locally
> make deploy STACK=prod-us-east-1
> echo '{}' | ./bin/dispatch           # smoke-test locally
> ```


--------------------------------------------------------------------------------
## 1  Prerequisites
| Tool | Tested Version | Purpose |
|------|----------------|---------|
| **AWS CLI v2** | 2.15+ | Deploy stacks & upload artefacts |
| **CMake** | 3.20+ | Cross-platform build configuration |
| **Ninja** | 1.10+ | Fast concurrent compilation |
| **Docker** | 24+ | Deterministic, glibc-compatible build environment |
| **Python** | 3.10+ | Small helper scripts |
| **clang-format** | 12+ | Consistent code style |

*All commands below assume a POSIX-compatible shell.*


--------------------------------------------------------------------------------
## 2  Directory Layout (abridged)

```
.
├── CMakeLists.txt           # top-level build descriptor
├── include/                 # public headers
│   ├── core/                # event models, utilities, logging
│   └── modules/             # utility-specific interfaces
├── src/
│   ├── core/                # framework: dispatcher, chain-of-responsibility
│   ├── modules/alerting/    # alert lambda
│   ├── modules/backup/      # backup lambda
│   └── ...
├── lambda/                  # tiny wrappers that expose `lambda_handler`
├── scripts/                 # build & CI helpers
├── infra/                   # SAM/CloudFormation templates
└── docs/                    # you are here
```


--------------------------------------------------------------------------------
## 3  Compiling Locally

All Lambdas use the *AWS custom runtime* (`provided.al2`) to avoid Go/Rust/Node
shims.  A single static ELF called `bootstrap` is produced for each module.

```bash
# One-liner using the provided toolchain container
./scripts/build.sh release

# or step-by-step:
docker build -t luo/buildenv -f docker/buildenv.Dockerfile .
docker run --rm -v $PWD:/src luo/buildenv /src/scripts/build_in_docker.sh
```

Relevant `CMake` flags:

```cmake
set(CMAKE_C_STANDARD 17)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)  # LTO
add_compile_options(-O2 -pipe -static -s)
```


--------------------------------------------------------------------------------
## 4  Running the Test Suite

```bash
make test       # unit + integration (CTest + pytest)

# View coverage
make coverage && firefox build/coverage/index.html
```


--------------------------------------------------------------------------------
## 5  Packaging & Deployment

The project ships a thin `Makefile` wrapper around AWS SAM.

```bash
# Deploy into an existing AWS account (default profile)
make deploy STACK=prod-us-east-1

# Update a single Lambda without touching the rest
make deploy MODULE=backup

# Tail logs in real-time
make logs MODULE=dispatch
```

Behind the scenes `infra/stack.yaml` defines:

* S3 bucket for artefact storage (`LambdaUtilityArtefacts`)
* EventBridge schedules & rules
* IAM roles w/ least-privilege policies
* DLQ for retries
* CloudWatch dashboards (metrics, alarms)


--------------------------------------------------------------------------------
## 6  Local Invocation

### 6.1 Using the AWS Lambda Runtime Interface Emulator (RIE)

```bash
export AWS_LAMBDA_EXEC_WRAPPER=""
docker run --rm -v "$PWD/lambda/alerting:/var/task:ro,delegated" \
    -e AWS_REGION=us-east-1 \
    -p 9000:8080 \
    lambci/provided:al2 /lambda-entrypoint.sh bootstrap

# In another terminal:
curl -s -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
     -d '{"resource":"test","detail-type":"integration"}' | jq
```

### 6.2 Direct Native Execution (for quick debugging)

```bash
echo '{"action":"push_config","target":"nginx"}' | ./bin/dispatch --stdin
```


--------------------------------------------------------------------------------
## 7  Extending the Orchestrator

Adding a new utility (e.g., **performance-baseline**):

1. Scaffold
   ```bash
   ./scripts/new_module.sh performance_baseline
   ```
   Generates:
   ```
   src/modules/performance_baseline/
   lambda/performance_baseline/        # bootstrap wrapper
   tests/performance_baseline/
   ```

2. Implement:

   ```c
   // src/modules/performance_baseline/performance_baseline.c
   #include "modules/performance_baseline/performance_baseline.h"
   #include "core/logger.h"

   int performance_baseline_handle(const luo_event_t *ev, luo_context_t *ctx) {
       luo_log_info("collecting baseline metrics for %s", ev->target);
       // ...
       return 0;
   }
   ```

3. Register with the dispatcher:

   ```c
   // src/core/registry.c
   REGISTER_COMMAND("performance_baseline", performance_baseline_handle);
   ```

4. Write tests (`tests/performance_baseline/test_main.c`).

5. Update infra (`infra/stack.yaml`) with an EventBridge rule or API
   endpoint.

6. `make all deploy STACK=dev`.


--------------------------------------------------------------------------------
## 8  Configuration

Runtime behaviour is controlled exclusively through environment variables to
remain stateless:

| Variable | Default | Notes |
|----------|---------|-------|
| `LUO_LOG_LEVEL`        | `INFO`   | `DEBUG`, `WARN`, `ERROR`, `FATAL` |
| `LUO_SSM_PREFIX`       | `/luo`   | Parameter Store namespace |
| `LUO_SLACK_WEBHOOK`    | —        | Enables Slack notifications |
| `LUO_MAX_CONCURRENCY`  | `5`      | Per-module semaphore limit |
| `LUO_DEFAULT_REGION`   | Lambda region | Fallback for AWS services |

Update values via `aws lambda update-function-configuration` or SAM
`Parameters:` block.


--------------------------------------------------------------------------------
## 9  Event Contract

All modules share a common envelope (`luo_event_t`):

```jsonc
{
  "id": "uuid4",
  "ts": 1696350512,
  "type": "config_push",     // enum: alert, backup, deploy, metric, ...
  "origin": "eventbridge",
  "payload": {
    "...": "..."
  }
}
```

*Errors* are returned in the *Lambda response* and forwarded verbatim to the
DLQ.  The handler must never call `exit()` – instead return a non-zero integer.

```c
// Inside any lambda_handler
if (luo_dispatch(&event, &ctx) != 0) {
    luo_log_error("dispatch failed: %s", ctx.errmsg);
    return luo_json_error(ctx.errmsg);
}
```


--------------------------------------------------------------------------------
## 10  Observability

* CloudWatch metrics emitted via Embedded Metric Format (`core/metrics.h`)
* Structured logs (JSON) → Log Insights
* Alarms:
  * `FunctionErrors > 0` → PagerDuty
  * `Duration p99` > threshold → Slack
* Traces exported to X-Ray (compile-time flag `-DLUO_XRAY=ON`)


--------------------------------------------------------------------------------
## 11  Troubleshooting Checklist

| Symptom | Common Cause | Fix |
|---------|--------------|-----|
| `fork: Resource temporarily unavailable` | `ulimit -n` too low in container | `ulimit -n 4096` |
| `ModuleNotFound` during test run | Missing `LD_LIBRARY_PATH` | `export` path or run via `ctest` |
| `EACCES` on SSM | Lambda execution role missing `ssm:GetParameter` | `make deploy` to refresh IAM |
| Cold starts > 1s | Large static libs | Use `-ffunction-sections -Wl,--gc-sections` |


--------------------------------------------------------------------------------
## 12  FAQ

**Q:** *Why C?*  
**A:** Deterministic performance, single-file static binaries (<1 MB),
low cold-start times, and nostalgia.

**Q:** *Is this safe in a memory-managed world?*  
**A:** Yes. We compile with the full sanitiser suite in CI:
`-fsanitize=address,undefined,leak,integer`.

**Q:** *Can I run it outside AWS?*  
**A:** Absolutely. The dispatcher is completely platform-agnostic and can be
embedded in Kubernetes CronJobs or systemd timers.


--------------------------------------------------------------------------------
Happy automating!  For additional help jump into `#lambdautility` on Slack or
file a GitHub issue.

---
© 2024 LambdaUtility Orchestrator · Apache 2.0
```