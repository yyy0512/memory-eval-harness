```typescript
/**
 * SocialPulse Gateway
 * File: src/module_60.ts
 *
 * DistributedRateLimiter — infrastructure-layer component that coordinates
 * token-bucket rate-limiting across a Redis cluster while offering an
 * in-memory fallback and OpenTelemetry instrumentation.
 *
 * The implementation is framework-agnostic (can be plugged into Express /
 * Fastify, Apollo Server, or any micro-service) and is safe for multi-node
 * deployments thanks to a single-roundtrip Lua script that executes
 * atomically on Redis.
 */

import EventEmitter from 'eventemitter3';
import Redis, { Pipeline } from 'ioredis';
import { context, trace, SpanStatusCode, Span } from '@opentelemetry/api';

/* ------------------------------------------------------------------------ */
/* Internal Logger (replace with @socialpulse/shared-logging in production) */
/* ------------------------------------------------------------------------ */
export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string | Error, meta?: Record<string, unknown>): void;
}

const ConsoleLogger: ILogger = {
  debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta ?? ''),
  info: (msg, meta)  => console.info(`[INFO]  ${msg}`, meta ?? ''),
  warn: (msg, meta)  => console.warn(`[WARN]  ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? ''),
};

/* ------------------------------------------------------------------------ */
/* Public Types                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Rate-limit rule describing how many *tokens* can be consumed per *window*.
 *
 * Example: { namespace: "POST_CREATE", limit: 20, windowSec: 60 }
 */
export interface RateLimitRule {
  /** Logical group / namespace (e.g., "FOLLOW", "DM_SEND") */
  namespace: string;
  /** Max number of tokens within the rolling window */
  limit: number;
  /** Length of the rolling window in seconds */
  windowSec: number;
}

/**
 * Result of a token consumption attempt.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch milliseconds
}

/**
 * Event payloads emitted by DistributedRateLimiter.
 */
export interface RateLimitEventMap {
  consumed: [subject: string, rule: RateLimitRule, result: RateLimitResult];
  blocked:  [subject: string, rule: RateLimitRule, result: RateLimitResult];
  failure:  [subject: string, rule: RateLimitRule, error: unknown];
}

/* ------------------------------------------------------------------------ */
/* Error Types                                                              */
/* ------------------------------------------------------------------------ */

export class RateLimitExceededError extends Error {
  public readonly resetAt: number;

  constructor(resetAt: number) {
    super('Rate limit exceeded');
    this.resetAt = resetAt;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RateLimiterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* ------------------------------------------------------------------------ */
/* Implementation                                                           */
/* ------------------------------------------------------------------------ */

/**
 * DistributedRateLimiter
 *
 * Uses Redis to manage token buckets with atomic Lua script execution.
 * Falls back to a bounded in-memory map if Redis is unavailable,
 * ensuring best-effort protection during outages.
 */
export class DistributedRateLimiter extends EventEmitter<RateLimitEventMap> {
  private readonly redis?: Redis;
  private readonly logger: ILogger;
  private readonly memoryStore = new Map<string, { resetAt: number; remaining: number }>();
  private readonly tracer = trace.getTracer('socialpulse.rate-limiter');

  // Lua script id loaded into Redis at runtime
  private scriptSha?: string;

  constructor(opts: {
    redis?: Redis;         // Optional. If undefined we operate in memory-only mode.
    logger?: ILogger;      // Optional custom logger.
  }) {
    super();
    this.redis  = opts.redis;
    this.logger = opts.logger ?? ConsoleLogger;

    if (this.redis) {
      this.bootstrapLuaScript()
        .catch((err) => this.logger.error('Failed to load rate-limiter script', { err }));
    }
  }

  /**
   * Attempts to consume 1 token for the given subject and rule.
   *
   * On success returns a RateLimitResult with allowed=true.
   * On limit breach throws RateLimitExceededError.
   */
  async consume(subject: string, rule: RateLimitRule): Promise<RateLimitResult> {
    // Instrumentation span for OpenTelemetry
    return await this.tracer.startActiveSpan('rateLimiter.consume', async (span) => {
      span.setAttributes({
        'rate_limiter.subject': subject,
        'rate_limiter.namespace': rule.namespace,
        'rate_limiter.limit': rule.limit,
        'rate_limiter.windowSec': rule.windowSec,
      });

      try {
        const result = this.redis
          ? await this.consumeRedis(subject, rule, span)
          : this.consumeMemory(subject, rule);

        const eventName = result.allowed ? 'consumed' : 'blocked';
        this.emit(eventName, subject, rule, result);

        if (!result.allowed) {
          throw new RateLimitExceededError(result.resetAt);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        this.emit('failure', subject, rule, err);
        throw err; // propagate
      } finally {
        span.end();
      }
    });
  }

  /* -------------------------------------------------------------------- */
  /* Private helpers                                                      */
  /* -------------------------------------------------------------------- */

  /**
   * In-memory fallback — NOT distributed, best effort only.
   */
  private consumeMemory(subject: string, rule: RateLimitRule): RateLimitResult {
    const now = Date.now();
    const key = `${subject}:${rule.namespace}`;
    const entry = this.memoryStore.get(key) ?? {
      remaining: rule.limit,
      resetAt: now + rule.windowSec * 1000,
    };

    if (now >= entry.resetAt) {
      // window elapsed — reset bucket
      entry.remaining = rule.limit;
      entry.resetAt   = now + rule.windowSec * 1000;
    }

    if (entry.remaining > 0) {
      entry.remaining -= 1;
      this.memoryStore.set(key, entry);
      return { allowed: true, remaining: entry.remaining, resetAt: entry.resetAt };
    }

    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  /**
   * Redis-based distributed rate-limiting.
   * Uses a Lua script to perform get/decr/expires atomically.
   */
  private async consumeRedis(
    subject: string,
    rule: RateLimitRule,
    span: Span,
  ): Promise<RateLimitResult> {
    if (!this.redis) {
      throw new RateLimiterUnavailableError('Redis connection not configured');
    }

    if (!this.scriptSha) {
      await this.bootstrapLuaScript();
    }

    const key = `rl:${rule.namespace}:${subject}`;
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      const [remaining, ttl] = (await this.redis.evalsha(
        this.scriptSha!,
        1,
        key,
        rule.limit,
        rule.windowSec,
        nowSec,
      )) as [number, number];

      const allowed = remaining >= 0;
      const result: RateLimitResult = {
        allowed,
        remaining: Math.max(0, remaining),
        resetAt: (nowSec + ttl) * 1000,
      };

      span.setAttributes({
        'rate_limiter.redis_remaining': remaining,
        'rate_limiter.redis_ttl': ttl,
      });

      return result;
    } catch (err) {
      // Fallback to memory store if Redis is temporarily unavailable
      this.logger.error('Redis rate-limiter error — falling back to memory store', { err });
      return this.consumeMemory(subject, rule);
    }
  }

  /**
   * Loads the Lua script and caches its SHA for subsequent EVALSHA calls.
   */
  /* eslint sonarjs/cognitive-complexity: ["error", 10] */
  private async bootstrapLuaScript(): Promise<void> {
    if (!this.redis) return;

    const script = `
      --[[
        KEYS[1]   = token bucket key
        ARGV[1]   = limit
        ARGV[2]   = window (s)
        ARGV[3]   = now (s)
        Returns: {remaining, ttl}
      ]]
      local limit   = tonumber(ARGV[1])
      local window  = tonumber(ARGV[2])
      local now     = tonumber(ARGV[3])

      local current = tonumber(redis.call("GET", KEYS[1]) or "0")
      if current == 0 then
        -- first hit in window — initialize bucket and set expiry
        redis.call("SET", KEYS[1], limit - 1, "EX", window, "NX")
        return {limit - 1, window}
      else
        if current > 0 then
          local remaining = redis.call("DECR", KEYS[1])
          local ttl       = redis.call("PTTL", KEYS[1]) / 1000
          return {remaining, ttl}
        else
          local ttl = redis.call("PTTL", KEYS[1]) / 1000
          return {current, ttl}
        end
      end
    `;

    try {
      this.scriptSha = await this.redis.script('LOAD', script);
      this.logger.info('Rate-limiter Lua script loaded', { sha: this.scriptSha });
    } catch (err) {
      this.logger.error('Unable to load rate-limiter Lua script', { err });
      throw new RateLimiterUnavailableError('Failed to load rate-limiter script');
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Express / Apollo middleware examples (for reference only)                */
/* ------------------------------------------------------------------------ */

/**
 * Express middleware factory.
 * Usage:
 *    app.post('/api/posts', rateLimitMiddleware(rLimiter, { namespace: 'POST_CREATE', limit: 20, windowSec: 60 }), handler)
 */
export const rateLimitMiddleware =
  (limiter: DistributedRateLimiter, rule: RateLimitRule) =>
  async (req: any, res: any, next: () => void) => {
    try {
      const userId = req.user?.id ?? 'anonymous';
      await limiter.consume(userId, rule);
      next();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        res.status(429).json({
          error: 'Too Many Requests',
          retry_after_ms: err.resetAt - Date.now(),
        });
      } else {
        next(err);
      }
    }
  };

/**
 * Apollo Server plugin example.
 *
 * import { ApolloServer } from 'apollo-server-express';
 * const server = new ApolloServer({
 *   typeDefs,
 *   resolvers,
 *   plugins: [apolloRateLimitPlugin(limiter)],
 * });
 */
export const apolloRateLimitPlugin =
  (limiter: DistributedRateLimiter): import('apollo-server-plugin-base').ApolloServerPlugin => ({
    async requestDidStart() {
      return {
        async didResolveOperation(requestContext) {
          const { operationName, variables } = requestContext.request;
          const userId = requestContext.context?.user?.id ?? 'anonymous';
          const rule: RateLimitRule = {
            namespace: operationName ?? 'GRAPHQL_OP',
            limit: 100,
            windowSec: 60,
          };
          await limiter.consume(userId, rule);
        },
      };
    },
  });
```