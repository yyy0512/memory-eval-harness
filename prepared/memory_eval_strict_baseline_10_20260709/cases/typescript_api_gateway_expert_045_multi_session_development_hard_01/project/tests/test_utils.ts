```typescript
/**
 * tests/test_utils.ts
 *
 * Integration–style tests for the generic utilities that power the
 * SocialPulse API-Gateway.  All utilities live in `src/utils` and are
 * completely framework-agnostic.
 *
 * NOTE:  The underlying implementations are not included here.  These
 * tests **must** succeed against the production implementations in the
 * `src/utils` folder.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';

import {
  parsePaginationParams,
  buildCacheKey,
  retryWithBackoff,
  sanitizeGraphQLQuery,
  generateRateLimitKey,
} from '../src/utils';

describe('utils/parsePaginationParams', () => {
  it('returns defaults when no query params are provided', () => {
    const result = parsePaginationParams({});
    expect(result).toEqual({ page: 1, limit: 20, offset: 0 });
  });

  it('normalises string values and casts them to numbers', () => {
    const result = parsePaginationParams({ page: '3', limit: '50' });
    expect(result).toEqual({ page: 3, limit: 50, offset: 100 });
  });

  it('throws when negative or non-numeric values are supplied', () => {
    expect(() => parsePaginationParams({ page: '-4', limit: 'abc' })).toThrow(
      /Invalid pagination/i,
    );
  });
});

describe('utils/buildCacheKey', () => {
  it('generates identical keys for semantically equal parameter objects (order-independent)', () => {
    const paramsA = { hashtag: 'typescript', page: 2, limit: 30 };
    const paramsB = { limit: 30, page: 2, hashtag: 'typescript' };

    const keyA = buildCacheKey('trendingFeed', paramsA);
    const keyB = buildCacheKey('trendingFeed', paramsB);

    expect(keyA).toEqual(keyB);
  });

  it('omits undefined or null parameters from the key', () => {
    const paramsA = { q: 'hello', locale: undefined, page: 1 };
    const paramsB = { q: 'hello', page: 1 };

    const keyA = buildCacheKey('search', paramsA);
    const keyB = buildCacheKey('search', paramsB);

    expect(keyA).toEqual(keyB);
  });

  it('produces an HMAC-SHA256 encoded cache key', () => {
    const params = { userId: 123, page: 1 };
    const key = buildCacheKey('timeline', params);

    // We expect a 64-character hex string (SHA-256 length).
    expect(key).toMatch(/^[a-f0-9]{64}$/i);
  });
});

describe('utils/retryWithBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('retries the provided function with exponential backoff and eventually resolves', async () => {
    const invocationLog: number[] = [];
    let attempt = 0;

    const flakyFn = jest.fn(async () => {
      attempt += 1;
      invocationLog.push(attempt);

      if (attempt < 3) {
        throw new Error('Transient failure');
      }

      return 'OK';
    });

    const promise = retryWithBackoff(flakyFn, {
      maxRetries: 5,
      baseDelayMs: 100,
      factor: 2,
    });

    // Fast-forward timers: 1st retry after 100ms, 2nd after 200ms.
    jest.advanceTimersByTime(100 + 200);

    const result = await promise;
    expect(result).toBe('OK');

    // We should have attempted 3 times total (initial + 2 retries).
    expect(invocationLog).toEqual([1, 2, 3]);
  });

  it('rejects once maxRetries has been exceeded', async () => {
    const alwaysFailingFn = jest.fn(async () => {
      throw new Error('Still broken');
    });

    const promise = retryWithBackoff(alwaysFailingFn, {
      maxRetries: 2,
      baseDelayMs: 50,
      factor: 2,
    });

    // Fast-forward all scheduled retries: 50 + 100 ms.
    jest.advanceTimersByTime(150);

    await expect(promise).rejects.toThrow(/Still broken/);

    // initial call + 2 retries
    expect(alwaysFailingFn).toHaveBeenCalledTimes(3);
  });
});

describe('utils/sanitizeGraphQLQuery', () => {
  it('strips out dangerous directives and disallows __schema introspection', () => {
    const rawQuery = `
      query Malicious {
        __schema { types { name } }
        user(id: "123") {
          password
          email @skip(if: true)
        }
      }
    `;

    const sanitized = sanitizeGraphQLQuery(rawQuery);

    expect(sanitized).not.toMatch(/__schema/);
    expect(sanitized).not.toMatch(/@skip/);
    // Business data fields should still be present
    expect(sanitized).toMatch(/user\s*\(\s*id:\s*"123"\s*\)/);
  });

  it('preserves legitimate queries untouched', () => {
    const legitQuery = `
      query Feed($cursor: String) {
        feed(after: $cursor, first: 20) {
          edges { node { id content likes } }
          pageInfo { endCursor hasNextPage }
        }
      }
    `;

    expect(sanitizeGraphQLQuery(legitQuery)).toEqual(legitQuery);
  });
});

describe('utils/generateRateLimitKey', () => {
  it('combines path, method and userId into a stable sha-256 key', () => {
    const key1 = generateRateLimitKey({
      method: 'POST',
      path: '/v1/messages',
      userId: 'user-123',
    });

    const key2 = generateRateLimitKey({
      userId: 'user-123',
      method: 'POST',
      path: '/v1/messages',
    });

    // Same inputs => same deterministic key
    expect(key1).toEqual(key2);

    // Validate format (hex encoded SHA-256)
    expect(key1).toMatch(/^[a-f0-9]{64}$/i);

    // Changing any component should produce a different key
    const key3 = generateRateLimitKey({
      method: 'POST',
      path: '/v1/messages',
      userId: 'user-999',
    });

    expect(key3).not.toEqual(key1);
  });

  it('is collision-resistant for similar paths & methods', () => {
    const combinations = [
      { method: 'GET', path: '/v1/users', userId: 'a' },
      { method: 'GET', path: '/v1/users/', userId: 'a' },
      { method: 'GET', path: '/v1/users/ ', userId: 'a' },
    ] as const;

    const keys = combinations.map(generateRateLimitKey);
    // Ensure all keys are unique
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
```