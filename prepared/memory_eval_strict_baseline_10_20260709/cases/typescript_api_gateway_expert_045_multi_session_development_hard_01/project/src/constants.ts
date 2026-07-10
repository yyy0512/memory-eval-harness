```typescript
/**
 * src/constants.ts
 *
 * A single, strongly-typed source of truth for configuration values, shared
 * enums and magic-strings used throughout the SocialPulse gateway.
 *
 * NOTE:
 *   – This module performs **eager** environment validation. Import it as early
 *     as possible (e.g., in the application entry-point) so the process fails
 *     fast when critical variables are missing or malformed.
 *   – Only add to this file if a value is truly static / global. Prefer passing
 *     scoped configuration through constructor injection where feasible.
 */

import dotenv from 'dotenv';
import ms from 'ms';
import { z } from 'zod';

dotenv.config(); // Load .env before touching process.env

/* -------------------------------------------------------------------------- */
/*                               Env validation                               */
/* -------------------------------------------------------------------------- */

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /* ---------------------------------------------------------------------- */
    /* General application settings                                           */
    /* ---------------------------------------------------------------------- */
    API_PORT: z.preprocess((v) => Number(v), z.number().int().positive().default(8080)),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    GATEWAY_VERSION: z.string().regex(/^v[0-9]+$/).default('v1'),

    /* ---------------------------------------------------------------------- */
    /* Redis / caching                                                        */
    /* ---------------------------------------------------------------------- */
    REDIS_URL: z.string().url(),

    /* ---------------------------------------------------------------------- */
    /* Rate-limiting                                                          */
    /* ---------------------------------------------------------------------- */
    RATELIMIT_WINDOW: z.string().default('1m'), // parsed by `ms`
    RATELIMIT_MAX_REQUESTS: z.preprocess((v) => Number(v), z.number().int().positive().default(100)),

    /* ---------------------------------------------------------------------- */
    /* GraphQL                                                                */
    /* ---------------------------------------------------------------------- */
    GRAPHQL_PLAYGROUND: z.preprocess((v) => v === 'true', z.boolean()).default(false),

    /* ---------------------------------------------------------------------- */
    /* Optional integrations                                                  */
    /* ---------------------------------------------------------------------- */
    SERVICE_REGISTRY_URL: z.string().url().optional(),
    AUTH_PUBLIC_KEY: z.string().optional()
  })
  .strict();

let env: z.infer<typeof EnvSchema>;

try {
  env = EnvSchema.parse(process.env);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:', error);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                                 Interface                                  */
/* -------------------------------------------------------------------------- */

export interface GatewayConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: typeof env.LOG_LEVEL;
  redisUrl: string;
  playground: boolean;
  rateLimit: {
    windowMs: number;
    max: number;
  };
  apiVersion: string;
  registryUrl: string | null;
  authPublicKey: string | null;
}

/* -------------------------------------------------------------------------- */
/*                              Derived constants                             */
/* -------------------------------------------------------------------------- */

export const IS_PROD = env.NODE_ENV === 'production';
export const IS_TEST = env.NODE_ENV === 'test';
export const IS_DEV = env.NODE_ENV === 'development';

export const APP_PORT = env.API_PORT;
export const LOG_LEVEL = env.LOG_LEVEL;
export const API_VERSION = env.GATEWAY_VERSION;

export const REDIS_URL = env.REDIS_URL;

export const RATE_LIMIT = Object.freeze({
  windowMs: ms(env.RATELIMIT_WINDOW),
  max: env.RATELIMIT_MAX_REQUESTS
});

export const GRAPHQL_PLAYGROUND_ENABLED = env.GRAPHQL_PLAYGROUND;

export const SERVICE_REGISTRY_URL = env.SERVICE_REGISTRY_URL ?? null;
export const AUTH_PUBLIC_KEY = env.AUTH_PUBLIC_KEY ?? null;

/* eslint-disable @typescript-eslint/naming-convention */
export const CONFIG: GatewayConfig = {
  env: env.NODE_ENV,
  port: APP_PORT,
  logLevel: LOG_LEVEL,
  redisUrl: REDIS_URL,
  playground: GRAPHQL_PLAYGROUND_ENABLED,
  rateLimit: RATE_LIMIT,
  apiVersion: API_VERSION,
  registryUrl: SERVICE_REGISTRY_URL,
  authPublicKey: AUTH_PUBLIC_KEY
};
/* eslint-enable @typescript-eslint/naming-convention */

/* -------------------------------------------------------------------------- */
/*                               Enumerations                                 */
/* -------------------------------------------------------------------------- */

/**
 * Logical names of downstream micro-services. Centralising them helps avoid
 * typos when constructing service-to-service requests or tracing spans.
 */
export enum Service {
  TIMELINE = 'timeline-service',
  MEDIA = 'media-service',
  MESSAGING = 'messaging-service',
  NOTIFICATIONS = 'notifications-service',
  SOCIAL_GRAPH = 'social-graph-service'
}

/**
 * Shared HTTP header names used for correlation, auth and client hints.
 */
export enum Header {
  // Observability
  CORRELATION_ID = 'x-correlation-id',
  REQUEST_ID = 'x-request-id',
  SPAN_ID = 'x-span-id',

  // Auth / identity
  AUTHORIZATION = 'authorization',
  USER_ID = 'x-user-id',

  // Client hints
  USER_AGENT = 'user-agent',
  CLIENT_VERSION = 'x-client-version'
}

/**
 * Cache key prefixes to enforce a predictable namespace inside Redis.
 */
export enum CacheKeyPrefix {
  PUBLIC_TIMELINE = 'public_timeline',
  USER_FEED = 'user_feed',
  TRENDING_TAGS = 'trending_tags',
  USER_PRESENCE = 'user_presence',
  STORY_REELS = 'story_reels'
}

/**
 * Canonical GraphQL subscription topics.
 */
export const SUBSCRIPTION_TOPICS = Object.freeze({
  POST_CREATED: 'POST_CREATED',
  POST_REACTION: 'POST_REACTION',
  CHAT_MESSAGE: 'CHAT_MESSAGE',
  USER_PRESENCE: 'USER_PRESENCE'
} as const);
export type SubscriptionTopic =
  (typeof SUBSCRIPTION_TOPICS)[keyof typeof SUBSCRIPTION_TOPICS];

/**
 * Logical buckets for rate-limiting middleware.
 */
export enum RateLimitGroup {
  AUTHENTICATED = 'authenticated',
  ANONYMOUS = 'anonymous',
  SERVICE = 'service'
}

/**
 * Sensible defaults for each bucket. These values can be overridden by
 * specialised middleware if a specific route needs looser / stricter limits.
 */
export const DEFAULT_RATE_LIMITS: Record<RateLimitGroup, { windowMs: number; max: number }> = {
  [RateLimitGroup.AUTHENTICATED]: RATE_LIMIT,
  [RateLimitGroup.ANONYMOUS]: { windowMs: ms('1m'), max: 30 },
  [RateLimitGroup.SERVICE]: { windowMs: ms('10s'), max: 500 }
};

/**
 * Standardised error codes returned in the `extensions.code` field for GraphQL
 * errors and in the `error.code` field for REST responses.
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const);
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/* -------------------------------------------------------------------------- */
/*                               Route helpers                                */
/* -------------------------------------------------------------------------- */

export const ROUTE_PREFIX = '/api';
export const GRAPHQL_PATH = '/graphql';
export const HEALTH_ROUTE = '/healthz';

/**
 * A single header we use for propagating distributed-trace IDs. The value is
 * compatible with OpenTelemetry's `traceparent` format, but we keep our own
 * shorthand alias for convenience.
 */
export const TRACE_HEADER = 'x-trace-id';
```