```typescript
/**
 * src/module_19.ts
 * ------------------------------------------------
 * Production-grade module implementing version-aware
 * “Trending Hashtags” retrieval with Redis caching,
 * request validation, and resilient error handling.
 *
 * Layer mapping (Clean Architecture):
 * – Domain:       HashtagAggregate, VersionTag
 * – Application:  GetTrendingHashtagsUseCase
 * – Infrastructure:  HashtagServiceClient, RedisCacheAdapter
 *
 * External deps:
 * – axios          (HTTP client)
 * – ioredis        (Redis client)
 * – pino           (structured logger)
 * – zod            (runtime validation / parsing)
 * ------------------------------------------------
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import Redis, { RedisOptions } from 'ioredis';
import pino, { Logger } from 'pino';
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/*                          Domain Layer                              */
/* ------------------------------------------------------------------ */

/**
 * Supported algorithm versions for trending calculation.
 * Version tag doubles as part of the route path for the micro-service.
 */
export enum VersionTag {
  V1 = 'v1',
  V2 = 'v2',
  EXP = 'experimental',
}

/**
 * Domain representation of a trending hashtag.
 */
export interface HashtagAggregate {
  tag: string;
  score: number;
  rank: number;
}

/**
 * Higher-order domain error for problems occurring during trending lookup.
 */
export class TrendingDomainError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TrendingDomainError';
  }
}

/* ------------------------------------------------------------------ */
/*                   Infrastructure Layer – Redis                     */
/* ------------------------------------------------------------------ */

/**
 * Redis cache adapter with a minimal surface tailored for this use case.
 */
class RedisCacheAdapter {
  private client: Redis | null = null;
  private readonly logger: Logger;

  constructor(logger: Logger, options?: RedisOptions) {
    this.logger = logger.child({ module: 'RedisCacheAdapter' });

    try {
      /* eslint-disable no-new */
      this.client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        lazyConnect: true,
        ...(options ?? {}),
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to instantiate Redis client.');
      this.client = null;
    }
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const json = await this.client.get(key);
      return json ? (JSON.parse(json) as T) : null;
    } catch (err) {
      this.logger.warn({ err, key }, 'Redis GET failed');
      return null;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn({ err, key }, 'Redis SET failed');
    }
  }
}

/* ------------------------------------------------------------------ */
/*            Infrastructure Layer – Trending micro-service           */
/* ------------------------------------------------------------------ */

/**
 * Service client responsible for delegating calls to the Ranking micro-service.
 */
class HashtagServiceClient {
  private readonly http: AxiosInstance;
  private readonly logger: Logger;

  constructor(baseURL: string, logger: Logger) {
    this.logger = logger.child({ module: 'HashtagServiceClient' });
    this.http = axios.create({
      baseURL,
      timeout: 3_000, // ms
    });
  }

  async fetchTrending(
    version: VersionTag,
    limit: number,
  ): Promise<HashtagAggregate[]> {
    const path = `/${version}/trending/hashtags`;
    try {
      const res: AxiosResponse<HashtagAggregate[]> =
        await this.http.get(path, { params: { limit } });

      return res.data;
    } catch (err) {
      this.logger.error({ err, version, limit }, 'HTTP call failed');
      throw new TrendingDomainError('Unable to fetch trending hashtags', err);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                   Application Layer – Use Case                     */
/* ------------------------------------------------------------------ */

const GetTrendingInputSchema = z.object({
  version: z.nativeEnum(VersionTag).default(VersionTag.V1),
  limit: z.number().int().positive().max(100).default(25),
});

export type GetTrendingInput = z.infer<typeof GetTrendingInputSchema>;

export class GetTrendingHashtagsUseCase {
  private readonly cacheTTLSeconds = 30; // short-lived due to high churn

  constructor(
    private readonly service: HashtagServiceClient,
    private readonly cache: RedisCacheAdapter,
    private readonly logger: Logger = pino().child({
      useCase: 'GetTrendingHashtagsUseCase',
    }),
  ) {}

  async execute(rawInput: Partial<GetTrendingInput>): Promise<HashtagAggregate[]> {
    // Validate + coerce
    const input = GetTrendingInputSchema.parse(rawInput);
    const cacheKey = this.composeCacheKey(input);

    // Attempt cache lookup
    const cached = await this.cache.get<HashtagAggregate[]>(cacheKey);
    if (cached) {
      this.logger.debug({ cacheKey }, 'Cache hit');
      return cached;
    }

    // Fallback to micro-service
    this.logger.debug({ input }, 'Cache miss; fetching from service');
    const freshData = await this.service.fetchTrending(input.version, input.limit);

    // Store in cache, ignoring errors
    await this.cache.set(cacheKey, freshData, this.cacheTTLSeconds);

    return freshData;
  }

  private composeCacheKey({ version, limit }: GetTrendingInput): string {
    return `hashtags:trending:${version}:limit-${limit}`;
  }
}

/* ------------------------------------------------------------------ */
/*                  Bootstrapping (factory helper)                    */
/* ------------------------------------------------------------------ */

/**
 * Factory to create a fully-wired use-case instance.
 * Isolated here so that callers can import a single function
 * without worrying about wiring dependencies manually.
 */
export function buildGetTrendingHashtagsUseCase(): GetTrendingHashtagsUseCase {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  const rankingServiceBase =
    process.env.RANKING_SVC_BASE_URL || 'http://ranking:8080';

  const serviceClient = new HashtagServiceClient(rankingServiceBase, logger);
  const cache = new RedisCacheAdapter(logger);

  return new GetTrendingHashtagsUseCase(serviceClient, cache, logger);
}

/* ------------------------------------------------------------------ */
/*                       Example (Unsafe) Usage                       */
/* ------------------------------------------------------------------ */
/*
(async () => {
  const useCase = buildGetTrendingHashtagsUseCase();
  const trending = await useCase.execute({ version: VersionTag.V2, limit: 10 });
  console.log(trending);
})();
*/
```