```javascript
/*  File: packages/service-media-orchestrator/src/patterns/chain_of_responsibility/NodeRecoveryHandler.js
 *  Description: Concrete handler in the “Chain-of-Responsibility” that attempts to
 *               autonomously recover a single streaming node (container / pod /
 *               bare-metal process) before escalating the incident to the next
 *               handler (e.g. ClusterRecoveryHandler, RegionFailoverHandler).
 *  Author: StreamPulse Nexus Platform Team
 */

'use strict';

/* ──────────────────────────────────────────────────────────────────────────────
 * External / Standard-lib dependencies
 * ──────────────────────────────────────────────────────────────────────────── */
const { EventEmitter }   = require('events');
const { exec }           = require('child_process');
const path               = require('path');
const util               = require('util');
const execAsync          = util.promisify(exec);

/* ──────────────────────────────────────────────────────────────────────────────
 * Internal dependencies (local utilities assumed to exist in the project)
 * ──────────────────────────────────────────────────────────────────────────── */
const logger             = require('../../utils/logger'); // Winston / Pino wrapper
const telemetry          = require('../../telemetry/metrics'); // Prometheus wrapper
const {
    RecoveryContext,
    RecoveryStage,
}                         = require('./types'); // Shared enums / typedefs

/* ──────────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────────── */
const HEARTBEAT_TIMEOUT_MS   = 3_000;  // Maximum time to wait for heartbeat
const BACKOFF_BASE_MS        = 1_000;  // Base time for exponential back-off
const MAX_NODE_ATTEMPTS      = 3;      // Attempts before escalation

/* ──────────────────────────────────────────────────────────────────────────────
 * Helper functions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * pingNode – Lightweight health-check (ICMP / liveness probe)
 *
 * @param {string} nodeHost – IP or DNS of the node
 * @returns {Promise<boolean>}
 */
async function pingNode (nodeHost) {
    try {
        const { stdout } = await execAsync(`ping -c 1 -W 1 ${nodeHost}`);
        return stdout.includes('1 packets transmitted, 1 received');
    } catch {
        return false;
    }
}

/**
 * restartService – Restarts the media daemon on the target node via SSH.
 *
 * This is intentionally lightweight; in real use we might call K8s APIs,
 * systemd, Docker, etc.
 *
 * @param {string} nodeHost
 * @param {string} serviceName
 * @returns {Promise<void>}
 */
async function restartService (nodeHost, serviceName) {
    const cmd = `ssh -o ConnectTimeout=2 ${nodeHost} 'sudo systemctl restart ${serviceName}'`;
    await execAsync(cmd);
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Abstract Handler base-class
 * ──────────────────────────────────────────────────────────────────────────── */
class AbstractRecoveryHandler extends EventEmitter {
    constructor () {
        super();
        /** @type {AbstractRecoveryHandler|null} */
        this._next = null;
    }

    /**
     * setNext – Inject next handler in the chain
     * @param {AbstractRecoveryHandler} handler
     * @returns {AbstractRecoveryHandler} handler
     */
    setNext (handler) {
        this._next = handler;
        return handler;
    }

    /**
     * handle – Entry-point. Subclasses call super.handle(context) after doing
     *         work so that metrics / fall-through happen consistently.
     *
     * @param {RecoveryContext} context
     * @returns {Promise<void>}
     */
    async handle (context) {
        if (!context || !(context instanceof RecoveryContext)) {
            throw new TypeError('Invalid RecoveryContext provided to handler');
        }

        const handled = await this._handleInternal(context);

        if (!handled && this._next) {
            logger.debug('Escalating recovery context to next handler', {
                nodeId: context.nodeId,
                stage : context.stage,
            });
            return this._next.handle(context);
        }

        if (!handled && !this._next) {
            logger.error('Unrecoverable state – end of chain reached', {
                nodeId: context.nodeId,
            });
        }
    }

    /* eslint-disable no-unused-vars */
    // eslint warns; to be overwritten by subclass
    async _handleInternal (context) { throw new Error('Not implemented'); }
    /* eslint-enable no-unused-vars */
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Concrete Handler: NodeRecoveryHandler
 * ──────────────────────────────────────────────────────────────────────────── */
class NodeRecoveryHandler extends AbstractRecoveryHandler {
    /**
     * @param {object} opts
     * @param {string} opts.serviceName – e.g. 'streampulse-media-daemon'
     */
    constructor ({ serviceName }) {
        super();
        this._serviceName = serviceName;
    }

    /* ---------------------------------------------------------------------- */
    /**
     * _handleInternal – Attempt node-level recovery
     *
     * @param {RecoveryContext} context
     * @returns {Promise<boolean>} true if recovery performed (or not needed)
     */
    async _handleInternal (context) {
        // Only handle when stage is NODE
        if (context.stage !== RecoveryStage.NODE) {
            return false; // Pass through
        }

        const { nodeId, nodeHost } = context;

        logger.info('NODE recovery handler invoked', { nodeId });

        // Quick liveness probe
        const isAlive = await pingNode(nodeHost);

        if (isAlive) {
            logger.warn('Node responded to heartbeat, marking context resolved', { nodeId });
            context.markResolved('Node reachable; false positive');
            telemetry.recovery.success_total.inc({ stage: 'node', type: 'no-op' });
            this.emit('resolved', context);
            return true;
        }

        // Not alive, start recovery loop
        for (let attempt = 1; attempt <= MAX_NODE_ATTEMPTS; attempt++) {
            try {
                logger.warn(`Attempt ${attempt}/${MAX_NODE_ATTEMPTS}: restarting service`, { nodeId });
                telemetry.recovery.attempt_total.inc({ stage: 'node' });

                await restartService(nodeHost, this._serviceName);

                // Back-off to allow service startup, then ping again
                const backoff = attempt ** 2 * BACKOFF_BASE_MS;
                await new Promise(res => setTimeout(res, backoff));

                const alive = await pingNode(nodeHost);
                if (alive) {
                    logger.info('Node recovered successfully', { nodeId, attempt });
                    context.markResolved('Service restart successful');
                    telemetry.recovery.success_total.inc({ stage: 'node', type: 'restart' });
                    this.emit('resolved', context);
                    return true;
                }
            } catch (err) {
                logger.error('Error while trying to restart service', {
                    nodeId,
                    attempt,
                    error: err.message,
                });
                telemetry.recovery.failure_total.inc({ stage: 'node', reason: 'restart-error' });
            }

            // Wait with exponential back-off before next attempt
            const sleep = Math.min(BACKOFF_BASE_MS * 2 ** attempt, HEARTBEAT_TIMEOUT_MS);
            await new Promise(res => setTimeout(res, sleep));
        }

        // Failed all attempts; mark context and bubble-up
        logger.error('Node recovery exhausted all attempts; escalating', { nodeId });
        context.incrementEscalationLevel();
        telemetry.recovery.escalation_total.inc({ from: 'node' });

        return false; // Pass to next handler
    }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Exports
 * ──────────────────────────────────────────────────────────────────────────── */
module.exports = NodeRecoveryHandler;
```