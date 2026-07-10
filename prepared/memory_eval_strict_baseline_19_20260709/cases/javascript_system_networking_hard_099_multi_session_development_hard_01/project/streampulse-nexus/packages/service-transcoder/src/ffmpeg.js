```javascript
/**
 * StreamPulse Nexus – service-transcoder
 * File: src/ffmpeg.js
 *
 * A thin yet production-ready wrapper around FFmpeg that
 *  •  Encapsulates process management (start/stop/restart)
 *  •  Surfaces granular progress events parsed from stderr
 *  •  Implements pluggable Strategy objects for rendition sets
 *  •  Publishes metrics for external monitoring / dashboards
 *
 * The module purposefully avoids heavyweight external
 * dependencies; fluent-ffmpeg is great, but we need tighter
 * control over args and better observability hooks.
 *
 * Copyright © StreamPulse
 */

'use strict';

/* ────────────────────────────────────────────────────────────
 * Node.js core
 * ──────────────────────────────────────────────────────────── */
const { spawn }         = require('child_process');
const { EventEmitter }  = require('events');
const { platform }      = require('os');
const path              = require('path');
const { v4: uuidv4 }    = require('uuid');
const fs                = require('fs');

/* ────────────────────────────────────────────────────────────
 * Optional / soft dependencies (fallback-safe)
 * ──────────────────────────────────────────────────────────── */
let promClient;
try {
  // Prometheus client is optional – only load when available.
  promClient = require('prom-client');
} catch (_) {
  promClient = null;
}

/* ────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────── */
const DEFAULT_FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const GRACE_PERIOD_MS     = 6000;    // Time to allow for SIGTERM shutdown
const KPI_INTERVAL_MS     = 10_000;  // Emit metric snapshots every 10s

/* ────────────────────────────────────────────────────────────
 * Regex helpers for parsing ffmpeg progress
 * ──────────────────────────────────────────────────────────── */
const PROGRESS_REGEX = /frame=\s*(?<frame>\d+).*?fps=\s*(?<fps>[\d.]+).*?time=(?<time>[\d:.]+).*?bitrate=\s*(?<bitrate>[\d.]+kbits\/s).*?speed=\s*(?<speed>[\d.]+)x/;

/* ────────────────────────────────────────────────────────────
 * Strategy pattern for rendition definitions
 * ──────────────────────────────────────────────────────────── */

/**
 * Base class for rendition generation strategies.
 * Each strategy must implement .buildRenditions() and
 * return an array describing each output rendition.
 */
class TranscodeStrategy {
  /* eslint-disable-next-line class-methods-use-this */
  buildRenditions() {
    throw new Error('TranscodeStrategy.buildRenditions must be implemented.');
  }
}

/**
 * Strategy that creates a fixed set of adaptive-bitrate renditions,
 * e.g. 1080p@6Mb, 720p@3Mb, 480p@1.5Mb. Suitable for live HLS.
 */
class ABRStrategy extends TranscodeStrategy {
  /**
   * @param {Object} opts
   * @param {string} opts.targetDir   – Directory where rendition files will be written
   * @param {boolean} [opts.audioPassthrough=true]
   */
  constructor(opts = {}) {
    super();
    this.targetDir         = opts.targetDir || '/tmp/stream';
    this.audioPassthrough  = opts.audioPassthrough !== false;
  }

  buildRenditions() {
    return [
      { name: '1080p', width: 1920, height: 1080, videoBitrate: '6000k', audioBitrate: '192k' },
      { name: '720p',  width: 1280, height: 720,  videoBitrate: '3000k', audioBitrate: '128k' },
      { name: '480p',  width: 854,  height: 480,  videoBitrate: '1500k', audioBitrate: '96k'  },
    ].map(conf => ({
      ...conf,
      output: path.join(this.targetDir, `${conf.name}.m3u8`),
    }));
  }
}

/**
 * Strategy that simply repackages into a different container
 * while preserving the original streams.
 */
class PassthroughStrategy extends TranscodeStrategy {
  /**
   * @param {Object} opts
   * @param {string} opts.output – Output file path
   */
  constructor(opts = {}) {
    super();
    this.output = opts.output || '/tmp/stream/output.mp4';
  }

  buildRenditions() {
    return [{
      name: 'passthrough',
      copyVideo: true,
      copyAudio: true,
      output: this.output,
    }];
  }
}

/* ────────────────────────────────────────────────────────────
 * Helper: compile FFmpeg CLI arguments for an individual
 * rendition descriptor.
 * ──────────────────────────────────────────────────────────── */
function buildRenditionArgs(rendition) {
  const args = [];

  // Video codec
  if (rendition.copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-b:v', rendition.videoBitrate,
      '-preset', 'veryfast',
      '-profile:v', 'high',
      '-vf', `scale=w=${rendition.width}:h=${rendition.height}:force_original_aspect_ratio=decrease`
    );
  }

  // Audio codec
  if (rendition.copyAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push(
      '-c:a', 'aac',
      '-b:a', rendition.audioBitrate || '128k'
    );
  }

  // Output
  args.push(rendition.output);

  return args;
}

/* ────────────────────────────────────────────────────────────
 * FFmpegProcess – EventEmitter wrapper around ffmpeg child-proc
 * ──────────────────────────────────────────────────────────── */
class FFmpegProcess extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.input                 – Input URL/filename
   * @param {TranscodeStrategy} opts.strategy   – Rendition strategy
   * @param {string} [opts.ffmpegPath]          – Override binary path
   * @param {Object} [opts.logger]              – Pino-style logger
   * @param {boolean} [opts.autoStart=true]
   */
  constructor(opts = {}) {
    super();

    if (!opts.input) throw new Error('FFmpegProcess: opts.input is required');
    if (!opts.strategy) throw new Error('FFmpegProcess: opts.strategy is required');
    if (!(opts.strategy instanceof TranscodeStrategy)) {
      throw new Error('FFmpegProcess: opts.strategy must be instance of TranscodeStrategy');
    }

    this.id          = uuidv4();
    this.input       = opts.input;
    this.strategy    = opts.strategy;
    this.ffmpegPath  = opts.ffmpegPath || DEFAULT_FFMPEG_PATH;
    this.logger      = opts.logger || console;

    this.child       = null;
    this.killed      = false;

    // Prometheus metric setup (lazy)
    this.metrics = promClient ? this._initMetricCollectors() : null;

    if (opts.autoStart !== false) {
      this.start();
    }
  }

  /* ───────────────────────────────────────
   * Public API
   * ─────────────────────────────────────── */

  /**
   * Boots an FFmpeg child process with args derived from the
   * provided strategy. Emits `start` → `progress` (multiple) → `end`.
   */
  start() {
    if (this.child) {
      throw new Error('FFmpegProcess already started');
    }

    const renditionDescriptors = this.strategy.buildRenditions();
    const args = [
      '-hide_banner',
      '-y',                         // Overwrite output files
      '-i', this.input,
    ].concat(...renditionDescriptors.map(buildRenditionArgs));

    this.logger.info({ id: this.id, args }, 'spawning ffmpeg');
    this.child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // stdout is usually empty for ffmpeg; we listen to stderr
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => this._handleStderr(chunk));

    this.child.on('error', err => {
      this.logger.error({ id: this.id, err }, 'ffmpeg spawn error');
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.logger.info({ id: this.id, code, signal }, 'ffmpeg exited');
      clearInterval(this._kpiTimer);
      this.emit('end', { code, signal });
    });

    // KPI snapshot timer
    this._kpiTimer = setInterval(() => this._emitKpiSnapshot(), KPI_INTERVAL_MS);

    this.emit('start', { pid: this.child.pid, args });
  }

  /**
   * Gracefully terminates the ffmpeg process (SIGTERM → wait →
   * SIGKILL fallback). Returns a Promise that resolves once
   * termination sequence completes.
   */
  async stop() {
    if (!this.child || this.killed) return;

    this.killed = true;
    this.logger.info({ id: this.id, pid: this.child.pid }, 'terminating ffmpeg');

    this.child.kill('SIGTERM');

    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (this.child.exitCode == null) {
          this.logger.warn({ id: this.id }, 'ffmpeg SIGKILL fallback');
          this.child.kill('SIGKILL');
        }
        resolve();
      }, GRACE_PERIOD_MS);

      this.child.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /* ───────────────────────────────────────
   * Private helpers
   * ─────────────────────────────────────── */

  _handleStderr(data) {
    data.split('\n').forEach(line => {
      if (!line.trim()) return;

      // Log raw stderr at trace level
      this.logger.debug({ id: this.id, line });

      const match = line.match(PROGRESS_REGEX);
      if (match && match.groups) {
        const progress = {
          frame:      Number(match.groups.frame),
          fps:        Number(match.groups.fps),
          timecode:   match.groups.time,
          bitrate:    match.groups.bitrate,
          speed:      Number(match.groups.speed),
        };
        this.emit('progress', progress);
        this._recordMetrics(progress);
      }
    });
  }

  _initMetricCollectors() {
    const registry  = promClient.register;
    const prefix    = `streampulse_transcoder_${this.id.replace(/-/g, '')}_`;

    const fpsGauge      = new promClient.Gauge({ name: `${prefix}fps`, help: 'Frames per second' });
    const speedGauge    = new promClient.Gauge({ name: `${prefix}speed`, help: 'Encoding speed (x realtime)' });
    const bitrateGauge  = new promClient.Gauge({ name: `${prefix}bitrate_kbps`, help: 'Bitrate in kbits/s' });

    return { registry, fpsGauge, speedGauge, bitrateGauge };
  }

  _recordMetrics(pg) {
    if (!this.metrics) return; // Prometheus optional

    this.metrics.fpsGauge.set(pg.fps);
    this.metrics.speedGauge.set(pg.speed);
    const bitrateNumeric = parseFloat(pg.bitrate.replace(/kbits\/s/i, ''));
    this.metrics.bitrateGauge.set(bitrateNumeric);
  }

  _emitKpiSnapshot() {
    this.emit('kpi', {
      timestamp: Date.now(),
      memoryRss: this.child ? this.child.resourceUsage().rss : 0,
    });
  }
}

/* ────────────────────────────────────────────────────────────
 * Factory function – convenience wrapper
 * ──────────────────────────────────────────────────────────── */

/**
 * Spawns a new FFmpegProcess using a friendly one-liner.
 *
 * @param {Object} opts – Same as FFmpegProcess constructor.
 * @returns {FFmpegProcess}
 */
function createTranscodeJob(opts) {
  return new FFmpegProcess(opts);
}

/* ────────────────────────────────────────────────────────────
 * Exports
 * ──────────────────────────────────────────────────────────── */
module.exports = {
  FFmpegProcess,
  createTranscodeJob,
  strategies: {
    ABRStrategy,
    PassthroughStrategy,
  },
};
```