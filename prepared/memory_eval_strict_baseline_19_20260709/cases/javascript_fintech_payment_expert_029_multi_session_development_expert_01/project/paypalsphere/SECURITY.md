```javascript
/* ============================================================================
 * File:        paypalsphere//SECURITY.md   (Yes: code lives in .md deliberately)
 * Project:     PayPalsphere – Fin-tech Social Payment Network
 * Purpose:     Core security helpers shared across micro-frontends / services.
 *
 * Rationale:
 *  PayPalsphere embraces “Security-by-Design”.  Every micro-component imports
 *  this library to obtain:
 *
 *    • Field-level encryption / decryption (AES-256-GCM, envelope key model)
 *    • RBAC & ABAC enforcement for resource access decisions
 *    • Secure JSON Web Token (JWT) minting / verification for service-to-service
 *    • Audit-trail helper that signs & streams events to the dedicated service
 *
 *  The module is intentionally lightweight; heavy crypto primitives (e.g.
 *  Argon2id, BBS+) are off-loaded to native add-ons within the “crypto-worker”
 *  micro-service.  Here we wire-up secure defaults & developer ergonomics.
 * ========================================================================== */

'use strict';

import crypto          from 'node:crypto';
import EventEmitter     from 'node:events';
import fs               from 'node:fs/promises';
import path             from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt              from 'jsonwebtoken';
import { v4 as uuid }   from 'uuid';

/* ============================================================================
 * Configuration
 * ========================================================================== */

const CONFIG = Object.freeze({
  JWT: {
    ISSUER:        'PayPalsphere-Auth-Gateway',
    AUDIENCE:      'PayPalsphere-Services',
    EXPIRY:        '15m',
    ALGORITHM:     'RS256',
    // Pulled from secure storage / env at runtime — placeholder only
    PRIVATE_KEY:   process.env.PAYPALSPHERE_JWT_PRIVATE_KEY ?? '',
    PUBLIC_KEY:    process.env.PAYPALSPHERE_JWT_PUBLIC_KEY  ?? '',
  },
  ENCRYPTION: {
    MASTER_KEY:    process.env.PAYPALSPHERE_DATA_KEY ?? '',   // 32-bytes base64
    KEY_ROTATION_INTERVAL_DAYS: 90,
  },
  AUDIT: {
    STREAM_ENDPOINT: process.env.PAYPALSPHERE_AUDIT_STREAM ?? 'https://audit.paypalsphere.io',
  },
});

/* ============================================================================
 * Helpers
 * ========================================================================== */

/**
 * Convert a Buffer to base64url without padding (RFC 7515)
 */
const toBase64Url = buf => buf.toString('base64')
                               .replace(/\+/g, '-')
                               .replace(/\//g, '_')
                               .replace(/=+$/, '');

/**
 * Derive a data-encryption-key (DEK) from the platform master key using HKDF.
 */
function deriveDek(salt) {
  const masterKey = Buffer.from(CONFIG.ENCRYPTION.MASTER_KEY, 'base64');
  return crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('PayPalsphere-DEK'), 32);
}

/* ============================================================================
 * Class: CryptoBox  – Field-level encryption helpers
 * ========================================================================== */

export class CryptoBox {
  /**
   * Encrypt arbitrary JSON-serialisable data using AES-256-GCM.
   * Returns a compact JWE-like string: base64url(salt).iv.cipher.authTag
   */
  static encrypt(data) {
    if (!CONFIG.ENCRYPTION.MASTER_KEY) {
      throw new Error('Master encryption key not provisioned');
    }

    // 1. Generate salt & IV
    const salt = crypto.randomBytes(16);
    const iv   = crypto.randomBytes(12);

    // 2. Derive key & initialise cipher
    const key     = deriveDek(salt);
    const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);

    // 3. Serialise & encrypt
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag       = cipher.getAuthTag();

    // 4. Return in compact representation
    return [
      toBase64Url(salt),
      iv.toString('hex'),
      encrypted.toString('hex'),
      tag.toString('hex'),
    ].join('.');
  }

  /**
   * Decrypt string produced by encrypt().
   * Returns parsed JSON object; throws on authentication failure.
   */
  static decrypt(compact) {
    const [b64Salt, hexIv, hexCipher, hexTag] = compact.split('.');
    const salt    = Buffer.from(b64Salt,  'base64');
    const iv      = Buffer.from(hexIv,    'hex');
    const cipher  = Buffer.from(hexCipher,'hex');
    const tag     = Buffer.from(hexTag,   'hex');
    const key     = deriveDek(salt);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }
}

/* ============================================================================
 * Class: RBAC  – Simple role based access control
 * ========================================================================== */

export class RBAC {
  // Map role → allowed actions
  static #ROLE_MATRIX = Object.freeze({
    'guest':        [],
    'user':         ['txn:read:own', 'circle:read'],
    'kyc_pending':  ['txn:read:own', 'circle:read', 'kyc:submit'],
    'kyc_verified': [
      'txn:create', 'txn:read:own', 'txn:refund:own',
      'circle:read', 'circle:create',
      'settlement:initiate', 'settlement:read:own',
      'social:post:create', 'social:post:read',
    ],
    'admin':        ['*'],
  });

  /**
   * Determine whether given role is permitted for an action
   * Wildcard '*' on role trumps everything.
   */
  static can(role, action) {
    const allowed = RBAC.#ROLE_MATRIX[role] ?? [];
    return allowed.includes('*') || allowed.includes(action);
  }
}

/* ============================================================================
 * Class: TokenFactory  – JWT Minting & Verification
 * ========================================================================== */

export class TokenFactory {
  /**
   * Mint a signed JWT for a user / service
   * @param {Object} payload  – claims; “sub” is required
   */
  static sign(payload) {
    if (!CONFIG.JWT.PRIVATE_KEY) {
      throw new Error('JWT private key not configured');
    }

    const jwtPayload = {
      jti:    uuid(),
      iss:    CONFIG.JWT.ISSUER,
      aud:    CONFIG.JWT.AUDIENCE,
      iat:    Math.floor(Date.now() / 1000),
      ...payload,
    };

    return jwt.sign(jwtPayload, CONFIG.JWT.PRIVATE_KEY, {
      algorithm: CONFIG.JWT.ALGORITHM,
      expiresIn: CONFIG.JWT.EXPIRY,
      header: { typ: 'JWT', kid: 'primary' },
    });
  }

  /**
   * Verify & decode a JWT.  Throws on failure.
   */
  static verify(token) {
    if (!CONFIG.JWT.PUBLIC_KEY) {
      throw new Error('JWT public key not configured');
    }

    return jwt.verify(token, CONFIG.JWT.PUBLIC_KEY, {
      algorithms: [CONFIG.JWT.ALGORITHM],
      audience:   CONFIG.JWT.AUDIENCE,
      issuer:     CONFIG.JWT.ISSUER,
    });
  }
}

/* ============================================================================
 * Class: AuditTrail  – Signed event emission to audit service
 * ========================================================================== */

export class AuditTrail extends EventEmitter {
  constructor() {
    super();
    this.endpoint = CONFIG.AUDIT.STREAM_ENDPOINT;
  }

  /**
   * Emit an audit event; the event is signed & streamed asynchronously.
   * @param {String} action    Human readable verb, e.g. “circle:create”
   * @param {Object} payload   Serializable context data
   * @param {Object} meta      Supplementary meta (ip, userAgent…)
   */
  async emitEvent(action, payload = {}, meta = {}) {
    const event = {
      uuid:      uuid(),
      action,
      timestamp: new Date().toISOString(),
      payload,
      meta,
    };

    const signature = this.#signEvent(event);
    const envelope  = { ...event, signature };

    // Async stream; fire-and-forget
    this.#stream(envelope).catch(err => {
      // Re-emit as “error” for listener aggregation (e.g. Prometheus counter)
      this.emit('error', err);
    });

    // Also emit locally for in-process handlers
    super.emit(action, envelope);
  }

  #signEvent(event) {
    const hmacKey = Buffer.from(CONFIG.ENCRYPTION.MASTER_KEY, 'base64');
    const hmac    = crypto.createHmac('sha256', hmacKey);
    hmac.update(JSON.stringify(event));
    return toBase64Url(hmac.digest());
  }

  async #stream(envelope) {
    // Minimal HTTP client using fetch (Node >= 18)
    const res = await fetch(this.endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'User-Agent':    'PayPalsphere-AuditTrail/1.0',
      },
      body:    JSON.stringify(envelope),
    });

    if (!res.ok) {
      const error = new Error(`Failed to stream audit event: ${res.statusText}`);
      error.status = res.status;
      throw error;
    }
  }
}

/* ============================================================================
 * Utilities: Secure CSRF Token generator – double submit cookie pattern
 * ========================================================================== */

export function generateCsrfToken() {
  return toBase64Url(crypto.randomBytes(32));
}

/* ============================================================================
 * Middleware Factory (Express-style) for RBAC enforcement
 * ========================================================================== */

export function rbacMiddleware(requiredAction) {
  /**
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   * @param {Function} next
   */
  return function rbacHandler(req, res, next) {
    try {
      const authz = req.user?.role || 'guest';
      if (!RBAC.can(authz, requiredAction)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/* ============================================================================
 * Simple file-based key rotation scheduler (cron-friendly)
 * ========================================================================== */

export async function rotateMasterKeyIfNeeded() {
  const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)),
                               '.masterKeyState.json');
  let state;

  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    state = JSON.parse(data);
  } catch {
    state = { lastRotated: null };
  }

  const last = state.lastRotated ? new Date(state.lastRotated) : null;
  const diff = last ? (Date.now() - last.getTime()) / 86400000 : Infinity;

  if (diff >= CONFIG.ENCRYPTION.KEY_ROTATION_INTERVAL_DAYS) {
    // Generate new 256-bit key, store securely (here: env placeholder)
    const newKey = crypto.randomBytes(32).toString('base64');
    console.warn('[Security] Rotating master key ‑ ensure secure storage!');
    // In production we would push newKey to the HSM / KMS, then update .env
    await fs.writeFile(STATE_FILE, JSON.stringify({ lastRotated: new Date().toISOString() }));
    // NOTE: We intentionally do not mutate CONFIG at runtime.
  }
}

/* ============================================================================
 * Public surface
 * ========================================================================== */

export default {
  CryptoBox,
  RBAC,
  TokenFactory,
  AuditTrail,
  generateCsrfToken,
  rbacMiddleware,
  rotateMasterKeyIfNeeded,
};
```