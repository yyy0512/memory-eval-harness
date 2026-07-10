```typescript
/***************************************************************************************************
 *  MediTrade Pulse – Shared Utilities
 *
 *  This file groups together Side-effect-free helper functions that are consumed throughout the
 *  Platform. Only deterministic, stateless utilities belong here—anything that reaches outside the
 *  process boundary (DB, network, FS, etc.) must live in an “adapter” according to the hexagonal
 *  architecture rules.
 *
 *  NOTE: Do not import app-layer aggregates, repositories, or adapters from this file!
 ***************************************************************************************************/

import { randomBytes } from 'crypto';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import Big from 'big.js';

/* -------------------------------------------------------------------------------------------------
 *  Error Types
 * -----------------------------------------------------------------------------------------------*/

export class MediTradeError extends Error {
  readonly code: string;

  constructor(message: string, code: string = 'MEDI_TRADE_ERR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class InvariantViolation extends MediTradeError {
  constructor(message: string) {
    super(message, 'INVARIANT_VIOLATION');
  }
}

/* -------------------------------------------------------------------------------------------------
 *  Functional Helper Types
 * -----------------------------------------------------------------------------------------------*/

/**
 * A tiny Result<E, T> implementation inspired by Rust/Swift.  Prefer returning Result over throwing
 * exceptions for predictable control-flow, especially inside domain logic.
 */
export type Ok<T>    = { ok: true;  value: T };
export type Err<E>   = { ok: false; error: E };
export type Result<E, T> = Ok<T> | Err<E>;

export const ok   = <T>(value: T): Ok<T>   => ({ ok: true,  value });
export const err  = <E>(error: E): Err<E> => ({ ok: false, error });

/* -------------------------------------------------------------------------------------------------
 *  Currency & Math Utilities
 * -----------------------------------------------------------------------------------------------*/

export type Currency =
  | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'CAD' | 'CHF' | 'JPY' | 'CNY' | 'INR' | 'BRL';

/**
 * Represents an FX rate quoted as: 1 FROM = rate TO
 * Example: { pair: 'USD/EUR', rate: 0.93 }
 */
export interface FxRate {
  pair: `${Currency}/${Currency}`;
  rate: number | string | Big;
}

/**
 * Convert an amount between two currencies using the provided FX rate map.
 *
 * All arithmetic is done in `Big` to protect against floating-point drift.
 */
export function convertCurrency(
  amount: number | string | Big,
  from: Currency,
  to: Currency,
  rates: FxRate[],
): Big {
  if (from === to) return new Big(amount);

  const directPair = rates.find(r => r.pair === `${from}/${to}`);
  if (directPair) {
    return new Big(amount).times(directPair.rate);
  }

  // Attempt triangular arbitrage via USD as the default pivot
  const pivot: Currency = 'USD';

  const toPivot   = rates.find(r => r.pair === `${from}/${pivot}`);
  const fromPivot = rates.find(r => r.pair === `${pivot}/${to}`);

  if (toPivot && fromPivot) {
    return new Big(amount)
      .times(toPivot.rate)
      .times(fromPivot.rate);
  }

  throw new MediTradeError(`Missing FX rate for ${from} → ${to}`, 'FX_RATE_NOT_FOUND');
}

/**
 * Quickly compute a Δ between two numeric inputs with arbitrary precision.
 */
export const delta = (a: number | string | Big, b: number | string | Big): Big =>
  new Big(b).minus(a);

/* -------------------------------------------------------------------------------------------------
 *  Risk Scoring Helpers
 * -----------------------------------------------------------------------------------------------*/

export interface RiskVector {
  notionalUSD: number;      // Monetary size of position
  expiryDays:  number;      // Days until medical product expires
  complianceFlags: number;  // Bit field representing clinical compliance issues
}

/**
 * Simple heuristic risk score.
 *
 *         0 (low) ──────────────────────────────────► 100 (high)
 *
 * The equation is purposely kept linear to remain explainable to regulators.
 */
export function computeRiskScore(vector: RiskVector): number {
  const { notionalUSD, expiryDays, complianceFlags } = vector;

  const sizeWeight        = Math.min(notionalUSD      / 1_000_000, 1) * 40;  // up to 40 pts
  const expiryWeight      = Math.max((180 - expiryDays) / 180, 0)  * 40;     // up to 40 pts
  const complianceWeight  = Math.min(complianceFlags.bitLength?.() ?? 0, 4) / 4 * 20; // up to 20

  return +(sizeWeight + expiryWeight + complianceWeight).toFixed(2);
}

/* -------------------------------------------------------------------------------------------------
 *  Event Sourcing Helpers
 * -----------------------------------------------------------------------------------------------*/

export type ISODateString = string & { readonly __brand: unique symbol };

/**
 * Immutable timestamp generator.  Always UTC and ISO-8601 compliant with millisecond precision.
 */
export const nowIso = (): ISODateString => new Date().toISOString() as ISODateString;

/**
 * Deep-freeze a POJO so that accidental mutations inside event payloads throw in strict mode.
 */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  if (Object.isFrozen(obj)) return obj;

  // eslint-disable-next-line guard-for-in, no-restricted-syntax
  for (const key in obj) {
    const val: unknown = (obj as Record<string, unknown>)[key];
    if (typeof val === 'object' && val !== null) {
      deepFreeze(val as object);
    }
  }

  return Object.freeze(obj);
}

/* -------------------------------------------------------------------------------------------------
 *  Saga / Correlation-ID Helpers
 * -----------------------------------------------------------------------------------------------*/

const NAMESPACE_UUID = '358db0ce-98b8-4c08-9e24-1c5f64b9c2a1'; // random, but stable

/**
 * Generates a deterministic UUIDv5 from an arbitrary input string.
 *
 * Useful for idempotent Saga steps (same business key ⇒ same ID).
 */
export const deterministicId = (seed: string): string =>
  uuidv5(seed, NAMESPACE_UUID);

/**
 * Generates a high-entropy, random correlation ID for cross-service tracing.
 */
export const correlationId = (): string => uuidv4();

/* -------------------------------------------------------------------------------------------------
 *  Async Utilities
 * -----------------------------------------------------------------------------------------------*/

export interface RetryConfig {
  /** Maximum number of attempts (default: 3). */
  attempts?: number;
  /** Initial back-off delay in ms (default: 250). */
  delayMs?: number;
  /** Jitter percentage 0-1 (default: 0.25 = ±25%). */
  jitter?: number;
  /** Abort condition based on thrown error. Return true to break early. */
  bailIf?: (e: unknown) => boolean;
}

/**
 * Exponential back-off with jitter.  Re-throws the last error if all attempts fail.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    delayMs  = 250,
    jitter   = 0.25,
    bailIf   = () => false,
  }: RetryConfig = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (bailIf(err)) break;
      if (attempt === attempts) break;

      const jitterFactor = 1 + (Math.random() * 2 - 1) * jitter;
      const sleepMs = delayMs * 2 ** (attempt - 1) * jitterFactor;

      await new Promise(res => setTimeout(res, sleepMs));
    }
  }

  throw lastError;
}

/* -------------------------------------------------------------------------------------------------
 *  Security Helpers
 * -----------------------------------------------------------------------------------------------*/

/**
 * Generates a cryptographically secure random identifier in base-32 (Crockford).
 * Size: 130 bits entropy ≈ 26 base32 chars.
 */
export function secureRandomId(): string {
  const bytes = randomBytes(16); // 128 bits
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
  let str = '';

  for (const byte of bytes) {
    str += alphabet[byte >> 3];        // upper 5 bits
    str += alphabet[byte & 0b11111];   // lower 5 bits
  }

  return str;
}

/* -------------------------------------------------------------------------------------------------
 *  Miscellaneous
 * -----------------------------------------------------------------------------------------------*/

/**
 * Exhaustiveness check function for switch statements.
 * Call this in the default case to satisfy the compiler and avoid silent failures.
 */
export function assertUnreachable(x: never): never {
  throw new InvariantViolation(`Unreachable case reached: ${String(x)}`);
}

/**
 * Safe JSON.stringify wrapper that drops circular references and handles Big.js instances.
 */
export function jsonSafeStringify(data: unknown, space?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(
    data,
    (_k, v) => {
      if (v instanceof Big) return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    },
    space,
  );
}

/**
 * Safe, typed JSON.parse that returns Result<Error, T> to keep callers honest.
 */
export function jsonSafeParse<T>(raw: string): Result<Error, T> {
  try {
    return ok(JSON.parse(raw) as T);
  } catch (e) {
    return err(e as Error);
  }
}
```