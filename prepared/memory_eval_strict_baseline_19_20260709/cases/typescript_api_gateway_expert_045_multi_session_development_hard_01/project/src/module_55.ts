```typescript
/***************************************************************************************************
 *  SocialPulse Gateway – Versioned Router
 *  ------------------------------------------------------------
 *  File:        src/module_55.ts
 *  Description: A drop-in Express router wrapper that adds first-class, semver-aware
 *               version negotiation/routing for both REST and GraphQL HTTP entry points.
 *               The module encapsulates:
 *                   • Multiple version-discovery strategies (header, query, path prefix).
 *                   • Declarative registration of versioned route handlers.
 *                   • Fallbacks (e.g., “latest” or configurable default version).
 *                   • Structured logging & metrics hooks.
 *
 *  The router is designed to work in a Clean Architecture/Hexagonal style: the module lives inside
 *  the “presentation” layer and delegates business logic to application-level use-cases without
 *  leaking infrastructure concerns.
 *
 *  Usage:
 *      const vRouter = new VersionedRouter({ latestVersion: '2.1.0' });
 *      vRouter.register(
 *          'get',
 *          '/posts',
 *          '1.x',
 *          async (_req, res) => res.json(await timelineV1Controller.fetchPosts())
 *      );
 *      vRouter.register(
 *          'get',
 *          '/posts',
 *          '2.x',
 *          async (_req, res) => res.json(await timelineV2Controller.fetchPosts())
 *      );
 *      app.use('/api', vRouter.router);
 ***************************************************************************************************/

import express, {
    Request,
    Response,
    NextFunction,
    Router,
    RequestHandler,
} from 'express';
import type { Logger } from 'pino';
import pino from 'pino';
import semver from 'semver';

////////////////////////////////////////////////////////////////////////////////
// Error types
////////////////////////////////////////////////////////////////////////////////

/** Thrown when no matching version handler can be found. */
export class NoMatchingVersionError extends Error {
    constructor(public readonly requestedVersion: string | undefined) {
        super(
            `No handler registered for requested API version: ${requestedVersion}`,
        );
        this.name = 'NoMatchingVersionError';
    }
}

/** Thrown when an invalid semver string is encountered. */
export class InvalidVersionError extends Error {
    constructor(public readonly invalidVersion: string | undefined) {
        super(`Invalid semver string provided: "${invalidVersion}"`);
        this.name = 'InvalidVersionError';
    }
}

////////////////////////////////////////////////////////////////////////////////
// Interfaces / Types
////////////////////////////////////////////////////////////////////////////////

/** Supported HTTP methods for registration convenience. */
type HttpMethod =
    | 'get'
    | 'post'
    | 'put'
    | 'patch'
    | 'delete'
    | 'head'
    | 'options';

/** Strategy for extracting the requested API version from the HTTP request. */
export enum VersionSource {
    HEADER = 'header',
    QUERY = 'query',
    PATH_PREFIX = 'path',
}

/** Internal structure for a versioned route handler. */
interface VersionedHandler {
    versionRange: string; // semver range
    handler: RequestHandler;
}

/** Configuration options for the router. */
export interface VersionedRouterOptions {
    latestVersion: string;
    /**
     * Optional: Provide a concrete list of versions the gateway should acknowledge.
     * If omitted, all ranges registered for handlers will be considered valid.
     */
    supportedVersions?: string[];
    /** Where to look for the requested version. Defaults: HEADER → X-Api-Version */
    versionSource?: VersionSource;
    versionHeaderName?: string; // Only relevant when source === HEADER
    queryParamName?: string; // Only relevant when source === QUERY
    /**
     * For path-prefix negotiation, e.g., /v1/posts or /v1.2.0/posts.
     * Provide a RegExp with one capturing group that extracts the semver string.
     * Example: /^\/v(\\d+(?:\\.\\d+){0,2})/
     */
    pathVersionExtractionRegExp?: RegExp;
    /** Logger (pino-compatible). When omitted a default child logger is created. */
    logger?: Logger;
    /** Whether to fall back to latestVersion when requested version is absent. */
    defaultToLatest?: boolean;
}

////////////////////////////////////////////////////////////////////////////////
// Helper utilities
////////////////////////////////////////////////////////////////////////////////

/**
 * Extract a version string from the request based on the configured strategy.
 */
function discoverVersion(
    req: Request,
    opts: Required<
        Pick<
            VersionedRouterOptions,
            | 'versionSource'
            | 'versionHeaderName'
            | 'queryParamName'
            | 'pathVersionExtractionRegExp'
        >
    >,
): string | undefined {
    switch (opts.versionSource) {
        case VersionSource.HEADER:
            return (req.header(opts.versionHeaderName) || '').trim() || undefined;
        case VersionSource.QUERY:
            return (req.query?.[opts.queryParamName] as string | undefined)
                ?.trim() || undefined;
        case VersionSource.PATH_PREFIX: {
            const match = opts.pathVersionExtractionRegExp.exec(req.path);
            return match?.[1];
        }
        /* istanbul ignore next */
        default:
            return undefined;
    }
}

/**
 * Validate a semver string and optionally ensure it is whitelisted.
 */
function validateVersion(
    version: string | undefined,
    supportedVersions?: string[],
): string {
    if (!version) throw new InvalidVersionError(version);
    if (!semver.valid(version))
        throw new InvalidVersionError(version.replace(/[^0-9A-Za-z.-]/g, ''));
    if (
        supportedVersions &&
        !supportedVersions.some((sv) => semver.eq(semver.coerce(version)!, sv))
    ) {
        throw new NoMatchingVersionError(version);
    }
    return version;
}

////////////////////////////////////////////////////////////////////////////////
// Core class
////////////////////////////////////////////////////////////////////////////////

export class VersionedRouter {
    private readonly routes = new Map<
        string /* key: "<METHOD>::<PATH>" */,
        VersionedHandler[]
    >();

    public readonly router: Router;

    private readonly options: Required<VersionedRouterOptions>;

    private readonly logger: Logger;

    constructor(opts: VersionedRouterOptions) {
        /* -------------------- merge defaults -------------------- */
        this.options = {
            latestVersion: opts.latestVersion,
            supportedVersions: opts.supportedVersions ?? [],
            versionSource: opts.versionSource ?? VersionSource.HEADER,
            versionHeaderName: opts.versionHeaderName ?? 'X-Api-Version',
            queryParamName: opts.queryParamName ?? 'version',
            pathVersionExtractionRegExp:
                opts.pathVersionExtractionRegExp ??
                /^\/v(\d+(?:\.\d+){0,2})/,
            defaultToLatest: opts.defaultToLatest ?? true,
            logger: opts.logger ?? pino().child({ module: 'VersionedRouter' }),
        } as Required<VersionedRouterOptions>;

        this.logger = this.options.logger;
        this.router = express.Router({ mergeParams: true });

        this.router.use(this.versionDispatchMiddleware);
    }

    ////////////////////////////////////////////////////////////////////////////
    // Public API
    ////////////////////////////////////////////////////////////////////////////

    /**
     * Registers a version-specific route handler.
     *
     * @param method  HTTP verb in lower-case
     * @param path    Route path in Express syntax (e.g., "/posts/:id")
     * @param versionRange semver range string (e.g., "1.x", "^2.0.0")
     * @param handler Express request handler for the given version
     */
    public register(
        method: HttpMethod,
        path: string,
        versionRange: string,
        handler: RequestHandler,
    ): void {
        /* ---- store handler for dispatch lookup ---- */
        const key = this.composeRouteKey(method, path);
        const arr = this.routes.get(key) ?? [];
        arr.push({ versionRange, handler });
        this.routes.set(key, arr);

        /* ---- register a proxy endpoint in the underlying Express router ---- */
        // Avoid duplicate route registration – only register once per method/path
        if (arr.length === 1) {
            (this.router as any)[method](
                path,
                // the actual dispatch will happen in versionDispatchMiddleware
                (_req: Request, _res: Response, _next: NextFunction) => {
                    /* empty on purpose */
                },
            );
        }

        this.logger.info(
            {
                method,
                path,
                versionRange,
            },
            'Registered versioned route',
        );
    }

    ////////////////////////////////////////////////////////////////////////////
    // Private implementation
    ////////////////////////////////////////////////////////////////////////////

    /**
     * Middleware that determines the correct handler based on the requested
     * version and invokes it.
     *
     * NOTE: must be inserted before all dynamic proxy endpoints.
     */
    private versionDispatchMiddleware = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        const { method, path } = req;
        // Express lower-cases the method when registering, so match accordingly
        const key = this.composeRouteKey(method.toLowerCase() as HttpMethod, path);
        const candidates = this.routes.get(key);

        if (!candidates) {
            // Let Express handle 404
            return next();
        }

        // Determine requested version
        let requestedVersion: string | undefined = undefined;
        try {
            requestedVersion = discoverVersion(req, this.options);
            if (!requestedVersion && this.options.defaultToLatest) {
                requestedVersion = this.options.latestVersion;
            }
            requestedVersion = validateVersion(
                requestedVersion,
                this.options.supportedVersions.length
                    ? this.options.supportedVersions
                    : undefined,
            );
        } catch (e) {
            return this.respondWithError(res, e as Error);
        }

        // Pick the best matching handler
        const handler = this.findBestHandler(
            requestedVersion,
            candidates,
            this.options.latestVersion,
        );

        if (!handler) {
            return this.respondWithError(
                res,
                new NoMatchingVersionError(requestedVersion),
                404,
            );
        }

        // Attach metadata for downstream middlewares/controllers
        (req as any).apiVersion = requestedVersion;

        // Execute handler
        try {
            return handler(req, res, next);
        } catch (err) {
            return next(err);
        }
    };

    /**
     * Selects the highest compatible handler according to semver precedence rules.
     */
    private findBestHandler(
        requestedVersion: string,
        handlers: VersionedHandler[],
        latestVersion: string,
    ): RequestHandler | undefined {
        // Sort handlers by specificity (more recent range first)
        const sorted = [...handlers].sort((a, b) => {
            const aMax = semver.maxSatisfying(
                [latestVersion, requestedVersion],
                a.versionRange,
            );
            const bMax = semver.maxSatisfying(
                [latestVersion, requestedVersion],
                b.versionRange,
            );
            if (!aMax || !bMax) return 0;
            return semver.rcompare(aMax, bMax);
        });

        for (const h of sorted) {
            if (semver.satisfies(requestedVersion, h.versionRange)) {
                return h.handler;
            }
        }
        return undefined;
    }

    /**
     * Compose a unique key for internal route handler storage.
     */
    private composeRouteKey(method: HttpMethod, path: string): string {
        return `${method.toLowerCase()}::${path}`;
    }

    /**
     * Centralized error serializer.
     */
    /* eslint-disable @typescript-eslint/explicit-module-boundary-types */
    private respondWithError(res: Response, err: Error, status = 400) {
        this.logger.warn({ err, statusCode: status }, 'Version negotiation error');
        // Simple RFC 7807 Problem Details format
        return res.status(status).json({
            type: 'https://docs.socialpulse.io/errors#versioning',
            title: err.name,
            detail: err.message,
            status,
        });
    }
    /* eslint-enable @typescript-eslint/explicit-module-boundary-types */
}

////////////////////////////////////////////////////////////////////////////////
// Convenience factory
////////////////////////////////////////////////////////////////////////////////

/**
 * Shorthand factory that automatically wires a VersionedRouter instance and
 * returns its Express.Router. Useful for DSL-style route declarations.
 *
 * Example:
 *     export default createVersionedRouter({ latestVersion: '1.0.0' }, router => {
 *         router.register('get', '/ping', '1.x', (_req, res) => res.send('pong v1'));
 *         router.register('get', '/ping', '2.x', (_req, res) => res.send('pong v2'));
 *     });
 */
export function createVersionedRouter(
    opts: VersionedRouterOptions,
    setup: (vr: VersionedRouter) => void,
): Router {
    const vr = new VersionedRouter(opts);
    setup(vr);
    return vr.router;
}
```