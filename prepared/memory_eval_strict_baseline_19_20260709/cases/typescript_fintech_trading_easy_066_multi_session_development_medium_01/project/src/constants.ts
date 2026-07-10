```typescript
/*───────────────────────────────────────────────────────────────────────────────
 * MediTrade Pulse — src/constants.ts
 *
 * Global constants, environment–driven configuration, and domain enumerations
 * that are reused across all bounded contexts (Core, Risk, Settlement, API).
 * Because this file is imported virtually everywhere, it MUST remain dependency–
 * free (aside from built-ins) to avoid circular dependencies and slow start-ups.
 *──────────────────────────────────────────────────────────────────────────────*/

/* ============================================================================
 * Environment helpers
 * ============================================================================
 */

/**
 * Fetches an environment variable or throws if it is missing.
 * This defensive approach guarantees that the application fails fast in an
 * invalid deployment rather than producing undefined behaviour later on.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `[config] Required environment variable "${key}" is not set.`,
    );
  }
  return value;
}

/**
 * Parses a boolean environment variable, defaulting to `false` if undefined.
 */
function envBool(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  return raw === undefined ? defaultValue : /^true$/i.test(raw);
}

/**
 * Parses a numeric environment variable with an optional fallback.
 */
function envNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  const parsed = raw !== undefined ? Number(raw) : fallback;
  if (parsed === undefined || Number.isNaN(parsed)) {
    throw new Error(`[config] Environment variable "${key}" must be a number.`);
  }
  return parsed;
}

/* ============================================================================
 * Application-level configuration
 * ============================================================================
 */

/**
 * Global runtime configuration derived from the environment.  
 * Frozen in order to guarantee immutability across the entire Node.js process.
 */
export const AppConfig = Object.freeze({
  /** Current runtime environment. */
  nodeEnv: (process.env.NODE_ENV ??
    'development') as 'development' | 'test' | 'production',

  /** PostgreSQL connection URL for the Event Store & read models. */
  postgresUrl: requireEnv('POSTGRES_URL'),

  /** Kafka broker list for event streaming & CQRS projections. */
  kafkaBrokers: requireEnv('KAFKA_BROKERS').split(','),

  /** Redis instance for saga state & distributed locks. */
  redisUrl: requireEnv('REDIS_URL'),

  /** Default currency for valuation unless otherwise specified. */
  baseCurrency: process.env.BASE_CURRENCY ?? 'USD',

  /** Enables verbose, HIPAA-compliant audit logging when set to true. */
  enableAuditLogging: envBool('ENABLE_AUDIT_LOGGING', true),

  /** When true, outgoing REST calls will include encryption headers. */
  enableEncryption: envBool('ENABLE_ENCRYPTION', true),

  /** Outbound HTTP(S) call timeouts, expressed in milliseconds. */
  httpTimeoutMs: envNumber('HTTP_TIMEOUT_MS', 15_000),

  /** Maximum allowed clock drift (ms) for external exchange timestamps. */
  maxClockSkewMs: envNumber('MAX_CLOCK_SKEW_MS', 3_000),
});

/* ============================================================================
 * Domain enumerations
 * ============================================================================
 */

/**
 * Asset classes traded inside MediTrade Pulse.
 */
export enum AssetClass {
  PPE_FUTURES = 'PPE_FUTURES', // e.g., N95 masks, gloves, gowns
  PHARMA_OPTIONS = 'PHARMA_OPTIONS', // e.g., antivirals, vaccines
  REFRIGERATED_LOGISTICS_SWAP = 'REFRIGERATED_LOGISTICS_SWAP',
  DISPOSABLE_SYRINGE_FORWARDS = 'DISPOSABLE_SYRINGE_FORWARDS',
}

/**
 * ISO-4217 supported currencies.
 * Marked `as const` for literal type inference and runtime immutability.
 */
export const SupportedCurrencies = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'AUD',
  'CHF',
  'CAD',
  'CNY',
] as const;
export type CurrencyCode = typeof SupportedCurrencies[number];

/**
 * Standardised risk levels used throughout the Risk Scoring engine.
 */
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Event names applied in the Event Sourcing model.
 * Keeping them in a single enum prevents typos and facilitates refactoring.
 */
export enum DomainEventName {
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_EXECUTED = 'ORDER_EXECUTED',
  CLINICAL_COMPLIANCE_FLAGGED = 'CLINICAL_COMPLIANCE_FLAGGED',
  SETTLEMENT_INITIATED = 'SETTLEMENT_INITIATED',
  SETTLEMENT_COMPLETED = 'SETTLEMENT_COMPLETED',
  RISK_SCORE_UPDATED = 'RISK_SCORE_UPDATED',
  TEMPERATURE_EXCURSION_RECORDED = 'TEMPERATURE_EXCURSION_RECORDED',
}

/**
 * Long-running transaction (Saga) identifiers.
 */
export enum SagaName {
  CROSS_CURRENCY_SETTLEMENT = 'CROSS_CURRENCY_SETTLEMENT',
  COMPLIANCE_ADJUSTED_EXECUTION = 'COMPLIANCE_ADJUSTED_EXECUTION',
  INVENTORY_REPLENISHMENT = 'INVENTORY_REPLENISHMENT',
}

/* ============================================================================
 * Risk Assessment thresholds
 * ============================================================================
 */

export const RiskThresholds = Object.freeze({
  temperatureExcursionCelsius: {
    low: 2, // Deviations ≤ 2℃ are acceptable with monitoring
    medium: 5,
    high: 10,
    critical: 15,
  },
  maxBatchRecallPercentage: 1, // ≥ 1% of batch recall triggers high risk
});

/* ============================================================================
 * Clinical constraints
 * ============================================================================
 */

/**
 * Defines how many days before expiration a pharmaceutical product must be
 * off-boarded from trading to comply with FDA guidance.
 */
export const DaysBeforeExpiryCutoff = 60;

/**
 * Allowed HL7/FHIR subscription topics for incoming clinical data feeds.
 */
export const FhirTopics = Object.freeze({
  MedicationDispense: 'mediTrade.fhir.medicationDispense.v1',
  Immunization: 'mediTrade.fhir.immunization.v1',
  ProductRecall: 'mediTrade.fhir.productRecall.v1',
});

/* ============================================================================
 * External exchange routing keys
 * ============================================================================
 */

export const ExchangeRoutingKeys = Object.freeze({
  orderBookSnapshot: 'exchange.orderbook.snapshot',
  orderBookUpdate: 'exchange.orderbook.update',
  tradeExecution: 'exchange.trade.execution',
});

/* ============================================================================
 * Miscellaneous constants
 * ============================================================================
 */

/** Maximum number of portfolio positions a single hospital group may hold. */
export const MAX_PORTFOLIO_POSITIONS = 10_000;

/** ISO-8601 regex for quick validations (not exhaustive). */
export const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Ensures that this constants module cannot be mutated at runtime,
 * providing an extra layer of safety against accidental re-assignment.
 */
Object.freeze(exports);
```