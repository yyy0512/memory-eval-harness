```javascript
/**
 * streampulse-nexus/packages/service-ingress-gateway/src/controllers/webrtc.controller.js
 *
 * Controller responsible for handling WebRTC signalling between viewers and the
 * StreamPulse ingress-gateway.  It exposes an Express router with a minimal REST
 * signalling API—offer, answer, ICE candidates, and teardown—while publishing
 * internal events that can be consumed by analytics, monitoring, or load-
 * balancing subsystems.
 *
 *  ┌────────────────────────┐
 *  │  Viewer (Browser)      │
 *  │   └── REST /offer ─────►  Ingress-Gateway (this file)
 *  │   ◄── REST /answer ────┘
 *  └────────────────────────┘
 *
 * The controller demonstrates several architectural patterns used in
 * StreamPulse-Nexus:
 *   • Observer / EventEmitter for broadcasting peer state.
 *   • Strategy pattern (ice server strategy injection).
 *   • Circuit-breaker (opossum) for resiliency when publishing analytics.
 *   • Prometheus instrumentation for runtime observability.
 *
 * NOTE:  The in-memory session map is sufficient for a single instance.  In
 *        production, a distributed cache (Redis, etcd) and sticky-sessions or a
 *        rendezvous mechanism would be required.
 */

'use strict';

/* ──────────────────────────────────────────────────────────────────────────── */
/* Dependencies                                                                */
/* ──────────────────────────────────────────────────────────────────────────── */
const { Router } = require('express');
const { RTCPeerConnection, RTCSessionDescription } = require('wrtc');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const CircuitBreaker = require('opossum');
const Joi = require('joi');
const merge = require('lodash.merge');

const logger = require('../utils/logger');              // pino-based logger
const metrics = require('../utils/metrics');            // prom-client wrapper
const config = require('../config');                    // typed-config utility
const analyticsPublisher = require('../services/analytics.publisher'); // AMQP/Kafka stub

/* ──────────────────────────────────────────────────────────────────────────── */
/* Metrics                                                                     */
/* ──────────────────────────────────────────────────────────────────────────── */
const sessionGauge = metrics.gauge({
  name  : 'webrtc_active_sessions',
  help  : 'Number of active WebRTC sessions held by this gateway instance',
});

const offerCounter = metrics.counter({
  name  : 'webrtc_offers_total',
  help  : 'Number of SDP offers received',
});

const candidateCounter = metrics.counter({
  name  : 'webrtc_remote_candidates_total',
  help  : 'Number of remote ICE candidates received',
});

/* ──────────────────────────────────────────────────────────────────────────── */
/* Validation Schemas                                                          */
/* ──────────────────────────────────────────────────────────────────────────── */
const schemas = {
  offer: Joi.object({
    sdp : Joi.string().required(),
    type: Joi.string().valid('offer').required(),
  }),

  candidate: Joi.object({
    candidate     : Joi.string().required(),
    sdpMid        : Joi.string().allow(null),
    sdpMLineIndex : Joi.number().integer().allow(null),
    sessionId     : Joi.string().guid().required(),
  }),
};

/* ──────────────────────────────────────────────────────────────────────────── */
/* Helper functions                                                            */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Builds an RTCPeerConnection with ICE configuration sourced from
 * runtime config and optional overrides.
 *
 * Strategy pattern: allow runtime injection of custom ICE server strategy.
 *
 * @param {object} [overrides]
 * @returns {RTCPeerConnection}
 */
function createPeerConnection(overrides = {}) {
  const rtcConfig = merge(
    {
      iceServers: config.get('webrtc.iceServers', [
        { urls: 'stun:stun.l.google.com:19302' },
      ]),
      sdpSemantics: 'unified-plan',
    },
    overrides,
  );

  return new RTCPeerConnection(rtcConfig);
}

/**
 * Asynchronously waits for ICE gathering to complete before returning the
 * final local description.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<RTCSessionDescriptionInit>}
 */
function waitForIceGathering(pc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('ICE gathering timeout')),
      config.get('webrtc.iceGatheringTimeoutMs', 5000),
    );

    if (pc.iceGatheringState === 'complete') {
      clearTimeout(timeout);
      return resolve(pc.localDescription);
    }

    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve(pc.localDescription);
      }
    });
  });
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Internal State & Observer                                                   */
/* ──────────────────────────────────────────────────────────────────────────── */

class WebRtcSessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  /**
   * Creates a new session entry and returns its ID
   *
   * @param {RTCPeerConnection} pc
   * @returns {string} sessionId (uuid)
   */
  register(pc) {
    const id = uuidv4();
    this.sessions.set(id, pc);
    sessionGauge.set(this.sessions.size);

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      logger.debug({ id, state }, 'Connection state changed');

      this.emit('state', { id, state });

      if (['disconnected', 'closed', 'failed'].includes(state)) {
        this.unregister(id);
      }
    });

    return id;
  }

  /**
   * Returns a peer connection for the given session ID.
   *
   * @param {string} id
   * @returns {RTCPeerConnection|undefined}
   */
  get(id) {
    return this.sessions.get(id);
  }

  /**
   * Tears down and removes a session
   *
   * @param {string} id
   */
  unregister(id) {
    const pc = this.sessions.get(id);
    if (!pc) return;

    try { pc.close(); }
    // eslint-disable-next-line no-empty
    catch (_) { /* ignore */ }

    this.sessions.delete(id);
    sessionGauge.set(this.sessions.size);

    this.emit('closed', { id });
  }
}

const sessionManager = new WebRtcSessionManager();

/* ──────────────────────────────────────────────────────────────────────────── */
/* Analytics Circuit Breaker                                                   */
/* ──────────────────────────────────────────────────────────────────────────── */
const analyticsBreaker = new CircuitBreaker(
  payload => analyticsPublisher.publish('webrtc.session', payload),
  {
    timeout                : 2000,
    errorThresholdPercentage: 35,
    resetTimeout           : 10_000,
  },
);

analyticsBreaker.on('open',  () => logger.warn('Analytics circuit opened'));
analyticsBreaker.on('close', () => logger.info('Analytics circuit closed'));

/* ──────────────────────────────────────────────────────────────────────────── */
/* Express Router                                                              */
/* ──────────────────────────────────────────────────────────────────────────── */

const router = Router();

/* -------------------------------------------------------------------------- */
/* POST /webrtc/offer                                                         */
/* -------------------------------------------------------------------------- */
router.post('/offer', async (req, res, next) => {
  offerCounter.inc();

  try {
    const { error, value } = schemas.offer.validate(req.body, { stripUnknown: true });
    if (error) {
      error.statusCode = 400;
      throw error;
    }

    const remoteOffer = value;

    /* 1. Create peer connection with configured ICE servers */
    const pc = createPeerConnection();

    /* 2. Register session BEFORE async awaits */
    const sessionId = sessionManager.register(pc);

    /* 3. Install media / data channel handlers */
    pc.addEventListener('datachannel', evt => {
      logger.info({ sessionId }, 'DataChannel created: %s', evt.channel.label);
    });

    /* 4. Set remote description (offer) */
    await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));

    /* 5. Create answer */
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    /* 6. Wait for ICE gathering complete */
    const localDesc = await waitForIceGathering(pc);

    /* 7. Publish session-created analytics (fire-and-forget) */
    analyticsBreaker.fire({ event: 'created', sessionId }).catch(() => {});

    /* 8. Respond to the caller */
    res.status(201).json({
      sessionId,
      answer: {
        type: localDesc.type,
        sdp : localDesc.sdp,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to handle /offer');
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* POST /webrtc/candidate                                                     */
/* -------------------------------------------------------------------------- */
router.post('/candidate', async (req, res, next) => {
  candidateCounter.inc();

  try {
    const { error, value } = schemas.candidate.validate(req.body, { stripUnknown: true });
    if (error) {
      error.statusCode = 400;
      throw error;
    }

    const { sessionId, ...candidateInit } = value;
    const pc = sessionManager.get(sessionId);

    if (!pc) {
      return res.status(404).json({ message: 'Unknown sessionId' });
    }

    await pc.addIceCandidate(candidateInit);

    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'Failed to handle /candidate');
    next(err);
  }
});

/* -------------------------------------------------------------------------- */
/* DELETE /webrtc/:sessionId                                                  */
/* -------------------------------------------------------------------------- */
router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const pc = sessionManager.get(sessionId);
  if (!pc) {
    return res.status(404).json({ message: 'Unknown sessionId' });
  }

  sessionManager.unregister(sessionId);
  analyticsBreaker.fire({ event: 'closed', sessionId }).catch(() => {});

  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* GET /webrtc/health                                                         */
/* Simple health-check endpoint used by the edge-orchestrator                 */
/* -------------------------------------------------------------------------- */
router.get('/health', (_req, res) => {
  res.json({
    status  : 'ok',
    sessions: sessionManager.sessions.size,
    circuit : analyticsBreaker.status.stats,
  });
});

/* ──────────────────────────────────────────────────────────────────────────── */
/* Error Middleware (local to this router)                                     */
/* ──────────────────────────────────────────────────────────────────────────── */
router.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  res.status(status).json({
    message: status === 500 ? 'Internal Server Error' : err.message,
  });
});

module.exports = router;
```
