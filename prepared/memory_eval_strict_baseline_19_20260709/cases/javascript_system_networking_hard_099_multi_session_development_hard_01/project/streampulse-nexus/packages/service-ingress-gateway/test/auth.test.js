```javascript
/**
 * @file auth.test.js
 * @description
 *   High-level tests for the ingress–gateway authentication middleware.
 *   We spin up a miniature Express app wired with the actual middleware
 *   so that each test exercises the request life-cycle end-to-end.
 *
 *   These tests intentionally stub the underlying `jsonwebtoken` library
 *   to isolate gateway-level concerns (header parsing, error handling,
 *   RBAC glue-logic, etc.) from crypto correctness, which is verified in
 *   the jwt project itself.
 *
 *   All network listeners are started on ephemeral ports and torn down
 *   automatically, guaranteeing test parallelism and preventing port
 *   collisions in CI.
 */

import http from 'http';
import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

// ───────────────────────────────────────────────────────────────────────────────
// Under-test modules
// ───────────────────────────────────────────────────────────────────────────────
import authMiddleware from '../src/middleware/auth.js'; // path relative to test file

// ───────────────────────────────────────────────────────────────────────────────
// Mocks & stubs
// ───────────────────────────────────────────────────────────────────────────────
/**
 * We stub `jsonwebtoken.verify` so that we can deterministically trigger
 * specific branches (success, token-expired, malformed, etc.) without
 * dealing with real private/public keys or clock skew.
 */
jest.unstable_mockModule('jsonwebtoken', () => {
  return {
    __esModule: true,
    default: {
      // We expose the stub so that tests can mutate implementation per-case.
      verify: jest.fn()
    }
  };
});

// Re-import the mocked module so that TypeScript / ESM bindings resolve.
import jsonwebtoken from 'jsonwebtoken';

const { verify: verifyStub } = jsonwebtoken.default;

// ───────────────────────────────────────────────────────────────────────────────
// Test data
// ───────────────────────────────────────────────────────────────────────────────
const BASE_PAYLOAD = {
  sub: 'viewer|1337',
  iss: 'https://auth.streampulse.example',
  aud: 'streampulse-nexus',
  iat: Date.now() / 1000
};

// Fake tokens we just need any non-empty string to hit the code path.
const VALID_TOKEN = 'Bearer valid.jwt.token';
const INVALID_TOKEN = 'Bearer invalid.jwt.token';
const EXPIRED_TOKEN = 'Bearer expired.jwt.token';

// ───────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ───────────────────────────────────────────────────────────────────────────────
/**
 * Spins up a throw-away Express app with only the auth middleware enabled.
 * We expose a dummy '/ping' route that simply echoes `res.locals.user`
 * populated by the middleware.  This is enough to verify access control.
 */
const createTestServer = () => {
  const app = express();

  // Attach middleware under test
  app.use(authMiddleware());

  // Protected resource
  app.get('/ping', (req, res) => {
    res.status(200).json({
      alive: true,
      user: res.locals.user
    });
  });

  return http.createServer(app);
};

// ───────────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────────
describe('Ingress Gateway – auth middleware', () => {
  let server;

  beforeAll(done => {
    server = createTestServer().listen(0, done); // ephemeral port
  });

  afterAll(done => {
    server.close(done);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('allows request with a valid JWT', async () => {
    verifyStub.mockImplementation((_token, _pubKey, _opts, cb) =>
      cb(null, { ...BASE_PAYLOAD, role: 'viewer' })
    );

    const res = await request(server)
      .get('/ping')
      .set('Authorization', VALID_TOKEN)
      .expect(200);

    expect(res.body).toEqual({
      alive: true,
      user: expect.objectContaining({
        sub: 'viewer|1337',
        role: 'viewer'
      })
    });

    expect(verifyStub).toHaveBeenCalledTimes(1);
    expect(verifyStub.mock.calls[0][0]).toBe(VALID_TOKEN.split(' ')[1]); // token sans "Bearer"
  });

  test('rejects request with malformed/invalid JWT', async () => {
    verifyStub.mockImplementation((_token, _pubKey, _opts, cb) =>
      cb(new jsonwebtoken.default.JsonWebTokenError('invalid signature'))
    );

    const res = await request(server)
      .get('/ping')
      .set('Authorization', INVALID_TOKEN)
      .expect(401);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'UNAUTHENTICATED'
      })
    );

    expect(verifyStub).toHaveBeenCalledTimes(1);
  });

  test('rejects request when token is expired', async () => {
    verifyStub.mockImplementation((_token, _pubKey, _opts, cb) =>
      cb(new jsonwebtoken.default.TokenExpiredError('jwt expired', new Date()))
    );

    const res = await request(server)
      .get('/ping')
      .set('Authorization', EXPIRED_TOKEN)
      .expect(401);

    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'TOKEN_EXPIRED'
      })
    );

    expect(verifyStub).toHaveBeenCalledTimes(1);
  });

  test('rejects request missing Authorization header', async () => {
    const res = await request(server).get('/ping').expect(401);

    // verifyStub is never called because middleware bails early.
    expect(verifyStub).not.toHaveBeenCalled();
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  test('enforces RBAC – denies viewer on admin-only endpoint', async () => {
    // Same test server but with an admin-only route.
    const app = express();
    app.use(authMiddleware({ requiredRole: 'admin' }));
    app.get('/admin', (req, res) => res.status(200).send('secret'));

    const localServer = http.createServer(app);

    verifyStub.mockImplementation((_token, _pubKey, _opts, cb) =>
      cb(null, { ...BASE_PAYLOAD, role: 'viewer' })
    );

    await new Promise(resolve => localServer.listen(0, resolve));

    await request(localServer)
      .get('/admin')
      .set('Authorization', VALID_TOKEN)
      .expect(403);

    await new Promise(resolve => localServer.close(resolve));
  });
});
```