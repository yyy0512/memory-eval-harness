```javascript
/**
 * StreamPulse Nexus – Shared Logger
 *
 * A structured, transport-aware logging facility used across StreamPulse
 * components.  Features:
 *   • Hierarchical log levels (trace → fatal)
 *   • Pluggable transports (console, file, remote HTTP)
 *   • Context propagation & correlation-id support via AsyncLocalStorage
 *   • Redaction of sensitive fields before emission
 *   • Simple file-rotation & remote retry w/ exponential back-off
 *
 * NOTE: The logger purposefully avoids heavyweight external dependencies to
 * stay lightweight inside latency-critical media routers.
 *
 * @module logger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { format } = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const http = require('http');
const https = require('https');

/* -------------------------------------------------------------------------- */
/*                                Enumerations                                */
/* -------------------------------------------------------------------------- */

const LogLevel = Object.freeze({
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
});

const LogLevelNames = Object.freeze(
  Object.entries(LogLevel).reduce((acc, [k, v]) => {
    acc[v] = k.toLowerCase();
    return acc;
  }, {}),
);

/* -------------------------------------------------------------------------- */
/*                           Async Context Handling                           */
/* -------------------------------------------------------------------------- */

/**
 * Simple async local storage for correlation-ids.  Each queued micro-task
 * inherits the id automatically.
 */
const asyncLocal = new AsyncLocalStorage();

/**
 * Retrieves current correlation id from AsyncLocalStorage (if any).
 * @returns {string|undefined}
 */
function currentCorrelationId() {
  const store = asyncLocal.getStore();
  return store?.correlationId;
}

/**
 * Runs given function with a correlation id available in async context.
 * Used by entrypoints to propagate request/task identifiers.
 * @param {Function} fn
 * @param {string} [correlationId]
 */
function withCorrelationId(fn, correlationId = crypto.randomUUID()) {
  asyncLocal.run({ correlationId }, fn);
}

/* -------------------------------------------------------------------------- */
/*                                Util Helpers                                */
/* -------------------------------------------------------------------------- */

function safeJSONStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return `"__non_serializable__: ${e.message}"`;
  }
}

/**
 * Redacts sensitive keys.
 * @param {object} meta
 * @param {string[]} redactedKeys
 * @returns {object}
 */
function redact(meta, redactedKeys) {
  if (!meta || typeof meta !== 'object') return meta;
  const clone = Array.isArray(meta) ? [...meta] : { ...meta };

  for (const key of Object.keys(clone)) {
    if (redactedKeys.includes(key.toLowerCase())) {
      clone[key] = '[REDACTED]';
    } else if (typeof clone[key] === 'object') {
      clone[key] = redact(clone[key], redactedKeys); // recursion
    }
  }
  return clone;
}

/* -------------------------------------------------------------------------- */
/*                                Transports                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base transport skeleton.
 */
class Transport {
  constructor(level = LogLevel.TRACE) {
    this.level = level;
  }

  // eslint-disable-next-line no-unused-vars
  log(_entry) {
    throw new Error('Transport.log must be implemented');
  }

  flush() {} // optional
  close() {} // optional
}

/* ------------------------------ Console ----------------------------------- */

const COLOR = {
  trace: '\x1b[90m', // gray
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  fatal: '\x1b[35m', // magenta
  reset: '\x1b[0m',
};

class ConsoleTransport extends Transport {
  constructor({
    level = LogLevel.TRACE,
    pretty = process.env.NODE_ENV !== 'production',
  } = {}) {
    super(level);
    this.pretty = pretty;
  }

  log(entry) {
    if (entry.level < this.level) return;

    if (this.pretty) {
      const color = COLOR[entry.levelName] ?? '';
      const reset = COLOR.reset;
      /* eslint-disable max-len */
      // prettier-ignore
      const line = `${color}${entry.timestamp} [${entry.levelName.toUpperCase()}] (${entry.pid}) ${entry.message}${reset} ${safeJSONStringify(entry.meta)}`;
      /* eslint-enable max-len */
      // eslint-disable-next-line no-console
      console.log(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(safeJSONStringify(entry));
    }
  }
}

/* ------------------------------ File -------------------------------------- */

class FileTransport extends Transport {
  constructor({
    level = LogLevel.INFO,
    filePath = path.join(process.cwd(), 'logs', 'streampulse.log'),
    maxSize = 10 * 1024 * 1024, // 10 MB
    maxFiles = 5,
  } = {}) {
    super(level);

    this.filePath = filePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;

    // Ensure directory exists
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
  }

  log(entry) {
    if (entry.level < this.level) return;

    const line = safeJSONStringify(entry) + os.EOL;
    this.stream.write(line, () => {
      if (this.stream.bytesWritten >= this.maxSize) {
        this.rotate();
      }
    });
  }

  rotate() {
    this.stream.end(() => {
      for (let i = this.maxFiles - 1; i >= 0; i--) {
        const src =
          i === 0
            ? this.filePath
            : `${this.filePath}.${String(i).padStart(2, '0')}`;
        const dest = `${this.filePath}.${String(i + 1).padStart(2, '0')}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest);
        }
      }
      this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    });
  }

  flush() {
    return new Promise((res) => this.stream.end(res));
  }

  close() {
    this.stream.destroy();
  }
}

/* ------------------------------ HTTP -------------------------------------- */

class HttpTransport extends Transport {
  constructor({
    level = LogLevel.WARN,
    endpoint = 'https://log-collector.streampulse.io/v1/ingest',
    timeout = 3_000,
    headers = {},
    retries = 3,
    agent,
  } = {}) {
    super(level);
    this.endpoint = new URL(endpoint);
    this.timeout = timeout;
    this.headers = {
      'Content-Type': 'application/json',
      ...headers,
    };
    this.retries = retries;
    this.agent = agent;
  }

  log(entry) {
    if (entry.level < this.level) return;

    const payload = Buffer.from(safeJSONStringify(entry));
    const isHttps = this.endpoint.protocol === 'https:';
    const reqFn = isHttps ? https.request : http.request;

    const options = {
      hostname: this.endpoint.hostname,
      port: this.endpoint.port || (isHttps ? 443 : 80),
      path: this.endpoint.pathname + this.endpoint.search,
      method: 'POST',
      timeout: this.timeout,
      headers: {
        ...this.headers,
        'Content-Length': payload.length,
      },
      agent: this.agent,
    };

    let attempts = 0;
    const max = this.retries;

    const attempt = () => {
      attempts += 1;
      const req = reqFn(options, (res) => {
        // Drain response data to free up memory
        res.resume();
        if (res.statusCode >= 400 && attempts <= max) {
          backoff();
        }
      });

      req.on('error', (err) => {
        if (attempts <= max) {
          backoff();
        } else {
          // eslint-disable-next-line no-console
          console.error('HttpTransport failed:', err.message);
        }
      });

      req.write(payload);
      req.end();
    };

    const backoff = () => {
      const delay = 2 ** attempts * 100;
      setTimeout(attempt, delay);
    };

    attempt();
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Logger                                   */
/* -------------------------------------------------------------------------- */

class Logger extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.level]            Minimum level (default: env / INFO)
   * @param {Transport[]} [options.transports]  Output transports
   * @param {object} [options.context]          Static context metadata
   * @param {string[]} [options.redact]         Keys to redact
   */
  constructor({
    level = parseLogLevel(process.env.LOG_LEVEL) ?? LogLevel.INFO,
    transports = [new ConsoleTransport()],
    context = {},
    redact = ['password', 'token', 'secret', 'authorization'],
  } = {}) {
    super();

    this.level = level;
    this.transports = transports;
    this.staticContext = { ...context };
    this.redactKeys = redact.map((k) => k.toLowerCase());
  }

  /* ------------------------------ Core logic ------------------------------ */

  log(level, message, meta = {}) {
    if (level < this.level) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      levelName: LogLevelNames[level],
      pid: process.pid,
      host: os.hostname(),
      correlationId: meta.correlationId ?? currentCorrelationId(),
      message: typeof message === 'string' ? message : format(message),
      meta: redact(meta, this.redactKeys),
      context: this.staticContext,
    };

    for (const transport of this.transports) {
      try {
        transport.log(entry);
      } catch (err) {
        // Ensure one bad transport does not break logging entirely.
        // eslint-disable-next-line no-console
        console.error('Logger transport error', err);
      }
    }

    this.emit('logged', entry);
  }

  trace(msg, meta) {
    this.log(LogLevel.TRACE, msg, meta);
  }

  debug(msg, meta) {
    this.log(LogLevel.DEBUG, msg, meta);
  }

  info(msg, meta) {
    this.log(LogLevel.INFO, msg, meta);
  }

  warn(msg, meta) {
    this.log(LogLevel.WARN, msg, meta);
  }

  error(msg, meta) {
    this.log(LogLevel.ERROR, msg, meta);
  }

  fatal(msg, meta) {
    this.log(LogLevel.FATAL, msg, meta);
  }

  /**
   * Creates child logger with extended context.
   * @param {object} ctx
   * @returns {Logger}
   */
  child(ctx = {}) {
    return new Logger({
      level: this.level,
      transports: this.transports,
      context: { ...this.staticContext, ...ctx },
      redact: this.redactKeys,
    });
  }

  /**
   * Flushes all transports that implement flush().
   * @returns {Promise<void>}
   */
  async flush() {
    await Promise.all(
      this.transports.map((t) => {
        if (typeof t.flush === 'function') {
          return t.flush();
        }
        return undefined;
      }),
    );
  }

  /**
   * Closes all transports that implement close().
   */
  close() {
    for (const t of this.transports) {
      if (typeof t.close === 'function') {
        t.close();
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                               Helper Methods                               */
/* -------------------------------------------------------------------------- */

/**
 * Converts string log level to numeric constant.
 * @param {string|number|undefined} level
 * @returns {number|undefined}
 */
function parseLogLevel(level) {
  if (typeof level === 'number') return level;
  if (typeof level !== 'string') return undefined;

  const upper = level.trim().toUpperCase();
  if (LogLevel[upper]) return LogLevel[upper];
  const num = Number(level);
  return Number.isFinite(num) ? num : undefined;
}

/* -------------------------------------------------------------------------- */
/*                                Exports                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
  LogLevel,
  Logger,
  Transport,
  ConsoleTransport,
  FileTransport,
  HttpTransport,
  currentCorrelationId,
  withCorrelationId,
};
```