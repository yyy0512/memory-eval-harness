```markdown
# PayPalsphere – Event Schemas

> Package: `@paypalsphere/event-schemas`  
> Status: ![CI](https://github.com/paypalsphere/monorepo/actions/workflows/ci.yml/badge.svg)

This package contains the canonical JSON Schemas for every domain event emitted by the PayPalsphere ecosystem.  
Schemas are **source-of-truth** contracts that are consumed by:

* Micro-services (validation & deserialization)
* Micro-frontends (code generation via `json-schema-to-typescript`)
* Data-Lake pipelines (stream compatibility & lineage)
* Security & Compliance engines (PII detection, redaction rules)

Event sourcing and CQRS rely on the immutability and correctness of these contracts—**never bypass them**.

---

##  📦  Installation

```bash
# consumers inside the monorepo
pnpm add @paypalsphere/event-schemas

# external consumers
npm install @paypalsphere/event-schemas --save
```

---

##  🏗  Directory layout

```
packages/event-schemas
├── README.md
├── package.json
├── scripts/
│   ├── validate.ts            # CI validation helper
│   └── generate-types.ts      # generates *.d.ts for TS consumers
└── src/
    ├── _envelope.json         # CloudEvents-compatible envelope
    ├── accounts
    │   ├── AccountCreated.v1.json
    │   └── KycStatusUpdated.v1.json
    ├── circles
    │   ├── CircleCreated.v1.json
    │   └── MemberInvited.v1.json
    ├── payments
    │   ├── PaymentInitiated.v2.json
    │   ├── PaymentSettled.v1.json
    │   └── PaymentFailed.v1.json
    └── ...
```

---

##  📝  Naming convention

* `<Domain><Action>.v<major>.json`
  * `PaymentInitiated.v2.json`
  * `RiskScoreCalculated.v1.json`
* Use **PascalCase** for the base name, **numeric** version suffix.
* Breaking changes ⟶ bump `major` version (`v2`, `v3`, …).  
  Never mutate or delete old versions.

---

##  📨  Event envelope

All domain events MUST be wrapped by the standard envelope located at `src/_envelope.json`.

```jsonc
{
  "$id": "https://schemas.paypalsphere.io/envelope.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "PayPalsphereEventEnvelope",
  "description": "CloudEvents-compliant envelope for all events",
  "type": "object",
  "required": ["id", "specversion", "source", "type", "time", "data"],
  "properties": {
    "id":        { "type": "string", "format": "uuid" },
    "specversion": { "const": "1.0" },
    "source":    { "type": "string", "pattern": "^urn:paypalsphere:[a-z-]+$" },
    "type":      { "type": "string" },
    "time":      { "type": "string", "format": "date-time" },
    "subject":   { "type": "string" },
    "correlationId": { "type": "string", "format": "uuid" },
    "actor": {
      "type": "object",
      "required": ["id", "type"],
      "properties": {
        "id":   { "type": "string" },
        "type": { "type": "string", "enum": ["USER", "SERVICE"] }
      }
    },
    "data": { "$ref": "#/definitions/payload" }
  },
  "definitions": {
    "payload": {
      "description": "Placeholder – replaced by $dynamicRef at runtime"
    }
  }
}
```

Individual domain schemas **MUST** declare:

```jsonc
{
  "allOf": [
    { "$ref": "../_envelope.json" },
    {
      "type": "object",
      "properties": {
        "data": { "$ref": "#/definitions/Payload" },
        "type": { "const": "payments.payment-initiated.v2" }
      }
    }
  ],
  "definitions": {
    "Payload": {
      "type": "object",
      "required": ["paymentId", "amount", "currency", "circleId"],
      "properties": {
        "paymentId": { "type": "string", "format": "uuid" },
        "circleId":  { "type": "string", "format": "uuid" },
        "amount":    { "type": "number", "minimum": 0.01 },
        "currency":  { "type": "string", "pattern": "^[A-Z]{3}$" },
        "notes":     { "type": "string", "maxLength": 280 }
      }
    }
  }
}
```

---

##  ✅  Validation

Validation is executed in CI via `pnpm test` and can be run locally:

```bash
pnpm ts-node packages/event-schemas/scripts/validate.ts
```

`scripts/validate.ts` walks every schema and asserts:

1. Draft-07 compliance
2. Structural correctness of `$id` & `type`
3. Round-trip sample payload validation

---

##  🛠  Adding / updating a schema

1. Copy an existing schema from the same domain.
2. Increment version if **breaking**.
3. Write/update the JSON Schema.
4. Add **sample** fixtures under `samples/`.
5. Run `pnpm validate` – green? Commit.
6. Open a PR; two approvals required (Domain Owner + Platform).

---

##  🔄  Code generation for TypeScript

Run once, or as part of the build:

```bash
pnpm ts-node packages/event-schemas/scripts/generate-types.ts
```

This produces `*.d.ts` files that can be imported:

```ts
import { PaymentInitiatedV2 } from '@paypalsphere/event-schemas/types';

function handle(evt: PaymentInitiatedV2) {
  // fully-typed access
  console.log(evt.data.amount);
}
```

---

##  🔐  Security guidelines

* No PII should cross service boundaries unencrypted.
* Mark PII fields with the custom keyword `"x-pii": true`.  
  The redaction proxy uses this during log shipping.
* All monetary values are `number` in **minor units** (e.g., cents) to avoid FP errors.

---

##  ℹ️  Further reading

* ADR-017 – Event Versioning Strategy  
* ADR-021 – Envelope Standardisation  
* RFC-001 – Schema Governance

---

© PayPalsphere 2024 – All Rights Reserved
```