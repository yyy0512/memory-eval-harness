```typescript
/**
 * SocialPulse Gateway
 * File: src/module_80.ts
 *
 * Description:
 *  Version-aware router + request middleware bundle that wires together:
 *    • Strict API-version negotiation
 *    • Schema-based request validation
 *    • Redis-backed rate-limiting and response caching
 *    • Structured logging + telemetry
 *
 *  Designed to be registered at the infrastructure/presentation boundary:
 *    import { composeTimelineEndpoint } from './module_80';
 *    app.use('/timeline', composeTimelineEndpoint(dependencies));
 *
 *  NOTE:
 *    – External interface remains framework-agnostic (Express | Fastify | …)
 *      by exposing plain HTTP-style handlers (req, res, next).
 *    – All framework-specific glue lives inside adapter layers elsewhere.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import express from 'express';
import { z, ZodSchema } from 'zod';
import Redis from 'ioredis';
import { v4 as uuidV4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import ms from 'ms';

/* ======================================================================================
 * Domain-level types
 * ====================================================================================*/

export enum ApiVersion {
  V1 = '1',
  V2 = '2',
}

export interface TimelineParams {
  userId: string;
  cursor?: string;
  limit?: number;
}

export interface TimelineItem {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface TimelineService {
  /**
   * Fetch a timeline for a user.
   */
  fetchTimeline(
    params: TimelineParams,
    version: ApiVersion
  ): Promise<TimelineItem[]>;
}

/* ======================================================================================
 * Configuration helpers
 * ====================================================================================*/

export interface EndpointDependencies {
  timelineService: TimelineService;
  redis: Redis;
  logger: Logger;
}

/**
 * Minimal structured logger interface compatible with pino/winston/etc.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/* ======================================================================================
 * Middleware building blocks
 * ====================================================================================*/

/**
 * Parse the `Accept-Version` header (or fallback query param `v`) and validate.
 * Defaults to V1 when not provided.
 */
function negotiateApiVersion(req: Request): ApiVersion {
  const headerValue =
    (req.headers['accept-version'] as string | undefined) ??
    (req.query.v as string | undefined) ??
    ApiVersion.V1;
  const normalised = headerValue.trim();

  if (Object.values(ApiVersion).includes(normalised as ApiVersion)) {
    return normalised as ApiVersion;
  }

  throw new HttpError(406, `Unsupported API version: ${normalised}`);
}

/**
 * Factory for request-validation middleware.
 */
function withValidation<T>(
  schema: ZodSchema<T>
): RequestHandler<
  Record<string, unknown>,
  unknown,
  unknown,
  Record<string, unknown>
> {
  return (req, _res, next) => {
    try {
      // Merge route params + query params for validation convenience.
      const input = { ...req.params, ...req.query };
      (req as any).validated = schema.parse(input); // attach to request
      return next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(new HttpError(422, 'Validation failed', err.flatten()));
      }
      return next(err);
    }
  };
}

/**
 * Redis-backed response caching decorator.
 */
function cacheResponse(
  redis: Redis,
  ttlMs: number
): (handler: RequestHandler) => RequestHandler {
  return (handler) => {
    return async (req, res, next) => {
      try {
        const cacheKey = generateCacheKey(req);
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.setHeader('X-Cache', 'HIT');
          res.type('application/json').send(cached);
          return;
        }

        // Monkey-patch res.json to capture payload
        const originalJson = res.json.bind(res);
        (res as any).json = async (payload: any) => {
          try {
            await redis.set(cacheKey, JSON.stringify(payload), 'PX', ttlMs);
          } catch (e) {
            /* cache set should never block response */
          }
          res.setHeader('X-Cache', 'MISS');
          return originalJson(payload);
        };

        return handler(req, res, next);
      } catch (err) {
        return next(err);
      }
    };
  };
}

/**
 * Rate-limit per IP + endpoint using express-rate-limit.
 */
function rateLimiter(windowMs: number, max: number): RequestHandler {
  return rateLimit({
    windowMs,
    max,
    handler: (_req, res) =>
      res
        .status(429)
        .json({ error: 'Too Many Requests', code: 429, ts: Date.now() }),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      `${req.ip}:${req.path}:${negotiateApiVersion(req)}`, // isolate by API version
  });
}

/**
 * Structured, request-scoped logging helper.
 */
function attachRequestLogger(logger: Logger): RequestHandler {
  return (req, _res, next) => {
    const requestId = req.headers['x-request-id'] ?? uuidV4();
    req.headers['x-request-id'] = requestId as string;

    const childLogger: Logger = {
      info: (msg, meta) => logger.info(msg, { ...meta, requestId }),
      error: (msg, meta) => logger.error(msg, { ...meta, requestId }),
      warn: (msg, meta) => logger.warn(msg, { ...meta, requestId }),
      debug: (msg, meta) => logger.debug(msg, { ...meta, requestId }),
    };

    (req as any).logger = childLogger;
    childLogger.info(`Incoming ${req.method} ${req.originalUrl}`);
    next();
  };
}

/* ======================================================================================
 * Bounded context: timeline endpoint
 * ====================================================================================*/

/**
 * Public factory that composes and returns an Express router
 * implementing `/timeline` endpoint with all middlewares.
 */
export function composeTimelineEndpoint({
  timelineService,
  redis,
  logger,
}: EndpointDependencies): express.Router {
  const router = express.Router();

  // ---------------------------------- validation schema
  const timelineQuerySchema = z.object({
    userId: z.string().uuid(),
    cursor: z.string().optional(),
    limit: z
      .string()
      .transform((v) => Number(v))
      .refine((n) => Number.isInteger(n) && n > 0 && n <= 100, {
        message: 'limit must be between 1 and 100',
      })
      .optional(),
  });

  // ---------------------------------- wrapped handler
  const handler: RequestHandler = async (req, res, next) => {
    const version = negotiateApiVersion(req);
    const params = (req as any).validated as TimelineParams;
    const log: Logger = (req as any).logger ?? logger;

    try {
      const data = await timelineService.fetchTimeline(params, version);
      log.debug('Timeline fetched', { count: data.length });
      res.json({ data, version });
    } catch (err) {
      log.error('Timeline fetch failed', { err });
      next(err);
    }
  };

  // ---------------------------------- middleware stack application order
  router.get(
    '/',
    attachRequestLogger(logger),
    rateLimiter(ms('1m'), 100), // 100 req / minute / IP / version
    withValidation(timelineQuerySchema),
    // cache only public timelines (when userId !== currentAuthUser)
    cacheResponse(redis, ms('30s'))(handler)
  );

  return router;
}

/* ======================================================================================
 * Utility helpers
 * ====================================================================================*/

function generateCacheKey(req: Request): string {
  const version = negotiateApiVersion(req);
  const { userId, cursor, limit } = req.query;
  return `timeline:${version}:${userId}:${cursor ?? ''}:${limit ?? ''}`;
}

/**
 * HTTP-friendly error with status code + metadata.
 */
export class HttpError extends Error {
  public status: number;
  public meta?: Record<string, unknown>;

  constructor(status: number, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.meta = meta;
  }
}

/* ======================================================================================
 * Global error handler (to be plugged at app level)
 * ====================================================================================*/

/**
 * Example global error handler (kept here for cohesion, export as needed).
 *
 * Usage:
 *   app.use(errorHandler(deps.logger));
 */
export function errorHandler(logger: Logger): RequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      logger.warn(err.message, { meta: err.meta });
      res.status(err.status).json({
        error: err.message,
        code: err.status,
        meta: err.meta,
      });
    } else {
      logger.error('Unhandled error', { err });
      res.status(500).json({ error: 'Internal Server Error', code: 500 });
    }
  };
}
```