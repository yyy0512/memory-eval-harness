```markdown
<!--
  PulseSphere – Real-Time Social Pulse Streaming Platform
  Setup & Deployment Guide
  -------------------------------------------------------
  File: docs/02_setup_guide.md
  License: Apache-2.0
  Copyright (c) 2024
-->

# PulseSphere — Setup & Deployment Guide

Welcome to PulseSphere!  
This document walks you through everything required to **build, test, and run** a local or production-grade cluster of the PulseSphere data-streaming platform.

> Target audience: C developers, DevOps engineers, and SREs familiar with *nix tooling, CMake, and containerisation.

---

## 1. At-a-Glance

| Layer                | Tech / Library                                     | Purpose                                |
|----------------------|----------------------------------------------------|----------------------------------------|
| Runtime              | **C17** + `-pthread`                               | Event-driven core                      |
| Networking           | libevent 2.1+, OpenSSL 1.1+                        | Non-blocking I/O, TLS                  |
| Serialization        | Protocol Buffers 3.21+                             | Pulse framing                          |
| Compression          | Zstandard 1.5+                                     | High-speed compression                 |
| Build System         | CMake ≥ 3.18                                       | Cross-platform builds                  |
| Observability        | Prometheus-C-Client, `spdlog`                      | Metrics & logging                      |
| Container Runtime    | Docker 24+, podman 5+                              | Deployment                             |
| Orchestration (opt.) | Kubernetes 1.28+, Helm 3.12+                       | Scalability                            |

---

## 2. Prerequisites

### 2.1 Operating System

* Ubuntu 22.04 LTS / Debian 12  
* Fedora 39 / RHEL 9  
* macOS 13+ (Apple Silicon & Intel)  

> Windows is supported via **WSL2** or **MSYS2**.

### 2.2 System Packages

Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential cmake pkg-config git \
  libevent-dev libprotobuf-dev protobuf-compiler \
  libssl-dev libzstd-dev libspdlog-dev
```

Fedora:

```bash
sudo dnf install -y gcc gcc-c++ cmake make pkgconfig git \
  libevent-devel protobuf-devel protobuf-compiler \
  openssl-devel zstd-devel spdlog-devel
```

macOS (Homebrew):

```bash
brew install cmake libevent protobuf openssl@3 zstd spdlog
```

---

## 3. Source Checkout

```bash
git clone --recurse-submodules https://github.com/pulsesphere/pulsesphere.git
cd pulsesphere
```

---

## 4. Building PulseSphere

### 4.1 Out-of-Source Build

```bash
mkdir -p build && cd build

# Release build with sanitizers off
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build . --target all -j$(nproc)
```

> For debug builds:
> `cmake -DCMAKE_BUILD_TYPE=Debug -DENABLE_ASAN=ON ..`

### 4.2 Unit & Integration Tests

Inside `build/`:

```bash
ctest --output-on-failure
```

All tests should pass. Coverage can be generated with:

```bash
cmake --build . --target coverage
xdg-open coverage/index.html   # Linux
open coverage/index.html       # macOS
```

---

## 5. Quick-Start (Standalone)

PulseSphere bundles a standalone *dev server* named **`ps_devbox`**. It spins up:

* An in-memory Event Broker
* Pulsar WebSocket compatible endpoint
* Embedded Prometheus metrics

```bash
./bin/ps_devbox --listen 0.0.0.0:9600 --workers $(nproc)
```

You should see:

```
[INFO] DevBox online  | http://127.0.0.1:9600
[INFO] Prometheus     | http://127.0.0.1:9600/metrics
```

Open another terminal:

```bash
cargo install websocat        # Only needed for test drive
echo '{"like": {"user":"@alice","post":"42"}}' | \
  websocat ws://localhost:9600/pulse/in
```

If everything is wired correctly you’ll receive an acknowledgement JSON frame.

---

## 6. Configuration

Runtime behaviour is tuned via a **TOML** file (default: `conf/pulsesphere.toml`).  
Key sections:

```toml
[network]
bind          = "0.0.0.0"
port          = 7600
tls_enabled   = true
cert_path     = "/etc/pulsesphere/tls/fullchain.pem"
key_path      = "/etc/pulsesphere/tls/privkey.pem"

[pipeline]
worker_threads     = 16
window_ms          = 60000        # 60-second lateness reconciliation
max_batch_bytes    = "4MB"
strategy_plugins   = ["toxicity.so", "geotag.so"]

[sinks.prometheus]
bind = "127.0.0.1:9102"
```

Reload without downtime:

```bash
kill -HUP $(pidof pulsesphered)
```

> PulseSphere validates the new config and performs a zero-copy switch-over.

---

## 7. Running as a Systemd Service

`sudo tee /etc/systemd/system/pulsesphere.service >/dev/null <<'EOF'
[Unit]
Description=PulseSphere Event Stream Processor
After=network-online.target

[Service]
Type=simple
User=pulsesphere
Group=pulsesphere
ExecStart=/opt/pulsesphere/bin/pulsesphered \
         --config /etc/pulsesphere/pulsesphere.toml
LimitNOFILE=1048576
Restart=always
RestartSec=5
Environment=PS_LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
EOF`

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pulsesphere
journalctl -u pulsesphere -f
```

---

## 8. Containerised Deployment

### 8.1 Build the Docker Image

```bash
docker build -t ghcr.io/pulsesphere/core:latest -f docker/Dockerfile .
```

### 8.2 Single-Node

```bash
docker run --pull=always --rm -p 7600:7600 ghcr.io/pulsesphere/core:latest
```

### 8.3 Kubernetes (Helm)

```bash
helm repo add pulsesphere https://pulsesphere.github.io/charts
helm install ps pulsesphere/pulsesphere \
  --set image.tag=latest \
  --set ingress.enabled=true
```

Check pods:

```bash
kubectl get pods -l app=pulsesphere
```

---

## 9. Extending PulseSphere (C Plugin API)

PulseSphere ships with a rich Strategy Plugin interface that compiles into
`.so`/`.dylib` on Unix.

Example: **toxicity filter** (`plugins/toxicity.c`):

```c
/**
 *  Example Toxicity Scorer – flag events > threshold
 *  Compile:  gcc -shared -fPIC toxicity.c -o toxicity.so
 */

#include <pulsesphere/plugin.h>
#include <pulsesphere/pulse.h>
#include <stdlib.h>

#define TOXIC_THRESHOLD 0.75

static int toxicity_score(const char *text);

bool ps_plugin_init(ps_plugin_info_t *info)
{
    info->name        = "toxicity-scorer";
    info->version     = "1.0.0";
    info->author      = "PulseSphere Dev Team";
    return true;
}

ps_result_t ps_plugin_process(ps_pulse_t *pulse, void *ctx)
{
    if (!pulse || pulse->schema != PS_SCHEMA_COMMENT)
        return PS_OK;                   /* ignore non-comments */

    double score = toxicity_score(pulse->payload.comment.message);
    if (score > TOXIC_THRESHOLD)
        return PS_DROP;                 /* filtered out */

    return PS_OK;
}

void ps_plugin_cleanup(void *ctx) { /* NOP */ }

/* Simple demo classifier */
static int toxicity_score(const char *text)
{
    static const char *bad[] = { "hate", "stupid", "idiot", NULL };
    for (int i = 0; bad[i]; ++i)
        if (strstr(text, bad[i]))
            return 0.9 * 100;           /* 90% toxic */
    return 0.1 * 100;                   /* benign */
}
```

Place the compiled `toxicity.so` under `/usr/lib/pulsesphere/plugins` and add to
`pulsesphere.toml`:

```toml
strategy_plugins = ["toxicity.so"]
```

Hot-reloading is supported (`SIGHUP`).

---

## 10. Troubleshooting

| Symptom                             | Remedy                                                    |
|-------------------------------------|-----------------------------------------------------------|
| Build fails: *“cannot find -lprotobuf”* | Re-install `libprotobuf-dev` and run `ldconfig`.          |
| TLS handshake errors                | Verify cert/key paths & file permissions (600).          |
| Dropped events reported in metrics  | Increase `[pipeline].worker_threads`.                     |
| High p95 latency                    | Check CPU governor, disable power-save, pin NUMA nodes.   |

---

## 11. Uninstall

```bash
sudo systemctl disable --now pulsesphere
sudo rm -rf /opt/pulsesphere /etc/pulsesphere /var/log/pulsesphere
```

---

## 12. Next Steps

1. Read the **Developer Guide** (`docs/03_developer_guide.md`) for
   architectural deep-dive.
2. Contribute new plugins – see `CONTRIBUTING.md`.
3. Star ⭐ the repo and join us on Discord!

Happy streaming!  
— The PulseSphere Team
```