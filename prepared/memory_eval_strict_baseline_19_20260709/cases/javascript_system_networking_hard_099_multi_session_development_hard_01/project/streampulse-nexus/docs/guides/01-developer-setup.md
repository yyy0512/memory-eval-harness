```markdown
# StreamPulse Nexus — Developer Setup Guide
*Version 1.4*  
_Last updated: 2024-05-27_

Welcome to the StreamPulse Nexus code-base!  
Follow the steps below to get a fully-fledged local environment suitable for day-to-day engineering, performance profiling, and integration testing against remote clusters.

> **TL;DR**  
> ```bash
> nvm install               # install the exact Node version
> corepack enable           # use the project-pinned package manager
> pnpm i                    # install JS dependencies
> ./scripts/bootstrap.sh    # pull Docker images & seed configs
> pnpm dev                  # start services + hot-reload core gateway
> ```

---

## 1. Prerequisites

| Tool / Service | Version                                       | Purpose                      |
| -------------- | --------------------------------------------- | ---------------------------- |
| git            | ≥ 2.40                                        | source control               |
| Node.js        | *LTS* 20.11.x (enforced via `.nvmrc`)         | build + runtime              |
| pnpm           | pinned via `corepack` (see `package.json`)     | JS dependency management     |
| Docker         | ≥ 24.0 w/ docker-compose v2                   | service orchestration        |
| mkcert         | ≥ 1.4                                         | local TLS certificates       |
| jq             | ≥ 1.6                                         | JSON manipulation (scripts)  |
| Python         | ≥ 3.11 (optional)                             | test fixtures & code-gen     |

>  ℹ️  You *do not* need a local Kubernetes cluster. A mocked control plane ships in `/dev/mock-k3s/` and spins up automatically.

---

## 2. Clone & Install

```bash
git clone https://github.com/streampulse/nexus.git streampulse-nexus
cd streampulse-nexus

# Ensure correct Node version
nvm install && nvm use

# Use the project-bundled pnpm version
corepack enable
corepack prepare pnpm@$(cat .tool-versions | grep pnpm | awk '{print $2}') --activate

# Install all JS workspace packages
pnpm i
```

The repository is a **pnpm workspace** consisting of:

```
apps/
  gateway/              # entrypoint: Express + Fastify multiplexing
  orchestrator/         # command bus & chain-of-responsibility
  dashboards/           # React admin console
packages/
  @spn/network-core/    # shared TypeScript interfaces + domain models
  @spn/strategies/      # pluggable Strategy pattern impls
  @spn/cli/             # CLI utilities & scaffolding
```

---

## 3. Environment Variables

`apps/gateway/.env.example` illustrates the full surface.  
Create your own file:

```bash
cp apps/gateway/.env.example apps/gateway/.env
```

Key variables:

| Name                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `SPN_ENV`               | `development` \| `staging` \| `production`             |
| `SPN_JWT_PUBLIC_KEY`    | Path or PEM string. Auto-generated if empty.           |
| `SPN_CLUSTER_SEEDS`     | Comma-separated host:port pairs for service discovery. |
| `SPN_S3_BUCKET`         | Bucket for backup snapshots.                           |
| `SPN_TELEMETRY_TOKEN`   | Ingest token for Grafana Cloud (optional).             |

Missing or malformed values will trigger a **typed zod schema** validation at boot time.

---

## 4. Bootstrap Services

A single helper script provisions everything:

```bash
./scripts/bootstrap.sh
```

Tasks performed:

1. Install mkcert & issue a local CA + wildcard cert.  
2. Pull latest pre-built containers (transcoder, redis, minio).  
3. Configure dummy ingress endpoints and edge cache rules.  
4. Seed a development S3 bucket with sample media (`samples/`).

> **Tip:** Set `SPN_BOOTSTRAP_FAST=1` to skip media seeding for a quicker first-run.

---

## 5. Running the Stack

### 5.1 Start Core Services

```bash
pnpm dev      # alias for pnpm --filter @spn/*... dev
```

The supervisor spins up:

- `apps/gateway` (hot-reload via ts-node + esbuild)
- Watcher for any package in `packages/*`
- Redis in Docker (pub/sub + job queues)
- MinIO S3 API clone (persisted in `./.data/minio`)

Visit https://localhost:5443/health for a green status page.

### 5.2 Control Plane CLI

```bash
pnpm --filter @spn/cli spn cluster status
```

Commands are auto-loaded using the **Command pattern** with a reflective registry:

```typescript
// packages/cli/src/commands/cluster/status.ts
@Command({
  description: 'Display cluster member health information'
})
export default class ClusterStatusCmd extends BaseCommand {
  async run() {
    const healthMap = await this.services.gossip.snapshot();
    this.view.renderTable(healthMap);
  }
}
```

---

## 6. Quality Gates

| Task          | Command                   | Notes                                    |
| ------------- | ------------------------- | ---------------------------------------- |
| Lint          | `pnpm lint`              | ESLint + Prettier                        |
| Tests         | `pnpm test`              | Vitest + ts-node                         |
| Type-check    | `pnpm typecheck`         | Strict TypeScript                        |
| Build all     | `pnpm build`             | Outputs to `dist/` with sourcemaps       |
| Security scan | `pnpm audit`             | npm-audit + custom CVE deny-list         |

Pre-commit hooks (husky) enforce lint and type-check on staged files.

---

## 7. Debugging Recipes

### Watch live packet flow

```bash
pnpm --filter @spn/cli spn tap \
  --topic media.ingress \
  --format compact
```

### Tail orchestrator logs

```bash
docker compose logs -f orchestrator
```

### Replay synthetic load

```bash
node ./dev/tools/traffic-replay.js \
  --profile ./dev/profiles/esports_high-load.yaml
```

---

## 8. VS Code Setup (optional)

1. Install extensions:  
   - `dbaeumer.vscode-eslint`  
   - `esbenp.prettier-vscode`  
   - `Formulahendry.auto-close-tag`  
2. Launch debug config: **Run > Debug StreamPulse Gateway**.  
   Uses `ts-node-dev` with auto attach.

---

## 9. Common Pitfalls

| Symptom                                       | Fix                                                         |
| --------------------------------------------- | ----------------------------------------------------------- |
| `Error: EADDRINUSE 443`                       | Another service bound to 443. Stop nginx or Skype.         |
| Gateway boots but `/health` shows RED         | Redis image may be stale. `docker compose pull redis`.      |
| TS2345 on `unknown` type from shared package  | Run `pnpm install` at root; mismatched lockfile shards.     |
| Self-signed cert warnings in browser console  | Trust the mkcert root in your OS/Browser.                   |

---

## 10. Keeping Up-to-Date

```bash
git pull --rebase
pnpm i    # lockfile may change
./scripts/bootstrap.sh --update
```

> **Heads-up:** Dev images are published nightly (`edge` tag). CI images (`latest`) sync every Sunday at 02:00 UTC.

---

## 11. Contribution Workflow

1. Branch from `main` → `feat/<ticket-id>-short-description`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
3. `pnpm test && pnpm lint && pnpm typecheck`.
4. Open PR → automatic preview env via GitHub Actions.
5. At least one code-owner review + green pipeline.

---

## 12. Clean Up

```bash
docker compose down --volumes --remove-orphans
pnpm clean
rm -rf ~/.spn/certs   # local CA & site certs
```

---

## 13. Support

• Slack `#nexus-dev`  
• GitHub Discussions  
• PagerDuty escalation policy (SRE hours only)  

Happy coding & welcome to the StreamPulse Nexus community!  
– The Core Networking Team
```