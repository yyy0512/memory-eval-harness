```markdown
# MediTrade Pulse <sup>®</sup> &mdash; Fintech-grade Trading for Healthcare Supply Chains  
[![CI](https://github.com/your-org/meditrade-pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/meditrade-pulse/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/your-org/meditrade-pulse/badge.svg?branch=main)](https://coveralls.io/github/your-org/meditrade-pulse?branch=main)
![Node](https://img.shields.io/badge/node-%3E%3D18.x-green)
![License](https://img.shields.io/badge/license-Apache%202.0-blue)

> “Trade at the **speed of finance**&nbsp;&nbsp;with the **safety of healthcare**.”

---

## ✨ Key Features
|  |  |
| --- | --- |
| 🔒 End-to-end encryption (AES-256/GCM + OpenPGP) | 💹 Multi-currency PnL &amp; FX netting |
| ♻️ Event Sourcing with pluggable stores | ⚖️ Real-time risk &amp; clinical-grade compliance |
| 🔄 Saga-orchestrated settlement workflows | 🏥 HL7/FHIR &amp; REST adapters for hospital ERPs |
| 🪵 Immutable FDA/HIPAA-ready audit log | 🚀 Highly-typed, hexagonal TypeScript core |

---

## 📦 Installation

```bash
# Yarn
yarn add @meditrade/pulse

# or NPM
npm install @meditrade/pulse
```

MediTrade Pulse requires Node 18+ and a running PostgreSQL instance (14+).  
If you plan to enable out-of-process saga orchestration, a message broker such as NATS 2.9+ is recommended.

---

## 🚀 Quick Start

Below is a **minimal fully-type-safe** example that places a hedging order for PPE futures, evaluates risk, and commits the result to an event store.

```ts
import { 
  OrderFactory,
  PortfolioRepository,
  RiskEngine,
  EventStore,
  PostgresEventStore,
  Currency,
  CommodityCode,
} from '@meditrade/pulse';

// --- 1. Connect Event Store -----------------------------------------------
const eventStore: EventStore = new PostgresEventStore({
  connectionString: process.env.DATABASE_URL!,
});

// --- 2. Spin up repositories & engines ------------------------------------
const portfolioRepo = new PortfolioRepository(eventStore);
const riskEngine    = new RiskEngine({ clinicalMode: true });

// --- 3. Construct a PPE futures order -------------------------------------
const order = OrderFactory.createLimitOrder({
  portfolioId   : 'PORT-ACME-HOSPITAL',
  commodityCode : CommodityCode.PPE_FUTURES,
  quantity      : 10_000,
  limitPrice    : 1.12,               // $1.12 per gown
  currency      : Currency.USD,
  expiresAt     : new Date('2024-12-31'),
});

// --- 4. Clinical risk assessment ------------------------------------------
const riskScore = await riskEngine.calculateFor(order);

if (riskScore.level === 'High') {
  console.warn('🔥  Clinical risk too high – order rejected.');
  process.exit(1);
}

// --- 5. Persist & publish --------------------------------------------------
await portfolioRepo.saveOrder(order);
console.log('✅  Order saved with id:', order.id);

order.commit(); // emits domain events to the store & broker
```

Full examples can be found in [`/examples`](./examples).

---

## 🏛️ Hexagonal Architecture

The codebase follows **strict DDD + Hexagonal** principles: domain logic lives in the center, completely oblivious to transport, persistence, or UI concerns.  

```mermaid
flowchart LR
    subgraph Core Domain
        Orders ---|uses| RiskScores
        Orders --- ClinicalComplianceFlags
    end
    subgraph Application Layer
        Portfolios
        SagaOrchestrator
    end
    subgraph Adapters
        RestAPI
        HL7Adapter
        WebSocketFeed
        PGEventStore
    end
    RestAPI -->|DTO| Application Layer
    HL7Adapter --> Application Layer
    WebSocketFeed --> Application Layer
    Application Layer --> Core Domain
    Core Domain --> PGEventStore
```

### Folder Overview
```
.
├── src/
│   ├── domain/                 # Pure business rules
│   ├── application/            # Use-cases & orchestration
│   ├── infrastructure/         # DB, message brokers, crypto
│   └── adapters/               # REST, HL7/FHIR, WebSocket
└── tests/                      # Jest-powered unit & E2E tests
```

---

## 🗄️ Event Sourcing & CQRS

Every state transition emits an **immutable, versioned event** stored in PostgreSQL (or any `EventStore`-compatible backend).  
Read models are rebuilt via projectors, enabling **time-travel debugging** and **audit-grade replay** for FDA inspections.

```ts
// Query a historical snapshot
const snapshot = await eventStore.rehydrate<OrderAggregate>('ORD-1234', {
  asOf: new Date('2024-03-01T00:00:00Z'),
});

console.log(
  `Order status on Mar 1 was: ${snapshot.state.status}`
);
```

---

## 🔄 Saga Pattern

Complex, cross-boundary workflows (e.g., **cross-currency settlement**) are coordinated by sagas:

```ts
import { SettlementSaga } from '@meditrade/pulse/application';

// Emits `SettlementInitiated`, awaits `FxQuoteReceived`, etc.
await SettlementSaga.execute({
  tradeId      : 'TRD-0000998',
  targetCurrency: Currency.EUR,
});
```

A default NATS implementation ships out-of-the-box, but you can plug in any message bus conforming to `ISagaMessageBroker`.

---

## ⚙️ Configuration

| Environment Variable      | Purpose                                  | Default   |
|---------------------------|------------------------------------------|-----------|
| `DATABASE_URL`            | PostgreSQL connection string             | —         |
| `NATS_URL`                | URI for saga message broker              | `nats://localhost:4222` |
| `CRYPTO_MASTER_KEY`       | 32-byte base64 key for AES-256 encryption| — (auto-generated in dev) |
| `HTTP_PORT`               | REST API port                            | `8080`    |

---

## 🧪 Testing

```bash
# Run unit & integration tests
npm test

# Generate coverage
npm run test:cov
```

Jest & Testcontainers spin up **throw-away PostgreSQL + NATS** instances for hermetic test runs.

---

## 🛠️ Development

1. `git clone https://github.com/your-org/meditrade-pulse.git`
2. `cd meditrade-pulse && yarn install`
3. `cp .env.example .env && edit to taste`
4. `docker compose up -d` to start Postgres & NATS
5. `yarn dev` launches the API on `http://localhost:8080`

---

## 🤝 Contributing

PRs are welcome! Please:

1. Open a GitHub Issue first  
2. Follow our [Code of Conduct](./CODE_OF_CONDUCT.md)  
3. Adhere to the existing coding style (`eslint`, `prettier`)  

Automated CI checks will enforce **100 % typed code**, **≥ 90 % coverage**, and **conventional commits**.

---

## 🔐 Security

We practice responsible disclosure.  
Email `security@meditrade.io` with any vulnerability reports.  
PGP key fingerprint: `A7F1 9C3B 2D6F 4ACE 012F  F91E 8F12 B6C2 1B4D 4E0A`

---

## 📄 License

Apache License 2.0 &copy; 2024 MediTrade LLC
```
