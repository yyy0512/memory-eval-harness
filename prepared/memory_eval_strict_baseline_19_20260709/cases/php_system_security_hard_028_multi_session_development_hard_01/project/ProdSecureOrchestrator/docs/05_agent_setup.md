```markdown
# 05 ‑ Agent Setup  
ProdSecure Orchestrator • System Security Suite  
_Last updated: {{DATE}}_

The **ProdSecure Agent** is a lightweight, cross-platform collector written in PHP-CLI that streams host telemetry, security events, and deployment hooks back to the Orchestrator in real-time.  
This guide walks you through:

1. Supported platforms & sizing guidelines  
2. Installation (online/offline)  
3. Secure registration & mTLS bootstrap  
4. Run-time configuration reference  
5. Service management (systemd, Upstart, Windows Service)  
6. Zero-downtime upgrades & rollback  
7. Advanced tuning, multi-tenant deployments, and FAQ


---

## 1. Compatibility Matrix

| OS / Distro               | Version(s)          | PHP Runtime                | Status      |
| ------------------------- | ------------------- | -------------------------- | ----------- |
| Ubuntu Server            | 18.04 LTS – 22.04 LTS| 8.1 CLI (ZTS **disabled**) | ✅ Supported |
| Debian                    | 10 (Buster)+        | 8.0 CLI+                  | ✅ Supported |
| RHEL / CentOS / Rocky     | 8.x / 9.x           | 8.0 CLI+                  | ✅ Supported |
| Amazon Linux             | 2                   | 8.0 CLI+                  | ✅ Supported |
| Windows Server           | 2016 – 2022         | PHP 8.1 x64 NTS            | ✅ Supported |
| macOS (Intel & Apple Silicon)\* | 11 (Big Sur)+ | 8.1 CLI (brew)            | 🛠 Lab-only  |

\*macOS is intended for development or PoC use only. Production use is not officially supported.

**Minimum Hardware**

* 1 vCPU, 256 MB RAM, 200 MB disk  
* Network throughput ≥ 1.5 Mb/s  

**Sizing Hint**: A typical agent with full telemetry (metrics + logs + security scans) peaks at ~80 MB RSS and 5% CPU on modern hosts.

---

## 2. Prerequisites

1. **PHP Runtime** — Install PHP 8.0+ CLI _without_ Zend Thread Safety (ZTS).  
2. **OpenSSL 1.1+** — For mTLS handshake.  
3. **Outbound Connectivity** — TCP 443 to the Orchestrator’s Agent Gateway (`agents.prodsecure.example.com`).  
4. **User Account** — Non-privileged user `psagent` with `sudo` rights for selected plugins (e.g., OS patch scanner).

### Install PHP & System Packages (Linux)

```bash
sudo apt update && \
sudo apt install -y php8.1-cli php8.1-curl php8.1-openssl \
                     php8.1-xml php8.1-json openssl ca-certificates \
                     jq unzip curl
```

---

## 3. Installation

### 3.1 Online Install (curl | bash)

```bash
curl -sS https://download.prodsecure.io/agent/install.sh | sudo bash
```

During installation you will be prompted for:

* **Tenant ID** — e.g., `acme-corp`  
* **Registration Token** — generated under _Settings ➜ Agents ➜ Tokens_  
* **Environment** — `prod`, `staging`, `dev`, etc.

The script:

1. Creates `/opt/prodsecure-agent`  
2. Downloads the latest **signed** release (`prodsecure-agent_X.Y.Z_linux_amd64.zip`)  
3. Verifies the SHA-256 checksum & GPG signature  
4. Installs a systemd service `prodsecure-agent.service`  
5. Runs initial `psagent healthcheck`

### 3.2 Offline / Air-gapped Install

1. Download the bundle from a connected workstation:

   ```bash
   curl -O https://download.prodsecure.io/agent/prodsecure-agent_X.Y.Z_linux_amd64.zip
   curl -O https://download.prodsecure.io/agent/prodsecure-agent_X.Y.Z_checksums.txt
   curl -O https://download.prodsecure.io/agent/RELEASES.gpg
   ```

2. Copy files to the target host (`scp` or removable media).  
3. Verify checksums and signatures _on the host_:  

   ```bash
   sha256sum -c prodsecure-agent_X.Y.Z_checksums.txt
   gpg --verify RELEASES.gpg
   ```  

4. Unzip into `/opt/prodsecure-agent` and run `./install.sh --offline`.

---

## 4. Secure Registration & Bootstrap

Agents authenticate via **short-lived registration tokens** exchanged for X.509 client certificates (valid 365 days by default).

1. `psagent register --token <TOKEN> --tenant <TENANT_ID> --url https://agents.prodsecure.example.com`  
2. The bootstrapper:

   a. Generates a 4096-bit RSA private key under `/var/lib/prodsecure-agent/certs`.  
   b. Creates a CSR embedding the host’s UUID, hostname, and tenant tag.  
   c. Posts the CSR to `/v1/agent/bootstrap`.  
   d. Receives a signed **client cert** + CA bundle, stored on disk with `0600` perms.  

3. Subsequent traffic negotiates mTLS (TLS 1.3) with **mutual identity verification**.

---

## 5. Configuration Reference (`agent.yaml`)

Located at `/etc/prodsecure/agent.yaml`. All keys are hot-reloadable (`SIGHUP`).

```yaml
general:
  tenant: acme-corp
  environment: prod
  log_level: info           # debug, info, warn, error
  metrics_interval: 30s
  log_rotation:
    size: 100MB
    files: 7

transport:
  gateway_url: https://agents.prodsecure.example.com
  proxy: ""                 # http(s)://user:pass@proxy:port or empty
  tls_verify: true
  max_backoff: 2m

plugins:
  system_metrics: true
  log_shipper:
    enabled: true
    paths:
      - /var/log/syslog
      - /var/log/nginx/*.log
  vulnerability_scanner:
    enabled: true
    schedule: "0 3 * * *"   # cron-style
  custom_scripts:
    - name: Check Disk Usage
      path: /opt/scripts/check_disk.sh
      interval: 5m
```

### Environment Variable Overrides

| Variable                       | Overrides                | Example                           |
| ------------------------------ | ------------------------ | --------------------------------- |
| `PS_AGENT_TOKEN`               | `general.tenant`, token  | `export PS_AGENT_TOKEN=abcd…`     |
| `PS_GATEWAY_URL`               | `transport.gateway_url` | `https://agents.internal:8443`     |
| `PS_AGENT_LOG_LEVEL`           | `general.log_level`     | `debug`                           |

---

## 6. Service Management

### systemd (Linux)

```bash
sudo systemctl enable --now prodsecure-agent
sudo systemctl status prodsecure-agent
sudo journalctl -u prodsecure-agent -f
```

### Upstart (Legacy)

The installer drops `/etc/init/prodsecure-agent.conf`; start with `sudo start prodsecure-agent`.

### Windows Service

```powershell
cd "C:\Program Files\ProdSecure Agent"
.\psagent.exe install --token <TOKEN> --tenant <TENANT>
Start-Service ProdSecureAgent
Get-EventLog -LogName Application -Source "ProdSecure Agent"
```

---

## 7. Upgrades & Rollbacks

The agent supports **in-place zero-downtime upgrades**:

```bash
sudo psagent upgrade --channel stable   # stable, rc, nightly
```

Internally, the agent:

1. Downloads the new binary to `/opt/prodsecure-agent/releases/<version>`  
2. Verifies checksum & GPG  
3. Switches the `current` symlink atomically  
4. Sends a _drain_ signal to the old worker, allowing in-flight batches to flush  
5. Rolls forward; on failure automatically rolls back.

To pin a specific version:

```bash
sudo psagent lock 3.4.2
```

---

## 8. Advanced Topics

### 8.1 Multi-Tenant / Service Mesh Mode

`psagent` can run _multiple instances_ per host, one per tenant or env:

```bash
sudo psagent --config /etc/prodsecure/tenant-alpha.yaml --systemd-unit prodsecure-alpha
sudo psagent --config /etc/prodsecure/tenant-beta.yaml  --systemd-unit prodsecure-beta
```

Each instance negotiates a distinct certificate and publishes its own metrics namespace.

### 8.2 High-Frequency Metrics

For high-churn workloads (e.g., Kubernetes nodes) set `metrics_interval: 10s` and increase `transport.max_backoff` to avoid thundering-herd retries.

```yaml
general:
  metrics_interval: 10s
transport:
  backpressure_threshold: 5000   # queued events
```

---

## 9. Troubleshooting

| Symptom                          | Possible Cause                    | Remediation                              |
| -------------------------------- | --------------------------------- | ---------------------------------------- |
| `ERR_TLS_CERT_EXPIRED`           | Cert older than 365d              | `psagent renew-cert`                     |
| `queue_overflow` warnings        | Gateway unreachable / latency     | Check firewall, proxy, or set `max_backoff` |
| High CPU (>20 %)                 | Too many custom scripts           | Stagger intervals or migrate to remote exec |
| `invalid registration token`     | Token revoked or typo             | Re-generate token in UI                  |

Gather diagnostics:

```bash
sudo psagent diag --output /tmp/psagent_diag_$(date +%s).tar.gz
```

---

## 10. Frequently Asked Questions (FAQ)

**Q:** _Can the agent run inside a container?_  
**A:** Yes. Use the official image `ghcr.io/prodsecure/agent:latest` and mount `/host` for log & metric access.

**Q:** _How are secrets stored?_  
**A:** Sensitive fields are encrypted using the Orchestrator’s tenant-scoped AES-256-GCM keyring and never written in plain-text to disk.

**Q:** _Is SELinux supported?_  
**A:** Enforcing mode is fully supported; the installer adds the required policy module (`prodsecure_agent.te`).

---

## 11. Glossary

* **Agent Gateway** — The cluster-scalable ingress layer terminating mTLS and load-balancing to internal streaming brokers.  
* **Tenant** — A logical isolation boundary in the Orchestrator.  
* **mTLS** — Mutual TLS; both client and server present certificates for strong identity.  

---

### Need help?

• Docs: <https://docs.prodsecure.io>  
• Slack: `#prodsecure-community`  
• Email: support@prodsecure.io  
• 24x7 Hotline: +1-800-785-SECUR

---

© 2024 ProdSecure Inc. All rights reserved.
```