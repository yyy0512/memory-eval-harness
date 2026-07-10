```javascript
/*  paypalsphere/services/risk-service/tests/risk-scorer.spec.js
 *
 *  Unit-tests for RiskScorer — the main orchestration layer that aggregates
 *  KYC status, velocity analysis, device fingerprinting, and third-party
 *  fraud signals into a single risk score.  All network / I/O boundaries are
 *  mocked so the suite can run deterministically and without side-effects.
 */

import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import { faker } from '@faker-js/faker';
import RiskScorer from '../src/risk-scorer.js'; // ← Subject Under Test

//--------------------------------------------------------------------------
// Jest mocks for collaborators
//--------------------------------------------------------------------------

// External KYC verification micro-service client
jest.mock('../src/clients/kyc-client.js', () => ({
  getKYCStatus: jest.fn(),
}));

// Transaction velocity tracker
jest.mock('../src/analytics/velocity-tracker.js', () => ({
  getUserVelocity: jest.fn(),
}));

// Device fingerprint risk engine
jest.mock('../src/analytics/device-risk.js', () => ({
  evaluateDevice: jest.fn(),
}));

// Third-party fraud provider
jest.mock('../src/providers/fraud-provider.js', () => ({
  scoreTransaction: jest.fn(),
}));

// Event bus for publishing risk events
jest.mock('../src/event-bus.js', () => new EventEmitter());

//--------------------------------------------------------------------------
// Import mocked modules AFTER they have been mocked
//--------------------------------------------------------------------------
import kycClient from '../src/clients/kyc-client.js';
import velocityTracker from '../src/analytics/velocity-tracker.js';
import deviceRisk from '../src/analytics/device-risk.js';
import fraudProvider from '../src/providers/fraud-provider.js';
import eventBus from '../src/event-bus.js';

//--------------------------------------------------------------------------
// Shared test constants
//--------------------------------------------------------------------------
const LOW_RISK_THRESHOLD  = 300;  // arbitrary risk threshold values
const HIGH_RISK_THRESHOLD = 700;

// Utility to create a canonical transaction DTO for tests
const buildTx = (overrides = {}) => ({
  id: uuid(),
  userId: uuid(),
  amount: faker.number.float({ min: 1, max: 10_000, precision: 0.01 }),
  currency: 'USD',
  ip: faker.internet.ip(),
  deviceId: faker.string.uuid(),
  geo: {
    country: faker.location.countryCode(),
    lat: faker.location.latitude(),
    lon: faker.location.longitude(),
  },
  createdAt: new Date(),
  ...overrides,
});

//--------------------------------------------------------------------------
// Reset mocks before each test
//--------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  eventBus.removeAllListeners();
});

//--------------------------------------------------------------------------
// Test suite
//--------------------------------------------------------------------------
describe('RiskScorer', () => {
  it('returns a LOW risk score for verified users with healthy signals', async () => {
    // Arrange
    const tx = buildTx({ amount: 50 });

    kycClient.getKYCStatus.mockResolvedValue({ verified: true });
    velocityTracker.getUserVelocity.mockResolvedValue({ txPerHour: 1, total24h: 50 });
    deviceRisk.evaluateDevice.mockResolvedValue({ risk: 100 });
    fraudProvider.scoreTransaction.mockResolvedValue({ risk: 50 });

    // Act
    const score = await RiskScorer.score(tx);

    // Assert
    expect(score.value).toBeLessThan(LOW_RISK_THRESHOLD);
    expect(score.grade).toBe('LOW');
    // verify that dependencies have been called exactly once
    expect(kycClient.getKYCStatus).toHaveBeenCalledTimes(1);
    expect(velocityTracker.getUserVelocity).toHaveBeenCalledTimes(1);
    expect(deviceRisk.evaluateDevice).toHaveBeenCalledTimes(1);
    expect(fraudProvider.scoreTransaction).toHaveBeenCalledTimes(1);
  });

  it('flags HIGH risk score for unverified users with suspicious behaviour', async () => {
    // Arrange
    const tx = buildTx({ amount: 9_000, geo: { country: 'IR' } });

    kycClient.getKYCStatus.mockResolvedValue({ verified: false });
    velocityTracker.getUserVelocity.mockResolvedValue({ txPerHour: 9, total24h: 15_000 });
    deviceRisk.evaluateDevice.mockResolvedValue({ risk: 400 });
    fraudProvider.scoreTransaction.mockResolvedValue({ risk: 450 });

    // Listen to event bus
    const alertListener = jest.fn();
    eventBus.once('risk.alert', alertListener);

    // Act
    const score = await RiskScorer.score(tx);

    // Assert
    expect(score.value).toBeGreaterThan(HIGH_RISK_THRESHOLD);
    expect(score.grade).toBe('HIGH');
    expect(alertListener).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: tx.id,
        userId: tx.userId,
        riskScore: score.value,
      }),
    );
  });

  it('caches third-party calls for identical deterministic inputs within TTL', async () => {
    // Arrange
    const tx = buildTx();
    kycClient.getKYCStatus.mockResolvedValue({ verified: true });
    velocityTracker.getUserVelocity.mockResolvedValue({ txPerHour: 0 });
    deviceRisk.evaluateDevice.mockResolvedValue({ risk: 50 });
    fraudProvider.scoreTransaction.mockResolvedValue({ risk: 50 });

    // Act — issue two scores in quick succession
    const [first, second] = await Promise.all([RiskScorer.score(tx), RiskScorer.score(tx)]);

    // Assert
    expect(first.value).toEqual(second.value);
    expect(fraudProvider.scoreTransaction).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully when external provider errors and logs the anomaly', async () => {
    // Arrange
    const tx = buildTx();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    kycClient.getKYCStatus.mockResolvedValue({ verified: true });
    velocityTracker.getUserVelocity.mockResolvedValue({ txPerHour: 1, total24h: 100 });
    deviceRisk.evaluateDevice.mockResolvedValue({ risk: 100 });
    // Simulate provider outage
    const providerErr = new Error('503 Service Unavailable');
    fraudProvider.scoreTransaction.mockRejectedValue(providerErr);

    // Act
    const score = await RiskScorer.score(tx);

    // Assert
    expect(score.value).toBeGreaterThan(LOW_RISK_THRESHOLD); // degradation path yields slightly higher score
    expect(consoleSpy).toHaveBeenCalledWith(
      'RiskScorer: external provider failure',
      providerErr,
    );

    // Clean up
    consoleSpy.mockRestore();
  });

  it('throws validation error when mandatory attributes are missing', async () => {
    // Arrange
    const invalidTx = { amount: 100 }; // missing userId, etc.

    await expect(RiskScorer.score(invalidTx)).rejects.toThrow('InvalidTransactionPayload');
  });
});
```