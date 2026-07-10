```markdown
# ADR-002: Adopt RabbitMQ as the Core Event Bus

*Status*         | _Accepted_  
*Date*           | 2024-06-01  
*Deciders*       | Architecture Guild (Networking & Observability)  
*Driver*         | @sara-mistry (Platform Staff Engineer)  
*Consulted*      | SRE, Security, Data-Engineering, Media-Pipeline teams  
*Impact*         | High (cross-service communication, monitoring, fail-over)

---

## 1  Context

StreamPulse Nexus is a constellation of loosely-coupled micro-services that orchestrate:

* Media packet routing (ingress/egress, transcoding, edge caching)  
* Real-time audience interactions (chat, polls, synchronized AR)  
* Telemetry (health, QoS, ML-driven highlight detection)  
* SRE automation (alerting, self-healing, disaster recovery)

Our existing **Observer + Command** patterns rely on a lightweight in-memory `EventEmitter`, which collapses at scale and breaks service isolation (single process boundary). We need a durable, mesh-aware **Event Bus** that satisfies:

Requirement                            | Target
-------------------------------------- | -------------------------------------------------------------
QoS                                     | ≤ 50 ms end-to-end latency (p99) across regions
Throughput                              | ≥ 250 K msgs/sec sustained, 1 M burst
Reliability                             | 4 × “9s” (99.99 %) message durability
Delivery semantics                      | At-least-once (idempotent consumers), FIFO per routing key
Security                                | Mutual-TLS, channel ACL, FIPS-certified crypto
Operational visibility                  | Native Prometheus metrics, OTEL traces, dead-letter queues
Multi-tenant isolation                  | Logical vhosts per show / environment

After a spike of three contenders—Apache Kafka, NATS JetStream, and RabbitMQ—we unanimously converged on **RabbitMQ**.

---

## 2  Decision

1. Provision a 5-node RabbitMQ cluster (Quorum Queues) per latency zone  
2. Back the cluster with **RAID-10 NVMe** for deterministic write latency  
3. Use **TLS 1.3** on all ports (AMQP 0-9-1 & AMQP 1.0) with short-lived certs from Vault  
4. Enable [`rabbitmq_peer_discovery_k8s`] for zero-touch scaling  
5. Expose _two_ logical vhosts:  
   • `nexus-prod` – production traffic  
   • `nexus-stage` – integration tests / canaries  
6. Enforce per-tenant topic prefixes: `tenantId.entity.event` (e.g., `riot.game.score`)  
7. Mandate mandatory publishing + publisher confirms; reject unroutable messages to safeguard uptime  
8. Wire in Prometheus & OTEL exporters; pump DLQ events to Sentry + Slack (`#pager`)  
9. Provide a hardened JS client (`@streampulse/event-bus`) with reconnection, back-pressure, and structured logging (pino)

---

## 3  Consequences

Positive  
• Sub-50 ms global propagation due to federated topology  
• Repeatable disaster recovery using Quorum Queue snapshots  
• Seamless blue/green releases – parallel vhosts during cut-over  
• Lower total cost (≈ 40 % cheaper than managed Kafka tier at equal throughput)

Negative / Trade-offs  
• Quorum Queues impose 1.4× write amplification vs. single leader Kafka  
• At-least-once means consumers must deduplicate (we provide a helper)  
• Two protocols (0-9-1 / 1.0) complicate polyglot clients; we standardise on amqplib for Node, spring-amqp for Java

Mitigations  
• Bench-tested write-amplified IO ceiling (NVMe saves us)  
• Provided idempotency key utilities in `@streampulse/event-bus`  
• Contract tests enforce protocol conformity in CI (Testcontainers + WireMock)

---

## 4  Alternatives Considered

| Candidate      | Scorecard (1–5) | Key Gaps                                       |
| -------------- | --------------- | ---------------------------------------------- |
| Apache Kafka   | 4               | High lat (<250 ms at p99) under small payloads |
| NATS JetStream | 3               | Lacks native ACL; clustering unstable at scale |
| gRPC Stream    | 2               | Point-to-point only; reinvents routing logic   |

---

## 5  Implementation Notes (Node.js)

### 5.1 Package Layout

```
packages/
  event-bus/
    src/
      index.js          ← public facade
      connection.js     ← singleton connection w/ retry
      publisher.js      ← confirm-mode publishing
      consumer.js       ← subscription helper
    tests/
      integration.test.js
```

### 5.2 Code Excerpt – `connection.js`

```javascript
/**
 * @fileoverview RabbitMQ connection singleton with jittered exponential back-off.
 */

'use strict';

const amqplib           = require('amqplib');
const pino              = require('pino')();
const { setTimeout }    = require('timers/promises');

const DEFAULT_OPTS = {
  reconnect: {
    retries : 10,
    factor  : 2,
    min     : 1000, // 1s
    max     : 30000 // 30s
  }
};

class ConnectionManager {
  constructor (url, opts = {}) {
    this.url       = url;
    this.opts      = { ...DEFAULT_OPTS, ...opts };
    this._conn     = null;
    this._closing  = false;
  }

  async get () {
    if (this._conn) return this._conn;

    let attempt = 0;
    while (!this._closing) {
      try {
        this._conn = await amqplib.connect(this.url, {
          heartbeat : 5,
          noDelay   : true,
          locale    : 'en_US'
        });

        this._conn.on('error', (err) => {
          pino.error({ err }, 'AMQP connection error');
        });

        this._conn.on('close', async () => {
          if (this._closing) return;
          pino.warn('AMQP connection closed, attempting to reconnect');
          this._conn = null;
          await this._delay(this._nextDelay(++attempt));
        });

        pino.info('AMQP connection established');
        return this._conn;
      } catch (err) {
        pino.error({ err, attempt }, 'Failed to connect to AMQP broker');
        await this._delay(this._nextDelay(++attempt));
      }
    }
    throw new Error('ConnectionManager: shutting down');
  }

  async close () {
    this._closing = true;
    if (this._conn) await this._conn.close();
  }

  _nextDelay (attempt) {
    const { min, max, factor } = this.opts.reconnect;
    return Math.min(max, Math.round(min * Math.pow(factor, attempt)));
  }

  _delay (ms) {
    // Add jitter ±20 %
    const jitter = ms * (0.2 * Math.random() - 0.1);
    return setTimeout(ms + jitter);
  }
}

module.exports = new ConnectionManager(process.env.RABBITMQ_URL);
```

### 5.3 Publishing Helper – `publisher.js`

```javascript
'use strict';

const log  = require('pino')();
const conn = require('./connection');

class Publisher {
  async init () {
    this.channel = await (await conn.get()).createConfirmChannel();
    this.channel.on('error', (err) => log.error({ err }, 'channel error'));
  }

  async publish ({ exchange, routingKey, message, headers = {} }) {
    if (!this.channel) await this.init();
    return new Promise((resolve, reject) => {
      const ok = this.channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          contentType   : 'application/json',
          persistent    : true,
          appId         : 'streampulse-nexus',
          headers
        },
        (err, ok) => (err ? reject(err) : resolve(ok))
      );

      if (!ok) log.warn('Back-pressure detected on publish()');
    });
  }
}

module.exports = new Publisher();
```

### 5.4 Consumer Skeleton – `consumer.js`

```javascript
'use strict';

const log      = require('pino')();
const conn     = require('./connection');

class Consumer {
  constructor ({ queue, onMessage, concurrency = 5 }) {
    this.queue       = queue;
    this.onMessage   = onMessage;
    this.concurrency = concurrency;
  }

  async start () {
    const channel = await (await conn.get()).createChannel();
    await channel.prefetch(this.concurrency);

    channel.consume(this.queue, async (msg) => {
      if (!msg) return;

      try {
        await this.onMessage(JSON.parse(msg.content.toString()), msg);
        channel.ack(msg);
      } catch (err) {
        log.error({ err }, 'consumer failed, sending to DLQ');
        channel.nack(msg, false, false); // dead‐letter
      }
    });

    log.info({ queue: this.queue }, 'consumer started');
  }
}

module.exports = Consumer;
```

---

## 6  Security Considerations

1. Clients must authenticate with short-lived certs (≤ 24 h) issued by Vault PKI.  
2. Firewalls restrict AMQP ports (5671) to service CIDRs only; no public ingress.  
3. Queues hosting _personal data_ (GDPR) use server-side AES-256-GCM at-rest encryption (LUKS).  
4. Policy prevents `x-message-ttl: 0` to avoid unbounded retention risk.

---

## 7  Migration Plan

Phase | Step | Owner | Status
----- | ---- | ----- | ------
I     | Provision cluster via Terraform modules | SRE | ✅
II    | Ship `@streampulse/event-bus` SDK, deprecate in-memory emitter | Platform | 🔄
III   | Gradually move services (10 % ‑> 100 %) using canary routing | Guild | ⬜
IV    | Decommission legacy emitter, archive ADR-001 | Architecture | ⬜

---

## 8  References

* “Quorum Queues in RabbitMQ 3.12” – Brouër et al., 2023  
* OWASP AMQP Security Cheat-Sheet  
* RFC 7807 – Problem Details for HTTP APIs (used in error envelopes)  
* Internal Confluence ‟SLA Matrix” – SPN-DOC-0042

---

_This document lives in `docs/architecture/adr/002-rabbitmq-for-event-bus.md` and is governed by the Architecture Decision Record (ADR) process. Revisions require a pull-request and two approvers from the Architecture Guild._
```