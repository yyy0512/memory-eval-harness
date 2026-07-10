// streampulse-nexus/packages/service-media-orchestrator/src/index.js
// -------------------------------------------------------------------------------------------------
// StreamPulse Nexus – Media Orchestrator Service
//
// Responsibility:
//   • Bootstraps and wires together all sub-systems required to ingest, orchestrate, and dispatch
//     media packets throughout the StreamPulse fabric.
//   • Applies Strategy, Observer, Event-Driven, and Chain-of-Responsibility patterns to keep the
//     codebase modular and highly adaptable to new show formats or operational requirements.
//
// NOTE: This file is intentionally self-contained so that the service can still function during
//       local development where some upstream packages might be mocked or stubbed.
//
// -------------------------------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { createServer } from 'http';
import os from 'os';
import process from 'process';

/* External/Peer Dependencies (provided by other packages in the mono-repo) */
import ConfigManager from '@streampulse-nexus/config-manager';
import OrchestratorNode from '@streampulse-nexus/core-orchestrator';
import LoadBalancingStrategyRegistry from '@streampulse-nexus/strategy-registry';
import HealthMonitor from '@streampulse-nexus/health-monitor';
import SecurityScanner from '@streampulse-nexus/security-scanner';
import BackupManager from '@streampulse-nexus/backup-manager';
import AlertingService from '@streampulse-nexus/alerting-service';
import Logger from '@streampulse-nexus/logger';

/* -------------------------------------------------------------------------------------------------
 * Utilities & Fallbacks
 * -------------------------------------------------------------------------------------------------
 */

/**
 * Creates a promise-based delay (used for back-off, retries, etc.).
 * @param {number} ms – Milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------------------------------
 * Shutdown Chain (Chain-of-Responsibility)
 * -------------------------------------------------------------------------------------------------
 */

class ShutdownChain {
  constructor(logger) {
    this._handlers = [];
    this._logger = logger.child({ scope: 'ShutdownChain' });
    this._invoked = false;
  }

  /**
   * Appends a new async handler to the shutdown chain.
   * @param {(reason: string) => Promise<void>} handler
   */
  use(handler) {
    this._handlers.push(handler);
    return this; // Fluent
  }

  /**
   * Executes handlers in insertion order (FIFO).
   * If any handler throws, the error is logged and execution proceeds.
   * @param {string} reason – Human readable shutdown reason.
   */
  async invoke(reason) {
    if (this._invoked) return;
    this._invoked = true;

    this._logger.info(`Invoking shutdown chain: ${reason}`);

    for (const handler of this._handlers) {
      try {
        await handler(reason);
      } catch (err) {
        this._logger.error({ err }, 'Shutdown handler failed, continuing...');
      }
    }

    this._logger.info('Shutdown complete, exiting process.');
    // Give logger transport time to flush
    await delay(250);
    process.exit(0);
  }
}

/* -------------------------------------------------------------------------------------------------
 * MediaOrchestrator (Facade) – EventEmitter (Observer + Event-Driven)
 * -------------------------------------------------------------------------------------------------
 */

class MediaOrchestrator extends EventEmitter {
  /**
   * @param {object}  opts
   * @param {object}  opts.config
   * @param {Logger}  opts.logger
   */
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.logger = logger.child({ scope: 'MediaOrchestrator' });

    // Core subsystems
    this.node            = new OrchestratorNode(config.node);
    this.healthMonitor   = new HealthMonitor(config.health);
    this.securityScanner = new SecurityScanner(config.security);
    this.backupManager   = new BackupManager(config.backup);
    this.alerting        = new AlertingService(config.alerting);
    this.strategyRegistry = new LoadBalancingStrategyRegistry();

    // Bind internal listeners
    this._bindEventHandlers();
  }

  /**
   * Attach subsystem event handlers.
   * Promotes a strongly typed, event-driven architecture between otherwise
   * loosely coupled components.
   */
  _bindEventHandlers() {
    /* Observer pattern: forward health changes to anyone interested */
    this.healthMonitor.on('stateChange', (state) => {
      this.emit('healthChange', state);
    });

    /* Security events are critical – escalated through alerting service */
    this.securityScanner.on('threatDetected', async (threat) => {
      this.logger.warn({ threat }, 'Security threat detected!');
      await this.alerting.notifySecurityOps(threat);
    });

    /* Node emits operational stats we may want to aggregate */
    this.node.on('metric', (metric) => this.emit('metric', metric));
    this.node.on('error', (err) => this.emit('error', err));
  }

  /* ---------------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------------ */

  async start() {
    this.logger.info(`Bootstrapping MediaOrchestrator on host ${os.hostname()}…`);

    // Dynamically select and inject load-balancing strategy (Strategy pattern).
    this._applyLoadBalancingStrategy(this.config.lbStrategy);

    // Parallelize subsystem start-up for speed.
    await Promise.all([
      this.securityScanner.start(),
      this.healthMonitor.start(),
      this.backupManager.start(),
      this.node.start()
    ]);

    this.logger.info('MediaOrchestrator started successfully.');
  }

  async stop(reason = 'unspecified') {
    this.logger.info(`Stopping MediaOrchestrator. Reason: ${reason}`);

    // Attempt an orderly shutdown.
    await Promise.allSettled([
      this.node.stop(reason),
      this.healthMonitor.stop(),
      this.securityScanner.stop(),
      this.backupManager.stop()
    ]);
    this.logger.info('MediaOrchestrator stopped.');
  }

  /* ---------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------ */

  /**
   * Registers or switches load-balancing strategy at runtime.
   * @param {string} strategyName – key for the desired strategy implementation.
   */
  _applyLoadBalancingStrategy(strategyName = 'roundRobin') {
    const strategy = this.strategyRegistry.get(strategyName);

    if (!strategy) {
      this.logger.warn(
        { strategy: strategyName },
        'Unknown load-balancing strategy; falling back to round-robin.'
      );
      return this.node.setLoadBalancer(this.strategyRegistry.get('roundRobin'));
    }

    this.node.setLoadBalancer(strategy);
    this.logger.info({ strategy: strategyName }, 'Load-balancing strategy applied.');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Health Probe HTTP Server (Kubernetes-style liveness / readiness)
 * -------------------------------------------------------------------------------------------------
 */

function startHealthServer(orchestrator, port = 9888, logger = console) {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      const healthy = orchestrator.healthMonitor.isHealthy();
      res.statusCode = healthy ? 200 : 503;
      res.end(JSON.stringify({ healthy }));
    } else if (req.url === '/readyz') {
      const ready = orchestrator.node.isReady();
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ ready }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  server.on('clientError', (err, socket) => {
    logger.error({ err }, 'Client error on health server.');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(port, () => logger.info(`Health server listening on :${port}`));

  return server;
}

/* -------------------------------------------------------------------------------------------------
 * Bootstrapping
 * -------------------------------------------------------------------------------------------------
 */

(async () => {
  const logger = Logger.create({
    service: 'service-media-orchestrator'
  });

  // ----------------------------------------------------------------------------
  // Load configuration with live reload support (Configuration Management)
  // ----------------------------------------------------------------------------
  const config = await ConfigManager.load('media-orchestrator'); // Namespace within config store

  const orchestrator = new MediaOrchestrator({ config, logger });
  const shutdownChain = new ShutdownChain(logger)
    .use(orchestrator.stop.bind(orchestrator))
    .use(async () => logger.flush?.()) // Ensure logs are delivered
    .use(async () => delay(50));       // micro-delay so transport can finish

  // If the ConfigManager signals an update, hot-swap certain configs
  ConfigManager.on('configChange', async (updated) => {
    logger.info('Configuration update received.');
    orchestrator._applyLoadBalancingStrategy(updated.lbStrategy);

    // We can push updates to sub-modules that support dynamic configuration
    await orchestrator.securityScanner.updateConfig(updated.security);
    await orchestrator.healthMonitor.updateConfig(updated.health);
    // …add more as necessary
  });

  // ----------------------------------------------------------------------------
  // Error / Exception Handling
  // ----------------------------------------------------------------------------
  orchestrator.on('error', async (err) => {
    logger.error({ err }, 'Unhandled orchestrator error.');
    await shutdownChain.invoke('orchestrator-error');
  });

  process.on('uncaughtException', async (err) => {
    logger.fatal({ err }, 'Uncaught exception – shutting down.');
    await shutdownChain.invoke('uncaught-exception');
  });

  process.on('unhandledRejection', async (reason) => {
    logger.fatal({ reason }, 'Unhandled promise rejection – shutting down.');
    await shutdownChain.invoke('unhandled-rejection');
  });

  // Graceful termination signals (Kubernetes, systemd, etc.)
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) =>
    process.on(signal, () => shutdownChain.invoke(`signal:${signal}`))
  );

  // ----------------------------------------------------------------------------
  // Launch!
  // ----------------------------------------------------------------------------
  try {
    await orchestrator.start();
  } catch (err) {
    logger.fatal({ err }, 'Failed to bootstrap orchestrator.');
    await shutdownChain.invoke('bootstrap-failure');
    return;
  }

  // Health endpoints for orchestrator
  const healthServer = startHealthServer(orchestrator, config.healthPort, logger);

  // Ensure health server is closed during shutdown
  shutdownChain.use(async () => {
    await new Promise((resolve) => healthServer.close(resolve));
  });
})();