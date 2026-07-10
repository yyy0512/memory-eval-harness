```javascript
/**
 * StreamPulse Nexus – Transcoder Service
 * --------------------------------------
 * Entrypoint / Service orchestrator for the node-local transcoder runtime.
 *
 * Responsibilities:
 *  • Accept “transcode jobs” coming from the message-bus (NATS, Kafka etc.)
 *  • Select an appropriate strategy (CPU/GPU/Remote) for the job
 *  • Execute the job in a worker thread-pool
 *  • Expose health/metrics endpoints for the service mesh
 *  • Emit lifecycle events so that observability dashboards stay current
 *
 * NOTE: This file purposefully contains no direct I/O with the message-bus.
 *       Instead it exposes a programmatic API (`TranscoderService`) that is
 *       mounted by whichever adapter (HTTP, gRPC, NATS subscription…) the
 *       deployment chooses.
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────── */
/* External Deps                                                             */
/* ────────────────────────────────────────────────────────────────────────── */
const { EventEmitter }    = require('node:events');
const { cpus }            = require('node:os');
const { join }            = require('node:path');
const { existsSync }      = require('node:fs');
const { Worker }          = require('node:worker_threads');
const { v4: uuid }        = require('uuid');
const pTimeout            = require('p-timeout');          // Tiny promise wrapper
const merge               = require('lodash.merge');       // Deep merge helper
const pLimit              = require('p-limit');            // Concurrency limiter
const debug               = require('debug')('sp:transcoder');

/* ────────────────────────────────────────────────────────────────────────── */
/* Constants / Config                                                        */
/* ────────────────────────────────────────────────────────────────────────── */
const DEFAULT_OPTS = {
  /** Maximum concurrent jobs we allow locally (soft-cap). */
  concurrency        : Math.max(1, Math.floor(cpus().length / 2)),

  /** Hard fail a single segment/job after N milliseconds. */
  jobTimeoutMs       : 7 * 60 * 1_000, // 7-minutes – safe default for 4K

  /** Path where temp artefacts live (waveforms, chunked HLS etc.) */
  workspaceDir       : join(process.cwd(), '.transcoder-workspace'),

  /** Accepted input/container mime-types */
  acceptedContainers : [ 'video/mp4', 'video/quicktime', 'video/x-m4v', 'video/x-mkv', 'video/x-flv' ],

  /** Strategy preferences (ordered by priority, will fallback) */
  strategyPreference : [ 'gpu', 'cpu', 'remote' ]
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Error Helpers                                                             */
/* ────────────────────────────────────────────────────────────────────────── */
class TranscodeError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'TranscodeError';
    this.meta = meta;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Strategy Interfaces                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * @interface ITranscodeStrategy
 * @method canHandle(job)  -> boolean
 * @method execute(job)    -> Promise<TranscodeResult>
 */

/* CPU-bound FFmpeg strategy (fallback/default) */
class CpuStrategy {
  static id = 'cpu';

  constructor(opts) {
    this.opts = opts;
  }

  canHandle(/* job */) {
    // Always true, CPU transcoding is universal
    return true;
  }

  async execute(job) {
    // Offload real processing to worker so CPU stays available for event-loop
    return await runWorker(job, { mode: 'cpu' });
  }
}

/* GPU accelerated strategy (NVENC/QSV/VAAPI…) */
class GpuStrategy {
  static id = 'gpu';

  constructor(opts) {
    this.opts = opts;
    this._available = this._detectGpu();
  }

  _detectGpu() {
    // Extremely naive proof-of-concept – in real life we'd poll nvidia-smi etc.
    return process.env.SPN_GPU_ENABLED === 'true';
  }

  canHandle() {
    return this._available;
  }

  async execute(job) {
    return await runWorker(job, { mode: 'gpu' });
  }
}

/* Remote/off-box transcoding – ships job to another cluster */
class RemoteStrategy {
  static id = 'remote';

  constructor(opts) {
    this.opts = opts;
  }

  canHandle(/* job */) {
    // Always can, assumed infinite capacity (SLA managed by remote vendor)
    return true;
  }

  async execute(job) {
    // Simulate an RPC call w/ async HTTP
    const { default: ky } = await import('ky');
    const resp = await ky.post('https://transcode-api.streampulse.cloud/v1/jobs', {
      json: job
    }).json();
    return resp;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Worker Thread Handler                                                     */
/* ────────────────────────────────────────────────────────────────────────── */
/**
 * Spawns a worker that lives in its own thread. The worker isolates heavy
 * FFmpeg binaries so the main process can continue handling event loop work.
 *
 * All arguments must be structured-clone serialisable.
 */
function runWorker(job, execOpts = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'worker.js'), {
      workerData: { job, execOpts }
    });

    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new TranscodeError(`Worker exited with code ${code}`));
      }
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Transcoder Service                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Central service orchestrator that exposes a clean API and proxies every
 * event to the outside world via EventEmitter (Observer pattern).
 */
class TranscoderService extends EventEmitter {

  /**
   * @param {Partial<typeof DEFAULT_OPTS>} opts
   */
  constructor(opts = {}) {
    super();
    this.opts             = merge({}, DEFAULT_OPTS, opts);
    this._strategies      = this._initStrategies();
    this._pendingJobs     = new Map();          // jobId -> {promise, meta}
    this._limit           = pLimit(this.opts.concurrency);
    this._shutdownRef     = null;
    debug('Service instantiated %o', this.opts);
  }

  /* Register default + user-supplied strategies */
  _initStrategies() {
    const all = [
      new GpuStrategy(this.opts),
      new CpuStrategy(this.opts),
      new RemoteStrategy(this.opts)
    ];

    // Sort according to user preference
    const order = this.opts.strategyPreference;
    return all.sort((a, b) => order.indexOf(a.constructor.id) - order.indexOf(b.constructor.id));
  }

  /**
   * Submits a new transcode job.
   *
   * @param {object} job – Input/Output specs, desired rendition list etc.
   * @returns {Promise<TranscodeResult>}
   */
  async submit(job) {
    // Fast validation
    if (!job || !job.inputUri) {
      throw new TranscodeError('Job requires at least `inputUri`');
    }

    job.jobId = job.jobId ?? uuid();

    // Make sure we can handle the container/codec
    if (!this._isContainerAccepted(job)) {
      throw new TranscodeError(`Container ${job.mimeType} not accepted`, { jobId: job.jobId });
    }

    const strategy = this._selectStrategy(job);
    if (!strategy) {
      throw new TranscodeError('No available strategy could handle job', { jobId: job.jobId });
    }

    this.emit('job:received', { job });

    const promise = this._limit(() =>
      pTimeout(strategy.execute(job), this.opts.jobTimeoutMs)
    );

    // Track and notify
    this._pendingJobs.set(job.jobId, { promise, job });
    promise
      .then((result) => {
        this.emit('job:completed', { jobId: job.jobId, result });
        this._pendingJobs.delete(job.jobId);
      })
      .catch((err) => {
        this.emit('job:failed', { jobId: job.jobId, err });
        this._pendingJobs.delete(job.jobId);
      });

    return promise;
  }

  /**
   * Gracefully shuts down the service – no new jobs are accepted and the
   * method resolves once all queued jobs complete (or are force-cancelled).
   *
   * @param {number} forceAfterMs
   */
  async shutdown(forceAfterMs = 30_000) {
    if (this._shutdownRef) {
      return this._shutdownRef;
    }

    this.emit('service:shutdown:init');
    debug('Shutdown requested – waiting for %d jobs', this._pendingJobs.size);

    const waitForJobs = Promise.allSettled(
      Array.from(this._pendingJobs.values()).map(({ promise }) => promise)
    );

    // Race vs. forced timeout
    this._shutdownRef = pTimeout(waitForJobs, forceAfterMs).catch((err) => {
      this.emit('service:shutdown:forced', err);
    });

    await this._shutdownRef;
    this.emit('service:shutdown:complete');
  }

  /* ───── Private Utilities ────────────────────────────────────────────── */

  _selectStrategy(job) {
    return this._strategies.find((s) => s.canHandle(job));
  }

  _isContainerAccepted(job) {
    return !job.mimeType || this.opts.acceptedContainers.includes(job.mimeType);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Health & Metrics (minimal)                                                */
/* ────────────────────────────────────────────────────────────────────────── */
function createHealthProbe(service) {
  return {
    liveness()  { return true; },
    readiness() { return service._pendingJobs.size < service.opts.concurrency; },
    metrics()   {
      return {
        pendingJobs  : service._pendingJobs.size,
        concurrency  : service.opts.concurrency,
        strategies   : service._strategies.map((s) => s.constructor.id),
        uptimeSec    : Math.floor(process.uptime())
      };
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Bootstrap / Export                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

module.exports = {
  TranscoderService,
  createHealthProbe,
  TranscodeError,
  strategies: {
    CpuStrategy,
    GpuStrategy,
    RemoteStrategy
  }
};

/* ────────────────────────────────────────────────────────────────────────── */
/* CLI (optional)                                                            */
/* ────────────────────────────────────────────────────────────────────────── */
if (require.main === module) {
  // Very light CLI for local testing
  (async () => {
    const args              = process.argv.slice(2);
    const inputUri          = args[0];
    const outputPreset      = args[1] || 'hls_1080p';
    if (!inputUri) {
      console.error('Usage: node index.js <input-uri> [preset]');
      process.exit(1);
    }

    const svc               = new TranscoderService();
    const health            = createHealthProbe(svc);

    svc.on('job:completed', ({ result }) => debug('COMPLETE %O', result));
    svc.on('job:failed',    ({ err })    => console.error(err));

    const job = { inputUri, outputPreset, mimeType: 'video/mp4' };

    try {
      await svc.submit(job);
      console.log('Job finished! Metrics:', health.metrics());
    } catch (e) {
      console.error('Transcoding failed', e);
    } finally {
      await svc.shutdown();
    }
  })();
}
```