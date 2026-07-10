```typescript
/**
 * SocialPulse Gateway – Version-Aware Routing & Caching Middleware
 * ---------------------------------------------------------------
 * This module is responsible for resolving upstream micro-service
 * targets based on the *requested* API version (v1, v2, …) while
 * performing ultra-fast look-ups through Redis-backed caching.
 *
 * Usage:
 *   import express from 'express';
 *   import { versionedRoutingMiddleware, VersionedRouter } from './module_23';
 *
 *   const app = express();
 *   const router = new VersionedRouter();
 *   app.use(versionedRoutingMiddleware(router));
 *
 * Clean Architecture Layer: Infrastructure ➜ Adapter (HTTP middleware)
 */

import type { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import createHttpError from 'http-errors';
import pino from 'pino';

/* ============================================================================
 * Types & Interfaces
 * ========================================================================== */

export type ApiVersion = 'v1' | 'v2' | 'v3';

export interface VersionedRouteConfig {
  apiVersion: ApiVersion;
  /**
   * Fully qualified URL (scheme + host + optional port).  
   * Path will be appended when proxying the request.
   */
  targetUrl: string;
}

export interface VersionedRouterOptions {
  /**
   * Maximum time (seconds) a route resolution should stay cached.
   * Default: 5 minutes.
   */
  ttlSeconds?: number;
  /**
   * Cache namespace prefix – allows multiple gateways to share
   * the same Redis instance without key collisions.
   */
  cachePrefix?: string;
  /**
   * Pre-configured static routing table.  
   * An API version not present here will be requested from the
   * service-registry (see `ServiceRegistryClient` below).
   */
  staticRoutes?: VersionedRouteConfig[];
}

/* ============================================================================
 * Logger
 * ========================================================================== */

const logger = pino({
  name: 'VersionedRouter',
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

/* ============================================================================
 * Minimal Service-Registry Client
 * ========================================================================== */

class ServiceRegistryClient {
  /**
   * Simulates call to a central service-registry (e.g., Consul, etcd, Eureka)
   * to obtain current routing data for an API version.
   */
  /* istanbul ignore next – external integration */
  async fetchRoute(apiVersion: ApiVersion): Promise<VersionedRouteConfig | null> {
    // In a real implementation, this would call out to the registry.
    // For demonstration we resolve an in-memory default.
    const fallback: Record<ApiVersion, string> = {
      v1: 'http://timeline-svc.internal:7100',
      v2: 'http://timeline-svc.internal:7200',
      v3: 'http://timeline-svc.internal:7300',
    };

    const targetUrl = fallback[apiVersion];
    return targetUrl ? { apiVersion, targetUrl } : null;
  }
}

/* ============================================================================
 * VersionedRouter – orchestrates route discovery & caching
 * ========================================================================== */

export class VersionedRouter {
  private readonly redis: Redis.Redis;
  private readonly ttlSeconds: number;
  private readonly cachePrefix: string;
  private readonly registry: ServiceRegistryClient;
  private readonly staticRoutes: Map<ApiVersion, VersionedRouteConfig>;

  constructor(
    redisClient?: Redis.Redis,
    opts: VersionedRouterOptions = {},
  ) {
    this.redis = redisClient ?? new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    this.ttlSeconds = opts.ttlSeconds ?? 60 * 5;
    this.cachePrefix = opts.cachePrefix ?? 'gateway:route';
    this.registry = new ServiceRegistryClient();
    this.staticRoutes = new Map(
      (opts.staticRoutes ?? []).map(cfg => [cfg.apiVersion, cfg]),
    );
  }

  /**
   * Obtain upstream target for a particular request.
   * Utilizes multi-layered resolution strategy:
   *   1. Memory (staticRoutes)
   *   2. Redis cache
   *   3. Service-registry lookup
   *
   * Throws 400 or 502 errors on failure.
   */
  async resolve(req: Request): Promise<VersionedRouteConfig> {
    const version = this.extractVersion(req);

    // 1) Check static in-memory mapping ASAP
    const staticRoute = this.staticRoutes.get(version);
    if (staticRoute) {
      logger.debug({ version, target: staticRoute.targetUrl }, 'served from static route');
      return staticRoute;
    }

    // 2) Try Redis cache
    const cacheKey = `${this.cachePrefix}:${version}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed: VersionedRouteConfig = JSON.parse(cached);
      logger.debug({ version, target: parsed.targetUrl }, 'served from redis cache');
      return parsed;
    }

    // 3) Fallback to service-registry
    const resolved = await this.registry.fetchRoute(version);
    if (!resolved) {
      throw createHttpError(502, `No upstream available for API version "${version}"`);
    }

    // Save into Redis cache (fire-and-forget)
    this.redis.set(cacheKey, JSON.stringify(resolved), 'EX', this.ttlSeconds)
      .catch(err => logger.warn({ err }, 'failed to cache route in redis'));

    logger.info({ version, target: resolved.targetUrl }, 'served from service registry');
    return resolved;
  }

  /* ------------------------------------------------------------------------
   * Helpers
   * --------------------------------------------------------------------- */

  /**
   * Determine requested API version by prioritising:
   *   1. Custom header `x-api-version`
   *   2. Accept-Version header
   *   3. URL prefix (/v1/, /v2/, …)
   * Default is `v1` to ensure backward compatibility.
   */
  extractVersion(req: Request): ApiVersion {
    const headerVersion =
      (req.headers['x-api-version'] as string | undefined) ??
      (req.headers['accept-version'] as string | undefined);

    if (headerVersion && this.isValidVersion(headerVersion)) {
      return headerVersion as ApiVersion;
    }

    const pathMatch = req.path.match(/^\/(v[0-9]+)\//);
    if (pathMatch && this.isValidVersion(pathMatch[1])) {
      return pathMatch[1] as ApiVersion;
    }

    return 'v1';
  }

  private isValidVersion(v: unknown): v is ApiVersion {
    return typeof v === 'string' && /^v[1-9][0-9]*$/.test(v);
  }
}

/* ============================================================================
 * Express Middleware
 * ========================================================================== */

/**
 * Attach `upstream` info to request.locals so downstream proxy
 * middleware can forward the call.
 */
export const versionedRoutingMiddleware =
  (router: VersionedRouter) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const route = await router.resolve(req);
      // Attach meta information for consumption by a proxy layer.
      (req as any).locals ??= {};
      (req as any).locals.upstream = route;

      next();
    } catch (err) {
      logger.error({ err }, 'failed to resolve versioned route');
      next(err);
    }
  };

/* ============================================================================
 * Re-export for convenience
 * ========================================================================== */

export default VersionedRouter;
```
