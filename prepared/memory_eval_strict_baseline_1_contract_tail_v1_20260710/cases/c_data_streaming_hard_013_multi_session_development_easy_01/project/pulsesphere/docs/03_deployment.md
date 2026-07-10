```markdown
# PulseSphere — Deployment Guide
File: `docs/03_deployment.md`  
Version: 2.4.0 <!-- Keep in sync with project release tag -->

> This document describes validated, production-ready deployment patterns for **PulseSphere**, including bare-metal, container-native, and cloud-managed targets.  Examples are opinionated yet generic enough to adapt to most environments.

---

## 1. Deployment Matrix

| Target                    | Artifact            | Orchestrator | Notes                                        |
|---------------------------|---------------------|--------------|----------------------------------------------|
| Bare-metal (CentOS/RHEL)  | RPM via `yum` repo  | systemd      | Low-latency hardware / on-prem clusters      |
| Container (Docker)        | `pulsesphere:<tag>` | Docker Swarm | Suitable for edge nodes & small scale        |
| Kubernetes (K8s & EKS)    | OCI image           | Helm Chart   | Recommended for large, elastic workloads     |
| Serverless (Fargate)      | OCI image           | AWS CDK      | Bursty, spiky traffic; limited throughput    |
| CI/CD ephemeral runners   | Static binary       | GitHub Act.  | Smoke & functional testing                   |

---

## 2. Pre-Requisites

```bash
# Build toolchain
sudo dnf groupinstall "Development Tools" -y
sudo dnf install cmake gcc clang lld \
     openssl-devel libcurl-devel libyaml-devel \
     zlib-devel libevent-devel jq -y

# Runtime dependencies
sudo dnf install librdkafka librdkafka-devel -y        # Pulses are streamed over Kafka
sudo dnf install postgresql15 libpq-devel -y           # Metadata catalog
sudo dnf install systemd-devel libcap-ng-devel -y      # Caps & unit files
```

* Minimum kernel: `5.10` (for io_uring & eBPF metrics)  
* CPU flags: `AVX2`, `FMA`, `AES` (optional, for crypto offload)  
* TLS: OpenSSL ≥ 1.1.1k

---

## 3. Building & Packaging

### 3.1 Compile From Source

```bash
git clone --depth=1 https://github.com/pulsesphere/pulsesphere.git
cd pulsesphere
mkdir -p build && cd build

cmake -DCMAKE_BUILD_TYPE=Release \
      -DENABLE_LTO=ON \
      -DENABLE_TLS=ON \
      -DENABLE_PROM=ON \
      ..
make -j$(nproc)       # Produces bin/pulsesphere
ctest --output-on-failure
sudo make install
```

### 3.2 RPM Creation

```bash
# Assumes rpmbuild macros are configured
cmake -DCPACK_GENERATOR=RPM -DENABLE_LTO=ON ..
cpack -G RPM
sudo yum localinstall PulseSphere-2.4.0-1.x86_64.rpm
```

---

## 4. Runtime Configuration

PulseSphere reads layered configuration (lowest-to-highest precedence):

1. `/etc/pulsesphere/pulsesphere.toml`
2. `/etc/pulsesphere/conf.d/*.toml`
3. `~/.config/pulsesphere.toml`
4. CLI flags (`--conf.*`)  

### Example `pulsesphere.toml`

```toml
[ingest]
broker_urls  = ["kafka://kafka-broker:9092"]
input_topic  = "raw.events"
consumer_grp = "pulsesphere-ingestors"
batch_size   = 4096
tls_enabled  = true
tls_ca_file  = "/etc/pki/ca.crt"

[enrichment]
plugins = ["geo", "lang", "toxicity"]

[storage]
sink_type    = "postgres"
dsn          = "host=db01 port=5432 user=ps_w agent=ingestor dbname=pulsesphere sslmode=verify-full"

[metrics]
prometheus_port = 9376
pushgateway     = "http://prom:9091"

[tracing]
jaeger_url      = "http://jaeger:14268/api/traces"
```

---

## 5. Bare-Metal via systemd

```ini
# /etc/systemd/system/pulsesphere.service
[Unit]
Description=PulseSphere Real-Time Stream Engine
After=network.target

[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/pulsesphere \
          --conf=/etc/pulsesphere/pulsesphere.toml
Restart=always
LimitNOFILE=1048576
Environment="RUST_LOG=error"     # Env forwarding for Rust plugins

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pulsesphere
journalctl -fu pulsesphere.service
```

---

## 6. Containerization

### 6.1 Reference Dockerfile

```dockerfile
FROM rockylinux:9 AS build
RUN dnf groupinstall -y "Development Tools" && \
    dnf install -y cmake openssl-devel libcurl-devel zlib-devel libevent-devel
COPY . /src
WORKDIR /src/build
RUN cmake -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=ON .. && \
    make -j$(nproc)

FROM rockylinux:9 AS runtime
LABEL maintainer="devops@pulsesphere.io"
RUN useradd -m -r pulsesphere
COPY --from=build /src/build/bin/pulsesphere /usr/local/bin/pulsesphere
COPY deploy/docker/entrypoint.sh /entrypoint.sh
COPY conf/pulsesphere.toml /etc/pulsesphere/
USER pulsesphere
ENTRYPOINT ["/entrypoint.sh"]
```

`entrypoint.sh` (excerpt):

```bash
#!/usr/bin/env bash
set -euo pipefail
exec /usr/local/bin/pulsesphere "$@"
```

### 6.2 Image Hardening Checklist
* Use **distroless** or **Alpine** when the eventloop is musl-compatible.  
* Enable **seccomp** profile with net, ipc syscalls whitelisted.  
* Drop all Linux capabilities except `NET_BIND_SERVICE`.  
* Scan via Trivy in CI (see section 10).

---

## 7. Kubernetes Deployment

### 7.1 Helm Chart (quickstart)

```bash
helm repo add pulsesphere https://charts.pulsesphere.io
helm install ps pulsesphere/pulsesphere \
     --set image.tag=2.4.0 \
     --set ingress.enabled=true \
     --values my-values.yaml
```

### 7.2 Raw Manifests

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pulsesphere-conf
data:
  pulsesphere.toml: |
    ## Mounted from ConfigMap
    [ingest]
    broker_urls  = ["kafka://kafka:9092"]
    input_topic  = "raw.events"
    ...

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pulsesphere
  labels: {app: pulsesphere}
spec:
  replicas: 3
  selector:
    matchLabels: {app: pulsesphere}
  template:
    metadata:
      labels: {app: pulsesphere}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9376"
    spec:
      securityContext:
        runAsNonRoot: true
        fsGroup: 2000
      containers:
        - name: ps-core
          image: ghcr.io/pulsesphere/pulsesphere:2.4.0
          args: ["--conf=/etc/pulsesphere/pulsesphere.toml"]
          ports:
            - name: http
              containerPort: 8080
            - name: prom
              containerPort: 9376
          volumeMounts:
            - name: conf
              mountPath: /etc/pulsesphere
          readinessProbe:
            httpGet: {path: /health,r port: 8080}
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: conf
          configMap: {name: pulsesphere-conf}

---
apiVersion: v1
kind: Service
metadata:
  name: pulsesphere
spec:
  selector: {app: pulsesphere}
  ports:
    - port: 80
      targetPort: http
  type: ClusterIP

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pulsesphere-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pulsesphere
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

---

## 8. Observability

1. **Prometheus** scrapes `/metrics` from port `9376`.  
2. **Grafana** dashboard JSON at `deploy/observability/grafana/pulsesphere.json`.  
3. **OpenTelemetry** exported via gRPC to `otlp-collector:4317`.  

Alert rules example:

```yaml
groups:
  - name: pulsesphere.rules
    rules:
      - alert: HighErrorRate
        expr: rate(pulsesphere_errors_total[5m]) > 50
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Spike in PulseSphere errors"
          description: "More than 50 errors/sec for the last 5 minutes."
```

---

## 9. Upgrade & Rollback

```bash
# Blue/Green on K8s
kubectl set image deploy/pulsesphere \
   ps-core=ghcr.io/pulsesphere/pulsesphere:2.4.1 --record

# Rollback if probe fails
kubectl rollout undo deploy/pulsesphere
```

* Use **partitioned rolling update** to keep at least 25 % healthy replicas.  
* Database migrations (`pulsesphere-migrate`) run as **pre-upgrade** Helm hook.

---

## 10. CI/CD (GitHub Actions)

```yaml
name: Build & Publish
on:
  push:
    branches: [ main ]
jobs:
  build:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v4
        with: {go-version: '1.21'}    # For Go-based test harness
      - name: Build
        run: |
          cmake -Bbuild -DENABLE_LTO=ON .
          cmake --build build --parallel
      - name: Unit Tests
        run: ctest --test-dir build --output-on-failure
      - name: Container
        uses: docker/build-push-action@v5
        with:
          context: .
          tags: ghcr.io/pulsesphere/pulsesphere:${{ github.sha }}
          push: true
      - name: Trivy Scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ghcr.io/pulsesphere/pulsesphere:${{ github.sha }}
          exit-code: 1
```

---

## 11. Security Hardening

* Enable **mTLS** for internal Kafka communication.  
* Leverage Linux **cgroups v2** CPU & memory QoS.  
* Integrate **OPA/Gatekeeper** for admission-time policy enforcement.  
* Rotate encryption keys via **HashiCorp Vault** Transit Engine.

---

## 12. Disaster Recovery

| Component   | Strategy                                             |
|-------------|------------------------------------------------------|
| Kafka       | Multi-AZ cluster, ISR replication factor ≥ 3         |
| Postgres    | Streaming replicas + `wal-g` S3 archived WALs        |
| ObjectStore | Versioned S3 bucket; cross-region replication        |
| Terraform   | `terraform state push` to remote backend (S3+Dynamo) |

Restore checklist:

```bash
# Infra
terraform init && terraform apply -refresh-only
# DB
wal-g backup-fetch /var/lib/pgsql/15/main LATEST
# Pulses
kafka-mirror-maker2 --whitelist '.*\.events' ...
```

---

## 13. FAQs

Q: How many events per node can PulseSphere handle?  
A: On a 16-core AMD EPYC with 32 GB RAM PulseSphere sustains **3.1 MM events/sec** (99p latency < 7 ms).

Q: Does PulseSphere support ARM?  
A: Yes—Apple M-series & Graviton 3 chips compile via `-DARCH_ARM64=ON`.

Q: Can I hot-swap enrichment plugins?  
A: Yes. Plugins are loaded via `dlopen` + Observer Pattern; issue `SIGHUP` for reload.

---

## 14. Change Log (Deployment Docs)

| Version | Date       | Author      | Notes                         |
|---------|------------|-------------|------------------------------|
| 2.4.0   | 2024-05-22 | @drawbridge | Added K8s autoscaler example |
| 2.3.0   | 2024-03-11 | @ymartinez  | systemd unit split configs   |
| 2.2.1   | 2024-01-06 | @hling      | Hardened Dockerfile          |

---

Happy streaming!  
The PulseSphere Core Team (<ops@pulsesphere.io>)
```