```javascript
/**
 * StreamPulse Nexus – Ingress Gateway
 * -----------------------------------
 * The Ingress Gateway is the primary entry-point for all traffic that is destined
 * for the StreamPulse backbone.  It accepts WebSocket connections for low-latency
 * transport (media, telemetry, chat) and exposes an HTTP surface for
 * health-checks, Prometheus metrics, and administrative commands (e.g. config
 * reload, drain-connections).  A pluggable load-balancing strategy decides which
 * downstream “Edge-Router” cluster every inbound session is forwarded to.
 *
 * Architectural highlights
 * ‑ Observer pattern   → EventEmitter for broadcasting state-changes
 * ‑ Strategy pattern   → injectable load-balancing algorithm
 * ‑ Command pattern    → runtime administrative commands
 *
 * NOTE: This file purposefully keeps all code in a single module for the sake of
 * the coding-exercise.  In production, code would be split into cohesive
 * sub-modules.
 */

/* ────────────────── External Dependencies ────────────────── */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const crypto = require('crypto');

const express = require('express');
const WebSocket = require('ws');
const Joi = require('joi');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');

/* ────────────────── Environment / CLI Parsing ────────────────── */
const argv = yargs(hideBin(process.argv))
  .option('config', {
    alias: 'c',
    describe: 'Path to configuration file (JSON or YAML)',
    type: 'string',
  })
  .option('env', {
    alias: 'e',
    describe: 'Node environment (development|production|staging)',
    default: process.env.NODE_ENV || 'development',
  })
  .strict()
  .help()
  .parse();

/* ────────────────── Configuration Handling ────────────────── */
const CONFIG_SCHEMA = Joi.object({
  server: Joi.object({
    port: Joi.number().port().default(8080),
    tls: Joi.object({
      enabled: Joi.boolean().default(false),
      key: Joi.string().when('enabled', { is: true, then: Joi.required() }),
      cert: Joi.string().when('enabled', { is: true, then: Joi.required() }),
    }).default(),
  }).required(),
  security: Joi.object({
    tokenSecret: Joi.string().min(32).required(),
    ipAllowList: Joi.array().items(Joi.string().ip({ cidr: 'optional' })).default([]),
  }).required(),
  loadBalancing: Joi.object({
    strategy: Joi.string().valid('round-robin', 'random', 'least-connections').default('round-robin'),
  }).default(),
  logging: Joi.object({
    level: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  }).default(),
}).required();

function loadConfig() {
  let rawConfig = {};

  // 1. File based config
  if (argv.config) {
    const filePath = path.resolve(argv.config);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    rawConfig = JSON.parse(fileContent);
  }

  // 2. ENV overrides
  if (process.env.SP_INGRESS_PORT) {
    rawConfig.server = rawConfig.server || {};
    rawConfig.server.port = parseInt(process.env.SP_INGRESS_PORT, 10);
  }

  const { value, error } = CONFIG_SCHEMA.validate(rawConfig, { abortEarly: false });
  if (error) {
    console.error('Invalid configuration:', error.details.map((d) => d.message).join(', '));
    process.exit(1);
  }

  return value;
}

/* ────────────────── Logging Setup ────────────────── */
const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format:
        argv.env === 'development'
          ? winston.format.combine(
              winston.format.colorize(),
              winston.format.timestamp(),
              winston.format.printf(
                ({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`,
              ),
            )
          : winston.format.json(),
    }),
  ],
});

/* ────────────────── Metrics Setup ────────────────── */
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const metricConnections = new promClient.Gauge({
  name: 'ingress_active_connections',
  help: 'Number of active WebSocket sessions',
});
const metricRejected = new promClient.Counter({
  name: 'ingress_rejected_connections_total',
  help: 'Total number of rejected sessions',
});
const metricForwarded = new promClient.Counter({
  name: 'ingress_forwarded_sessions_total',
  help: 'Number of sessions forwarded to downstream edge routers',
});

register.registerMetric(metricConnections);
register.registerMetric(metricRejected);
register.registerMetric(metricForwarded);

/* ────────────────── Load Balancing Strategies ────────────────── */
class LoadBalancerStrategy {
  constructor(name) {
    this.name = name;
  }
  selectTarget(targets /*: string[] */) {
    throw new Error('selectTarget() must be implemented by subclasses');
  }
}

class RoundRobinStrategy extends LoadBalancerStrategy {
  constructor() {
    super('round-robin');
    this._counter = 0;
  }
  selectTarget(targets) {
    if (!targets.length) return null;
    const target = targets[this._counter % targets.length];
    this._counter += 1;
    return target;
  }
}

class RandomStrategy extends LoadBalancerStrategy {
  constructor() {
    super('random');
  }
  selectTarget(targets) {
    if (!targets.length) return null;
    return targets[Math.floor(Math.random() * targets.length)];
  }
}

class LeastConnectionsStrategy extends LoadBalancerStrategy {
  constructor(connectionMap) {
    super('least-connections');
    this._connectionMap = connectionMap; // Map<target, number>
  }
  selectTarget(targets) {
    if (!targets.length) return null;
    let minTarget = targets[0];
    let minConn = this._connectionMap.get(minTarget) || 0;
    targets.forEach((t) => {
      const c = this._connectionMap.get(t) || 0;
      if (c < minConn) {
        minConn = c;
        minTarget = t;
      }
    });
    return minTarget;
  }
}

function buildStrategy(config, connectionMap) {
  switch (config.loadBalancing.strategy) {
    case 'random':
      return new RandomStrategy();
    case 'least-connections':
      return new LeastConnectionsStrategy(connectionMap);
    case 'round-robin':
    default:
      return new RoundRobinStrategy();
  }
}

/* ────────────────── Helper: Token Verification ────────────────── */
function verifyAuthToken(token, secret) {
  try {
    const [payload, signature] = token.split('.');
    const validSig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(validSig));
  } catch (err) {
    return false;
  }
}

/* ────────────────── Ingress Gateway Implementation ────────────────── */
class IngressGateway extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.connections = new Map(); // Map<uuid, WebSocket>
    this.edgeRouters = ['edge-a', 'edge-b', 'edge-c']; // would be dynamic in real system
    this.connectionCountByEdge = new Map(); // Map<edge, number>
    this.strategy = buildStrategy(config, this.connectionCountByEdge);
    this._wsServer = null;
    this._httpServer = null;
  }

  /* ---------- Start/Stop Lifecycle ---------- */
  async start() {
    await this._bootstrapHttpServer();
    await this._bootstrapWebSocketServer();
    logger.info(`Ingress Gateway started on port ${this.config.server.port}`);
  }

  async stop() {
    logger.info('Graceful shutdown initiated');
    this._wsServer?.close();
    await new Promise((resolve) => this._httpServer?.close(resolve));
    for (const [, ws] of this.connections) {
      ws.terminate();
    }
    this.connections.clear();
    logger.info('Ingress Gateway stopped');
  }

  /* ---------- Bootstrap Methods ---------- */
  async _bootstrapHttpServer() {
    const app = express();

    /* Health check */
    app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

    /* Metrics endpoint */
    app.get('/metrics', async (req, res) => {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    });

    /* Command endpoint (simple Command pattern) */
    app.post('/admin/reload', (req, res) => {
      this.emit('command:reload');
      return res.status(202).json({ status: 'accepted' });
    });

    const { tls } = this.config.server;
    if (tls && tls.enabled) {
      const { key, cert } = tls;
      const credentials = {
        key: fs.readFileSync(key),
        cert: fs.readFileSync(cert),
      };
      this._httpServer = https.createServer(credentials, app);
    } else {
      this._httpServer = http.createServer(app);
    }

    return new Promise((resolve) => {
      this._httpServer.listen(this.config.server.port, resolve);
    });
  }

  async _bootstrapWebSocketServer() {
    this._wsServer = new WebSocket.Server({ server: this._httpServer });

    this._wsServer.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      if (!this._isIpAllowed(ip)) {
        metricRejected.inc();
        logger.warn(`Connection from ${ip} rejected (IP not allow-listed)`);
        ws.close(4001, 'IP not allowed');
        return;
      }

      const token = this._extractToken(req.url);
      if (!verifyAuthToken(token, this.config.security.tokenSecret)) {
        metricRejected.inc();
        logger.warn(`Connection from ${ip} rejected (invalid token)`);
        ws.close(4002, 'Invalid token');
        return;
      }

      const sessionId = uuidv4();
      this.connections.set(sessionId, ws);
      metricConnections.inc();

      const targetEdge = this._assignEdgeRouter();
      metricForwarded.inc();
      this.emit('connection:accepted', { sessionId, targetEdge, ip });

      logger.info(`Session ${sessionId} accepted, forwarded to ${targetEdge}`);

      ws.on('message', (data) => {
        /* In a real system we would forward data to the chosen edge router here */
        this.emit('message', { sessionId, data });
      });

      ws.on('close', () => {
        this.connections.delete(sessionId);
        metricConnections.dec();
        this._decrementEdgeConnection(targetEdge);
        this.emit('connection:closed', { sessionId });
      });

      ws.on('error', (err) => logger.error(`WebSocket error: ${err.message}`));
    });

    this._wsServer.on('error', (err) => logger.error(`WebSocket server error: ${err.message}`));
  }

  /* ---------- Internals ---------- */
  _extractToken(url) {
    try {
      const [, query] = url.split('?');
      const params = new URLSearchParams(query);
      return params.get('token');
    } catch (err) {
      return null;
    }
  }

  _isIpAllowed(ip) {
    if (this.config.security.ipAllowList.length === 0) return true;
    return this.config.security.ipAllowList.includes(ip);
  }

  _assignEdgeRouter() {
    const target = this.strategy.selectTarget(this.edgeRouters);
    const current = this.connectionCountByEdge.get(target) || 0;
    this.connectionCountByEdge.set(target, current + 1);
    return target;
  }

  _decrementEdgeConnection(edge) {
    const current = this.connectionCountByEdge.get(edge) || 1;
    this.connectionCountByEdge.set(edge, Math.max(0, current - 1));
  }
}

/* ────────────────── Main Entrypoint ────────────────── */
(async () => {
  const config = loadConfig();
  logger.level = config.logging.level;

  const gateway = new IngressGateway(config);

  /* Observer pattern: broadcast to log */
  gateway.on('connection:accepted', ({ sessionId, targetEdge, ip }) =>
    logger.debug(`Event: connection:accepted ${sessionId} → ${targetEdge} (${ip})`),
  );
  gateway.on('connection:closed', ({ sessionId }) =>
    logger.debug(`Event: connection:closed ${sessionId}`),
  );
  gateway.on('command:reload', () => logger.info('Reload command received (noop for demo)'));

  /* Graceful shutdown */
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach((sig) =>
    process.on(sig, async () => {
      logger.info(`Received ${sig}, starting shutdown...`);
      try {
        await gateway.stop();
        process.exit(0);
      } catch (err) {
        logger.error(`Error during shutdown: ${err.stack || err}`);
        process.exit(1);
      }
    }),
  );

  /* Unhandled rejection / exception */
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.stack || err}`);
  });

  await gateway.start();
})();
```