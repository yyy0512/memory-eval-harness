```javascript
/**
 * StreamPulse Nexus – Media Orchestrator
 *
 * File: ingress.listener.js
 * Desc: Event-driven listener responsible for reacting to ingress-layer events
 *       (publishers connecting / disconnecting, media packet arrival, health
 *       pings, etc.).  The listener performs schema validation, basic security
 *       scanning, metrics emission, and hands off heavy-lifting to the
 *       IngressController so that the orchestration layer can take routing or
 *       transcoding decisions in near-real-time.
 *
 * NOTE:
 *   – This file purposely contains *no* framework-specific code so it can run
 *     in bare Node.js, a worker thread, or any message-broker consumer.
 *   – All dependencies referenced from “../..” exist elsewhere in the
 *     StreamPulse monorepo.  They are intentionally not mocked here.
 */

'use strict';

import EventEmitter       from 'events';
import Ajv                from 'ajv';
import addFormats         from 'ajv-formats';
import { v4 as uuidv4 }   from 'uuid';

import logger             from '../../utils/logger.js';
import metrics            from '../../utils/metrics.js';
import Config             from '../../config/index.js';
import SecurityScanner    from '../../security/security.scanner.js';
import { withTimeout }    from '../../utils/promise.js';

import IngressController  from '../../controllers/ingress.controller.js';
import { EVENT_NAMES }    from '../constants.js';

/* -------------------------------------------------------------------------- */
/*                               Local Helpers                                */
/* -------------------------------------------------------------------------- */

/**
 * Wrap any async listener handler to capture unhandled rejections
 * and forward them to the process-wide error channel.
 */
const safeHandler =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      logger.error({ err }, 'Unhandled error in IngressListener handler');
      process.emit('uncaughtException', err);
    }
  };

/* -------------------------------------------------------------------------- */
/*                           Schema Validators (AJV)                          */
/* -------------------------------------------------------------------------- */

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const PACKET_SCHEMA = {
  $id: 'https://streampulse.dev/schemas/ingress-packet.json',
  type: 'object',
  additionalProperties: false,
  required: ['streamId', 'seq', 'ts', 'payload'],
  properties: {
    streamId: { type: 'string', minLength: 1 },
    seq:      { type: 'integer', minimum: 0 },
    ts:       { type: 'number' },
    // We do not validate binary payload format at this layer; leave it opaque.
    payload:  { instanceof: 'Buffer' },
    metadata: { type: 'object' },
  },
};

const CONNECTION_SCHEMA = {
  $id: 'https://streampulse.dev/schemas/ingress-connection.json',
  type: 'object',
  additionalProperties: false,
  required: ['streamId', 'origin', 'codec', 'bitrate'],
  properties: {
    streamId: { type: 'string', minLength: 1 },
    origin:   { type: 'string' },
    codec:    { type: 'string' },
    bitrate:  { type: 'integer', minimum: 1 },
  },
};

const validatePacket     = ajv.compile(PACKET_SCHEMA);
const validateConnection = ajv.compile(CONNECTION_SCHEMA);

/* -------------------------------------------------------------------------- */
/*                               Event Listener                               */
/* -------------------------------------------------------------------------- */

class IngressListener extends EventEmitter {
  /**
   * @param {EventEmitter} eventBus – the global or service-scoped bus
   */
  constructor(eventBus) {
    super();

    if (!eventBus || typeof eventBus.on !== 'function') {
      throw new TypeError('eventBus must be an EventEmitter-like object');
    }

    this._bus  = eventBus;
    this._name = 'IngressListener';
    this._scanner = new SecurityScanner({
      maxPacketSize: Config.security.maxPacketSize,
    });

    this._controller = new IngressController(this._bus);

    this._isRunning = false;
  }

  /* ------------------------------- Public API ----------------------------- */

  /**
   * Bootstraps the listener, attaching handlers to the shared bus.
   */
  start() {
    if (this._isRunning) return;

    logger.info('%s starting…', this._name);

    this._bus.on(EVENT_NAMES.INGRESS.CONNECT,     safeHandler(this._onConnect));
    this._bus.on(EVENT_NAMES.INGRESS.DISCONNECT,  safeHandler(this._onDisconnect));
    this._bus.on(EVENT_NAMES.INGRESS.PACKET,      safeHandler(this._onPacket));
    this._bus.on(EVENT_NAMES.INGRESS.HEARTBEAT,   safeHandler(this._onHeartbeat));

    this._isRunning = true;
  }

  /**
   * Detaches all handlers so that the listener can be hot-reloaded safely.
   */
  stop() {
    if (!this._isRunning) return;

    logger.info('%s stopping…', this._name);

    this._bus.removeListener(EVENT_NAMES.INGRESS.CONNECT,    this._onConnect);
    this._bus.removeListener(EVENT_NAMES.INGRESS.DISCONNECT, this._onDisconnect);
    this._bus.removeListener(EVENT_NAMES.INGRESS.PACKET,     this._onPacket);
    this._bus.removeListener(EVENT_NAMES.INGRESS.HEARTBEAT,  this._onHeartbeat);

    this._isRunning = false;
  }

  /* ------------------------------- Handlers ------------------------------- */

  /**
   * Handle new publisher connection.
   *
   * @private
   * @param {Object} data – connection meta
   * @param {Function} [ack] – optional acknowledgement callback
   */
  _onConnect = async (data, ack = () => {}) => {
    const ctx = { reqId: uuidv4(), event: EVENT_NAMES.INGRESS.CONNECT };

    // Validate payload structure
    if (!validateConnection(data)) {
      logger.warn(
        { ...ctx, validationErrors: validateConnection.errors },
        'Invalid connection meta received',
      );
      return ack({ ok: false, reason: 'schema violation' });
    }

    // Security scanning (e.g., allowed origins)
    if (!this._scanner.isOriginAllowed(data.origin)) {
      logger.warn({ ...ctx, origin: data.origin }, 'Origin not allowed');
      return ack({ ok: false, reason: 'origin not allowed' });
    }

    logger.info({ ...ctx, streamId: data.streamId }, 'Ingress stream connected');
    metrics.increment('ingress.connections');

    await this._controller.registerStream(data);

    ack({ ok: true });
  };

  /**
   * Handle publisher disconnection.
   *
   * @private
   * @param {Object} data
   */
  _onDisconnect = async (data) => {
    const ctx = { event: EVENT_NAMES.INGRESS.DISCONNECT, streamId: data?.streamId };

    if (!data?.streamId) {
      logger.warn(ctx, 'Disconnect event missing streamId');
      return;
    }

    logger.info(ctx, 'Ingress stream disconnected');
    metrics.increment('ingress.disconnections');

    await this._controller.unregisterStream(data.streamId);
  };

  /**
   * Handle media packet arrival.
   *
   * @private
   * @param {Object} packet – packet payload
   */
  _onPacket = async (packet) => {
    const ctx = {
      event: EVENT_NAMES.INGRESS.PACKET,
      streamId: packet?.streamId,
      seq: packet?.seq,
    };

    // Quick sanity checks before doing anything expensive
    if (!validatePacket(packet)) {
      metrics.increment('ingress.packets.invalid');
      logger.debug(
        { ...ctx, validationErrors: validatePacket.errors },
        'Invalid packet received',
      );
      return;
    }

    // Security scanning (sync + cheap)
    if (!this._scanner.inspect(packet.payload)) {
      metrics.increment('ingress.packets.blocked');
      logger.warn(ctx, 'Packet failed security inspection; dropping');
      return;
    }

    // Forward to controller (may do async IO, heavy CPU)
    try {
      // Enforce a maximum processing time so we never clog the event loop
      await withTimeout(
        this._controller.ingestPacket(packet),
        Config.timeouts.ingestPacketMs,
      );
      metrics.increment('ingress.packets.processed');
    } catch (err) {
      metrics.increment('ingress.packets.error');
      logger.error({ ...ctx, err }, 'Failed to process packet');
    }
  };

  /**
   * Handle heartbeat/ping packets from publishers to detect QoS degradation.
   *
   * @private
   * @param {Object} data
   */
  _onHeartbeat = async (data) => {
    const ctx = {
      event: EVENT_NAMES.INGRESS.HEARTBEAT,
      streamId: data?.streamId,
      latencyMs: Date.now() - data.ts,
    };

    metrics.observe('ingress.heartbeat.latency', ctx.latencyMs);
    logger.trace(ctx, 'Heartbeat received');

    // Optionally update stream status in controller
    await this._controller.updateHeartbeat(data.streamId, ctx.latencyMs);
  };
}

/* -------------------------------------------------------------------------- */
/*                              Default Export                                */
/* -------------------------------------------------------------------------- */

export default IngressListener;
```