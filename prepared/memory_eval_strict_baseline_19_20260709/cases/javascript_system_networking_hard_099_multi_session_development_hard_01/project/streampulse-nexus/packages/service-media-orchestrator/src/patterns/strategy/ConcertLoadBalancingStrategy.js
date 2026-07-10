/**
 * StreamPulse Nexus
 * ------------------------------------------------------------
 * Load-balancing Strategy: ConcertLoadBalancingStrategy
 *
 * Purpose
 * -------
 * Implements a pluggable load-balancing algorithm that is optimised
 * for high-profile, low-latency live-concert streams.  The strategy
 * prioritises edge nodes that
 *
 *   1. have sufficient head-room (capacity – currentLoad)
 *   2. exhibit low RTT latency to the viewer
 *   3. are geographically near the viewer (to mitigate last-mile jitter)
 *   4. maintain heat-map fairness (avoid audience hotspots)
 *
 * The algorithm is a weighted-score ranking system whose weights can
 * be fine-tuned at runtime through dynamic configuration events.
 *
 * Usage
 * -----
 * const strategy = new ConcertLoadBalancingStrategy({
 *   nodeRegistry,
 *   metricsProvider,
 *   logger
 * });
 *
 * const chosenEdgeNode = await strategy.routeViewer(viewerCtx);
 *
 * Design Notes
 * ------------
 * - Strategy Pattern: implements `ILoadBalancingStrategy`
 * - EventEmitter: broadcasts selection decisions & configuration changes
 * - Defensive Programming: exhaustive validation & graceful degradation
 * - External deps kept minimal; haversine-distance is a tiny utility
 */

import { EventEmitter } from 'node:events';
import haversine from 'haversine-distance'; // lightweight geo util → npm i haversine-distance

// -------------------------------------------------------------------------
// Type Definitions (JSDoc) – helps editors/intellisense & TS consumers
// -------------------------------------------------------------------------

/**
 * @typedef {Object} GeoLocation
 * @property {number} latitude
 * @property {number} longitude
 */

/**
 * @typedef {Object} EdgeNode
 * @property {string} id                       Unique node identifier
 * @property {number} capacity                 Max concurrent streams
 * @property {number} currentLoad              Currently active streams
 * @property {number} avgRttMs                 Smoothed RTT (ms) from node to backbone
 * @property {GeoLocation} geo                 Physical/region coordinates
 * @property {boolean} isHealthy               Health-check status
 */

/**
 * @typedef {Object} ViewerContext
 * @property {string} viewerId                 UUID of viewer
 * @property {GeoLocation} geo                 Viewer geo-position
 * @property {number} expectedBitrate          kbps
 * @property {string} deviceType               desktop | mobile | tv | …
 * @property {boolean} premiumTier             VIP / Ultra-low latency product
 */

/**
 * @typedef {Object} StrategyConfig
 * @property {number} weightCapacity           Balance weight [0-1]
 * @property {number} weightLatency            Balance weight [0-1]
 * @property {number} weightGeoDistance        Balance weight [0-1]
 * @property {number} hotSpotThreshold         % load where node enters hot-spot penalty
 * @property {number} hotSpotPenalty           Penalty subtracted if above threshold
 */

const DEFAULT_CONFIG = Object.freeze({
  weightCapacity: 0.4,
  weightLatency: 0.35,
  weightGeoDistance: 0.25,
  hotSpotThreshold: 0.85,   // 85 % capacity considered hotspot
  hotSpotPenalty: 0.3       // subtract 0.3 from score if hotspot
});

// -------------------------------------------------------------------------
// ConcertLoadBalancingStrategy
// -------------------------------------------------------------------------

export default class ConcertLoadBalancingStrategy extends EventEmitter {
  /**
   * @param {Object} options
   * @param {import('../registry/NodeRegistry').default} options.nodeRegistry
   * @param {import('../metrics/MetricsProvider').default} options.metricsProvider
   * @param {import('../logging/Logger').default} [options.logger]
   * @param {Partial<StrategyConfig>}              [options.config]
   */
  constructor ({
    nodeRegistry,
    metricsProvider,
    logger = console,
    config = {}
  } = {}) {
    super();

    if (!nodeRegistry || !metricsProvider) {
      throw new Error('ConcertLoadBalancingStrategy requires nodeRegistry and metricsProvider');
    }

    /** @private */
    this._registry = nodeRegistry;
    /** @private */
    this._metrics = metricsProvider;
    /** @private */
    this._log = logger;

    /** @private */
    this._config = Object.assign({}, DEFAULT_CONFIG, config);

    // listen for dynamic config updates
    this.on('config:update', this._handleConfigUpdate.bind(this));
  }

  /**
   * Returns a healthy edge node for the viewer using the scoring algorithm.
   *
   * @param {ViewerContext} viewerCtx
   * @returns {Promise<EdgeNode>}
   * @throws {Error} if no suitable node can be found
   */
  async routeViewer (viewerCtx) {
    this._guardViewerCtx(viewerCtx);

    const candidateNodes = await this._registry.getAllEdges();

    // filter unhealthy nodes immediately
    const healthyNodes = candidateNodes.filter(n => n.isHealthy);
    if (!healthyNodes.length) {
      this._log.error('ConcertLB: No healthy nodes available');
      throw new Error('No healthy nodes');
    }

    // compute max values once to normalise metrics
    const maxCapacity = Math.max(...healthyNodes.map(n => n.capacity));
    const maxLatency  = Math.max(...healthyNodes.map(n => n.avgRttMs));

    const scored = healthyNodes
      .map(node => ({
        node,
        score: this._computeScore(node, viewerCtx, { maxCapacity, maxLatency })
      }))
      // order by highest score
      .sort((a, b) => b.score - a.score);

    const selected = scored[0];

    if (!selected || selected.score <= 0) {
      this._log.warn('ConcertLB: No node satisfied minimum score – falling back to random selection');
      return this._randomNode(healthyNodes);
    }

    // emit selection event
    this.emit('node:selected', {
      viewerId: viewerCtx.viewerId,
      nodeId:   selected.node.id,
      score:    selected.score
    });

    // Optional: record decision metrics
    void this._metrics.increment('lb.decisions', { strategy: 'concert' });

    return selected.node;
  }

  /**
   * Update weights/hotspot config at runtime.
   * @param {Partial<StrategyConfig>} patch
   */
  updateConfig (patch = {}) {
    this.emit('config:update', patch);
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  /**
   * Compute composite score for node
   * @param {EdgeNode} node
   * @param {ViewerContext} viewerCtx
   * @param {Object} max
   * @param {number} max.maxCapacity
   * @param {number} max.maxLatency
   * @returns {number} score 0-1
   * @private
   */
  _computeScore (node, viewerCtx, { maxCapacity, maxLatency }) {
    const {
      weightCapacity,
      weightLatency,
      weightGeoDistance,
      hotSpotThreshold,
      hotSpotPenalty
    } = this._config;

    // Normalised capacity invert load: more free capacity → better
    const loadRatio = node.currentLoad / node.capacity;          // 0-1
    const capacityScore = 1 - loadRatio;                         // 1-0

    // Normalised latency: lower latency → higher score
    const latencyScore = 1 - (node.avgRttMs / maxLatency);       // reasonable 0-1

    // Geo distance (km) normalised: closer → higher score
    const distanceKm = this._calcGeoDistanceKm(viewerCtx.geo, node.geo);
    // assume 20 000 km worst case round-earth; convert to 0-1
    const distanceScore = 1 - Math.min(distanceKm / 20000, 1);

    let composite =
      (capacityScore   * weightCapacity)   +
      (latencyScore    * weightLatency)    +
      (distanceScore   * weightGeoDistance);

    // Hot-spot penalty
    if (loadRatio >= hotSpotThreshold) {
      composite = composite - hotSpotPenalty;
    }

    // Bound score
    composite = Math.max(0, Math.min(1, composite));

    // Debug (verbose only in dev environments)
    /* istanbul ignore next */
    if (process.env.NODE_ENV !== 'production') {
      this._log.debug?.(`[LB-concert] node=${node.id} capacityScore=${capacityScore.toFixed(2)} latencyScore=${latencyScore.toFixed(2)} distanceScore=${distanceScore.toFixed(2)} → composite=${composite.toFixed(2)}`);
    }

    return composite;
  }

  /**
   * Validate incoming viewer context.
   * @private
   * @param {ViewerContext} ctx
   */
  _guardViewerCtx (ctx) {
    if (!ctx || typeof ctx !== 'object') { throw new TypeError('viewerCtx must be an object'); }
    if (!ctx.viewerId)                     { throw new Error('viewerCtx.viewerId required'); }
    if (!ctx.geo || typeof ctx.geo.latitude !== 'number' || typeof ctx.geo.longitude !== 'number') {
      throw new Error('viewerCtx.geo with latitude & longitude required');
    }
  }

  /**
   * @private
   * @param {GeoLocation} from
   * @param {GeoLocation} to
   * @returns {number} km
   */
  _calcGeoDistanceKm (from, to) {
    try {
      return haversine(
        { lat: from.latitude, lon: from.longitude },
        { lat: to.latitude,   lon: to.longitude }
      ) / 1000; // convert metres to km
    } catch (err) {
      this._log.warn('ConcertLB: Failed geo distance calculation, defaulting distance=∞', err);
      return Infinity;
    }
  }

  /**
   * Random healthy node fallback.
   * @private
   * @param {EdgeNode[]} nodes
   * @returns {EdgeNode}
   */
  _randomNode (nodes) {
    return nodes[Math.floor(Math.random() * nodes.length)];
  }

  /**
   * Handle dynamic configuration updates.
   * @param {Partial<StrategyConfig>} patch
   * @private
   */
  _handleConfigUpdate (patch = {}) {
    const before = { ...this._config };
    this._config = Object.assign({}, this._config, patch);

    this._log.info('ConcertLB: config updated', {
      before,
      after: this._config
    });

    // propagate change metric
    void this._metrics.increment('lb.config_updates', { strategy: 'concert' });
  }
}