```javascript
// File: streampulse-nexus/packages/service-media-orchestrator/src/core/StreamManager.js

/**
 * StreamPulse Nexus – StreamManager
 *
 * The StreamManager sits at the heart of the media–orchestration layer.
 * It maintains the lifecycle of a single logical “Stream” across an
 * ever-shifting sea of ingress / egress nodes, applying custom
 * load-balancing strategies, forwarding operational telemetry to the
 * metrics pipeline and surfacing domain events to interested observers.
 *
 * Architectural patterns employed:
 *   • Strategy      – Pluggable load-balancer implementations
 *   • Observer      – Outgoing “state” and “metric” events
 *   • Command       – Runtime control plane integration
 *   • Chain-of-Resp – Resilient command execution across cluster
 *   • Event-Driven  – Health & Telemetry bus
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import Logger from '../utils/Logger.js';
import { loadStrategy } from '../strategies/registry.js';
import {
  HealthEvents,
  healthBus,
  /** @typedef {import('../health/HealthMonitor.js').NodeHealthPayload} NodeHealthPayload */
} from '../health/HealthMonitor.js';
import { commandBus } from '../control-plane/CommandBus.js';
import {
  StreamCommandTypes,
  /** @typedef {import('../control-plane/commands.js').BaseStreamCommand} BaseStreamCommand */
} from '../control-plane/commands.js';
import {
  MetricsCollector,
  /** @typedef {import('../metrics/MetricsCollector.js').MetricPayload} MetricPayload */
} from '../metrics/MetricsCollector.js';

/**
 * @typedef {Object} StreamManagerOptions
 * @property {string}                       streamId           – Unique stream identifier
 * @property {readonly string[]}            ingressEndpoints   – Candidate ingress node IDs
 * @property {readonly string[]}            egressEndpoints    – Candidate egress node IDs
 * @property {string}                       strategy           – Registered load-balancing strategy key
 * @property {MetricsCollector}             metricsCollector   – Metrics collector implementation
 * @property {number}                       rebalanceInterval  – How often (ms) to re-evaluate load distribution
 * @property {number}                       healthTimeout      – How long (ms) to wait before failing an unhealthy node
 * @property {AbortSignal}                  [abortSignal]      – External abort controller
 */

export const StreamManagerEvents = Object.freeze({
  START: 'stream:start',
  STOP: 'stream:stop',
  REBALANCE: 'stream:rebalance',
  FAILOVER: 'stream:failover',
  ERROR: 'stream:error',
});

/**
 * Custom domain error
 */
export class StreamManagerError extends Error {
  constructor(message, cause) {
    super(`[StreamManager] ${message}`);
    this.name = 'StreamManagerError';
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, StreamManagerError);
  }
}

/**
 * Manages the lifecycle of a single streaming session.
 */
export default class StreamManager extends EventEmitter {
  /** @type {string} */
  #id;

  /** @type {import('../strategies/base.js').LoadBalancingStrategy} */
  #strategy;

  #logger;
  #metrics;
  #state = {
    ingress: /** @type {string|null} */ (null),
    egress: /** @type {string[]} */ ([]), // fan-out for edge nodes
    started: false,
    closed: false,
  };

  /** @type {NodeJS.Timeout|null} */
  #rebalanceTimer = null;

  /** @type {number} */
  #rebalanceInterval;

  /** @type {number} */
  #healthTimeout;

  /** @type {AbortController} */
  #abortController;

  /**
   * @param {StreamManagerOptions} options
   */
  constructor(options) {
    super();
    if (!options) {
      throw new StreamManagerError('Options must be supplied');
    }

    this.#id = options.streamId || randomUUID();
    this.#logger = Logger.child({ scope: 'StreamManager', streamId: this.#id });
    this.#metrics = options.metricsCollector;
    this.#rebalanceInterval = options.rebalanceInterval ?? 15_000;
    this.#healthTimeout = options.healthTimeout ?? 5_000;
    this.#abortController = new AbortController();

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () =>
        this.#abortController.abort(),
      );
    }

    // Resolve the strategy implementation dynamically
    this.#strategy = loadStrategy(options.strategy, {
      ingressCandidates: options.ingressEndpoints,
      egressCandidates: options.egressEndpoints,
      logger: this.#logger,
    });

    // Wire health event consumption
    healthBus.on(
      HealthEvents.NODE_HEALTH,
      /** @param {NodeHealthPayload} payload */ (payload) => {
        this.#handleHealthUpdate(payload).catch((err) =>
          this.#emitError('Health handler error', err),
        );
      },
    );

    // Wire command consumption
    commandBus.on(
      this.#id,
      /** @param {BaseStreamCommand} cmd */ (cmd) => {
        this.#executeCommand(cmd).catch((err) =>
          this.#emitError('Command execution error', err),
        );
      },
    );
  }

  /**
   * Start stream orchestration.
   */
  async start() {
    if (this.#state.started) return;

    this.#logger.info('Starting StreamManager…');
    try {
      await this.#allocateInitialNodes();

      this.#state.started = true;
      this.emit(StreamManagerEvents.START, { streamId: this.#id });

      this.#scheduleRebalance();
    } catch (err) {
      this.#emitError('Failed to start stream', err);
      throw err;
    }
  }

  /**
   * Trigger a graceful shutdown.
   * No new data is accepted and existing resources will be released.
   */
  async shutdown() {
    if (this.#state.closed) return;
    this.#logger.info('Shutting down StreamManager…');
    clearTimeout(this.#rebalanceTimer);
    this.#abortController.abort();

    // TODO: actual teardown (closing sockets, closing channels etc.)
    await delay(300); // simulate teardown latency

    this.#state.closed = true;
    this.emit(StreamManagerEvents.STOP, { streamId: this.#id });
  }

  /**
   * ---------------------------------------------------------------------
   *                            Private Helpers
   * ---------------------------------------------------------------------
   */

  /**
   * Allocate initial ingress + egress nodes using the strategy.
   */
  async #allocateInitialNodes() {
    this.#logger.debug('Selecting initial nodes via strategy…');
    const { ingress, egress } = await this.#strategy.selectInitialNodes();
    if (!ingress || egress.length === 0) {
      throw new StreamManagerError(
        'Strategy returned no viable ingress/egress nodes',
      );
    }
    await this.#bindIngress(ingress);
    await this.#bindEgress(egress);
  }

  /**
   * Bind an ingress node.
   * @param {string} nodeId
   */
  async #bindIngress(nodeId) {
    // pretend we open an RTP/RTMP tunnel
    this.#logger.info({ nodeId }, 'Binding ingress node');
    this.#state.ingress = nodeId;
    this.#metrics.increment('stream.ingress.bound', { nodeId });
  }

  /**
   * Bind egress nodes (fan-out).
   * @param {readonly string[]} nodeIds
   */
  async #bindEgress(nodeIds) {
    this.#logger.info({ nodeIds }, 'Binding egress nodes');
    this.#state.egress = [...nodeIds];
    this.#metrics.increment('stream.egress.bound', {
      count: nodeIds.length,
    });
  }

  /**
   * Schedule periodic re-evaluation of node distribution.
   */
  #scheduleRebalance() {
    if (this.#rebalanceInterval <= 0) return;

    this.#rebalanceTimer = setInterval(async () => {
      try {
        await this.#rebalance();
      } catch (err) {
        this.#emitError('Rebalance error', err);
      }
    }, this.#rebalanceInterval).unref();
  }

  /**
   * Evaluate whether load balancing warrants a change in node assignment.
   */
  async #rebalance() {
    this.#logger.debug('Running rebalance cycle…');
    const plan = await this.#strategy.rebalance({
      currentIngress: this.#state.ingress,
      currentEgress: this.#state.egress,
    });

    if (!plan.changed) {
      this.#logger.debug('No rebalance changes necessary');
      return;
    }

    // Apply ingress switch (failover)
    if (plan.newIngress && plan.newIngress !== this.#state.ingress) {
      await this.#bindIngress(plan.newIngress);
      this.emit(StreamManagerEvents.FAILOVER, {
        streamId: this.#id,
        previousIngress: this.#state.ingress,
        newIngress: plan.newIngress,
      });
    }

    // Apply egress changes (scale-up / down)
    if (plan.newEgress) {
      await this.#bindEgress(plan.newEgress);
    }

    this.emit(StreamManagerEvents.REBALANCE, {
      streamId: this.#id,
      ingress: this.#state.ingress,
      egress: this.#state.egress,
    });
  }

  /**
   * React to cluster health changes.
   * @param {NodeHealthPayload} payload
   */
  async #handleHealthUpdate(payload) {
    const { nodeId, status } = payload;
    if (status !== 'UNHEALTHY') return;

    const affected =
      nodeId === this.#state.ingress || this.#state.egress.includes(nodeId);
    if (!affected) return;

    this.#logger.warn(
      { nodeId },
      'Node unhealthy – triggering immediate rebalance',
    );

    // Temporarily shorten rebalance interval for rapid response
    await this.#rebalance();

    // If node remains unhealthy beyond timeout, disconnect it
    await delay(this.#healthTimeout, null, {
      signal: this.#abortController.signal,
    }).catch(() => {}); // ignore abort
    if (payload.status === 'UNHEALTHY') {
      this.#strategy.markNodeUnhealthy(nodeId);
    }
  }

  /**
   * Execute inbound control plane command.
   * @param {BaseStreamCommand} cmd
   */
  async #executeCommand(cmd) {
    switch (cmd.type) {
      case StreamCommandTypes.STREAM_STOP:
        await this.shutdown();
        break;

      case StreamCommandTypes.STREAM_FORCE_REBALANCE:
        await this.#rebalance();
        break;

      default:
        this.#logger.warn({ cmd }, 'Unknown command received');
        this.#metrics.increment('stream.command.unknown', { type: cmd.type });
    }
  }

  /**
   * Unified error propagation
   * @param {string} contextMsg
   * @param {unknown} err
   */
  #emitError(contextMsg, err) {
    const wrapped =
      err instanceof StreamManagerError
        ? err
        : new StreamManagerError(contextMsg, err);
    this.#logger.error({ err: wrapped }, wrapped.message);
    this.emit(StreamManagerEvents.ERROR, wrapped);
  }

  /**
   * ---------------------------------------------------------------------
   *                            Public getters
   * ---------------------------------------------------------------------
   */

  /**
   * @returns {string}
   */
  get streamId() {
    return this.#id;
  }

  /**
   * @returns {{ ingress: string|null, egress: readonly string[] }}
   */
  get endpoints() {
    return { ingress: this.#state.ingress, egress: Object.freeze(this.#state.egress) };
  }

  /**
   * @returns {boolean}
   */
  get isRunning() {
    return this.#state.started && !this.#state.closed;
  }
}
```