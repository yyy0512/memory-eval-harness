```typescript
/**************************************************************************************************
 *  SocialPulse Gateway – Version Resolution & Routing Utilities
 *
 *  File:        src/module_75.ts
 *  Description: Centralised, pluggable “algorithm-version” resolution module.  A request can be
 *               routed to different downstream algorithm implementations (e.g. timeline-ranking
 *               V1, V2, V3) based on headers, query-params, AB-tests, or remote feature flags.
 *
 *               This module exposes:
 *                 • A strategy interface (`VersionResolverStrategy`)
 *                 • Several concrete strategies (Header, QueryParam, AB-test, RemoteFlag)
 *                 • A highly-performant composite resolver (`VersionResolver`)
 *                 • An Express middleware that attaches the resolved version to `req.algorithmVersion`
 *
 *  Architectural Layer: application ➜ use-cases / service utilities
 *  Author:     SocialPulse Gateway Platform Team
 **************************************************************************************************/

/* eslint-disable max-classes-per-file */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import LRU from 'lru-cache';

/* -----------------------------------------------------------------------------------------------
 * Shared Types
 * ---------------------------------------------------------------------------------------------*/

export interface ClientMeta {
  /** Authenticated user id (may be undefined for anonymous traffic). */
  readonly userId?: string;
  /** Source  platform, e.g. 'ios', 'android', 'web'. */
  readonly platform: string;
  /** Client-reported app version, semantic versioning string. */
  readonly appVersion?: string;
  /** Arbitrary request headers (lower-cased keys). */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Raw query string params. */
  readonly query: Record<string, string | string[] | undefined>;
}

/**
 * Strategy interface: implementors return an algorithm version string or `null` (not applicable).
 */
export interface VersionResolverStrategy {
  /**
   * @param meta Client metadata extracted from the HTTP request.
   * @returns    The resolved version or `null` if the strategy cannot decide.
   */
  resolve(meta: ClientMeta): Promise<string | null>;
}

/* -----------------------------------------------------------------------------------------------
 * 1) Header-based Strategy
 * ---------------------------------------------------------------------------------------------*/

export class HeaderVersionStrategy implements VersionResolverStrategy {
  private readonly headerName: string;

  constructor(headerName = 'x-algorithm-version') {
    this.headerName = headerName.toLowerCase();
  }

  async resolve(meta: ClientMeta): Promise<string | null> {
    const raw = meta.headers[this.headerName];
    if (!raw) return null;

    const version = Array.isArray(raw) ? raw[0] : raw;
    return version?.trim() || null;
  }
}

/* -----------------------------------------------------------------------------------------------
 * 2) Query-parameter Strategy
 * ---------------------------------------------------------------------------------------------*/

export class QueryParamVersionStrategy implements VersionResolverStrategy {
  private readonly paramName: string;

  constructor(paramName = 'algo_version') {
    this.paramName = paramName;
  }

  async resolve(meta: ClientMeta): Promise<string | null> {
    const raw = meta.query[this.paramName];
    const version = Array.isArray(raw) ? raw[0] : raw;
    return version?.trim() || null;
  }
}

/* -----------------------------------------------------------------------------------------------
 * 3) Remote Feature Flag Strategy
 * ---------------------------------------------------------------------------------------------*/

/**
 * Thin in-file facade for remote config service to keep the example self-contained.
 * Replace with your production implementation (e.g. LaunchDarkly, Unleash, etc.).
 */
export interface RemoteConfig {
  getFlag(key: string): Promise<boolean | undefined>;
  getNumber(key: string): Promise<number | undefined>;
}

class InMemoryRemoteConfig implements RemoteConfig {
  private readonly flags = new Map<string, boolean | number>();

  set(key: string, value: boolean | number): void {
    this.flags.set(key, value);
  }

  async getFlag(key: string): Promise<boolean | undefined> {
    const v = this.flags.get(key);
    return typeof v === 'boolean' ? v : undefined;
  }

  async getNumber(key: string): Promise<number | undefined> {
    const v = this.flags.get(key);
    return typeof v === 'number' ? v : undefined;
  }
}

/**
 * Basic percentage-rollout strategy: e.g. 15% of traffic gets “v2”.
 */
export class PercentageRolloutStrategy implements VersionResolverStrategy {
  private readonly version: string;
  private readonly percentageFlagKey: string;
  private readonly remoteConfig: RemoteConfig;

  constructor(opts: { version: string; percentageFlagKey: string; remoteConfig: RemoteConfig }) {
    this.version = opts.version;
    this.percentageFlagKey = opts.percentageFlagKey;
    this.remoteConfig = opts.remoteConfig;
  }

  async resolve(meta: ClientMeta): Promise<string | null> {
    const pct = await this.remoteConfig.getNumber(this.percentageFlagKey);
    if (pct === undefined || pct <= 0) return null;

    const hash = deterministicHash(meta.userId ?? meta.headers['x-forwarded-for'] ?? 'anonymous');
    const bucket = hash % 100;

    return bucket < pct ? this.version : null;
  }
}

/* -----------------------------------------------------------------------------------------------
 * 4) AB-test Strategy
 * ---------------------------------------------------------------------------------------------*/

/**
 * Assigns users to A/B buckets predictably via hashing.
 */
export class AbTestStrategy implements VersionResolverStrategy {
  private readonly versionA: string;
  private readonly versionB: string;
  private readonly treatmentPercentage: number;

  constructor(opts: { versionA: string; versionB: string; treatmentPercentage: number }) {
    if (opts.treatmentPercentage < 0 || opts.treatmentPercentage > 100) {
      throw new RangeError('treatmentPercentage must be between 0 and 100');
    }
    this.versionA = opts.versionA;
    this.versionB = opts.versionB;
    this.treatmentPercentage = opts.treatmentPercentage;
  }

  async resolve(meta: ClientMeta): Promise<string | null> {
    const id = meta.userId;
    if (!id) return null; // Only deterministically assign identifiable users.

    const bucket = deterministicHash(id) % 100;
    return bucket < this.treatmentPercentage ? this.versionB : this.versionA;
  }
}

/* -----------------------------------------------------------------------------------------------
 * Composite Resolver
 * ---------------------------------------------------------------------------------------------*/

/**
 * Combines multiple strategies (first non-null wins).  Results are cached for `ttlMs`.
 */
export class VersionResolver {
  private readonly strategies: readonly VersionResolverStrategy[];
  private readonly cache: LRU<string, string>;
  private readonly defaultVersion: string;

  constructor(opts: {
    strategies: readonly VersionResolverStrategy[];
    cacheSize?: number;
    ttlMs?: number;
    defaultVersion: string;
  }) {
    this.strategies = opts.strategies;
    this.defaultVersion = opts.defaultVersion;
    this.cache = new LRU({
      max: opts.cacheSize ?? 20_000,
      ttl: opts.ttlMs ?? 30_000, // 30 seconds sliding-expiry
    });
  }

  /**
   * Resolve version for a request (memoised while cache entry alive).
   */
  async resolve(meta: ClientMeta): Promise<string> {
    const cacheKey = buildCacheKey(meta);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    for (const s of this.strategies) {
      try {
        const v = await s.resolve(meta);
        if (v) {
          this.cache.set(cacheKey, v);
          return v;
        }
      } catch (err) {
        /* Strategy failure must not cascade. */
        // eslint-disable-next-line no-console
        console.error('[VersionResolver] strategy failed', err);
      }
    }

    this.cache.set(cacheKey, this.defaultVersion);
    return this.defaultVersion;
  }
}

/* -----------------------------------------------------------------------------------------------
 * Express Middleware
 * ---------------------------------------------------------------------------------------------*/

export interface VersionMiddlewareOptions {
  headerName?: string;
  /**
   * Attach value under custom request property (default: 'algorithmVersion').
   * Example: req.customVersionField
   */
  requestProperty?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      algorithmVersion?: string;
      correlationId?: string;
    }
  }
}

/**
 * Correlation-ID utility.  Generates RFC4122-compliant v4 UUIDs.
 */
function uuidv4(): string {
  return crypto.randomUUID();
}

/**
 * Factory that returns an Express middleware.  The resolved algorithm version is attached to the
 * request object and also emitted as a response header for diagnostic purposes.
 */
export function createVersionRoutingMiddleware(
  resolver: VersionResolver,
  opts: VersionMiddlewareOptions = {}
) {
  const headerName = opts.headerName ?? 'x-sp-algo-version';
  const requestProperty = opts.requestProperty ?? 'algorithmVersion';

  /* The actual middleware fn: */
  // eslint-disable-next-line consistent-return
  return async function versionRoutingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      // Attach correlation id early so that downstream can rely on it.
      if (!req.correlationId) {
        req.correlationId = req.headers['x-correlation-id'] as string | undefined ?? uuidv4();
        res.setHeader('x-correlation-id', req.correlationId);
      }

      const meta: ClientMeta = {
        userId: req.headers['x-user-id'] as string | undefined,
        platform: (req.headers['x-platform'] as string | undefined) ?? 'unknown',
        appVersion: req.headers['x-app-version'] as string | undefined,
        headers: req.headers as Record<string, string | string[] | undefined>,
        query: req.query as Record<string, string | string[] | undefined>,
      };

      const version = await resolver.resolve(meta);
      // @ts-ignore – dynamic index access
      req[requestProperty] = version;
      res.setHeader(headerName, version);

      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[VersionRoutingMiddleware] fatal', err);
      res.status(500).json({ error: 'Unable to route request' });
    }
  };
}

/* -----------------------------------------------------------------------------------------------
 * Helper Functions
 * ---------------------------------------------------------------------------------------------*/

/**
 * Deterministic hash for bucketing.  Non-cryptographic but fast.
 */
function deterministicHash(input: string): number {
  const hash = crypto.createHash('sha256').update(input).digest();
  // Use first 4 bytes for 32-bit number.
  return hash.readUInt32BE(0);
}

/**
 * Builds a cache key—user-specific if possible, otherwise IP + platform.
 */
function buildCacheKey(meta: ClientMeta): string {
  return meta.userId ?? `${meta.headers['x-forwarded-for'] ?? 'ip-unknown'}:${meta.platform}`;
}

/* -----------------------------------------------------------------------------------------------
 * Example Bootstrap (replace with DI container of choice)
 * ---------------------------------------------------------------------------------------------*/

/* Remote config wiring (demo only). */
const remoteConfig = new InMemoryRemoteConfig();
remoteConfig.set('timeline.v2.rolloutPct', 15);

/* Compose strategies. */
const strategies: VersionResolverStrategy[] = [
  new HeaderVersionStrategy(),
  new QueryParamVersionStrategy(),
  new PercentageRolloutStrategy({
    version: 'v2',
    percentageFlagKey: 'timeline.v2.rolloutPct',
    remoteConfig,
  }),
  new AbTestStrategy({ versionA: 'v1', versionB: 'v2', treatmentPercentage: 50 }),
];

/* Instantiate resolver & middleware. */
export const algorithmVersionResolver = new VersionResolver({
  strategies,
  defaultVersion: 'v1',
  cacheSize: 50_000,
  ttlMs: 60_000, // 1min
});

export const algorithmVersionMiddleware = createVersionRoutingMiddleware(
  algorithmVersionResolver
);

/* -----------------------------------------------------------------------------------------------
 * End of file
 * ---------------------------------------------------------------------------------------------*/
```