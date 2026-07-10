```markdown
# Architecture Decision Record 003 — Zero-Trust Security Model  
StreamPulse Nexus / docs / architecture / adr / 003-zero-trust-security-model.md  

Status: Accepted  
Date: 2024-05-13  
Authors: Core Platform Group  

---

## Context  

StreamPulse Nexus distributes real-time entertainment traffic across hundreds of edge nodes that
sit in a highly adversarial environment (public Internet, BYOD clients, untrusted ISPs).
Traditional perimeter-based defenses are insufficient; every request—internal or external—must be
authenticated, authorized, encrypted, and continuously re-evaluated.  

Key requirements:

* Mutual TLS between every node (ingress → core → egress).  
* Short-lived JWT access tokens issued by an identity provider (IdP).  
* Pluggable policy engine that enforces least privilege, device posture, rate limits, and
  contextual signals (geo-fence, anomaly scores, maintenance windows).  
* Tamper-proof audit trail for each decision, exported to SIEM and incident-response tooling.  
* Minimal latency (<1 ms median) so that security never degrades fan experience.  

---

## Decision  

1. Adopt a “Zero-Trust Gateway” component implemented in Node.js—deployed in-process to every
   media/router service and exposed as an Express / Fastify middleware.  
2. Expose a Strategy pattern API so that features (mTLS, RBAC, device posture, ML anomaly score)
   can evolve independently without changing the gateway’s public surface.  
3. Standardize on asymmetric JWTs validated with rotating JWK sets retrieved from the IdP over
   mTLS.  
4. Emit a signed security event (`security.zeroTrust.v1`) for every allow/deny decision.  
5. Ship a default policy bundle (`@streampulse-nexus/policies-default`) that tournament operators
   can override on a per-cluster basis.  

---

## Consequences  

• Slightly higher CPU usage (<3 %) for cryptographic operations, offset by hardware AES-NI.
• Uniform, centralized enforcement makes compliance audits straightforward.
• Any node compromise is isolated; lateral movement requires fresh credentials and posture.  
• Future adaptive policies (e.g., raise friction during grand-finals) plug‐in without redeploying
  the core network stack.  

---

## Implementation Sketch  

Below is production-grade JavaScript that makes the decision concrete.  
The code lives in the `@streampulse-nexus/security` workspace and is published to our internal
registry.  All snippets below are fully functional; paste them into a project, run `npm i`, and
execute `node examples/server.js`.

> ⚠️  Secrets are injected via environment variables—never hard-code credentials in the repo.

---

### 1. `src/ZeroTrustGateway.js`

```javascript
/**
 * @fileoverview ZeroTrustGateway — Express / Fastify compatible middleware that
 * validates JWTs, enforces mTLS, and evaluates pluggable policy strategies.
 *
 * Production-ready: includes aggressive timeouts, adaptive caching, and
 * structured audit logging (ECS v1).
 *
 * npm dependencies:
 *   jsonwebtoken   — crypto-safe JWT decode & verify
 *   jwks-rsa       — JWK retrieval and caching
 *   pino           — zero allocation JSON logger
 */

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import pino from 'pino';

/* ---------- Constants ---------- */

const DEFAULT_ALG = 'RS256';
const CLOCK_SKEW_SEC = 30; // allow slight clock drift

/* ---------- Logger ---------- */

const log = pino({
  name: 'ZeroTrustGateway',
  level: process.env.LOG_LEVEL || 'info',
});

/* ---------- Helper Functions ---------- */

/**
 * Return the bearer token from Authorization header or query param.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.searchParams.get('access_token');
}

/* ---------- Strategy Interface ---------- */

/**
 * @interface
 * @typedef {object} AccessStrategy
 * @property {(context: PolicyContext) => Promise<PolicyResult>} evaluate
 */

/**
 * @typedef PolicyContext
 * @property {import('http').IncomingMessage} req
 * @property {import('jsonwebtoken').JwtPayload} tokenPayload
 */

/**
 * @typedef {object} PolicyResult
 * @property {boolean} allowed
 * @property {string} [reason]  - Short reason for denial
 */

/* ---------- Default Strategies ---------- */

/**
 * Role-Based Access Control (RBAC) strategy.
 */
export class RoleBasedAccessStrategy {
  /**
   * @param {{ requiredRoles: string[] }} opts
   */
  constructor({ requiredRoles = [] } = {}) {
    this.requiredRoles = new Set(requiredRoles);
  }

  /**
   * @param {PolicyContext} ctx
   * @returns {Promise<PolicyResult>}
   */
  async evaluate({ tokenPayload }) {
    const roles = new Set(tokenPayload.roles || []);
    const missing = [...this.requiredRoles].filter((r) => !roles.has(r));
    if (missing.length > 0) {
      return { allowed: false, reason: `missing_roles:${missing.join(',')}` };
    }
    return { allowed: true };
  }
}

/**
 * Device posture check: simple example that blocks rooted/jailbroken devices
 * flagged by the IdP in the `device_trust` claim.
 */
export class DevicePostureStrategy {
  /**
   * @param {{ acceptedLevels: string[] }} opts
   */
  constructor({ acceptedLevels = ['secure'] } = {}) {
    this.accepted = new Set(acceptedLevels);
  }

  /**
   * @param {PolicyContext} ctx
   * @returns {Promise<PolicyResult>}
   */
  async evaluate({ tokenPayload }) {
    const level = tokenPayload.device_trust || 'unknown';
    if (!this.accepted.has(level)) {
      return {
        allowed: false,
        reason: `device_trust:${level}`,
      };
    }
    return { allowed: true };
  }
}

/* ---------- ZeroTrustGateway ---------- */

export class ZeroTrustGateway {
  /**
   * @param {Object} opts
   * @param {string} opts.jwksUri         - HTTPS endpoint for JWKs
   * @param {string} opts.issuer          - Expected token issuer (`iss`)
   * @param {string} opts.audience        - Expected token audience (`aud`)
   * @param {AccessStrategy[]} [opts.strategies]
   */
  constructor({ jwksUri, issuer, audience, strategies = [] }) {
    if (!jwksUri || !issuer || !audience) {
      throw new Error('jwksUri, issuer, and audience are required');
    }

    this.strategies = strategies;
    this.issuer = issuer;
    this.audience = audience;

    this.jwks = jwksClient({
      jwksUri,
      requestHeaders: { 'User-Agent': 'StreamPulse-Nexus/ZeroTrustGateway' },
      cache: true,
      cacheMaxEntries: 10,
      cacheMaxAge: 10 * 60 * 1000, // 10 min
      timeout: 3000,
    });
  }

  /**
   * Express-style middleware.
   * @returns {(req, res, next) => void}
   */
  createMiddleware() {
    return async (req, res, next) => {
      const start = process.hrtime.bigint();
      let decision = 'allow';
      let reason = 'ok';

      try {
        // 1. Enforce mutual TLS if enabled
        if (process.env.ENFORCE_MTLS === 'true') {
          const cert = req.socket.getPeerCertificate();
          if (!req.client.authorized || !cert.subject) {
            throw Object.assign(new Error('mTLS verification failed'), {
              code: 'ERR_MTLS',
            });
          }
        }

        // 2. Extract & verify JWT
        const token = extractBearerToken(req);
        if (!token) {
          throw Object.assign(new Error('Missing bearer token'), {
            code: 'ERR_NO_TOKEN',
          });
        }

        const getKey = (header, cb) => {
          this.jwks.getSigningKey(header.kid, (err, key) => {
            if (err) cb(err);
            else cb(null, key.getPublicKey());
          });
        };

        /** @type {import('jsonwebtoken').JwtPayload} */
        const payload = await new Promise((resolve, reject) => {
          jwt.verify(
            token,
            getKey,
            {
              algorithms: [DEFAULT_ALG],
              issuer: this.issuer,
              audience: this.audience,
              clockTolerance: CLOCK_SKEW_SEC,
            },
            (err, decoded) => {
              if (err) return reject(err);
              resolve(decoded);
            }
          );
        });

        // 3. Evaluate custom strategies sequentially
        for (const strategy of this.strategies) {
          const res = await strategy.evaluate({ req, tokenPayload: payload });
          if (!res.allowed) {
            reason = res.reason || 'policy_denied';
            decision = 'deny';
            throw Object.assign(new Error(`Policy denied: ${reason}`), {
              code: 'ERR_POLICY',
            });
          }
        }

        // 4. Stash token payload for downstream handlers
        req.user = payload;
        next();
      } catch (err) {
        // Map errors to 401/403 as appropriate
        const status =
          err.code === 'ERR_POLICY' || err.code === 'ERR_MTLS' ? 403 : 401;

        decision = 'deny';
        reason = err.code || err.message;

        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: reason,
          })
        );
      } finally {
        // 5. Emit audit log
        const latencyMs =
          Number(process.hrtime.bigint() - start) / 1_000_000; /* ns → ms */
        log.info(
          {
            event: 'zeroTrustDecision',
            decision,
            reason,
            method: req.method,
            path: req.url,
            remote: req.socket.remoteAddress,
            latencyMs: latencyMs.toFixed(2),
          },
          'zero-trust decision'
        );
      }
    };
  }
}
```

---

### 2. `examples/server.js`

```javascript
/**
 * Minimal Express server that attaches the ZeroTrustGateway middleware.
 * Run with:
 *   $ npm install express jsonwebtoken jwks-rsa pino
 *   $ node examples/server.js
 *
 * Environment variables required:
 *   JWKS_URI   — `https://idp.internal.example.com/.well-known/jwks.json`
 *   ISSUER     — `https://idp.internal.example.com/`
 *   AUDIENCE   — `streampulse.nexus`
 */

import express from 'express';
import { ZeroTrustGateway, RoleBasedAccessStrategy } from '../src/ZeroTrustGateway.js';

/* ---------- Configuration ---------- */

const config = {
  jwksUri: process.env.JWKS_URI,
  issuer: process.env.ISSUER,
  audience: process.env.AUDIENCE,
};

/* ---------- Instantiate Gateway ---------- */

const gateway = new ZeroTrustGateway({
  ...config,
  strategies: [
    new RoleBasedAccessStrategy({ requiredRoles: ['stream:write'] }),
  ],
});

/* ---------- Build HTTP Server ---------- */

const app = express();

app.use(gateway.createMiddleware());

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/admin', (req, res) =>
  res.json({ message: `Hello, ${req.user.sub}! You are cleared.` })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅  Demo server listening on http://localhost:${PORT}`);
});
```

---

### 3. `README.md` (excerpt)

```markdown
## Deploying ZeroTrustGateway in a Kubernetes Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nexus-gateway
  annotations:
    nginx.ingress.kubernetes.io/auth-url: "http://$service_zero_trust/auth"
---
apiVersion: v1
kind: Service
metadata:
  name: service_zero_trust
spec:
  selector:
    app: zero-trust-gateway
  ports:
    - name: http
      port: 80
      targetPort: 3000
```

The side-car implementation reuses the same Node.js package, exposing `/auth`
and responding with `200` (allow) or `403` (deny).
```
```

---

## Roll-out Plan  

1. Canary deploy to the **ap-southeast-1** edge cluster behind feature flag
   `edge.zero_trust.enabled = true`.  
2. Monitor latency histogram (`hist_zero_trust_latency_ms`) and error budget
   (`err_zero_trust_denied_total`) for 48 hours.  
3. Gradually enable for all clusters, 5 % increments every hour.  
4. Post-launch security simulation (MITRE ATT&CK T1071, T1190) to validate
   mTLS and policy resilience.  

---

## References  

* NIST 800-207 — Zero Trust Architecture  
* Google BeyondCorp Whitepaper  
* jwt.io — Debugging and Best Practices  
* “Securing Distributed Systems with Zero Trust” — ACM Queue, 2023  

---
```