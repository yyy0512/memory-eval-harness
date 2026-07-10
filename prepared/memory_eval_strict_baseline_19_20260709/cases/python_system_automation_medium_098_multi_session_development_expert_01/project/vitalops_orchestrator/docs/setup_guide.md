```markdown
# VitalOps Orchestrator – Setup Guide
_Installation & Deployment Documentation_

> Version: `v2.6.x`  
> Last updated: `2024-06-12`

---

## 1. Overview
VitalOps Orchestrator is an event-driven platform that monitors and automates EMR micro-services inside a hospital’s private cloud.  
This guide walks you through:

* Local development bootstrap
* Docker Compose single-node demo
* Kubernetes / Istio production deployment
* Database migrations & seeding
* Continuous-integration hooks

---

## 2. Pre-requisites

| Dependency      | Minimum Version | Notes                                   |
| --------------- | --------------- | --------------------------------------- |
| Python          | 3.11            | PEP 654 enabled runtimes recommended    |
| Docker Engine   | 24.0            | BuildKit activated                      |
| Docker Compose  | v2              | `docker compose` CLI                    |
| kubectl         | 1.27            | Matches cluster minor version           |
| Helm            | 3.11            | For chart deployment                    |
| make            | —               | Quality-of-life scripts (`Makefile`)    |
| PostgreSQL      | 15              | Primary data store                      |
| Redis           | 7               | Pub/Sub & task queue                    |

Optional:

* **Poetry 1.7** – reproducible Python env
* **pre-commit 3** – run linters automatically

---

## 3. Clone & Bootstrap

```bash
# Clone repository
git clone git@github.com:vitalops/vitalops_orchestrator.git
cd vitalops_orchestrator

# Checkout the desired release
git checkout v2.6.0
```

### 3.1 Python virtual-env (Poetry)

```bash
curl -sSL https://install.python-poetry.org | python3 -
poetry env use 3.11
poetry install --with dev
poetry run pre-commit install
```

### 3.2 Environment Variables

Copy the template and adjust to your host:

```bash
cp .env.example .env
vim .env             # or your favourite editor
```

Key toggles:

```
# Core DB
DATABASE__URL=postgresql+psycopg://vitalops:vitalops@db:5432/vitalops

# Redis URI
REDIS__URL=redis://redis:6379/0

# HIPAA logger
AUDIT__SINK=stdout,postgres

# Mesh sidecar
SERVICE_MESH__ENABLED=true
SERVICE_MESH__SIDECAR_IMAGE=envoyproxy/envoy:v1.27-latest
```

---

## 4. Quickstart (Docker Compose)

The `infra/local` stack spins up PostgreSQL, Redis, an Nginx ingress and the Orchestrator micro-services.

```bash
# Build and run all images
docker compose -f infra/local/docker-compose.yaml up --build -d

# Check health
docker compose ps
```

Expected containers:

```
NAME                          STATE    PORTS
vo-postgres-1                 healthy  5432/tcp
vo-redis-1                    healthy  6379/tcp
vo-orchestrator-api-1         healthy  8000->8000/tcp
vo-orchestrator-worker-1      healthy
vo-grafana-1                  healthy  3000->3000/tcp
vo-nginx-1                    healthy  80->80/tcp
```

### 4.1 Seed Reference Data

```bash
# Inside the API container
docker compose exec orchestrator-api poetry run vo-manage seed --fixtures fixtures/reference
```

---

## 5. Database Migration Workflow

Alembic manages schema changes; migrations run automatically on container start, but during development:

```bash
# Generate revision after modifying models/*
poetry run alembic revision --autogenerate -m "add alert_rule.concurrency"
# Apply to local DB
poetry run alembic upgrade head
```

For manual rollback:

```bash
poetry run alembic downgrade -1      # revert last migration
```

---

## 6. Running the Test Suite

```bash
poetry run pytest -q
poetry run coverage run -m pytest
poetry run coverage html  # report in htmlcov/
```

Quality gates (flake8, mypy, import-sort) are enforced in CI; run them locally:

```bash
poetry run pre-commit run --all-files
```

---

## 7. Production Deployment (Kubernetes)

### 7.1 Namespace & Secrets

```bash
kubectl create namespace vitalops
kubectl -n vitalops create secret generic vitalops-env \
  --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 7.2 Helm Chart

```bash
helm repo add vitalops https://charts.vitalops.io
helm repo update
helm upgrade --install vitalops-orchestrator vitalops/orchestrator \
  -n vitalops \
  -f infra/helm/values.prod.yaml
```

Main pod groups:

* `api` – FastAPI w/ uvicorn workers
* `worker` – Celery / RQ background tasks
* `coordinator` – Event-driven orchestrator engine
* `sidecar` – Envoy (mesh) + OpenTelemetry collector

### 7.3 Istio VirtualService Snippet

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: vitalops-orchestrator
spec:
  hosts:
    - orchestrator.vitals.internal
  gateways:
    - istio-system/secure-gateway
  http:
    - route:
        - destination:
            host: vitalops-orchestrator-api
            port:
              number: 8000
```

---

## 8. CLI Cheatsheet

```bash
# List real-time performance alerts
poetry run voctl alerts list --severity CRITICAL

# Trigger synthetic load (for demo)
poetry run voctl simulate-load --service radiology-viewer --rps 1800

# Force immediate backup
poetry run voctl backup run --target all --mode incremental
```

---

## 9. Makefile Targets

```bash
# Build & tag OCI images
make build

# Push images to registry
REGISTRY=registry.hospital.local make push

# Clean local artifacts
make clean
```

Consult `Makefile` for additional shortcuts (`run`, `lint`, `docs`, `release`).

---

## 10. CI/CD (GitHub Actions)

The pipeline (`.github/workflows/ci.yml`) executes:

1. Lint & type-check  
2. Unit & integration tests (docker-in-docker)  
3. Build multi-arch images (`amd64`, `arm64`)  
4. Sign images w/ Sigstore & push to GHCR  
5. Update Helm chart via Chart Releaser  

CD environments (optional):

* _Staging_ ⚙️: auto-deploy on `main` merge  
* _Prod_ 🏥: manual approval w/ compliance check  

---

## 11. Troubleshooting

| Symptom                               | Resolution                                                |
| ------------------------------------- | --------------------------------------------------------- |
| API `503 Service Unavailable`         | Verify mesh sidecar injection & `VirtualService` routes   |
| Alerts stuck in `PENDING` state       | Ensure Redis pub/sub connectivity & Celery queues drained |
| `alembic` migration mismatch          | Re-run migrations, check `alembic_version` table          |
| Worker OOMKilled in k8s              | Check resource limits & JVM (ML workloads) tuning         |

Logs aggregated to Loki; query with:

```bash
{app="vitalops-orchestrator-worker"} |= "ERROR"
```

---

## 12. FAQ

**Q:** Why PostgreSQL over MySQL?  
**A:** Advanced JSONB queries for EMR telemetry and native advisory locks used in our coordination layer.

**Q:** Can I deploy on bare-metal?  
**A:** Yes. Provide your own Ingress (Traefik or Nginx), disable `SERVICE_MESH__ENABLED`, and configure static service discovery.

---

## 13. Contributing

1. Fork ➡️ branch off `develop`  
2. Follow commit convention `feat(scope): message`  
3. Write/adjust tests and docs  
4. Open PR & sign CLA  

---

## 14. License

Licensed under the Apache License 2.0 ‑ see `LICENSE` file for details.

---

Happy automating!  
— The VitalOps Engineering Team
```