```typescript
/**
 * src/config.ts
 *
 * Centralised, type-safe configuration manager for InsightHexaAI.
 * ----------------------------------------------------------------------------
 *  • Loads layered configuration from:
 *      1. Process environment            (highest precedence)
 *      2. Environment-specific .env file (e.g. .env.production)
 *      3. YAML/JSON file supplied via INSIGHT_HEXA_CONFIG_PATH
 *      4. Hard-coded application defaults (lowest precedence)
 *
 *  • Validates at runtime with Zod, preventing the application from booting
 *    with an invalid or incomplete configuration.
 *
 *  • Exposes a frozen, read-only Config object that can be imported anywhere
 *    within the codebase. For tests, a scoped override() helper is provided.
 * ----------------------------------------------------------------------------
 *
 * NB: All paths are resolved relative to the project root (monorepo-safe).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { config as dotenvConfig } from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                               Helper types                                 */
/* -------------------------------------------------------------------------- */

type DeepReadonly<T> = {
  readonly [K in keyof T]: DeepReadonly<T[K]>;
};

/* -------------------------------------------------------------------------- */
/*                            Default configuration                           */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  nodeEnv: 'development' as NodeEnv,
  server: {
    port: 8080,
    host: '0.0.0.0',
    requestTimeoutMs: 30_000,
    gracefulShutdownMs: 5_000,
  },
  logger: {
    level: 'info' as LogLevel,
    json: false,
  },
  database: {
    driver: 'postgres' as const,
    url: 'postgres://hexa:hexa@localhost:5432/insight_hexa',
    connectionPool: 10,
  },
  messageQueue: {
    broker: 'kafka' as const,
    clientId: 'insight-hexa',
    brokers: ['localhost:9092'],
    ssl: false,
  },
  storage: {
    bucket: 'insight-hexa-dev',
    provider: 's3' as const,
    region: 'us-east-1',
  },
  featureFlags: {
    enableAutoRetraining: false,
    enableRealTimeServing: true,
  },
  strategies: {
    revenue: 'usage_based' as RevenueStrategy,
    modelSelection: 'multi_armed_bandit' as ModelSelectionStrategy,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*                               Zod Schemas                                  */
/* -------------------------------------------------------------------------- */

const nodeEnvEnum = z.enum(['development', 'production', 'test']);
export type NodeEnv = z.infer<typeof nodeEnvEnum>;

const logLevelEnum = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof logLevelEnum>;

const revenueStrategyEnum = z.enum(['subscription', 'usage_based']);
export type RevenueStrategy = z.infer<typeof revenueStrategyEnum>;

const modelSelectionStrategyEnum = z.enum(['ab_testing', 'multi_armed_bandit']);
export type ModelSelectionStrategy = z.infer<typeof modelSelectionStrategyEnum>;

const configSchema = z.object({
  nodeEnv: nodeEnvEnum,

  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().nonempty(),
    requestTimeoutMs: z.number().int().positive(),
    gracefulShutdownMs: z.number().int().positive(),
  }),

  logger: z.object({
    level: logLevelEnum,
    json: z.boolean(),
  }),

  database: z.object({
    driver: z.literal('postgres'),
    url: z.string().url(),
    connectionPool: z.number().int().positive(),
  }),

  messageQueue: z.object({
    broker: z.literal('kafka'),
    clientId: z.string().nonempty(),
    brokers: z.array(z.string().nonempty()),
    ssl: z.boolean(),
  }),

  storage: z.object({
    bucket: z.string().nonempty(),
    provider: z.enum(['s3', 'gcs', 'azure_blob']),
    region: z.string().nonempty(),
  }),

  featureFlags: z.object({
    enableAutoRetraining: z.boolean(),
    enableRealTimeServing: z.boolean(),
  }),

  strategies: z.object({
    revenue: revenueStrategyEnum,
    modelSelection: modelSelectionStrategyEnum,
  }),
});

export type Config = DeepReadonly<z.infer<typeof configSchema>>;

/* -------------------------------------------------------------------------- */
/*                       Configuration loading mechanism                      */
/* -------------------------------------------------------------------------- */

class ConfigService {
  private static instance: Config;
  private static readonly PROJECT_ROOT = path.resolve(__dirname, '..');

  /**
   * Returns the singleton Config instance, loading + validating on first call.
   */
  static get(): Config {
    if (!this.instance) {
      this.instance = Object.freeze(this.load()) as Config;
    }
    return this.instance;
  }

  /**
   * Allows tests to temporarily override configuration.
   * Use cautiously – production code should never mutate config.
   */
  static override(partial: Partial<Config>): void {
    /* istanbul ignore next */
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Config.override() is only permitted in test mode');
    }
    const merged = { ...this.get(), ...partial } as Config;
    this.instance = Object.freeze(configSchema.parse(merged));
  }

  /* ---------------------------------------------------------------------- */
  /*                        Layered config loading steps                    */
  /* ---------------------------------------------------------------------- */

  private static load(): Config {
    // 1. Hard-coded defaults
    let cfg: Record<string, unknown> = { ...DEFAULTS };

    // 2. YAML / JSON external file
    const externalPath = process.env.INSIGHT_HEXA_CONFIG_PATH;
    if (externalPath) {
      cfg = this.deepMerge(cfg, this.parseExternalFile(externalPath));
    }

    // 3. `.env` file corresponding to NODE_ENV
    this.loadDotEnvFile();

    // 4. Environment-variable overrides
    cfg = this.deepMerge(cfg, this.fromEnv());

    // 5. Validate and return
    return configSchema.parse(cfg);
  }

  /* --------------------------- Helper utilities -------------------------- */

  private static parseExternalFile(filePath: string): Record<string, unknown> {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.PROJECT_ROOT, filePath);

    if (!fs.existsSync(absolute)) {
      throw new Error(`Configuration file not found: ${absolute}`);
    }

    const content = fs.readFileSync(absolute, 'utf8');
    try {
      if (absolute.endsWith('.json')) return JSON.parse(content);
      if (absolute.endsWith('.yaml') || absolute.endsWith('.yml')) return YAML.parse(content);
      throw new Error('Unsupported config file extension (use .json or .yaml)');
    } catch (err) {
      throw new Error(
        `Failed to parse configuration file ${absolute}: ${(err as Error).message}`,
      );
    }
  }

  private static loadDotEnvFile(): void {
    const fileName = `.env.${process.env.NODE_ENV || 'development'}`;
    const filePath = path.resolve(this.PROJECT_ROOT, fileName);
    dotenvConfig({ path: filePath, override: false });
  }

  /**
   * Convert environment variables to partial config object.
   * Naming convention: INSIGHT_HEXA__<SECTION>__<KEY>=VALUE
   *
   * Example: INSIGHT_HEXA__SERVER__PORT=3000
   */
  private static fromEnv(): Record<string, unknown> {
    const prefix = 'INSIGHT_HEXA__';
    const result: Record<string, unknown> = {};

    for (const [rawKey, rawVal] of Object.entries(process.env)) {
      if (!rawKey.startsWith(prefix) || rawVal === undefined) continue;

      const [, section, key] = rawKey.split('__'); // ['', 'SERVER', 'PORT']
      if (!section || !key) continue;

      const sectionKey = section.toLowerCase();
      const configKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).toLowerCase(); // PORT -> port

      if (!result[sectionKey]) result[sectionKey] = {};
      // Attempt to coerce primitive types
      (result[sectionKey] as Record<string, unknown>)[configKey] = this.coerce(rawVal);
    }
    return result;
  }

  private static coerce(value: string): unknown {
    if (value === 'true' || value === 'false') return value === 'true';
    if (!Number.isNaN(Number(value))) return Number(value);
    return value;
  }

  /**
   * Deep-merge helper for plain objects.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  private static deepMerge<T extends Record<string, any>, U extends Record<string, any>>(
    base: T,
    override: U,
  ): T & U {
    const output = { ...base };

    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;

      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        key in base
      ) {
        // @ts-expect-error recursive
        output[key] = this.deepMerge(base[key], value);
      } else {
        // @ts-expect-error override
        output[key] = value;
      }
    }

    return output as T & U;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Module-level export                             */
/* -------------------------------------------------------------------------- */

/**
 * Application-wide, immutable configuration object.
 *
 * Importing this module has side-effects (it reads files / env vars) –
 * ensure it’s imported as early as possible during bootstrap.
 */
export const config = ConfigService.get();
export { ConfigService };
export default config;

/* -------------------------------------------------------------------------- */
/*                                 Examples                                   */
/* -------------------------------------------------------------------------- */
/*
import { config } from './config';

console.log('Running on port', config.server.port);
if (config.featureFlags.enableAutoRetraining) {
  retrainingScheduler.start();
}
*/
```