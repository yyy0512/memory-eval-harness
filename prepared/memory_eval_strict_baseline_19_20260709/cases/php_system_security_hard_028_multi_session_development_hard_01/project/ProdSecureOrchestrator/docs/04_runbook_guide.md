```markdown
# ProdSecure Orchestrator – Run-Book Guide
*File Path:* `ProdSecureOrchestrator/docs/04_runbook_guide.md`  
*Last Updated:* {{DATE}}  
*Audience:* DevSecOps Engineers, SREs, Platform Engineers

---

## 1. What Is a Run-Book?

A run-book is an ordered set of **Command Pattern** objects that can be executed automatically or manually to remediate incidents, perform routine maintenance, or facilitate blue-green deployments.  
Within ProdSecure Orchestrator every run-book is:

* Typed (security, ops, backup, etc.)
* Versioned & immutable once published
* Stored in the internal “Mesh Registry” (Service Mesh)
* Executed by the **Orchestration Engine** (Chain of Responsibility)

---

## 2. Anatomy of a Run-Book

```
┌───────────────────────────────┐
│      RunBook Descriptor       │  ←– YAML / JSON
├───────────────────────────────┤
│  Meta (name, version, tags)   │
│  Permissions / RBAC guards    │
│  Preconditions (Strategy)     │
│  Steps (Command objects)      │
│  Rollback Policy              │
│  Post-conditions & Notifiers  │
└───────────────────────────────┘
```

### 2.1 Minimal YAML Descriptor

```yaml
name: "hotfix-restart-web"
version: "1.3.2"
tags: [ "hotfix", "web", "restart" ]
type: "ops"
rbac:
  allowedRoles: [ "SRE", "PLATFORM_ADMIN" ]
steps:
  - command: "RestartServiceCommand"
    arguments:
      serviceName: "nginx"
  - command: "VerifyHealthCheckCommand"
    arguments:
      endpoint: "https://api.example.com/health"
      retries: 3
  - command: "NotifySlackCommand"
    arguments:
      channel: "#prod-alerts"
rollback:
  onFailure: true
  steps:
    - command: "RollbackDeploymentCommand"
      arguments:
        deploymentId: "{{context.deploymentId}}"
```

The YAML is converted to PHP **RunBook** objects at runtime by the `RunBookFactory`.

---

## 3. Creating Commands

All commands implement `App\Contracts\CommandInterface`.

```php
<?php

namespace App\Contracts;

/**
 * Contract every run-book command must fulfil.
 */
interface CommandInterface
{
    /**
     * Executes the command.
     *
     * @param array<string, mixed> $context Shared mutable context between steps.
     * @return void
     *
     * @throws \Throwable Any failure triggers orchestrator rollback.
     */
    public function execute(array &$context): void;

    /**
     * Optionally reverse the operation (idempotent).
     *
     * @param array<string, mixed> $context
     * @return void
     */
    public function rollback(array &$context): void;
}
```

### 3.1 Sample Command Implementation

```php
<?php

namespace App\RunBook\Commands;

use App\Contracts\CommandInterface;
use App\Services\SystemdService;
use Psr\Log\LoggerInterface;

final class RestartServiceCommand implements CommandInterface
{
    public function __construct(
        private readonly SystemdService $systemd,
        private readonly LoggerInterface $logger,
        private readonly string $serviceName
    ) {}

    public function execute(array &$context): void
    {
        $this->logger->info("Restarting service: {$this->serviceName}");
        $this->systemd->restart($this->serviceName);

        // Persist info for downstream steps
        $context['serviceRestarted'] = $this->serviceName;
    }

    public function rollback(array &$context): void
    {
        $this->logger->warning("Rolling back: stopping service {$this->serviceName}");
        $this->systemd->stop($this->serviceName);
    }
}
```

Best practice: **Do not** perform heavy logic in the constructor. Inject services via DI and use the `execute()` method for side-effects only.

---

## 4. Building & Publishing a Run-Book Programmatically

```php
<?php

use App\RunBook\Commands\{
    RestartServiceCommand,
    VerifyHealthCheckCommand,
    NotifySlackCommand
};
use App\RunBook\RunBook;
use App\RunBook\RunBookPublisher;
use Psr\Log\LoggerInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

$logger  = $container->get(LoggerInterface::class);
$http    = $container->get(HttpClientInterface::class);
$systemd = $container->get(SystemdService::class);

$runBook = RunBook::builder()
    ->withName('hotfix-restart-web')
    ->withVersion('1.3.2')
    ->addStep(new RestartServiceCommand($systemd, $logger, 'nginx'))
    ->addStep(new VerifyHealthCheckCommand($http, $logger, 'https://api.example.com/health', 3))
    ->addStep(new NotifySlackCommand('#prod-alerts', $logger))
    ->withRollbackPolicy(RunBook::ROLLBACK_ON_FAILURE)
    ->build();

(new RunBookPublisher())->publish($runBook);
```

---

## 5. Executing Run-Books

### 5.1 From the Web UI

1. Navigate to **Run-Books ➜ Catalog**  
2. Locate the required run-book (search by tag)  
3. Click **Execute** ➜ select **Target Environment**  
4. Confirm RBAC prompt

### 5.2 Using the CLI

```bash
./bin/console runbook:execute hotfix-restart-web \
    --env=production \
    --user=alice@example.com
```

### 5.3 Via the REST API

```http
POST /api/v1/runbooks/execute
Content-Type: application/json
Authorization: Bearer <token>

{
  "runBook": "hotfix-restart-web",
  "environment": "production",
  "arguments": {
    "serviceName": "nginx"
  }
}
```

Response:

```json
{
  "executionId": "rbx_2896f1a2",
  "status": "QUEUED",
  "createdAt": "2024-05-06T12:04:27Z"
}
```

---

## 6. Observability & Audit Trail

* Every step logs to the central **Log Aggregator** (PSR-3 compliant).
* Execution metrics are streamed via **Observer Pattern** to the dashboard:
  * Mean time-to-resolve (MTTR)
  * Success/Failure ratio
  * SLA impact
* Full diff-aware audit trail stored in `runbook_executions` table.

---

## 7. Error Handling & Rollbacks

The orchestrator surrounds each command with a try/catch block:

```php
try {
    $command->execute($context);
    $pipeline->advance();
} catch (\Throwable $e) {
    $logger->error($e->getMessage(), ['runBookId' => $runBook->id()]);
    if ($runBook->shouldRollbackOnFailure()) {
        $pipeline->rollback();
    }
}
```

Rollback order is **LIFO** (last executed, first rolled back).

---

## 8. Best Practices

1. **Idempotency** – commands should be safe to re-run.
2. **Timeouts** – avoid blocking calls without sane timeouts.
3. **Secrets Management** – reference credentials via the internal Vault, never hard-code.
4. **Observability** – emit structured logs (`json_log` channel) for each step.
5. **Validation** – validate inputs early using Symfony’s `Validator` component.

---

## 9. Example End-to-End Run-Book (Full Source)

```php
<?php

declare(strict_types=1);

namespace App\RunBook;

use App\Contracts\CommandInterface;
use Psr\Log\LoggerInterface;

final class FullHotfixRunBook
{
    public function __construct(
        private readonly SystemdService $systemd,
        private readonly LoggerInterface $logger,
        private readonly HealthCheckService $healthCheck,
        private readonly SlackNotifier $notifier,
    ) {}

    /**
     * Returns a fully-built RunBook instance, ready to publish.
     */
    public function create(): RunBook
    {
        return RunBook::builder()
            ->withName('hotfix-restart-web')
            ->withVersion('2.0.0')
            ->withTags(['hotfix', 'web', 'restart'])
            ->addStep($this->restartService())
            ->addStep($this->verifyHealthCheck())
            ->addStep($this->notifySlack())
            ->withRollbackPolicy(RunBook::ROLLBACK_ON_FAILURE)
            ->build();
    }

    private function restartService(): CommandInterface
    {
        return new RestartServiceCommand($this->systemd, $this->logger, 'nginx');
    }

    private function verifyHealthCheck(): CommandInterface
    {
        return new VerifyHealthCheckCommand(
            $this->healthCheck,
            $this->logger,
            'https://api.example.com/health',
            5  // retry count
        );
    }

    private function notifySlack(): CommandInterface
    {
        return new NotifySlackCommand('#prod-alerts', $this->logger);
    }
}
```

Publish with:

```php
$publisher->publish((new FullHotfixRunBook(...deps))->create());
```

---

## 10. Additional Resources

* 02_architecture_overview.md – design patterns under the hood  
* 03_cli_reference.md – command-line usage  
* 05_extending_orchestrator.md – writing custom handlers  
* https://docs.prodsecure.example.com – full API reference  

---

© ProdSecure Inc. All rights reserved.
```