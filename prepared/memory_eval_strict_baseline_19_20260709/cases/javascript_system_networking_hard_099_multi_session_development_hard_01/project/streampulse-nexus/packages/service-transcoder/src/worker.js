```javascript
/**
 * StreamPulse Nexus – Transcoder Service Worker
 *
 * This worker consumes transcoding jobs from Redis (BullMQ), spawns a
 * highly–tuned FFmpeg pipeline, and emits state updates that upstream
 * dashboards, auto–scalers, and incident bots subscribe to.
 *
 * Architectural Patterns
 * ----------------------
 * • Event-Driven: BullMQ jobs + internal EventEmitter
 * • Observer:   `TranscoderWorker` emits rich telemetry events
 * • Command:    Each BullMQ job is treated as an executable command
 *
 * Dependencies
 * ------------
 * – bullmq         (job queue backed by Redis)
 * – pino           (structured logging)
 * – prom-client    (Prometheus metrics)
 * – zod            (payload schema validation)
 */

import { Worker as BullWorker, Queue, QueueScheduler, JobsOptions, Job } from 'bullmq';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import Pino from 'pino';
import { Registry, collectDefaultMetrics, Gauge } from 'prom-client';
import { z } from 'zod';

// ----------------------------
// Config
// ----------------------------

const CONFIG = {
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  queueName: process.env.TRANSCODE_QUEUE ?? 'nexus:transcoder:jobs',
  //   `/data` is typically a persistent volume mount in k8s
  workDir: process.env.TRANSCODER_WORKDIR ?? '/data/transcoder',
  concurrency: parseInt(process.env.TRANSCODER_CONCURRENCY ?? `${os.cpus().length}`, 10),
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  metricsInterval: 10_000, // 10 seconds
};

// Ensure workDir exists
await fs.mkdir(CONFIG.workDir, { recursive: true });

// ----------------------------
// Logger
// ----------------------------

const logger = Pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'service-transcoder' },
});

// ----------------------------
// Prometheus Metrics
// ----------------------------

const registry = new Registry();
collectDefaultMetrics({ register: registry });

const jobDurationGauge = new Gauge({
  name: 'nexus_transcoder_job_duration_seconds',
  help: 'Time taken to transcode a job (seconds)',
  registers: [registry],
});

const jobFailGauge = new Gauge({
  name: 'nexus_transcoder_job_failed_total',
  help: 'Number of failed transcoding jobs',
  registers: [registry],
});

const cpuLoadGauge = new Gauge({
  name: 'nexus_transcoder_cpu_load',
  help: 'CPU load (1 minute)',
  registers: [registry],
});

// ----------------------------
// Schema Validation
// ----------------------------

const outputFormatSchema = z.object({
  // HLS, DASH, MP4, etc.
  container: z.enum(['m3u8', 'mpd', 'mp4']),
  videoBitrate: z.string(), // e.g. "1500k"
  audioBitrate: z.string().optional(),
  resolution: z.string().optional(), // e.g. "1280x720"
});

const jobPayloadSchema = z.object({
  id: z.string(),
  sourceUrl: z.string().url(),
  outputs: z.array(outputFormatSchema).nonempty(),
});

// ----------------------------
// Helper – FFmpeg Spawner
// ----------------------------

/**
 * spawnFfmpeg
 *
 * Spawns FFmpeg with provided args. Returns a promise that resolves
 * when the child process exits. Streams std{out,err} to logger for
 * debugging and progress extraction.
 */
function spawnFfmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => {
      logger.debug({ jobId, line: data.toString() }, '[ffmpeg:stdout]');
    });

    child.stderr.on('data', (data) => {
      const line = data.toString();
      logger.debug({ jobId, line }, '[ffmpeg:stderr]');

      // Extract simple progress (frame=, time=) for observers
      // Example: frame=  238 fps= 25 q=28.0 size=    1024kB time=00:00:09.52 bitrate= 882.1kbits/s
      const timeMatch = line.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch) {
        emitter.emit('progress', { jobId, ts: Date.now(), encodedTime: timeMatch[1] });
      }
    });

    child.on('error', (err) => {
      logger.error({ jobId, err }, 'FFmpeg spawn error');
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`FFmpeg exited with code ${code}`);
        err.exitCode = code;
        reject(err);
      }
    });
  });
}

// ----------------------------
// TranscoderWorker
// ----------------------------

export class TranscoderWorker extends EventEmitter {
  constructor() {
    super();
    this._init();
  }

  _init() {
    // Keep track of ongoing transcodes to allow graceful shutdown
    this.activeJobs = new Set();

    // Scheduler prevents stalled jobs
    this.scheduler = new QueueScheduler(CONFIG.queueName, {
      connection: CONFIG.redis,
    });

    this.queue = new Queue(CONFIG.queueName, {
      connection: CONFIG.redis,
    });

    this.worker = new BullWorker(
      CONFIG.queueName,
      (job) => this._handleJob(job),
      {
        connection: CONFIG.redis,
        concurrency: CONFIG.concurrency,
        // Backoff strategy: exponential 2^attempt * 5s
        settings: { backoffStrategies: { exponential: (attempts) => attempts ** 2 * 5000 } },
      },
    );

    // Worker-level events forwarded to external observers
    this.worker.on('completed', (job) => this.emit('completed', { jobId: job.id }));
    this.worker.on('failed', (job, err) => this.emit('failed', { jobId: job?.id, error: err }));

    // Health metrics
    this.healthTimer = setInterval(() => this._emitHealth(), CONFIG.metricsInterval);

    // Bubble up queue errors
    this.worker.on('error', (err) => logger.error({ err }, 'Worker runtime error'));
  }

  /**
   * _handleJob
   *
   * Core processing pipeline for each BullMQ job. Validates payload,
   * orchestrates FFmpeg, manages retries, and collects metrics.
   */
  async _handleJob(job) {
    const startedAt = process.hrtime.bigint();
    const jobId = job.id;

    try {
      // 1. Schema validation (fail fast)
      const payload = jobPayloadSchema.parse(job.data);
      this.activeJobs.add(jobId);
      this.emit('started', { jobId, payload });

      // 2. Run transcoding for each output definition sequentially
      for (const output of payload.outputs) {
        const outputPath = path.join(CONFIG.workDir, `${payload.id}.${output.container}`);

        const ffmpegArgs = [
          '-y', // overwrite
          '-i',
          payload.sourceUrl,
          '-c:v',
          'libx264',
          '-b:v',
          output.videoBitrate,
          ...(output.audioBitrate ? ['-b:a', output.audioBitrate] : []),
          ...(output.resolution ? ['-s', output.resolution] : []),
          outputPath,
        ];

        logger.info({ jobId, ffmpegArgs }, 'Launching FFmpeg');

        await spawnFfmpeg(ffmpegArgs, jobId);

        this.emit('output-complete', { jobId, format: output, outputPath });
      }

      // 3. Duration metric
      const duration =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000; // nanoseconds → seconds
      jobDurationGauge.set(duration);
      logger.info({ jobId, duration }, 'Transcoding complete');
      return { duration };
    } catch (err) {
      // Update metrics, rethrow to BullMQ so retries/backoff apply
      jobFailGauge.inc();
      logger.error({ jobId, err }, 'Transcoding failed');
      throw err;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * _emitHealth
   *
   * Emits CPU load metrics and notifies observers. Useful for autoscalers
   * and dashboards watching cluster hotspots.
   */
  _emitHealth() {
    const load = os.loadavg()[0]; // 1-minute average
    cpuLoadGauge.set(load);
    this.emit('health', { timestamp: Date.now(), load });
  }

  // -------------------------
  // Public API
  // -------------------------

  /**
   * Enqueue a new transcoding job.
   *
   * @param {object} payload – Must satisfy `jobPayloadSchema`
   * @param {JobsOptions} opts – BullMQ job options (priority, delay, etc.)
   */
  async enqueue(payload, opts = {}) {
    const parsed = jobPayloadSchema.parse(payload);
    return this.queue.add(parsed.id, parsed, opts);
  }

  /**
   * Gracefully shuts down the worker, waiting for active transcodes
   * to finish or until timeout.
   */
  async shutdown(timeout = 30_000) {
    logger.info('Initiating graceful shutdown');
    clearInterval(this.healthTimer);

    const shutdownPromise = this.worker.close();
    const timer = setTimeout(
      () => {
        logger.warn('Forcing shutdown after timeout');
        this.worker.disconnect();
      },
      timeout,
    );

    await shutdownPromise.finally(() => clearTimeout(timer));
    logger.info('Shutdown complete');
  }

  /**
   * Expose Prometheus metrics to HTTP-based scrapers.
   * This method returns the plaintext exposition format.
   */
  async metrics() {
    return registry.metrics();
  }
}

// --------------------------------
// Self-run (CLI mode)
// --------------------------------

if (require.main === module) {
  (async () => {
    const worker = new TranscoderWorker();

    const shutdownSignals = ['SIGINT', 'SIGTERM'];
    shutdownSignals.forEach((signal) => {
      process.on(signal, async () => {
        logger.info({ signal }, 'Received shutdown signal');
        await worker.shutdown();
        process.exit(0);
      });
    });

    // Simple built-in HTTP server for /metrics
    const PORT = process.env.METRICS_PORT ?? 9100;
    const http = (await import('http')).default;
    http
      .createServer(async (req, res) => {
        if (req.url === '/metrics') {
          const body = await worker.metrics();
          res.writeHead(200, { 'Content-Type': registry.contentType });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end();
        }
      })
      .listen(PORT, () => logger.info({ port: PORT }, 'Metrics server listening'));
  })().catch((err) => {
    logger.fatal({ err }, 'Fatal error in transcoder worker');
    process.exit(1);
  });
}
```