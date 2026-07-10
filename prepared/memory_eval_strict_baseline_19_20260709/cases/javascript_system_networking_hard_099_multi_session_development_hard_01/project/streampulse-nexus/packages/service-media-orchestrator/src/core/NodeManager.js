```javascript
/**
 * StreamPulse Nexus – Node Manager
 * =================================
 * This module is responsible for registering, monitoring, and commanding
 * streaming nodes that participate in an active media orchestration cluster.
 *
 * Architectural patterns leveraged:
 *   • Observer (EventEmitter)………………………………………… broadcasts node-state changes
 *   • Strategy ……………………………………………………………… pluggable load-balancing algorithm
 *   • Command / Chain of Responsibility …………… secure command dispatch
 *
 * @file packages/service-media-orchestrator/src/core/NodeManager.js
 * @author StreamPulse
 */

'use strict';

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_HEARTBEAT_TIMEOUT = 10_000; // 10 s without heartbeat ⇒ unhealthy
const MONITOR_INTERVAL          = 3_000;  // health-monitor frequency
const STATE_SNAPSHOT_FILE       = '/var/lib/streampulse/nodes.json';

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to read JSON from a file. Returns fallback on error.
 * @param {string} filePath
 * @param {any}    fallback
 */
async function readJsonSafe(filePath, fallback = {}) {
  try {
    await access(filePath, FS_CONSTANTS.R_OK);
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Safely persist JSON to disk, swallowing I/O errors (non-critical path).
 * @param {string} filePath
 * @param {object} data
 */
async function writeJsonSafe(filePath, data) {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[NodeManager] Failed to persist state: ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Command chain-of-responsibility                                            */
/* -------------------------------------------------------------------------- */

class CommandContext {
  /**
   * @param {object} node
   * @param {object} command
   * @param {AbortSignal} [signal]
   */
  constructor(node, command, signal) {
    this.node    = node;
    this.command = command;
    this.signal  = signal;
  }
}

/**
 * Abstract handler.
 * @template {CommandHandler} T
 */
class CommandHandler {
  /**
   * @param {CommandHandler} next
   * @returns {CommandHandler}
   */
  setNext(next) {
    this.next = next;
    return next;
  }

  /**
   * @param {CommandContext} ctx
   * @returns {Promise<any>}
   */
  // eslint-disable-next-line class-methods-use-this
  async handle(ctx) {
    if (this.next) return this.next.handle(ctx);
    throw new Error('Terminal handler reached with no result.');
  }
}

/**
 * Ensure node exists & is healthy.
 */
class ValidationHandler extends CommandHandler {
  async handle(ctx) {
    if (!ctx.node) throw new Error('Target node not found.');
    if (ctx.node.status !== 'healthy') {
      throw new Error(`Node ${ctx.node.id} is not healthy (${ctx.node.status}).`);
    }
    return super.handle(ctx);
  }
}

/**
 * Lightweight security scanning.
 */
class SecurityHandler extends CommandHandler {
  async handle(ctx) {
    // Example threat-detection stub
    if (typeof ctx.command.type !== 'string' || !ctx.command.type.length) {
      throw new Error('Malformed command.');
    }
    // Potentially inspect ctx.command.payload for policy violations…
    return super.handle(ctx);
  }
}

/**
 * Execute command – in real life, this would be a network gRPC/HTTP call.
 */
class ExecutionHandler extends CommandHandler {
  async handle(ctx) {
    // Simulated network latency
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Fake response
    return { ok: true, node: ctx.node.id, echo: ctx.command };
  }
}

/* -------------------------------------------------------------------------- */
/* Strategy utilities                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Built-in round-robin selection strategy.
 * @param {Array<object>} nodes list of healthy nodes
 * @returns {object|null}
 */
function roundRobinStrategy(nodes) {
  if (!roundRobinStrategy._cursor) roundRobinStrategy._cursor = 0;
  if (!nodes.length) return null;
  const node = nodes[roundRobinStrategy._cursor % nodes.length];
  roundRobinStrategy._cursor += 1;
  return node;
}

/* -------------------------------------------------------------------------- */
/* NodeManager                                                                */
/* -------------------------------------------------------------------------- */

export default class NodeManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.heartbeatTimeout]
   * @param {number} [options.monitorInterval]
   * @param {Function} [options.selectionStrategy]
   */
  constructor(options = {}) {
    super();
    this._nodes             = new Map();   // id ⇒ node record
    this._heartbeatTimeout  = options.heartbeatTimeout  || DEFAULT_HEARTBEAT_TIMEOUT;
    this._monitorIntervalMs = options.monitorInterval   || MONITOR_INTERVAL;
    this._selectStrategy    = options.selectionStrategy || roundRobinStrategy;

    /* Restore persisted state if any */
    void this._restoreSnapshot();

    /* Start background monitor */
    this._monitorTimer = setInterval(() => this._healthSweep(), this._monitorIntervalMs)
      .unref(); // allow process to exit if nothing else keeps it alive
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Registers a node in the cluster.
   * @param {object} info
   * @param {string} info.host      – hostname/ip
   * @param {number} info.port
   * @param {object} [info.meta]    – arbitrary metadata
   * @returns {object} node
   */
  registerNode(info) {
    const id   = randomUUID();
    const now  = Date.now();
    const node = {
      id,
      host: info.host,
      port: info.port,
      meta: info.meta || {},
      status: 'initializing',
      load: 0,
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
    };

    this._nodes.set(id, node);
    this.emit('node.registered', node);
    void this._persistSnapshot();
    return node;
  }

  /**
   * Updates heartbeat & telemetry.
   * @param {string} id
   * @param {object} metrics e.g., { load, latency }
   */
  updateHeartbeat(id, metrics = {}) {
    const node = this._nodes.get(id);
    if (!node) return;
    node.lastHeartbeat = Date.now();
    if (typeof metrics.load === 'number') node.load = metrics.load;
    if (metrics.status) node.status = metrics.status;
    node.updatedAt = Date.now();

    this.emit('node.updated', { ...node });
  }

  /**
   * Removes a node from registry.
   * @param {string} id
   * @param {string} [reason]
   * @returns {boolean} success
   */
  deregisterNode(id, reason = 'unspecified') {
    const node = this._nodes.get(id);
    if (!node) return false;

    this._nodes.delete(id);
    this.emit('node.removed', { ...node, reason });
    void this._persistSnapshot();
    return true;
  }

  /**
   * Returns an array of nodes filtered by health.
   * @param {'healthy'|'unhealthy'|'all'} [filter='healthy']
   */
  listNodes(filter = 'healthy') {
    const arr = Array.from(this._nodes.values());
    if (filter === 'all') return arr;
    return arr.filter((n) => (filter === 'healthy' ? n.status === 'healthy' : n.status !== 'healthy'));
  }

  /**
   * Select a node using pluggable strategy.
   * @returns {object|null}
   */
  selectNode() {
    const healthy = this.listNodes('healthy');
    return this._selectStrategy(healthy);
  }

  /**
   * Dispatch command to a node via chain-of-responsibility pipeline.
   * @param {string}  nodeId
   * @param {object}  command
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async dispatchCommand(nodeId, command, signal) {
    const ctx = new CommandContext(this._nodes.get(nodeId), command, signal);

    const pipeline = new ValidationHandler();
    pipeline
      .setNext(new SecurityHandler())
      .setNext(new ExecutionHandler());

    const result = await pipeline.handle(ctx);
    this.emit('command.dispatched', { nodeId, command, result });
    return result;
  }

  /**
   * Gracefully shutdown manager (cleanup intervals).
   */
  async close() {
    clearInterval(this._monitorTimer);
    await this._persistSnapshot(); // persist final state
  }

  /* ---------------------------------------------------------------------- */
  /* Internal logic                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Periodic sweep to mark nodes healthy/unhealthy based on heartbeat.
   * Emits state-change events.
   * @private
   */
  _healthSweep() {
    const now = Date.now();
    for (const node of this._nodes.values()) {
      const unhealthy = now - node.lastHeartbeat > this._heartbeatTimeout;
      const prevStatus = node.status;
      node.status = unhealthy ? 'unhealthy' : 'healthy';

      if (prevStatus !== node.status) {
        this.emit('node.' + (unhealthy ? 'unhealthy' : 'recovered'), { ...node });
      }
    }
  }

  /**
   * Persist snapshot of node registry – used for recovery and metrics.
   * @private
   */
  async _persistSnapshot() {
    const snapshot = {
      version: 1,
      savedAt: Date.now(),
      nodes: Array.from(this._nodes.values()),
    };
    await writeJsonSafe(STATE_SNAPSHOT_FILE, snapshot);
  }

  /**
   * Restore node registry from disk on process start.
   * @private
   */
  async _restoreSnapshot() {
    const data = await readJsonSafe(STATE_SNAPSHOT_FILE, null);
    if (!data || !Array.isArray(data.nodes)) return;

    for (const node of data.nodes) {
      // Re-initialise Age-based health; mark all as unhealthy until heartbeat
      node.status = 'unhealthy';
      this._nodes.set(node.id, node);
    }
    this.emit('snapshot.restored', { count: this._nodes.size });
  }
}

/* -------------------------------------------------------------------------- */
/* Event Names (for reference)                                                */
/* -------------------------------------------------------------------------- */
/**
 * 'node.registered'   – (node)
 * 'node.updated'      – (node)
 * 'node.unhealthy'    – (node)
 * 'node.recovered'    – (node)
 * 'node.removed'      – ({…node, reason})
 * 'command.dispatched'– ({ nodeId, command, result })
 * 'snapshot.restored' – ({ count })
 */
```