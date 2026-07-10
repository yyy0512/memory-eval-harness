```markdown
# PayPalsphere ▸ Development Setup Guide
Welcome to the PayPalsphere code-base!  
This document will take you from a fresh clone to a fully-functional, hot-reloading, **micro-service playground** in ±10 minutes.

> The guide targets macOS/Linux, but Windows (WSL2) users should have a near-identical experience.

---

## ✨ TL;DR (5-step bootstrap)

```bash
git clone git@github.com:paypalsphere/fintech_payment.git
cd fintech_payment

# 1. Select the recommended Node version
corepack enable && corepack prepare pnpm@latest --activate
pnpm env use --global 20

# 2. Install all workspace deps
pnpm i

# 3. Spin up infrastructure (DB, Kafka, etc.)
pnpm infra:up

# 4. Seed local environment with demo data
pnpm seed

# 5. Launch every micro-frontend & micro-service
pnpm dev
```

---

## 1. Prerequisites

| Tool                | Version (min) | Install Hint                                   |
| ------------------- | ------------- | ---------------------------------------------- |
| Node.js (LTS)       | 20.x          | `nvm install 20`                               |
| pnpm                | 8.x           | `corepack enable`                              |
| Docker + Compose    | 24.x          | https://docs.docker.com/engine/install/        |
| Git                 | 2.40+         | https://git-scm.com/                           |

> 💁 **Why pnpm?** – workspace-aware, disk-efficient, and deterministic.

---

## 2. Repository Layout (Monorepo)

```
.
├── apps/
│   ├── web-shell/            # Next.js host for MFEs
│   └── mobile/               # Expo/React Native
├── services/
│   ├── accounts/
│   ├── kyc/
│   ├── risk/
│   ├── transactions/
│   ├── compliance/
│   ├── audit-trail/
│   └── settlement/
├── libs/                     # Shared domain packages (DDD!)
│   ├── event-bus/
│   ├── saga-orchestrator/
│   └── security/
├── infra/                    # IaC (Terraform ↔︎ AWS) + local compose
└── docs/
    └── guides/
        └── development-setup.md   👈 **You’re here**
```

Monorepo orchestration is powered by **Turborepo**.  
  ‑ Parallelised builds & caching  
  ‑ Intelligent graph-based task scheduling

---

## 3. Installing Dependencies

```bash
# Install root deps
pnpm install

# Verify workspace health
pnpm turbo run lint typecheck
```

> If you see _“Lockfile is up to date”_ 🥳 – you’re good to go.

---

## 4. Local Infrastructure

All stateful dependencies run in Docker.  
The compose file lives in `infra/local/docker-compose.yml`.

### Spin up

```bash
pnpm infra:up      # alias for: docker compose -f infra/local/docker-compose.yml up -d
```

Services provisioned:

| Container          | Port | Purpose                            |
| ------------------ | ---- | ---------------------------------- |
| postgres           | 5432 | ACID transactional DB              |
| redis              | 6379 | Caching + Saga coordinator locks   |
| kafka + zookeeper  | 9092 | CQRS event bus                     |
| localstack         | 4566 | S3 (audit logs), KMS, SecretsMgr   |
| mailhog            | 8025 | E-mail testing                     |
| vault-dev          | 8200 | Secrets / encryption keys          |

Shut down with `pnpm infra:down`.

---

## 5. Environment Configuration

Each service reads `.env.[local|test|prod]` via [`dotenv-flow`](https://github.com/kerimdzhanov/dotenv-flow).

Example (`services/kyc/.env.local`):

```dotenv
NODE_ENV=local
PORT=4002
DATABASE_URL=postgres://kyc_user:superSecret@localhost:5432/paypalsphere
KAFKA_BROKERS=localhost:9092
VAULT_ADDR=http://localhost:8200
JWT_PUBLIC_KEY_PATH=certs/jwt_pub.pem
```

Secret material (private keys, prod creds) **must never** be committed; use `vault write` or your cloud secrets manager.

---

## 6. Running Micro-services

The canonical dev task spins **all** back-end services and web shells with automatic reload:

```bash
pnpm dev
```

Under the hood:

```
turbo run dev --filter=services/... --filter=apps/...
```

Need only the `risk` service?

```bash
pnpm --filter=services/risk dev
```

> Hot reload is powered by `tsx` (ESM friendly) and `nodemon`.

---

## 7. Database Migrations

We use [Prisma ORM](https://www.prisma.io/).

```bash
# Create a new migration after modeling
pnpm --filter=services/transactions prisma migrate dev --name add-settlements

# Push latest schema + seed
pnpm db:migrate
```

Each service owns its **bounded context** schema; no cross-schema foreign keys.  
Cross-context projections are handled via **event subscribers**.

---

## 8. Seed Demo Data

```bash
pnpm seed
```

Seeds:

• 3 demo users (alice, bob, charlie)  
• A “EuroTrip 2024” circle with sample expenses  
• KYC states (verified/unverified)  
• Risk scores (low/medium)  

Seed scripts live at `scripts/seed/`.

---

## 9. Debugging & VSCode Launch

A `.vscode/` directory is already provided.

Start debug session:

1. Hit `F5` → choose **“KYC Service”** or any configured launch.  
2. Breakpoints will trigger inside TypeScript sources (source-maps enabled).

---

## 10. Test, Lint, Type-check

```bash
pnpm test           # jest + ts-jest
pnpm lint           # eslint + prettier
pnpm typecheck      # tsc --noEmit
```

CI (GitHub Actions) enforces the trio above.

---

## 11. Troubleshooting

| Symptom                                         | Fix                                                           |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `EADDRINUSE 4002`                               | Another instance running → `lsof -i:4002`                     |
| Kafka can’t connect `ECONNREFUSED`              | `pnpm infra:up` again; ensure ports 9092, 2181 free           |
| Prisma migrate hangs                            | Delete `.prisma/migrations/_lockfile`, rerun                  |
| Vault returns `permission denied`               | Export `VAULT_TOKEN=root` (dev-only)                          |
| Docker disk full                                | `docker system prune -af && docker volume prune -f`           |

---

## 12. Appendix ▸ Minimal Service Entrypoint

Below is the real (trimmed) `services/kyc/src/index.ts` showing **CQRS + Event Sourcing + Security-by-Design** patterns.

```ts
/* eslint-disable no-console */
import 'reflect-metadata';
import fastify from 'fastify';
import { config } from 'dotenv-flow';
import { createKafkaConsumer } from '@paypalsphere/event-bus';
import { KycCommandHandler } from './application/commands';
import { KycQueryHandler } from './application/queries';
import { registerRoutes } from './presentation/http';
import { VaultKeyProvider } from '@paypalsphere/security';

// ---- Bootstrapping ---------------------------------------------------------
config(); // loads .env.<NODE_ENV>

const app = fastify({ logger: true });
const port = Number(process.env.PORT || 4002);

// Field-level encryption keys
const keyProvider = new VaultKeyProvider({
  vaultAddr: process.env.VAULT_ADDR as string,
  mount: 'transit',
});

// Command-side: subscribe to domain events
const consumer = await createKafkaConsumer({
  clientId: 'kyc-service',
  brokers: (process.env.KAFKA_BROKERS || '').split(','),
});

consumer.subscribe({ topic: 'accounts.stream', fromBeginning: false });

consumer.run({
  eachMessage: async ({ topic, message }) => {
    try {
      const event = JSON.parse(message.value!.toString());
      await KycCommandHandler.handle(event);
    } catch (err) {
      app.log.error({ err, topic }, 'Failed to process event');
    }
  },
});

// Query-side: REST & WebSocket projections
registerRoutes(app, new KycQueryHandler());

// Global error handler
app.setErrorHandler((error, request, reply) => {
  app.log.error(error);
  reply.status(500).send({ message: 'Internal Server Error' });
});

// Start HTTP server
app.listen({ port, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`➡️  KYC service running at ${address}`);
});
```

> The full source demonstrates domain-driven structure, dependency injection,  
> and hermetic event handlers—feel free to explore!

---

Happy hacking 👾  
Need help? Ping `#paypalsphere-dev` on Slack.
```