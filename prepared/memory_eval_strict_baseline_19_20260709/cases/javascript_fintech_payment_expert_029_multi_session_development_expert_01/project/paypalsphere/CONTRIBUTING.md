```markdown
# Contributing to **PayPalsphere**

First of all, thank you for taking the time to contribute!  
PayPalsphere is a complex, security-first, event-driven fintech ecosystem and we take contributions seriously.  
This document explains our working agreements so that we can collaborate effectively and safely.

> **TL;DR**  
> 1. Fork ➜ branch from `develop` ➜ code (with tests) ➜ `yarn test:all` ➜ Conventional Commit ➜ PR  
> 2. Never commit secrets or customer data.  
> 3. All server/client code **must** pass lint, type-check and security scan gates.  
> 4. One feature/bug per PR. Keep it small.  
> 5. Be nice, inclusive, and respectful (see `CODE_OF_CONDUCT.md`).  

---

## Table of Contents

1. [Prerequisites](#prerequisites)  
2. [Architecture Primer](#architecture-primer)  
3. [Development Workflow](#development-workflow)  
4. [Branching Strategy](#branching-strategy)  
5. [Commit Message Convention](#commit-message-convention)  
6. [Code Style](#code-style)  
7. [Testing](#testing)  
8. [Security Requirements](#security-requirements)  
9. [Pull-Request Checklist](#pull-request-checklist)  
10. [Issue & Feature Proposals](#issue--feature-proposals)  
11. [Glossary](#glossary)  

---

## Prerequisites

| Tool                  | Version | Notes                                  |
|-----------------------|---------|----------------------------------------|
| Node.js               | ≥ 18.x  | LTS only                               |
| Yarn (Berry)          | ≥ 3.x   | We use **Yarn Workspaces**             |
| Docker Desktop / CLI  | Latest  | Spins up local micro-service swarm     |
| Git                   | ≥ 2.40  |                                         |
| `jq`, `openssl`       | Latest  | Misc scripts                           |

1. Clone the repo and install dependencies:

```bash
git clone git@github.com:PayPalsphere/PayPalsphere.git
cd PayPalsphere
corepack enable
yarn install
```

2. Bootstrap the dev stack:

```bash
# Starts Postgres, Kafka, Redis, and all micro-services in watch-mode
yarn dev:up
```

3. Run the entire test suite:

```bash
yarn test:all            # unit + integration + e2e + contract tests
```

---

## Architecture Primer

PayPalsphere follows **CQRS + Event Sourcing** with a **micro-frontend / micro-service** pairing per bounded context.

* Each context owns its database schema/event stream.
* Write-side emits an immutable **DomainEvent**; read-side materializes projections.
* Long-running workflows are coordinated by the **Saga Orchestrator** (`packages/saga-engine`).
* **Security-by-Design**: field-level encryption, RBAC, consent scopes.
* **Audit Trail Service** fans out WORM-signed logs to cold storage.

Please read `ARCHITECTURE.md` for details before touching core flows such as KYC, Risk, Compliance, or Settlement.

---

## Development Workflow

1. **Fork** the repository (or create a branch if you are an internal contributor).
2. **Branch from** `develop` using the pattern `feat/<scope>/<ticket-id>` or `fix/<scope>/<ticket-id>`.
3. Make your changes (with exhaustive **unit & integration tests**).
4. Ensure **all gates pass**:

   ```bash
   yarn lint
   yarn typecheck
   yarn test:all
   yarn security:scan        # npm-audit + snyk + secret-scanner
   ```

5. Commit using **Conventional Commits**.
6. Push and open a **draft PR** early; convert to “Ready for review” when done.
7. At least **2 approvals** are required (one must be a code owner of the target package).
8. CI will auto-deploy review apps to the ephemeral cluster.
9. Merges are done via **Squash & Merge** to keep a linear history.
10. **Automated release notes** and version bumps are handled by `semantic-release`.

---

## Branching Strategy

We follow a slim-lined **GitFlow**:

```
main       # → production (immutable, protected)
│
└─ develop # → staging (protected)
   │
   └─ feat/* | fix/* | chore/* → pull requests → develop
```

Hotfixes go: `main → hotfix/* → PR to main + cherry-pick to develop`.

---

## Commit Message Convention

We leverage [Conventional Commits](https://www.conventionalcommits.org).

Format:
```
<type>[optional scope]: <short summary>
<BLANK LINE>
[optional body]
<BLANK LINE>
[optional footer(s)]
```

Allowed `<type>` values:  
`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`, `security`.

Examples:
```
feat(settlement): add multilateral netting saga
fix(kyc): sanitize markdown injection in address line
security(risk): enforce mTLS between services
```

---

## Code Style

* **ESLint** + **TypeScript ESLint** + **Airbnb** ruleset.
* **Prettier** auto-formats on commit (via **Husky** & **lint-staged**).
* Use **functional components** and hooks in React micro-frontends.
* Prefer **async/await**; never `.then().catch()` chains.
* Avoid relative imports beyond two directory levels (`../../..`). Use path aliases.

Example:

```ts
// good
import { SettlementSagaStep } from '@pps/sagas/settlement'

// bad
import SettlementSagaStep from '../../../../../../packages/saga-engine/src/settlement'
```

---

## Testing

Test pyramid:

1. **Unit tests** → Jest + ts-jest  
2. **Integration tests** → Jest + Testcontainers (Docker)  
3. **Contract tests** → Pact  
4. **E2E** → Cypress composable spec files  

Run everything:

```bash
yarn test:all
```

To run a single package’s tests:

```bash
cd packages/kyc-service
yarn test -t 'should reject high-risk applicant'
```

Snapshots must be **reviewed, committed, and versioned**.

---

## Security Requirements

1. **NEVER** commit API keys, secrets, private certs, or customer data.  
   Git history is forever; we enforce a pre-commit secret scanner, but you are accountable.
2. All dependencies are scanned with `npm-audit`, `snyk`, and **OWASP Dependency-Check**.
3. New endpoints **must** include a threat model summary in the PR description.  
4. Frontend code should only call backend APIs through the **BFF Gateway** (`/api/*`) and not directly to micro-services.
5. **Helmet** and **CSP** headers are enforced by the gateway; do not disable them in PRs except for explicit, reviewed reasons.

---

## Pull-Request Checklist

☑ Conventional Commit title  
☑ Linked Jira ticket (`PPS-####`) in description  
☑ Tests added/updated (unit + integration)  
☑ `yarn lint && yarn typecheck` pass  
☑ Updated documentation / schema / ADR if needed  
☑ No secrets in diff (`yarn secret:scan` passes)  
☑ At least one screenshot / screencast for UI changes  
☑ Changelog entry (`docs/CHANGELOG_PENDING.md`)  

---

## Issue & Feature Proposals

Use the template `.github/ISSUE_TEMPLATE/*`.

For major features, please propose an **ADR** (Architectural Decision Record) under `docs/adr/` using `yarn adr:new`.

---

## Glossary

* **ADR** – Architectural Decision Record  
* **BFF** – Backend-For-Frontend  
* **CQRS** – Command Query Responsibility Segregation  
* **KYC** – Know Your Customer  
* **Saga** – Distributed transaction coordinator  
* **WORM** – Write Once Read Many (immutable storage)  

---

### Need help?

* Slack: `#help-contributors`  
* Email: `opensource@paypalsphere.io`  
* Office hours: Every Wednesday 08:00-09:00 UTC on Zoom  

Happy coding!  
— The PayPalsphere Core Team
```