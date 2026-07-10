```javascript
/**
 * paypalsphere/services/compliance-service/src/application/reporting.js
 *
 * High-level application service responsible for generating, signing and
 * distributing regulatory compliance reports (e.g. SAR – Suspicious Activity
 * Report) from the event-sourced ledger.  All I/O is abstracted behind small,
 * focused ports that get injected at construction time, making the
 * implementation easily testable and framework-agnostic.
 *
 * Author: PayPalsphere Compliance Team
 * Copyright: (c) 2024
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────── *\
 * Dependencies                                                             *
\* ────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { EventEmitter } = require('events');
const { stringify } = require('csv-stringify/sync');
const { createLogger, format, transports } = require('winston');
const Ajv = require('ajv');
const dayjs = require('dayjs');

/* ────────────────────────────────────────────────────────────────────────── *\
 * Logger                                                                   *
\* ────────────────────────────────────────────────────────────────────────── */
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [new transports.Console()],
});

/* ────────────────────────────────────────────────────────────────────────── *\
 * JSON-Schema validation setup                                             *
\* ────────────────────────────────────────────────────────────────────────── */
const ajv = new Ajv({ allErrors: true, strict: false });
const EVENT_SCHEMA = {
  $id: 'http://paypalsphere.io/schemas/compliance_event.json',
  type: 'object',
  required: ['eventId', 'type', 'occurredAt', 'payload'],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    type: { type: 'string' },
    occurredAt: { type: 'string', format: 'date-time' },
    payload: { type: 'object' },
  },
};

const validateEvent = ajv.compile(EVENT_SCHEMA);

/* ────────────────────────────────────────────────────────────────────────── *\
 * Constants                                                                *
\* ────────────────────────────────────────────────────────────────────────── */
const DEFAULT_REPORT_DIR =
  process.env.COMPLIANCE_REPORT_DIR || path.resolve('/var/paypalsphere/reports');
const SIGN_ALGO = 'sha256';
const REPORT_TYPES = Object.freeze({
  SAR: 'SuspiciousActivityReport',
  CTR: 'CurrencyTransactionReport',
});

/* ────────────────────────────────────────────────────────────────────────── *\
 * Helper Utilities                                                         *
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * Generates a SHA-256 hex digest for the provided buffer.
 * @param {Buffer|string} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash(SIGN_ALGO).update(data).digest('hex');
}

/**
 * Ensures an async function does not crash the process.
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function safeAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error({ msg: 'Unhandled exception in safeAsync', err });
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────── *\
 * ComplianceReportingService                                               *
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} EventStorePort
 * @property {(types: string[], from: Date, to: Date) => Promise<Object[]>} fetchEvents
 *
 * @typedef {Object} StoragePort
 * @property {(filename: string, data: Buffer) => Promise<void>} save
 *
 * @typedef {Object} NotificationPort
 * @property {(subject: string, body: string, meta?: Object) => Promise<void>} notify
 */

class ComplianceReportingService extends EventEmitter {
  /**
   * @param {Object}   deps
   * @param {EventStorePort}   deps.eventStore
   * @param {StoragePort}      deps.storage
   * @param {NotificationPort} deps.notification
   */
  constructor({ eventStore, storage, notification }) {
    super();

    if (!eventStore || !storage || !notification) {
      throw new Error('ComplianceReportingService missing required dependencies');
    }

    this.eventStore = eventStore;
    this.storage = storage;
    this.notification = notification;
  }

  /* ────────────────────────────────────────────────────────────────────── *\
   * Public API                                                             *
  \* ────────────────────────────────────────────────────────────────────── */

  /**
   * Generates and stores a compliance report for the given period.
   *
   * @param   {keyof typeof REPORT_TYPES} reportKey  e.g. 'SAR'
   * @param   {Date} from
   * @param   {Date} to
   * @returns {Promise<{location: string, signature: string}>}
   */
  async generateReport(reportKey, from, to) {
    if (!REPORT_TYPES[reportKey]) {
      throw new Error(`Unsupported report type "${reportKey}"`);
    }

    const reportType = REPORT_TYPES[reportKey];
    logger.info(
      { reportType, from: from.toISOString(), to: to.toISOString() },
      'Generating compliance report'
    );

    // Fetch and filter domain events
    const events = await this._collectEvents(reportKey, from, to);
    if (!events.length) {
      logger.warn({ reportType }, 'No events found for period, skipping report');
      return { location: null, signature: null };
    }

    // Build CSV artefact
    const csvBuffer = Buffer.from(this._toCsv(events), 'utf-8');
    const digest = sha256(csvBuffer);
    const { csvFilename, sigFilename } = this._fileNames(reportKey, to);

    // Persist artefacts
    await this.storage.save(csvFilename, csvBuffer);
    await this.storage.save(sigFilename, Buffer.from(digest, 'utf-8'));

    const location = path.join(DEFAULT_REPORT_DIR, csvFilename);

    logger.info(
      { reportType, location, records: events.length },
      'Compliance report persisted'
    );

    // Dispatch notification
    await this.notification.notify(
      `${reportType} ready`,
      `Your ${reportType} between ${from.toISOString()} and ${to.toISOString()} ` +
        `has been generated and stored at ${location}.`,
      { signature: digest }
    );

    // Emit domain event for other bounded contexts
    this.emit('report:generated', {
      type: reportType,
      file: location,
      signature: digest,
      generatedAt: new Date().toISOString(),
    });

    return { location, signature: digest };
  }

  /* ────────────────────────────────────────────────────────────────────── *\
   * Private Helpers                                                        *
  \* ────────────────────────────────────────────────────────────────────── */

  /**
   * Returns the correct list of event types for the requested report.
   * @param {string} reportKey
   * @returns {string[]}
   */
  _applicableEventTypes(reportKey) {
    switch (reportKey) {
      case 'SAR':
        return ['PAYMENT_REVIEWED', 'RISK_ALERT_RAISED', 'FRAUD_SUSPECTED'];
      case 'CTR':
        return ['SETTLEMENT_POSTED', 'PAYMENT_CAPTURED'];
      default:
        return [];
    }
  }

  /**
   * Collects, validates, and normalizes events.
   * @param {string} reportKey
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Object[]>}
   */
  async _collectEvents(reportKey, from, to) {
    const types = this._applicableEventTypes(reportKey);
    const rawEvents = await this.eventStore.fetchEvents(types, from, to);

    const validEvents = [];
    let discarded = 0;

    for (const evt of rawEvents) {
      if (validateEvent(evt)) {
        validEvents.push(evt);
      } else {
        discarded += 1;
        logger.debug(
          {
            errors: validateEvent.errors,
            eventId: evt?.eventId,
          },
          'Event validation failed, discarding'
        );
      }
    }

    if (discarded > 0) {
      logger.warn({ discarded }, 'Some events were discarded after schema validation');
    }

    return validEvents.map(this._normalizeEvent);
  }

  /**
   * Normalizes raw domain event into flat object used in CSV.
   * @param {Object} evt
   * @returns {Object}
   */
  _normalizeEvent(evt) {
    /* A normalizer that picks and flattens relevant properties. */
    const { eventId, type, occurredAt, payload } = evt;
    return {
      event_id: eventId,
      type,
      occurred_at: occurredAt,
      user_id: payload?.userId ?? null,
      txn_id: payload?.transactionId ?? null,
      amount: payload?.amount ?? null,
      currency: payload?.currency ?? null,
      risk_score: payload?.riskScore ?? null,
      status: payload?.status ?? null,
    };
  }

  /**
   * Converts event array into a CSV string.
   * @param {Object[]} events
   * @returns {string}
   */
  _toCsv(events) {
    return stringify(events, {
      header: true,
      columns: Object.keys(events[0] || {}),
    });
  }

  /**
   * Constructs deterministic filenames.
   * @param {string} reportKey
   * @param {Date} periodEnd
   */
  _fileNames(reportKey, periodEnd) {
    const ts = dayjs(periodEnd).format('YYYY-MM-DD_HHmmss');
    const csvFilename = `${reportKey}_${ts}.csv`;
    const sigFilename = `${csvFilename}.sha256`;

    return { csvFilename, sigFilename };
  }
}

/* ────────────────────────────────────────────────────────────────────────── *\
 * Default adapters (used in production runtime – tests inject fakes/mocks) *
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * Filesystem implementation of storage port.
 * NOTE: Production deploys could replace this with an S3 or Blob adapter.
 *
 * @type {StoragePort}
 */
const FileSystemStorage = {
  async save(filename, data) {
    const fullPath = path.join(DEFAULT_REPORT_DIR, filename);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
  },
};

/**
 * Basic stdout notification adapter; production could integrate with SNS,
 * email, Slack, etc.
 *
 * @type {NotificationPort}
 */
const StdoutNotifier = {
  async notify(subject, body, meta = {}) {
    logger.info({ subject, body, meta }, 'Compliance notification dispatched');
  },
};

/**
 * HTTP client wrapper for the Event Store micro-service.
 *
 * @type {EventStorePort}
 */
const HttpEventStore = {
  /**
   * @param {string[]} types
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<Object[]>}
   */
  async fetchEvents(types, from, to) {
    // Lazily require to avoid pulling axios into unit tests unless used
    // eslint-disable-next-line global-require
    const axios = require('axios').default;

    const res = await axios.get(process.env.EVENT_STORE_URL || 'http://event-store.local/events', {
      params: {
        types: types.join(','),
        from: from.toISOString(),
        to: to.toISOString(),
      },
      timeout: 10_000,
    });

    return res.data?.events ?? [];
  },
};

/* ────────────────────────────────────────────────────────────────────────── *\
 * Factory                                                                  *
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a singleton of ComplianceReportingService wired with the default
 * runtime adapters.  Consumers are encouraged to inject mocks/fakes for
 * isolation in unit tests.
 */
let _instance;

/**
 * @returns {ComplianceReportingService}
 */
function getReportingService() {
  if (!_instance) {
    _instance = new ComplianceReportingService({
      eventStore: HttpEventStore,
      storage: FileSystemStorage,
      notification: StdoutNotifier,
    });
  }
  return _instance;
}

/* ────────────────────────────────────────────────────────────────────────── *\
 * Module Exports                                                           *
\* ────────────────────────────────────────────────────────────────────────── */

module.exports = {
  ComplianceReportingService,
  getReportingService,
  REPORT_TYPES,
};
```