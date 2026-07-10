```typescript
/**************************************************************************************************
 *  SocialPulse Gateway – Version-aware HTTP router
 *  ------------------------------------------------
 *  This module encapsulates all concerns related to HTTP/REST version negotiation.  It allows
 *  feature teams to ship multiple algorithmic versions of the same route (e.g. /timeline V1, V2),
 *  then gradually migrate traffic by tweaking the default version in configuration, HTTP header, or
 *  query-string.  It is **not** a fully-fledged API‐gateway in itself; instead, it is consumed by
 *  the top-level Express application living in `src/server.ts`.
 *
 *  Why a dedicated router?
 *  ───────────────────────
 *  • Keeps the Express bootstrap clean and focused on cross-cutting concerns (auth, logging).
 *  • Provides a single-source-of-truth for what versions exist and which one is currently active.
 *  • Makes it trivial for feature teams to add a new version with zero routing boilerplate:
 *
 *        versionedRouter.register({
 *            method  : 'get',
 *            path    : '/timeline',
 *            version : 2,
 *            handler : timelineV2Controller,
 *        });
 *
 *  Public API
 *  ──────────
 *  • register     – registers a new versioned route definition.
 *  • buildRouter  – materialises an `express.Router` ready to be mounted by the host application.
 **************************************************************************************************/

import express, { Request, Response, NextFunction, Router } from 'express';
import asyncHandler from 'express-async-handler';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import { Logger } from './infrastructure/logging';                // Winston-powered logger wrapper
import { MetricsRegistry } from './infrastructure/metrics';        // Prometheus client wrapper
import { Config } from './config';                                 // Centralised configuration access

/**************************************************************************************************
 *                                                                 Types & Interfaces
 **************************************************************************************************/

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface VersionedRouteDefinition {
    /** Express path pattern – MUST start with a forward slash. */
    path: string;
    /** HTTP verb in lowercase (Express-style). */
    method: HttpMethod;
    /** Opt-in version number, positive integer, monotonically increasing. */
    version: number;
    /** Business logic implemented as an async Express request handler. */
    handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void;
    /**
     * Optional description used for API-documentation generation (OpenAPI).
     * When omitted the path/method combo is used as an identifier.
     */
    summary?: string;
    /** Tags for grouping routes in OpenAPI UI (e.g. "Timeline", "Posts"). */
    tags?: string[];
}

/**************************************************************************************************
 *                                                               Implementation
 **************************************************************************************************/

/**
 * VersionedRouter – orchestrates Express route registration and runtime version selection.
 */
export class VersionedRouter {
    /**
     * Key structure:
     *     Map<path, Map<method, Map<version, handler>>>
     */
    private readonly registry: Map<
        string,
        Map<HttpMethod, Map<number, VersionedRouteDefinition>>
    > = new Map();

    constructor(
        private readonly logger: Logger,
        private readonly metrics: MetricsRegistry,
        private readonly config: Config
    ) {}

    // ────────────────────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * Registers a new versioned route.  If the (path, method, version) combination already exists,
     * an exception is thrown to prevent accidental overrides.
     */
    register(def: VersionedRouteDefinition): void {
        this.validateDefinition(def);

        const methodMap =
            this.registry.get(def.path) ??
            (() => {
                const m = new Map<HttpMethod, Map<number, VersionedRouteDefinition>>();
                this.registry.set(def.path, m);
                return m;
            })();

        const versionMap =
            methodMap.get(def.method) ??
            (() => {
                const v = new Map<number, VersionedRouteDefinition>();
                methodMap.set(def.method, v);
                return v;
            })();

        if (versionMap.has(def.version)) {
            throw new Error(
                `Route already registered: [${def.method.toUpperCase()}] ${def.path} v${def.version}`
            );
        }

        versionMap.set(def.version, def);
        this.logger.debug(
            `Registered route: [${def.method.toUpperCase()}] ${def.path} (v${def.version})`
        );
    }

    /**
     * Builds an Express router containing all registered routes with the correct runtime version
     * negotiation logic and error handling.
     */
    buildRouter(): Router {
        const router = express.Router({ mergeParams: true });

        // Iterate over the registry and attach the dispatching middleware per (path, method) pair.
        for (const [path, methodMap] of this.registry.entries()) {
            for (const [method, versionMap] of methodMap.entries()) {
                const availableVersions = Array.from(versionMap.keys()).sort((a, b) => b - a); // Descending

                const dispatcher = asyncHandler(
                    async (req: Request, res: Response, next: NextFunction) => {
                        const requestedVersion = this.resolveVersion(req, availableVersions);
                        const def = versionMap.get(requestedVersion);

                        if (!def) {
                            // Should not happen: resolveVersion guarantees the version is available.
                            return next(
                                new Error(
                                    `Resolved version ${requestedVersion} not found for ${method.toUpperCase()} ${path}`
                                )
                            );
                        }

                        // Set hint headers
                        res.setHeader('X-API-Version', requestedVersion.toString());
                        res.setHeader('X-API-Available-Versions', availableVersions.join(','));

                        const endTimer = this.metrics.startTimer('http_request_duration_seconds', {
                            route: path,
                            method,
                            version: requestedVersion,
                        });

                        try {
                            await Promise.resolve(def.handler(req, res, next));
                            endTimer({ status: res.statusCode.toString() });
                        } catch (err) {
                            endTimer({ status: '500' });
                            throw err; // handled by asyncHandler
                        }
                    }
                );

                (router as any)[method](path, dispatcher);

                this.logger.info(
                    `Mounted dispatcher [${method.toUpperCase()}] ${path} – versions: ${availableVersions.join(
                        ','
                    )}`
                );
            }
        }

        // 404 fallback – Express will jump here when no route matched.
        router.use((req: Request, res: Response) => {
            res.status(StatusCodes.NOT_FOUND).json({
                statusCode: StatusCodes.NOT_FOUND,
                error: getReasonPhrase(StatusCodes.NOT_FOUND),
                message: 'Endpoint not found',
            });
        });

        // Centralised error handler. This must be the last middleware.
        router.use(
            (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
                this.logger.error('Unhandled error in VersionedRouter', {
                    err,
                    path: req.path,
                    method: req.method,
                    version: res.getHeader('X-API-Version'),
                });

                const status =
                    (err as any)?.statusCode && Number.isInteger((err as any)?.statusCode)
                        ? (err as any).statusCode
                        : StatusCodes.INTERNAL_SERVER_ERROR;

                res.status(status).json({
                    statusCode: status,
                    error: getReasonPhrase(status),
                    message:
                        (err as any)?.message ??
                        'Unexpected error, please contact SocialPulse support.',
                });
            }
        );

        return router;
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * Validates a route definition at registration time.
     */
    private validateDefinition(def: VersionedRouteDefinition): void {
        if (!def.path.startsWith('/')) {
            throw new Error('Route path must start with "/"');
        }
        if (def.version <= 0 || !Number.isInteger(def.version)) {
            throw new Error('Version must be a positive integer');
        }
        if (typeof def.handler !== 'function') {
            throw new Error('Handler must be a function');
        }
    }

    /**
     * Determines the desired version based on:
     *   1. Explicit "Accept-Version" header (standard in some gateways)
     *   2. "v" query parameter (?v=2)
     *   3. Configured default override (app config)
     *   4. Highest available version (backwards compatible default)
     */
    private resolveVersion(req: Request, availableVersions: number[]): number {
        const headerVersion = req.header('Accept-Version');
        if (headerVersion && /^\d+$/.test(headerVersion)) {
            const ver = parseInt(headerVersion, 10);
            if (availableVersions.includes(ver)) {
                return ver;
            }
        }

        const queryVersionRaw = req.query['v'];
        if (queryVersionRaw && /^\d+$/.test(String(queryVersionRaw))) {
            const ver = parseInt(String(queryVersionRaw), 10);
            if (availableVersions.includes(ver)) {
                return ver;
            }
        }

        const cfgPathKey = `versioning.defaults["${req.path.toLowerCase()}"]`;
        const defaultFromConfig = this.config.get<number | undefined>(cfgPathKey);
        if (defaultFromConfig && availableVersions.includes(defaultFromConfig)) {
            return defaultFromConfig;
        }

        return availableVersions[0]; // Fallback to newest
    }
}

/**************************************************************************************************
 *                                                         Example usage (bootstrapping)
 *            (Will be shaken out by tree-shaking in production builds if unused)
 **************************************************************************************************/

if (require.main === module) {
    // This block is for local development only (`ts-node src/module_77.ts`).
    // It demonstrates how the router can be wired into a minimal Express server.
    const PORT = 3030;
    // Dynamically import to avoid dev dependency pollution during library usage.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const morgan = require('morgan');

    const logger = new Logger('dev'); // Simplified factory
    const metrics = new MetricsRegistry();
    const config = new Config({}); // Empty for demo

    const versionedRouter = new VersionedRouter(logger, metrics, config);

    // Fake controllers
    versionedRouter.register({
        path: '/hello',
        method: 'get',
        version: 1,
        async handler(req, res) {
            res.json({ msg: 'Hello from V1 👋' });
        },
    });

    versionedRouter.register({
        path: '/hello',
        method: 'get',
        version: 2,
        async handler(req, res) {
            res.json({ msg: 'Greetings from V2 🚀' });
        },
    });

    const app = express();
    app.use(morgan('dev'));
    app.use(versionedRouter.buildRouter());

    app.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`🔧 Demo server listening on http://localhost:${PORT}`);
    });
}
```
