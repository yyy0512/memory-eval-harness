```typescript
/**************************************************************************************************
 * File: src/module_45.ts
 * Project: SocialPulse Gateway (api_gateway)
 *
 * Description:
 *  A resilient, strongly-typed HTTP client used by the gateway to communicate with downstream
 *  micro-services (timeline, media, messaging, notifications, social-graph, etc.).  The client
 *  provides:
 *
 *    • Automatic retries with exponential back-off
 *    • Circuit-breaker protection
 *    • Distributed request-level caching (Redis)
 *    • Structured logging and OpenTelemetry tracing
 *    • Request validation and sane timeouts
 *    • Concurrency limits to protect internal resources
 *
 *  NOTE: All dependencies are purposefully imported at the top-level.  For external modules that
 *  live outside the mono-repo (@socialpulse/*), a light-weight interface is provided so that this
 *  file stays self-contained for the purpose of the exercise.
 **************************************************************************************************/

/* ─────────────────────────────────────  External Imports  ───────────────────────────────────── */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, Method } from 'axios';
import axiosRetry, { isNetworkOrIdempotentRequestError } from 'axios-retry';
import CircuitBreaker from 'opossum';
import pLimit from 'p-limit';
import * as otel from '@opentelemetry/api';
import { v4 as uuid } from 'uuid';
import Redis from 'ioredis';

/* ────────────────────────────────────────  Local Imports  ───────────────────────────────────── */
import { HttpValidationError, validateRequestSchema } from './validation'; // domain-specific
import { Logger } from './logger';                                          // structured logger

/* ────────────────────────────────────────────  Types  ───────────────────────────────────────── */

export interface ResilientClientOptions {
  /** Root URL of the downstream service (https://timeline.internal) */
  baseUrl: string;

  /** Max number of in-flight requests allowed for this client instance */
  maxConcurrency?: number;

  /** Number of retry attempts for transient errors */
  maxRetries?: number;

  /** Per-request timeout (ms).  Defaults to 5 seconds */
  timeoutMs?: number;

  /** Redis instance used for GET request caching */
  redis?: Redis;

  /** Cache TTL in seconds (only applied to GET) */
  cacheTtlSeconds?: number;

  /** Custom logger instance */
  logger?: Logger;

  /** Circuit breaker options (fallback to sane defaults) */
  circuitBreakerOptions?: CircuitBreaker.Options;

  /** Optional header object to send with *every* request */
  defaultHeaders?: Record<string, string>;
}

export interface RequestOptions<TBody = unknown, TQuery = unknown> {
  /** Path relative to baseUrl, e.g. `/v1/posts/123` */
  path: string;

  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method?: Method;

  /** JSON request body for POST/PUT/PATCH */
  body?: TBody;

  /** Query-string parameters */
  query?: TQuery;

  /** Map of additional headers */
  headers?: Record<string, string>;

  /** Disable cache for this request (GET only) */
  bypassCache?: boolean;
}

/* Generic typed response */
export interface ApiResponse<TData = unknown> {
  requestId: string;
  status: number;
  data: TData;
}

/* ──────────────────────────────────────────  Constants  ─────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CACHE_TTL_SECONDS = 10;
const DEFAULT_MAX_CONCURRENCY = 50;

/* ─────────────────────────────────────────  Main Class  ────────────────────────────────────── */

/**
 * ResilientServiceClient
 *
 * A drop-in replacement for plain Axios calls with added robustness features.
 */
export class ResilientServiceClient {
  private readonly axios: AxiosInstance;
  private readonly breaker: CircuitBreaker<AxiosRequestConfig, AxiosResponse>;
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly redis?: Redis;
  private readonly cacheTtlSeconds: number;
  private readonly log: Logger;
  private readonly tracer = otel.trace.getTracer('socialpulse.gateway');

  constructor(private readonly options: ResilientClientOptions) {
    /* ─────── Input-sanity & defaults ─────── */
    if (!options.baseUrl) {
      throw new TypeError('baseUrl is required');
    }

    this.log = options.logger ?? new Logger('ResilientServiceClient');

    /* ─────── Axios instance ─────── */
    this.axios = axios.create({
      baseURL: this.options.baseUrl,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        'User-Agent': 'SocialPulse-Gateway/1.0',
        ...options.defaultHeaders,
      },
    });

    /* ─────── Retry strategy ─────── */
    axiosRetry(this.axios, {
      retries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        // Only retry for idempotent + network errors
        return (
          isNetworkOrIdempotentRequestError(error) ||
          error.response?.status === 429 || // Too Many Requests
          error.response?.status >= 500
        );
      },
      onRetry: (count, error) => {
        this.log.warn(
          {
            service: options.baseUrl,
            attempt: count,
            code: error.code,
            status: error.response?.status,
          },
          'Retrying downstream request',
        );
      },
    });

    /* ─────── Circuit-breaker ─────── */
    this.breaker = new CircuitBreaker(this.executeAxiosRequest.bind(this), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      ...options.circuitBreakerOptions,
    });

    this.breaker.on('open', () => this.log.warn({ service: options.baseUrl }, 'Circuit opened'));
    this.breaker.on('halfOpen', () => this.log.info({ service: options.baseUrl }, 'Circuit half-open'));
    this.breaker.on('close', () => this.log.info({ service: options.baseUrl }, 'Circuit closed'));

    /* ─────── Concurrency limiter ─────── */
    this.limit = pLimit(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);

    /* ─────── Cache init ─────── */
    this.redis = options.redis;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  }

  /* ────────────────────────────────────────  Public API  ─────────────────────────────────────── */

  /**
   * Performs a HTTP request with full resilience.
   *
   * @throws AxiosError | CircuitBreaker.BrokenCircuitError | HttpValidationError
   */
  async request<TResponse = unknown, TBody = unknown, TQuery = unknown>(
    opts: RequestOptions<TBody, TQuery>,
  ): Promise<ApiResponse<TResponse>> {
    // Validate and build config
    const config = this.buildAxiosConfig(opts);

    // Unique request ID for trace-ability
    const requestId = uuid();

    /* IMPORTANT: For GET requests we attempt a cache lookup before hitting the downstream. */
    const cacheKey = this.buildCacheKey(config);
    if (this.isCacheable(config.method) && !opts.bypassCache && this.redis) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.log.debug({ path: config.url }, 'Cache hit');
        return {
          requestId,
          status: 200,
          data: JSON.parse(cached) as TResponse,
        };
      }
    }

    // Perform request inside concurrency limiter & circuit breaker
    const span = this.startSpan(config, requestId);
    try {
      const axiosResponse = await this.limit(() => this.breaker.fire(config));
      span.setStatus({ code: otel.SpanStatusCode.OK });
      // Cache response if eligible
      if (this.isCacheable(config.method) && this.redis) {
        await this.redis.setex(
          cacheKey,
          this.cacheTtlSeconds,
          JSON.stringify(axiosResponse.data),
        );
      }
      return {
        requestId,
        status: axiosResponse.status,
        data: axiosResponse.data as TResponse,
      };
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({ code: otel.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  /* ─────────────────────────────────────  Private Helpers  ──────────────────────────────────── */

  /**
   * Builds a fully-qualified Axios config from RequestOptions.
   * Also performs request validation.
   */
  private buildAxiosConfig<TBody, TQuery>(opts: RequestOptions<TBody, TQuery>): AxiosRequestConfig {
    // Basic sanity
    if (!opts.path?.startsWith('/')) {
      throw new HttpValidationError('path must start with a slash (/)');
    }

    // Validate request against schema if present
    validateRequestSchema(opts.path, opts.method ?? 'GET', {
      body: opts.body,
      query: opts.query,
      headers: opts.headers,
    });

    const config: AxiosRequestConfig = {
      url: opts.path,
      method: (opts.method ?? 'GET') as Method,
      headers: {
        ...opts.headers,
      },
      params: opts.query as any,
      data: opts.body,
    };

    return config;
  }

  /** Actual Axios execution (wrapped by opossum circuit breaker) */
  private async executeAxiosRequest(config: AxiosRequestConfig): Promise<AxiosResponse> {
    this.log.debug(
      { method: config.method, url: config.url, params: config.params },
      'Dispatching downstream request',
    );
    return this.axios.request(config);
  }

  /** Determines if a HTTP method is cacheable */
  private isCacheable(method?: string): boolean {
    return (method ?? 'GET').toUpperCase() === 'GET';
  }

  /** Generates a stable Redis key for cache lookups */
  private buildCacheKey(config: AxiosRequestConfig): string {
    // Example: timeline:/v1/posts?author=abc
    const query = config.params ? JSON.stringify(config.params) : '';
    return `${this.options.baseUrl}:${config.url ?? ''}:${query}`;
  }

  /** Starts a new OpenTelemetry span for the outgoing HTTP call */
  private startSpan(config: AxiosRequestConfig, requestId: string): otel.Span {
    const span = this.tracer.startSpan('downstream.http', {
      attributes: {
        'http.method': config.method,
        'http.url': `${this.options.baseUrl}${config.url}`,
        'request.id': requestId,
      },
    });
    return span;
  }
}

/* ─────────────────────────────────────────  Exports  ───────────────────────────────────────── */

export default ResilientServiceClient;

/* ─────────────────────────────────────  Mocked Modules  ─────────────────────────────────────── */
/**
 * In the actual production codebase, these would come from shared packages.
 * For the purpose of this standalone file, we provide minimal stubs.
 */

declare module './logger' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class Logger {
    constructor(scope?: string);
    debug(meta: Record<string, any>, msg: string): void;
    info(meta: Record<string, any>, msg: string): void;
    warn(meta: Record<string, any>, msg: string): void;
    error(meta: Record<string, any>, msg: string): void;
  }
}

declare module './validation' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function validateRequestSchema(path: string, method: string, payload: any): void;
  export class HttpValidationError extends Error {}
}
```