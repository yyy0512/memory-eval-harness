```javascript
/**
 * PayPalsphere – Compliance Service
 * ---------------------------------
 * Infrastructure Component: AuditLogWriter
 *
 * Persists signed, immutable audit-trail entries to cold storage (AWS S3).
 * The component validates the event shape, generates a canonical JSON
 * representation, calculates an RSA-SHA256 signature, and uploads the
 * resulting envelope to S3 with server-side encryption (SSE-KMS).
 *
 * Design considerations:
 *  - Validation powered by AJV to guard against malformed events
 *  - Deterministic (canonical) JSON serialization to ensure the signature
 *    is reproducible and verifiable by downstream services
 *  - Retries with exponential back-off (p-retry) for network resilience
 *  - Dependency injection to facilitate unit testing & local development
 *
 * Environment variables consumed by the factory:
 *  - AUDIT_S3_BUCKET            (required)
 *  - AUDIT_S3_PREFIX            (optional, default: audit-logs/)
 *  - AUDIT_PRIVATE_KEY_PEM      (base64 encoded PEM, required)
 *  - AWS_REGION                 (required by AWS SDK)
 *  - AWS_KMS_KEY_ID             (optional, used for SSE-KMS)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Ajv from 'ajv';
import pRetry from 'p-retry';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import winston from 'winston';

/**
 * Helper: simple canonical JSON stringify (keys sorted alphabetically).
 *
 * NOTE: This is adequate for small/medium objects. For very large or deeply
 * nested payloads consider streaming canonicalizers to avoid memory pressure.
 */
const canonicalStringify = (obj) =>
  JSON.stringify(obj, Object.keys(obj).sort(), 2);

/**
 * Build a Winston logger instance if one was not provided by DI container.
 */
const defaultLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

/**
 * JSON Schema for audit events. Extend as necessary from domain requirements.
 * All services should reuse the same schema contract to keep signatures stable.
 */
const AUDIT_EVENT_BASE_SCHEMA = {
  type: 'object',
  required: ['eventName', 'actorId', 'data', 'sequence', 'createdAt'],
  additionalProperties: false,
  properties: {
    eventName: { type: 'string', minLength: 3 },
    actorId: { type: 'string', minLength: 1 },
    data: { type: 'object' },
    sequence: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export default class AuditLogWriter {
  /**
   * @param {Object}                    deps
   * @param {S3Client}                  deps.s3Client
   * @param {string}                    deps.bucketName
   * @param {string}                    deps.objectKeyPrefix
   * @param {string}                    deps.privateKeyPem
   * @param {winston.Logger}            deps.logger
   * @param {Object}                    deps.schema      JSON Schema for event validation
   * @param {number}   [deps.maxRetries=3]
   */
  constructor({
    s3Client,
    bucketName,
    objectKeyPrefix,
    privateKeyPem,
    logger = defaultLogger,
    schema = AUDIT_EVENT_BASE_SCHEMA,
    maxRetries = 3,
  }) {
    if (!s3Client) throw new Error('s3Client is required');
    if (!bucketName) throw new Error('bucketName is required');
    if (!privateKeyPem) throw new Error('privateKeyPem is required');

    this._s3 = s3Client;
    this._bucket = bucketName;
    this._prefix = objectKeyPrefix || 'audit-logs/';
    this._logger = logger;
    this._maxRetries = maxRetries < 1 ? 1 : maxRetries;

    /* eslint-disable new-cap */
    const ajv = new Ajv({ allErrors: true, useDefaults: true });
    this._validate = ajv.compile(schema);
    /* eslint-enable new-cap */

    // Pre-load the key into a KeyObject for faster signing
    try {
      this._privateKey = crypto.createPrivateKey({
        key: Buffer.from(privateKeyPem, 'base64').toString('utf8'),
        format: 'pem',
      });
    } catch (err) {
      throw new Error(`Invalid private key provided: ${err.message}`);
    }
  }

  /**
   * Write a signed audit event to S3.
   *
   * @param {Object} event         – domain event payload
   * @param {Object} [context={}]  – meta (service, ip, txnId, etc.)
   * @returns {Promise<string>}    – S3 object key for reference
   */
  async write(event, context = {}) {
    const startTime = Date.now();

    // 1. Validate against JSON Schema
    if (!this._validate(event)) {
      const err = new Error(
        `Audit event validation failed: ${JSON.stringify(this._validate.errors)}`
      );
      this._logger.warn(err.message, { event });
      throw err;
    }

    // 2. Create envelope
    const envelope = this._buildEnvelope(event, context);

    // 3. Sign envelope
    const { signature, canonical } = this._signEnvelope(envelope);
    const signedEnvelope = { ...envelope, signature };

    // 4. Persist to S3 with retries
    const objectKey = this._objectKey(envelope);

    await pRetry(
      () => this._putToS3(objectKey, canonical, signature),
      {
        retries: this._maxRetries,
        factor: 2,
        minTimeout: 250,
        onFailedAttempt: (err) => {
          this._logger.warn('AuditLogWriter upload retry', {
            attempt: err.attemptNumber,
            retriesLeft: err.retriesLeft,
            error: err.message,
          });
        },
      }
    );

    this._logger.info('AuditLogWriter success', {
      objectKey,
      durationMs: Date.now() - startTime,
    });

    return objectKey;
  }

  /**
   * Build a deterministic S3 object key to ease downstream partitioning.
   * Example: audit-logs/2023/11/14/compliance-service/uuid.json
   */
  _objectKey({ header }) {
    const [yyyy, mm, dd] = new Date(header.occurredAt)
      .toISOString()
      .split('T')[0]
      .split('-');
    return `${this._prefix}${yyyy}/${mm}/${dd}/${header.service}/${header.id}.json`;
  }

  /**
   * Perform the actual PutObject call to S3.
   * @private
   */
  async _putToS3(Key, canonicalPayload, signature) {
    const params = {
      Bucket: this._bucket,
      Key,
      Body: canonicalPayload,
      ContentType: 'application/json',
      Metadata: {
        'pp-signature': signature,
        'pp-service': 'compliance-service',
      },
      // Enable server-side encryption with KMS if key id provided
      ...(process.env.AWS_KMS_KEY_ID
        ? {
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: process.env.AWS_KMS_KEY_ID,
          }
        : { ServerSideEncryption: 'AES256' }),
    };

    await this._s3.send(new PutObjectCommand(params));
  }

  /**
   * Construct the envelope wrapper.
   * @private
   */
  _buildEnvelope(event, context) {
    return {
      header: {
        id: uuidv4(),
        occurredAt: new Date().toISOString(),
        service: 'compliance-service',
        version: 1,
        context,
      },
      event,
    };
  }

  /**
   * Canonicalize and sign envelope with RSA-SHA256.
   * @returns {Object} { canonical: string, signature: string }
   * @private
   */
  _signEnvelope(envelope) {
    const canonical = canonicalStringify(envelope);
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonical);
    signer.end();

    const signature = signer.sign(this._privateKey, 'base64');
    return { canonical, signature };
  }

  /**
   * Factory that wires dependencies using environment variables.
   * Example usage:
   *   const writer = AuditLogWriter.createDefault();
   */
  static createDefault({
    s3Client,
    logger = defaultLogger,
    overrides = {},
  } = {}) {
    const bucketName =
      process.env.AUDIT_S3_BUCKET || overrides.bucketName;
    if (!bucketName) {
      throw new Error(
        'AUDIT_S3_BUCKET env var must be set for AuditLogWriter'
      );
    }

    const privateKeyPem =
      process.env.AUDIT_PRIVATE_KEY_PEM || overrides.privateKeyPem;
    if (!privateKeyPem) {
      throw new Error(
        'AUDIT_PRIVATE_KEY_PEM env var must be set for AuditLogWriter'
      );
    }

    const objectKeyPrefix =
      process.env.AUDIT_S3_PREFIX || overrides.objectKeyPrefix || 'audit-logs/';

    const s3 =
      s3Client ||
      new S3Client({
        region: process.env.AWS_REGION,
        maxAttempts: 3,
      });

    return new AuditLogWriter({
      s3Client: s3,
      bucketName,
      objectKeyPrefix,
      privateKeyPem,
      logger,
      ...overrides,
    });
  }
}
```