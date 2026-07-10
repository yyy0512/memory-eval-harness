```typescript
/**
 * SocialPulse Gateway
 * src/module_66.ts
 *
 * A resilient, version-aware HTTP client used by the API-gateway whenever it
 * needs to call downstream micro-services (timeline, media, messaging, …).
 *
 * Features
 * --------
 * • Automatic service discovery via env-vars / config-service
 * • Per-service circuit-breaker with configurable thresholds
 * • Exponential-back-off & jitter on retryable failures
 * • Optional read-through Redis caching for idempotent GET requests
 * • Centralised structured logging & observability hooks
 *
 * NOTE: Do not import this file directly from presentation-layer code!
 *       Use the “service-layer” facades instead so we keep clean-architecture
 *       boundaries intact.
 */

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios';
import CircuitBreaker from 'opossum';
import pRetry, { AbortError, Options as RetryOptions } from 'p-retry';
import Redis, { Redis as RedisClient } from 'ioredis';
import { v4 as uuid } from 'uuid';

import { logger } from './infrastructure/logger'; // <- shared winston logger
import { Metrics } from './infrastructure/metrics'; // <- Prometheus/StatsD wrapper

/**********************************************************************************************************************
 * Types & Interfaces
 *********************************************************************************************************************/

export type Microservice =
  | 'TIMELINE'
  | 'MEDIA'
  | 'MESSAGING'
  | 'NOTIFICATIONS'
  | 'SOCIAL_GRAPH';

interface BaseServiceConfig {
  /**
   * Base URL of the micro-service like https://timeline.svc.cluster.local
   */
  baseUrl: string;

  /**
   * Default version (e.g. "v1") if the caller did not request explicit
   * versioning.
   */
  defaultVersion: string;
}

interface ServiceDiscoveryTable {
  [service in Microservice]: BaseServiceConfig;
}

export interface HttpClientOptions<T> extends AxiosRequestConfig<T> {
  /**
   * Semantic service name so we can pick the correct breaker & config.
   */
  service: Microservice;

  /**
   * Optional API version to be appended after the baseUrl, i.e.
   *   https://timeline/ <version>/path
   */
  version?: string;

  /**
   * Cache GET responses for <ttlSeconds>. If undefined, no caching is applied.
   */
  cacheTtlSeconds?: number;
}

/**********************************************************************************************************************
 * In-memory singleton instances
 *********************************************************************************************************************/

/**
 * Simple Redis connection pooling via ioredis.
 * (In production we would share this across the whole application.)
 */
const redis: RedisClient = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  enableOfflineQueue: false,
});

/**
 * Service discovery table populated from env-vars or fallback defaults.
 * In real-life this might be populated from Consul, etcd, or a config service.
 */
const serviceDiscovery: ServiceDiscoveryTable = {
  TIMELINE: {
    baseUrl: process.env.TIMELINE_BASE_URL ?? 'http://timeline:4000',
    defaultVersion: process.env.TIMELINE_DEFAULT_VERSION ?? 'v1',
  },
  MEDIA: {
    baseUrl: process.env.MEDIA_BASE_URL ?? 'http://media:4001',
    defaultVersion: process.env.MEDIA_DEFAULT_VERSION ?? 'v1',
  },
  MESSAGING: {
    baseUrl: process.env.MESSAGING_BASE_URL ?? 'http://messaging:4002',
    defaultVersion: process.env.MESSAGING_DEFAULT_VERSION ?? 'v1',
  },
  NOTIFICATIONS: {
    baseUrl: process.env.NOTIFICATIONS_BASE_URL ?? 'http://notifications:4003',
    defaultVersion: process.env.NOTIFICATIONS_DEFAULT_VERSION ?? 'v1',
  },
  SOCIAL_GRAPH: {
    baseUrl: process.env.SOCIAL_GRAPH_BASE_URL ?? 'http://social-graph:4004',
    defaultVersion: process.env.SOCIAL_GRAPH_DEFAULT_VERSION ?? 'v1',
  },
};

/**********************************************************************************************************************
 * Circuit-breaker factory
 *********************************************************************************************************************/

/**
 * Map each micro-service to its own circuit-breaker so one noisy dependency
 * will not impact the rest.
 */
const breakers: Record<Microservice, CircuitBreaker> = {
  TIMELINE: makeBreaker('TIMELINE'),
  MEDIA: makeBreaker('MEDIA'),
  MESSAGING: makeBreaker('MESSAGING'),
  NOTIFICATIONS: makeBreaker('NOTIFICATIONS'),
  SOCIAL_GRAPH: makeBreaker('SOCIAL_GRAPH'),
};

/**
 * Create a configured circuit-breaker instance.
 */
function makeBreaker(service: Microservice): CircuitBreaker {
  /* eslint-disable @typescript-eslint/naming-convention */
  const breaker = new CircuitBreaker(rawRequest, {
    timeout: Number(process.env.CB_TIMEOUT_MS ?? 5_000),
    errorThresholdPercentage: Number(
      process.env.CB_ERROR_THRESHOLD_PCT ?? 50,
    ),
    resetTimeout: Number(process.env.CB_RESET_TIMEOUT_MS ?? 30_000),
    rollingCountTimeout: Number(
      process.env.CB_WINDOW_SIZE_MS ?? 10_000,
    ),
    rollingCountBuckets: Number(process.env.CB_BUCKETS ?? 10),
  });
  /* eslint-enable @typescript-eslint/naming-convention */

  breaker.on('open', () =>
    logger.warn(`Circuit breaker opened for ${service}`),
  );
  breaker.on('close', () =>
    logger.info(`Circuit breaker closed for ${service}`),
  );
  breaker.on('halfOpen', () =>
    logger.info(`Circuit breaker half-open for ${service}`),
  );

  return breaker;
}

/**********************************************************************************************************************
 * Core client implementation
 *********************************************************************************************************************/

class GatewayHttpClient {
  private readonly axios: AxiosInstance;
  private readonly metrics = Metrics.instance();

  constructor() {
    this.axios = axios.create({
      timeout: Number(process.env.DOWNSTREAM_TIMEOUT_MS ?? 4_000),
      headers: {
        'User-Agent': 'SocialPulse-Gateway/1.0 (+https://socialpulse.io)',
      },
    });
  }

  /**
   * Generic request method. Handles:
   * • Versioned routing
   * • Retries w/ exponential back-off
   * • Circuit-breaker & graceful degrading
   * • Optional Redis read-through cache for GETs
   */
  async request<T = unknown, D = unknown>(
    opts: HttpClientOptions<D>,
  ): Promise<T> {
    const { service, version, cacheTtlSeconds, ...axiosOpts } = opts;

    const discoveredService = serviceDiscovery[service];
    if (!discoveredService) {
      // Should never happen; compile-time failure is better though.
      throw new Error(`Unknown microservice: ${service}`);
    }

    const resolvedVersion = version ?? discoveredService.defaultVersion;
    const finalUrl = `${discoveredService.baseUrl}/${resolvedVersion}${
      axiosOpts.url?.startsWith('/') ? '' : '/'
    }${axiosOpts.url ?? ''}`;

    const enhancedReq: AxiosRequestConfig<D> = {
      ...axiosOpts,
      url: finalUrl,
    };

    const cacheKey =
      cacheTtlSeconds && enhancedReq.method?.toUpperCase() === 'GET'
        ? this.buildCacheKey(service, enhancedReq)
        : null;

    /* Attempt to serve from cache first (read-through). */
    if (cacheKey) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        this.metrics.increment('gateway.cache.hit', { service });
        return JSON.parse(cached) as T;
      }
      this.metrics.increment('gateway.cache.miss', { service });
    }

    /**
     * We wrap the raw axios call with:
     *   1. Retry policy
     *   2. Circuit breaker
     * so permanent errors trigger fast open circuits while intermittent
     * network errors are retried.
     */
    const breaker = breakers[service];

    const retryableFn = () =>
      breaker.fire<T>(enhancedReq).catch((err: unknown) => {
        if (this.isRetryableError(err)) {
          throw err; // p-retry will handle
        }
        // Non-retryable errors should abort further retries
        throw new AbortError(err as Error);
      });

    const retryOpts: RetryOptions = {
      retries: Number(process.env.DOWNSTREAM_RETRIES ?? 2),
      randomize: true, // Add jitter
      minTimeout: 250,
      maxTimeout: 2000,
      factor: 2,
      onFailedAttempt: (e) => {
        logger.warn(
          {
            service,
            attempt: e.attemptNumber,
            retriesLeft: e.retriesLeft,
            err: e.cause?.message,
          },
          `Retryable request failure for ${service}`,
        );
        this.metrics.increment('gateway.downstream.retry', { service });
      },
    };

    try {
      const response = await pRetry(retryableFn, retryOpts);
      if (cacheKey && cacheTtlSeconds) {
        // Fire-and-forget cache write
        void redis.setex(cacheKey, cacheTtlSeconds, JSON.stringify(response));
      }
      return response;
    } catch (err) {
      logger.error(
        { err, service, url: enhancedReq.url },
        'Downstream request permanently failed',
      );
      this.metrics.increment('gateway.downstream.failure', { service });

      // Attempt to provide stale cache, if present
      if (cacheKey) {
        const stale = await redis.get(cacheKey);
        if (stale) {
          logger.warn(
            `Serving stale cache for ${service} after failure on ${enhancedReq.url}`,
          );
          this.metrics.increment('gateway.cache.stale', { service });
          return JSON.parse(stale) as T;
        }
      }

      throw err;
    }
  }

  /******************************************************************************************************************
   * Private helpers
   ******************************************************************************************************************/

  private buildCacheKey(
    service: Microservice,
    req: AxiosRequestConfig,
  ): string {
    // GET /timeline?user=123 => gateway:cache:TIMELINE:e3b0c… (hash)
    const hash = uuid(); // Using uuid just as placeholder; in prod use sha256(req.url+qs)
    return `gateway:cache:${service}:${hash}`;
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      return (
        err.code === 'ECONNABORTED' || // timeout
        err.code === 'ENOTFOUND' ||
        err.response?.status === 503 ||
        err.response?.status === 502 ||
        err.response?.status === 504
      );
    }
    // Circuit-breaker open errors are considered retryable so that if the breaker
    // transitions back to half-open we can try again.
    if (err instanceof CircuitBreaker.BreakerOpenError) {
      return true;
    }
    return false;
  }
}

/**********************************************************************************************************************
 * Raw request function –> used by circuit breaker
 *********************************************************************************************************************/

async function rawRequest<T>(
  config: AxiosRequestConfig,
): Promise<T> {
  const httpClientSingleton = GatewayHttpClientSingleton.instance();
  const axiosClient = httpClientSingleton.axiosInstance;
  const resp: AxiosResponse<T> = await axiosClient.request<T>(config);
  return resp.data;
}

/**********************************************************************************************************************
 * Singleton façade so other modules can import and reuse.
 *********************************************************************************************************************/

export class GatewayHttpClientSingleton {
  private static _instance: GatewayHttpClientSingleton;

  private readonly client: GatewayHttpClient;
  private readonly axios: AxiosInstance;

  private constructor() {
    this.client = new GatewayHttpClient();
    this.axios = this.client['axios']; // expose for instrumentation
  }

  static instance(): GatewayHttpClient {
    if (!GatewayHttpClientSingleton._instance) {
      GatewayHttpClientSingleton._instance = new GatewayHttpClientSingleton();
    }
    return GatewayHttpClientSingleton._instance.client;
  }

  /**
   * For low-level instrumentation libraries that need direct axios access.
   */
  get axiosInstance(): AxiosInstance {
    return this.axios;
  }
}

/**********************************************************************************************************************
 * Example usage (would normally live inside a service-layer class)
 *********************************************************************************************************************/

/*
(async () => {
  const client = GatewayHttpClientSingleton.instance();

  const timeline = await client.request<string[]>({
    service: 'TIMELINE',
    method: 'GET',
    url: '/users/123/feed',
    params: { limit: 20 },
    cacheTtlSeconds: 10,
    version: 'v2',
  });

  console.log({ timeline });
})();
*/
```
