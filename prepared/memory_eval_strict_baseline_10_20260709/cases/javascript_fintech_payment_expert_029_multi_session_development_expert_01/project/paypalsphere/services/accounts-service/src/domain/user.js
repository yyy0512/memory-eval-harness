/**
 * File: paypalsphere/services/accounts-service/src/domain/user.js
 *
 * Domain model (Aggregate Root) for the `User` entity in the Accounts-Service.
 *
 * The User aggregate is responsible for:
 *   • Encapsulating all user-related invariants and behaviors.
 *   • Emitting domain events that will be persisted by the Event-Store layer.
 *   • Coordinating security concerns such as field-level encryption and password hashing
 *     (delegated to crypto helpers so the domain stays deterministic).
 *
 * NOTE:
 *   – No direct persistence or network I/O is performed in this layer.
 *   – All mutations MUST go through aggregate methods, never by directly setting props.
 */

import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import EventEmitter from 'events';

/* -------------------------------------------------------------------------- */
/*                               Domain Errors                                */
/* -------------------------------------------------------------------------- */

class DomainError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
    this.meta = meta;
  }
}

class ValidationError extends DomainError {}
class DuplicateRoleError extends DomainError {}

/* -------------------------------------------------------------------------- */
/*                               Value Objects                                */
/* -------------------------------------------------------------------------- */

class EmailAddress {
  constructor(value) {
    if (!EmailAddress.#isValid(value)) {
      throw new ValidationError('Invalid email format', { value });
    }
    this.value = value.toLowerCase();
    Object.freeze(this);
  }

  static #isValid(email) {
    /* eslint-disable max-len */
    const regex =
      // rfc2822 compliant (simplified)
      /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@([a-z\d-]+\.)+[a-z]{2,}$/i;
    /* eslint-enable max-len */
    return regex.test(email);
  }

  toString() {
    return this.value;
  }
}

class PhoneNumber {
  constructor(value) {
    if (!PhoneNumber.#isValid(value)) {
      throw new ValidationError('Invalid phone number format', { value });
    }
    this.value = value.replace(/\D/g, ''); // digits-only representation
    Object.freeze(this);
  }

  static #isValid(number) {
    // E.164 simplified
    return /^\+?[1-9]\d{1,14}$/.test(number);
  }

  toString() {
    return `+${this.value}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Enumerations                                */
/* -------------------------------------------------------------------------- */

export const KYC_STATUS = Object.freeze({
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

/* -------------------------------------------------------------------------- */
/*                           Event Definitions                                */
/* -------------------------------------------------------------------------- */

class DomainEvent {
  constructor(eventName, payload) {
    this.id = uuidv4();
    this.eventName = eventName;
    this.payload = payload;
    this.occurredAt = new Date();
    Object.freeze(this);
  }
}

export const EVENTS = Object.freeze({
  USER_CREATED: 'accounts.user.created',
  USER_EMAIL_CHANGED: 'accounts.user.email-changed',
  USER_PHONE_CHANGED: 'accounts.user.phone-changed',
  USER_PASSWORD_CHANGED: 'accounts.user.password-changed',
  USER_KYC_STATUS_CHANGED: 'accounts.user.kyc-status-changed',
  USER_ROLE_ADDED: 'accounts.user.role-added',
  USER_ROLE_REMOVED: 'accounts.user.role-removed',
});

/* -------------------------------------------------------------------------- */
/*                          Crypto Helpers (Domain)                           */
/* -------------------------------------------------------------------------- */

/**
 * Field-level “encryption” helpers for deterministic AES encryption.
 * The key is injected via env-vars. In production this should be managed by
 * a vault (e.g. Hashicorp Vault, AWS KMS). For the sake of the domain,
 * we keep the algorithm deterministic and pure.
 */
const AES_ALGO = 'aes-256-gcm';
const ENC_KEY = crypto
  .createHash('sha256')
  .update(process.env.PAYPALSPHERE_FLE_KEY || 'dev_key')
  .digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(base64) {
  const data = Buffer.from(base64, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encText = data.subarray(28);
  const decipher = crypto.createDecipheriv(AES_ALGO, ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(encText), decipher.final()]);
  return dec.toString();
}

/* -------------------------------------------------------------------------- */
/*                            Domain Event Bus                                */
/* -------------------------------------------------------------------------- */

/**
 * Thin in-memory event bus for intra-process usage.
 * For production use, an adapter wires this to Kafka, RabbitMQ, NATS, etc.
 * Kept here as a singleton so aggregates can emit events without DI boilerplate.
 */
export const DomainEventBus = new EventEmitter({ captureRejections: true });

/* -------------------------------------------------------------------------- */
/*                                  Aggregate                                 */
/* -------------------------------------------------------------------------- */

export class User {
  /* -------------------------------- Factory ------------------------------- */
  /**
   * Creates a brand-new user. Emits USER_CREATED.
   * @param {Object} params
   * @returns {User}
   */
  static async register({
    email,
    phone,
    plainPassword,
    displayName = null,
    roles = ['USER'],
  }) {
    const now = new Date();

    const user = new User({
      id: uuidv4(),
      email: new EmailAddress(email),
      phone: new PhoneNumber(phone),
      passwordHash: await User.#hashPassword(plainPassword),
      kycStatus: KYC_STATUS.PENDING,
      roles: new Set(roles),
      displayName,
      createdAt: now,
      updatedAt: now,
      _encrypted: {
        // encrypted fields stored in persistence layer
        phone: encrypt(phone),
      },
    });

    user.#emit(EVENTS.USER_CREATED, {
      userId: user.id,
      email: user.email.toString(),
      phone: user.phone.toString(),
      displayName,
      roles: [...user.roles],
      kycStatus: user.kycStatus,
      timestamp: now.toISOString(),
    });

    return user;
  }

  /**
   * Reconstitutes a user from persistence (e.g., a projection or event stream).
   * No events are emitted.
   */
  static rehydrate(state) {
    return new User({
      id: state.id,
      email: new EmailAddress(state.email),
      phone: new PhoneNumber(state.phone),
      passwordHash: state.passwordHash,
      kycStatus: state.kycStatus,
      roles: new Set(state.roles),
      displayName: state.displayName,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
      _encrypted: state._encrypted ?? {},
    });
  }

  /* ----------------------------- Constructor ------------------------------ */
  constructor({
    id,
    email,
    phone,
    passwordHash,
    kycStatus,
    roles,
    displayName,
    createdAt,
    updatedAt,
    _encrypted,
  }) {
    this.id = id;
    this.email = email;
    this.phone = phone;
    this.passwordHash = passwordHash;
    this.kycStatus = kycStatus;
    this.roles = roles;
    this.displayName = displayName;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this._encrypted = _encrypted;

    // Private per-instance event buffer (not persisted)
    Object.defineProperty(this, '_events', {
      configurable: false,
      enumerable: false,
      writable: true,
      value: [],
    });

    // Freeze primitive fields to avoid accidental mutation
    Object.freeze(this.email);
    Object.freeze(this.phone);
  }

  /* ----------------------------- Public API ------------------------------- */

  async changeEmail(newEmail) {
    const valueObj = new EmailAddress(newEmail);
    if (valueObj.value === this.email.value) return; // idempotent

    this.email = valueObj;
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_EMAIL_CHANGED, {
      userId: this.id,
      newEmail: valueObj.toString(),
      timestamp: this.updatedAt.toISOString(),
    });
  }

  async changePhone(newPhone) {
    const valueObj = new PhoneNumber(newPhone);
    if (valueObj.value === this.phone.value) return; // idempotent

    this.phone = valueObj;
    this._encrypted.phone = encrypt(newPhone);
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_PHONE_CHANGED, {
      userId: this.id,
      newPhone: valueObj.toString(),
      timestamp: this.updatedAt.toISOString(),
    });
  }

  async changePassword(newPlainPassword) {
    const newHash = await User.#hashPassword(newPlainPassword);
    const isSame = await bcrypt.compare(newPlainPassword, this.passwordHash);
    if (isSame) return; // idempotent

    this.passwordHash = newHash;
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_PASSWORD_CHANGED, {
      userId: this.id,
      timestamp: this.updatedAt.toISOString(),
    });
  }

  setKycStatus(newStatus) {
    if (!Object.values(KYC_STATUS).includes(newStatus)) {
      throw new ValidationError('Invalid KYC status', { newStatus });
    }

    if (this.kycStatus === newStatus) return; // idempotent

    const previous = this.kycStatus;
    this.kycStatus = newStatus;
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_KYC_STATUS_CHANGED, {
      userId: this.id,
      previous,
      current: newStatus,
      timestamp: this.updatedAt.toISOString(),
    });
  }

  addRole(role) {
    if (this.roles.has(role)) {
      throw new DuplicateRoleError(`Role '${role}' already assigned`);
    }
    this.roles.add(role);
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_ROLE_ADDED, {
      userId: this.id,
      role,
      timestamp: this.updatedAt.toISOString(),
    });
  }

  removeRole(role) {
    if (!this.roles.has(role)) return; // silently ignore

    this.roles.delete(role);
    this.updatedAt = new Date();

    this.#emit(EVENTS.USER_ROLE_REMOVED, {
      userId: this.id,
      role,
      timestamp: this.updatedAt.toISOString(),
    });
  }

  /* ---------------------------- Public Queries ---------------------------- */

  hasRole(role) {
    return this.roles.has(role);
  }

  verifyPassword(plain) {
    return bcrypt.compare(plain, this.passwordHash);
  }

  /* ---------------------------- Serialization ----------------------------- */

  /**
   * Converts the aggregate to primitives for repository serialization
   */
  toPrimitives() {
    return {
      id: this.id,
      email: this.email.toString(),
      phone: this.phone.toString(),
      passwordHash: this.passwordHash,
      kycStatus: this.kycStatus,
      roles: [...this.roles],
      displayName: this.displayName,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      _encrypted: this._encrypted,
    };
  }

  /**
   * Exposes the list of new domain events since last commit.
   * After pulling, consumer should call `clearEvents()`.
   */
  pullEvents() {
    return [...this._events];
  }

  clearEvents() {
    this._events.length = 0;
  }

  /* --------------------------- Private Helpers ---------------------------- */

  #emit(eventName, payload) {
    const event = new DomainEvent(eventName, payload);
    this._events.push(event); // keeps events for the repository
    DomainEventBus.emit(eventName, event); // fire-and-forget (in-process)
  }

  static async #hashPassword(plain) {
    const saltRounds = parseInt(process.env.PAYPALSPHERE_PW_SALT_ROUNDS, 10) || 12;
    return bcrypt.hash(plain, saltRounds);
  }
}

/* -------------------------------------------------------------------------- */
/*                           Event Bus Error Handling                         */
/* -------------------------------------------------------------------------- */

DomainEventBus.on('error', (err, event) => {
  // Centralized logging; rethrow so process managers are aware
  // eslint-disable-next-line no-console
  console.error('Unhandled Domain Event Bus error', { err, event });
});
