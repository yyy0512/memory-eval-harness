```typescript
// -----------------------------------------------------------------------------
// File: src/module_81.ts
// Description: Redis-backed response-caching adapter for “public timeline”
//              queries with version-aware keys and automatic cache invalidation.
//              This is an *infrastructure* concern and must only depend on
//              abstractions from the application layer, never on controllers or
//              external frameworks.
// -----------------------------------------------------------------------------

import Redis, { RedisOptions } from 'ioredis';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

/**
 * DTO that represents a pre-computed timeline slice returned by the timeline
 * micro-service. Keep it loosely coupled to avoid leaking domain details.
 */
export interface TimelineSliceDTO {
  readonly userId: string;
  readonly items: ReadonlyArray<{
    id: string;
    authorId: string;
    type: 'POST' | 'REACTION' | 'STORY' | 'LIVE_CHAT';
    createdAt: string; // ISO8601
    payload: unknown;  // specific to the type
  }>;
  readonly fetchedAt: string; // ISO8601
  readonly version: number;   // algorithm version (e.g., ranking V2)
}

/**
 * Runtime validation for incoming payloads (defense in depth).
 */
const TimelineSliceSchema: z.ZodSchema<TimelineSliceDTO> = z.object({
  userId: z.string().uuid(),
  items: z
    .array(
      z.object({
        id: z.string(),
        authorId: z.string(),
        type: z.enum(['POST', 'REACTION', 'STORY', 'LIVE_CHAT']),
        createdAt: z.string(),
        payload: z.unknown(),
      }),
    )
    .readonly(),
  fetchedAt: z.string(),
  version: z.number().int(),
});

/**
 * Abstraction that the application layer relies on.
 */
export interface TimelineCachePort {
  /**
   * Tries to retrieve the cached timeline for the given user and algorithm
   * version. Returns `null` if the entry is missing or expired.
   */
  get(
    userId: string,
    version: number,
  ): Promise<TimelineSliceDTO | null>;

  /**
   * Persists an entire timeline slice under a versioned cache key.
   */
  set(
    dto: TimelineSliceDTO,
    options?: { ttlSeconds?: number },
  ): Promise<void>;

  /**
   * Invalidates all cached timelines for the specified user, regardless of
   * algorithm version.
   */
  invalidate(userId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                      REDIS IMPLEMENTATION OF THE PORT                      */
/* -------------------------------------------------------------------------- */

export interface RedisTimelineCacheOptions {
  /**
   * Prefix for all keys controlled by this adapter. Makes it trivial to
   * inspect and bulk-delete keys with redis-cli.
   *
   * Final key structure:
   *   {prefix}:timeline:{userId}:v{version}
   */
  keyPrefix: string;

  /** TTL (seconds) for newly created entries. Overrides per-call values.   */
  ttlSeconds: number;

  /** ioredis connection options.                                           */
  redisOptions: RedisOptions;
}

/**
 * Minimal structured logger so the adapter remains framework-agnostic. You
 * might want to replace this with pino / bunyan in production.
 */
class Logger {
  static info(msg: string, meta?: object): void {
    // eslint-disable-next-line no-console
    console.info(`[TimelineCache] INFO  ${msg}`, meta ?? '');
  }
  static warn(msg: string, meta?: object): void {
    // eslint-disable-next-line no-console
    console.warn(`[TimelineCache] WARN  ${msg}`, meta ?? '');
  }
  static error(msg: string, meta?: object): void {
    // eslint-disable-next-line no-console
    console.error(`[TimelineCache] ERROR ${msg}`, meta ?? '');
  }
}

/**
 * Production-ready cache layer with:
 *   • graceful handling of Redis outages
 *   • defensive runtime validation of cached payloads
 *   • namespaced keys + version routing
 *   • coarse invalidation pattern per user
 */
export class RedisTimelineCache implements TimelineCachePort {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly defaultTtl: number;

  constructor(private readonly opts: RedisTimelineCacheOptions) {
    this.keyPrefix = opts.keyPrefix.replace(/:$/, ''); // ensure no trailing ':'
    this.defaultTtl = opts.ttlSeconds;

    // Use auto-reconnect with back-off
    this.redis = new Redis({
      ...opts.redisOptions,
      retryStrategy: (attempts) => {
        const delay = Math.min(attempts * 100, 2_000); // cap at 2s
        Logger.warn('Redis connection lost. Reconnecting…', { attempts, delay });
        return delay;
      },
    });

    // basic observability
    this.redis.on('ready', () => Logger.info('Redis connection ready.'));
    this.redis.on('error', (err) => Logger.error('Redis error', { err }));
  }

  /* ---------------------------------------------------------------------- */
  /*                               PUBLIC API                               */
  /* ---------------------------------------------------------------------- */

  async get(
    userId: string,
    version: number,
  ): Promise<TimelineSliceDTO | null> {
    const key = this.composeKey(userId, version);

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as unknown;

      // Validate against schema; drop on failure
      const result = TimelineSliceSchema.safeParse(parsed);
      if (!result.success) {
        Logger.warn('Invalid cache entry detected. Purging…', {
          key,
          errors: result.error.errors,
        });
        await this.redis.del(key);
        return null;
      }

      return result.data;
    } catch (err) {
      // Never let cache layer bring the app down
      Logger.error('Failed to read from Redis', { err, key });
      return null;
    }
  }

  async set(
    dto: TimelineSliceDTO,
    options?: { ttlSeconds?: number },
  ): Promise<void> {
    const ttl = options?.ttlSeconds ?? this.defaultTtl;
    const key = this.composeKey(dto.userId, dto.version);

    try {
      await this.redis.set(key, JSON.stringify(dto), 'EX', ttl);
      Logger.info('Timeline cached', { key, ttl });
    } catch (err) {
      Logger.error('Failed to write to Redis', { err, key });
    }
  }

  async invalidate(userId: string): Promise<void> {
    const pattern = `${this.composeUserPrefix(userId)}*`;

    try {
      // Find matching keys (SCAN for large keyspaces)
      const keys = await this.scanKeys(pattern);
      if (keys.length === 0) return;

      await this.redis.del(...keys);
      Logger.info('Timeline cache invalidated', { userId, keys });
    } catch (err) {
      Logger.error('Failed to invalidate timeline cache', { err, userId });
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                          INTERNAL HELPER METHODS                       */
  /* ---------------------------------------------------------------------- */

  private composeKey(userId: string, version: number): string {
    return `${this.composeUserPrefix(userId)}v${version}`;
  }

  private composeUserPrefix(userId: string): string {
    return `${this.keyPrefix}:timeline:${userId}:`;
  }

  /**
   * Lightweight implementation of `SCAN` that is safe for production reads.
   * Collects *at most* 10K keys to avoid memory blow-ups in pathological cases.
   */
  private async scanKeys(
    pattern: string,
    maxKeys = 10_000,
  ): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];

    do {
      // 500 is a good trade-off between round-trips and latency
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', '500');
      cursor = nextCursor;
      keys.push(...batch);

      if (keys.length >= maxKeys) {
        Logger.warn('Key scan truncated to prevent memory issues.', {
          pattern,
          maxKeys,
        });
        break;
      }
    } while (cursor !== '0');

    return keys;
  }
}

/* -------------------------------------------------------------------------- */
/*                    CONVENIENCE FACTORY USING ENVIRONMENT                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates a ready-to-use cache adapter in a single call. The caller can still
 * provide custom `ttlSeconds` or `redisOptions` for tests.
 */
export function createTimelineCache(
  overrides?: Partial<Omit<RedisTimelineCacheOptions, 'keyPrefix'>>,
): TimelineCachePort {
  const {
    CACHE_TTL = '120', // 2 minutes
    CACHE_PREFIX = 'spg',
    REDIS_URL = 'redis://localhost:6379',
  } = process.env;

  return new RedisTimelineCache({
    keyPrefix: CACHE_PREFIX,
    ttlSeconds: Number(CACHE_TTL),
    redisOptions: {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      ...(overrides?.redisOptions ?? {}),
      // URL must be last to avoid overrides being clobbered
      ...(REDIS_URL ? { connectionName: 'timeline-cache', host: undefined, port: undefined, path: undefined, url: REDIS_URL } : {}),
    },
    ...overrides,
  });
}
```