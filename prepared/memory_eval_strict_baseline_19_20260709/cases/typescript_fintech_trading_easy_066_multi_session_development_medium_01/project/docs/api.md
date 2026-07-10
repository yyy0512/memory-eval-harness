```markdown
# MediTrade Pulse – Public API Reference
_Status: v1.3 • Last updated: 2024-05-06 • © Meditrade Pulse_

MediTrade Pulse exposes a multi-modal API surface that allows certified healthcare organizations to execute, monitor, and audit medical-grade commodity trades in real-time.

* REST  (JSON / HAL)
* GraphQL  (single endpoint, persisted queries)
* Secure WebSocket feeds  (STOMP over WSS)
* FHIR/HL7 Adapter (out-of-scope for this document)

All interfaces are **read/write**, transactional, and trace every clinically significant state-change via Event Sourcing.  
Most examples below are expressed in **TypeScript** for clarity.

---

## 1. Authentication & Security

| Method | Description |
|--------|-------------|
| `X-Api-Key` | Short-lived (30 min), tied to an OAuth2 client + mTLS certificate fingerprint. |
| `X-Request-Signature` | HMAC-SHA256 of the canonical request. Prevents body-tampering. |
| `x-trace-id` | Optional caller-provided UUID v4. Echoed back for multi-system correlation. |

```ts
// Axios interceptor example
axios.interceptors.request.use(signWithHmac({
  apiKey: process.env.MEDIPULSE_API_KEY,
  secret: process.env.MEDIPULSE_API_SECRET
}));
```

All endpoints enforce TLS 1.3+, strict mTLS, and must be invoked from registered CIDR blocks.

---

## 2. Error Model

```jsonc
{
  "timestamp"   : "2024-05-03T12:45:12.456Z",
  "status"      : 422,
  "errorCode"   : "LIMIT_EXCEEDED",
  "message"     : "Order quantity exceeds allowed exposure",
  "traceId"     : "b7ac946b-1a12-46f4-98bb-740b0ccc0bc1",
  "debug"       : { /* optional, only in sandbox */ }
}
```

| Code | HTTP | Meaning |
|------|------|---------|
| `LIMIT_EXCEEDED` | 422 | Exposure breach by risk engine |
| `CLINICAL_BLOCK` | 409 | Violates `ClinicalComplianceFlag` rules (expiry, recall) |
| `FX_UNAVAILABLE` | 503 | Downstream FX liquidity temporarily offline |

---

## 3. Domain Glossary

* **Order** – Immutable command to buy/sell a lot of medical commodities.  
* **Portfolio** – Aggregate position by custodian, currency, and clinical grade.  
* **RiskScore** – Continuous variable `0–100`; > 70 triggers auto-hedging.  
* **ClinicalComplianceFlag** – Enum set describing regulatory constraints.

---

## 4. REST Endpoints (v1)

### 4.1 List Orders

```
GET /api/v1/orders?state=OPEN&limit=50
Accept: application/hal+json
```

#### Response (200)

```jsonc
{
  "_links": {
    "self": { "href": "/api/v1/orders?state=OPEN&limit=50" },
    "next": { "href": "/api/v1/orders?state=OPEN&cursor=eyJhIjoxMjN9" }
  },
  "_embedded": {
    "orders": [
      {
        "orderId": "ord_94ec2f9f",
        "side": "BUY",
        "commodity": "PPE_FUTURES_MAR2025",
        "quantity": 5000,
        "currency": "USD",
        "state": "PENDING_MATCH",
        "clinicalFlags": ["STERILITY_GRADE_A"],
        "riskScore": 42,
        "createdAt": "2024-05-03T12:45:12.456Z"
      }
    ]
  }
}
```

---

### 4.2 Submit Order

```
POST /api/v1/orders
Content-Type: application/json
Idempotency-Key: 6d4ef040-9de6-4aea-8e7c-106ac5d91bb2
```

```jsonc
{
  "side"          : "SELL",
  "commodity"     : "INSULIN_OPT_JUN2024",
  "quantity"      : 1200,
  "currency"      : "EUR",
  "price"         : 4.55,
  "expiryDate"    : "2024-06-30",
  "clinicalFlags" : ["TEMPERATURE_SENSITIVE"],
  "metadata"      : { "originBatch": "BATCH_98AF" }
}
```

#### Response (202)

```jsonc
{
  "orderId"  : "ord_b41e9c2f",
  "state"    : "QUEUED_FOR_RISK_CHECK",
  "_links"   : {
    "self": { "href": "/api/v1/orders/ord_b41e9c2f" }
  }
}
```

⚠️ Orders remain in **QUEUED_FOR_RISK_CHECK** until the asynchronous risk saga resolves.  
Subscribe to the WebSocket channel `orders/{orderId}` or listen to the GraphQL subscription `orderChanged` for updates.

---

### 4.3 Get Portfolio Snapshot

```
GET /api/v1/portfolios/{portfolioId}
```

```jsonc
{
  "portfolioId": "port_0c56644d",
  "owner": "CLINIC_GROUP_A",
  "baseCurrency": "USD",
  "totalNAV": 15897234.53,
  "hedgedNAV": 14925211.09,
  "outstandingFX": [
    { "ccy": "EUR", "exposure": -242980.42 }
  ],
  "updatedAt": "2024-05-03T12:45:12.456Z",
  "_links": {
    "rebalance" : { "href": "/api/v1/portfolios/port_0c56644d/rebalance", "method": "POST" }
  }
}
```

---

## 5. GraphQL

```
POST /graphql
Header: Content-Type: application/json
```

### Schema (excerpt)

```graphql
type Order {
  orderId: ID!
  side: Side!
  commodity: String!
  quantity: Float!
  currency: String!
  price: Float
  state: OrderState!
  riskScore: Int!
  clinicalFlags: [ClinicalFlag!]!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Subscription {
  orderChanged(orderId: ID!): Order!
  portfolioChanged(portfolioId: ID!): Portfolio!
}
```

### Persisted Query Example

```ts
import { request } from 'graphql-request';

await request({
  url: 'https://api.meditrade-pulse.com/graphql',
  document: undefined,                     // use persisted hash instead
  requestHeaders: {
    'x-hasura-persisted-operation-id': '0x88ad49...',
    'X-Api-Key': process.env.KEY
  },
  variables: { orderId: 'ord_b41e9c2f' }
});
```

---

## 6. WebSocket Feed

Endpoint: `wss://stream.meditrade-pulse.com/v1`  
Protocol: `STOMP` (secured with JWT signed by your client secret)

### Channels

| Destination | Payload |
|-------------|---------|
| `/topic/orders/{orderId}` | `OrderChangedEvent` |
| `/topic/portfolio/{portfolioId}` | Snapshot delta |
| `/topic/ledger/settlements` | Settlement finalization events |

```ts
// Quick-start with @stomp/stompjs
const client = new Client({
  brokerURL: 'wss://stream.meditrade-pulse.com/v1',
  connectHeaders: {
    Authorization: `Bearer ${jwt}`
  }
});

client.onConnect = () => {
  client.subscribe('/topic/orders/ord_b41e9c2f', msg => {
    const event: OrderChangedEvent = JSON.parse(msg.body);
    console.info(event.state);
  });
};
client.activate();
```

---

## 7. Event Contracts (JSON Schema)

### 7.1 OrderChangedEvent

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "OrderChangedEvent",
  "type": "object",
  "required": ["eventId", "orderId", "state", "timestamp"],
  "properties": {
    "eventId": { "type": "string", "format": "uuid" },
    "orderId": { "type": "string" },
    "prevState": { "type": "string" },
    "state": { "type": "string" },
    "riskScore": { "type": "integer", "minimum": 0, "maximum": 100 },
    "timestamp": { "type": "string", "format": "date-time" }
  }
}
```

---

## 8. Idempotency & Retries

All mutating REST calls accept the header `Idempotency-Key`.  
If the same key is re-sent within 24 hours, the original response is replayed.  
Safe to retry `POST /orders` and `POST /portfolios/{id}/rebalance` without side-effects.

---

## 9. Rate Limits

| Tier | RPS | Burst | Note |
|------|-----|-------|------|
| Sandbox | 10 | 50 | Mocked executions |
| Production | 120 | 250 | Soft-throttled, contact support for upgrades |

429 responses include `Retry-After` in milliseconds.

---

## 10. SDK Quick-Start (Node ≥ 18)

```bash
npm i @meditrade-pulse/sdk
```

```ts
import { MediTradeClient } from '@meditrade-pulse/sdk';

const client = new MediTradeClient({
  apiKey : process.env.KEY,
  apiSecret: process.env.SECRET
});

const order = await client.orders.create({
  side: 'BUY',
  commodity: 'PPE_FUTURES_MAR2025',
  quantity: 5000,
  currency: 'USD'
});

console.log(order.orderId);
```

---

## 11. Change Log

| Version | Date | Highlights |
|---------|------|------------|
| v1.3 | 2024-05-06 | Added `rebalance` endpoint, upgraded TLS 1.3 ciphers |
| v1.2 | 2024-03-14 | GraphQL subscriptions GA |
| v1.1 | 2023-12-02 | Clinical compliance flags extended |
| v1.0 | 2023-09-10 | Initial public release |

For deprecations, subscribe to the status page or monitor the `api.version.deprecated` event channel.

---

## 12. Support

Email: `support@meditrade-pulse.com`  
Emergency hotline (24/7): `+1-415-MED-PULSE`  
PGP Key: `0xA1B2C3D4`  

Happy (and compliant) trading!
```