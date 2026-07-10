```markdown
# `@paypalsphere/crypto-utils`

Robust, thoroughly-audited cryptographic helpers used across the **PayPalsphere** ecosystem.  
The package offers a minimal, curated surface area over `crypto`, `tweetnacl`, and `@noble/*` primitives while enforcing secure defaults, deterministic algorithms, and automatic parameter hardening to pass PCI-DSS, GDPR, and SOC 2 audits.

> ℹ️  This module is **runtime-agnostic** and works in **Node ≥ 18**, **Deno**, **Cloudflare Workers**, and all evergreen browsers (via ESM build).

---

## ✨ Core Features

| Feature                                    | Purpose                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| AES-256-GCM symmetric encryption           | Field-level encryption for PII & secrets                                                   |
| XChaCha20-Poly1305 streaming encryption    | Large/streaming payload protection                                                         |
| Ed25519 digital signatures                 | Event sourcing integrity & audit-trail non-repudiation                                     |
| Argon2id/SCrypt credential derivation      | Password / passphrase hardening with built-in parameter negotiation                        |
| HKDF-SHA-256 key separation                | Derive scoped keys for **KYC**, **Risk**, **Settlement** bounded contexts                  |
| JOSE (JWS/JWE) helpers                     | Light wrappers for stateless, signed/ encrypted tokens (OAuth, session cookies, etc.)      |
| Transparent, pluggable KMS integration     | Vendor-agnostic API (AWS KMS, GCP KMS, Hashicorp Vault, in-memory for local dev)            |
| Tamper-evident envelope format             | Embedded metadata (alg, iv/nonce, aad, ts, key-id) with versioned magic header             |
| Zero-dependency (runtime only)             | Only peer dependency is the builtin Web Crypto / Node `crypto` module                      |

---

## 📦 Installation

```bash
# using npm
npm i @paypalsphere/crypto-utils

# using yarn
yarn add @paypalsphere/crypto-utils

# using pnpm
pnpm add @paypalsphere/crypto-utils
```

---

## 🚀 Quick-Start

Encrypt & decrypt a JSON payload with AES-256-GCM:

```js
import { encryptJson, decryptJson, generateSymmetricKey } from '@paypalsphere/crypto-utils';

// 1. Generate or retrieve a symmetric key (Uint8Array 32 bytes)
const key = await generateSymmetricKey(); // persisted in DB, KMS, or env-var

// 2. Encrypt an object
const envelope = await encryptJson(
  { ssn: '123-45-6789', dob: '1988-04-12', tier: 'gold' },
  key,
  { aad: 'kyc:user:92f32173' }          // Additional Authenticated Data
);

/*
{
  v: 1,
  alg: 'A256GCM',
  iv: 'TI6Q6x0T6r2dFBrj',
  ts: 1690032364051,
  aad: 'kyc:user:92f32173',
  data: 'f3eea1af067b…',
  tag: '7e97625dd9…'
}
*/

// 3. Decrypt
try {
  const json = await decryptJson(envelope, key);
  console.log(json); // { ssn: '123-45-6789', dob: '1988-04-12', tier: 'gold' }
} catch (err) {
  // Authentication fails on any tampering
  console.error('Ciphertext has been modified or key is wrong', err);
}
```

---

## 🛠  API Reference (excerpt)

> Typedoc-generated docs are available at <https://paypalsphere.dev/crypto-utils/>.

### `generateSymmetricKey([opts]) → Uint8Array`

| Param | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| opts.length | number | `32` | Key length in bytes (16/24/32). <br/>Use 32 bytes for AES-256-GCM. |

```js
const key = await generateSymmetricKey({ length: 32 });
```

---

### `encryptJson(plainObject, key, [opts]) → Promise<CipherEnvelope>`

Encrypts any serializable object via `AES-256-GCM`, returning a tamper-evident envelope.

| Param | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| plainObject | object | ✔︎ | Data to encrypt (will be `JSON.stringify`-ed). |
| key | Uint8Array / CryptoKey | ✔︎ | 32-byte buffer or `CryptoKey`. |
| opts.aad | string / Uint8Array |  | Additional Authenticated Data (AAD). |
| opts.iv | Uint8Array |  | Provide your own 12-byte IV (not recommended). |

```ts
type CipherEnvelope = {
  v: 1;                  // Format version
  alg: 'A256GCM';
  iv: string;            // Base64Url
  ts: number;            // UNIX ms
  aad?: string;
  data: string;          // Base64Url ciphertext
  tag: string;           // Base64Url auth tag
};
```

---

### `decryptJson(envelope, key) → Promise<object>`

Throws `CryptoIntegrityError` if authentication fails:

```js
import { decryptJson, CryptoIntegrityError } from '@paypalsphere/crypto-utils';

try {
  const payload = await decryptJson(envelope, key);
} catch (err) {
  if (err instanceof CryptoIntegrityError) {
    // Handle tampering attempt
  } else {
    throw err;
  }
}
```

---

### `sign(payload, privateKey) → Uint8Array`

Ed25519 signature with context separation:

```js
import { sign, verify, generateKeyPair } from '@paypalsphere/crypto-utils';

const { publicKey, privateKey } = await generateKeyPair();

const sig = await sign('event-id:7ad3…', privateKey);

await verify('event-id:7ad3…', sig, publicKey); // → true
```

---

## 🔒 Security Notes

1. **Key separation**: Use `deriveScopedKey()` to generate a unique sub-key per bounded context (e.g., `risk-scoring`, `settlement`, `kyc`).
2. **IV reuse**: Never reuse an IV/nonce with the same key. The helper auto-generates a cryptographically secure IV (12 bytes random) per invocation.
3. **Zero-copy**: All Uint8Array instances are defensive clones to prevent mutation.
4. **Side-channel hardening**: Constant-time comparisons, branch-free tag checks, entropy self-tests.
5. **Regulatory compliance**: Algorithms + key sizes satisfy NIST SP 800-57, PCI-DSS v4, ISO/IEC 27001.

---

## 🧪 Tests

```bash
pnpm run test       # 100% coverage via vitest
pnpm run bench      # micro-benchmarks w/ Benchmark.js
```

---

## 🛡 Contribution Guidelines

1. **No new dependency** without security review (reach out to `@security-guild`).
2. All PRs **must** include:
   • Unit tests  
   • TypeScript .d.ts updates  
   • Typedoc comments  
   • `CHANGELOG.md` entry
3. _Never_ commit private keys or random seeds. Pre-commit hook via `lefthook` already scans diff.

---

## 🪪 License

Apache 2.0 © PayPalsphere, Inc.
```