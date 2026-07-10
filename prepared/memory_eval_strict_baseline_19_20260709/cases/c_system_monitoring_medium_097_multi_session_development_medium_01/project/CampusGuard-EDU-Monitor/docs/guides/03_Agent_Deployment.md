```markdown
# CampusGuard EDU Monitor – Guide 03  
## Agent Deployment & Bootstrap Handbook
*Last updated: 2024-03-30*

> This guide describes how to compile, package, and roll-out the **CampusGuard Agent** to a fleet of lab
> virtual-machines.  
> The agent is written in ISO C 17 and relies only on *libevent* and *SQLite*—making it lightweight
> enough to run on resource-constrained student VMs while still showcasing production-grade
> techniques such as TLS mutual-auth, an internal message-bus, and hot-upgrade capability.

---

## 1. High-level Architecture

```
[Agent] ──► (gTLS) ──► [Relay/API] ──► [Event Bus] ──► [Controller]
   │                         ▲
   └──────── local IPC ◄─────┘
```

1. **Agent**  
   • Collects metrics, parses logs, and performs lightweight security scans.  
   • Publishes `MetricReport`, `Alert`, and `StatusBeat` events every *N* seconds.  
   • Listens for secure commands: `StartScan`, `SendLogs`, `Upgrade`, `Shutdown`.

2. **Relay/API**  
   • Terminates TLS connections, validates tokens, and forwards events into the internal
     ØMQ-backed *Event Bus*.

3. **Controller**  
   • Applies *Chain-of-Responsibility* to authorize user requests.  
   • Dispatches Jobs to Agents through the Relay.

---

## 2. Prerequisites

| Component      | Minimum Version | Ubuntu LTS | Fedora | macOS    |
| -------------- | --------------- | ---------- | ------ | -------- |
| GCC / Clang    | C17-capable     | 11         | 13     | Xcode 14 |
| cmake          | 3.25            | ✅         | ✅     | ✅       |
| libevent-core  | 2.1.8           | `libevent-dev` | `libevent-devel` | Homebrew |
| OpenSSL        | 3.x             | `libssl-dev`   | `openssl-devel` | ✅       |
| SQLite         | 3.40            | `libsqlite3-dev` | ✅ | ✅       |

---

## 3. Compiling the Agent

### 3.1 Obtain the source

```bash
git clone https://github.com/CampusGuard/edu-monitor.git
cd edu-monitor/agent
```

### 3.2 Configure & build

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

The resulting binary (`bin/cg-agent`) is **statically linked** by default.  
To create a smaller *dynamically linked* build:

```bash
cmake -B build -DBUILD_STATIC=OFF -DENABLE_LTO=ON
cmake --build build --target strip
```

### 3.3 Unit-tests

```bash
ctest --test-dir build --output-on-failure
```

---

## 4. Packaging for Distribution

The project ships with a cross-platform **packaging recipe**:

```bash
./scripts/package_agent.sh --arch x86_64 --out dist/
```

This script:

1. Copies the binary and default configuration.  
2. Generates a *systemd* unit (`cg-agent.service`).  
3. Signs the tarball with *Cosign* for supply-chain integrity.

Resulting artifact: `CampusGuard-agent-<ver>-linux-x86_64.tar.gz.sig`

---

## 5. Configuration Reference (`agent.yml`)

```yaml
agent:
  id: "{{ vm_hostname }}"
  tenancy: "cs-lab"
network:
  relay_url: "relay.lab.edu:5443"
  tls:
    ca_file: "/etc/campusguard/ca.pem"
    crt_file: "/etc/campusguard/agent.pem"
    key_file: "/etc/campusguard/agent.key"
collection:
  log_paths:
    - "/var/log/auth.log"
    - "/var/log/syslog"
  metric_interval_sec: 15
  scan:
    enable_rootkit: true
    enable_pkg_audit: false
```

---

## 6. Secure Bootstrap Flow

1. **Provision**  
   • Controller generates a *one-time* bootstrap token (`cgctl agent token create <host>`).  
2. **Enroll**  
   • At first launch, the agent exchanges the token for a TLS client certificate via ACME-like
     protocol.  
3. **Heartbeat**  
   • Agent starts sending signed `StatusBeat` frames every 15 s.

The snippet below shows the *C* code responsible for the bootstrap:

```c
/* src/bootstrap.c */
#include "bootstrap.h"
#include "crypto/tls.h"
#include "ipc/message_bus.h"
#include "util/log.h"

#define BOOTSTRAP_ENDPOINT "/v1/agents/bootstrap"

static int exchange_token_for_cert(const char *relay,
                                   const char *token,
                                   cg_cert_ctx_t *out_ctx);

bool cg_bootstrap(const char *token)
{
    cg_cert_ctx_t tls_ctx = {0};

    if (!exchange_token_for_cert(config_get_relay_url(), token, &tls_ctx)) {
        cg_log_error("Bootstrap failed: cannot obtain client certificate.");
        return false;
    }

    if (!tls_ctx.save("/etc/campusguard/agent.pem",
                      "/etc/campusguard/agent.key")) {
        cg_log_error("Bootstrap failed: cannot persist credentials.");
        return false;
    }

    cg_log_info("Bootstrap succeeded; credentials stored.");
    return true;
}

static int exchange_token_for_cert(const char *relay,
                                   const char *token,
                                   cg_cert_ctx_t *out_ctx)
{
    cg_http_client_t *cli = cg_http_client_new(relay, true /* tls */);
    if (!cli) return -1;

    cg_http_req_t *req = cg_http_req_new("POST", BOOTSTRAP_ENDPOINT);
    cg_http_req_set_header(req, "Authorization", token);
    cg_http_res_t *res = cg_http_client_send(cli, req, NULL);

    int rc = -1;
    if (res && res->status == 201) {
        rc = cg_cert_ctx_from_pem(out_ctx, res->body, res->body_len);
    } else {
        cg_log_warn("Bootstrap error: HTTP %d", res ? res->status : 0);
    }

    cg_http_res_free(res);
    cg_http_req_free(req);
    cg_http_client_free(cli);
    return rc;
}
```

---

## 7. Installing as a Systemd Service

```ini
# /etc/systemd/system/cg-agent.service
[Unit]
Description=CampusGuard EDU Monitor Agent
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cg-agent --config /etc/campusguard/agent.yml
Restart=on-failure
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_SYS_TIME
ProtectSystem=strict
ProtectHome=read-only
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Enable & start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cg-agent
```

---

## 8. Rolling Out to 30+ VMs (Quick Start)

```bash
# 1. Pre-provision tokens
for host in $(cat vm-list.txt); do
    cgctl agent token create "$host" --ttl 24h --out tokens/"$host".jwt
done

# 2. Push artifacts & tokens
parallel -a vm-list.txt --eta --max-procs 16 \
    "scp dist/CampusGuard-agent-*.tar.gz {}/:/tmp/ && \
     scp tokens/{}.jwt {}/:/tmp/agent.jwt"

# 3. Remote install & start
parallel -a vm-list.txt \
    "ssh {} 'sudo tar -C / -xzf /tmp/CampusGuard-agent-*.tar.gz && \
             sudo /usr/local/bin/cg-agent --bootstrap /tmp/agent.jwt && \
             sudo systemctl enable --now cg-agent'"
```

After a few minutes, confirm enrollment:

```bash
cgctl agent list --status enrolled
```

---

## 9. Zero-Downtime Upgrade

The agent supports **hot-upgrade**: the new binary starts, hands off
file-descriptors via UNIX domain socket, and signals the old process to exit.

1. Build new version: `cmake --build build -j && ./scripts/package_agent.sh`
2. Upload tarball to the *Controller’s Object Store*.
3. Issue upgrade command: `cgctl agent upgrade --all --version 1.4.2`

The controller enqueues an `UpgradeJob`; the agent:

```c
/* src/upgrade.c */
if (download_and_verify(new_pkg_url, sig_url) &&
    cg_hot_swap_exec(new_binary_path, argv, envp) == 0) {
    cg_log_info("Upgrade completed via hot-swap.");
} else {
    cg_log_error("Upgrade failed; falling back to current version.");
}
```

---

## 10. Troubleshooting

| Symptom                          | Likely Cause                                  | Fix |
| -------------------------------- | --------------------------------------------- | --- |
| `Bootstrap failed (HTTP 403)`    | Token expired / wrong tenancy                 | Regenerate token |
| `TLS handshake error`            | Clock skew > 5 min                             | Run `ntpdate pool.ntp.org` |
| Agent restarts every 30 s        | Service file missing `--config` argument      | Update unit file |

View logs:

```bash
journalctl -u cg-agent -f
```

Increase verbosity:

```bash
sudo cg-agent --config /etc/campusguard/agent.yml --log-level debug
```

---

## 11. Additional Resources

• `docs/guides/04_Event_Bus.md` – Observer & ØMQ internals  
• `docs/api/relay_openapi.yaml` – REST & WebSocket spec  
• `examples/agent_embed/` – Embedding the agent into custom C apps  

---

© 2024 CampusGuard EDU Monitor — Licensed under the MIT License
```