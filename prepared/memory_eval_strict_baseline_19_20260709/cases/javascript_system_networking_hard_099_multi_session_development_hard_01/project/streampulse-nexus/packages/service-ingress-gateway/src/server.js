/*******************************
 * streampulse-nexus
 * packages/service-ingress-gateway/src/server.js
 *******************************/

/* eslint-disable no-console */

/**
 * StreamPulse Nexus – Ingress Gateway
 *
 * Responsibilities
 * ----------------
 * • TLS termination & HTTP/WS upgrade handling
 * • Zero-trust token validation
 * • Pluggable load-balancing to internal edge routers
 * • Health-checks & Prometheus metrics
 * • Graceful draining & shutdown
 */

import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { collectDefaultMetrics, Registry, Counter, Histogram } from 'prom-client';
import { WebSocketServer } from 'ws';
import Joi from 'joi';
import pino from 'pino';

// Local utilities (part of the monorepo; implementations not shown here)
import { StrategyLoader } from './strategies/loader.js';
import { TokenValidator } from './security/token-validator.js';
import { createShutdownHook } from './utils/graceful-shutdown.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------------------------------------------------------------- */
/*                                ENVIRONMENT                                */
/* -------------------------------------------------------------------------- */

const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  INGRESS_PORT: Joi.number().integer().min(1).max(65535).default(443),
  INGRESS_HOST: Joi.string().hostname().default('0.0.0.0'),
  INGRESS_KEY_FILE: Joi.string().when('NODE_ENV', { is: 'production', then: Joi.required() }),
  INGRESS_CERT_FILE: Joi.string().when('NODE_ENV', { is: 'production', then: Joi.required() }),
  STRATEGY_NAME: Joi.string().default('round-robin'),
  PROMETHEUS_METRICS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  PROMETHEUS_METRICS_PORT: Joi.number().integer().min(1).max(65535).default(9100),
  PROMETHEUS_METRICS_ENDPOINT: Joi.string().default('/metrics'),
  ACCESS_LOG_FORMAT: Joi.string().default('combined'),
  CLUSTER_FORKS: Joi.number().integer().min(1).max(os.cpus().length).default(os.cpus().length),
}).unknown();

const { value: env, error } = envSchema.validate(process.env);
if (error) {
  console.error('❌ Invalid environment configuration:', error.message);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*                                   LOGGER                                  */
/* -------------------------------------------------------------------------- */

const logger = pino({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { translateTime: true },
        }
      : undefined,
});

/* -------------------------------------------------------------------------- */
/*                                 METRICS                                   */
/* -------------------------------------------------------------------------- */

const registry = new Registry();

if (env.PROMETHEUS_METRICS_ENABLED) {
  collectDefaultMetrics({ register: registry });

  // Custom metrics
  const ingressRequestCounter = new Counter({
    name: 'ingress_requests_total',
    help: 'Total number of ingress requests handled',
    labelNames: ['protocol', 'method', 'status'],
    registers: [registry],
  });

  const ingressLatencyHistogram = new Histogram({
    name: 'ingress_request_duration_seconds',
    help: 'Latency histogram of ingress HTTP requests',
    labelNames: ['route'],
    buckets: [0.003, 0.03, 0.1, 0.3, 1.5, 10],
    registers: [registry],
  });

  global.__metrics__ = { ingressRequestCounter, ingressLatencyHistogram };
}

/* -------------------------------------------------------------------------- */
/*                             EXPRESS APP FACTORY                            */
/* -------------------------------------------------------------------------- */

function createExpressApp(eventBus, loadBalancer) {
  const app = express();

  /* ----------------------------- Middlewares ---------------------------- */

  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));

  // HTTP access log
  app.use(
    morgan(env.ACCESS_LOG_FORMAT, {
      stream: { write: (msg) => logger.info(msg.trim()) },
    })
  );

  /* ------------------------------ Endpoints ----------------------------- */

  if (env.PROMETHEUS_METRICS_ENABLED) {
    app.get(env.PROMETHEUS_METRICS_ENDPOINT, async (_req, res) => {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    });
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/readyz', (_req, res) =>
    res.json({ status: 'ready', pendingRequests: loadBalancer.inflightCount })
  );

  // Main ingress route
  app.all('/ingress/*', TokenValidator.express(), async (req, res, next) => {
    const endTimer = env.PROMETHEUS_METRICS_ENABLED
      ? global.__metrics__.ingressLatencyHistogram.startTimer({ route: '/ingress' })
      : () => {};

    try {
      const targetUrl = await loadBalancer.nextTarget();

      res.json({ message: 'Routed', target: targetUrl });

      eventBus.emit('request:routed', { target: targetUrl, user: req.user });

      if (env.PROMETHEUS_METRICS_ENABLED) {
        global.__metrics__.ingressRequestCounter.inc({
          protocol: req.protocol,
          method: req.method,
          status: 200,
        });
      }
      endTimer();
    } catch (err) {
      logger.error(err, 'Error routing request');

      if (env.PROMETHEUS_METRICS_ENABLED) {
        global.__metrics__.ingressRequestCounter.inc({
          protocol: req.protocol,
          method: req.method,
          status: 500,
        });
      }
      endTimer();
      next(err);
    }
  });

  /* ---------------------------- Error Handler --------------------------- */

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'internal_server_error', message: err.message });
  });

  return app;
}

/* -------------------------------------------------------------------------- */
/*                              WEBSOCKET LAYER                              */
/* -------------------------------------------------------------------------- */

function attachWebSocketServer(httpServer, eventBus, loadBalancer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, request) => {
    logger.debug({ address: request.socket.remoteAddress }, 'WS client connected');

    ws.on('message', async (data) => {
      try {
        const target = await loadBalancer.nextTarget();
        eventBus.emit('ws:message', { data, target });
        ws.send(JSON.stringify({ ack: true, upstream: target }));
      } catch (err) {
        logger.error(err, 'WS forwarding failed');
        ws.close(1011, 'Internal Error');
      }
    });
  });

  httpServer.on('upgrade', async (request, socket, head) => {
    if (request.url.startsWith('/ws/ingress')) {
      const params = new URLSearchParams(request.url.split('?')[1]);
      const token = params.get('token');
      if (!TokenValidator.validate(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}

/* -------------------------------------------------------------------------- */
/*                              CLUSTER BOOTSTRAP                            */
/* -------------------------------------------------------------------------- */

if (process.env.NODE_UNIQUE_ID === undefined && env.CLUSTER_FORKS > 1 && os.cpus().length > 1) {
  // Primary process – fork workers
  import('node:cluster').then((cluster) => {
    const { default: clusterModule } = cluster;

    if (clusterModule.isPrimary) {
      logger.info(`Launching ${env.CLUSTER_FORKS} ingress workers…`);
      for (let i = 0; i < env.CLUSTER_FORKS; i += 1) clusterModule.fork();

      clusterModule.on('exit', (worker, code, signal) => {
        logger.warn({ pid: worker.process.pid, code, signal }, 'Worker exited');
        clusterModule.fork();
      });
    }
  });
} else {
  /* ------------------------------ Worker ------------------------------- */

  (async () => {
    try {
      const loadBalancer = await StrategyLoader.load(env.STRATEGY_NAME, { logger });
      const eventBus = new EventEmitter();
      const app = createExpressApp(eventBus, loadBalancer);

      // TLS options if provided
      const tlsOptions =
        env.NODE_ENV === 'production'
          ? {
              key: fs.readFileSync(path.resolve(__dirname, env.INGRESS_KEY_FILE)),
              cert: fs.readFileSync(path.resolve(__dirname, env.INGRESS_CERT_FILE)),
            }
          : undefined;

      const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
      attachWebSocketServer(server, eventBus, loadBalancer);

      // Graceful shutdown
      createShutdownHook({
        logger,
        servers: [server],
        beforeShutdown: async () => {
          logger.info('Draining load balancer…');
          await loadBalancer.drain();
          logger.info('Load balancer drained');
        },
      });

      // Listen
      server.listen(env.INGRESS_PORT, env.INGRESS_HOST, () => {
        logger.info(
          `Ingress Gateway listening on ${tlsOptions ? 'https' : 'http'}://${
            env.INGRESS_HOST
          }:${env.INGRESS_PORT} (pid: ${process.pid})`
        );
      });
    } catch (err) {
      logger.fatal(err, 'Failed to start Ingress Gateway');
      process.exit(1);
    }
  })();
}