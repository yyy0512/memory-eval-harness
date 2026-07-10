```typescript
/**************************************************************************************************
 * File:         src/module_5.ts
 * Project:      SocialPulse Gateway – API Gateway
 * Description:  Algorithm / API version negotiation & rollout utilities.
 *
 * This module encapsulates all logic related to:
 *   • Deciding which algorithm or API *version* is served to a particular caller
 *   • Rule-based and percentage-based gradual rollouts (A/B or canary)
 *   • Sticky assignment via deterministic hashing (so a user sticks to the same version)
 *   • Centralised, Redis-backed configuration & short-lived decision caching
 *
 * Public API:
 *   – VersionNegotiator.decide(...)
 *
 * The negotiator is intentionally ignorant of transport (REST / GraphQL) and of concrete
 * micro-service details; it merely produces a version string that up-stream adapters can
 * propagate to underlying services or to feature-flag checks.
 **************************************************************************************************/

import { createHash } from 'crypto';
import Redis, { Redis as RedisClient } from 'ioredis';
import deepmerge from 'deepmerge';
import { nanoid } from 'nanoid';
import { Logger } from './infrastructure/logger';

/* ------------------------------------------------------------------------------------------------
 * Domain Types
 * ---------------------------------------------------------------------------------------------- */

/**
 * A rule that dictates when a *specific* version becomes eligible.
 * Rules are evaluated sequentially (first match wins) after the “hard” checks
 * (e.g. “supportedVersions”).
 */
export type RolloutRule =
  | {
      type: 'percentage';
      /** 0–100 (inclusive, floating-point allowed) */
      value: number;
      version: string;
    }
  | {
      type: 'attribute';
      attribute: string;
      predicate: 'equals' | 'in';
      value: string | string[];
      version: string;
    };

export interface VersionedFeature {
  name: string;
  /** List of versions *supported* by the underlying service (inclusive of defaultVersion) */
  supportedVersions: readonly string[];

  /** Fallback version if no rule matches. Must belong to supportedVersions */
  defaultVersion: string;

  /** Optional set of rollout rules (first-match-wins) */
  rollout?: RolloutRule[];

  /** Optional: decision cache TTL (seconds). 0 / undefined = no cache */
  decisionTtlSec?: number;
}

/** Descriptor used by callers to make a decision */
export interface DecisionContext {
  userId?: string; // hashed for percentage rollout – if absent, will use a random value
  /** Arbitrary attributes to be used by attribute-based rules */
  attributes?: Record<string, string | number | boolean>;
}

/** Result shape returned by VersionNegotiator */
export interface VersionDecision {
  feature: string;
  chosenVersion: string;
  /** Whether the version came from cache (true) or fresh computation (false) */
  cacheHit: boolean;
  traceId: string;
}

/* ------------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------------- */

export class VersionNegotiatorError extends Error {
  constructor(message: string, public readonly feature: string) {
    super(`[VersionNegotiator] ${feature}: ${message}`);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Helper functions
 * ---------------------------------------------------------------------------------------------- */

/**
 * Produce a 0–100 float bucket based on a stable hash.
 */
const computeStableBucket = (value: string): number => {
  const hash = createHash('sha1').update(value).digest();
  // Take first 4 bytes → UInt32 → map to [0, 100)
  const bucket = (hash.readUInt32BE(0) / 0xffffffff) * 100;
  return bucket;
};

/**
 * Tiny util for safe JSON.parse with fallback.
 */
const parseJsonSafe = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------------------------------------
 * VersionNegotiator
 * ---------------------------------------------------------------------------------------------- */

export class VersionNegotiator {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly staticConfigByFeature: Record<string, VersionedFeature>;

  /**
   * @param redis          – Shared Redis client (ioredis instance)
   * @param logger         – Winston-compatible structured logger
   * @param staticConfig   – Default configuration baked with the application bundle
   */
  constructor(
    redis: RedisClient,
    logger: Logger,
    staticConfig: readonly VersionedFeature[]
  ) {
    this.redis = redis;
    this.logger = logger;
    this.staticConfigByFeature = staticConfig.reduce<Record<string, VersionedFeature>>(
      (acc, f) => {
        acc[f.name] = f;
        return acc;
      },
      {}
    );
  }

  /**
   * Decide which version of a given feature the caller should get.
   *
   * Decision order:
   *   1. Check Redis cache → return immediately if found
   *   2. Fetch *remote* config (if any) → deep merge into static config
   *   3. Validate supported versions and rules
   *   4. Evaluate rules sequentially
   *   5. Fallback to `defaultVersion`
   *   6. Persist decision in Redis (if TTL configured)
   */
  async decide(
    featureName: string,
    ctx: DecisionContext = {}
  ): Promise<VersionDecision> {
    const traceId = nanoid(10);

    const cfg = await this.resolveFeatureConfig(featureName);

    const cacheKey =
      cfg.decisionTtlSec && ctx.userId
        ? `vnd:${featureName}:${ctx.userId}`
        : undefined;

    if (cacheKey) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const chosenVersion = cached;
        this.logger.debug('VersionNegotiator cache hit', {
          featureName,
          chosenVersion,
          traceId
        });
        return { feature: featureName, chosenVersion, cacheHit: true, traceId };
      }
    }

    const chosenVersion = this.computeVersion(cfg, ctx, traceId);

    // Persist (fire-and-forget) — ignore errors
    if (cacheKey && cfg.decisionTtlSec && cfg.decisionTtlSec > 0) {
      void this.redis
        .setex(cacheKey, cfg.decisionTtlSec, chosenVersion)
        .catch((err) => {
          this.logger.warn('Failed to set version decision cache', {
            feature: featureName,
            err,
            traceId
          });
        });
    }

    return { feature: featureName, chosenVersion, cacheHit: false, traceId };
  }

  /* --------------------------------------------------------------------------------------------
   * Internal functions
   * ------------------------------------------------------------------------------------------ */

  /**
   * Fetch remote config (<feature>:cfg) from Redis and deep-merge with static config
   */
  private async resolveFeatureConfig(feature: string): Promise<VersionedFeature> {
    const staticCfg = this.staticConfigByFeature[feature];

    if (!staticCfg) {
      throw new VersionNegotiatorError('Unknown feature', feature);
    }

    const rawRemote = await this.redis.get(`feature:${feature}:cfg`);
    const remoteCfg = parseJsonSafe<Partial<VersionedFeature>>(rawRemote) || {};

    const merged = deepmerge(staticCfg, remoteCfg, {
      arrayMerge: (_dest, src) => src // override arrays completely
    }) as VersionedFeature;

    // Basic validation (throw early so bad config doesn’t propagate)
    if (!merged.supportedVersions.includes(merged.defaultVersion)) {
      throw new VersionNegotiatorError(
        `defaultVersion "${merged.defaultVersion}" not in supportedVersions`,
        feature
      );
    }

    merged.rollout?.forEach((rule, idx) => {
      if (!merged.supportedVersions.includes(rule.version)) {
        throw new VersionNegotiatorError(
          `Rule #${idx} references unsupported version "${rule.version}"`,
          feature
        );
      }
      if (rule.type === 'percentage' && (rule.value < 0 || rule.value > 100)) {
        throw new VersionNegotiatorError(
          `Rule #${idx} has invalid percentage value "${rule.value}"`,
          feature
        );
      }
    });

    return merged;
  }

  /**
   * Core rule evaluation logic.
   */
  /* eslint-disable complexity */
  private computeVersion(
    cfg: VersionedFeature,
    ctx: DecisionContext,
    traceId: string
  ): string {
    const { userId, attributes = {} } = ctx;

    for (const rule of cfg.rollout ?? []) {
      switch (rule.type) {
        case 'percentage': {
          if (!userId) {
            this.logger.debug('Skipping percentage rule – no userId', {
              feature: cfg.name,
              rule,
              traceId
            });
            continue;
          }
          const bucket = computeStableBucket(userId);
          if (bucket < rule.value) {
            this.logger.debug('Matched percentage rule', {
              feature: cfg.name,
              rule,
              bucket,
              traceId
            });
            return rule.version;
          }
          break;
        }

        case 'attribute': {
          const attrValue = attributes[rule.attribute];
          if (attrValue === undefined) continue;

          const { predicate, value: ruleVal } = rule;
          const match =
            predicate === 'equals'
              ? attrValue === ruleVal
              : Array.isArray(ruleVal)
                ? ruleVal.includes(String(attrValue))
                : false;

          if (match) {
            this.logger.debug('Matched attribute rule', {
              feature: cfg.name,
              rule,
              traceId
            });
            return rule.version;
          }
          break;
        }

        /* istanbul ignore next */
        default:
          this.logger.warn('Unsupported rule encountered, ignoring', {
            feature: cfg.name,
            rule,
            traceId
          });
      }
    }

    // Default fallback
    this.logger.debug('Falling back to defaultVersion', {
      feature: cfg.name,
      defaultVersion: cfg.defaultVersion,
      traceId
    });
    return cfg.defaultVersion;
  }
  /* eslint-enable complexity */
}

/* ------------------------------------------------------------------------------------------------
 * Exported helpers for integration tests / diagnostics
 * ---------------------------------------------------------------------------------------------- */
export const __testing = {
  computeStableBucket
};
```