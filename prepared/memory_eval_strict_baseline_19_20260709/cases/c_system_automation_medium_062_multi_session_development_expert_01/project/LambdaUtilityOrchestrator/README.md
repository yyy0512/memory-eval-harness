# LambdaUtility Orchestrator

A production-grade, serverless automation suite written in C. LambdaUtility Orchestrator delivers day-to-day systems-utility workflows—alerting, configuration management, automated deployments, centralized log aggregation, scheduled backups, and performance metric harvesting—without requiring a long-running control plane.

![LambdaUtility Orchestrator Banner](docs/assets/banner.png)

---

## Table of Contents
1. Features
2. Architecture
3. Quick Start
4. Directory Layout
5. Build & Deploy
6. Configuration
7. Operational Playbooks
8. Troubleshooting
9. Contributing
10. License

---

## 1  Features
• **Alerting** – Slack, e-mail, or SMS notifications using the Observer pattern  
• **Configuration Management** – Idempotent pushes and rollbacks of service configs  
• **Backup & Recovery** – Snapshot orchestration and retention pruning  
• **Deployment Automation** – Blue/green & canary deployments for micro-services  
• **Performance Metrics** – Harvest, normalize, and push to a metrics DB  

> All utilities are implemented as stand-alone AWS Lambda functions compiled from C.

---

## 2  Architecture

```
┌───────────┐   schedule/topic/http   ┌───────────────┐
│  Trigger  ├────────────────────────►│  Dispatcher   │
└───────────┘                        └──────┬────────┘
                                            ▼
                                   ┌─────────────────┐
                                   │   Command Bus   │
                                   └────┬────┬───────┘
                        ┌───────────────┘    └───────────────────┐
                        ▼                                        ▼
              ┌─────────────────┐                      ┌──────────────────┐
              │ Chain-of-Resp.  │   … → … → …          │ Observer Fan-Out │
              └─────────────────┘                      └──────────────────┘
```

Patterns employed:

* **Command Pattern** – Encapsulate each utility action as an object.  
* **Chain of Responsibility** – Create linear, conditional processing pipelines.  
* **Observer Pattern** – Decouple notification channels from business logic.  
* **Event-Driven** – Triggers: CloudWatch Events, SNS, or REST.  

### 2.1 Key Components

| Component            | Path                                   | Responsibility                          |
|----------------------|----------------------------------------|-----------------------------------------|
| `src/dispatcher`     | `dispatcher.c/h`                       | Map triggers to command objects         |
| `src/commands`       | `backup.c`, `deploy.c`, …              | Concrete command implementations        |
| `src/chain`          | `chain.c/h`                            | Chain execution engine                  |
| `src/observer`       | `observer.c/h`                         | Notification fan-out                    |
| `infra`              | Terraform modules, CI/CD definitions   | Infrastructure as Code                  |

---

## 3  Quick Start

### Prerequisites
* GNU Make (4.1+)  
* CMake (3.15+)  
* Clang/LLVM or GCC (with `-std=c11`)  
* AWS CLI + credentials with `lambda:*` & `iam:*` permissions  

### Build & Test

```bash
# Clone repository
git clone https://github.com/acme-sys/LambdaUtilityOrchestrator.git
cd LambdaUtilityOrchestrator

# Configure & build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel

# Run unit tests
ctest --test-dir build
```

### Deploy a Single Function

```bash
make deploy FUNCTION=alerting/slack_notifier
```

The Makefile targets automate: compile → package → upload → publish → tag.

---

## 4  Directory Layout

```
LambdaUtilityOrchestrator/
├── CMakeLists.txt      # Top-level build specification
├── infra/              # Terraform & AWS SAM templates
├── src/                # C source code
│   ├── dispatcher/
│   ├── commands/
│   ├── chain/
│   └── observer/
├── include/            # Public headers
├── tests/              # Unit & integration tests
├── scripts/            # Dev-tooling (lint, static-analysis, packaging)
└── docs/               # Architecture docs, ADRs, diagrams
```

---

## 5  Build & Deploy Details

1. **Compilation**  
   All functions are compiled with `-Os`, link-time optimization, and `--strip`.  
2. **Bundling**  
   Output ELF binaries are zipped with a minimal `bootstrap` per AWS Lambda’s  
   Custom Runtime API.  
3. **CI**  
   GitHub Actions runs `clang-tidy`, unit tests, and static analysis (`cppcheck`).  
4. **CD**  
   Successful builds trigger the `infra/terraform` workflow to roll out updates.  

---

## 6  Configuration

Each Lambda consumes a JSON “event” payload following the common envelope:

```jsonc
{
  "meta": {
    "correlation_id": "123e4567-e89b-12d3-a456-426614174000",
    "timestamp": 1688509534
  },
  "command": "backup.create_snapshot",
  "args": {
    "volume_id": "vol-06dfe7f3a7965d8b9",
    "retention_days": 30
  }
}
```

Global settings live in `config/defaults.toml` and environment variables  
(`LAMBDAUTILITY_*`). For sensitive data use AWS Secrets Manager.

---

## 7  Operational Playbooks

* **Rollback:** `aws lambda publish-version --function-name ... --revision-id ...`  
* **Scale out:** Adjust reserved-concurrency or provisioned‐concurrency in Terraform.  
* **Log drain:** All functions stream `stdout`/`stderr` to CloudWatch Logs group  
  `/lambdautility/$FUNCTION/$(date +%Y-%m-%d)`.

---

## 8  Troubleshooting

| Symptom                                       | Action                                    |
|-----------------------------------------------|-------------------------------------------|
| High latency for first call of the day        | Enable provisioned concurrency            |
| `Handler timed out` errors                    | Increase `timeout` or optimize I/O        |
| `AccessDeniedException` on deployment         | Validate IAM role trust & policies        |
| Memory spikes during large backups            | Raise `memory_size` or chunk operations   |

Run `scripts/diag.sh --function deploy.rollout --verbose` for an end-to-end diagnostic.

---

## 9  Contributing

1. Fork and create a feature branch.  
2. Follow the coding standards in `docs/STYLE_GUIDE.md`.  
3. Run `make pre-commit`.  
4. Submit a pull request; the CI pipeline must pass.  

Community discussions happen in `#lambdautility` on the Acme Corp Slack.

---

## 10  License

LambdaUtility Orchestrator is released under the MIT License—see `LICENSE` for details.

---

### Appendix A – Minimal C Handler Example

```c
/**********************************************************************
 * src/commands/alert_slack.c
 *
 * Post a critical alert to Slack via Incoming WebHook.
 *********************************************************************/
#include "alert_slack.h"
#include "json_parser.h"
#include "http_client.h"

#define SLACK_WEBHOOK_ENV "SLACK_WEBHOOK_URL"
#define DEFAULT_CHANNEL   "#ops-alerts"

static int post_to_slack(const char *webhook, const char *payload);

/* Lambda entry point */
int lambda_handler(const uint8_t *event, size_t event_len,
                   uint8_t **response, size_t *response_len)
{
    json_value_t *root = json_parse(event, event_len);
    if (!root) return ERR_BAD_REQUEST;

    const char *msg   = json_get_string(root, "args.message", "No message");
    const char *level = json_get_string(root, "args.level",  "INFO");
    const char *ch    = json_get_string(root, "args.channel", DEFAULT_CHANNEL);

    char slack_msg[512];
    snprintf(slack_msg, sizeof(slack_msg),
             "{\"channel\":\"%s\",\"text\":\"[%s] %s\"}", ch, level, msg);

    const char *hook = getenv(SLACK_WEBHOOK_ENV);
    if (!hook) return ERR_MISCONFIGURED;

    int rc = post_to_slack(hook, slack_msg);

    /* Build Lambda JSON response */
    *response_len = asprintf((char**)response,
                             "{\"ok\":%s}", rc == 0 ? "true" : "false");
    json_free(root);
    return rc;
}
```

---

Happy automating!