```javascript
/**
 * @file chain_of_responsibility.test.js
 *
 * Unit-tests that validate a classical Chain-of-Responsibility (CoR) flow
 * used in the “disaster-recovery” sub-system of the StreamPulse Nexus
 * media-orchestrator service.  The tests do not rely on the real
 * production chain implementation that lives in `src/` so they remain
 * completely self-contained and runnable in isolation (CI environments
 * often execute the test-suite before compiling other packages).
 *
 * The tests spin-up an in-memory chain composed of three recovery
 * handlers:
 *   – IntegrityCheckHandler      (disk / footage validation)
 *   – CapacityFailoverHandler    (cluster capacity balancing)
 *   – GeoRedundancyHandler       (cross-region fail-over)
 *
 * Each handler decides—based on the incoming RecoveryCommand—whether it
 * can handle the request.  If the command is not relevant the handler
 * passes it down the chain.  When no handler can process the command, an
 * `UnhandledRecoveryCommandError` is raised.
 *
 * Scenarios covered:
 *   1. Happy-path where first handler handles the request.
 *   2. Propagation down the chain until a later handler handles.
 *   3. Entire chain declines resulting in a well-defined error.
 *   4. Handler failure bubbles up (propagated rejection).
 *   5. Asynchronous handling (handlers may return promises).
 */

const { randomUUID } = require('crypto');

/* -------------------------------------------------------------------------- */
/* Helper abstractions (local mini-CoR implementation)                        */
/* -------------------------------------------------------------------------- */

class UnhandledRecoveryCommandError extends Error {
  constructor(command) {
    super(`No handler could process recovery command "${command.type}".`);
    this.name = 'UnhandledRecoveryCommandError';
    this.command = command;
  }
}

/**
 * Base class for all recovery handlers in the chain.
 *
 * Concrete handlers only need to implement:
 *   – canHandle(command): boolean
 *   – process(command):  Promise<any>|any   (returns a result or throws)
 */
class RecoveryHandler {
  #next; // private reference to next handler

  setNext(handler) {
    if (handler === this) {
      throw new Error('A handler cannot set itself as next.');
    }
    this.#next = handler;
    return handler; // allow fluent API
  }

  /**
   * Public entry for executing the chain.
   * @param {RecoveryCommand} command
   */
  async handle(command) {
    if (this.canHandle(command)) {
      return this.process(command); // May throw / return promise
    }

    if (this.#next) {
      return this.#next.handle(command);
    }

    throw new UnhandledRecoveryCommandError(command);
  }

  // --- abstract methods (to be overridden) -------------------------------
  /* eslint-disable class-methods-use-this */
  canHandle() {
    throw new Error('canHandle() must be implemented by subclass.');
  }
  process() {
    throw new Error('process() must be implemented by subclass.');
  }
  /* eslint-enable class-methods-use-this */
}

/* -------------------------------------------------------------------------- */
/* Mock / sample concrete handlers                                            */
/* -------------------------------------------------------------------------- */

/**
 * Command DTO used by tests.
 * @typedef {Object} RecoveryCommand
 * @property {string} id    – Correlation id
 * @property {string} type  – Command type: INTEGRITY_CHECK | CAPACITY_FAILOVER | GEO_REDUNDANCY
 */

class IntegrityCheckHandler extends RecoveryHandler {
  canHandle(cmd) {
    return cmd.type === 'INTEGRITY_CHECK';
  }
  async process(cmd) {
    return {
      handler: this.constructor.name,
      result: `Footage integrity verified for command ${cmd.id}`,
    };
  }
}

class CapacityFailoverHandler extends RecoveryHandler {
  canHandle(cmd) {
    return cmd.type === 'CAPACITY_FAILOVER';
  }
  async process(cmd) {
    return {
      handler: this.constructor.name,
      result: `Traffic re-balanced across cluster for command ${cmd.id}`,
    };
  }
}

class GeoRedundancyHandler extends RecoveryHandler {
  canHandle(cmd) {
    return cmd.type === 'GEO_REDUNDANCY';
  }
  async process(cmd) {
    return {
      handler: this.constructor.name,
      result: `Fail-over to secondary region completed for command ${cmd.id}`,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Jest tests                                                                 */
/* -------------------------------------------------------------------------- */

describe('Chain-of-Responsibility: Disaster Recovery', () => {
  let chainRoot;

  beforeEach(() => {
    // Build chain: Integrity ➜ Capacity ➜ Geo
    const integrity   = new IntegrityCheckHandler();
    const capacity    = new CapacityFailoverHandler();
    const geoRedundancy = new GeoRedundancyHandler();

    integrity.setNext(capacity).setNext(geoRedundancy);
    chainRoot = integrity;
  });

  test('first handler processes command and short-circuits chain', async () => {
    const command = { id: randomUUID(), type: 'INTEGRITY_CHECK' };
    const spyIntegrity  = jest.spyOn(IntegrityCheckHandler.prototype, 'process');
    const spyCapacity   = jest.spyOn(CapacityFailoverHandler.prototype, 'process');
    const spyGeo        = jest.spyOn(GeoRedundancyHandler.prototype, 'process');

    const response = await chainRoot.handle(command);

    expect(response.handler).toBe('IntegrityCheckHandler');
    expect(spyIntegrity).toHaveBeenCalledTimes(1);
    expect(spyCapacity).not.toHaveBeenCalled();
    expect(spyGeo).not.toHaveBeenCalled();

    // Clean up spies to avoid leaks between tests
    jest.restoreAllMocks();
  });

  test('request flows until appropriate handler is found', async () => {
    const command = { id: randomUUID(), type: 'GEO_REDUNDANCY' };
    const spyGeo  = jest.spyOn(GeoRedundancyHandler.prototype, 'process');

    const response = await chainRoot.handle(command);

    expect(response.handler).toBe('GeoRedundancyHandler');
    expect(spyGeo).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  test('unhandled command results in custom error', async () => {
    const command = { id: randomUUID(), type: 'UNSUPPORTED_TYPE' };

    await expect(chainRoot.handle(command)).rejects.toThrow(UnhandledRecoveryCommandError);
  });

  test('handler processing error bubbles up as rejection', async () => {
    const command = { id: randomUUID(), type: 'CAPACITY_FAILOVER' };
    const errorMsg = 'Cluster API timeout';

    // Force CapacityFailoverHandler to throw
    jest.spyOn(CapacityFailoverHandler.prototype, 'process')
      .mockImplementation(() => {
        throw new Error(errorMsg);
      });

    await expect(chainRoot.handle(command)).rejects.toThrow(errorMsg);

    jest.restoreAllMocks();
  });

  test('handlers may operate asynchronously (promise resolves)', async () => {
    const command = { id: randomUUID(), type: 'CAPACITY_FAILOVER' };

    // Turn process into delayed promise
    jest.spyOn(CapacityFailoverHandler.prototype, 'process')
      .mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve({ handler: 'CapacityFailoverHandler', async: true }), 30);
      }));

    const result = await chainRoot.handle(command);
    expect(result).toEqual({ handler: 'CapacityFailoverHandler', async: true });

    jest.restoreAllMocks();
  });
});
```