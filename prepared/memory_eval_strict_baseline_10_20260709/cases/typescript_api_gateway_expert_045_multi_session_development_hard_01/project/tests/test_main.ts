```typescript
/**
 * tests/test_main.ts
 *
 * High-level integration tests for the SocialPulse Gateway’s HTTP surface.
 * These tests rely on Jest + SuperTest and showcase how the gateway is expected
 * to behave around critical cross-cutting concerns:
 *   – request-validation
 *   – rate-limiting
 *   – response-caching
 *   – versioned routing
 *   – API documentation exposure
 *
 * NOTE: The real implementations live under `src/**`.  In order to keep the
 * tests hermetic, the heavyweight dependencies are mocked with Jest.  Only the
 * public contracts (interfaces / DTOs) are imported from source code so that
 * type-checking still guards against API drift.
 */

import request from 'supertest';
import { Express } from 'express';
import http from 'http';
import { mocked } from 'ts-jest/utils';

// Contracts
import { TimelineResponseDto } from '../src/application/dtos/timeline.dto';

// System-under-test factory
import { buildServer } from '../src/infrastructure/http/server';

// External collaborators we want to spy on / stub
import { CacheProvider } from '../src/infrastructure/cache/cache.provider';
import { RateLimiter } from '../src/infrastructure/security/rate-limiter';
import {
  GetTimelineV1UseCase,
  GetTimelineV2UseCase,
} from '../src/application/use-cases/timeline';

// Jest auto-mocking for infrastructure & use-cases
jest.mock('../src/infrastructure/cache/cache.provider');
jest.mock('../src/infrastructure/security/rate-limiter');
jest.mock('../src/application/use-cases/timeline');

const MockedCacheProvider = mocked(CacheProvider, true);
const MockedRateLimiter = mocked(RateLimiter, true);
const MockedGetTimelineV1UseCase = mocked(GetTimelineV1UseCase, true);
const MockedGetTimelineV2UseCase = mocked(GetTimelineV2UseCase, true);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let app: Express;
let httpServer: http.Server;

beforeAll(async () => {
  // buildServer wires middlewares, routes, DI container, etc.
  app = await buildServer();
  httpServer = app.listen(); // ephemeral port
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const sampleTimeline: TimelineResponseDto = {
  userId: 'user-123',
  items: [
    // realistic payload trimmed for brevity
    {
      id: 'post-1',
      kind: 'POST',
      author: { id: 'friend-1', displayName: 'Alice' },
      body: 'Hello world 👋',
      reactions: 10,
      comments: 2,
      createdAt: new Date().toISOString(),
    },
  ],
  paging: { nextCursor: null },
};

// ---------------------------------------------------------------------------
// Happy-path – V1
// ---------------------------------------------------------------------------
describe('GET /api/v1/timeline', () => {
  const endpoint = '/api/v1/timeline';

  test('returns 200 with aggregated timeline when query is valid', async () => {
    // Arrange
    MockedGetTimelineV1UseCase.prototype.execute.mockResolvedValueOnce(
      sampleTimeline,
    );

    // Act
    const res = await request(httpServer)
      .get(endpoint)
      .query({ userId: 'user-123' })
      .set('Accept', 'application/json'); // explicit but optional

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleTimeline);
    // Ensure underlying use-case executed
    expect(MockedGetTimelineV1UseCase.prototype.execute).toHaveBeenCalledWith({
      userId: 'user-123',
      cursor: undefined,
    });
  });

  test('fails with 400 when required query param is missing', async () => {
    const res = await request(httpServer).get(endpoint);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { message: expect.stringMatching(/userId/i) },
    });
    // Use-case should not be executed
    expect(MockedGetTimelineV1UseCase.prototype.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response caching
// ---------------------------------------------------------------------------
describe('Caching behaviour for timeline endpoint', () => {
  const endpoint = '/api/v1/timeline';
  const cacheKey = 'timeline:user-123:undefined';

  test('skips use-case execution when cached value exists', async () => {
    // Arrange cache hit
    MockedCacheProvider.prototype.get.mockResolvedValueOnce(sampleTimeline);

    const res = await request(httpServer)
      .get(endpoint)
      .query({ userId: 'user-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(sampleTimeline);
    // Use-case must NOT be called when cache hits
    expect(MockedGetTimelineV1UseCase.prototype.execute).not.toHaveBeenCalled();
    // CacheProvider.get should be invoked with correct key
    expect(MockedCacheProvider.prototype.get).toHaveBeenCalledWith(cacheKey);
  });

  test('stores freshly computed data into cache on miss', async () => {
    MockedCacheProvider.prototype.get.mockResolvedValueOnce(null); // miss
    MockedGetTimelineV1UseCase.prototype.execute.mockResolvedValueOnce(
      sampleTimeline,
    );

    await request(httpServer).get(endpoint).query({ userId: 'user-123' });

    expect(MockedCacheProvider.prototype.set).toHaveBeenCalledWith(
      cacheKey,
      sampleTimeline,
      expect.any(Number), // TTL seconds
    );
  });
});

// ---------------------------------------------------------------------------
// Rate-limiting
// ---------------------------------------------------------------------------
describe('Rate-limiting middleware', () => {
  const endpoint = '/api/v1/timeline';

  test('blocks abusive caller with HTTP 429', async () => {
    // Simulate "too many requests" detection
    MockedRateLimiter.prototype.consume.mockImplementationOnce(() => {
      throw new Error('Rate limit exceeded');
    });

    const res = await request(httpServer)
      .get(endpoint)
      .query({ userId: 'abusive-user' });

    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// Versioned routing – feature rollout for ranking V2
// ---------------------------------------------------------------------------
describe('Version negotiation via Accept-Version header', () => {
  const endpoint = '/api/timeline'; // version-agnostic route

  test('delegates to V2 use-case when client opts-in', async () => {
    MockedGetTimelineV2UseCase.prototype.execute.mockResolvedValueOnce(
      sampleTimeline,
    );

    const res = await request(httpServer)
      .get(endpoint)
      .query({ userId: 'user-123' })
      .set('Accept-Version', '2');

    expect(res.status).toBe(200);
    expect(MockedGetTimelineV2UseCase.prototype.execute).toHaveBeenCalled();
    expect(MockedGetTimelineV1UseCase.prototype.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// API documentation
// ---------------------------------------------------------------------------
describe('OpenAPI documentation exposure', () => {
  test('serves swagger UI on /docs', async () => {
    const res = await request(httpServer).get('/docs');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<title>SocialPulse API Docs<\/title>/);
  });

  test('serves raw OpenAPI JSON on /openapi.json', async () => {
    const res = await request(httpServer).get('/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi', '3.0.1');
    expect(res.body).toHaveProperty('paths');
  });
});
```