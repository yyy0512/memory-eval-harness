```javascript
/**
 * @file packages/service-transcoder/test/ffmpeg.test.js
 * @description Unit-tests for the FFmpeg wrapper that lives in
 *              packages/service-transcoder/src/ffmpeg.js.
 *
 * The tests cover:
 *  1. Pure-function behaviour of buildFFmpegCommand.
 *  2. Transcoder orchestration around the underlying FFmpeg process
 *     (spawned through `execa`).  We simulate process I/O with an
 *     EventEmitter so no actual binary is required.
 *
 * Jest is the test-runner of choice for the StreamPulse monorepo.
 */

import { EventEmitter } from 'events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { jest } from '@jest/globals';
import execa from 'execa';

import {
  buildFFmpegCommand,
  Transcoder,
  TRANSCODER_DEFAULTS,
} from '../src/ffmpeg';

jest.mock('execa');

/* -------------------------------------------------------------------------- */
/*                              Helper utilities                              */
/* -------------------------------------------------------------------------- */

/**
 * Generates a stub execa child process for controlled testing.
 * The returned object satisfies the essential parts of the `execa`
 * `ExecaChildProcess` interface that our wrapper utilises.
 *
 * @param {object} opts
 * @param {number} opts.exitCode – The exit code that should eventually be emitted.
 * @param {number} opts.emitDelay – How long to wait (ms) before emitting `close`.
 * @returns {EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill: Function }}
 */
function createStubProcess({ exitCode = 0, emitDelay = 10 } = {}) {
  const proc = new EventEmitter();

  // execa attaches `stdout` and `stderr` streams that are themselves
  // EventEmitters.  We keep this surface-area small for testing.
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  proc.kill = jest.fn();

  // After a tick, emit the `close` event.
  setTimeout(() => {
    proc.emit('close', exitCode);
  }, emitDelay);

  // Promise interface: `.then()` resolves when 'close' is emitted.
  proc.then = (onFulfilled, onRejected) =>
    new Promise((res, rej) => {
      proc.once('close', (code) => {
        if (code === 0) res(code);
        else rej(new Error(`Process exited with code ${code}`));
      });
    }).then(onFulfilled, onRejected);

  return proc;
}

/**
 * Parses a small fixture with FFmpeg progress log-lines.
 * Real FFmpeg pipes these to `stderr`; we replicate that.
 */
function emitProgress(proc) {
  /**
   * Typical FFmpeg progress line (stderr):
   * frame=  120 fps=0.0 q=0.0 size=       0kB time=00:00:05.00 bitrate=   0.0kbits/s speed=9.99x
   */
  const lines = [
    'frame=   10 fps=25.0 q=28.0 size=     256kB time=00:00:00.40 bitrate=5245.1kbits/s speed=0.99x',
    'frame=   20 fps=29.3 q=28.0 size=     512kB time=00:00:00.80 bitrate=5244.8kbits/s speed=1.15x',
    'frame=   30 fps=29.1 q=28.0 size=     768kB time=00:00:01.20 bitrate=5245.5kbits/s speed=1.21x',
  ];

  // Emit each line with a small delay to emulate streaming output.
  lines.forEach((ln, idx) => {
    setTimeout(() => proc.stderr.emit('data', Buffer.from(`${ln}\n`)), idx * 2);
  });
}

/* -------------------------------------------------------------------------- */
/*                                    Tests                                   */
/* -------------------------------------------------------------------------- */

describe('buildFFmpegCommand', () => {
  it('produces the expected argument list for H.264 progressive stream', () => {
    const opts = {
      input: '/tmp/source.mp4',
      output: '/tmp/out.m3u8',
      videoCodec: 'libx264',
      audioCodec: 'aac',
      videoBitrate: '3000k',
      audioBitrate: '128k',
      preset: 'veryfast',
      crf: 23,
      maxrate: '3200k',
      bufsize: '6400k',
      format: 'hls',
      hlsTime: 4,
    };

    const args = buildFFmpegCommand(opts);

    expect(args).toEqual([
      '-hide_banner',
      '-y',
      '-i',
      opts.input,
      '-c:v',
      opts.videoCodec,
      '-b:v',
      opts.videoBitrate,
      '-maxrate',
      opts.maxrate,
      '-bufsize',
      opts.bufsize,
      '-preset',
      opts.preset,
      '-crf',
      String(opts.crf),
      '-c:a',
      opts.audioCodec,
      '-b:a',
      opts.audioBitrate,
      '-f',
      opts.format,
      '-hls_time',
      String(opts.hlsTime),
      opts.output,
    ]);
  });

  it('falls back to defaults when optional fields are not provided', () => {
    const args = buildFFmpegCommand({
      input: 'in.mkv',
      output: 'out.mp4',
    });

    expect(args).toContain('-c:v');
    expect(args).toContain(TRANSCODER_DEFAULTS.videoCodec);
    expect(args).toContain('-b:v');
    expect(args).toContain(TRANSCODER_DEFAULTS.videoBitrate);
  });

  it('throws helpful error when required fields are missing', () => {
    expect(() => buildFFmpegCommand({ input: 'a.mp4' })).toThrow(
      /output.*required/i,
    );
    expect(() => buildFFmpegCommand({ output: 'b.mp4' })).toThrow(
      /input.*required/i,
    );
  });
});

describe('Transcoder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('spawns an execa child-process with the generated ffmpeg args', async () => {
    const stubProc = createStubProcess();
    execa.mockReturnValueOnce(stubProc);

    const transcoder = new Transcoder();

    const opts = {
      input: '/media/track.mov',
      output: '/media/track_720p.mp4',
    };

    await transcoder.start(opts);

    expect(execa).toHaveBeenCalledTimes(1);
    const [binary, args] = execa.mock.calls[0];

    expect(binary).toMatch(/ffmpeg$/);
    expect(args).toEqual(buildFFmpegCommand(opts));
  });

  it('emits `progress` events parsed from FFmpeg stderr', async () => {
    const stubProc = createStubProcess({ exitCode: 0, emitDelay: 30 });
    execa.mockReturnValueOnce(stubProc);

    const transcoder = new Transcoder();
    const progressEvents = [];

    transcoder.on('progress', (p) => progressEvents.push(p));

    const startPromise = transcoder
      .start({
        input: '/media/foo.mkv',
        output: '/media/bar.mp4',
      })
      .catch(() => {}); // suppress automatic rejection for this test

    // Simulate FFmpeg progress lines.
    emitProgress(stubProc);

    // Wait until the stub process exits.
    await startPromise;

    expect(progressEvents.length).toBeGreaterThan(0);
    progressEvents.forEach((evt) => {
      expect(evt).toEqual(
        expect.objectContaining({
          frame: expect.any(Number),
          fps: expect.any(Number),
          time: expect.any(Number),
        }),
      );
    });
  });

  it('rejects the promise when FFmpeg exits non-zero', async () => {
    const stubProc = createStubProcess({ exitCode: 1 });
    execa.mockReturnValueOnce(stubProc);

    const transcoder = new Transcoder();

    await expect(
      transcoder.start({
        input: '/media/broken.mov',
        output: '/media/broken_out.mp4',
      }),
    ).rejects.toThrow(/exit code 1/);
  });

  it('aborts the underlying process tree when `stop()` is invoked', async () => {
    const stubProc = createStubProcess({ emitDelay: 50 });
    execa.mockReturnValueOnce(stubProc);

    const transcoder = new Transcoder();

    // Kick off a transcode but we'll abort shortly after.
    transcoder
      .start({
        input: '/foo/in.mp4',
        output: '/foo/out.mp4',
      })
      .catch(() => {}); // intentionally ignore for this test

    // Give event-loop a tick so `execa` call registers.
    await new Promise((r) => setTimeout(r, 5));

    await transcoder.stop();

    expect(stubProc.kill).toHaveBeenCalledWith('SIGTERM', {
      forceKillAfterTimeout: 5_000,
    });
  });

  it('writes progressive status updates to an optional status-file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-test-'));
    const statusFile = path.join(tmpDir, 'status.json');

    const stubProc = createStubProcess({ exitCode: 0, emitDelay: 40 });
    execa.mockReturnValueOnce(stubProc);

    const transcoder = new Transcoder({ statusFile });

    const startPromise = transcoder.start({
      input: '/media/live.mp4',
      output: '/media/vod.mp4',
    });

    emitProgress(stubProc);
    await startPromise;

    // Ensure file exists and contains valid JSON.
    const serialized = await fs.readFile(statusFile, 'utf-8');
    const payload = JSON.parse(serialized);
    expect(payload).toEqual(
      expect.objectContaining({
        state: 'completed',
        metrics: expect.objectContaining({ fps: expect.any(Number) }),
      }),
    );
  });
});
```