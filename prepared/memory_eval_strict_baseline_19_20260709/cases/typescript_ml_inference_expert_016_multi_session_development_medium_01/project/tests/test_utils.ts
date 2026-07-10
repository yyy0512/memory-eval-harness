```typescript
/**
 * tests/test_utils.ts
 *
 * High–level integration + unit tests for several foundational utility
 * helpers that power the hexagonal InsightHexaAI platform.
 *
 * All tests rely on Jest (with ts-jest) and make heavy use of fake timers,
 * spies, and mocks to keep the suite deterministic and blazing-fast.
 *
 * NOTE: The production code under test lives in `src/**`.  If you rename or
 * move those modules, remember to update the import paths below.
 */

import { jest } from '@jest/globals';
import { retryWithBackoff } from '../src/shared/utils/retryWithBackoff';
import { CircuitBreaker } from '../src/shared/utils/circuitBreaker';
import {
  SlaPricingService,
  SlaPricingConfig,
} from '../src/domain/pricing/SlaPricingService';
import { InferencePriority } from '../src/domain/pricing/types';
import { CircuitBreakerOpenError } from '../src/shared/errors/CircuitBreakerOpenError';

describe('Utility helpers', () => {
  /***********************************************************************
   * retryWithBackoff
   **********************************************************************/
  describe('retryWithBackoff()', () => {
    beforeEach(() => {
      jest.useFakeTimers(); // deterministic time manipulation
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.clearAllTimers();
      jest.resetAllMocks();
    });

    it('retries a flaky operation until it succeeds, then resolves', async () => {
      const operation = jest
        .fn()
        // first two attempts → throw
        .mockRejectedValueOnce(new Error('temporary failure 1'))
        .mockRejectedValueOnce(new Error('temporary failure 2'))
        // third attempt → succeed
        .mockResolvedValue('🎉 OK');

      const promiseUnderTest = retryWithBackoff(operation, {
        maxRetries: 3,
        initialDelayMs: 100,
        factor: 2,
        jitter: false,
      });

      // Fast-forward time: 1st wait (100 ms), 2nd wait (200 ms)
      jest.advanceTimersByTime(100 + 200);

      await expect(promiseUnderTest).resolves.toBe('🎉 OK');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('bubbles the last error when retries exceed maxRetries', async () => {
      const permanenterror = new Error('💥 still broken');
      const operation = jest.fn().mockRejectedValue(permanenterror);

      const promiseUnderTest = retryWithBackoff(operation, {
        maxRetries: 2,
        initialDelayMs: 50,
      });

      // 1st wait (50 ms) + 2nd wait (100 ms)
      jest.advanceTimersByTime(50 + 100);

      await expect(promiseUnderTest).rejects.toThrow(permanenterror);
      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  /***********************************************************************
   * CircuitBreaker
   **********************************************************************/
  describe('CircuitBreaker', () => {
    const successFn = jest.fn().mockResolvedValue('✅ healthy');
    const failureFn = jest.fn().mockRejectedValue(new Error('💣 failure'));

    afterEach(() => {
      jest.clearAllMocks();
    });

    it('opens the circuit after N consecutive failures', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        coolDownPeriodMs: 1_000,
      });

      // 1st call (failure)
      await expect(breaker.exec(failureFn)).rejects.toThrow();
      // 2nd call (failure) → threshold reached
      await expect(breaker.exec(failureFn)).rejects.toThrow();

      expect(breaker.isOpen()).toBe(true);

      // Subsequent call *without* elapsed cool-down throws synchronously
      await expect(breaker.exec(successFn)).rejects.toBeInstanceOf(
        CircuitBreakerOpenError,
      );
      expect(successFn).not.toHaveBeenCalled();
    });

    it('closes the circuit after cool-down when downstream recovers', async () => {
      jest.useFakeTimers();

      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        coolDownPeriodMs: 2_000,
      });

      // Trigger opening
      await expect(breaker.exec(failureFn)).rejects.toThrow();
      expect(breaker.isOpen()).toBe(true);

      // Fast-forward cool-down period
      jest.advanceTimersByTime(2_000);

      // Next attempt → closed, succeeds
      await expect(breaker.exec(successFn)).resolves.toBe('✅ healthy');
      expect(breaker.isOpen()).toBe(false);

      jest.useRealTimers();
    });
  });

  /***********************************************************************
   * SlaPricingService
   **********************************************************************/
  describe('SlaPricingService', () => {
    const pricingConfig: SlaPricingConfig = {
      basePriceUsd: 0.001, // $0.001 per inference base
      tiers: [
        { priority: InferencePriority.High, multiplier: 3 },
        { priority: InferencePriority.Medium, multiplier: 2 },
        { priority: InferencePriority.Low, multiplier: 1 },
      ],
      volumeDiscounts: [
        {
          minQueries: 10_000,
          maxQueries: 49_999,
          percentOff: 5,
        },
        {
          minQueries: 50_000,
          maxQueries: 99_999,
          percentOff: 10,
        },
        {
          minQueries: 100_000,
          maxQueries: Infinity,
          percentOff: 15,
        },
      ],
    };

    const service = new SlaPricingService(pricingConfig);

    it('calculates per-inference price with priority multiplier', () => {
      const price = service.unitPrice(InferencePriority.High);
      expect(price).toBeCloseTo(0.003); // 0.001 × 3
    });

    it('applies volume discounts cumulatively', () => {
      const total = service.totalPrice({
        priority: InferencePriority.Medium,
        queries: 60_000,
      });

      // Base price: 0.001 × 2 = 0.002 per inference
      // Raw cost:   60_000 × 0.002 = 120
      // Discount:   10 %   => 108
      expect(total).toBeCloseTo(108);
    });

    it('throws when an unsupported priority is supplied', () => {
      // @ts-expect-error – passing an unsupported Enum value should explode
      expect(() => service.unitPrice('ULTRA_HIGH')).toThrowError(
        /Unsupported priority/i,
      );
    });
  });
});
```