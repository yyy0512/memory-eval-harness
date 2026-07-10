```javascript
/**
 * Integration test suite – CQRS happy-path and edge-case flows
 * ------------------------------------------------------------------
 * These tests spin up the real Transactions micro-service (HTTP layer +
 * command / query buses wired to an in-memory event store) and exercise
 * the full CQRS pipeline:
 *
 *   1. POST /command/transactions/create       →  TransactionCreated event
 *   2. GET  /query/transactions/:id            ←  Eventually consistent read model
 *   3. POST /command/transactions/:id/settle   →  TransactionSettled event
 *   4. GET  /query/transactions/:id            ←  Read model reflects settlement
 *
 * The test harness purposely waits for eventual consistency rather than
 * relying on synchronous responses, mirroring the behaviour of the live
 * system where projections are materialised asynchronously.
 *
 * NOTE: The underlying service uses an embedded, in-memory event store
 *       and a lightweight SQLite database when NODE_ENV === "test".
 */

'use strict';

/* ──────────────  External dependencies  ─────────────────────────── */
const request           = require('supertest');           // HTTP assertions
const waitForExpect     = require('wait-for-expect');     // Poll/wait helper
const uuid              = require('uuid').v4;             // Random IDs

/* ──────────────  Internal dependencies  ─────────────────────────── */
const createServer      = require('../../../src/server'); // Rest + CQRS bootstrap
const eventStore        = require('../../../src/lib/event-store'); // Direct event-store access

/* ──────────────  Constants & helpers  ─────────────────────────── */
const TEN_MS            = 10;
const TIMEOUT_MS        = 12_000;              // Upper bound for eventual consistency

/**
 * Wrap waitForExpect with service-level defaults.
 * @param {Function} assertionFn
 * @returns {Promise<void>}
 */
const eventually = (assertionFn) =>
  waitForExpect(assertionFn, TIMEOUT_MS, TEN_MS);

/* ──────────────  Test data fixtures  ─────────────────────────── */
const buildCreateCommand = (overrides = {}) => ({
  commandId      : uuid(),
  type           : 'CreateTransaction',
  payload        : {
    transactionId : uuid(),
    debitAccount  : 'user:alice',
    creditAccount : 'user:bob',
    amount        : 2750,          // in minor units (e.g. cents)
    currency      : 'USD',
    memo          : '🏖  Split hotel room',
    circleId      : 'circle:spring-break-2024',
    ...overrides,
  },
  metadata       : {
    userId  : 'user:alice',
    ip      : '127.0.0.1',
    traceId : uuid(),
  },
});

const buildSettleCommand = (transactionId) => ({
  commandId      : uuid(),
  type           : 'SettleTransaction',
  payload        : {
    transactionId,
    settlementTimestamp : new Date().toISOString(),
  },
  metadata       : {
    userId  : 'system-settlement-bot',
    traceId : uuid(),
  },
});

/* ──────────────  Test lifecycle  ─────────────────────────── */
let app;
let server;             // http.Server – Used to gracefully close sockets

beforeAll(async () => {
  // Boot the real application in test mode
  ({ app, server } = await createServer({ env: 'test' }));
});

afterAll(async () => {
  // Properly shut down http server & underlying infra
  await new Promise((resolve) => server.close(resolve));
  await eventStore.dispose(); // Flush and shutdown the in-memory store
});

/* ──────────────  Top-level test suite  ─────────────────────────── */
describe('Transactions Service – CQRS Flow', () => {
  jest.setTimeout(TIMEOUT_MS + 1_000); // Buffer margin

  test('CreateTransaction command is persisted and reflected in the read model', async () => {
    /* Arrange */
    const createCmd = buildCreateCommand();

    /* Act – fire the command over HTTP */
    const cmdRes = await request(app)
      .post('/command/transactions/create')
      .send(createCmd)
      .set('Idempotency-Key', createCmd.commandId)
      .expect(202);                      // Accepted for async processing

    /* Assert – command acknowledgement */
    expect(cmdRes.body).toEqual({
      status  : 'ACCEPTED',
      traceId : createCmd.metadata.traceId,
    });

    /* Assert – event is persisted in event store */
    const eventStream = await eventStore.readStream(createCmd.payload.transactionId);
    expect(eventStream).toHaveLength(1);
    expect(eventStream[0]).toMatchObject({
      type   : 'TransactionCreated',
      data   : expect.objectContaining({
        ...createCmd.payload,
        status : 'PENDING',
      }),
      meta   : expect.objectContaining({
        userId  : createCmd.metadata.userId,
      }),
    });

    /* Assert – read model is eventually consistent */
    await eventually(async () => {
      const queryRes = await request(app)
        .get(`/query/transactions/${createCmd.payload.transactionId}`)
        .expect(200);

      expect(queryRes.body).toMatchObject({
        transactionId : createCmd.payload.transactionId,
        debitAccount  : createCmd.payload.debitAccount,
        creditAccount : createCmd.payload.creditAccount,
        amount        : createCmd.payload.amount,
        currency      : createCmd.payload.currency,
        status        : 'PENDING',
      });
    });
  });

  test('Transaction can be settled and projection is updated', async () => {
    /* Arrange – first create a transaction */
    const createCmd  = buildCreateCommand();
    await request(app).post('/command/transactions/create').send(createCmd).expect(202);

    const settleCmd  = buildSettleCommand(createCmd.payload.transactionId);

    /* Act – send settlement command */
    await request(app)
      .post(`/command/transactions/${createCmd.payload.transactionId}/settle`)
      .send(settleCmd)
      .set('Idempotency-Key', settleCmd.commandId)
      .expect(202);

    /* Assert – two events exist for stream */
    await eventually(async () => {
      const events = await eventStore.readStream(createCmd.payload.transactionId);
      const types  = events.map(e => e.type);
      expect(types).toEqual(['TransactionCreated', 'TransactionSettled']);
    });

    /* Assert – read model reflects settlement */
    await eventually(async () => {
      const res = await request(app)
        .get(`/query/transactions/${createCmd.payload.transactionId}`)
        .expect(200);

      expect(res.body).toMatchObject({
        transactionId : createCmd.payload.transactionId,
        status        : 'SETTLED',
        settledAt     : expect.stringMatching(
          // ISO-8601 timestamp
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
        ),
      });
    });
  });

  test('Duplicate Idempotency-Key results in HTTP 409 (conflict)', async () => {
    /* Arrange */
    const cmd = buildCreateCommand();

    /* Act – first call succeeds */
    await request(app)
      .post('/command/transactions/create')
      .send(cmd)
      .set('Idempotency-Key', cmd.commandId)
      .expect(202);

    /* Act – replay exact same command */
    const dupRes = await request(app)
      .post('/command/transactions/create')
      .send(cmd) // identical payload & idempotency key
      .set('Idempotency-Key', cmd.commandId)
      .expect(409);

    /* Assert */
    expect(dupRes.body).toEqual({
      error   : 'IDEMPOTENCY_CONFLICT',
      message : 'Command with the same Idempotency-Key has already been processed.',
    });
  });
});
```