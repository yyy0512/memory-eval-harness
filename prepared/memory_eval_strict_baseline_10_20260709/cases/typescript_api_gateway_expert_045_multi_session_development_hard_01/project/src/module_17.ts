```typescript
/***************************************************************************************************
 * File:         src/module_17.ts
 * Project:      SocialPulse Gateway (api_gateway)
 * Description:  Adaptive, behavior-aware rate-limiter backed by Redis. Designed for social-centric
 *               workloads (follow-spam, message floods, etc.) and intended to sit inside an
 *               Express / NestJS middleware or GraphQL plugin. Implements a sliding-window counter
 *               plus a lightweight “behavior score” that classifies user actions and blocks abusive
 *               patterns before they saturate downstream micro-services.
 *
 * Author:       SocialPulse Core Team
 * License:      MIT
 ***************************************************************************************************/

import { EventEmitter } from 'node:events';
import Redis, { RedisOptions } from 'ioredis';

/**
 * All interaction types the gateway cares about for rate-limiting / scoring.
 * Extend as new surface areas are introduced (e.g., StoryReaction).
 */
export enum BehaviorEvent {
  FOLLOW   = 'FOLLOW',
  UNFOLLOW = 'UNFOLLOW',
  LIKE     = 'LIKE',
  COMMENT  = 'COMMENT',
  POST     = 'POST',
  MESSAGE  = 'MESSAGE'
}

/**
 * Configuration for how each event type translates into “score”. Positive numbers add to score
 * (bad), negative numbers subtract (good). Keep values small to avoid overflow.
 */
export interface BehaviorScorePolicy {
  [BehaviorEvent.FOLLOW]   ?: number;
  [BehaviorEvent.UNFOLLOW] ?: number;
  [BehaviorEvent.LIKE]     ?: number;
  [BehaviorEvent.COMMENT]  ?: number;
  [BehaviorEvent.POST]     ?: number;
  [BehaviorEvent.MESSAGE]  ?: number;
}

/**
 * Top-level config object consumed by AdaptiveRateLimiter.
 */
export interface AdaptiveRateLimiterOptions {
  /**
   * Sliding-window size in seconds. All events inside the window count toward score.
   */
  windowSizeSeconds: number;

  /**
   * Maximum allowed aggregated score before user is blocked.
   */
  threshold: number;

  /**
   * Score decay rate (percentage per minute). Value between 0-100. 20 => score reduced by 20 %
   * every minute.
   */
  decayPercentagePerMinute: number;

  /**
   * Event-to-score mapping (see BehaviorScorePolicy).
   */
  policy: BehaviorScorePolicy;

  /**
   * Namespace prefix to avoid Redis key collisions when multiple gateways share an instance.
   * Example: “sp:gateway:v1”.
   */
  redisKeyNamespace: string;
}

/**
 * Domain-specific error thrown when a user exceeds the configured threshold.
 */
export class RateLimitError extends Error {
  public readonly userId: string;
  public readonly currentScore: number;
  public readonly threshold: number;

  constructor(
    userId: string,
    currentScore: number,
    threshold: number,
    message = 'Rate limit exceeded'
  ) {
    super(message);
    this.userId     = userId;
    this.currentScore = currentScore;
    this.threshold  = threshold;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * AdaptiveRateLimiter is a self-contained service that can be instantiated from any HTTP context.
 * Example (Express):
 *
 *   const limiter = new AdaptiveRateLimiter(redis, opts)
 *   app.post('/follow', async (req, res, next) => {
 *     try {
 *       await limiter.registerEvent(req.user.id, BehaviorEvent.FOLLOW)
 *       next()
 *     } catch (e) {
 *       if (e instanceof RateLimitError) return res.status(429).json({ message: e.message })
 *       next(e)
 *     }
 *   })
 */
export class AdaptiveRateLimiter extends EventEmitter {
  private readonly redis: Redis;
  private readonly opts: Readonly<AdaptiveRateLimiterOptions>;

  /**
   * Lua script (EVALSHA) for atomic score aggregation:
   *
   * KEYS[1] => userKey
   * ARGV[1] => scoreToAdd (integer)
   * ARGV[2] => windowSize (seconds)
   *
   * Returns:
   *   newTotalScore (integer)
   */
  private static readonly LUA_SLIDING_WINDOW = `
    local userKey     = KEYS[1]
    local scoreDelta  = tonumber(ARGV[1])
    local windowSize  = tonumber(ARGV[2])

    -- prune old events
    redis.call('ZREMRANGEBYSCORE', userKey, '-inf', (redis.call('TIME')[1] - windowSize))

    -- add new event
    local now         = redis.call('TIME')[1]
    redis.call('ZADD', userKey, now, now .. ':' .. scoreDelta)

    -- compute total score
    local events      = redis.call('ZRANGE', userKey, 0, -1)
    local sum = 0
    for i, entry in ipairs(events) do
      local delim = string.find(entry, ':')
      if delim then
        local delta = tonumber(string.sub(entry, delim + 1))
        sum = sum + delta
      end
    end
    -- store aggregated value for quick access (sorted-set len is still used for pruning)
    redis.call('HSET', userKey .. ':meta', 'score', sum)
    redis.call('EXPIRE', userKey .. ':meta', windowSize)
    redis.call('EXPIRE', userKey,          windowSize)
    return sum
  `;

  private scriptSha?: string;

  constructor(
    redisConnection: Redis | RedisOptions,
    options: AdaptiveRateLimiterOptions
  ) {
    super();

    this.redis =
      redisConnection instanceof Redis
        ? redisConnection
        : new Redis(redisConnection);

    this.opts  = Object.freeze({ ...options });
    this.bootstrapLuaScript().catch((err) => {
      // Emit but don’t crash—caller may decide to retry or fallback
      this.emit('error', err);
    });

    // Kick off decay timer
    if (this.opts.decayPercentagePerMinute > 0) {
      const minute = 60_000;
      setInterval(
        () => this.runDecayCycle().catch((err) => this.emit('error', err)),
        minute
      ).unref();
    }
  }

  /**
   * Registers a user event and enforces limit. If limit exceeded a RateLimitError is thrown.
   */
  public async registerEvent(
    userId: string,
    event: BehaviorEvent
  ): Promise<void> {
    const scoreToAdd =
      this.opts.policy[event] ?? 1 /* fallback to 1 pt if not configured */;

    const totalScore = await this.incrementScoreAtomic(userId, scoreToAdd);

    if (totalScore > this.opts.threshold) {
      this.emit('blocked', { userId, totalScore });
      throw new RateLimitError(userId, totalScore, this.opts.threshold);
    } else {
      this.emit('accepted', { userId, totalScore });
    }
  }

  /**
   * Reads current aggregate score for a user. O(1) because we store aggregated value in Hash.
   */
  public async getCurrentScore(userId: string): Promise<number> {
    const key   = this.userMetaKey(userId);
    const score = await this.redis.hget(key, 'score');
    return score ? Number(score) : 0;
  }

  /******************************** Private helpers **********************************************/

  /**
   * Atomically increments the user’s score via Lua script to prevent race conditions.
   */
  private async incrementScoreAtomic(
    userId: string,
    delta: number
  ): Promise<number> {
    await this.ensureScriptLoaded();
    const key = this.userEventsKey(userId);

    const result = await this.redis.evalsha(
      this.scriptSha!,
      1,
      key,
      delta,
      this.opts.windowSizeSeconds
    );

    return Number(result);
  }

  private async bootstrapLuaScript(): Promise<void> {
    // Load script & get SHA so that subsequent calls use EVALSHA (fast path)
    this.scriptSha = await this.redis.script(
      'LOAD',
      AdaptiveRateLimiter.LUA_SLIDING_WINDOW
    );
  }

  private async ensureScriptLoaded(): Promise<void> {
    if (!this.scriptSha) await this.bootstrapLuaScript();
  }

  private userEventsKey(userId: string): string {
    return `${this.opts.redisKeyNamespace}:u:${userId}:events`;
  }

  private userMetaKey(userId: string): string {
    return `${this.opts.redisKeyNamespace}:u:${userId}:events:meta`;
  }

  /**
   * Decay cycle runs every minute, reducing each user’s score by configured percentage. Uses Redis
   * SCAN to avoid blocking the server. Heavy-handed but acceptable for low cardinality (< 10 M).
   */
  private async runDecayCycle(): Promise<void> {
    const decay = 1 - this.opts.decayPercentagePerMinute / 100;
    if (decay >= 1 || decay <= 0) return;

    const pattern = `${this.opts.redisKeyNamespace}:u:*:events:meta`;
    let   cursor  = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = nextCursor;

      if (keys.length === 0) continue;

      const pipeline = this.redis.pipeline();
      for (const k of keys) {
        pipeline.hget(k, 'score');
      }
      const scores = await pipeline.exec();

      const updatePipeline = this.redis.pipeline();
      keys.forEach((key, idx) => {
        const res = scores[idx];
        if (res[0]) return; // Error, skip
        const current = Number(res[1]);
        if (current === 0) return;
        const newVal = Math.max(0, Math.floor(current * decay));
        updatePipeline.hset(key, 'score', newVal);
      });
      await updatePipeline.exec();
    } while (cursor !== '0');
  }
}

/***************************************************************************************************
 * Example default configuration—exported for convenience.
 ***************************************************************************************************/
export const DEFAULT_POLICY: BehaviorScorePolicy = {
  [BehaviorEvent.FOLLOW]:  5,
  [BehaviorEvent.UNFOLLOW]: 1,
  [BehaviorEvent.LIKE]:    1,
  [BehaviorEvent.COMMENT]: 2,
  [BehaviorEvent.POST]:    3,
  [BehaviorEvent.MESSAGE]: 4
};

export const DEFAULT_RATE_LIMITER_OPTS: AdaptiveRateLimiterOptions = {
  windowSizeSeconds:         60 * 10, // 10-minute sliding window
  threshold:                 150,     // block once 150 pts reached
  decayPercentagePerMinute:  10,      // score reduced by 10 % every minute
  policy:                    DEFAULT_POLICY,
  redisKeyNamespace:         'sp:gateway:v1'
};

/***************************************************************************************************
 * If this file is run directly (e.g., ts-node src/module_17.ts) we spin up a quick demo.
 *  $ REDIS_URL=redis://localhost ts-node src/module_17.ts
 ***************************************************************************************************/
if (require.main === module) {
  (async () => {
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    const redis    = new Redis(redisUrl);

    const rateLimiter = new AdaptiveRateLimiter(redis, DEFAULT_RATE_LIMITER_OPTS);

    const userId = 'demo-user';
    rateLimiter.on('blocked', ({ totalScore }) =>
      console.warn(`[demo] user blocked with score=${totalScore}`)
    );

    // Simulate a burst of follows
    for (let i = 0; i < 40; i++) {
      try {
        await rateLimiter.registerEvent(userId, BehaviorEvent.FOLLOW);
        console.log(`[demo] event accepted #${i + 1}`);
      } catch (err) {
        if (err instanceof RateLimitError) {
          console.error(`[demo] BLOCKED at iteration #${i + 1}:`, err.message);
          break;
        }
        throw err;
      }
    }

    process.exit(0);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```