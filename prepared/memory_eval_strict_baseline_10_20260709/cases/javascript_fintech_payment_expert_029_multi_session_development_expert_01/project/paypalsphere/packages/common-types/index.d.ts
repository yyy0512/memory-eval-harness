```typescript
/**
 * @package     @paypalsphere/common-types
 * @file        index.d.ts
 *
 * Shared primitive & domain-level types used across PayPalsphere micro-frontends
 * and micro-services.  The goal is to guarantee **type safety at service
 * boundaries** while avoiding circular runtime dependencies.  Only pure
 * TypeScript declarations live here—no implementation logic.
 *
 * Design notes:
 *  • Every entity/aggregate is referenced by an opaque, strongly-typed ID.
 *  • All monetary values use an immutable Money object (ISO-4217 currency code +
 *    atomic units as bigint).
 *  • Events follow a consistent envelope, allowing CQRS + Event Sourcing layers
 *    to introspect metadata without decoding event-specific payloads.
 *  • Security-by-Design: data classification & encryption flags are embedded in
 *    field metadata, enabling downstream services to enforce policy.
 */

/* ------------------------------------------------------------------------- *\
   Utility helpers
\* ------------------------------------------------------------------------- */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Nullable<T> = T | null | undefined;

/**
 * ISO-8601 timestamp string.  Enforced to end with 'Z' for UTC.
 * Example: 2024-04-29T18:28:03.123Z
 */
export type UTCTimestamp = Brand<string, 'UTC-ISO8601'>;

/**
 * Milliseconds since UNIX epoch (UTC).
 */
export type EpochMS = Brand<number, 'EpochMS'>;

/**
 * Primitive JSON value, including nested arrays/objects.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

/**
 * Data Sensitivity classification, used by encryption & access policy layers.
 */
export enum DataClassification {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CONFIDENTIAL = 'confidential',
  RESTRICTED = 'restricted', // requires field-level encryption
}

/* ------------------------------------------------------------------------- *\
   Strongly-typed IDs
\* ------------------------------------------------------------------------- */

export type UserID = Brand<string, 'UserID'>;
export type CircleID = Brand<string, 'CircleID'>;
export type TransactionID = Brand<string, 'TransactionID'>;
export type TimelinePostID = Brand<string, 'TimelinePostID'>;
export type SettlementID = Brand<string, 'SettlementID'>;
export type KycCaseID = Brand<string, 'KycCaseID'>;
export type RiskAssessmentID = Brand<string, 'RiskAssessmentID'>;
export type SagaID = Brand<string, 'SagaID'>;

/* ------------------------------------------------------------------------- *\
   Currency & Monetary amounts
\* ------------------------------------------------------------------------- */

/**
 * ISO-4217 alpha-3 currency code, upper-case (e.g., 'USD', 'EUR').
 */
export type CurrencyCode = Brand<string, 'CurrencyCode'>;

/**
 * Immutable representation of a monetary amount.
 * `amount` is stored in the currency's atomic units (e.g., cents for USD).
 */
export interface Money {
  readonly __type: 'Money';
  readonly currency: CurrencyCode;
  readonly amount: bigint;
}

/**
 * Helper alias for maps of currency → Money.
 * Example:  { USD: {currency:'USD', amount: 1500n}, EUR: {...} }
 */
export type MultiCurrencyBalance = Record<CurrencyCode, Money>;

/* ------------------------------------------------------------------------- *\
   User & Identity
\* ------------------------------------------------------------------------- */

export enum KycStatus {
  NOT_STARTED = 'not_started',
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

export interface UserProfile {
  id: UserID;
  displayName: string;
  avatarUrl?: string;
  locale: string;
  /**
   * ISO-3166 alpha-2 country code of legal domicile.
   */
  countryCode: string;
  kycStatus: KycStatus;
  /**
   * Optional risk vector aggregated from Risk service.
   */
  riskScore?: RiskScore;
}

export interface RiskScore {
  /**
   * Numerical score 0 (lowest risk) – 100 (highest risk).
   */
  score: number;
  assessmentId: RiskAssessmentID;
  /**
   * Descriptive labels explaining risk factors (rule-based or ML features).
   */
  labels: string[];
  assessedAt: UTCTimestamp;
}

/* ------------------------------------------------------------------------- *\
   Transactions & Timeline
\* ------------------------------------------------------------------------- */

export enum TransactionStatus {
  INITIATED = 'initiated',
  AUTHORIZED = 'authorized',
  IN_FLIGHT = 'in_flight',
  SETTLED = 'settled',
  DECLINED = 'declined',
  REVERSED = 'reversed',
}

export interface TransactionLineItem {
  description: string;
  amount: Money;
  payerId: UserID;
  payeeId: UserID;
  tags?: string[];
}

export interface Transaction {
  id: TransactionID;
  circleId: CircleID;
  initiatedBy: UserID;
  status: TransactionStatus;
  lineItems: TransactionLineItem[];
  createdAt: UTCTimestamp;
  updatedAt: UTCTimestamp;
  metadata?: Json;
}

/**
 * Social timeline post that wraps any financial or social event.
 */
export interface TimelinePost {
  id: TimelinePostID;
  authorId: UserID;
  transactionId?: TransactionID;
  /**
   * Human-friendly free-form message authored by the user.
   * New-lines allowed; markdown subset permitted by the renderer.
   */
  message: string;
  createdAt: UTCTimestamp;
  reactions: Reaction[];
  comments: Comment[];
  visibility: PostVisibility;
}

export enum ReactionType {
  LIKE = 'like',
  CELEBRATE = 'celebrate',
  LAUGH = 'laugh',
  CONFETTI = 'confetti',
  EYES = 'eyes',
  CUSTOM = 'custom', // e.g. custom emoji
}

export interface Reaction {
  userId: UserID;
  type: ReactionType;
  reactedAt: UTCTimestamp;
  customEmoji?: string; // populated when type == CUSTOM
}

export interface Comment {
  id: Brand<string, 'CommentID'>;
  authorId: UserID;
  body: string;
  createdAt: UTCTimestamp;
}

export enum PostVisibility {
  PRIVATE = 'private',
  CIRCLE = 'circle',
  PUBLIC = 'public',
}

/* ------------------------------------------------------------------------- *\
   Settlements & Sagas
\* ------------------------------------------------------------------------- */

export enum SettlementStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface Settlement {
  id: SettlementID;
  sagaId: SagaID;
  circleId: CircleID;
  initiatorId: UserID;
  status: SettlementStatus;
  grossAmount: Money;
  fees: Money;
  netAmount: Money;
  createdAt: UTCTimestamp;
  completedAt?: UTCTimestamp;
}

/* ------------------------------------------------------------------------- *\
   Event Sourcing envelope
\* ------------------------------------------------------------------------- */

/**
 * Base metadata every domain event carries, regardless of bounded context.
 */
export interface EventMeta {
  /** Monotonically increasing offset from the event store (bigint in JS). */
  globalSeq: bigint;
  /** ISO-8601 timestamp indicating when the event reached durable storage. */
  persistedAt: UTCTimestamp;
  /** Tracing correlation ID (e.g., OpenTelemetry traceId). */
  traceId?: string;
  /** Saga/process manager correlation. */
  sagaId?: SagaID;
  /**
   * If `true`, the event payload was encrypted at rest.
   * The decryption key/algorithm is resolved by the consuming service.
   */
  encrypted: boolean;
  /**
   * Indicates the data sensitivity classification for field-level security.
   */
  classification: DataClassification;
}

/**
 * Generic event wrapper used by the event store and message bus.
 * The string literal `E` should follow the convention `<Context>.<EventName>`.
 *
 * Example:
 *   type PaymentInitiatedEvt = DomainEvent<'Transactions.PaymentInitiated', {
 *      txId: TransactionID; ...;
 *   }>;
 */
export type DomainEvent<E extends string, P = unknown> = {
  readonly __event__: E;
  readonly aggregateId: string;
  readonly payload: P;
  readonly meta: EventMeta;
};

/* ------------------------------------------------------------------------- *\
   Notification
\* ------------------------------------------------------------------------- */

export enum NotificationChannel {
  EMAIL = 'email',
  PUSH = 'push',
  IN_APP = 'in_app',
  SMS = 'sms',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export interface Notification {
  id: Brand<string, 'NotificationID'>;
  recipientId: UserID;
  channel: NotificationChannel;
  priority: NotificationPriority;
  title: string;
  body: string;
  createdAt: UTCTimestamp;
  readAt?: UTCTimestamp;
  metadata?: Json;
}

/* ------------------------------------------------------------------------- *\
   Compliance & Audit
\* ------------------------------------------------------------------------- */

export enum ComplianceReportType {
  SAR = 'suspicious_activity_report',
  CTR = 'currency_transaction_report',
  GDPR_EXPORT = 'gdpr_data_export',
}

export interface ComplianceReportRequest {
  id: Brand<string, 'ComplianceReportRequestID'>;
  type: ComplianceReportType;
  requestedBy: UserID;
  parameters: Json;
  createdAt: UTCTimestamp;
  expiresAt?: UTCTimestamp;
}

/**
 * Immutable, signed audit log entry written to append-only store.
 */
export interface AuditLogEntry {
  id: Brand<string, 'AuditLogEntryID'>;
  eventName: string;
  occurredAt: UTCTimestamp;
  actorId?: UserID;
  sourceIp?: string;
  payloadDigest: string; // e.g., SHA-256 hex
  signature: string;     // e.g., Ed25519
  classification: DataClassification;
}

/* ------------------------------------------------------------------------- *\
   Encryption policy annotations
\* ------------------------------------------------------------------------- */

/**
 * Decorator-like opt-in for fields that must be encrypted in-flight and at rest.
 * Not enforced by TypeScript compiler but used by codegen & runtime frameworks.
 */
export type Encrypted<T> = Brand<T, 'Encrypted'>;

/* ------------------------------------------------------------------------- *\
   Export aggregation
\* ------------------------------------------------------------------------- */

export {
  // IDs
  UserID,
  CircleID,
  TransactionID,
  TimelinePostID,
  SettlementID,
  KycCaseID,
  RiskAssessmentID,
  SagaID,
  // Money & Currencies
  Money,
  CurrencyCode,
  MultiCurrencyBalance,
  // Users & Profiles
  UserProfile,
  KycStatus,
  RiskScore,
  // Transactions
  Transaction,
  TransactionStatus,
  TransactionLineItem,
  // Timeline
  TimelinePost,
  Reaction,
  ReactionType,
  Comment,
  PostVisibility,
  // Settlements
  Settlement,
  SettlementStatus,
  // Events
  DomainEvent,
  EventMeta,
  // Notifications
  Notification,
  NotificationChannel,
  NotificationPriority,
  // Compliance
  ComplianceReportRequest,
  ComplianceReportType,
  // Audit
  AuditLogEntry,
  // Misc
  UTCTimestamp,
  EpochMS,
  Json,
  DataClassification,
  Encrypted,
};
```