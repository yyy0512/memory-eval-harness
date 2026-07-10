```markdown
# StreamPulse Nexus — Core Architectural Patterns  
_A living technical companion for platform architects, operators, and extension developers._

> **Note**  
> All code snippets are written in modern, production-grade JavaScript (ES2022) and assume a Node.js₁⁸+ runtime.  
> Type annotations are provided with JSDoc; swap in TypeScript typings if your build pipeline supports it.

---

## Table of Contents
1. Observer Pattern — Real-time topology monitoring  
2. Event-Driven Architecture — The backbone message-bus  
3. Strategy Pattern — Pluggable load-balancing engines  
4. Command Pattern — Disaster-recovery automation  
5. Chain-of-Responsibility — Policy-as-code enforcement  

---

## 1. Observer Pattern  
_Nodes publish health, throughput, and latency events that dashboards can consume in near real-time._

```javascript
// ./src/core/observer/Observable.js
import { EventEmitter } from 'node:events';

/**
 * An Observable wraps Node.js' EventEmitter with domain-specific helpers.
 * @template TPayload
 */
export default class Observable extends EventEmitter {
  /**
   * Emit a domain event with strong typing.
   * @param {string} event
   * @param {TPayload} payload
   */
  notify(event, payload) {
    queueMicrotask(() => this.emit(event, payload));
  }

  /**
   * Register a listener that auto-unsubscribes on error.
   * @param {string} event
   * @param {(payload: TPayload) => void} listener
   */
  subscribe(event, listener) {
    const safeListener = (payload) => {
      try {
        listener(payload);
      } catch (err) {
        this.removeListener(event, safeListener);
        console.error(`[Observable] Listener error: ${err.stack}`);
      }
    };
    this.on(event, safeListener);
    return () => this.removeListener(event, safeListener);
  }
}
```

```javascript
// ./src/nodes/MediaRouter.js
import Observable from '../core/observer/Observable.js';

export default class MediaRouter {
  #bus = new Observable();

  constructor(nodeId) {
    this.nodeId = nodeId;
  }

  /** Health heartbeat every 5 s. */
  startHeartbeats() {
    setInterval(() => {
      this.#bus.notify('health/heartbeat', {
        nodeId  : this.nodeId,
        cpuLoad : process.cpuUsage(),
        memFree : process.memoryUsage().heapFree,
        ts      : Date.now(),
      });
    }, 5_000);
  }

  /**
   * External systems can subscribe to router events.
   * @param {(payload: unknown) => void} cb
   * @returns {() => void} unsubscribe
   */
  onHeartbeat(cb) {
    return this.#bus.subscribe('health/heartbeat', cb);
  }
}
```

### Usage

```javascript
const router = new MediaRouter('router-eu-1');
const unsubscribe = router.onHeartbeat(console.log);
router.startHeartbeats();

// Later …
// unsubscribe(); // stop receiving events
```

---

## 2. Event-Driven Architecture  
_A lightweight, multiplexed message-bus sits at the platform’s core, enabling loose coupling._

```javascript
// ./src/core/eventBus/index.js
import { EventEmitter } from 'node:events';

const BUS_EVENTS = {
  METRICS  : 'metrics',
  SECURITY : 'security',
  COMMAND  : 'command',
};

class EventBus extends EventEmitter {
  /**
   * Publish a namespaced event.
   * @param {keyof typeof BUS_EVENTS} channel
   * @param {Record<string, any>} data
   */
  publish(channel, data) {
    this.emit(channel, { ts: Date.now(), data });
  }

  /**
   * Subscribe to a specific channel.
   * @param {keyof typeof BUS_EVENTS} channel
   * @param {(payload: {ts:number, data:any}) => void} handler
   * @returns {() => void}
   */
  subscribe(channel, handler) {
    this.on(channel, handler);
    return () => this.removeListener(channel, handler);
  }
}

// Shared singleton
export const bus = new EventBus();
export { BUS_EVENTS };
```

```javascript
// ./src/services/metrics/index.js
import { bus, BUS_EVENTS } from '../../core/eventBus/index.js';

export function collect(nodeId, stats) {
  bus.publish(BUS_EVENTS.METRICS, { nodeId, stats });
}

// Example consumer
bus.subscribe(BUS_EVENTS.METRICS, ({ data }) => {
  // Forward to Prometheus, Grafana Loki, etc.
  console.debug(`[Metrics] ${data.nodeId}`, data.stats);
});
```

---

## 3. Strategy Pattern  
_Route packets according to dynamic show formats or audience heat-maps._

```javascript
// ./src/core/loadBalancer/index.js

/**
 * @typedef {import('./strategies/AbstractStrategy').AbstractStrategy} AbstractStrategy
 */

export default class LoadBalancer {
  /** @type {AbstractStrategy} */
  #strategy;

  /**
   * Inject a concrete strategy at runtime.
   * @param {AbstractStrategy} strategy
   */
  setStrategy(strategy) {
    this.#strategy = strategy;
  }

  /**
   * @param {object} request
   * @returns {Promise<string>} resolvedTargetNodeId
   */
  async route(request) {
    if (!this.#strategy)
      throw new Error('No load-balancing strategy configured.');
    return this.#strategy.selectTarget(request);
  }
}
```

```javascript
// ./src/core/loadBalancer/strategies/AbstractStrategy.js

/**
 * @interface
 */
export class AbstractStrategy {
  /**
   * Decide which node receives the packet.
   * @param {object} request
   * @returns {Promise<string>}
   */
  /* eslint-disable-next-line no-unused-vars */
  async selectTarget(request) {
    throw new Error('selectTarget() must be implemented by subclass');
  }
}
```

```javascript
// ./src/core/loadBalancer/strategies/GeoLatencyStrategy.js
import { AbstractStrategy } from './AbstractStrategy.js';
import geoip from 'fast-geoip';
import latencyCache from '../../utils/latencyCache.js';

export default class GeoLatencyStrategy extends AbstractStrategy {
  async selectTarget(request) {
    const { ip } = request;
    const geo = await geoip.lookup(ip);
    const candidateNodes = latencyCache.pickNearest(geo.countryCode);
    return candidateNodes[0]; // Simplified
  }
}
```

```javascript
// ./src/example/strategyUsage.js
import LoadBalancer from '../core/loadBalancer/index.js';
import GeoLatencyStrategy from '../core/loadBalancer/strategies/GeoLatencyStrategy.js';

const lb = new LoadBalancer();
lb.setStrategy(new GeoLatencyStrategy());

export async function handleIncomingPacket(pkt) {
  const target = await lb.route(pkt);
  // forwardToNode(target, pkt);
}
```

---

## 4. Command Pattern  
_Execute compound recovery operations atomically and with full audit-trail._

```javascript
// ./src/core/command/Command.js

/**
 * @interface
 */
export class Command {
  /** @returns {Promise<void>} */
  execute() { throw new Error('execute() must be implemented'); }
  /** @returns {Promise<void>} */
  undo()    { throw new Error('undo() must be implemented'); }
}
```

```javascript
// ./src/core/command/CompositeCommand.js
import { Command } from './Command.js';

export default class CompositeCommand extends Command {
  constructor() {
    super();
    /** @type {Command[]} */
    this.commands = [];
  }

  add(cmd) { this.commands.push(cmd); }

  async execute() {
    for (const cmd of this.commands) await cmd.execute();
  }

  async undo() {
    // Rollback in reverse order
    for (const cmd of [...this.commands].reverse()) await cmd.undo();
  }
}
```

```javascript
// ./src/commands/FailoverNodeCommand.js
import { Command } from '../core/command/Command.js';

export default class FailoverNodeCommand extends Command {
  constructor(nodeId, backupNodeId, orchestrator) {
    super();
    Object.assign(this, { nodeId, backupNodeId, orchestrator });
  }

  async execute() {
    await this.orchestrator.drainTraffic(this.nodeId);
    await this.orchestrator.promoteBackup(this.backupNodeId);
    console.info(`[Failover] ${this.nodeId} → ${this.backupNodeId}`);
  }

  async undo() {
    await this.orchestrator.restoreTraffic(this.nodeId);
    console.info(`[Failover-Rollback] Restored ${this.nodeId}`);
  }
}
```

```javascript
// ./src/playbooks/disasterRecovery.js
import CompositeCommand from '../core/command/CompositeCommand.js';
import FailoverNodeCommand from '../commands/FailoverNodeCommand.js';

export async function triggerDisasterRecovery(ctx) {
  const composite = new CompositeCommand();
  composite.add(new FailoverNodeCommand('core-eu-1', 'core-eu-backup-1', ctx.orchestrator));
  composite.add(new FailoverNodeCommand('edge-eu-3', 'edge-eu-backup-2', ctx.orchestrator));

  try {
    await composite.execute();
    ctx.audit.log('DR-playbook executed');
  } catch (err) {
    ctx.audit.error('DR-playbook failed', err);
    await composite.undo();
  }
}
```

---

## 5. Chain-of-Responsibility  
_Security policies and traffic shaping are enforced through reusable pipeline nodes._

```javascript
// ./src/core/pipeline/Handler.js

/**
 * @interface
 */
export class Handler {
  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
  handle(req, res) { throw new Error('handle() must be implemented'); }

  /**
   * Attach next handler in chain.
   * @param {Handler} next
   * @returns {Handler}
   */
  linkWith(next) {
    this.next = next;
    return next;
  }

  /** Forward call if next exists. */
  forward(req, res) {
    if (this.next) return this.next.handle(req, res);
    res.writeHead(404).end();
  }
}
```

```javascript
// ./src/core/pipeline/handlers/RateLimiter.js
import { Handler } from '../Handler.js';
import LRU from 'lru-cache';

export default class RateLimiter extends Handler {
  constructor({ rpm = 600 } = {}) {
    super();
    this.cache = new LRU({ maxAge: 60_000 }); // 1 min window
    this.rpm = rpm;
  }

  handle(req, res) {
    const key = `${req.socket.remoteAddress}:${req.url}`;
    const hits = (this.cache.get(key) || 0) + 1;
    this.cache.set(key, hits);

    if (hits > this.rpm) {
      res.writeHead(429).end('Too Many Requests');
      return;
    }
    this.forward(req, res);
  }
}
```

```javascript
// ./src/core/pipeline/handlers/AuthValidator.js
import { Handler } from '../Handler.js';
import jwt from 'jsonwebtoken';

export default class AuthValidator extends Handler {
  constructor(secret) {
    super();
    this.secret = secret;
  }

  handle(req, res) {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      jwt.verify(token, this.secret);
      this.forward(req, res);
    } catch {
      res.writeHead(401).end('Unauthorized');
    }
  }
}
```

```javascript
// ./src/server/httpGateway.js
import http from 'node:http';
import { Handler } from '../core/pipeline/Handler.js';
import AuthValidator from '../core/pipeline/handlers/AuthValidator.js';
import RateLimiter from '../core/pipeline/handlers/RateLimiter.js';

// Terminal handler that actually processes valid requests.
class RequestProcessor extends Handler {
  handle(req, res) {
    res.writeHead(200).end('OK');
  }
}

// Compose chain
const auth    = new AuthValidator(process.env.JWT_SECRET);
const limiter = new RateLimiter({ rpm: 900 });
auth.linkWith(limiter).linkWith(new RequestProcessor());

http.createServer((req, res) => auth.handle(req, res))
    .listen(8080, () => console.log('Gateway listening on :8080'));
```

---

## Next Steps

1. Harden observability by exporting OpenTelemetry spans from every pattern node.  
2. Move Strategy and Command implementations into versioned plugins for runtime hot-swapping.  
3. Write cross-language SDKs so external teams can subscribe to EventBus via gRPC or WebSocket.

---
```