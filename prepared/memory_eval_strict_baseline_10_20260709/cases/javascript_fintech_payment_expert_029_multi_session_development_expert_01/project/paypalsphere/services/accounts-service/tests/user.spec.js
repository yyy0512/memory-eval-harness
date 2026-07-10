```javascript
/**
 * @file paypalsphere/services/accounts-service/tests/user.spec.js
 *
 * End-to-end & contract tests for the Accounts-Service user flow.
 * The suite spins up an in-memory MongoDB instance, hits the real
 * HTTP layer through supertest, and mocks the EventBus so that we
 * can assert CQRS / event-sourcing boundaries without touching the
 * actual broker (Kafka, NATS, RabbitMQ, etc.).
 *
 * Why contract tests?
 * ‑ Accounts-Service is consumed by multiple bounded contexts
 *   (KYC, Risk, Social-Graph, Notification). Any breaking change
 *   in the API or the domain events must pop up here first.
 */

const request                = require('supertest');
const mongoose               = require('mongoose');
const { MongoMemoryServer }  = require('mongodb-memory-server');
const uuid                   = require('uuid').v4;

// NOTE: Path starts at the service root (`services/accounts-service`)
const app = require('../src/app'); // The real Express app

/**
 * The EventBus is mocked at the module boundary so all internal imports
 * inside the service still resolve to the singleton mock, giving us full
 * visibility of publish/subscribe calls without relying on the network.
 */
jest.mock('../src/infrastructure/event-bus', () => ({
  publish   : jest.fn(),
  subscribe : jest.fn()
}));

const EventBus = require('../src/infrastructure/event-bus');

let mongo;

/**
 * Global test fixtures -------------------------------------------------------
 */
beforeAll(async () => {
  /**
   * Spin up an ephemeral, in-memory MongoDB. This keeps the test suite
   * hermetic and lightning-fast while exercising real persistence logic.
   */
  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();

  await mongoose.connect(mongoUri, {
    useNewUrlParser    : true,
    useUnifiedTopology : true
  });
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongo.stop();
});

beforeEach(async () => {
  // Clean DB collections between tests for full isolation
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map(col => col.deleteMany({})));

  // Reset EventBus mocks
  jest.clearAllMocks();
});

/**
 * Helper: fabricate a fully-formed user payload
 */
function buildUserPayload (overrides = {}) {
  return {
    firstName : 'Jane',
    lastName  : 'Doe',
    email     : `jane.${uuid()}@paypalsphere.dev`,
    phone     : '+12025550123',
    address   : {
      line1   : '1 Hacker Way',
      city    : 'Menlo Park',
      state   : 'CA',
      zip     : '94025',
      country : 'US'
    },
    ...overrides
  };
}

/**
 * ----------------------------------------------------------------------------
 *                                Test Suites
 * ----------------------------------------------------------------------------
 */
describe('Accounts-Service – User API', () => {

  it('POST /v1/accounts → 201 Created + emits AccountCreated event', async () => {
    const payload = buildUserPayload();

    const { statusCode, body } = await request(app)
      .post('/v1/accounts')
      .send(payload)
      .set('Accept', 'application/json');

    expect(statusCode).toBe(201);
    expect(body).toMatchObject({
      id        : expect.any(String),
      firstName : payload.firstName,
      lastName  : payload.lastName,
      email     : payload.email
    });

    // Event-sourcing / CQRS boundary
    expect(EventBus.publish).toHaveBeenCalledWith('AccountCreated', expect.objectContaining({
      aggregateId : body.id,
      data        : expect.objectContaining({ email: payload.email })
    }));
  });

  it('GET /v1/accounts/:id → 200 OK returns persisted user', async () => {
    const payload = buildUserPayload();

    const createRes = await request(app).post('/v1/accounts').send(payload);
    const { id } = createRes.body;

    const { statusCode, body } = await request(app).get(`/v1/accounts/${id}`);

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      id,
      email : payload.email
    });
  });

  it('POST /v1/accounts → 409 Conflict on duplicate e-mail', async () => {
    const payload = buildUserPayload();

    // First creation succeeds
    await request(app).post('/v1/accounts').send(payload).expect(201);

    // Second attempt with same email should fail
    const { statusCode, body } = await request(app)
      .post('/v1/accounts')
      .send(payload);

    expect(statusCode).toBe(409);
    expect(body).toMatchObject({
      error   : 'DuplicateResource',
      message : expect.stringMatching(/email.*already exists/i)
    });

    // Only one AccountCreated event is expected
    expect(EventBus.publish).toHaveBeenCalledTimes(1);
  });

  it('POST /v1/accounts (risk country) → 202 Accepted + triggers KYC flow', async () => {
    const payload = buildUserPayload({
      address : { ...buildUserPayload().address, country: 'IR' } // Example high-risk country
    });

    const { statusCode, body } = await request(app)
      .post('/v1/accounts')
      .send(payload);

    expect(statusCode).toBe(202);
    expect(body).toHaveProperty('kycStatus', 'pending');

    // The service must orchestrate downstream KYC saga
    expect(EventBus.publish).toHaveBeenCalledWith('KYCCheckRequested', expect.objectContaining({
      aggregateId : body.id,
      data        : expect.objectContaining({ country: 'IR' })
    }));
  });

  it('PUT /v1/accounts/:id/profile-picture → 200 OK + event', async () => {
    const payload = buildUserPayload();
    const createRes = await request(app).post('/v1/accounts').send(payload);
    const { id } = createRes.body;

    const { statusCode } = await request(app)
      .put(`/v1/accounts/${id}/profile-picture`)
      .attach('image', Buffer.from('fake-img-bytes'), 'avatar.png');

    expect(statusCode).toBe(200);

    expect(EventBus.publish).toHaveBeenCalledWith('ProfilePictureUpdated', expect.objectContaining({
      aggregateId : id,
      data        : { contentType: 'image/png' }
    }));
  });

});
```