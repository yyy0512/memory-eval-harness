```typescript
/* ========================================================================== *
 * SocialPulse Gateway — Version-aware routing & lightweight response caching *
 * ========================================================================== *
 * This module adds two cross-cutting facilities used by the HTTP facade      *
 * (Express):                                                                 *
 *   1. VersionedRouter  – dispatches incoming requests to the correct        *
 *                         controller based on the requested API version.     *
 *   2. withInMemoryCache – decorator that transparently caches idempotent    *
 *                         responses (protects high-fan-out endpoints when    *
 *                         Redis is not yet available or as fallback).        *
 * -------------------------------------------------------------------------- *
 * Both utilities are 100 % framework-agnostic except for their Express       *
 * surface, making them straightforward to unit-test and reuse across the     *
 * Gateway.                                                                   *
 * ========================================================================== */

import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';
import NodeCache from 'node-cache';
import semver from 'semver';

/* -------------------------------------------------------------------------- */
/*                                Type helpers                                */
/* -------------------------------------------------------------------------- */

/**
 * Allowed HTTP verbs for the registration API.
 */
type HttpMethod =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'head'
  | 'options';

/**
 * All metadata we store per (method, path) tuple.
 */
interface VersionedRouteRecord {
  /** Map <major version, associated handler chain> */
  versions: Map<number, RequestHandler[]>;
  /** Lazily initialised dispatching function bound to Express. */
  dispatcher?: RequestHandler;
}

/* -------------------------------------------------------------------------- */
/*                            VersionedRouter class                           */
/* -------------------------------------------------------------------------- */

/**
 * Tiny wrapper around an Express Router that supports multiple implementations
 * of the "same" logical route – one per major API version.
 *
 * @example
 * const vr = new VersionedRouter();
 * vr.register('get', '/users/:id', 1, userControllerV1);
 * vr.register('get', '/users/:id', 2, userControllerV2);
 * app.use('/api', vr.expressRouter);
 */
export class VersionedRouter {
  /** Underlying Express router instance. */
  public readonly expressRouter: Router;

  /**
   * Registry is two-level:
   *  - key#1 = `${method}:${path}`                              (constant)
   *  - value = { versions: Map<majorVersion, handler[]> }       (mutable)
   */
  private readonly registry: Map<string, VersionedRouteRecord>;

  constructor(
    private readonly opts: {
      /**
       * Optional default version when the client does not specify any.
       * If omitted, the router will respond with 400.
       */
      defaultVersion?: number;
      /**
       * Where to look for the requested version:
       *   - header:        Accept-Version / X-Api-Version
       *   - query string:  ?v=
       */
      lookupOrder?: Array<'header' | 'query'>;
    } = {}
  ) {
    this.expressRouter = Router({ mergeParams: true });
    this.registry = new Map();
    this.opts.lookupOrder = this.opts.lookupOrder ?? ['header', 'query'];
  }

  /* ---------------------------------------------------------------------- */
  /*                            Public API surface                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Register a new controller chain for the specified path / version.
   *
   * @param method   HTTP verb in lower-case
   * @param path     Express-style path template (e.g. "/users/:id")
   * @param version  Major version number (M in "vM.N.P")
   * @param handlers One or more Express handlers (middlewares + controller)
   */
  public register(
    method: HttpMethod,
    path: string,
    version: number,
    ...handlers: RequestHandler[]
  ): void {
    if (version < 1 || !Number.isInteger(version)) {
      throw new Error(
        `[VersionedRouter] Version must be a positive integer – got: ${version}`
      );
    }

    const registryKey = this.makeRegistryKey(method, path);
    const record =
      this.registry.get(registryKey) ??
      this.createRegistryEntry(method, path, registryKey);

    if (record.versions.has(version)) {
      throw new Error(
        `[VersionedRouter] Duplicate registration for ${method.toUpperCase()} ${
          path
        } v${version}`
      );
    }

    record.versions.set(version, handlers);
  }

  /* ---------------------------------------------------------------------- */
  /*                               Internals                                */
  /* ---------------------------------------------------------------------- */

  private makeRegistryKey(method: string, path: string): string {
    return `${method.toUpperCase()}:${path}`;
  }

  /**
   * When a route is added for the first time we create an Express endpoint
   * whose only job is to pick the correct versioned handler chain.
   */
  private createRegistryEntry(
    method: HttpMethod,
    path: string,
    registryKey: string
  ): VersionedRouteRecord {
    const record: VersionedRouteRecord = { versions: new Map() };

    const dispatcher: RequestHandler = (req, res, next) => {
      try {
        const requestedVersion = this.resolveRequestedVersion(req);

        const chain =
          (requestedVersion &&
            record.versions.get(requestedVersion.major ?? 0)) ??
          this.fallbackChain(record, requestedVersion?.major);

        if (!chain) {
          res.status(400).json({
            error: 'unsupported_version',
            message: `API version not supported for ${method.toUpperCase()} ${
              req.path
            }.`,
          });
          return;
        }

        // Attach negotiated version to request (for logging / metrics).
        Reflect.set(req, 'apiVersion', requestedVersion.major);
        // Execute controllers.
        this.runHandlerChain(chain, req, res, next);
      } catch (err) {
        next(err);
      }
    };

    record.dispatcher = dispatcher;
    this.registry.set(registryKey, record);

    // Bind dispatcher to Express router.
    (this.expressRouter as any)[method](path, dispatcher);

    return record;
  }

  /**
   * Parses header / query param to extract a semver range (e.g. "2", ">=1 <3").
   * We only use the major part because minor / patch must stay backward-compatible
   * according to our API policy.
   */
  private resolveRequestedVersion(
    req: Request
  ): semver.SemVer | undefined | null {
    let versionRaw: string | undefined;

    for (const channel of this.opts.lookupOrder!) {
      if (channel === 'header') {
        versionRaw =
          req.header('accept-version') ?? req.header('x-api-version') ?? undefined;
      } else if (channel === 'query') {
        versionRaw = (req.query['v'] as string | undefined) ?? versionRaw;
      }

      if (versionRaw) break;
    }

    if (!versionRaw) {
      if (typeof this.opts.defaultVersion === 'number') {
        return new semver.SemVer(`${this.opts.defaultVersion}.0.0`);
      }
      return null;
    }

    // Accept bare integers or full semver strings.
    const sanitized = /^\d+$/.test(versionRaw) ? `${versionRaw}.0.0` : versionRaw;
    if (!semver.valid(sanitized)) {
      throw new Error(
        `[VersionedRouter] Invalid version string supplied: "${versionRaw}"`
      );
    }

    return new semver.SemVer(sanitized);
  }

  /**
   * Pick the highest available version below the requested one, or use default.
   */
  private fallbackChain(
    record: VersionedRouteRecord,
    requestedMajor?: number | null
  ): RequestHandler[] | undefined {
    // (1) If explicit major requested: try to find the closest lower version.
    if (requestedMajor && requestedMajor > 0) {
      const candidates = [...record.versions.keys()]
        .filter((v) => v < requestedMajor)
        .sort((a, b) => b - a);
      return candidates.length ? record.versions.get(candidates[0]) : undefined;
    }

    // (2) Fallback to defaultVersion.
    if (this.opts.defaultVersion) {
      return record.versions.get(this.opts.defaultVersion);
    }

    // (3) Nothing found.
    return undefined;
  }

  /**
   * Executes an array of middlewares sequentially, mimicking Express' own
   * internal logic (needed because we bypassed Router's handler chain).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private runHandlerChain(
    chain: RequestHandler[],
    req: Request,
    res: Response,
    parentNext: NextFunction
  ): void {
    let idx = 0;

    const next: NextFunction = (err?: any) => {
      if (err) {
        parentNext(err);
        return;
      }
      const handler = chain[idx++];
      if (!handler) {
        parentNext();
        return;
      }
      try {
        handler(req, res, next);
      } catch (e) {
        parentNext(e);
      }
    };

    next();
  }
}

/* -------------------------------------------------------------------------- */
/*                   Simple in-process response cache decorator               */
/* -------------------------------------------------------------------------- */

const fallbackCache = new NodeCache({
  checkperiod: 120,
  useClones: false,
});

/**
 * Decorator that adds naive in-memory caching around a controller.
 * Should be used only for GET endpoints known to be idempotent.
 *
 * @param ttlSeconds      How long an entry lives in seconds.
 * @param cacheKeyBuilder Optional function returning a unique cache key
 *                        based on the request. Defaults to "<method>:<originalUrl>".
 */
export function withInMemoryCache(
  ttlSeconds = 30,
  cacheKeyBuilder?: (req: Request) => string
): (handler: RequestHandler) => RequestHandler {
  return (handler: RequestHandler): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (req.method !== 'GET') return handler(req, res, next);

        const key =
          cacheKeyBuilder?.(req) ?? `${req.method}:${req.originalUrl.toLowerCase()}`;
        const cached = fallbackCache.get<{ status: number; body: unknown; headers: Record<string, string> }>(key);

        if (cached) {
          // Replay cached response
          Object.entries(cached.headers).forEach(([k, v]) => res.setHeader(k, v));
          res.status(cached.status).json(cached.body);
          return;
        }

        // Capture outgoing payload by monkey-patching res.json
        const originalJson = res.json.bind(res);
        res.json = (body: unknown): Response => {
          const headers: Record<string, string> = {};
          // Store currently set headers (only primitives).
          Object.entries(res.getHeaders()).forEach(([k, v]) => {
            if (['string', 'number'].includes(typeof v)) {
              headers[k] = String(v);
            }
          });

          fallbackCache.set(key, { status: res.statusCode, body, headers }, ttlSeconds);
          return originalJson(body);
        };

        await handler(req, res, next);
      } catch (err) {
        next(err);
      }
    };
  };
}

/* -------------------------------------------------------------------------- */
/*                              Module Exports                               */
/* -------------------------------------------------------------------------- */

export default {
  VersionedRouter,
  withInMemoryCache,
};
```
