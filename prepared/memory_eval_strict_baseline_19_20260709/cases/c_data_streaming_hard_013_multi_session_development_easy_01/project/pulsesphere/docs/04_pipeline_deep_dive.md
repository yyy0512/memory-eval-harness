```markdown
# 04 ‑ Pipeline Deep Dive
_PulseSphere — Real-Time Social Pulse Streaming Platform_  
© 2024 PulseSphere Engineering. All rights reserved.

---

## Table of Contents
1. Architectural Overview
2. Stage-by-Stage Walk-Through
3. Event Data Model
4. Memory, Concurrency & Back-Pressure
5. Strategy Plug-In SDK (C API)
6. Aggregation Windows
7. Fault Tolerance & Replay
8. Telemetry & Observability
9. Build, Test & Profiling Recipes
10. Appendix: Complete Example Plug-In

---

## 1. Architectural Overview

```
 ┌──────────────┐  batched TCP/QUIC  ┌────────────────┐  lock-free   ┌────────────────┐
 │ Social Feeds │ ─────► Ingest GW ──► Validation/Norm │ ───────────► │ Enrichment Bus │
 └──────────────┘                    └────────────────┘               └────────────────┘
         ▲                                      │                             │
         │                                      ▼                             ▼
         │                              ┌────────────────┐            ┌──────────────────┐
         │                              │  Dead-Letter   │            │ Window Aggregator│
         │                              │     Queue      │            └──────────────────┘
         │                                      │                             │
         │                                      ▼                             ▼
         │                              ┌────────────────┐            ┌──────────────────┐
         └───────────────────────────── │ Fan-Out Mixer  │──────────►│ Sink Connectors  │
                                        └────────────────┘            └──────────────────┘
```

The pipeline is implemented as an **event-driven micro-kernel**. Each stage runs in its own thread group, communicating via **SPSC lock-free ring buffers**. A universal `ps_event_t` struct carries the immutable pulse through the fabric.

---

## 2. Stage-by-Stage Walk-Through

### 2.1 Ingestion Gateway
* Accepts HTTP/2, gRPC, WebSocket, and internal SDK feeds.  
* Performs minimal framing checks before pushing raw frames onto the `raw_queue`.

Key file: `src/ingest/ps_ingest_gateway.c`

```c
static void
ingest_on_frame(const uint8_t *buf, size_t len, ingest_meta_t m)
{
    ps_raw_frame_t *f = ps_mempool_alloc(sizeof(*f));
    if (!f) {
        ps_metrics_inc(PS_METRIC_INGEST_OOM);
        return; /* drop frame */
    }
    memcpy(f->payload, buf, len);
    f->len   = len;
    f->meta  = m;
    rb_write(&ctx->raw_queue, f); /* lock-free, may spin-wait */
}
```

### 2.2 Validation & Normalization
* Schema-on-read leveraging [Jansson](https://github.com/akheron/jansson) for rapid JSON parsing.  
* Converts vendor-specific keys to PulseSphere canonical fields.

### 2.3 Enrichment Engine
* Dynamically loads plug-ins implementing `ps_plugin_iface_v1`.  
* Supports parallel fan-out; each plug-in gets a const view of the event.

### 2.4 Windowed Aggregator
* Maintains per-topic tumbling and hopping windows.  
* Resolves out-of-order events using watermarking (see §6).

---

## 3. Event Data Model

```c
typedef struct {
    uint64_t        id;          /* monotonically increasing sequence  */
    uint64_t        ts_epoch_ns; /* source timestamp                   */
    ps_actor_id_t   actor;       /* user / bot id                      */
    ps_object_id_t  object;      /* content id                         */
    ps_pulse_kind_t kind;        /* like, comment, share, ...          */
    ps_geo_t        geo;         /* optional geo tag                   */
    ps_lang_t       lang;        /* ISO-639-1                          */
    ps_ext_kv_t     extensions;  /* vendor-specific ext map            */
    uint32_t        crc32;       /* self-checksum for fast integrity   */
} ps_event_t;
```

Immutability guarantees safe lock-free hand-off.

---

## 4. Memory, Concurrency & Back-Pressure

1. **Ring Buffer**  
   Custom implementation of a single-producer/single-consumer ring using `__atomic` built-ins.

2. **Mempool**  
   Slab allocator per core (`ps_mempool_t`) avoids heap fragmentation.

3. **Back-Pressure**  
   A full ring raises `PS_PIPE_BACKPRESSURE`, letting upstream throttle via exponential back-off.

4. **NUMA-Aware Pinning**  
   Each stage hints its CPU affinity; mempool pages are allocated on the same NUMA node.

---

## 5. Strategy Plug-In SDK (C API)

Header: `include/ps_plugin.h`

```c
typedef struct {
    const char *name;                      /* plug-in label        */
    uint32_t    abi_version;               /* == PS_PLUGIN_ABI_V1  */
    void      (*init)   (ps_plugin_ctx_t*);
    void      (*process)(const ps_event_t*, ps_plugin_ctx_t*);
    void      (*flush)  (ps_plugin_ctx_t*); /* window flush hook   */
    void      (*fini)   (ps_plugin_ctx_t*);
} ps_plugin_iface_v1;

#define PS_PLUGIN_EXPORT                                                       \
    __attribute__((visibility("default"))) const ps_plugin_iface_v1 ps_plugin
```

### Writing a Plug-In

```c
#include "ps_plugin.h"
#include "libtoxicity.h"

static void
tox_init(ps_plugin_ctx_t *ctx)
{
    tox_model_load(ctx->config["model_path"]);
}

static void
tox_process(const ps_event_t *e, ps_plugin_ctx_t *ctx)
{
    if (e->kind != PS_PULSE_COMMENT) return;

    double score = tox_predict(e->extensions.comment_text);
    ps_meta_set_double(ctx, "toxicity", score);
}

static void
tox_fini(ps_plugin_ctx_t *ctx) { tox_model_unload(); }

const ps_plugin_iface_v1 ps_plugin = {
    .name     = "toxicity_scoring",
    .abi_version = PS_PLUGIN_ABI_V1,
    .init     = tox_init,
    .process  = tox_process,
    .flush    = NULL,
    .fini     = tox_fini
};
```

Compile:  
`gcc -fPIC -shared -o libps_toxicity.so toxicity.c -ltoxicity`

---

## 6. Aggregation Windows

PulseSphere supports:

* Tumbling (`Δt` non-overlapping)  
* Hopping (`Δt` overlap), configurable hop size `h`  
* Sliding count (`N` events)  
* Session windows (inactivity gap `g`)

```c
static inline uint64_t
wm_calc(const ps_event_t *e)
{
    /* Watermark: last_seen_ts – allowed_lateness */
    return ps_atomic_read_u64(&g_last_seen_ts) - LATE_MS_TO_NS(800);
}

void
aggregator_on_event(const ps_event_t *e)
{
    uint64_t wm = wm_calc(e);
    if (e->ts_epoch_ns < wm) { stash_late(e); return; }

    window_bucket_t *b = bucket_for(e->ts_epoch_ns);
    bucket_add(b, e);
}
```

Late events are reconciled during periodic compaction.

---

## 7. Fault Tolerance & Replay

* **Write-Ahead Log (WAL)** per stage using `O_DIRECT` and CRC-32 chunking.  
* **Checkpoint**: every 5 s aggregator persists window state (RocksDB).  
* **Replay**: on crash, ingest GW replays WAL whilst honoring event idempotency.

---

## 8. Telemetry & Observability

* **Prometheus** textfile exporter (`/var/run/ps_metrics.prom`)  
* **Tracepoints** via LTTng (`src/trace/`)  
* **pprof-compatible** heap/CPU profiling gated by `--prof` flag.

Key metric: `ps_pipeline_latency_ns{stage="enrichment"}`.

---

## 9. Build, Test & Profiling Recipes

```
# Build all
$ meson setup build && ninja -C build

# Run unit tests (μ-units & integration)
$ meson test -C build --num-processes 8

# Start sandbox cluster
$ ./scripts/dev_cluster.sh up

# Stress test ingest (10 M events/s for 60 s)
$ build/tools/ps_bench_ingest -c bench/high_throughput.toml

# CPU flamegraph
$ perf record -F 99 -g build/bin/pulsesphere --prof
$ perf script | ./scripts/flamegraph.pl > flame.svg
```

---

## 10. Appendix: Complete Example Plug-In

`plugins/emoji_reaction_counter/emoji_counter.c`

```c
#include "ps_plugin.h"
#include <stdbool.h>
#include <string.h>

#define EMOJI_HASH_SIZE  4096

static uint64_t emoji_table[EMOJI_HASH_SIZE];

static inline uint32_t
hash_emoji(const char *u)
{
    uint32_t h = 5381;
    for (const unsigned char *p = (const unsigned char*)u; *p; ++p)
        h = ((h << 5) + h) + *p;
    return h & (EMOJI_HASH_SIZE - 1);
}

static void
ec_init(ps_plugin_ctx_t *ctx)
{
    memset(emoji_table, 0, sizeof(emoji_table));
}

static void
ec_process(const ps_event_t *e, ps_plugin_ctx_t *ctx)
{
    if (e->kind != PS_PULSE_REACTION) return;

    const char *emoji = ps_kv_get(&e->extensions, "emoji");
    if (!emoji) return;

    uint32_t idx = hash_emoji(emoji);
    __atomic_add_fetch(&emoji_table[idx], 1, __ATOMIC_RELAXED);
}

static void
ec_flush(ps_plugin_ctx_t *ctx)
{
    /* emit counts every window */
    for (uint32_t i = 0; i < EMOJI_HASH_SIZE; ++i) {
        uint64_t c = __atomic_exchange_n(&emoji_table[i], 0, __ATOMIC_RELAXED);
        if (c == 0) continue;
        ps_metric_emit_u64(ctx, "emoji_count", c, "bucket", i);
    }
}

static void
ec_fini(ps_plugin_ctx_t *ctx) { /* no-op */ }

const ps_plugin_iface_v1 ps_plugin = {
    .name        = "emoji_reaction_counter",
    .abi_version = PS_PLUGIN_ABI_V1,
    .init        = ec_init,
    .process     = ec_process,
    .flush       = ec_flush,
    .fini        = ec_fini
};
```

Compile & deploy:

```
$ gcc -fPIC -shared -o libps_emoji_counter.so emoji_counter.c
$ pulsesphere --plugin ./libps_emoji_counter.so
```

---

_Questions?_ Reach us at `#pulsesphere-dev` on Matrix or open a GitHub issue.

```