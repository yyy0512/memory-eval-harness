```typescript
// src/config.ts
// -------------------------------------------------------------------------------------------------
// MediTrade Pulse – Centralised, schema–validated application configuration
//
// This module is the single source of truth for run-time configuration across the entire platform.
// All environment variables are validated up-front with `zod`; the resulting object is deeply
// frozen to guarantee immutability and type-safety throughout the code-base.
//
// NOTE: Do NOT import `process.env` directly in business logic. Always depend on `getConfig()`.
//
// -------------------------------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { z } from 'zod';
import dotenv from 'dotenv';

// ────────────────────────────────────────────────────────────────────────────
// Load environment variables (.env, .env.local, etc.)
// ────────────────────────────────────────────────────────────────────────────
dotenv.config();

/* -------------------------------------------------------------------------------------------------
 * Helper utilities
 * -----------------------------------------------------------------------------------------------*/

/**
 * Recursively freezes an object so it cannot be mutated at runtime.
 */
function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  Object.freeze(obj);

  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value: unknown = (obj as any)[prop];
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      !Object.isFrozen(value)
    ) {
      deepFreeze(value as Record<string, unknown>);
    }
  });

  return obj;
}

/**
 * Attempts to load the project's package.json to retrieve metadata
 * (e.g., application name & version). Silently fails if not found—
 * useful during tests where paths are different.
 */
function getPackageJson(): { name: string; version: string } {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return { name: parsed.name ?? 'meditrade-pulse', version: parsed.version ?? '0.0.0' };
  } catch {
    return { name: 'meditrade-pulse', version: '0.0.0' };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Environment variable schema
 * -----------------------------------------------------------------------------------------------*/

const EnvSchema = z.object({
  /* Core ------------------------------------------------------------------ */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /* HTTP ------------------------------------------------------------------ */
  HTTP_PORT: z.coerce.number().int().positive().default(4000),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_CORS_ORIGINS: z
    .string()
    .default('*')
    .transform((v) => v.split(',').map((s) => s.trim())),
  /* Database                                                               */
  DB_WRITE_URI: z.string().url(),
  DB_READ_URI: z.string().url().optional(),
  DB_EVENTSTORE_URI: z.string().url(),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DB_SSL: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /* Encryption & Security ------------------------------------------------- */
  KMS_MASTER_KEY_ID: z.string().min(1),
  KMS_ENDPOINT: z.string().url().optional(),
  /* Risk Management ------------------------------------------------------- */
  DEFAULT_VAR_PERCENT: z.coerce.number().min(0).max(100).default(5),
  COMPLIANCE_SERVICE_URL: z.string().url(),
  /* Trading ---------------------------------------------------------------- */
  SUPPORTED_CURRENCIES: z
    .string()
    .default('USD,EUR,GBP')
    .transform((v) => v.split(',').map((c) => c.trim().toUpperCase())),
  SETTLEMENT_LAG_DAYS: z.coerce.number().int().nonnegative().default(2),
  /* Feature Flags ---------------------------------------------------------- */
  FEATURE_EVENT_SOURCING: z
    .string()
    .optional()
    .transform((v) => v !== 'false'), // default true
  FEATURE_SAGA_ORCHESTRATOR: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  FEATURE_CQRS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

/* -------------------------------------------------------------------------------------------------
 * TypeScript interfaces derived *after* validation
 * -----------------------------------------------------------------------------------------------*/

type EnvVars = z.infer<typeof EnvSchema>;

export interface DbConfig {
  uri: string;
  poolSize: number;
  ssl: boolean;
}

export interface AppConfig {
  nodeEnv: EnvVars['NODE_ENV'];
  app: {
    name: string;
    version: string;
  };
  http: {
    port: number;
    host: string;
    corsOrigins: string[];
  };
  logging: {
    level: EnvVars['LOG_LEVEL'];
    redactedFields: string[];
  };
  db: {
    write: DbConfig;
    read: DbConfig | null; // optional second-level replica
    eventStore: DbConfig;
  };
  encryption: {
    masterKeyId: string;
    kmsEndpoint?: string;
  };
  risk: {
    defaultVaRPercent: number;
    complianceServiceUrl: string;
  };
  trading: {
    supportedCurrencies: string[];
    settlementLagDays: number;
  };
  featureFlags: {
    eventSourcing: boolean;
    sagaOrchestrator: boolean;
    cqrs: boolean;
  };
}

/* -------------------------------------------------------------------------------------------------
 * Configuration builder
 * -----------------------------------------------------------------------------------------------*/

function buildConfig(): Readonly<AppConfig> {
  /* 1. Parse & validate environment variables ---------------------------- */
  const env: EnvVars = EnvSchema.parse(process.env);

  /* 2. Build the strongly-typed config object ---------------------------- */
  const pkg = getPackageJson();

  const config: AppConfig = {
    nodeEnv: env.NODE_ENV,
    app: {
      name: pkg.name,
      version: pkg.version,
    },
    http: {
      port: env.HTTP_PORT,
      host: env.HTTP_HOST,
      corsOrigins: env.HTTP_CORS_ORIGINS,
    },
    logging: {
      level: env.LOG_LEVEL,
      // All PII fields we do *not* want to appear in logs
      redactedFields: ['password', 'ssn', 'jwt', 'authorization'],
    },
    db: {
      write: {
        uri: env.DB_WRITE_URI,
        poolSize: env.DB_POOL_SIZE,
        ssl: env.DB_SSL ?? false,
      },
      read: env.DB_READ_URI
        ? {
            uri: env.DB_READ_URI,
            poolSize: env.DB_POOL_SIZE,
            ssl: env.DB_SSL ?? false,
          }
        : null,
      eventStore: {
        uri: env.DB_EVENTSTORE_URI,
        poolSize: env.DB_POOL_SIZE,
        ssl: env.DB_SSL ?? false,
      },
    },
    encryption: {
      masterKeyId: env.KMS_MASTER_KEY_ID,
      kmsEndpoint: env.KMS_ENDPOINT,
    },
    risk: {
      defaultVaRPercent: env.DEFAULT_VAR_PERCENT,
      complianceServiceUrl: env.COMPLIANCE_SERVICE_URL,
    },
    trading: {
      supportedCurrencies: env.SUPPORTED_CURRENCIES,
      settlementLagDays: env.SETTLEMENT_LAG_DAYS,
    },
    featureFlags: {
      eventSourcing: env.FEATURE_EVENT_SOURCING ?? true,
      sagaOrchestrator: env.FEATURE_SAGA_ORCHESTRATOR ?? true,
      cqrs: env.FEATURE_CQRS ?? true,
    },
  };

  /* 3. Freeze the object (defensive copy) -------------------------------- */
  return deepFreeze(config);
}

/* -------------------------------------------------------------------------------------------------
 * Public accessor (cached singleton)
 * -----------------------------------------------------------------------------------------------*/

let cachedConfig: Readonly<AppConfig> | null = null;

/**
 * Returns the global application configuration. Any attempt to call this
 * twice will return the same immutable instance, ensuring consistency across
 * files and test suites.
 */
export function getConfig(): Readonly<AppConfig> {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
  }
  return cachedConfig;
}

/* -------------------------------------------------------------------------------------------------
 * Convenience exports for destructuring (optional)
 * -----------------------------------------------------------------------------------------------*/

export const CONFIG = getConfig();
export default CONFIG;
```