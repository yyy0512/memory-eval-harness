```typescript
/**
 * SocialPulse Gateway – Trending Hashtag Service
 *
 * This module provides a high-level service for retrieving trending hashtags
 * with built-in input validation, algorithm versioning, response caching,
 * and structured logging.  It is intended to be consumed by controllers or
 * GraphQL resolvers in the presentation layer and hides all infrastructure
 * concerns behind a clean application-layer façade.
 *
 * Responsibilities
 * 1. Validate inbound request DTOs (using zod)
 * 2. Derive a deterministic cache key that captures algorithmVersion + locale + limit
 * 3. Attempt Redis cache lookup; short-circuit when cache hit
 * 4. Delegate cache-misses to the social-analytics micro-service via HTTP
 * 5. Persist successful responses in Redis with TTL
 * 6. Emit structured logs and basic metrics for observability
 */

import { createClient, RedisClientType } from 'redis';
import fetch, { Response } from 'node-fetch';
import * as z from 'zod';
import winston, { Logger } from 'winston';

/* -------------------------------------------------------------------------- */
/*                              DTOs & VALIDATION                             */
/* -------------------------------------------------------------------------- */

/**
 * Input DTO for `getTrendingHashtags`
 */
export const GetTrendingHashtagsSchema = z.object({
  /**
   * ISO-3166-1 alpha-2 locale used for regional trending computation.
   * e.g. "US", "DE", "JP"
   */
  locale: z.string().length(2).toUpperCase(),

  /**
   * Maximum number of hashtags the caller is interested in.
   * Enforced upper bound prevents overly heavy queries.
   */
  limit: z.number().int().positive().max(100).default(25),

  /**
   * Version of ranking algorithm.
   * Allows incremental rollout (v1, v2, v3-beta, …) without breaking callers.
   */
  algorithmVersion: z
    .string()
    .regex(/^v[0-9]+(-[0-9a-zA-Z]+)?$/)
    .default('v1'),
});

export type GetTrendingHashtagsDTO = z.infer<typeof GetTrendingHashtagsSchema>;

export interface TrendingHashtag {
  tag: string;
  count: number;
}

export interface TrendingHashtagsResponse {
  algorithmVersion: string;
  hashtags: TrendingHashtag[];
  generatedAt: string; // ISO-8601
}

/* -------------------------------------------------------------------------- */
/*                               ERROR CLASSES                                */
/* -------------------------------------------------------------------------- */

export class ValidationError extends Error {
  constructor(readonly details: z.ZodError) {
    super('Invalid input for getTrendingHashtags');
    this.name = 'ValidationError';
  }
}

export class UpstreamServiceError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Trending-service responded with ${status}`);
    this.name = 'UpstreamServiceError';
  }
}

/* -------------------------------------------------------------------------- */
/*                            TRENDING SERVICE CLASS                          */
/* -------------------------------------------------------------------------- */

export class TrendingHashtagService {
  private readonly redisClient: RedisClientType;
  private readonly logger: Logger;
  private readonly ttlSeconds: number;
  private readonly upstreamBaseUrl: string;

  private constructor(opts: {
    redisClient: RedisClientType;
    logger: Logger;
    ttlSeconds: number;
    upstreamBaseUrl: string;
  }) {
    this.redisClient = opts.redisClient;
    this.logger = opts.logger;
    this.ttlSeconds = opts.ttlSeconds;
    this.upstreamBaseUrl = opts.upstreamBaseUrl;
  }

  /* ------------------------------ PUBLIC API ----------------------------- */

  /**
   * Retrieve trending hashtags, optionally hitting cache.
   */
  public async getTrendingHashtags(
    rawDto: unknown,
  ): Promise<TrendingHashtagsResponse> {
    // Step 1: Validate DTO
    const dto = this.validateInput(rawDto);

    // Step 2: Compose cache key
    const cacheKey = this.buildCacheKey(dto);

    // Step 3: Attempt Redis read
    const cached = await this.fetchFromCache(cacheKey);
    if (cached) {
      this.logger.debug('cacheHit', { cacheKey });
      return cached;
    }
    this.logger.debug('cacheMiss', { cacheKey });

    // Step 4: Query upstream micro-service
    const fresh = await this.fetchFromUpstream(dto);

    // Step 5: Persist to cache (fire & forget)
    this.persistInCache(cacheKey, fresh).catch((err) =>
      this.logger.warn('cacheSetFailed', { cacheKey, err: err.message }),
    );

    return fresh;
  }

  /* ---------------------------- STATIC FACTORY --------------------------- */

  /**
   * DI-friendly factory that wires dependencies from environment variables.
   */
  public static async createFromEnv(): Promise<TrendingHashtagService> {
    // Redis bootstrap
    const redisClient = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    });
    await redisClient.connect();

    // Winston logger bootstrap
    const logger = winston.createLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      transports: [new winston.transports.Console({ format: winston.format.json() })],
      defaultMeta: { svc: 'TrendingHashtagService' },
    });

    const ttlSeconds =
      parseInt(process.env.TRENDING_CACHE_TTL_SEC || '', 10) || 60 * 2; // 2 min default
    const upstreamBaseUrl =
      process.env.TRENDING_SERVICE_URL || 'http://social-analytics:7070';

    return new TrendingHashtagService({
      redisClient,
      logger,
      ttlSeconds,
      upstreamBaseUrl,
    });
  }

  /* ----------------------------- VALIDATION ------------------------------ */

  private validateInput(rawDto: unknown): GetTrendingHashtagsDTO {
    const parsed = GetTrendingHashtagsSchema.safeParse(rawDto);
    if (!parsed.success) {
      this.logger.warn('validationFailed', {
        issues: parsed.error.issues,
      });
      throw new ValidationError(parsed.error);
    }
    return parsed.data;
  }

  /* ------------------------ CACHE & KEY GENERATION ----------------------- */

  private buildCacheKey(dto: GetTrendingHashtagsDTO): string {
    // Example: trending:v2:DE:25
    return [
      'trending',
      dto.algorithmVersion,
      dto.locale.toUpperCase(),
      dto.limit,
    ].join(':');
  }

  private async fetchFromCache(
    cacheKey: string,
  ): Promise<TrendingHashtagsResponse | null> {
    try {
      const payload = await this.redisClient.get(cacheKey);
      return payload ? (JSON.parse(payload) as TrendingHashtagsResponse) : null;
    } catch (err) {
      this.logger.error('cacheReadFailed', { cacheKey, err: (err as Error).message });
      return null; // fail open – proceed without cache
    }
  }

  private async persistInCache(
    cacheKey: string,
    resp: TrendingHashtagsResponse,
  ): Promise<void> {
    await this.redisClient.set(cacheKey, JSON.stringify(resp), {
      EX: this.ttlSeconds,
    });
  }

  /* ---------------------------- UPSTREAM CALL ---------------------------- */

  private async fetchFromUpstream(
    dto: GetTrendingHashtagsDTO,
  ): Promise<TrendingHashtagsResponse> {
    const url = new URL('/trending/hashtags', this.upstreamBaseUrl);
    url.searchParams.set('locale', dto.locale);
    url.searchParams.set('limit', dto.limit.toString());
    url.searchParams.set('version', dto.algorithmVersion);

    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(url.toString(), { timeout: 5_000 });
    } catch (err) {
      this.logger.error('upstreamTimeout', { url: url.toString() });
      throw new UpstreamServiceError(504, 'Gateway Timeout');
    }
    const durationMs = Date.now() - start;

    this.logger.info('upstreamRequest', {
      url: url.pathname,
      status: res.status,
      durationMs,
    });

    if (!res.ok) {
      const bodyText = await res.text();
      throw new UpstreamServiceError(res.status, bodyText);
    }

    const data = (await res.json()) as TrendingHashtagsResponse;

    // Defensive: ensure upstream honors algorithmVersion in response
    if (data.algorithmVersion !== dto.algorithmVersion) {
      this.logger.warn('algorithmVersionMismatch', {
        requested: dto.algorithmVersion,
        received: data.algorithmVersion,
      });
    }

    return data;
  }
}

/* -------------------------------------------------------------------------- */
/*                          SINGLETON (EAGER INSTANTIATE)                     */
/* -------------------------------------------------------------------------- */

/**
 * Exported singleton used by controllers/resolvers.  Deferred init allows unit
 * tests to substitute a mock implementation via jest.mock or DI container.
 */
export const TrendingServiceSingleton: Promise<TrendingHashtagService> =
  TrendingHashtagService.createFromEnv();
```