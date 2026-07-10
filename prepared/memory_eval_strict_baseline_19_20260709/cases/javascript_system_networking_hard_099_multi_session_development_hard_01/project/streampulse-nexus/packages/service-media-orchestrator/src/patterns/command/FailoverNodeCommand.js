```javascript
/**
 * StreamPulse Nexus – Media Orchestrator
 * --------------------------------------
 * Command: FailoverNodeCommand
 *
 * When the Health-Monitor raises a CRITICAL alert for a media router we need to
 * drain traffic, transfer state and promote a healthy replica with as little
 * viewer impact as possible.  The FailoverNodeCommand coordinates that
 * procedure, providing a single atomic operation that can also be rolled back
 * when the failing router recovers quickly (e.g. transient network flap).
 *
 * The command participates in the Command-Pattern so that it can be queued,
 * retried, persisted, audited and composed in higher-level disaster-recovery
 * workflows.
 */

import { BaseCommand } from './BaseCommand.js';
import { NodeRegistry } from '../../core/NodeRegistry.js';
import { HealthMonitor } from '../../services/HealthMonitor.js';
import { LoadBalancer } from '../../services/LoadBalancer.js';
import { BackupService } from '../../services/BackupService.js';
import { EventBus, Events } from '../../core/EventBus.js';
import { NotificationService } from '../../services/NotificationService.js';
import { logger } from '../../utils/logger.js';

/**
 * @typedef {Object} FailoverOptions
 * @property {string} [preferredReplica]  ID of a replica node to promote.  If
 *                                        omitted the command will choose one
 *                                        using system strategy.
 * @property {number} [drainTimeoutMs]    Milliseconds to wait while draining
 *                                        traffic from the failing node.
 * @property {boolean} [force]            Allow failover even if health status
 *                                        is not CRITICAL (manual takeover).
 */

/**
 * Command responsible for failing traffic over from an unhealthy node to a
 * healthy replica.
 */
export class FailoverNodeCommand extends BaseCommand {
    /**
     * @param {string} failingNodeId           ID of the node that is unhealthy.
     * @param {FailoverOptions} [options]      Optional operation parameters.
     */
    constructor(failingNodeId, options = {}) {
        super();
        if (!failingNodeId) {
            throw new TypeError('FailoverNodeCommand: "failingNodeId" required');
        }

        /** @private */
        this._failingNodeId = failingNodeId;

        /** @private */
        this._options = {
            drainTimeoutMs: 10_000,
            force: false,
            ...options,
        };

        /** @private */
        this._backupJobId = null;

        /** @private */
        this._promotedReplicaId = null;
    }

    /**
     * Execute the failover workflow.
     * @returns {Promise<void>}
     */
    async execute() {
        logger.info(`FailoverNodeCommand::execute → node=${this._failingNodeId}`);

        // 1. Validate failing node exists and is in error state (or force flag)
        const failingNode = NodeRegistry.get(this._failingNodeId);

        if (!failingNode) {
            throw new Error(`Node "${this._failingNodeId}" not found in registry`);
        }
        if (!this._options.force) {
            const health = await HealthMonitor.getStatus(failingNode.id);
            if (health !== 'CRITICAL') {
                throw new Error(
                    `Node "${this._failingNodeId}" not in CRITICAL state (status=${health})`,
                );
            }
        }

        // 2. Initiate backup before draining traffic (fire-and-forget but track id)
        this._backupJobId = await BackupService.snapshotAsync(failingNode.id);
        logger.debug(
            `FailoverNodeCommand → backup snapshot started (job=${this._backupJobId})`,
        );

        // 3. Decide which replica should be promoted
        this._promotedReplicaId =
            this._options.preferredReplica || this._selectReplica(failingNode);

        if (!this._promotedReplicaId) {
            throw new Error(
                `No healthy replica available for node "${this._failingNodeId}"`,
            );
        }

        // 4. Drain traffic from failing node, re-route to replica
        await this._drainAndRedirectTraffic(
            failingNode.id,
            this._promotedReplicaId,
            this._options.drainTimeoutMs,
        );

        // 5. Update registry states
        NodeRegistry.updateStatus(failingNode.id, 'OFFLINE');
        NodeRegistry.updateStatus(this._promotedReplicaId, 'PRIMARY');

        // 6. Notify the system
        EventBus.emit(Events.NODE_FAILOVER_COMPLETED, {
            from: failingNode.id,
            to: this._promotedReplicaId,
        });

        NotificationService.broadcast(
            'MEDIA_ROUTER_FAILOVER',
            `Traffic moved from ${failingNode.id} to ${this._promotedReplicaId}`,
        );

        logger.info(
            `FailoverNodeCommand → completed: ${failingNode.id} → ${this._promotedReplicaId}`,
        );
    }

    /**
     * Undo the command. Attempt to revert to original state if possible.
     * @returns {Promise<void>}
     */
    async rollback() {
        logger.warn(
            `FailoverNodeCommand::rollback → node=${this._failingNodeId} replica=${this._promotedReplicaId}`,
        );

        const failingNode = NodeRegistry.get(this._failingNodeId);
        const replicaNode = NodeRegistry.get(this._promotedReplicaId);

        if (!failingNode || !replicaNode) {
            logger.error('Rollback aborted — nodes not present in registry');
            return;
        }

        // 1. Ensure failing node is healthy again
        const health = await HealthMonitor.getStatus(failingNode.id);
        if (health !== 'HEALTHY') {
            logger.error(
                `Rollback blocked — original node "${failingNode.id}" is not healthy (status=${health})`,
            );
            return;
        }

        // 2. Perform traffic switch-back
        await this._drainAndRedirectTraffic(
            replicaNode.id,
            failingNode.id,
            this._options.drainTimeoutMs,
        );

        // 3. Update states
        NodeRegistry.updateStatus(failingNode.id, 'PRIMARY');
        NodeRegistry.updateStatus(replicaNode.id, 'STANDBY');

        EventBus.emit(Events.NODE_FAILOVER_ROLLED_BACK, {
            from: replicaNode.id,
            to: failingNode.id,
        });

        // 4. Cancel backup job if still running
        if (this._backupJobId) {
            BackupService.cancelSnapshot(this._backupJobId).catch((err) =>
                logger.debug(`Backup cancel failed: ${err.message}`),
            );
        }

        logger.info(
            `FailoverNodeCommand → rollback completed: traffic returned to ${failingNode.id}`,
        );
    }

    // --------------------------------------------------------------------- //
    //                               Helpers                                 //
    // --------------------------------------------------------------------- //

    /**
     * Pick an appropriate replica according to active strategy.
     * @private
     * @param {import('../../types').Node} failingNode
     * @returns {string|null} Node ID of chosen replica or null.
     */
    _selectReplica(failingNode) {
        const replicas = NodeRegistry.list({
            role: 'STANDBY',
            region: failingNode.region,
            status: 'HEALTHY',
        });

        if (replicas.length === 0) {
            return null;
        }

        // Simple selection — lowest CPU utilisation
        return replicas.reduce((best, current) =>
            current.metrics.cpu < best.metrics.cpu ? current : best,
        ).id;
    }

    /**
     * Drain active sessions and switch traffic from one node to another.
     *
     * @private
     * @param {string} fromNodeId   Node currently serving traffic.
     * @param {string} toNodeId     Node that will take over.
     * @param {number} timeoutMs    Max time to wait for drain.
     */
    async _drainAndRedirectTraffic(fromNodeId, toNodeId, timeoutMs) {
        logger.debug(`Draining traffic from ${fromNodeId} → ${toNodeId}`);

        await LoadBalancer.markDraining(fromNodeId);

        // Wait until sessions reach ~0 or timeout
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const activeSessions = await LoadBalancer.countActiveSessions(
                fromNodeId,
            );
            if (activeSessions === 0) break;
            await this._sleep(500); // Poll every 0.5s
        }

        // Redirect new traffic
        await LoadBalancer.redirect(fromNodeId, toNodeId);

        // Ensure 'from' node is fully removed from rotation
        await LoadBalancer.removeFromRotation(fromNodeId);

        logger.debug(`Traffic redirected: ${fromNodeId} → ${toNodeId}`);
    }

    /**
     * Simple promise-based sleep utility.
     * @private
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
```