```typescript
/***************************************************************************************************
 * SocialPulse Gateway – Response Caching & Version-Aware Route Helper
 *
 *  Layer: Infrastructure ➜ HTTP / REST Adapter
 *  File: src/module_71.ts
 *
 *  What it does:
 *  • Provides a production-ready response-caching service backed by Redis.
 *  • Exposes an Express/Router-compatible helper (createVersionedCachedRoute) that
 *    – validates incoming requests using Zod schemas,
 *    – performs automatic version negotiation (via URL segment or Accept-Version header),
 *    – transparently caches JSON responses,
 *    – streams cache hits directly from Redis,
 *    – logs structured events to the central Winston logger.
 *
 *  How to use (example):
 *
 *      import express from "express";
 *      import { createVersionedCachedRoute } from "./module_71";
 *      import { timelineV1Controller } from "../controllers/timeline.v1.controller";
 *      import { timelineV2Controller } from "../controllers/timeline.v2.controller";
 *      import { timelineQuerySchema } from "../schemas/timeline.schema";
 *
 *      const router = express.Router();
 *
 *      router.get(
 *          "/api/timeline/:userId",
 *          createVersionedCachedRoute({
 *              versions: {
 *                  "1": timelineV1Controller,
 *                  "2": timelineV2Controller,
 *              },
 *              validationSchema: timelineQuerySchema,
 *              ttlSeconds: 30, // cache hot timeline for 30 seconds
 *          }),
 *      );
 *
 ***************************************************************************************************/

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash } from "crypto";
import Redis from "ioredis";
import { z, ZodSchema } from "zod";
import winston from "winston";

/* -------------------------------------------------------------------------------------------------
 * Redis Connection (singleton)
 * -----------------------------------------------------------------------------------------------*/
const redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on("error", (err) => {
    getLogger().error("Redis connection error", { err });
});

/* -------------------------------------------------------------------------------------------------
 * Logger (Winston) – centralised logger shared across modules
 * -----------------------------------------------------------------------------------------------*/
const loggerInstance = winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: winston.format.json(),
    defaultMeta: { service: "api_gateway" },
    transports: [new winston.transports.Console()],
});

function getLogger(): winston.Logger {
    return loggerInstance;
}

/* -------------------------------------------------------------------------------------------------
 * ResponseCacheService
 * -----------------------------------------------------------------------------------------------*/

/**
 * Key derivation helper – keeps cache keys deterministic and segregated by
 * API version + route + user (when applicable).
 */
export interface CacheKeyContext {
    version: string;
    route: string;
    /**
     * A unique identifier representing user-specific contexts
     * (e.g. viewerId or tenantId). For public resources pass <PUBLIC>.
     */
    scope: string;
    /**
     * Request-derived additional string to differentiate query parameters.
     * Pre-hashing and ordering is handled internally.
     */
    query: Record<string, unknown>;
}

export class ResponseCacheService {
    constructor(
        private readonly redisClient: Redis,
        private readonly logger: winston.Logger,
    ) {}

    /**
     * Look up cache; if miss, execute `producer()` to generate a fresh payload.
     * When producer resolves, the value is cached under the derived key.
     */
    async getOrCreate<T>(
        context: CacheKeyContext,
        ttlSeconds: number,
        producer: () => Promise<T>,
    ): Promise<{ payload: T; hit: boolean }> {
        const key = this.buildKey(context);

        // Try fast path: cache hit
        const cached = await this.redisClient.get(key);
        if (cached) {
            this.logger.debug("Cache hit", { cacheKey: key });
            return { payload: JSON.parse(cached) as T, hit: true };
        }

        // Miss → compute fresh
        const startTs = Date.now();
        const payload = await producer();
        const latency = Date.now() - startTs;

        // Store
        await this.redisClient.set(key, JSON.stringify(payload), "EX", ttlSeconds).catch((err) => {
            this.logger.error("Failed to set Redis cache", { err, cacheKey: key });
        });

        this.logger.debug("Cache miss", { cacheKey: key, latencyMs: latency });

        return { payload, hit: false };
    }

    /**
     * Drop cached entries for a given route & scope (fan-out invalidation).
     * Example: after posting to timeline, call purge({ route: "/timeline", scope: userId })
     */
    async purge(route: string, scope: string): Promise<number> {
        const matchGlob = `v*|${route}|${scope}|*`;
        const keys = await this.redisClient.keys(matchGlob);
        if (keys.length === 0) return 0;
        await this.redisClient.del(keys);
        return keys.length;
    }

    private buildKey({ version, route, scope, query }: CacheKeyContext): string {
        const paramsHash = createHash("sha1")
            .update(JSON.stringify(this.sortObject(query)))
            .digest("hex");

        /* Key format:
         *   v<version>|<route>|<scope>|<paramsHash>
         *   Example:
         *   v1|/timeline|user:123|18e9120...
         */
        return `v${version}|${route}|${scope}|${paramsHash}`;
    }

    private sortObject(obj: Record<string, unknown>): Record<string, unknown> {
        return Object.fromEntries(Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])));
    }
}

/* Instantiate singleton */
const cacheService = new ResponseCacheService(redis, getLogger());

/* -------------------------------------------------------------------------------------------------
 * Version Negotiation Helper
 * -----------------------------------------------------------------------------------------------*/

interface VersionedControllerMap {
    [version: string]: RequestHandler;
}

/**
 * Reads requested API version from (in order):
 *  1. Explicit numeric segment in route param ":version"
 *  2. "Accept-Version" header
 *  3. Falls back to defaultVersion
 */
function extractRequestedVersion(req: Request, defaultVersion: string): string {
    const fromParam = (req.params.version ?? "").trim();
    if (fromParam) return fromParam;

    const fromHeader = (req.headers["accept-version"] ?? "").toString().trim();
    if (fromHeader) return fromHeader;

    return defaultVersion;
}

/* -------------------------------------------------------------------------------------------------
 * createVersionedCachedRoute – Factory
 * -----------------------------------------------------------------------------------------------*/

export interface VersionedCachedRouteOptions {
    versions: VersionedControllerMap;
    /**
     * Default version if client omits negotiation.
     */
    defaultVersion?: string;
    /**
     * Zod schema that validates and sanitises req.query.
     */
    validationSchema?: ZodSchema<any>;
    /**
     * Cache TTL in seconds. If 0 or undefined, caching is disabled.
     */
    ttlSeconds?: number;
    /**
     * Extract scope strategy. Defaults to userId param or `<PUBLIC>`.
     */
    scopeExtractor?: (req: Request) => string;
}

/**
 * Factory that returns an Express middleware chain honouring:
 * • request validation,
 * • version negotiation,
 * • response caching.
 */
export const createVersionedCachedRoute = ({
    versions,
    defaultVersion = Object.keys(versions)[0],
    validationSchema,
    ttlSeconds = 0,
    scopeExtractor = (req) => req.params.userId ?? "<PUBLIC>",
}: VersionedCachedRouteOptions): RequestHandler[] => {
    const middleware: RequestHandler = async (
        req: Request,
        res: Response,
        next: NextFunction,
    ) => {
        const log = getLogger();
        const version = extractRequestedVersion(req, defaultVersion);

        /* Request validation – if provided */
        if (validationSchema) {
            const parsed = validationSchema.safeParse(req.query);
            if (!parsed.success) {
                log.debug("Validation error", { errors: parsed.error.format() });
                return res.status(400).json({
                    error: "BAD_REQUEST",
                    details: parsed.error.issues,
                });
            }
            req.query = parsed.data; // sanitised
        }

        /* De-multiplex controller by version */
        const controller = versions[version];
        if (!controller) {
            log.debug("Unsupported version", { version, available: Object.keys(versions) });
            return res.status(400).json({
                error: "UNSUPPORTED_VERSION",
                details: `Version ${version} is not available for this endpoint.`,
            });
        }

        /* If caching disabled or request is not GET, short-circuit. */
        if (ttlSeconds <= 0 || req.method !== "GET") {
            return controller(req, res, next);
        }

        /* Caching path */
        try {
            const { payload, hit } = await cacheService.getOrCreate(
                {
                    version,
                    route: req.route?.path ?? req.path,
                    scope: scopeExtractor(req),
                    query: req.query,
                },
                ttlSeconds,
                async () =>
                    new Promise<any>((resolve, reject) => {
                        // Intercept controller's response by monkey-patching res.json
                        const originalJson = res.json.bind(res) as (body: any) => Response;

                        // Replace json to capture payload
                        res.json = (body: any): Response => {
                            resolve(body);
                            return originalJson(body);
                        };

                        // Call actual controller
                        controller(req, res, (err?: any) => {
                            if (err) reject(err);
                        });
                    }),
            );

            if (hit) {
                return res.setHeader("X-Cache", "HIT").json(payload);
            } else {
                res.setHeader("X-Cache", "MISS");
                // controller already sent response via monkey-patched json
                return;
            }
        } catch (error) {
            /* Fall back to non-cached execution in case of errors */
            getLogger().error("Error in caching layer, delegating to controller", { error });
            return controller(req, res, next);
        }
    };

    return [middleware];
};

/* -------------------------------------------------------------------------------------------------
 * Validation Schema Example (can be imported elsewhere)
 * -----------------------------------------------------------------------------------------------*/
/**
 * Example schema for timeline queries. Left in module for illustration;
 * in real code, export from dedicated `/schemas`.
 */
export const timelineQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .transform((val) => (isNaN(val) ? 20 : val)),
});

/* -------------------------------------------------------------------------------------------------
 * Health probe for Redis – can be imported by health-check route
 * -----------------------------------------------------------------------------------------------*/
export async function probeRedis(): Promise<{
    ok: boolean;
    latencyMs: number;
}> {
    const start = Date.now();
    try {
        await redis.ping();
        return { ok: true, latencyMs: Date.now() - start };
    } catch {
        return { ok: false, latencyMs: Date.now() - start };
    }
}
```