```typescript
/**
 * SocialPulse Gateway – TrendingHashtagService
 *
 * This module orchestrates retrieval, caching, and resilience concerns for the
 * “trending hashtags” feature exposed through both REST and GraphQL surfaces.
 *
 * Key capabilities:
 *  • Talks to the upstream “trend-analyzer” micro-service over HTTP
 *  • Caches responses in Redis (read-through) with a configurable TTL
 *  • Implements single-flight to eliminate cache-miss stampedes
 *  • Emits structured logs (pino) & tracing spans (OpenTelemetry)
 *  • Provides TypeScript-strict DTOs + runtime schema validation (zod)
 */

import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';
import pino, { Logger } from 'pino';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Configuration contracts
// ---------------------------------------------------------------------------

export interface TrendingServiceOptions {
  /**
   * Fully-qualified base URL of the trend-analyzer service
   *   Example: https://trend-analyzer.socialpulse.svc.cluster.local
   */
  baseUrl: string;

  /**
   * Redis client instance for cache access
   */
  redis: Redis.Redis;

  /**
   * TTL (seconds) for cached trending hashtag payloads.
   * Defaults to 60 seconds (empirically tuned for freshness vs. cost).
   */
  cacheTTLSeconds?: number;

  /**
   * Pino logger (child logger will be created if none supplied)
   */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// DTOs & runtime validation schemas
// ---------------------------------------------------------------------------

export interface TrendingHashtag {
  tag: string;
  score: number; // relevance score computed by the trend analyzer
}

export interface TrendingHashtagResponse {
  generatedAt: string; // ISO-8601 timestamp
  hashtags: TrendingHashtag[];
}

/**
 * Zod runtime schema mirrors the DTO for defensive parsing
 */
const HashtagSchema = z.object({
  tag: z.string().min(1),
  score: z.number().nonnegative(),
});

const TrendingResponseSchema = z.object({
  generatedAt: z.string().nonempty(),
  hashtags: z.array(HashtagSchema).max(100),
});

// ---------------------------------------------------------------------------
// Single-flight in-process de-dupe to avoid cache-miss stampede
// ---------------------------------------------------------------------------

const pendingRequests: Map<string, Promise<TrendingHashtagResponse>> = new Map();

/**
 * Build stable cache key
 */
const cacheKey = (version = 'v1'): string => `trending_hashtags:${version}`;

// ---------------------------------------------------------------------------
// Module Implementation
// ---------------------------------------------------------------------------

export class TrendingHashtagService {
  private readonly axios: AxiosInstance;
  private readonly redis: Redis.Redis;
  private readonly logger: Logger;
  private readonly cacheTTL: number;

  constructor(private readonly opts: TrendingServiceOptions) {
    this.redis = opts.redis;
    this.logger = opts.logger ?? pino().child({ module: 'TrendingHashtagService' });
    this.cacheTTL = opts.cacheTTLSeconds ?? 60;

    this.axios = axios.create({
      baseURL: opts.baseUrl,
      timeout: 2_500, // 2.5 s upstream timeout
    });
  }

  /**
   * Public entry point used by controllers/resolvers.
   *
   * @param version – semantic version of trending algorithm requested by client.
   *                  The gateway uses this to gradually roll out new ranking.
   */
  public async getTrendingHashtags(version: string = 'v1'): Promise<TrendingHashtagResponse> {
    const span = trace.getTracer('socialpulse-gateway').startSpan('TrendingHashtagService.get');
    span.setAttribute('version', version);

    try {
      const key = cacheKey(version);

      // 1) Attempt fast-path cache hit
      const cached = await this.readFromCache(key);
      if (cached) {
        span.addEvent('cache_hit');
        return cached;
      }
      span.addEvent('cache_miss');

      // 2) Single-flight deduplication
      if (pendingRequests.has(key)) {
        this.logger.debug({ key }, 'Awaiting existing in-flight request');
        return pendingRequests.get(key)!;
      }

      const promise = this.fetchAndCache(key, version)
        .finally(() => pendingRequests.delete(key));

      pendingRequests.set(key, promise);
      return promise;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      this.logger.error({ err }, 'Failed to fetch trending hashtags');
      throw err;
    } finally {
      span.end();
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Read & parse cached value (if present)
   */
  private async readFromCache(key: string): Promise<TrendingHashtagResponse | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const validation = TrendingResponseSchema.safeParse(parsed);
      if (!validation.success) {
        this.logger.warn({ key, errors: validation.error.errors }, 'Cache entry failed validation; purging');
        void this.redis.del(key); // Fire-and-forget purge
        return null;
      }
      return validation.data;
    } catch (err) {
      this.logger.error({ err }, 'Error reading from Redis');
      // Fail-open: continue without cached data
      return null;
    }
  }

  /**
   * Fetch data from upstream service and populate cache
   */
  private async fetchAndCache(key: string, version: string): Promise<TrendingHashtagResponse> {
    const response = await this.callUpstream(version);
    await this.writeToCache(key, response);
    return response;
  }

  /**
   * Writes data into Redis with TTL
   */
  private async writeToCache(key: string, data: TrendingHashtagResponse): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(data), 'EX', this.cacheTTL);
      this.logger.debug({ key, ttl: this.cacheTTL }, 'Cached trending hashtags');
    } catch (err) {
      // Non-fatal: logging suffices
      this.logger.warn({ err }, 'Failed to write trending hashtags to cache');
    }
  }

  /**
   * Resilient upstream HTTP call with simple retry (exponential backoff)
   */
  private async callUpstream(version: string): Promise<TrendingHashtagResponse> {
    const maxAttempts = 3;
    let attempt = 0;
    let backoffMs = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const { data } = await this.axios.get<TrendingHashtagResponse>(`/trending/${version}`);
        const validation = TrendingResponseSchema.parse(data);
        return validation;
      } catch (err) {
        attempt += 1;
        const isRetryable = this.isRetryableError(err);
        this.logger.warn({ err, attempt, maxAttempts }, 'Upstream request failed');

        if (attempt >= maxAttempts || !isRetryable) {
          throw err; // surface the error to caller
        }

        await this.delay(backoffMs);
        backoffMs *= 2; // exponential
      }
    }
  }

  /**
   * Simple heuristic for retry eligibility
   */
  private isRetryableError(err: unknown): boolean {
    if (!axios.isAxiosError(err)) return false;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return true;
    if (!err.response) return true; // network failures
    return err.response.status >= 500; // 5xx = server side
  }

  /**
   * Sleep helper (Promise-based)
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```