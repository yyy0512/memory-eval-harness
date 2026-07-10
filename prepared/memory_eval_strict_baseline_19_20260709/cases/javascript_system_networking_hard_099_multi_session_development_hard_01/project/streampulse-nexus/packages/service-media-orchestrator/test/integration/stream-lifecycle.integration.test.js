```javascript
/**
 * Integration tests for StreamPulse Media Orchestrator stream-lifecycle.
 *
 * These tests spin up a real instance of the orchestrator CLI (built from the
 * local workspace), exercise its public API, listen to its event stream, and
 * assert that a stream can be created, scaled, recovered from a simulated node
 * failure, and cleanly terminated.
 *
 * NOTE: The orchestrator process is spawned once for the entire test-suite to
 * keep runtime down. A random, free port is chosen for each run to avoid
 * collisions when multiple CI jobs run in parallel.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import tcpPortUsed from 'tcp-port-used';
import axios from 'axios';
import EventSource from 'eventsource';
import { v4 as uuid } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

jest.setTimeout(120_000); // allow plenty of time for e2e orchestration

/***********************************************************************
 * Test-helpers
 ***********************************************************************/

/**
 * Wait for a specific event envelope to arrive on an EventSource stream.
 * The predicate receives the JSON-parsed data object.  If the predicate
 * returns true the promise resolves with that payload.
 */
const waitForEvent = (es, predicate, timeout = 30_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      es.close();
      /* eslint-disable prefer-promise-reject-errors */
      reject(
        new Error(
          `Timed out after ${timeout} ms while waiting for orchestrator event.`,
        ),
      );
    }, timeout);

    es.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (predicate(data)) {
          clearTimeout(timer);
          es.close();
          resolve(data);
        }
      } catch (err) {
        // ignore JSON parse errors from unrelated debug chatter
      }
    });

    es.addEventListener('error', (err) => {
      clearTimeout(timer);
      es.close();
      reject(err);
    });
  });

/**
 * Randomly chooses a free port by opening and closing a socket until one
 * becomes available.  (tcp-port-used util handles polling.)
 */
async function getFreePort(startPort = 32_000, endPort = 65_535) {
  let port = startPort + Math.floor(Math.random() * (endPort - startPort));
  // eslint-disable-next-line no-await-in-loop
  while (await tcpPortUsed.check(port)) port += 1;
  return port;
}

/**
 * Spawns the orchestrator CLI and waits until health-check passes.
 */
async function bootOrchestrator({ binPath, env }) {
  const port = await getFreePort();

  const proc = spawn('node', [binPath, '--port', port, '--log-level', 'warn'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, PORT: `${port}` },
  });

  const readyRegex = /Service\sready\s+🚀/; // orchestrator prints this when healthy
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  const stderrBuffer = [];
  const stdoutBuffer = [];

  proc.stdout.on('data', (chunk) => stdoutBuffer.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => stderrBuffer.push(chunk.toString()));

  // Wait until port becomes reachable or process exits abnormally
  const HEALTH_TIMEOUT = 20_000;
  const deadline = Date.now() + HEALTH_TIMEOUT;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    /* eslint-disable no-await-in-loop */
    if (Date.now() > deadline) {
      proc.kill('SIGTERM');
      throw new Error(
        `Timed out waiting for orchestrator to start. Logs:\n${stdoutBuffer.join(
          '',
        )}\n${stderrBuffer.join('')}`,
      );
    }

    if (proc.exitCode !== null) {
      throw new Error(
        `Orchestrator exited early with code ${proc.exitCode}\nSTDOUT:\n${stdoutBuffer.join(
          '',
        )}\nSTDERR:\n${stderrBuffer.join('')}`,
      );
    }

    if (stdoutBuffer.some((l) => readyRegex.test(l))) break;
    // Poll for port open as an additional guarantee
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }

  const baseURL = `http://127.0.0.1:${port}`;
  const api = axios.create({ baseURL, timeout: 10_000 });

  return {
    proc,
    port,
    api,
    logs() {
      return stdoutBuffer.join('') + stderrBuffer.join('');
    },
    async shutdown() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        await once(proc, 'exit');
      }
    },
  };
}

/***********************************************************************
 * Global setup/teardown
 ***********************************************************************/

let orchestrator;
let api; // axios-instance
let baseURL;

beforeAll(async () => {
  const binPath = path.resolve(
    __dirname,
    '..',
    '..',
    'dist',
    'service-media-orchestrator',
    'cli.js',
  );

  orchestrator = await bootOrchestrator({
    binPath,
    env: { NODE_ENV: 'test' },
  });
  api = orchestrator.api;
  baseURL = api.defaults.baseURL;
});

afterAll(async () => {
  await orchestrator.shutdown();
});

/***********************************************************************
 * Happy path lifecycle test
 ***********************************************************************/

describe('Stream lifecycle (happy path)', () => {
  let streamId;
  let es;

  afterEach(() => {
    if (es && es.readyState === EventSource.OPEN) es.close();
  });

  test('should create, scale, recover and terminate a stream', async () => {
    /**
     * 1. Create stream
     */
    const createPayload = {
      title: 'Integration Test Stream',
      ingestUrl: `rtmp://test-ingest/${crypto.randomBytes(6).toString('hex')}`,
      metadata: { tournamentId: uuid() },
    };

    const { data: createResp } = await api.post('/v1/streams', createPayload);
    expect(createResp).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        state: 'PENDING',
        createdAt: expect.any(String),
      }),
    );

    streamId = createResp.id;

    /**
     * 2. Observe event flow until live
     */
    es = new EventSource(`${baseURL}/v1/streams/${streamId}/events`);
    const liveEvt = await waitForEvent(
      es,
      (evt) => evt.type === 'STREAM_LIVE',
      25_000,
    );
    expect(liveEvt).toEqual(
      expect.objectContaining({
        type: 'STREAM_LIVE',
        payload: expect.objectContaining({
          id: streamId,
          currentReplicas: 2, // default autostart worker pair
        }),
      }),
    );

    /**
     * 3. Scale up
     */
    const newReplicaCount = 4;
    await api.patch(`/v1/streams/${streamId}/scale`, {
      replicas: newReplicaCount,
    });

    const scaledEvt = await waitForEvent(
      es,
      (evt) =>
        evt.type === 'STREAM_SCALED' &&
        evt.payload.replicas === newReplicaCount,
      20_000,
    );

    expect(scaledEvt.payload.replicas).toBe(newReplicaCount);

    /**
     * 4. Simulate a node failure & auto-recovery
     *
     * The orchestrator exposes an internal endpoint solely for testing.
     */
    await api.post(`/v1/streams/${streamId}/_simulateFailure`, {
      workerIndex: 1,
    });

    const recoveredEvt = await waitForEvent(
      es,
      (evt) => evt.type === 'WORKER_RECOVERED',
      30_000,
    );

    expect(recoveredEvt.payload).toEqual(
      expect.objectContaining({
        streamId,
        workerId: expect.any(String),
        strategy: 'auto-heal',
      }),
    );

    /**
     * 5. Terminate
     */
    await api.delete(`/v1/streams/${streamId}`);

    const terminatedEvt = await waitForEvent(
      es,
      (evt) => evt.type === 'STREAM_TERMINATED',
      15_000,
    );

    expect(terminatedEvt.payload.state).toBe('TERMINATED');
  });
});

/***********************************************************************
 * Error path: ensure duplicate stream titles are rejected
 ***********************************************************************/

describe('Validation / duplicate titles', () => {
  const title = `dup-test-${Date.now()}`;

  afterAll(async () => {
    // Clean up by deleting any lingering streams with this title
    const { data } = await api.get('/v1/streams', {
      params: { title },
    });
    await Promise.all(
      data.results.map((s) => api.delete(`/v1/streams/${s.id}`)),
    );
  });

  test('should return 409 CONFLICT when duplicate title is posted', async () => {
    await api.post('/v1/streams', {
      title,
      ingestUrl: `rtmp://dup/${uuid()}`,
    });

    await expect(
      api.post('/v1/streams', {
        title,
        ingestUrl: `rtmp://dup/${uuid()}`,
      }),
    ).rejects.toHaveProperty('response.status', 409);
  });
});

/***********************************************************************
 * Smoke-test: orchestrator health endpoint
 ***********************************************************************/

describe('Service health', () => {
  test('GET /health returns OK', async () => {
    const { data } = await api.get('/health');
    expect(data).toEqual({ status: 'ok' });
  });
});
```