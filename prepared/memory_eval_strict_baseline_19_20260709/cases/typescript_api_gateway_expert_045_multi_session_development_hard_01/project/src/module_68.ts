```typescript
// File: src/module_68.ts
// Purpose: Centralized, pluggable version–resolution middleware for the
//          SocialPulse Gateway.  It looks at various version hints
//          (Accept-Version header, URL param, query param) and resolves the
//          requested API or algorithm version.  The resolved value is
//          attached to the request object so that downstream controllers,
//          use-cases or proxy adapters can perform version-aware routing.
//
//          This module follows clean architecture boundaries: It lives in the
//          “infrastructure” layer and exposes an Express-compatible
//          middleware.  Internal concerns (parsing, validation, heuristic
//          scoring) are expressed through small strategy classes that can be
//          unit-tested in isolation.
//
// -----------------------------------------------------------------------------

import { Request, Response, NextFunction, RequestHandler } from 'express';
import createHttpError from 'http-errors';

/**
 * A strongly-typed extension to Express' Request object.
 * Downstream components may rely on `req.requestedVersion` for their routing
 * decisions.
 */
declare module 'express-serve-static-core' {
  interface Request {
    /** The semantic version extracted by VersionResolverMiddleware */
    requestedVersion?: string;
  }
}

/* ------------------------------------------------------------------------- */
/*                               Configuration                               */
/* ------------------------------------------------------------------------- */

/**
 * A map of supported, semver-like API versions and their canonical aliases.
 * In a real-world scenario this could be backed by a feature flag service
 * (e.g. LaunchDarkly) or dynamic configuration store (e.g. Consul).
 */
const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set([
  '2023-09-01', // YYYY-MM-DD date-based versions
  '2024-01-15',
  '2024-05-01',
]);

/** The version assumed when none is specified */
const DEFAULT_VERSION = '2024-05-01';

/**
 * An upper bound after which “future” versions will be rejected.  This avoids
 * issues where clients send arbitrary large versions to skip ahead in the
 * algorithm rollout.
 */
const MAX_VERSION = '2025-01-01';

/* ------------------------------------------------------------------------- */
/*                               Error Types                                 */
/* ------------------------------------------------------------------------- */

/**
 * Error thrown when a supplied version is syntactically valid but not yet
 * supported by the gateway.
 */
export class UnsupportedVersionError extends createHttpError.HttpError {
  constructor(requested: string) {
    super(
      426,
      `Requested API version ${requested} is not supported. Please upgrade your client or use one of: ${[
        ...SUPPORTED_VERSIONS,
      ].join(', ')}.`,
      {
        expose: true,
      },
    );
  }
}

/**
 * Error thrown when the version string is malformed.
 */
export class MalformedVersionError extends createHttpError.HttpError {
  constructor(raw: string) {
    super(400, `Malformed version string: "${raw}". Expected YYYY-MM-DD.`, {
      expose: true,
    });
  }
}

/* ------------------------------------------------------------------------- */
/*                             Utility Functions                             */
/* ------------------------------------------------------------------------- */

/**
 * Validates the incoming version string is in ISO8601 short date format and
 * lower than `MAX_VERSION`.
 */
function validateVersion(rawVersion: string): string {
  // Accept only ISO8601 YYYY-MM-DD for simplicity. RegExp is pre-compiled.
  const isoDateRx = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDateRx.test(rawVersion)) {
    throw new MalformedVersionError(rawVersion);
  }
  if (rawVersion > MAX_VERSION) {
    throw new UnsupportedVersionError(rawVersion);
  }
  return rawVersion;
}

/* ------------------------------------------------------------------------- */
/*                          Version Hint Strategies                           */
/* ------------------------------------------------------------------------- */

interface VersionResolutionContext {
  req: Request;
}

interface VersionStrategy {
  /**
   * Attempts to extract a version hint from the current context.
   * Returns undefined when the strategy is not applicable.
   */
  resolve(ctx: VersionResolutionContext): string | undefined;
}

/**
 * Accept-Version: 2024-05-01
 */
class HeaderVersionStrategy implements VersionStrategy {
  private readonly headerName: string;

  constructor(headerName = 'accept-version') {
    this.headerName = headerName.toLowerCase();
  }

  resolve({ req }: VersionResolutionContext): string | undefined {
    const raw = req.headers[this.headerName] as string | undefined;
    return raw?.trim();
  }
}

/**
 * /v/2024-05-01/users/…
 * The version occurs as the first path segment *after* “v”.
 */
class UrlPathVersionStrategy implements VersionStrategy {
  #prefix = '/v/';

  resolve({ req }: VersionResolutionContext): string | undefined {
    if (!req.path.startsWith(this.#prefix)) {
      return undefined;
    }
    const [, maybeVersion] = req.path.slice(this.#prefix.length).split('/', 1);
    return maybeVersion;
  }
}

/**
 * ?version=2024-05-01
 */
class QueryParamVersionStrategy implements VersionStrategy {
  #param = 'version';

  resolve({ req }: VersionResolutionContext): string | undefined {
    const raw = req.query?.[this.#param];
    if (typeof raw !== 'string') return undefined;
    return raw;
  }
}

/* ------------------------------------------------------------------------- */
/*                      Aggregating Resolver Middleware                      */
/* ------------------------------------------------------------------------- */

/**
 * The order of strategies matters; earlier strategies override later ones.
 * Header > URL path > Query param.
 */
const STRATEGIES: ReadonlyArray<VersionStrategy> = [
  new HeaderVersionStrategy(),
  new UrlPathVersionStrategy(),
  new QueryParamVersionStrategy(),
];

/**
 * Express middleware that determines the requested API version and stores it
 * on req.requestedVersion.
 *
 * Throwing an HttpError will be caught by the gateway's global error handler
 * and converted into an RFC 7807 compliant JSON error.
 */
export function versionResolverMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const ctx: VersionResolutionContext = { req };

      let resolved: string | undefined;
      for (const strategy of STRATEGIES) {
        const candidate = strategy.resolve(ctx);
        if (candidate) {
          resolved = validateVersion(candidate);
          break;
        }
      }

      // Fallback
      if (!resolved) {
        resolved = DEFAULT_VERSION;
      }

      // Enforce supported set
      if (!SUPPORTED_VERSIONS.has(resolved)) {
        throw new UnsupportedVersionError(resolved);
      }

      req.requestedVersion = resolved;
      next();
    } catch (err) {
      // Ensure the error conforms to HttpError so downstream error handler
      // knows how to format it.
      if (createHttpError.isHttpError(err)) {
        next(err);
      } else {
        next(
          createHttpError(500, 'Internal version resolution error.', {
            cause: err,
          }),
        );
      }
    }
  };
}

/* ------------------------------------------------------------------------- */
/*                               Unit Helpers                                */
/* ------------------------------------------------------------------------- */

/**
 * Programmatic entry point for unit tests or other environments where
 * middleware construction overhead would be undesirable.
 */
export function resolveVersionFor(
  partialReq: Pick<Request, 'path' | 'headers' | 'query'>,
): string {
  const dummyReq = partialReq as unknown as Request;
  const ctx: VersionResolutionContext = { req: dummyReq };

  for (const strategy of STRATEGIES) {
    const candidate = strategy.resolve(ctx);
    if (candidate) {
      return validateVersion(candidate);
    }
  }

  return DEFAULT_VERSION;
}
```