```javascript
/**
 * PayPalsphere – Crypto Utils
 *
 * Centralised cryptographic helper utilities used across PayPalsphere’s micro
 * front-ends and micro-services. The utilities intentionally avoid non-standard
 * libraries to ensure deterministic builds inside FIPS-compliant containers.
 *
 * This module exposes:
 *
 *  • AES-256-GCM symmetric encryption helpers (encrypt / decrypt)
 *  • RSA-SHA256 signing & verification helpers (signEvent / verifyEvent)
 *  • HMAC helpers for lightweight message authentication (hmac / verifyHmac)
 *  • Key-pair generation & automated key-rotation helpers (generateKeyPair / rotateKeyPair)
 *
 * All functions are synchronous by design to avoid accidentally leaking secrets
 * to the event-loop or mixing sensitive crypto materials with userland awaits.
 * The payloads are small (< 32 KB) and primarily used for metadata, audit
 * records and field-level encryption inside events.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {Object} EncryptedPayload
 * @property {string} algorithm  – encryption algorithm identifier
 * @property {string} salt       – base64-encoded salt
 * @property {string} iv         – base64-encoded IV
 * @property {string} tag        – base64-encoded authentication tag
 * @property {string} ciphertext – base64-encoded encrypted data
 * @property {number} ts         – unix millis when encryption happened
 */

/* ══════════════════════════════════════════════ */
/*  INTERNAL CONSTANTS & ERRORS                   */
/* ══════════════════════════════════════════════ */

const AES_ALGORITHM        = 'aes-256-gcm';
const RSA_ALGORITHM        = 'RSA';
const DEFAULT_PBKDF2_ITER  = Number.parseInt(process.env.CRYPTO_PBKDF2_ITER ?? '200000', 10);
const KEY_DERIVATION_SALT  = 'pp-sphere:field-level:derivation:v1'; // Fixed purpose string, not secret

class CryptoError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'CryptoError';
    if (meta) this.meta = meta;
    Error.captureStackTrace(this, CryptoError);
  }
}

/* ══════════════════════════════════════════════ */
/*  SYMMETRIC ENCRYPTION                          */
/* ══════════════════════════════════════════════ */

/**
 * Derives a 32-bytes AES key from a user-supplied secret.
 * @private
 * @param {string|Buffer} secret
 * @param {Buffer} salt
 * @returns {Buffer} derived key
 */
function deriveAesKey(secret, salt) {
  try {
    return crypto.pbkdf2Sync(
      secret,
      Buffer.concat([salt, Buffer.from(KEY_DERIVATION_SALT)]),
      DEFAULT_PBKDF2_ITER,
      32,
      'sha512'
    );
  } catch (err) {
    throw new CryptoError('Key derivation failed', { cause: err });
  }
}

/**
 * Encrypt plaintext using AES-256-GCM with password-based key derivation.
 *
 * @param {string|Buffer|Object} plaintext – Data to encrypt. Objects are JSON-serialised.
 * @param {string|Buffer} secret            – User-supplied password or master secret.
 * @returns {EncryptedPayload}
 */
function encrypt(plaintext, secret) {
  if (!plaintext) throw new CryptoError('encrypt() missing plaintext');
  if (!secret)    throw new CryptoError('encrypt() missing secret');

  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(12);
  const key  = deriveAesKey(secret, salt);

  const cipher     = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const input      = typeof plaintext === 'object' ? Buffer.from(JSON.stringify(plaintext)) : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag        = cipher.getAuthTag();

  return {
    algorithm: AES_ALGORITHM,
    salt      : salt.toString('base64'),
    iv        : iv.toString('base64'),
    tag       : tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    ts        : Date.now()
  };
}

/**
 * Decrypt payload produced by encrypt().
 *
 * @param {EncryptedPayload} payload
 * @param {string|Buffer} secret
 * @param {Object} [opts]
 * @param {boolean} [opts.returnJson=true] – parse decrypted buffer as JSON if possible
 * @returns {string|Object|Buffer} – Decrypted clear text
 */
function decrypt(payload, secret, opts = {}) {
  const { returnJson = true } = opts;
  if (!payload || typeof payload !== 'object') throw new CryptoError('decrypt() expects payload object');
  if (!secret)                                  throw new CryptoError('decrypt() missing secret');

  const salt = Buffer.from(payload.salt, 'base64');
  const iv   = Buffer.from(payload.iv, 'base64');
  const tag  = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.ciphertext, 'base64');
  const key  = deriveAesKey(secret, salt);

  let decrypted;
  try {
    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (err) {
    throw new CryptoError('Tampered or corrupted ciphertext', { cause: err });
  }

  if (returnJson) {
    try {
      return JSON.parse(decrypted.toString('utf8'));
    } catch (_) {
      // not JSON, return raw
    }
  }
  return decrypted;
}

/* ══════════════════════════════════════════════ */
/*  RSA SIGNING / VERIFICATION                    */
/* ══════════════════════════════════════════════ */

/**
 * Sign opaque data (buffers or strings) using an RSA private key.
 *
 * The resulting signature is base64-encoded and ready for transport.
 *
 * @param {string|Buffer|Object} data
 * @param {string|Buffer|crypto.KeyObject} privateKey – PEM or KeyObject
 * @returns {string} base64 signature
 */
function signEvent(data, privateKey) {
  if (!privateKey) throw new CryptoError('signEvent() missing private key');

  const sign = crypto.createSign('RSA-SHA256');
  const payload = typeof data === 'object' ? Buffer.from(JSON.stringify(data)) : Buffer.from(data);
  sign.update(payload);
  sign.end();

  try {
    return sign.sign(privateKey).toString('base64');
  } catch (err) {
    throw new CryptoError('Failed to sign data', { cause: err });
  }
}

/**
 * Verify RSA signature against a payload using public key.
 *
 * @param {string|Buffer|Object} data             – Original (clear) data
 * @param {string} signature                       – base64 signature from signEvent
 * @param {string|Buffer|crypto.KeyObject} pubKey
 * @returns {boolean}
 */
function verifyEvent(data, signature, pubKey) {
  if (!pubKey) throw new CryptoError('verifyEvent() missing public key');

  const verify = crypto.createVerify('RSA-SHA256');
  const payload = typeof data === 'object' ? Buffer.from(JSON.stringify(data)) : Buffer.from(data);
  verify.update(payload);
  verify.end();
  try {
    return verify.verify(pubKey, Buffer.from(signature, 'base64'));
  } catch (err) {
    throw new CryptoError('Failed to verify signature', { cause: err });
  }
}

/* ══════════════════════════════════════════════ */
/*  HMAC HELPERS                                  */
/* ══════════════════════════════════════════════ */

/**
 * Convenience helper for generating HMAC-SHA256.
 * @param {string|Buffer} data
 * @param {string|Buffer} secret
 * @returns {string} base64 HMAC
 */
function hmac(data, secret) {
  const hm = crypto.createHmac('sha256', secret);
  hm.update(data);
  return hm.digest('base64');
}

/**
 * Verify HMAC in constant time.
 * @param {string|Buffer} data
 * @param {string} expectedBase64
 * @param {string|Buffer} secret
 * @returns {boolean}
 */
function verifyHmac(data, expectedBase64, secret) {
  const actual = hmac(data, secret);
  // constant-time comparison
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expectedBase64));
}

/* ══════════════════════════════════════════════ */
/*  KEY-PAIR GENERATION & ROTATION                */
/* ══════════════════════════════════════════════ */

const DEFAULT_RSA_BITS = 4096;

/**
 * Generate RSA key-pair synchronously.
 *
 * @param {number} [bits=4096]
 * @param {Object} [opts]
 * @param {boolean} [opts.returnKeyObject=false] – whether to return crypto.KeyObject instead of PEM
 * @returns {{ publicKey: string|crypto.KeyObject, privateKey: string|crypto.KeyObject }}
 */
function generateKeyPair(bits = DEFAULT_RSA_BITS, opts = {}) {
  const { returnKeyObject = false } = opts;

  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: bits,
      publicKeyEncoding : returnKeyObject ? undefined : { type: 'spki', format: 'pem' },
      privateKeyEncoding: returnKeyObject ? undefined : { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
  } catch (err) {
    throw new CryptoError('RSA key-pair generation failed', { cause: err });
  }
}

/**
 * Rotate RSA key-pair on disk. Existing key files are archived with timestamp.
 *
 * @param {string} dir            – directory to store keys
 * @param {string} basename="pp-sphere" – base name used for key files
 * @param {number} bits=4096
 * @returns {{ publicKeyPath: string, privateKeyPath: string }}
 */
function rotateKeyPair(dir, basename = 'pp-sphere', bits = DEFAULT_RSA_BITS) {
  const ensureDir = () => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  };

  const ts   = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const pub  = path.join(dir, `${basename}.pub.pem`);
  const priv = path.join(dir, `${basename}.pem`);

  ensureDir();

  // archive existing keys, if any
  if (fs.existsSync(pub))  fs.renameSync(pub,  path.join(dir, `${basename}-${ts}.pub.pem.bak`));
  if (fs.existsSync(priv)) fs.renameSync(priv, path.join(dir, `${basename}-${ts}.pem.bak`));

  const { publicKey, privateKey } = generateKeyPair(bits);

  fs.writeFileSync(pub,  publicKey, { mode: 0o644 });
  fs.writeFileSync(priv, privateKey, { mode: 0o600 });

  return { publicKeyPath: pub, privateKeyPath: priv };
}

/* ══════════════════════════════════════════════ */
/*  EXPORTS                                       */
/* ══════════════════════════════════════════════ */

module.exports = {
  /* Classes */
  CryptoError,

  /* Symmetric */
  encrypt,
  decrypt,

  /* Asymmetric */
  signEvent,
  verifyEvent,

  /* HMAC */
  hmac,
  verifyHmac,

  /* Keys */
  generateKeyPair,
  rotateKeyPair
};
```