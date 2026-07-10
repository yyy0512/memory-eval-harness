```javascript
/**
 * @file EsportsLoadBalancingStrategy.js
 * @description
 *   A pluggable load–balancing strategy tailored for high-stakes e-sports
 *   broadcasts. The algorithm blends real-time cluster telemetry
 *   (CPU/GPU/RAM/network), audience heat-maps, and intra-region latency
 *   measurements to route new media sessions to the most suitable edge node.
 *
 *   This file is part of StreamPulse Nexus, an event-driven networking platform
 *   for interactive entertainment at massive scale.
 *
 * @author StreamPulse Nexus Core Team
 */

import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';          // Unique request IDs for traceability
import { TimeoutError, withTimeout } from '../utils/asyncHelpers.js'; // internal helper
import deepFreeze from '../utils/deepFreeze.js';                      // immutability helper

// ---------------------------------------------------------------------------
// Type Definitions (JSDoc)
//
// @typedef {Object} NodeMetrics
// @property {string}   id                - Unique node identifier
// @property {string}   region            - ISO-3166 region (e.g., "us-west")
// @property {number}   activeSessions    - Active media sessions
// @property {number}   cpu               - CPU load percentage   (0–100)
// @property {number}   gpu               - GPU load percentage   (0–100)
// @property {number}   bandwidthMbps     - Outbound bandwidth in Mbps
// @property {number}   avgLatencyMs      - Measured RTT to last 128 audience probes
// @property {number}   dropRatePpm       - Packet drop rate (parts per million)
// @property {Date}     ts                - Telemetry timestamp
//
// @typedef {Object} SessionContext
// @property {string}  viewerRegion       - ISO-3166 viewer region code
// @property {number}  expectedBitrate    - Anticipated bitrate in Mbps
// @property {boolean} lowLatencyMode     - Ultra-low latency toggle
// @property {Object}  [customTags]       - Arbitrary metadata
//
// ---------------------------------------------------------------------------

/**
 * Default scoring weights. Higher weight = stronger influence.
 * Can be overridden via constructor options.
 */
const DEFAULT_WEIGHTS = deepFreeze({
  capacity: 0.5,     // Node capacity & resource pressure
  latency:  0.3,     // Round-trip latency to viewer region
  heatMap:  0.2      // Current audience concentration in region
});

/**
 * Maximum number of concurrent scoring operations.
 * Prevents strategy from starving event-loop on burst traffic.
 */
const MAX_PARALLEL_SCORE = 32;

/**
 * @class EsportsLoadBalancingStrategy
 * @extends EventEmitter
 *
 * The strategy exposes two major public APIs:
 *   1. selectNodeForSession(ctx) -> Promise<NodeMetrics>
 *   2. updateHeatMap(region, audienceCount) -> void
 *
 * Additionally, it emits the following events:
 *   - "nodeSelected"  : { requestId, nodeId, score }
 *   - "selectionError": { requestId, error }
 */
export default class EsportsLoadBalancingStrategy extends EventEmitter {
  /**
   * @param {Object} params
   * @param {import('../registry/NodeRegistry.js').default} params.nodeRegistry
   *        Live view of available nodes & health scores.
   * @param {import('../telemetry/MetricsPublisher.js').default} params.metricsPublisher
   *        Publisher for push-based telemetry.
   * @param {import('pino').Logger} params.logger  - Structured logger instance.
   * @param {object} [params.weights]              - Override DEFAULT_WEIGHTS
   */
  constructor({ nodeRegistry, metricsPublisher, logger, weights = {} }) {
    super();

    if (!nodeRegistry || !metricsPublisher || !logger) {
      throw new TypeError('EsportsLoadBalancingStrategy: Missing dependencies');
    }

    this._nodeRegistry     = nodeRegistry;
    this._metricsPublisher = metricsPublisher;
    this._logger           = logger.child({ scope: 'EsportsLBStrategy' });

    this._weights = Object.freeze({ ...DEFAULT_WEIGHTS, ...weights });

    /** @type {Map<string, number>} */
    this._audienceHeatMap = new Map(); // region => viewer count

    // Pre-bind private methods for speed & safety
    this._scoreNode         = this._scoreNode.bind(this);
    this.updateHeatMap      = this.updateHeatMap.bind(this);
    this.selectNodeForSession = this.selectNodeForSession.bind(this);

    // Propagate internal errors to top-level listeners
    this.on('error', err => {
      this._logger.error({ err }, 'Unhandled error in EsportsLoadBalancingStrategy');
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Update the audience heat-map for a region. Invoked by analytics service.
   *
   * @param {string} region         - ISO-3166 region code
   * @param {number} viewerCount    - Number of concurrent viewers
   */
  updateHeatMap(region, viewerCount) {
    if (typeof region !== 'string' || typeof viewerCount !== 'number' || viewerCount < 0) {
      throw new TypeError('updateHeatMap expects (string region, positive number viewerCount)');
    }

    this._audienceHeatMap.set(region, viewerCount);
  }

  /**
   * Select an optimal node for an incoming media session.
   *
   * @param {SessionContext} sessionCtx
   * @param {number} [timeoutMs=800] – Hard selection timeout
   * @returns {Promise<NodeMetrics>} Selected node
   */
  async selectNodeForSession(sessionCtx, timeoutMs = 800) {
    const requestId = nanoid();

    try {
      const node = await withTimeout(
        this._pickBestNode(sessionCtx, requestId),
        timeoutMs,
        new TimeoutError(`LB timeout after ${timeoutMs} ms`)
      );

      this.emit('nodeSelected', { requestId, nodeId: node.id, score: node.__score });
      return node;
    } catch (err) {
      this.emit('selectionError', { requestId, error: err });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  /**
   * Core algorithm: fetch nodes, score each in parallel, return the best.
   *
   * @private
   * @param {SessionContext} sessionCtx
   * @param {string} requestId
   * @returns {Promise<NodeMetrics>}
   */
  async _pickBestNode(sessionCtx, requestId) {
    const nodes = await this._nodeRegistry.listHealthyNodes();

    if (!nodes.length) {
      throw new Error('No healthy nodes available');
    }

    // Limit concurrency to MAX_PARALLEL_SCORE
    const batches = [];
    for (let i = 0; i < nodes.length; i += MAX_PARALLEL_SCORE) {
      batches.push(nodes.slice(i, i + MAX_PARALLEL_SCORE));
    }

    let bestNode = null;
    for (const batch of batches) {
      const scored = await Promise.all(
        batch.map(node => this._scoreNode(node, sessionCtx))
      );

      for (const n of scored) {
        if (!bestNode || n.__score > bestNode.__score) {
          bestNode = n;
        }
      }
    }

    if (!bestNode) {
      throw new Error('Failed to evaluate nodes during load-balancing');
    }

    // Persist selection into registry (optimistic locking)
    await this._nodeRegistry.allocateSession(bestNode.id, sessionCtx).catch(err => {
      this._logger.warn({ err, nodeId: bestNode.id }, 'Allocation race detected. Retrying...');
      return this._pickBestNode(sessionCtx, requestId); // tail-recursion retry
    });

    // Push KPI for observability
    this._metricsPublisher.publish('lb.node.selected', {
      nodeId:  bestNode.id,
      score:   bestNode.__score,
      request: requestId,
      ts:      Date.now()
    });

    // Remove private scoring field before handing node to caller
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { __score, ...sanitizedNode } = bestNode;
    return sanitizedNode;
  }

  /**
   * Calculates a composite score for a node.
   *
   * Score range: 0.0 – 1.0 (higher = better)
   *
   * @private
   * @param {NodeMetrics} node
   * @param {SessionContext} sessionCtx
   * @returns {Promise<NodeMetrics & {__score: number}>}
   */
  async _scoreNode(node, sessionCtx) {
    // 1. Capacity factor -----------------------------------------------------
    //    Free capacity ratio inverted (lower load => higher score)
    const resourcePressure =
      (node.cpu + node.gpu) / 2 + (node.activeSessions / Math.max(node.bandwidthMbps, 1)) * 10;
    const capacityScore = 1 - Math.min(resourcePressure / 100, 1);

    // 2. Latency factor ------------------------------------------------------
    let latencyScore = 1;
    if (node.region === sessionCtx.viewerRegion) {
      latencyScore = 1;
    } else if (typeof node.avgLatencyMs === 'number') {
      latencyScore = 1 - Math.min(node.avgLatencyMs / 400, 1); // 400 ms worst-case
    }

    // 3. Heat-map factor -----------------------------------------------------
    const regionalViewers = this._audienceHeatMap.get(node.region) || 0;
    const totalViewers = [...this._audienceHeatMap.values()].reduce((a, b) => a + b, 0) || 1;
    const popularityRatio = regionalViewers / totalViewers;
    const heatMapScore = 1 - popularityRatio; // less crowded region preferred

    // Composite weighted score
    const totalScore =
      capacityScore * this._weights.capacity +
      latencyScore  * this._weights.latency  +
      heatMapScore  * this._weights.heatMap;

    return Object.assign({}, node, { __score: totalScore });
  }
}

// ---------------------------------------------------------------------------
// Private Utilities
// ---------------------------------------------------------------------------

// None for now – placeholder for future additions (e.g., geo distance cache)

```