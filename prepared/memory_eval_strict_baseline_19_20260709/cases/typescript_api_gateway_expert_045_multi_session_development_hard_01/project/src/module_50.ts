```typescript
/**
 * SocialPulse Gateway
 * Module: api-version-router
 *
 * A small but critical infrastructure utility that allows us to expose
 * multiple iterations of the same REST endpoint (v1, v2, …​) under the
 * very same public URL while giving clients opt-in capability via
 * headers, query-string, or content negotiation. Deprecation and sunset
 * notices are automatically propagated through HTTP headers.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Usage
 * ──────────────────────────────────────────────────────────────────────
 *
 * import { createVersionedRouter } from './module_50';
 *
 * const router = createVersionedRouter('/posts');
 *
 * router.register('1.0.0', postControllerV1);
 * router.register('2.0.0', postControllerV2, { deprecated: true, sunsetAt: '2025-01-01' });
 *
 * app.use(router.expressRouter);
 */

import express, {
  Router,
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from 'express';
import semver, { SemVer } from 'semver';
import pino from 'pino';

/* ------------------------------------------------------------------ */
/* Logger                                                             */
/* ------------------------------------------------------------------ */

const logger = pino({
  name: 'api-version-router',
  level: process.env.LOG_LEVEL ?? 'info',
});

/* ------------------------------------------------------------------ */
/* Types / Interfaces                                                 */
/* ------------------------------------------------------------------ */

declare global {
  // Augment Express typings so downstream middlewares can rely on it
  namespace Express {
    interface Request {
      /**
       * The resolved semantic version string that should handle
       * the current request (`undefined` when nothing matched).
       */
      apiVersion?: string;
    }
  }
}

/**
 * A function that can fully handle an Express request lifecycle.
 */
export type VersionedRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;

/**
 * Per-version meta-data.
 */
export interface VersionMetadata {
  deprecated?: boolean;
  sunsetAt?: string; // ISO-8601
}

/**
 * Registration object stored internally for quick lookup.
 */
interface VersionRegistration {
  semver: SemVer;
  handler: VersionedRequestHandler;
  meta: VersionMetadata;
}

/* ------------------------------------------------------------------ */
/* Error Classes                                                      */
/* ------------------------------------------------------------------ */

/**
 * Thrown when request did not specify a valid / supported version.
 */
export class ApiVersionNegotiationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    Object.setPrototypeOf(this, ApiVersionNegotiationError.prototype);
  }
}

/**
 * Thrown when handler registration failed because of duplicates etc.
 */
export class ApiVersionRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ApiVersionRegistrationError.prototype);
  }
}

/* ------------------------------------------------------------------ */
/* Helper Functions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Try to extract a semver string from common HTTP affordances.
 *
 * Priority:
 *  1. X-API-Version header
 *  2. Accept-Version header (Heroku convention)
 *  3. "version" query parameter
 */
function resolveRequestedVersion(req: Request): string | undefined {
  const headerVersion =
    req.headers['x-api-version'] ??
    req.headers['accept-version'] ??
    req.headers['accept-version'.toLowerCase()];

  if (typeof headerVersion === 'string' && headerVersion.trim().length > 0) {
    return headerVersion.trim();
  }

  if (req.query.version && typeof req.query.version === 'string') {
    return req.query.version;
  }

  // Could not determine, return undefined – system will fallback to default
  return undefined;
}

/**
 * Append deprecation / sunset headers (RFC 8594) if applicable.
 */
function applyDeprecationHeaders(
  res: Response,
  meta: VersionMetadata,
): void {
  if (meta.deprecated) {
    res.setHeader('Deprecation', 'true');
  }
  if (meta.sunsetAt) {
    res.setHeader('Sunset', new Date(meta.sunsetAt).toUTCString());
  }
}

/* ------------------------------------------------------------------ */
/* VersionedRouter Implementation                                     */
/* ------------------------------------------------------------------ */

export class VersionedRouter {
  /** Express router instance that gets mounted into the application. */
  public readonly expressRouter: Router;

  /** Keyed by full semver. */
  private readonly registry: Map<string, VersionRegistration> = new Map();

  constructor(private readonly basePath: string) {
    this.expressRouter = express.Router({ mergeParams: true });
    // We want to handle everything below base path
    this.expressRouter.all('*', this.dispatchRequest.bind(this));
  }

  /**
   * Register a new handler under a semantic version.
   *
   * @throws ApiVersionRegistrationError if the version was already registered
   */
  public register(
    version: string,
    handler: VersionedRequestHandler,
    meta: VersionMetadata = {},
  ): void {
    if (!semver.valid(version)) {
      throw new ApiVersionRegistrationError(
        `Invalid semver string "${version}" for route ${this.basePath}`,
      );
    }

    if (this.registry.has(version)) {
      throw new ApiVersionRegistrationError(
        `Duplicate registration for version "${version}" on route ${this.basePath}`,
      );
    }

    const semVerObj = new semver.SemVer(version);

    this.registry.set(version, { semver: semVerObj, handler, meta });
    // Keep the map sorted descending by version for fastest lookup
    this.sortRegistry();
    logger.debug(
      {
        basePath: this.basePath,
        version,
        meta,
      },
      'Registered versioned handler',
    );
  }

  /**
   * Central dispatching logic invoked for every request below the
   * mounted path. Negotiates the best matching version and delegates
   * the request to the corresponding handler.
   */
  private async dispatchRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Resolve requested version, default to latest if unspecified
      const requestedVersion = resolveRequestedVersion(req);
      const registration = this.negotiateVersion(requestedVersion);

      if (!registration) {
        throw new ApiVersionNegotiationError(
          requestedVersion
            ? `Requested API version "${requestedVersion}" is not supported on ${this.basePath}`
            : `No API versions have been registered on ${this.basePath}`,
          406,
        ); // 406 Not Acceptable
      }

      req.apiVersion = registration.semver.format();

      // Add informational response headers
      res.setHeader('Content-Version', req.apiVersion);
      applyDeprecationHeaders(res, registration.meta);

      // Finally, invoke the handler
      await Promise.resolve(
        registration.handler(req, res, next),
      );
    } catch (err) {
      next(err);
    }
  }

  /**
   * Little helper for unit tests & introspection (not exported).
   */
  /* istanbul ignore next */
  private get registeredVersions(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Decide which version to pick based on the client's requested
   * constraint. When constraint is `undefined`, we default to highest.
   */
  private negotiateVersion(
    requested: string | undefined,
  ): VersionRegistration | undefined {
    if (!requested) {
      // Default fallback to highest version
      return this.registry.values().next().value;
    }

    // When the client sends a full semver (e.g. 1.2.3) we look for exact match
    if (semver.valid(requested)) {
      return this.registry.get(requested);
    }

    // Otherwise we treat the string as semver range (e.g. ^1.0.0, ~2)
    const range = semver.validRange(requested);
    if (!range) return undefined;

    // Return first (highest) version that satisfies range
    for (const reg of this.registry.values()) {
      if (semver.satisfies(reg.semver, range)) {
        return reg;
      }
    }
    return undefined;
  }

  /**
   * Re-sort internal registry whenever new handlers get added.
   * Highest versions first to speed up lookups.
   */
  private sortRegistry(): void {
    const sorted = [...this.registry.values()].sort((a, b) =>
      semver.rcompare(a.semver, b.semver),
    );
    this.registry.clear();
    for (const entry of sorted) {
      this.registry.set(entry.semver.format(), entry);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Factory Function                                                   */
/* ------------------------------------------------------------------ */

/**
 * Syntactic sugar to create a new VersionedRouter.
 *
 * @example
 * const usersRouter = createVersionedRouter('/users');
 * usersRouter.register('1.0.0', usersV1Controller);
 */
export function createVersionedRouter(basePath: string): VersionedRouter {
  return new VersionedRouter(basePath);
}

/* ------------------------------------------------------------------ */
/* Express Error-handling Middleware (optional)                       */
/* ------------------------------------------------------------------ */

/**
 * Converts ApiVersionNegotiationError into an HTTP response so every
 * service that uses VersionedRouter does not have to install its own
 * error mapper. Should be mounted after all routers.
 *
 * @example
 * app.use(versioningErrorHandler);
 */
export const versioningErrorHandler: RequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (err instanceof ApiVersionNegotiationError) {
    res
      .status(err.status)
      .json({
        error: 'version_negotiation_failed',
        message: err.message,
      })
      .end();
    return;
  }
  // delegate to other error handlers
  next(err);
};
```