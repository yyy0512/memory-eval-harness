```markdown
# InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178c6?logo=typescript)](https://typescriptlang.org)
[![CI](https://github.com/InsightHexaAI/ml_inference/actions/workflows/ci.yml/badge.svg)](https://github.com/InsightHexaAI/ml_inference/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/InsightHexaAI/ml_inference.svg)](LICENSE)

**InsightHexaAI** is a production-ready, hexagonally-architected MLOps platform that transforms predictive models into continuously-improving, revenue-impacting services—without coupling core business rules to any single technology.

---

## Table of Contents
1. [Why InsightHexaAI?](#why-insighthexaai)
2. [Hexagonal Architecture](#hexagonal-architecture)
3. [Core Modules](#core-modules)
4. [Quick Start](#quick-start)
5. [Code Examples](#code-examples)
   - [Implement a New Revenue Strategy](#implement-a-new-revenue-strategy)
   - [Plug-in a Model-Selection Strategy](#plug-in-a-model-selection-strategy)
   - [Declare a Training → Deployment Pipeline in Code](#declare-a-training--deployment-pipeline-in-code)
6. [Command-Line Interface](#command-line-interface)
7. [Testing](#testing)
8. [Contributing](#contributing)
9. [License](#license)

---

## Why InsightHexaAI?
Large enterprises already own data lakes, BI dashboards, and ML infrastructure—but **struggle to connect predictive insights to bottom-line metrics**. InsightHexaAI closes that gap by:

* Enforcing **ports-and-adapters (hexagonal)** boundaries, so business logic outlives tools that will inevitably change.
* Providing **Strategy** and **Factory** patterns to swap revenue, model-selection, or feature-engineering strategies _in code_, in minutes.
* Shipping **pipelines as strongly-typed code**, not sprawling YAML, guaranteeing compile-time safety and observable cost attribution.
* Offering first-class **model versioning, experiment tracking, feature store, and drift monitoring** out-of-the-box.

---

## Hexagonal Architecture

```text
                ┌───────────────────────────┐
                │      Presentation         │
                │ (Dashboards, APIs, CLI)   │
                └───────────┬───────────────┘
                            │ Port: `KpiQueryPort`
              ┌─────────────▼─────────────┐
              │    Application Layer      │
              │ (Use-Cases, Services, DTO)│
              └─────────────┬─────────────┘
                            │ Port: `InferencePort`
              ┌─────────────▼─────────────┐
              │       Domain Core         │  <-- You are here
              │   (Revenue & KPI rules)   │
              └─────────────┬─────────────┘
          ┌─────────────────▼───────────────────┐
          │            Adapters                 │
          │ ─────────┬─────────┬─────────────── │
          │  Kafka   │  S3     │  Snowflake     │
          │  REST    │  PowerBI│  TensorFlow    │
          └──────────┴─────────┴────────────────┘
```

*Only the adapters change; the domain core never does.*

---

## Core Modules
| Package                               | Description                                                     |
|---------------------------------------|-----------------------------------------------------------------|
| `@insighthexa/core`                   | KPI revenue rules, domain entities, Strategy/Factory contracts. |
| `@insighthexa/pipeline`               | Pre-processing → training → evaluation → deployment orchestration. |
| `@insighthexa/registry`               | Model & feature versioning, metadata audit trails.              |
| `@insighthexa/monitoring`             | Drift detection, SLA alerts via Observer Pattern.               |
| `@insighthexa/adapters-*`             | Technology-specific adapters (Kafka, Snowflake, etc.).          |

---

## Quick Start

1. **Prerequisites**

   ```bash
   node --version   # ≥ 18.x
   npm  --version   # ≥ 9.x
   docker --version # optional for local services
   ```

2. **Install**

   ```bash
   git clone https://github.com/InsightHexaAI/ml_inference.git
   cd ml_inference
   npm install
   ```

3. **Bootstrap local stack**

   ```bash
   # spin up MinIO, PostgreSQL, & Kafka for dev
   docker compose -f infra/docker-compose.local.yml up -d
   ```

4. **Seed demo artifacts**

   ```bash
   npm run seed:demo
   ```

5. **Run the sample server**

   ```bash
   npm start
   open http://localhost:8080/docs   # Swagger UI
   ```

---

## Code Examples

### Implement a New Revenue Strategy

`@insighthexa/core/src/revenue/strategies/SubscriptionStrategy.ts`

```ts
import { RevenueStrategy, UsageSnapshot } from '../RevenueStrategy';

/**
 * Flat-rate monthly subscription—ideal for high-volume customers
 * who prefer billing predictability.
 */
export class SubscriptionStrategy implements RevenueStrategy {
  private readonly flatRateUsd: number;

  constructor(flatRateUsd = 10_000) {
    if (flatRateUsd <= 0) {
      throw new Error('Flat rate must be positive.');
    }
    this.flatRateUsd = flatRateUsd;
  }

  public calculate(snapshot: UsageSnapshot): number {
    // A flat rate ignores inference count but audits SLA breaches.
    if (snapshot.slaBreaches > 0) {
      // Penalize by 2% per breach.
      return this.flatRateUsd * (1 - 0.02 * snapshot.slaBreaches);
    }
    return this.flatRateUsd;
  }

  public description(): string {
    return `Flat-rate subscription @ \$${this.flatRateUsd}/month`;
  }
}
```

Register the new strategy:

```ts
import { RevenueStrategyFactory } from '../RevenueStrategyFactory';
RevenueStrategyFactory.register('subscription', () => new SubscriptionStrategy());
```

Switch strategies _without touching I/O code_:

```ts
const revenueStrategy = RevenueStrategyFactory.get('subscription');
billingService.setStrategy(revenueStrategy);
```

---

### Plug-in a Model-Selection Strategy

`@insighthexa/core/src/modelSelection/strategies/MultiArmedBanditStrategy.ts`

```ts
import { ModelSelectionContext, ModelSelectionStrategy } from '../ModelSelectionStrategy';
import { ThompsonSampler } from '../../utils/ThompsonSampler';

export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  private readonly sampler = new ThompsonSampler();

  selectModel(ctx: ModelSelectionContext) {
    return this.sampler.nextArm(ctx.candidateMetrics);
  }
}
```

Register via factory:

```ts
ModelSelectionStrategy.register('mab', () => new MultiArmedBanditStrategy());
```

---

### Declare a Training → Deployment Pipeline in Code

```ts
import { pipeline } from '@insighthexa/pipeline';
import { RawEventIngestStage } from './stages/RawEventIngestStage';
import { FeatureEngineeringStage } from './stages/FeatureEngineeringStage';
import { TrainModelStage } from './stages/TrainModelStage';
import { DeployStage } from './stages/DeployStage';

pipeline('customer-churn')
  .withStage(new RawEventIngestStage())
  .withStage(new FeatureEngineeringStage({ oneHotEmbed: true }))
  .withStage(new TrainModelStage({ algorithm: 'xgboost' }))
  .withStage(new DeployStage({ minAccuracy: 0.88 }))
  .run()
  .catch(console.error);
```

Pipelines are **JavaScript objects**; introspection, versioning, and cost attribution become trivial.

---

## Command-Line Interface

```bash
# List registered models and serving metrics
npx insighthexa models list --filter churn

# Trigger an on-demand retraining pipeline
npx insighthexa pipeline run customer-churn

# Tail production inference logs
npx insighthexa logs -f
```

---

## Testing

```bash
# Lint and type-check
npm run lint && npm run typecheck

# Run unit + integration tests
npm test

# Generate coverage report
npm run coverage
```

---

## Contributing
Pull requests are welcome! Before opening one, please:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Run `npm run prepush` to ensure tests, lint and type-checks pass.
3. Follow the existing hexagonal boundaries—new dependencies belong in adapters, **never inside domain core**.

---

## License
InsightHexaAI is distributed under the Apache 2.0 license. See [LICENSE](LICENSE) for details.
```