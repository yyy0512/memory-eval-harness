import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { Counter, Registry } from 'prom-client';
import createHttpError from 'http-errors';
import ms from 'ms';
import debugFactory from 'debug';

/**
 * module_48.ts
 *
 * Purpose:
 *   Centralised API-version resolution and feature-flag hydration middleware
 *   for the SocialPulse Gateway.
 *
 *   – Extracts requested API version (header | query | URL prefix)
 *   – Rejects unsupported versions
 *   – Emits deprecation warnings
 *   – Hydrates user-scoped feature flags from Redis
 *   – Provides helper utilities to resolve downstream micro-service targets
 *   – Emits Prometheus metrics for observability
 */

const debug = debugFactory('socialpulse:gateway:versioning');

/* ------------------------------------------------------------------ */
/*                           Version Config                            */
/* ------------------------------------------------------------------ */

export const SUPPORTED_VERSIONS = ['v1', 'v2', 'v3'] as const;
export type SupportedVersion = typeof SUPPORTED_VERSIONS[number];

export const DEPRECATED_VERSIONS: ReadonlySet<string> = new Set(['v1']);
export const EXPERIMENTAL_VERSIONS: ReadonlySet<string> = new Set(['beta']);

/* ------------------------------------------------------------------ */
/*                        Middleware: Options                          */
/* ------------------------------------------------------------------ */

export interface VersioningOptions {
  /** If true and client fails to supply a version ⇒ 400 Bad-Request */
  requireVersion?: boolean;
  /** HTTP header checked first; default: "x-api-version" */
  headerName?: string;
  /** Query-param fallback; default: "version" */
  queryParam?: string;
  /**
   * Cache TTL for in-memory feature-flag cache, e.g. "10m".
   * Prevents hammering Redis every request.
   */
  featureFlagCacheTtl?: string;
  /** Redis connection used for feature flags (optional) */
  redis?: Redis;
  /** Prometheus registry for metrics; defaults to globalRegistry */
  metricsRegistry?: Registry;
}

type RequiredOpts = Required<Omit<VersioningOptions, 'redis' | 'metricsRegistry'>>;

/* ------------------------------------------------------------------ */
/*                       Gateway Request Shape                         */
/* ------------------------------------------------------------------ */

export interface FeatureFlags {
  [flag: string]: boolean;
}

export interface GatewayRequest extends Request {
  apiVersion: SupportedVersion | 'beta' | undefined;
  featureFlags: FeatureFlags;
}

/* ------------------------------------------------------------------ */
/*                      Middleware Implementation                      */
/* ------------------------------------------------------------------ */

const FEATURE_FLAG_CACHE_PREFIX = '__ff_cache__';

const defaults: RequiredOpts = {
  requireVersion: false,
  headerName: 'x-api-version',
  queryParam: 'version',
  featureFlagCacheTtl: '5m',
};

/**
 * Creates an express middleware to handle API-versioning concerns.
 *
 * Usage:
 *   app.use(versioningMiddleware({ redis, requireVersion: true }));
 */
export function versioningMiddleware(opts: VersioningOptions = {}) {
  const options: VersioningOptions & RequiredOpts = { ...defaults, ...opts };

  /* --------------- Prometheus metric ---------------- */
  const versionCounter = new Counter({
    name: 'gateway_api_version_requests_total',
    help: 'Total HTTP requests grouped by resolved API version',
    labelNames: ['version'],
    registers: options.metricsRegistry ? [options.metricsRegistry] : undefined,
  });

  return async (req: GatewayRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const version = resolveVersion(req, options);

      /* -------------- Validation ---------------- */
      if (!version && options.requireVersion) {
        throw createHttpError(400, 'API version not specified');
      }
      if (version && !isAcceptedVersion(version)) {
        throw createHttpError(400, `Unsupported API version "${version}"`);
      }

      /* -------------- Attach to request ---------------- */
      req.apiVersion = version;
      res.setHeader('x-api-version', version ?? 'none');
      handleDeprecation(res, version);

      /* -------------- Metrics ---------------- */
      versionCounter.inc({ version: version ?? 'none' });

      /* -------------- Feature Flags ---------------- */
      req.featureFlags = await loadFeatureFlags(req, options);

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/* ------------------------------------------------------------------ */
/*                       Helper – Version Resolve                      */
/* ------------------------------------------------------------------ */

function resolveVersion(req: Request, opts: RequiredOpts): string | undefined {
  const header = (req.headers[opts.headerName.toLowerCase()] as string | undefined)?.toLowerCase();
  if (header) {
    debug('Version resolved from header: %s', header);
    return header;
  }

  const query = (req.query?.[opts.queryParam] as string | undefined)?.toLowerCase();
  if (query) {
    debug('Version resolved from query: %s', query);
    return query;
  }

  const [firstSegment] = req.path.replace(/^\//, '').split('/');
  if (firstSegment && (firstSegment.startsWith('v') || firstSegment === 'beta')) {
    debug('Version resolved from path segment: %s', firstSegment);
    return firstSegment.toLowerCase();
  }

  return undefined;
}

function isAcceptedVersion(ver: string): boolean {
  return SUPPORTED_VERSIONS.includes(ver as SupportedVersion) || EXPERIMENTAL_VERSIONS.has(ver);
}

function handleDeprecation(res: Response, version?: string): void {
  if (version && DEPRECATED_VERSIONS.has(version)) {
    res.append('Warning', `299 - "Version ${version} is deprecated and will be removed in a future release"`);
  }
}

/* ------------------------------------------------------------------ */
/*                     Helper – Feature Flags (Redis)                  */
/* ------------------------------------------------------------------ */

const memCache = new Map<string, { flags: FeatureFlags; expires: number }>();

async function loadFeatureFlags(req: Request, opts: VersioningOptions & RequiredOpts): Promise<FeatureFlags> {
  if (!opts.redis) return {};

  const userId = (req as any).user?.id;
  if (!userId) return {};

  const cacheKey = `${FEATURE_FLAG_CACHE_PREFIX}:${userId}`;
  const now = Date.now();
  const cached = memCache.get(cacheKey);
  if (cached && cached.expires > now) return cached.flags;

  try {
    const redisKey = `feature_flags:${userId}`;
    const raw = await opts.redis.get(redisKey);
    const flags: FeatureFlags = raw ? JSON.parse(raw) : {};

    memCache.set(cacheKey, { flags, expires: now + ms(opts.featureFlagCacheTtl) });
    return flags;
  } catch (err) {
    debug('Failed to fetch feature flags for %s: %O', userId, err);
    /* fail-open: treat as no flags */
    return {};
  }
}

/* ------------------------------------------------------------------ */
/*               Utility – Downstream Service Resolution               */
/* ------------------------------------------------------------------ */

export interface ServiceMap {
  readonly [serviceName: string]: { readonly [ver in SupportedVersion | 'latest']: string };
}

/**
 * Static example – in production this may be hydrated from Consul / env / config-service
 */
export const DEFAULT_SERVICE_MAP: ServiceMap = {
  timeline: {
    v1: 'http://timeline-v1:4000',
    v2: 'http://timeline-v2:4000',
    v3: 'http://timeline-v3:4000',
    latest: 'http://timeline-v3:4000',
  },
  messaging: {
    v1: 'http://messaging-v1:4100',
    v2: 'http://messaging-v2:4100',
    v3: 'http://messaging-v3:4100',
    latest: 'http://messaging-v3:4100',
  },
};

/**
 * Resolves the base-URL for a downstream micro-service based on API version.
 *
 * Example:
 *   const base = resolveServiceTarget('timeline', req.apiVersion);
 */
export function resolveServiceTarget(
  service: keyof ServiceMap,
  version: SupportedVersion | undefined,
  registry: ServiceMap = DEFAULT_SERVICE_MAP,
): string {
  const svc = registry[service];
  if (!svc) throw new Error(`Unknown service "${String(service)}"`);
  return (version && svc[version]) || svc.latest;
}

/* ------------------------------------------------------------------ */
/*               Optional – Express Error-Handler Helper               */
/* ------------------------------------------------------------------ */

export function versioningErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (!isHttpErr(err)) return next(err);

  res.status(err.statusCode).json({
    error: { type: 'VERSIONING_ERROR', message: err.message },
  });
}

function isHttpErr(e: any): e is createHttpError.HttpError {
  return e?.statusCode && typeof e.statusCode === 'number';
}