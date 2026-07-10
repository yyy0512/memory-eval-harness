```javascript
/**
 * verification.spec.js
 *
 * End-to-end & unit hybrid test-suite for KYC Verification flows.
 * ‑ Uses supertest for HTTP assertions against the local Express instance
 * ‑ Uses nock for mocking outbound calls to the external KYC provider
 * ‑ Spies on the DomainEventEmitter to ensure correct CQRS messaging
 *
 * NOTE:
 *  - The tests assume the KYC Service exposes an initTestApp() helper that
 *    boots the Express instance with in-memory dependencies wired-up.
 *  - DomainEventEmitter is mocked to isolate the service from the real broker.
 *  - Jest’s default timeout is increased because KYC flows can be slow.
 */

process.env.NODE_ENV = 'test';

const request             = require('supertest');
const nock                = require('nock');
const { v4: uuid }        = require('uuid');
const { advanceTo, clear } = require('jest-date-mock');

jest.setTimeout(20_000); // allow up to 20s per test, KYC can be chatty

/***********************************************************************
 * Mock Domain Event Emitter so that we can assert published events
 **********************************************************************/
jest.mock('../../src/events/DomainEventEmitter', () => ({
  DomainEventEmitter: {
    emit : jest.fn(),
    once : jest.fn(),
    on   : jest.fn()
  }
}));
const { DomainEventEmitter } = require('../../src/events/DomainEventEmitter');

/***********************************************************************
 * Spin-up the in-memory Express application
 **********************************************************************/
let app;
beforeAll(async () => {
  // The KYC service exposes this helper exclusively for test-suites.
  // It wires repositories against an in-mem SQLite DB and stubs
  // message brokers so we can run isolated.
  ({ app } = await require('../../src/app').initTestApp());
});

afterAll(async () => {
  await require('../../src/app').shutdown(); // graceful close: DB / queues
  jest.clearAllMocks();
  nock.cleanAll();
  clear();
});

/***********************************************************************
 * Helper(s)
 **********************************************************************/
const mockKycProviderSuccess = (userId, providerRequestBody = {}) => {
  return nock('https://provider.kyc.com')
    .post('/verify', body => body.userId === userId)
    .reply(200, {
      referenceId : uuid(),
      status      : 'VERIFIED',
      ...providerRequestBody
    });
};

const mockKycProviderFailure = userId => {
  return nock('https://provider.kyc.com')
    .post('/verify', body => body.userId === userId)
    .reply(422, { code: 'DOCUMENT_MISMATCH', message: 'Document failed validation' });
};

/***********************************************************************
 * Test-cases
 **********************************************************************/
describe('KYC ‑ Verification Endpoint', () => {
  describe('POST /api/kyc/verify', () => {
    it('successfully verifies a user and publishes KYC_VERIFIED event', async () => {
      // Arrange
      const userId = uuid();
      const payload = {
        userId,
        firstName     : 'Ada',
        lastName      : 'Lovelace',
        documentType  : 'PASSPORT',
        documentNumber: 'AA1234567',
        countryCode   : 'GB'
      };

      const provider = mockKycProviderSuccess(userId);

      // Act
      const res = await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect('Content-Type', /json/)
        .expect(200);

      // Assert – HTTP response
      expect(res.body).toEqual(
        expect.objectContaining({
          userId,
          status: 'VERIFIED',
          provider: 'THIRD_PARTY_1'
        })
      );

      // Assert – outbound provider call happened
      expect(provider.isDone()).toBe(true);

      // Assert – correct event emitted
      expect(DomainEventEmitter.emit).toHaveBeenCalledWith(
        'KYC_VERIFIED',
        expect.objectContaining({
          userId,
          status      : 'VERIFIED',
          referenceId : expect.any(String)
        })
      );
    });

    it('fails verification with validation error and emits KYC_FAILED event', async () => {
      // Arrange
      const userId = uuid();
      const payload = {
        userId,
        firstName     : 'Grace',
        lastName      : 'Hopper',
        documentType  : 'NATIONAL_ID',
        documentNumber: 'ZZ999999',
        countryCode   : 'US'
      };

      const provider = mockKycProviderFailure(userId);

      // Act
      const res = await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect('Content-Type', /json/)
        .expect(422);

      // Assert – HTTP response
      expect(res.body).toEqual(
        expect.objectContaining({
          error      : 'DOCUMENT_MISMATCH',
          statusCode : 422
        })
      );

      // Provider was contacted
      expect(provider.isDone()).toBe(true);

      // Event emission
      expect(DomainEventEmitter.emit).toHaveBeenCalledWith(
        'KYC_FAILED',
        expect.objectContaining({
          userId,
          reason: 'DOCUMENT_MISMATCH'
        })
      );
    });

    it('is idempotent – repeat verification returns stored result without re-calling provider', async () => {
      // Arrange
      const userId  = uuid();
      const payload = {
        userId,
        firstName     : 'Satoshi',
        lastName      : 'Nakamoto',
        documentType  : 'DRIVERS_LICENSE',
        documentNumber: 'DL555666777',
        countryCode   : 'JP'
      };

      const provider = mockKycProviderSuccess(userId);

      // First attempt
      await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect(200);

      // Second attempt – should NOT hit provider again
      const res = await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect(200);

      expect(res.body).toHaveProperty('status', 'VERIFIED');
      expect(provider.isDone()).toBe(true); // only initial call

      // Provider interception registry has exactly 1 match
      expect(nock.pendingMocks().length).toBe(0);
    });

    it('gracefully degrades when provider is unreachable', async () => {
      // Arrange
      const userId  = uuid();
      const payload = {
        userId,
        firstName    : 'Linus',
        lastName     : 'Torvalds',
        documentType : 'PASSPORT',
        documentNumber: 'AA7654321',
        countryCode  : 'FI'
      };

      // Simulate connection timeout (ECONNREFUSED)
      nock('https://provider.kyc.com')
        .post('/verify')
        .replyWithError({ code: 'ECONNREFUSED' });

      // Act
      const res = await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect(503);

      // Assert
      expect(res.body).toEqual(
        expect.objectContaining({
          error     : 'PROVIDER_UNAVAILABLE',
          statusCode: 503
        })
      );

      // Event emission
      expect(DomainEventEmitter.emit).toHaveBeenCalledWith(
        'KYC_PROVIDER_UNAVAILABLE',
        expect.objectContaining({ userId })
      );
    });

    it('handles concurrency – parallel requests trigger only one upstream call', async () => {
      // Arrange
      const userId  = uuid();
      const payload = {
        userId,
        firstName     : 'Alan',
        lastName      : 'Turing',
        documentType  : 'PASSPORT',
        documentNumber: 'AT1001001',
        countryCode   : 'GB'
      };

      const provider = mockKycProviderSuccess(userId);

      // Act – fire 10 parallel requests
      const results = await Promise.all(
        new Array(10).fill(null).map(() =>
          request(app)
            .post('/api/kyc/verify')
            .send(payload)
            .set('x-correlation-id', uuid())
        )
      );

      // Assert every response is successful
      results.forEach(r => {
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('VERIFIED');
      });

      // Provider should have been hit exactly once
      expect(provider.isDone()).toBe(true);

      // Event emitter should publish only once as well
      const emitCount = DomainEventEmitter.emit.mock.calls
        .filter(([eventName]) => eventName === 'KYC_VERIFIED').length;
      expect(emitCount).toBe(1);
    });

    it('records verification timestamp deterministically for audit trail', async () => {
      // Arrange – freeze time
      const frozenDate = new Date('2030-01-10T13:37:42Z');
      advanceTo(frozenDate);

      const userId  = uuid();
      const payload = {
        userId,
        firstName     : 'Katherine',
        lastName      : 'Johnson',
        documentType  : 'PASSPORT',
        documentNumber: 'KJ202020',
        countryCode   : 'US'
      };

      const provider = mockKycProviderSuccess(userId);

      // Act
      const { body } = await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect(200);

      // Assert – timestamp equals frozenDate
      expect(body.verifiedAt).toBe(frozenDate.toISOString());
      expect(provider.isDone()).toBe(true);
    });
  });

  describe('GET /api/kyc/:userId/status', () => {
    it('returns 404 for unknown user', () =>
      request(app)
        .get(`/api/kyc/${uuid()}/status`)
        .set('x-correlation-id', uuid())
        .expect(404)
    );

    it('returns current verification status for an existing user', async () => {
      // Arrange
      const userId  = uuid();
      const payload = {
        userId,
        firstName     : 'Margaret',
        lastName      : 'Hamilton',
        documentType  : 'PASSPORT',
        documentNumber: 'MH000111',
        countryCode   : 'US'
      };

      mockKycProviderSuccess(userId);

      // First verify
      await request(app)
        .post('/api/kyc/verify')
        .send(payload)
        .set('x-correlation-id', uuid())
        .expect(200);

      // Act – fetch status
      const res = await request(app)
        .get(`/api/kyc/${userId}/status`)
        .set('x-correlation-id', uuid())
        .expect(200);

      // Assert
      expect(res.body).toEqual({
        userId,
        status     : 'VERIFIED',
        verifiedAt : expect.any(String)
      });
    });
  });
});
```