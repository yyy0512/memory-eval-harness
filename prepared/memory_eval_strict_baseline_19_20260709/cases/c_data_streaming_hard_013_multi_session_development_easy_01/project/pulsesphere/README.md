```markdown
# PulseSphere &nbsp;![CI](https://github.com/pulsesphere/pulsesphere/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/github/license/pulsesphere/pulsesphere) ![Coverage](https://img.shields.io/codecov/c/github/pulsesphere/pulsesphere)

Real-time social-pulse streaming platform written in C.  
Capture, validate, transform and disseminate live engagement events (likes, comments, shares, follows, emojis) from multiple social networks at **multi-million-event/second** scale.

---

## Table of Contents
1. [Key Capabilities](#key-capabilities)  
2. [Architecture](#architecture)  
3. [Quick Start](#quick-start)  
4. [Directory Layout](#directory-layout)  
5. [Configuration](#configuration)  
6. [Embedding the SDK](#embedding-the-sdk)  
7. [Performance Tuning](#performance-tuning)  
8. [Roadmap](#roadmap)  
9. [Contributing](#contributing)  
10. [License](#license)  

---

## Key Capabilities
| Category              | Details                                                                                   |
|-----------------------|-------------------------------------------------------------------------------------------|
| Data Ingestion        | Multi-source ingestion (REST WebHooks, Kafka, STOMP, gRPC, ZeroMQ)                        |
| Stream Processing     | Pluggable enrichment (geo-tag, language detect, toxicity score) via **Strategy Pattern**  |
| Event Fabric          | Lock-free ring-buffer dispatcher ± sub-µs latency (inspired by LMAX Disruptor)            |
| Fault Tolerance       | WAL + epoch-based replay, watermark + gap detection for out-of-order events               |
| Observability         | Built-in Prometheus metrics, OpenTelemetry tracing, structured JSON logging               |
| Extensibility         | Hot-swap strategy plug-ins without downtime (dlopen/close)                                |
| Compliance/Security   | TLS 1.3, OAuth2, Message ACLs, encrypted at-rest store                                    |

---

## Architecture

```text
                                             ┌──────────────────┐
         ┌───────────┐   pulses (JSON)   ┌──►│  VALIDATION      │
 REST     │ Social   │───────────────────┘   └──────────────────┘
 WebHooks │  APIs    │        ▲                ▲    ▲
/Kafka    └───────────┘        │                │    │ Strategy plug-ins
                                │                │    │
                       ┌────────┴────────┐  ┌────┴─────┐
                       │  INGESTION      │  │ ENRICHER │───┐
                       │  PIPELINE       │  │  Pool    │   │
                       └────────┬────────┘  └──────────┘   │
                                │                          │
                                ▼                          ▼
                          ┌────────────┐            ┌───────────┐
                          │ RINGBUFFER │───────────►│  BROADCAST │───► dashboards
                          └────────────┘            └───────────┘
                                ▲                          │
                                │                          ▼
                           ┌─────┴─────┐            ┌────────────┐
                           │ WRITE-AHEAD│           │   DATA     │
                           │   LOG      │           │   LAKE     │
                           └────────────┘            └────────────┘
```

*Each block is an independent microservice communicating via protobuf-defined topics.*

---

## Quick Start

### Prerequisites
* GCC ≥ 11 or Clang ≥ 13  
* CMake ≥ 3.19  
* pkg-config, OpenSSL ≥ 1.1.1, librdkafka, libcurl, libzstd  
* Linux 4.15+ (epoll, `CLOCK_TAI`)  

```bash
# Clone
git clone https://github.com/pulsesphere/pulsesphere.git
cd pulsesphere

# Build (Release w/ LTO)
cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_LTO=ON
cmake --build build -j $(nproc)

# Run minimal end-to-end demo
./build/bin/ps_demo ./etc/demo.yaml
```

Logs and Prometheus endpoints will be emitted to `./logs/` and `http://localhost:9108/metrics`.

---

## Directory Layout
| Path                | Purpose                                   |
|---------------------|-------------------------------------------|
| `src/`              | Core library & services                   |
| `include/`          | Public API headers                        |
| `plugins/`          | Hot-swappable enrichment + validation     |
| `etc/`              | Configuration templates (.yaml)           |
| `tests/`            | Catch2 unit + integration tests           |
| `bench/`            | Latency & throughput micro-benchmarks     |
| `docs/`             | Additional design docs / ADRs            |
| `scripts/`          | Utility scripts and CI helpers            |

---

## Configuration

PulseSphere uses declarative YAML files (validated at startup via JSON-Schema).  
Core fields:

```yaml
service:
  id: ingest-1
  bind: 0.0.0.0:7447
sources:
  - kind: kafka
    brokers: ["kafka-broker-1:9092"]
    topic: soc-pulses
    group: ingest-prod
enrichment:
  plugins:
    - name: lang_detect
      so_path: plugins/libps_lang_detect.so
      params:
        confidence_threshold: 0.65
storage:
  wal_directory: /var/lib/pulsesphere/wal
  max_segment_mb: 256
limits:
  max_event_size: 8KiB
  max_batch_size: 1MiB
```

Reload live with `SIGHUP`; incompatible changes trigger a graceful restart.

---

## Embedding the SDK

PulseSphere exposes a minimal API for third-party microservices:

```c
#include <ps/client.h>

int main(void) {
    ps_ctx_t *ctx = NULL;
    ps_event_t ev  = {0};

    if (ps_connect(&ctx, "tls://ingest-1:7447", PS_OPT_TLS_VERIFY) != 0) {
        fprintf(stderr, "connect failed: %s\n", ps_errmsg());
        return 1;
    }

    ev.type          = PS_EVT_LIKE;
    ev.social_id     = ps_str("fb:123456");
    ev.user_id       = ps_str("uid:42");
    ev.timestamp_ns  = ps_now_monotonic();
    ev.payload       = ps_buf("{\"post_id\":\"abc\"}", 18);

    if (ps_publish(ctx, &ev) != 0) {
        fprintf(stderr, "publish failed: %s\n", ps_errmsg());
    }

    ps_disconnect(ctx);
    return 0;
}
```

Static & shared variants of `libpulsesphere` are produced under `build/lib/`.

---

## Performance Tuning

1. Compile with `-march=native -flto -fuse-ld=lld`  
2. Pin CPU-intensive threads (NUMA-aware, use `taskset(1)`)  
3. Set:
   ```bash
   sysctl -w net.core.rmem_max=134217728
   sysctl -w net.core.wmem_max=134217728
   echo 1000000 > /proc/sys/fs/inotify/max_user_watches
   ```
4. WAL device: NVMe or tmpfs + periodic fsync to SSD mirror  
5. Adjust `RING_SIZE` (power of two) in `etc/perf.yaml` based on burst rates  

Benchmarks (`bench/run.sh`) show <2µs 99p latency @ 1M EPS on Ryzen 5950X.

---

## Roadmap
- [ ] Exactly-once delivery guarantees (two-phase commit)  
- [ ] WASM sandbox for user-defined plugins  
- [ ] ARM64 build pipeline & k3s Helm charts  
- [ ] MQTT ingest for IoT engagement widgets  

---

## Contributing

We :heart: pull requests!

1. Fork → Feature Branch → PR.  
2. Run `scripts/pre-commit.sh` (clang-format, cppcheck, spell-check).  
3. Ensure `cmake --build build && ctest` passes.  
4. Keep commit messages conventional (`feat: add geo-hash enrich plugin`).  

Read `docs/CONTRIBUTING.md` for coding standards and DCO sign-off.

---

## License

PulseSphere is distributed under the **MIT License**.  
See [`LICENSE`](LICENSE) for details.

---

<sub>© 2024 PulseSphere Project Authors</sub>
```