```javascript
/**
 * StreamPulse Nexus – DashboardObserver
 *
 * This observer listens to state-change events emitted by various system
 * components (e.g. media routers, edge caches, security scanners) and ships
 * them, in near-real-time and in sensible batches, to the operator dashboard
 * via WebSocket.  It implements a resilient connection strategy with
 * exponential back-off, automatic re-subscription, and back-pressure control
 * so that dashboards are up-to-date without risking an event-storm.
 *
 * File location:
 *    streampulse-nexus/packages/service-media-orchestrator/src/patterns/observer/DashboardObserver.js
 */

import EventEmitter from 'events';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_BATCH_INTERVAL_MS = 1_000;   // Flush every 1s
const DEFAULT_MAX_BUFFER_SIZE    = 5_000;  // Hard buffer cap
const DEFAULT_MAX_RETRIES        = 10;     // Maximum reconnection attempts
const BACKOFF_BASE_MS            = 500;    // Initial backoff
const BACKOFF_MAX_MS             = 30_000; // Cap backoff at 30s

/* -------------------------------------------------------------------------- */
/*  Type Definitions (JSDoc)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} DashboardObserverOptions
 * @property {string}  dashboardUrl      – WebSocket URL for dashboard feed
 * @property {number=} batchIntervalMs   – How often to flush the buffer
 * @property {number=} maxBufferSize     – Max number of events to hold
 * @property {number=} maxReconnects     – Maximum reconnect attempts
 * @property {function(Error):void=} onFatalError – Callback for unrecoverable errors
 */

/**
 * @typedef {Object} Subject
 * @property {EventEmitter} emitter – EventEmitter that emits change events
 * @property {string}       id      – Unique identifier
 */

/**
 * Event payload shape that subjects emit and dashboards expect.
 * @typedef {Object} StateChangeEvent
 * @property {string}   nodeId
 * @property {string}   metric             – e.g. 'bitrate', 'cpu', 'latency'
 * @property {number}   value
 * @property {number}   timestamp          – epoch ms
 * @property {string=}  traceId
 */

/* -------------------------------------------------------------------------- */
/*  DashboardObserver                                                         */
/* -------------------------------------------------------------------------- */

export default class DashboardObserver extends EventEmitter {
  /**
   * @param {DashboardObserverOptions} options
   */
  constructor (options) {
    super();

    if (!options?.dashboardUrl) {
      throw new Error('DashboardObserver requires a dashboardUrl');
    }

    this._options = Object.freeze({
      batchIntervalMs : options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
      maxBufferSize   : options.maxBufferSize   ?? DEFAULT_MAX_BUFFER_SIZE,
      maxReconnects   : options.maxReconnects   ?? DEFAULT_MAX_RETRIES,
      dashboardUrl    : options.dashboardUrl,
      onFatalError    : options.onFatalError ?? (err => this.emit('fatal', err))
    });

    /** @type {WebSocket|null} */
    this._ws = null;
    this._reconnectAttempts = 0;

    /** @type {Set<Subject>} */
    this._subjects = new Set();

    /** @type {StateChangeEvent[]} */
    this._buffer = [];

    /** @type {NodeJS.Timeout|null} */
    this._flushTimer = null;

    /** Bindings for subject listeners so we can detach cleanly. */
    this._listeners = new Map();

    this._paused = false;

    // Kick off connection
    this._connect();
  }

  /* ---------------------------------------------------------------------- */
  /*  Public API                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Attach to a new subject to start receiving events.
   * @param {Subject} subject
   */
  attach (subject) {
    if (!subject?.emitter || !subject?.id) {
      throw new TypeError('Invalid subject: must have {emitter, id}');
    }
    if (this._subjects.has(subject)) return; // Already attached

    const listener = (event) => this._handleEvent(subject.id, event);
    subject.emitter.on('stateChange', listener);

    this._subjects.add(subject);
    this._listeners.set(subject.id, listener);
  }

  /**
   * Detach from a subject to stop receiving events.
   * @param {Subject} subject
   */
  detach (subject) {
    if (!this._subjects.has(subject)) return;

    const listener = this._listeners.get(subject.id);
    subject.emitter.off('stateChange', listener);

    this._subjects.delete(subject);
    this._listeners.delete(subject.id);
  }

  /**
   * Disconnect WebSocket and detach from all subjects.
   * Intended for graceful shutdown.
   */
  async close () {
    this._paused = true;
    clearTimeout(this._flushTimer);

    for (const subject of [...this._subjects]) {
      this.detach(subject);
    }

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      await new Promise(resolve => {
        this._ws.once('close', resolve);
        this._ws.close();
      });
    }
    this._ws = null;
  }

  /**
   * Pause event processing without disconnecting subjects.
   * Useful during deployments to avoid false-positive alerts.
   */
  pause () { this._paused = true; }

  /** Resume event processing. */
  resume () { 
    if (!this._paused) return;
    this._paused = false;
    this._scheduleFlush();
  }

  /* ---------------------------------------------------------------------- */
  /*  Internal — Event Handling                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Handle a single state-change event coming from a subject.
   * @param {string}              nodeId
   * @param {StateChangeEvent}    rawEvent
   * @private
   */
  _handleEvent (nodeId, rawEvent) {
    if (this._paused) return;

    const envelope = {
      ...rawEvent,
      nodeId,
      traceId  : rawEvent.traceId ?? uuidv4(),
      timestamp: rawEvent.timestamp ?? Date.now()
    };

    this._buffer.push(envelope);

    if (this._buffer.length >= this._options.maxBufferSize) {
      // Buffer at capacity, flush synchronously
      this._flushBuffer();
    }
  }

  /**
   * Schedule the next buffer flush if none is pending.
   * @private
   */
  _scheduleFlush () {
    if (this._flushTimer || this._paused) return;

    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flushBuffer();
    }, this._options.batchIntervalMs);
  }

  /**
   * Flush buffered events to the dashboard. Implements a minimal
   * back-pressure mechanism: if WebSocket is closed, we simply drop
   * the data (rather than blocking upstream services) and rely on
   * dashboard observers at other nodes to fill gaps.
   * @private
   */
  _flushBuffer () {
    if (this._buffer.length === 0) {
      this._scheduleFlush();
      return;
    }

    const payload = JSON.stringify({
      type     : 'stateChangeBatch',
      emittedAt: Date.now(),
      payload  : [...this._buffer]
    });
    this._buffer.length = 0; // clear

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(payload);
      } catch (err) {
        this.emit('error', err);
      }
    }
    // else drop silently

    this._scheduleFlush();
  }

  /* ---------------------------------------------------------------------- */
  /*  WebSocket Management                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Establish WebSocket connection with exponential back-off.
   * @private
   */
  _connect () {
    this._ws = new WebSocket(this._options.dashboardUrl);

    this._ws.on('open', () => {
      this._reconnectAttempts = 0;
      this.emit('connected');
      this._scheduleFlush();
    });

    this._ws.on('message', (data) => {
      // In future dashboards may send commands; ignore for now
      this.emit('message', data);
    });

    this._ws.on('close', (code, reason) => {
      this.emit('disconnected', { code, reason });
      this._attemptReconnect();
    });

    this._ws.on('error', (err) => {
      this.emit('error', err);
      // Error will trigger 'close' event; we let that handle reconnection
    });
  }

  /**
   * Attempt to reconnect with exponential backoff until maxReconnects
   * is reached.  If it fails permanently, call onFatalError callback.
   * @private
   */
  _attemptReconnect () {
    if (this._paused) return;
    if (this._reconnectAttempts >= this._options.maxReconnects) {
      const fatal = new Error('DashboardObserver: exceeded reconnect attempts');
      this._options.onFatalError(fatal);
      return;
    }

    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** this._reconnectAttempts,
      BACKOFF_MAX_MS
    );

    setTimeout(() => {
      this._reconnectAttempts += 1;
      this._connect();
    }, backoff);
  }
}

/* -------------------------------------------------------------------------- */
/*  Example Usage (commented out)                                             */
/* -------------------------------------------------------------------------- */
/*
import someRouter from '../core/MediaRouter'; // Emits 'stateChange'

const observer = new DashboardObserver({
  dashboardUrl: 'wss://dash.example.internal/feed'
});

observer.on('fatal', (err) => {
  console.error('Fatal observer error, exiting process', err);
  process.exit(1);
});

observer.attach({ id: someRouter.id, emitter: someRouter });

process.on('SIGTERM', () => observer.close());
*/
```