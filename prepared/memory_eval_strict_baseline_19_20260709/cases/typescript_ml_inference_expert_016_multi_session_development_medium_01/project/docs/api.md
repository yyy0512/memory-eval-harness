```markdown
# InsightHexaAI – Public TypeScript API

Welcome to the InsightHexaAI Strategic ML Inference Suite.  
This document is the single source of truth for **developers integrating against the TypeScript API** (the ports inside the hexagon).  
All examples compile under TypeScript ≥ 5.2 and assume Node ≥ 18 LTS.

---

## Contents
1. Installation
2. Architectural Primer (Ports & Adapters)
3. Glossary of Core Domain Concepts
4. API Reference  
   4.1 Experiment Tracking  
   4.2 Feature Store  
   4.3 Model Training & Versioning  
   4.4 Real-Time Inference (Serving)  
   4.5 Model Monitoring  
5. End-to-End Example ⟨source code⟩
6. Error Handling
7. FAQ

---

## 1  Installation

```bash
# 1. Add the runtime SDK
npm i @insighthexa/core

# 2. Optionally add the default adapter bundle (Kafka, S3, Postgres…)
npm i @insighthexa/adapters-default
```

The library is distributed as pure ESM.  
Use the `--experimental-specifier-resolution=node` flag if your Node version is < 20.

---

## 2  Architectural Primer (Ports & Adapters)

Inside **InsightHexaAI**, every business capability is expressed as a `Port` (an abstract interface) and optionally *multiple* `Adapters`.

```
┌──────────┐           ┌──────────────────────┐
│  Port    │ <───uses──┤   Domain Service     │
│ ░░░░░░░░ │           │  (Hexagon Core)      │
└──────────┘           └───────▲──────────────┘
         ▲                     │
         │ depends on          │
┌────────┴────────┐     ┌──────┴─────┐
│ PostgresAdapter │     │ KafkaAdapter│
└─────────────────┘     └─────────────┘
```

Replacing Postgres with Snowflake or Kafka with Pulsar requires **zero** modifications in the domain core.

---

## 3  Glossary

Term | Description
---- | -----------
`RunId` | Opaque UUID representing one training or inference run.
`FeatureVector` | Immutable snapshot of engineered feature values.
`ModelArtifact` | Serialized, deployable model + metadata bundle.
`Metric` | Quantitative signal (e.g., `mape`, `auc`, `latency_p95`).

---

## 4  API Reference

### Notes on Typographical Conventions

• **Public, stable contracts** are typed using `export interface …`.  
• All **domain methods are `async`** and return `Promise<Result<T, E>>`, where `Result` is the discriminated-union pattern popularised by [Rust](https://doc.rust-lang.org/std/result/).  
• In *code snippets* we elide irrelevant imports with `…`.

---

### 4.1  Experiment Tracking

```ts
// @insighthexa/core/experiment-tracking.ts

export interface ExperimentPort {
  /**
   * Creates or rehydrates an experiment container identified by `name`.
   * If `name` already exists, the returned `ExperimentHandle` is non-mutable
   * w.r.t. configuration changes.
   */
  create(name: string, opts?: ExperimentOptions): Promise<Result<ExperimentHandle, DomainError>>;

  /**
   * Records a metric value for the active run under the given step.
   * Supports high-cardinality labels out-of-the-box.
   */
  logMetric(runId: RunId, metric: Metric): Promise<Result<void, DomainError>>;

  /**
   * Writes an arbitrary JSON blob as a run-scoped artefact.
   */
  logArtifact(runId: RunId, artifact: ModelArtifact): Promise<Result<void, DomainError>>;

  /**
   * Gracefully ends a run, flushes buffers and immutably persists metadata.
   */
  endRun(runId: RunId, status?: 'success' | 'failed' | 'aborted'): Promise<Result<void, DomainError>>;
}
```

#### Default Implementation

```ts
// @insighthexa/adapters-default/experiment/PostgresExperimentAdapter.ts
export class PostgresExperimentAdapter implements ExperimentPort { … }
```

---

### 4.2  Feature Store

```ts
// @insighthexa/core/feature-store.ts

export interface FeatureStorePort {
  /**
   * Writes a batch of features. The operation is idempotent on `(entityId, ts)`.
   */
  putBatch(batch: FeatureVector[]): Promise<Result<void, DomainError>>;

  /**
   * Fetches the *latest* feature vector per entity key by default.
   * Pass an explicit `asOf` timestamp for point-in-time correctness.
   */
  get(
    entityIds: string[],
    opts?: { asOf?: Date; includeInactive?: boolean }
  ): Promise<Result<Map<string, FeatureVector>, DomainError>>;
}
```

Supported adapters: `SnowflakeFeatureAdapter`, `InMemoryFeatureAdapter`, `BigQueryFeatureAdapter`.

---

### 4.3  Model Training & Versioning

```ts
// @insighthexa/core/model-registry.ts
export interface ModelRegistryPort {
  registerModel(
    model: ModelArtifact,
    metadata: { tags?: string[]; description?: string }
  ): Promise<Result<VersionId, DomainError>>;

  promoteStage(
    version: VersionId,
    stage: 'Staging' | 'Production' | 'Archived'
  ): Promise<Result<void, DomainError>>;

  latest(stage?: 'Production' | 'Staging'): Promise<Result<ModelArtifact, DomainError>>;
}
```

---

### 4.4  Real-Time Inference (Serving)

```ts
// @insighthexa/core/inference.ts

export interface InferencePort {
  /**
   * Execute a prediction synchronously.
   *
   * SLA guarantees are enforced via `Deadline`—requests exceeding the
   * configured latency budget are rejected with `ErrTimeout`.
   */
  predict<TFeatures extends Record<string, unknown>, TPrediction>(
    request: {
      modelVersion?: VersionId;   // Default → production tag
      features: TFeatures;
      deadline?: Millis;          // Soft deadline
      idempotencyKey?: string;    // Prevent double billing
    }
  ): Promise<Result<PredictionResponse<TPrediction>, DomainError>>;
}
```

Adapters:  

• `TensorFlowServingAdapter` (gRPC)  
• `OnnxRuntimeAdapter` (native)  
• `SageMakerAdapter` (REST)

---

### 4.5  Model Monitoring

```ts
// @insighthexa/core/monitoring.ts

export interface MonitoringPort {
  /**
   * Emits *serving* metrics (latency, httpStatus…).
   * Automatically batched & debounced to minimize ingestion cost.
   */
  emitOperational(metric: Metric): void;

  /**
   * Emits *business* metrics (conversions, CLV delta…).
   */
  emitBusiness(metric: Metric): void;

  /**
   * Subscribes to *drift* events via Observer pattern.
   */
  onDrift(
    cb: (event: DriftEvent) => void,
    filter?: { severity?: 'LOW' | 'MEDIUM' | 'HIGH' }
  ): UnsubscribeFn;
}
```

---

## 5  End-to-End Example ⟨source code⟩

Below is a full program illustrating how **an enterprise e-commerce platform** would integrate InsightHexaAI to predict customer churn, retrain nightly, and surface KPI alerts.

```ts
import {
  container,                             // IoC factory
  ExperimentPort,
  FeatureStorePort,
  ModelRegistryPort,
  InferencePort,
  MonitoringPort,
  Result,
} from '@insighthexa/core';

// 1. Wire dependencies via factories (hexagon-safe)
const experiment = container.resolve<ExperimentPort>('ExperimentPort');
const featureStore = container.resolve<FeatureStorePort>('FeatureStorePort');
const registry = container.resolve<ModelRegistryPort>('ModelRegistryPort');
const inference = container.resolve<InferencePort>('InferencePort');
const monitoring = container.resolve<MonitoringPort>('MonitoringPort');

async function nightlyRetrainingJob() {
  const exp = await experiment.create('churn-model-v2').unwrap(); // throws on Err

  // 1.a Fetch training set
  const trainingSet = await featureStore
    .get(['*'], { includeInactive: true })          // '*' pseudo key = full export
    .unwrap();

  // 1.b Train using domain pipeline pattern
  const artifact = await pipeline
    .source(trainingSet)
    .transform(myFeatureEng)                        // custom business rules
    .train(tfGradientBoost)                         // uses configured Strategy
    .evaluate({ metric: 'auc' })
    .serialize();                                   // returns ModelArtifact

  await experiment.logArtifact(exp.runId, artifact).unwrap();

  // 1.c Register & stage – Factory pattern selects registry backend
  const version = await registry.registerModel(artifact, {
    tags: ['nightly', 'churn'],
  }).unwrap();

  await registry.promoteStage(version, 'Staging').unwrap();
  await experiment.endRun(exp.runId, 'success');

  monitoring.emitBusiness({ name: 'MODEL_TRAINED', value: 1 });
}

async function realTimeHandler(req: Request, res: Response) {
  // 2. Real-time prediction
  const features = await featureStore.get([req.body.customerId]).unwrap();
  const pred = await inference.predict({
    features: features.get(req.body.customerId)!.values,
    idempotencyKey: req.headers['x-request-id'] as string,
  }).unwrap();

  // 2.a Send response
  res.json(pred);

  // 2.b Monitoring async
  monitoring.emitOperational({ name: 'prediction_latency_ms', value: pred.latency });
}

// 3. Drift subscription – Observer pattern
monitoring.onDrift((event) => {
  if (event.severity === 'HIGH') {
    // Auto-promote fallback model, alert Slack, open JIRA, etc.
    registry.promoteStage(event.modelVersion, 'Archived');
  }
});
```

Compile & run:

```bash
ts-node src/jobs/nightlyRetrainingJob.ts
```

---

## 6  Error Handling

Every domain method returns `Result<T, DomainError>`.

```ts
const res = await registry.promoteStage(v, 'Production');
if (res.isErr()) {
  if (res.error.kind === 'Conflict') { /* retry/backoff */ }
  logger.error(res.error.message);
}
```

`DomainError` is strictly typed (`Conflict`, `NotFound`, `Timeout`, `ValidationError`, …).  
Use `.unwrap()` in tests or short-lived scripts only.

---

## 7  FAQ

Q: *Can I bypass the Feature Store and serve raw JSON?*  
A: Technically yes, but doing so forfeits point-in-time correctness and audit guarantees.

Q: *Which license?*  
A: Commercial—contact sales@insighthexa.ai for pricing.

---

© 2024 InsightHexa Corporation. All rights reserved.
```