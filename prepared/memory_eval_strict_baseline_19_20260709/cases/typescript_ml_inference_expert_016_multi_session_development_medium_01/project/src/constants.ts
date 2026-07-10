```typescript
/**
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * constants.ts
 *
 * A centralized, type-safe catalog of application-wide constants, defaults,
 * feature toggles, and environment bindings. By funnelling every “magic
 * string” through this module, we guarantee compile-time safety and reduce
 * configuration drift across the hexagonal boundary.
 */

import { z } from 'zod'; // Small runtime validation layer (lightweight)

/* ------------------------------------------------------------------ */
/*  ENVIRONMENT DEFINITIONS                                            */
/* ------------------------------------------------------------------ */

/**
 * Supported runtime environments.  We intentionally align the enum values
 * with common `process.env.NODE_ENV` strings to ease CI/CD adoption.
 */
export enum Environment {
  Development = 'development',
  Test        = 'test',
  Staging     = 'staging',
  Production  = 'production',
}

/**
 * Coerce and validate the current environment using Zod. Fail fast if the
 * value is unexpected to prevent silent misconfiguration.
 */
const EnvironmentSchema = z.nativeEnum(Environment);

function detectEnvironment(): Environment {
  const parsed = EnvironmentSchema.safeParse(process.env.NODE_ENV ?? '');
  if (!parsed.success) {
    /* eslint-disable-next-line no-console */
    console.error(
      `[InsightHexaAI] Invalid NODE_ENV "${process.env.NODE_ENV}". ` +
        `Falling back to "${Environment.Development}".`
    );
    return Environment.Development;
  }
  return parsed.data;
}

export const CURRENT_ENV: Environment = detectEnvironment();

/* ------------------------------------------------------------------ */
/*  FEATURE FLAGS & DOMAIN CAPABILITIES                                */
/* ------------------------------------------------------------------ */

/**
 * Canonical list of product capabilities.  These are used throughout the
 * hexagon to perform compile-time discrimination of feature availability.
 */
export const FEATURES = {
  EXPERIMENT_TRACKING: 'experiment_tracking',
  MODEL_TRAINING:      'model_training',
  FEATURE_STORE:       'feature_store',
  MODEL_MONITORING:    'model_monitoring',
  MODEL_VERSIONING:    'model_versioning',
} as const;

export type FeatureKey = keyof typeof FEATURES;

/**
 * Runtime feature toggles resolved from environment variables.
 *
 * Convention:
 *   INSIGHT_HEXA_FEATURE_<UPPER_SNAKE_CASE> = "true" | "false"
 *
 * Example:
 *   INSIGHT_HEXA_FEATURE_MODEL_MONITORING=false
 */
type FeatureFlags = Record<FeatureKey, boolean>;

function loadFeatureFlags(): FeatureFlags {
  return (Object.keys(FEATURES) as Array<FeatureKey>).reduce<FeatureFlags>(
    (acc, key) => {
      const envVar = process.env[`INSIGHT_HEXA_FEATURE_${key}`];
      acc[key] = envVar ? envVar.toLowerCase() === 'true' : true; // Enabled by default
      return acc;
    },
    {} as FeatureFlags
  );
}

export const FEATURE_FLAGS: FeatureFlags = loadFeatureFlags();

/* ------------------------------------------------------------------ */
/*  KPI & BUSINESS-RULE CONSTANTS                                     */
/* ------------------------------------------------------------------ */

export const KPI = {
  CUSTOMER_LIFETIME_VALUE: 'customer_lifetime_value',
  CHURN_RISK_SCORE:        'churn_risk_score',
  PROFIT_MARGIN:           'profit_margin',
  REVENUE_FORECAST:        'revenue_forecast',
} as const;

export type KpiKey = keyof typeof KPI;

/**
 * Service-level objectives (SLO) that the core domain logic can reference
 * independent of any IO implementation.
 */
export const SLO = Object.freeze({
  MAX_P99_INFERENCE_MS: 250, // 99th percentile latency
  MAX_P50_INFERENCE_MS: 60,
});

/* ------------------------------------------------------------------ */
/*  ADAPTER PORT TOKENS                                               */
/* ------------------------------------------------------------------ */

/**
 * Dependency-Injection tokens for adapter discovery.  Using symbols avoids
 * accidental name collisions across disparate plugin packages.
 */
export const PORTS = Object.freeze({
  EventBusPort:         Symbol.for('EventBusPort'),         // Observer_Pattern
  FeatureStorePort:     Symbol.for('FeatureStorePort'),     // Adapter > Snowflake | Redis
  ModelRegistryPort:    Symbol.for('ModelRegistryPort'),    // Adapter > MLflow | S3
  TrainingPipelinePort: Symbol.for('TrainingPipelinePort'), // Pipeline_Pattern
  BillingPort:          Symbol.for('BillingPort'),          // Strategy_Pattern
});

/* ------------------------------------------------------------------ */
/*  MISCELLANEOUS CONSTANTS                                           */
/* ------------------------------------------------------------------ */

export const APP_INFO = Object.freeze({
  NAME:              'InsightHexaAI',
  VERSION:           process.env.npm_package_version ?? '0.0.0-dev',
  BUILD_TIMESTAMP:   process.env.BUILD_TIMESTAMP ?? new Date().toISOString(),
  COMMIT_SHA:        process.env.GIT_COMMIT_SHA ?? 'unknown',
});

/**
 * Default concurrency limits.  Individual adapters may opt-in to stricter
 * thresholds, but they may never exceed these values without explicit,
 * code-level acknowledgement.
 */
export const CONCURRENCY_LIMITS = Object.freeze({
  GLOBAL_MAX_PARALLEL_REQUESTS: 50,
  TRAINING_MAX_PARALLEL_JOBS:   3,
});

/* ------------------------------------------------------------------ */
/*  HELPER UTILITIES                                                  */
/* ------------------------------------------------------------------ */

/**
 * Safe accessor for strongly-typed environment variables.
 *
 * Usage:
 *   const myVar = getEnv('SOME_VAR', { required: true });
 */
export function getEnv(
  key: string,
  opts: { required?: boolean; fallback?: string } = {}
): string {
  const value = process.env[key] ?? opts.fallback;
  if (opts.required && (value === undefined || value === null)) {
    throw new Error(
      `[InsightHexaAI] Missing required env var "${key}"` +
        (CURRENT_ENV === Environment.Production ? '' : ` (fallback=${opts.fallback})`)
    );
  }
  return value ?? '';
}
```