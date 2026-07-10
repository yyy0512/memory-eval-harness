```javascript
/**
 * PayPalsphere :: Transactions Service
 * infrastructure/event-store.js
 *
 * A lightweight, production-ready Event Store implementation backed by PostgreSQL.
 *  • Optimistic concurrency control with versioned streams
 *  • Field–level encryption at rest  (AES-256-GCM)
 *  • Correlation & causation metadata for sagas / audit trail
 *  • Snapshot utilities for efficient aggregate re-hydration
 *
 * NOTE:
 *   • Database migrations for the underlying tables are expected to
 *     be executed at bootstrap by the DevOps pipeline. See ./migrations/*.sql
 *   • Errors surface as typed EventStoreError instances so callers
 *     can act accordingly without leaking internals.
 */

import { Pool } from 'pg';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import assert from 'assert';

/* -------------------------------------------------------------------------- */
/*                               CONFIGURATION                                */
/* -------------------------------------------------------------------------- */

const {
  PG_HOST,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  PG_DATABASE,
  EVENT_STORE_ENCRYPTION_KEY,
} = process.env;

if (!EVENT_STORE_ENCRYPTION_KEY || EVENT_STORE_ENCRYPTION_KEY.length !== 64) {
  throw new Error(
    'EVENT_STORE_ENCRYPTION_KEY env var must be a 64-character hex string (32 byte key)'
  );
}

const pool = new Pool({
  host: PG_HOST,
  port: Number(PG_PORT || 5432),
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
  max: 10,
  idleTimeoutMillis: 30_000,
});

/* -------------------------------------------------------------------------- */
/*                                   TYPES                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} EventEnvelope
 * @property {string} id           – Unique id for the event (UUID v4)
 * @property {string} stream_id    – Aggregate stream id
 * @property {number} version      – Stream version for optimistic concurrency
 * @property {string} type         – Domain event name
 * @property {Object} data         – Payload (encrypted at rest)
 * @property {Object} metadata     – Correlation, causation, user agent, etc.
 * @property {Date}   created_at   – Timestamp UTC
 */

/* -------------------------------------------------------------------------- */
/*                                   ERRORS                                   */
/* -------------------------------------------------------------------------- */

export class EventStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EventStoreError';
    this.code = code;
  }
}

export const ErrorCodes = {
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',
  STREAM_NOT_FOUND: 'STREAM_NOT_FOUND',
  SNAPSHOT_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
};

/* -------------------------------------------------------------------------- */
/*                              ENCRYPTION UTIL                               */
/* -------------------------------------------------------------------------- */

const AES_KEY = Buffer.from(EVENT_STORE_ENCRYPTION_KEY, 'hex'); // 32 bytes
const AES_ALGO = 'aes-256-gcm';

/**
 * Encrypt JSON serializable payload.
 * @param {Object} payload
 * @returns {Object} { iv, tag, ciphertext } – All hex encoded
 */
function encrypt(payload) {
  const iv = crypto.randomBytes(12); // 96-bit nonce
  const cipher = crypto.createCipheriv(AES_ALGO, AES_KEY, iv, { authTagLength: 16 });
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypt previously encrypted payload.
 * @param {Object} param0 { iv, tag, ciphertext }
 * @returns {Object} Plain JSON object
 */
function decrypt({ iv, tag, ciphertext }) {
  const decipher = crypto.createDecipheriv(
    AES_ALGO,
    AES_KEY,
    Buffer.from(iv, 'hex'),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

/* -------------------------------------------------------------------------- */
/*                                EVENT STORE                                 */
/* -------------------------------------------------------------------------- */

export class EventStore {
  /**
   * Append events to a stream using optimistic concurrency control.
   *
   * @param {string} streamId Aggregate root identifier
   * @param {Array<{ type: string, data: Object, metadata?: Object }>} events
   * @param {number} expectedVersion  -1 for new stream, otherwise last known version
   * @returns {Promise<EventEnvelope[]>}
   */
  static async appendToStream(streamId, events, expectedVersion = -1) {
    assert(streamId, 'streamId required');
    assert(Array.isArray(events) && events.length, 'non-empty events array required');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check current version
      const { rows: versionRows } = await client.query(
        `
          SELECT COALESCE(MAX(version), -1) AS current_version
          FROM event_store
          WHERE stream_id = $1
          FOR UPDATE
        `,
        [streamId]
      );

      const currentVersion = Number(versionRows[0].current_version);
      if (currentVersion !== expectedVersion) {
        throw new EventStoreError(
          `Concurrency conflict on stream ${streamId}. Expected v${expectedVersion}, got v${currentVersion}`,
          ErrorCodes.CONCURRENCY_CONFLICT
        );
      }

      // Insert events
      const envelopes = [];
      for (let i = 0; i < events.length; i++) {
        const { type, data, metadata = {} } = events[i];
        const version = expectedVersion + 1 + i;
        const id = uuid();

        const encryptedData = encrypt(data);
        const insertText = `
          INSERT INTO event_store (
            id, stream_id, version, type, data, metadata
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        `;
        await client.query(insertText, [
          id,
          streamId,
          version,
          type,
          JSON.stringify(encryptedData),
          JSON.stringify({
            causation_id: metadata.causation_id || null,
            correlation_id: metadata.correlation_id || null,
            actor_id: metadata.actor_id || null,
            user_agent: metadata.user_agent || null,
            ip: metadata.ip || null,
          }),
        ]);

        envelopes.push({
          id,
          stream_id: streamId,
          version,
          type,
          data,
          metadata,
          created_at: new Date(),
        });
      }

      await client.query('COMMIT');
      return envelopes;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof EventStoreError) throw err;
      throw new EventStoreError(err.message);
    } finally {
      client.release();
    }
  }

  /**
   * Read events for a given stream.
   *
   * @param {string} streamId
   * @param {number} [fromVersion=0]  Inclusive
   * @param {number} [limit=1000]
   */
  static async readStream(streamId, fromVersion = 0, limit = 1000) {
    assert(streamId, 'streamId required');
    const { rows } = await pool.query(
      `
        SELECT *
        FROM event_store
        WHERE stream_id = $1 AND version >= $2
        ORDER BY version ASC
        LIMIT $3
      `,
      [streamId, fromVersion, limit]
    );

    if (!rows.length && fromVersion === 0) {
      throw new EventStoreError(`Stream ${streamId} not found`, ErrorCodes.STREAM_NOT_FOUND);
    }

    return rows.map(deserializeRow);
  }

  /**
   * Read events by correlation id—useful for sagas or audit trail traceability.
   *
   * @param {string} correlationId
   * @returns {Promise<EventEnvelope[]>}
   */
  static async readByCorrelationId(correlationId) {
    const { rows } = await pool.query(
      `
        SELECT *
        FROM event_store
        WHERE metadata ->> 'correlation_id' = $1
        ORDER BY created_at ASC
      `,
      [correlationId]
    );
    return rows.map(deserializeRow);
  }

  /* ---------------------------------------------------------------------- */
  /*                               SNAPSHOTS                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Save snapshot for an aggregate.
   *
   * @param {string} streamId
   * @param {number} version   Last event version included in the snapshot
   * @param {Object} state     Aggregate root compressed state
   */
  static async saveSnapshot(streamId, version, state) {
    assert(streamId, 'streamId required');
    assert(Number.isInteger(version) && version >= 0, 'version must be int >= 0');

    const encryptedState = encrypt(state);
    await pool.query(
      `
        INSERT INTO event_store_snapshots (stream_id, version, state)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (stream_id) DO UPDATE
        SET version = EXCLUDED.version,
            state   = EXCLUDED.state,
            updated_at = NOW()
      `,
      [streamId, version, JSON.stringify(encryptedState)]
    );
  }

  /**
   * Load latest snapshot for a stream.
   *
   * @param {string} streamId
   * @returns {Promise<{ version: number, state: Object } | null>}
   */
  static async loadSnapshot(streamId) {
    const { rows } = await pool.query(
      `
        SELECT version, state
        FROM event_store_snapshots
        WHERE stream_id = $1
        LIMIT 1
      `,
      [streamId]
    );

    if (!rows.length) return null;

    const { version, state } = rows[0];
    return { version, state: decrypt(state) };
  }

  /* ---------------------------------------------------------------------- */
  /*                              MAINTENANCE                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Soft delete events for GDPR forget-me or compliance redaction.
   *
   * @param {string} streamId
   * @param {string[]} eventIds
   */
  static async redact(streamId, eventIds) {
    assert(Array.isArray(eventIds) && eventIds.length, 'eventIds array required');

    await pool.query(
      `
        UPDATE event_store
        SET data = '{}'::jsonb,
            metadata = jsonb_set(metadata, '{redacted}', 'true', true)
        WHERE stream_id = $1 AND id = ANY($2::uuid[])
      `,
      [streamId, eventIds]
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                               HELPERS                                      */
/* -------------------------------------------------------------------------- */

/**
 * Map DB row to EventEnvelope with decrypted payload.
 * @param {any} row
 * @returns {EventEnvelope}
 */
function deserializeRow(row) {
  return {
    id: row.id,
    stream_id: row.stream_id,
    version: row.version,
    type: row.type,
    data: decrypt(row.data),
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/*                            HEALTH-CHECK PING                              */
/* -------------------------------------------------------------------------- */

/**
 * Simple liveness probe that ensures the database connection is alive.
 * Call from Kubernetes /health endpoint.
 */
export async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}
```