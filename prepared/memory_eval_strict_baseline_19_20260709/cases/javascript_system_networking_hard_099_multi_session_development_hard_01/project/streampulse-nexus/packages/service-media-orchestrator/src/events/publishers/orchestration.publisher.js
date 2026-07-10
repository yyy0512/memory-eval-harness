```javascript
/**
 * StreamPulse Nexus – Media Orchestrator
 * OrchestrationPublisher
 * --------------------------------------
 * Responsible for publishing high-level orchestration events (routing changes,
 * transcoder spin-ups, audience surge mitigation, etc.) to the message broker
 * so that downstream components (edge nodes, dashboards, disaster-recovery
 * processors) can react in real-time.
 *
 * Core design goals:
 *   • Low-latency, at-least-once delivery
 *   • Correlation-ID propagation for distributed tracing
 *   • JSON-Schema validation for payload integrity
 *   • Resilient connection handling with exponential back-off
 *
 * NOTE: All configuration is driven via environment variables so that the same
 * Docker image can be reused in staging/production with different broker URLs.
 */

import { Kafka, logLevel } from 'kafkajs';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import Ajv from 'ajv';

const DEFAULT_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const DEFAULT_CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'streampulse-media-orchestrator';
const DEFAULT_TOPIC = process.env.ORCHESTRATION_TOPIC || 'streampulse.orchestration.v1';
const CONNECT_RETRY_LIMIT = Number(process.env.KAFKA_CONNECT_RETRY_LIMIT) || 5;
const CONNECT_RETRY_BASE_DELAY_MS = Number(process.env.KAFKA_CONNECT_RETRY_BASE_DELAY_MS) || 500;

// ----------------------------------------------------------------------------
// Event Types & Schemas
// ----------------------------------------------------------------------------

/**
 * Enumeration of orchestration event types.  Each type has a corresponding
 * JSON-schema that is validated before publish.
 */
export const OrchestrationEventType = Object.freeze({
  ROUTING_UPDATE: 'ROUTING_UPDATE',
  TRANSCODER_SCALE: 'TRANSCODER_SCALE',
  AUDIENCE_SURGE: 'AUDIENCE_SURGE',
  HEALTH_ALERT: 'HEALTH_ALERT',
  SECURITY_VIOLATION: 'SECURITY_VIOLATION',
});

/**
 * JSON-schemas keyed by event type.  Keeps publisher and subscriber honest.
 * Strict schema enforcement minimizes runtime errors caused by malformed data.
 */
const eventSchemas = {
  [OrchestrationEventType.ROUTING_UPDATE]: {
    type: 'object',
    required: ['nodeId', 'newRoute', 'previousRoute'],
    additionalProperties: false,
    properties: {
      nodeId: { type: 'string' },
      previousRoute: { type: 'string' },
      newRoute: { type: 'string' },
      reason: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
    },
  },

  [OrchestrationEventType.TRANSCODER_SCALE]: {
    type: 'object',
    required: ['clusterId', 'desiredReplicas'],
    additionalProperties: false,
    properties: {
      clusterId: { type: 'string' },
      prevReplicas: { type: 'integer', minimum: 0 },
      desiredReplicas: { type: 'integer', minimum: 0 },
      trigger: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
    },
  },

  [OrchestrationEventType.AUDIENCE_SURGE]: {
    type: 'object',
    required: ['region', 'surgeFactor'],
    additionalProperties: false,
    properties: {
      region: { type: 'string' },
      surgeFactor: { type: 'number', minimum: 1 },
      concurrentViewers: { type: 'integer', minimum: 0 },
      at: { type: 'string', format: 'date-time' },
    },
  },

  [OrchestrationEventType.HEALTH_ALERT]: {
    type: 'object',
    required: ['nodeId', 'severity', 'summary'],
    additionalProperties: false,
    properties: {
      nodeId: { type: 'string' },
      severity: { type: 'string', enum: ['INFO', 'WARN', 'ERROR', 'CRITICAL'] },
      summary: { type: 'string' },
      details: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
    },
  },

  [OrchestrationEventType.SECURITY_VIOLATION]: {
    type: 'object',
    required: ['attackVector', 'sourceIp', 'severity'],
    additionalProperties: false,
    properties: {
      attackVector: { type: 'string' },
      sourceIp: { type: 'string', format: 'ipv4' },
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      nodeId: { type: 'string' },
      at: { type: 'string', format: 'date-time' },
    },
  },
};

// ----------------------------------------------------------------------------
// OrchestrationPublisher Implementation
// ----------------------------------------------------------------------------

export default class OrchestrationPublisher {
  /**
   * @param {object} [options]
   * @param {pino.Logger} [options.logger] – custom pino logger instance
   * @param {string[]} [options.brokers] – list of Kafka brokers
   * @param {string} [options.clientId] – Kafka client id
   * @param {string} [options.topic] – Kafka topic where orchestration events are published
   */
  constructor(options = {}) {
    this.logger = options.logger || pino({ name: 'orchestration-publisher' });
    this.brokers = options.brokers || DEFAULT_BROKERS;
    this.clientId = options.clientId || DEFAULT_CLIENT_ID;
    this.topic = options.topic || DEFAULT_TOPIC;

    // AJV instance with ISO date-time format support
    this.ajv = new Ajv({ allErrors: true, removeAdditional: 'failing' });
    this.validatorCache = new Map();

    this.kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      logLevel: logLevel.NOTHING, // silence kafkajs internal logs; we use our own logger
    });

    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,          // ensure no duplicates on retries
      retry: {
        retries: 8,
        factor: 0.2,
        multiplier: 2,
        maxRetryTime: 30_000,
      },
    });

    this.isConnected = false;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Connects to Kafka with exponential back-off retries.
   */
  async connect() {
    let attempt = 0;
    let delay = CONNECT_RETRY_BASE_DELAY_MS;

    while (attempt < CONNECT_RETRY_LIMIT) {
      try {
        ++attempt;
        await this.producer.connect();
        this.isConnected = true;
        this.logger.info(
          {
            brokers: this.brokers,
            topic: this.topic,
          },
          'Connected to Kafka broker'
        );
        return;
      } catch (err) {
        this.logger.warn(
          { err, attempt, delay },
          'Failed to connect to Kafka, will retry'
        );
        await this.#sleep(delay);
        delay *= 2; // exponential back-off
      }
    }

    const err = new Error(
      `Unable to connect to Kafka after ${CONNECT_RETRY_LIMIT} attempts`
    );
    this.logger.error(err);
    throw err;
  }

  /**
   * Publishes an orchestration event after validating payload.
   *
   * @param {string} type – one of OrchestrationEventType.*
   * @param {object} payload – JSON payload conforming to schema
   * @param {object} [options]
   * @param {string} [options.correlationId] – propagate trace context
   * @param {number} [options.timeout] – override default send timeout
   */
  async publish(type, payload, options = {}) {
    const { correlationId = uuidv4(), timeout = 10_000 } = options;

    if (!this.isConnected) {
      throw new Error(
        'Publisher is not connected – call connect() before publish()'
      );
    }

    // Validate type
    if (!OrchestrationEventType[type]) {
      throw new Error(`Unknown orchestration event type: ${type}`);
    }

    // Validate payload
    this.#validatePayload(type, payload);

    // Build message envelope
    const message = {
      key: correlationId, // ensures messages with same correlationId are on same partition
      timestamp: Date.now().toString(),
      headers: {
        'x-correlation-id': correlationId,
        'x-event-type': type,
        'x-service': 'service-media-orchestrator',
      },
      value: JSON.stringify({ type, payload }),
    };

    // Send
    try {
      await this.producer.send({
        topic: this.topic,
        messages: [message],
        timeout,
      });

      this.logger.debug(
        {
          type,
          correlationId,
          size: Buffer.byteLength(message.value, 'utf8'),
        },
        'Published orchestration event'
      );
    } catch (err) {
      this.logger.error(
        { err, type, correlationId },
        'Failed to publish orchestration event'
      );
      throw err; // surface error to caller for retry/back-pressure logic
    }
  }

  /**
   * Gracefully disconnects from Kafka, flushing in-flight messages.
   */
  async disconnect() {
    if (!this.isConnected) return;
    try {
      await this.producer.disconnect();
      this.logger.info('Disconnected from Kafka broker');
    } finally {
      this.isConnected = false;
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Validates the payload against the JSON Schema for the given event type.
   * Caches compiled validators for performance.
   *
   * @private
   */
  #validatePayload(type, payload) {
    let validate = this.validatorCache.get(type);
    if (!validate) {
      const schema = eventSchemas[type];
      validate = this.ajv.compile(schema);
      this.validatorCache.set(type, validate);
    }

    const valid = validate(payload);
    if (!valid) {
      const message = this.ajv.errorsText(validate.errors);
      throw new Error(
        `Payload validation failed for ${type}: ${message}`
      );
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ----------------------------------------------------------------------------
// Singleton Export (common in Node.js microservices)
// ----------------------------------------------------------------------------

/**
 * Rather than have each module construct its own publisher (which would create
 * multiple connections and waste sockets), we expose a single shared instance
 * that lives for the process lifetime.
 */
export const publisher = new OrchestrationPublisher();

// Automatically establish connection when the module is first imported.
// Call publisher.disconnect() on graceful shutdown (SIGTERM, etc.).
(async () => {
  try {
    await publisher.connect();
  } catch (err) {
    // If we fail early, bubble up so that the orchestrator container can crash
    // and be restarted by Kubernetes, systemd, etc.
    // eslint-disable-next-line no-console
    console.error('Fatal: unable to start OrchestrationPublisher', err);
    process.exit(1);
  }
})();
```