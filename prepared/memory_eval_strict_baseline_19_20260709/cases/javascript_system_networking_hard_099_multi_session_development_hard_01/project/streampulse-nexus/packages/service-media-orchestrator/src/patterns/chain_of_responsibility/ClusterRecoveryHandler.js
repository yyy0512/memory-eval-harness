```javascript
/**
 * StreamPulse Nexus – ClusterRecoveryHandler
 *
 * This handler is part of the Chain-of-Responsibility that executes disaster-recovery
 * commands.  Its purpose is to detect an unrecoverable cluster outage and initiate
 * automated restore using the Backup/Recovery micro-service.  If the request does
 * not apply (e.g. lower severity, or cluster is already healthy) the handler
 * delegates to the next member in the chain.
 *
 * Typical chain order:
 *   HealthCheckHandler  ->  SegmentRecoveryHandler  ->  ClusterRecoveryHandler
 *
 * NOTE: Down-stream handlers **must** extend `AbstractRecoveryHandler` and call
 * `super.handle(request)` when they choose not to process the event.
 */

import { v4 as uuid } from 'uuid';
import Redlock from 'redlock';
import { createClient as createRedisClient } from 'redis';

import AbstractRecoveryHandler from './AbstractRecoveryHandler.js';
import BackupClient from '../../clients/BackupClient.js';
import ClusterRegistry from '../../registries/ClusterRegistry.js';
import Logger from '../../utils/Logger.js';
import Metrics from '../../monitoring/Metrics.js';

/**
 * @typedef {Object} RecoveryEvent
 * @property {string} clusterId       – Unique cluster identifier
 * @property {string} severity        – One of "info" | "warning" | "critical"
 * @property {Date}   timestamp       – Event creation time
 * @property {string} reason          – Human-readable message
 * @property {Object} [meta]          – Arbitrary diagnostic metadata
 */

export default class ClusterRecoveryHandler extends AbstractRecoveryHandler {
  /**
   * @param {Object}  deps
   * @param {Logger}  deps.logger
   * @param {BackupClient} deps.backupClient
   * @param {ClusterRegistry} deps.clusterRegistry
   * @param {Redlock} [deps.redlock]            – Optional externally-managed redlock
   * @param {number}  [deps.lockTtlMs=120_000]  – How long the recovery lock lasts
   */
  constructor({
    logger = Logger.child({ scope: 'ClusterRecoveryHandler' }),
    backupClient = new BackupClient(),
    clusterRegistry = new ClusterRegistry(),
    redlock,
    lockTtlMs = 120_000,
  } = {}) {
    super();
    this.log = logger;
    this.backupClient = backupClient;
    this.clusterRegistry = clusterRegistry;
    this.lockTtlMs = lockTtlMs;

    // Create a Redlock instance if the caller did not supply one.
    if (redlock) {
      this.redlock = redlock;
    } else {
      const redisClient = createRedisClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
      });
      redisClient.on('error', (err) =>
        this.log.error({ err }, 'Redis connection error'),
      );
      this.redlock = new Redlock([redisClient], {
        // Retry strategy that finishes quickly—ops team wants fast feedback.
        retryCount: 3,
        retryDelay: 200, // ms
      });
    }
  }

  /**
   * Handle an inbound recovery event.  The method is `async` because we need
   * to query cluster health, acquire distributed locks, and call the backup
   * service over the network.
   *
   * @param {RecoveryEvent} event
   * @returns {Promise<*>}  handler result or super.handle result
   */
  async handle(event) {
    if (!this._canHandle(event)) {
      return super.handle(event);
    }

    const { clusterId, reason } = event;

    // Attempt to acquire a distributed lock so that only one orchestrator
    // performs recovery for this cluster at a time.
    const lockKey = `locks:cluster-recovery:${clusterId}`;
    let lock;
    try {
      lock = await this.redlock.acquire([lockKey], this.lockTtlMs);
      this.log.info({ clusterId, reason }, 'Acquired recovery lock');
    } catch (err) {
      // Someone else is already recovering this cluster.  Skip gracefully.
      if (err instanceof Redlock.LockError) {
        this.log.info({ clusterId }, 'Another node is already handling recovery');
        return { skipped: true, reason: 'lock_not_acquired' };
      }
      this.log.error({ err }, 'Unexpected lock acquisition error');
      throw err;
    }

    // Capture telemetry for observability.
    const recoveryId = uuid();
    Metrics.increment('cluster_recovery.attempt', { clusterId });

    let result;
    try {
      const status = await this.clusterRegistry.getStatus(clusterId);
      if (status === 'HEALTHY') {
        this.log.warn({ clusterId }, 'Cluster reported healthy after lock-acquire → skipping recovery');
        Metrics.increment('cluster_recovery.noop_cluster_healthy', { clusterId });
        return { skipped: true, reason: 'cluster_healthy' };
      }

      // Find the most recent good snapshot for this cluster.
      const snapshot = await this.backupClient.findLatestSnapshot(clusterId);
      if (!snapshot) {
        this.log.error({ clusterId }, 'No snapshot available for recovery');
        Metrics.increment('cluster_recovery.failed_no_snapshot', { clusterId });
        throw new Error(`Recovery aborted – no snapshot for cluster ${clusterId}`);
      }

      this.log.info(
        { clusterId, snapshotId: snapshot.id, takenAt: snapshot.takenAt },
        'Restoring cluster from snapshot',
      );

      // Initiate the recovery operation.
      await this.backupClient.restoreSnapshot(clusterId, snapshot.id, {
        recoveryId,
      });

      // Optionally update registry state to signal "RECOVERING".
      await this.clusterRegistry.markRecovering(clusterId, { recoveryId });

      Metrics.increment('cluster_recovery.success', { clusterId });
      this.log.info({ clusterId, recoveryId }, 'Cluster recovery initiated successfully');

      result = { success: true, recoveryId };
    } catch (err) {
      Metrics.increment('cluster_recovery.failed', { clusterId });
      this.log.error({ err, clusterId }, 'Cluster recovery failed');
      result = { success: false, error: err };
      throw err; // escalate to upstream error handler / alerting pipeline
    } finally {
      // Always release the lock, even on error.
      try {
        if (lock) await lock.release();
      } catch (releaseErr) {
        this.log.error({ releaseErr, clusterId }, 'Failed to release recovery lock');
      }
    }

    // Short-circuit the rest of the chain—once cluster-level recovery is
    // in progress, lower-level handlers are not applicable.
    return result;
  }

  /**
   * @private
   * Determine whether this handler should process the recovery event.
   *
   * @param {RecoveryEvent} event
   * @returns {boolean}
   */
  _canHandle(event) {
    if (!event || typeof event !== 'object') return false;
    const { severity, clusterId } = event;
    if (!clusterId) return false;

    // Only act on "critical" events. Less severe events should be handled
    // by earlier members in the chain.
    return severity === 'critical';
  }
}
```
