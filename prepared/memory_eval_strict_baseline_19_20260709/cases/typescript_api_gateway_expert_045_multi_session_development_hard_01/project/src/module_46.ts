```typescript
/**
 * SocialPulse Gateway – Core Middlewares & Helpers
 * ------------------------------------------------
 * File: src/module_46.ts
 *
 * This module bundles several cross-cutting, production-grade middlewares that
 * fulfill a subset of the gateway’s global concerns:
 *
 *   1. Request-level JSON-Schema validation (clean-architecture: presentation)
 *   2. Smart response caching backed by Redis (infrastructure)
 *   3. SemVer-aware version routing (presentation)
 *   4. Structured logging (observability)
 *
 * All helpers are framework-agnostic, but sensible defaults are provided for
 * Express/Nest-compatible interfaces.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash } from 'crypto';
import Ajv, { ErrorObject, JSONSchemaType, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import Pino from 'pino';
import Redis, { RedisOptions } from 'ioredis';

/* -------------------------------------------------------------------------- */
/*                               Logger Singleton                             */
/* -------------------------------------------------------------------------- */

/**
 * Singleton pino instance with sensible defaults.
 * App-level transports/output pipes are configured outside of this module.
 */
export const logger = Pino({
  name: 'socialpulse-gateway',
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization'],
});

/* -------------------------------------------------------------------------- */
/*                               Redis Provider                               */
/* -------------------------------------------------------------------------- */

/**
 * Thin Redis client wrapper. Inject via DI container or import directly
 * if your application is small enough.
 */
export class RedisCache {
  private static instance: RedisCache;
  private readonly client: Redis;

  private constructor(opts?: RedisOptions) {
    this.client = new Redis({
      keyPrefix: 'gw:',
      lazyConnect: true,
      ...opts,
    });

    this.client.on('error', (err) =>
      logger.error({ err }, 'Redis connection error'),
    );
  }

  static getInstance(opts?: RedisOptions): RedisCache {
    if (!RedisCache.instance) {
      RedisCache.instance = new RedisCache(opts);
    }
    return RedisCache.instance;
  }

  async connect(): Promise<void> {
    if (this.client.status === 'end' || this.client.status === 'close') {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const data = await this.client.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                               Cache Helpers                                */
/* -------------------------------------------------------------------------- */

export interface CacheOptions {
  /**
   * Time-to-live in seconds. 0 or undefined disables caching.
   */
  ttl?: number;
  /**
   * Function that decides whether the response should be cached.
   */
  shouldCache?: (req: Request, res: Response) => boolean;
  /**
   * Custom key builder. Default uses HTTP method + path + hashed query/body.
   */
  buildKey?: (req: Request) => string;
}

/**
 * Express/Nest compatible middleware for response caching.
 *
 * MUST be wired *before* the controller/business logic but *after*
 * authentication so that cache keys include user-specific identifiers when
 * necessary (e.g., `req.user.id`).
 */
export function responseCacheMiddleware(
  cacheOptions: CacheOptions = {},
): RequestHandler {
  const {
    ttl = 30, // sane default for public timeline endpoints
    shouldCache = () => true,
    buildKey = defaultCacheKeyBuilder,
  } = cacheOptions;

  const redis = RedisCache.getInstance();

  return async (req, res, next): Promise<void> => {
    if (!ttl) return next();

    const key = buildKey(req);

    try {
      await redis.connect();
      const cached = await redis.get<{ status: number; body: unknown }>(key);

      if (cached) {
        logger.debug({ key }, 'Cache hit');
        return res.status(cached.status).json(cached.body);
      }

      // monkey-patch res.json to capture payload
      const originalJson = res.json.bind(res);
      res.json = async (body: unknown) => {
        if (shouldCache(req, res)) {
          await redis.set(key, { status: res.statusCode, body }, ttl);
          logger.debug({ key }, `Cached for ${ttl}s`);
        }
        return originalJson(body);
      };

      return next();
    } catch (err) {
      logger.warn({ err }, 'Cache middleware error – falling through');
      return next();
    }
  };
}

/**
 * Default cache key builder hashing method/path/query/body/user-id.
 */
function defaultCacheKeyBuilder(req: Request): string {
  const hash = createHash('sha1')
    .update(JSON.stringify(req.query))
    .update(JSON.stringify(req.body))
    .update(String((req as any).user?.id ?? 'anon'))
    .digest('hex');

  return `resp:${req.method}:${req.baseUrl}${req.path}:${hash}`;
}

/* -------------------------------------------------------------------------- */
/*                             Request Validation                             */
/* -------------------------------------------------------------------------- */

export interface ValidationErrorPayload {
  message: string;
  errors: ErrorObject<string, Record<string, unknown>, unknown>[];
}

/**
 * Factory returning middleware that validates `req.body` against the provided
 * JSON schema using AJV. Attaches typed body to `req.validated`.
 */
export function validationMiddleware<T>(
  schema: JSONSchemaType<T>,
): RequestHandler {
  const ajv = addFormats(new Ajv({ coerceTypes: true, useDefaults: true }));
  const validate: ValidateFunction<T> = ajv.compile(schema);

  return (req: Request, res: Response, next: NextFunction): void => {
    const isValid = validate(req.body);
    if (isValid) {
      // Attach strongly typed body for further layers
      (req as Request & { validated: T }).validated = req.body as T;
      return next();
    }

    const payload: ValidationErrorPayload = {
      message: 'Request validation failed',
      errors: validate.errors ?? [],
    };

    logger.debug({ errors: payload.errors }, 'Validation error');
    res.status(422).json(payload);
  };
}

/* -------------------------------------------------------------------------- */
/*                            Semantic Versioning                             */
/* -------------------------------------------------------------------------- */

export interface VersionRouteOptions {
  /**
   * Mapping of major version number to request handler.
   * Example: { 1: controllerV1, 2: controllerV2 }
   */
  handlers: Record<number, RequestHandler>;
  /**
   * Fallback handler when the requested version isn't found.
   */
  onVersionMissing?: (requested: number, req: Request, res: Response) => void;
  /**
   * Header name or query param key for version retrieval.
   * Accepts 'Accept-Version', 'X-API-Version', etc.
   */
  lookupKey?: { header?: string; query?: string };
}

/**
 * Selects the appropriate handler based on SemVer major version.
 *
 *   • Accepts headers (`Accept-Version: 2.0`) or query (`?v=2`).
 *   • Defaults to the highest known version when absent.
 *   • Rejects unknown versions w/ 404 unless `onVersionMissing` is provided.
 */
export function versionRoutingMiddleware(
  options: VersionRouteOptions,
): RequestHandler {
  const {
    handlers,
    lookupKey = { header: 'accept-version', query: 'v' },
    onVersionMissing,
  } = options;

  const latest = Math.max(...Object.keys(handlers).map(Number));

  return (req, res, next): void => {
    const headerKey = lookupKey.header?.toLowerCase();
    const queryKey = lookupKey.query;

    const requestedVersionRaw: string | undefined =
      (headerKey && req.headers[headerKey])?.toString() ??
      (queryKey && (req.query[queryKey] as string)) ??
      '';

    // Extract major portion (e.g., "2" from "2.1.0")
    const requested = parseInt(requestedVersionRaw.split('.')[0] || '', 10);

    const version = Number.isNaN(requested) ? latest : requested;
    const handler = handlers[version];

    if (!handler) {
      logger.debug(
        { requestedVersionRaw, resolvedMajor: version },
        'Unknown API version requested',
      );
      if (onVersionMissing) return onVersionMissing(version, req, res);
      return res.status(404).json({
        message: `API version ${version} not found`,
        available: Object.keys(handlers).map(Number),
      });
    }

    logger.debug({ version }, 'Dispatching to versioned handler');
    return handler(req, res, next);
  };
}

/* -------------------------------------------------------------------------- */
/*                              Example Usage                                 */
/* -------------------------------------------------------------------------- */

/**
 * Below is an illustrative integration using Express.  In a NestJS context,
 * you would instead convert middlewares into Nest *Interceptors* or *Guards*.
 *
 *    import express from 'express';
 *    import { responseCacheMiddleware, validationMiddleware, versionRoutingMiddleware } from './module_46';
 *
 *    const app = express();
 *    app.use(express.json());
 *
 *    // Validation schema for POST /posts
 *    interface CreatePostDto { content: string; visibility: 'public' | 'private'; }
 *    const createPostSchema: JSONSchemaType<CreatePostDto> = {
 *      type: 'object',
 *      required: ['content', 'visibility'],
 *      additionalProperties: false,
 *      properties: {
 *        content: { type: 'string', minLength: 1, maxLength: 1024 },
 *        visibility: { type: 'string', enum: ['public', 'private'] },
 *      },
 *    };
 *
 *    const createPostHandlerV1: RequestHandler = (req, res) => {
 *      const { validated } = req as Request & { validated: CreatePostDto };
 *      // ... perform business logic
 *      res.status(201).json({ id: '123', ...validated });
 *    };
 *
 *    const createPostHandlerV2: RequestHandler = (req, res) => {
 *      // ... new algorithm
 *    };
 *
 *    app.post(
 *      '/posts',
 *      validationMiddleware(createPostSchema),
 *      versionRoutingMiddleware({
 *        handlers: { 1: createPostHandlerV1, 2: createPostHandlerV2 },
 *      }),
 *    );
 *
 *    // Caching for GET /timeline
 *    app.get(
 *      '/timeline',
 *      responseCacheMiddleware({ ttl: 10 }),
 *      (req, res) => { ... },
 *    );
 *
 *    app.listen(3000);
 */
```