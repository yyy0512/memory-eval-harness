```typescript
/* ========================================================================
 * SocialPulse Gateway
 * File: module_56.ts
 * ------------------------------------------------------------------------
 * Purpose:
 *  - Centralised “timeline-algorithm” resolver that decides which ranking
 *    algorithm (v1, v2, experimental, …) should be executed for a given
 *    request.
 *  - Exposes:
 *      * AlgorithmVersionService  – async, cached resolution API
 *      * timelineAlgorithmMiddleware – Express middleware that decorates
 *        the request with the resolved version & emits structured logs.
 *
 *  - Rationale:
 *    Rolling out new versions of high-fan-out algorithms requires precise
 *    routing and rapid rollback capabilities.  A single source-of-truth
 *    component simplifies feature-flag/AB-test handling while keeping the
 *    public contract (headers, GraphQL args) stable.
 * ===================================================================== */

import axios, { AxiosError } from 'axios';
import LRUCache from 'lru-cache';
import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';

/* --------------------------------------------------------------------- */
/* Types & Constants                                                     */
/* --------------------------------------------------------------------- */

export type TimelineAlgorithmVersion = 'v1' | 'v2' | 'experimental';

/**
 * Context used to determine the effective algorithm version.
 * All properties must be serializable (for cache key derivation).
 */
export interface AlgorithmContext {
  /** Authenticated user id (empty for guest). */
  userId: string | null;
  /** Feature flag identifiers coming from the Feature-Flag service. */
  featureFlags: string[];
  /** Client platform initiating the request. */
  source: 'web' | 'ios' | 'android' | 'public-api';
  /** Explicit version requested via header / query-param, if any. */
  requestedVersion?: TimelineAlgorithmVersion;
}

interface RemoteDecision {
  version: TimelineAlgorithmVersion;
  reason: string;
  ttlSeconds: number;
}

/* Header name accepted by the gateway for explicit version selection. */
const HEADER_VERSION = 'x-timeline-algorithm-version';

/* --------------------------------------------------------------------- */
/* Logger stub – the real implementation lives elsewhere in the codebase */
/* --------------------------------------------------------------------- */

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const log: Logger =
  // Dynamically require only when present – keeps the file testable in
  // isolation without the full infra.
  // eslint-disable-next-line global-require, @typescript-eslint/consistent-type-imports
  ((): Logger => require('./infrastructure/logger').default)();
/* eslint-enable @typescript-eslint/no-var-requires */

/* --------------------------------------------------------------------- */
/* AlgorithmVersionService                                               */
/* --------------------------------------------------------------------- */

/**
 * Responsible for communicating with the remote Configuration Service,
 * performing deterministic fallbacks, and caching the outcome.
 */
export class AlgorithmVersionService {
  private readonly cache: LRUCache<string, TimelineAlgorithmVersion>;
  private readonly configServiceUrl: string;

  constructor({
    cacheMax = 10_000,
    ttlMs = 60_000,
    configServiceUrl = process.env.TIMELINE_CONFIG_SERVICE_URL ??
      'http://config-service.socialpulse.local/api/timeline',
  }: {
    cacheMax?: number;
    ttlMs?: number;
    configServiceUrl?: string;
  } = {}) {
    this.cache = new LRUCache({ max: cacheMax, ttl: ttlMs });
    this.configServiceUrl = configServiceUrl;
  }

  /**
   * Resolve the algorithm version for a user given the provided context.
   */
  public async resolveVersion(
    ctx: AlgorithmContext,
  ): Promise<TimelineAlgorithmVersion> {
    const key = this.cacheKey(ctx);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    let version: TimelineAlgorithmVersion;
    try {
      version = await this.fetchFromRemote(ctx);
      this.cache.set(key, version);
      return version;
    } catch (err) {
      /* Fallback logic — stay resilient when remote config is down. */
      const safeVersion = this.safeFallback(ctx);
      log.warn('Using safe fallback algorithm version.', {
        error: (err as Error).message,
        userId: ctx.userId,
        safeVersion,
      });
      this.cache.set(key, safeVersion, { ttl: 15_000 }); // Short TTL
      return safeVersion;
    }
  }

  /**
   * Computes an LRU-cache key from context.  We hash the value to avoid
   * storing arbitrarily long keys.
   */
  private cacheKey(ctx: AlgorithmContext): string {
    const json = JSON.stringify({
      userId: ctx.userId,
      flags: ctx.featureFlags.sort(),
      source: ctx.source,
      req: ctx.requestedVersion ?? '',
    });

    return createHash('md5').update(json).digest('hex');
  }

  /**
   * Ask the remote Configuration Service for a decision.
   * Throws if the response is not OK or cannot be parsed.
   */
  private async fetchFromRemote(
    ctx: AlgorithmContext,
  ): Promise<TimelineAlgorithmVersion> {
    try {
      const response = await axios.post<RemoteDecision>(
        `${this.configServiceUrl}/decide`,
        ctx,
        { timeout: 2_000 },
      );

      return response.data.version;
    } catch (err) {
      const axiosErr = err as AxiosError;
      log.error('Failed to fetch timeline algorithm decision.', {
        code: axiosErr.code,
        message: axiosErr.message,
        userId: ctx.userId,
      });
      throw err;
    }
  }

  /**
   * Ensures we never serve an *unknown* algorithm; logic is intentionally
   * deterministic and side-effect-free.
   */
  private safeFallback(ctx: AlgorithmContext): TimelineAlgorithmVersion {
    //  1) Respect explicit client preference if it is whitelisted.
    if (
      ctx.requestedVersion &&
      ['v1', 'v2', 'experimental'].includes(ctx.requestedVersion)
    ) {
      return ctx.requestedVersion;
    }

    //  2) Opt-in feature flag for experimental.
    if (ctx.featureFlags.includes('timeline.experimental')) {
      return 'experimental';
    }

    //  3) Mobile clients default to v2; others get v1.
    return ctx.source === 'ios' || ctx.source === 'android' ? 'v2' : 'v1';
  }
}

/* --------------------------------------------------------------------- */
/* Express Middleware                                                    */
/* --------------------------------------------------------------------- */

/**
 * Middleware that:
 *  - collects context (headers, auth, feature flags, …)
 *  - resolves the algorithm version
 *  - stores it on `res.locals.timelineAlgorithmVersion`
 *  - exposes it back via header for transparency/debugging
 */
export function timelineAlgorithmMiddleware(
  svc = new AlgorithmVersionService(),
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = buildContext(req);
      const version = await svc.resolveVersion(ctx);
      res.locals.timelineAlgorithmVersion = version;
      res.setHeader(HEADER_VERSION, version);
      next();
    } catch (err) {
      // Hard-fail if we cannot decide — guarantees downstream services
      // never receive an undefined algorithm identifier.
      log.error('TimelineAlgorithm middleware failed.', {
        path: req.path,
        error: (err as Error).message,
      });
      res.status(500).json({
        error: 'internal_error',
        message: 'Unable to resolve timeline algorithm version.',
      });
    }
  };
}

/**
 * Helper that extracts AlgorithmContext from request.
 * In a real codebase feature flags would come from the Session or
 * dedicated Flag service – here we demo via header stub.
 */
function buildContext(req: Request): AlgorithmContext {
  const userId = req.header('x-user-id') ?? null;
  const featureFlagsHeader = req.header('x-feature-flags') ?? '';
  const featureFlags = featureFlagsHeader
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const requestedVersion = req
    .header(HEADER_VERSION)
    ?.trim()
    .toLowerCase() as TimelineAlgorithmVersion | undefined;

  const source =
    (req.header('x-client-platform') as AlgorithmContext['source']) ??
    'public-api';

  return {
    userId,
    featureFlags,
    source,
    requestedVersion,
  };
}
```