```javascript
/**
 * @file LoadBalancingContext.js
 *
 * StreamPulse-Nexus – Media Orchestrator
 * --------------------------------------
 * A context object that encapsulates pluggable load-balancing strategies
 * (Strategy Pattern).  Down-stream services (ingress routers, edge nodes,
 * transcoders, analytics workers, etc.) depend on this component to decide
 * where traffic should be forwarded in real-time.
 *
 * The context:
 *   • keeps a registry of available strategies
 *   • exposes a simple API for selecting / registering strategies at runtime
 *   • emits lifecycle events so that dashboards & alerting systems can react
 *   • performs basic metrics collection for observability
 *
 * NOTE: In production this class would live in its own module and the concrete
 *       strategies would be imported from dedicated files.  For the sake of a
 *       self-contained example they are included at the bottom of this file.
 *
 * @license MIT (c) 2023-present StreamPulse Inc.
 */

'use strict';

/* ──────────────────────────────────────────────────────────────────────────*\
  Dependencies
\*────────────────────────────────────────────────────────────────────────── */
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

/* eslint-disable import/no-extraneous-dependencies */
const cloneDeep = require('lodash.clonedeep');

/* ──────────────────────────────────────────────────────────────────────────*\
  Constants & Utilities
\*────────────────────────────────────────────────────────────────────────── */
const DEFAULT_STRATEGY = 'roundRobin';
const METRIC_WINDOW_MS = 60_000; // 1 min

/**
 * Simple, nano-id style id generator.
 * @returns {string}
 */
function uid() {
  return crypto.randomUUID();
}

/* ──────────────────────────────────────────────────────────────────────────*\
  LoadBalancingContext
\*────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} Strategy
 * @property {string}  name
 * @property {boolean} [isAsync] – if true, selectNode returns a Promise
 * @property {(nodes: NodeInfo[], ctx: RequestContext) => (NodeInfo|Promise<NodeInfo>)}   selectNode
 */

/**
 * @typedef {Object} NodeInfo
 * @property {string} id          – unique identifier
 * @property {number} [weight]    – optional weight (0-1) for Weighted strategy
 * @property {number} [load]      – current CPU/network utilisation (0-1)
 * @property {number} [connections] – current active connections
 * @property {Object.<string, any>} [meta] – arbitrary metadata
 */

/**
 * @typedef {Object} RequestContext
 * @property {string} requestId
 * @property {string} mediaType        – 'video' | 'chat' | 'telemetry' | etc.
 * @property {number} audienceHotspot  – scaled 0-100 (used by custom algos)
 * @property {Object.<string, any>} [custom]
 */

class LoadBalancingContext extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Strategy[]} [opts.strategies] – pre-registered strategies
   * @param {string}     [opts.defaultStrategy] – fallback when none selected
   * @param {import('pino').BaseLogger} [opts.logger]
   */
  constructor(opts = {}) {
    super();

    const {
      strategies = [],
      defaultStrategy = DEFAULT_STRATEGY,
      logger = console, // default to console if caller did not inject logger
    } = opts;

    /** @private */
    this._logger = logger;

    /** @private */
    this._strategies = new Map();
    strategies.forEach((s) => this.registerStrategy(s));

    /** @private */
    this._current = defaultStrategy;

    if (!this._strategies.has(this._current)) {
      this._logger.warn(
        `[LoadBalancingContext] Default strategy "${this._current}" is not registered. Falling back to RoundRobin.`
      );
      this._strategies.set(DEFAULT_STRATEGY, new RoundRobinStrategy());
      this._current = DEFAULT_STRATEGY;
    }

    /** @private Metrics: Map<strategyName, {hits:number, totalMs:number}> */
    this._metrics = new Map();

    // reset metrics window every METRIC_WINDOW_MS
    setInterval(() => {
      this._exportAndResetMetrics();
    }, METRIC_WINDOW_MS).unref();
  }

  /* ───────────────────────────────────────────── public API ───────────── */

  /**
   * Balance the given request across provided nodes.
   *
   * @param {RequestContext} reqCtx
   * @param {NodeInfo[]}     nodes
   * @returns {Promise<NodeInfo>} – resolved immediately for sync strategies
   */
  async balance(reqCtx, nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('LoadBalancingContext.balance(): nodes array is empty.');
    }

    // Defensive copy to avoid unexpected mutations by strategies
    const nodesCopy = cloneDeep(nodes);
    const strategy = this._strategies.get(this._current);

    if (!strategy) {
      throw new Error(
        `Attempted to use unknown load-balancing strategy "${this._current}".`
      );
    }

    const startTime = performance.now();
    try {
      const node = strategy.isAsync
        ? await strategy.selectNode(nodesCopy, reqCtx)
        : strategy.selectNode(nodesCopy, reqCtx);

      if (!node || typeof node !== 'object') {
        throw new Error(
          `Strategy "${strategy.name}" returned invalid node "${node}".`
        );
      }

      this._recordMetrics(strategy.name, performance.now() - startTime);

      this.emit('nodeSelected', {
        requestId: reqCtx.requestId,
        strategy: strategy.name,
        nodeId: node.id,
      });

      return node;
    } catch (err) {
      this._logger.error(
        { err, strategy: strategy.name },
        '[LoadBalancingContext] strategy error'
      );

      this._recordMetrics(strategy.name, performance.now() - startTime, true);
      this.emit('strategyError', { err, strategy: strategy.name });

      // Fallback: pick first healthy node (here we just choose random)
      const fallbackNode = nodesCopy[Math.floor(Math.random() * nodesCopy.length)];
      this.emit('fallback', {
        requestId: reqCtx.requestId,
        strategy: strategy.name,
        nodeId: fallbackNode.id,
      });

      return fallbackNode;
    }
  }

  /**
   * Register or replace a strategy at runtime.
   * @param {Strategy} strategy
   */
  registerStrategy(strategy) {
    if (!strategy?.name || typeof strategy.selectNode !== 'function') {
      throw new TypeError(
        'registerStrategy() expects { name<String>, selectNode<Function> }'
      );
    }
    this._strategies.set(strategy.name, strategy);
    this._logger.info(
      `[LoadBalancingContext] Registered strategy "${strategy.name}"`
    );
  }

  /**
   * Remove a previously registered strategy.
   * @param {string} name
   */
  unregisterStrategy(name) {
    if (name === this._current) {
      throw new Error('Cannot unregister currently active strategy.');
    }
    this._strategies.delete(name);
    this._logger.info(`[LoadBalancingContext] Unregistered strategy "${name}"`);
  }

  /**
   * Switch active strategy.
   * @param {string} name
   */
  setStrategy(name) {
    if (!this._strategies.has(name)) {
      throw new Error(`Strategy "${name}" is not registered.`);
    }
    const prev = this._current;
    this._current = name;
    this.emit('strategyChanged', { from: prev, to: name });
    this._logger.info(
      `[LoadBalancingContext] Switched strategy from "${prev}" to "${name}"`
    );
  }

  /**
   * Return name of current strategy.
   * @returns {string}
   */
  getStrategy() {
    return this._current;
  }

  /**
   * Get a snapshot of metrics since last interval reset.
   * @returns {Array<{name: string, hits: number, errors:number, p99:number, avgMs:number}>}
   */
  getMetrics() {
    return Array.from(this._metrics.entries()).map(([name, d]) => ({
      name,
      hits: d.hits,
      errors: d.errors,
      p99: percentile(d.durations, 0.99),
      avgMs: d.hits === 0 ? 0 : d.durations.reduce((a, b) => a + b, 0) / d.hits,
    }));
  }

  /* ────────────────────────────────────────── private helpers ─────────── */

  /**
   * @private
   */
  _recordMetrics(name, durationMs, errored = false) {
    if (!this._metrics.has(name)) {
      this._metrics.set(name, {
        hits: 0,
        errors: 0,
        durations: [],
      });
    }
    const m = this._metrics.get(name);
    m.hits += 1;
    if (errored) m.errors += 1;
    m.durations.push(durationMs);
  }

  /**
   * @private Export metrics and reset.  In production this would push to Prometheus, etc.
   */
  _exportAndResetMetrics() {
    const snapshot = this.getMetrics();
    if (snapshot.length) {
      this._logger.debug(
        { snapshot },
        '[LoadBalancingContext] strategy performance window'
      );
    }
    this._metrics.clear();
  }
}

/* ──────────────────────────────────────────────────────────────────────────*\
  Built-in Strategies (simplified reference implementations)
\*────────────────────────────────────────────────────────────────────────── */

/**
 * Round-Robin: cycles through nodes sequentially.
 */
class RoundRobinStrategy {
  constructor() {
    this.name = 'roundRobin';
    this._idx = 0;
    this.isAsync = false;
  }

  /**
   * @param {NodeInfo[]} nodes
   * @returns {NodeInfo}
   */
  selectNode(nodes) {
    if (this._idx >= nodes.length) this._idx = 0;
    const node = nodes[this._idx];
    this._idx += 1;
    return node;
  }
}

/**
 * Least-Connections: selects node with smallest active connection count.
 */
class LeastConnectionsStrategy {
  constructor() {
    this.name = 'leastConnections';
    this.isAsync = false;
  }

  selectNode(nodes /*, ctx */) {
    return nodes.reduce((best, node) =>
      !best || node.connections < best.connections ? node : best
    );
  }
}

/**
 * Weighted-Random: distributes according to relative weights.
 */
class WeightedRandomStrategy {
  constructor() {
    this.name = 'weightedRandom';
    this.isAsync = false;
  }

  selectNode(nodes) {
    const totalWeight = nodes.reduce(
      (sum, node) => sum + (node.weight ?? 1),
      0
    );
    let rand = Math.random() * totalWeight;
    for (const node of nodes) {
      rand -= node.weight ?? 1;
      if (rand <= 0) return node;
    }
    return nodes[0];
  }
}

/**
 * Example async strategy that consults an external scoring service.
 */
class ExternalScoreStrategy {
  constructor({ scorerClient }) {
    this.name = 'externalScore';
    this.isAsync = true;
    this._scorer = scorerClient; // expects scorerClient.score(nodes) -> Promise<NodeInfo>
  }

  async selectNode(nodes, reqCtx) {
    return this._scorer.score(nodes, reqCtx);
  }
}

/* ──────────────────────────────────────────────────────────────────────────*\
  Helper functions
\*────────────────────────────────────────────────────────────────────────── */

/**
 * Calculate percentile in an array of numbers.
 * @param {number[]} arr
 * @param {number} p - 0-1
 */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

/* ──────────────────────────────────────────────────────────────────────────*\
  Module exports
\*────────────────────────────────────────────────────────────────────────── */

module.exports = {
  LoadBalancingContext,
  strategies: {
    RoundRobinStrategy,
    LeastConnectionsStrategy,
    WeightedRandomStrategy,
    ExternalScoreStrategy,
  },
};
```