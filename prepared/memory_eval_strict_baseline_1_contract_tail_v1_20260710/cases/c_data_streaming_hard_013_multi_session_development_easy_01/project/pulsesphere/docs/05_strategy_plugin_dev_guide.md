```markdown
<!--
   PulseSphere – Real-Time Social Pulse Streaming Platform
   ======================================================
   Document: 05_strategy_plugin_dev_guide.md
   Purpose : End-to-end guide for implementing runtime-loadable
             “strategy” plug-ins (enrichment/validation/visualization)
             that extend the PulseSphere data pipeline without
             requiring platform downtime or a full rebuild.
-->

# Strategy Plug-in Developer Guide

*Revision: 1.2*  
*Applies to: PulseSphere ≥ v0.9.0*  
*Audience: C developers building custom enrichment, QC, or analytics modules*

---

## 1. Introduction

PulseSphere exposes a hot-swappable [Strategy Pattern] ABI that allows
developers to inject new data‐processing logic into the live streaming
pipeline.  A **strategy plug-in** is a shared library (`.so`) that
conforms to a well-defined binary interface:

* Zero external symbol collisions (namespace safe)  
* Explicit life-cycle callbacks (register → init → process → flush → shutdown)  
* Strict thread-safety contract (stateless or internally synchronized)  
* Deterministic resource management (no leaks)

If you are familiar with Apache Flink or Kafka Streams user-defined
functions, PulseSphere strategies serve a similar role—yet are written
in pure, high-performance C and can be loaded/unloaded at runtime.

---

## 2. Strategy ABI Reference

The canonical definitions reside in **`include/pulsesphere/plugin.h`**
and are versioned to guarantee backward compatibility.

```c
/* pulsesphere/plugin.h
 *
 *   Author   : Core Platform Team
 *   License  : Apache-2.0
 */
#ifndef PULSES_PHERE_PLUGIN_H
#define PULSES_PHERE_PLUGIN_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ----------------------------------------------------------------------------
 * Pulse event – immutable domain object passed to plug-ins.
 * --------------------------------------------------------------------------*/
typedef struct ps_event {
    uint64_t            ts_epoch_ms;   /* Event time (milliseconds since epoch) */
    const char         *source_id;     /* Producing social network (e.g., "tw") */
    const char         *raw_payload;   /* UTF-8 JSON envelope – null-terminated */
    size_t              payload_len;   /* Pre-computed for convenience          */
    /* ... additional canonical fields live in opaque region ... */
} ps_event_t;

/* Opaque context used for platform utility calls (logging, metrics, etc.) */
typedef struct ps_context ps_context_t;

/* ------------------------------- Diagnostic --------------------------------*/

typedef enum {
    PS_LOG_TRACE, PS_LOG_DEBUG, PS_LOG_INFO,
    PS_LOG_WARN,  PS_LOG_ERROR, PS_LOG_FATAL
} ps_log_level_t;

typedef void (*ps_log_fn)(ps_context_t *ctx,
                          ps_log_level_t lvl,
                          const char    *func,
                          const char    *fmt,
                          ...)
#ifdef __GNUC__
    __attribute__((format(printf, 4, 5)))
#endif
;

/* ------------------------------ Life-cycle ----------------------------------*/

typedef struct ps_plugin_api {
    /* Mandatory fields */
    uint32_t     abi_version;      /* Must match PULSES_PHERE_ABI_VERSION     */
    const char  *name;             /* Human-readable plug-in name             */
    const char  *version;          /* Semantic version string                 */

    /* Optional metadata */
    const char  *author;
    const char  *description;

    /* Life-cycle hooks */
    int  (*init)      (ps_context_t *ctx, const char *config_json);
    int  (*process)   (ps_context_t *ctx,
                       const ps_event_t *in,
                       ps_event_t       *out);  /* in → out transform */
    int  (*flush)     (ps_context_t *ctx);      /* periodic drain      */
    void (*shutdown)  (ps_context_t *ctx);      /* graceful release    */

    /* Reserved for future expansion */
    void *reserved[4];
} ps_plugin_api_t;

/* ABI major for compatibility screening */
#define PULSES_PHERE_ABI_VERSION  3u

/* Mandatory entry point symbol name */
#define PS_PLUGIN_ENTRYPOINT  "ps_plugin_register"

/* Plug-in must export:
 *   const ps_plugin_api_t* ps_plugin_register(const ps_log_fn log_fn);
 */
typedef const ps_plugin_api_t* (*ps_plugin_register_fn)(ps_log_fn);

#ifdef __cplusplus
}
#endif
#endif /* PULSES_PHERE_PLUGIN_H */
```

### 2.1 Life-cycle Contract

1. **Registration phase** – PulseSphere performs a `dlsym()` lookup for
   `ps_plugin_register`. The plug-in passes back a **const** pointer to a
   statically allocated `ps_plugin_api_t`. No blocking allowed.

2. **Initialization** – Executed **once** on the main thread. Perform
   lightweight parsing of `config_json`. Heavy resources (ML models,
   DB connections) may be delayed until the first `process()` if
   asynchronous.

3. **Processing** – May be invoked concurrently from several worker
   threads. Implement *re-entrancy* or protect mutable state via locks.

4. **Flush** – Called periodically (configurable, default = 5 s) to
   commit batched state or emit time-windowed aggregates.

5. **Shutdown** – Called exactly once during an orderly unload. All
   allocations must be freed.

Return codes  
`init`, `process`, and `flush` must return `0` on success, negative POSIX
error numbers on failure (`-EINVAL`, `-ENOMEM`, etc.).

---

## 3. Creating a New Strategy Plug-in

1. Copy the scaffolding template:

   ```
   cp -r samples/strategy_template your_plugin_name
   ```

2. Update `plugin.c`, `Makefile`, and `README.md`.

3. Build a versioned shared library:

   ```
   $ make
   └── build/libpulsesphere_strategy_toxicity.so
   ```

4. Drop the artifact into the hot plug-in directory (default
   `/opt/pulsesphere/plugins/`) or configure
   `PULSESPHERE_PLUGIN_PATH=/my/custom/dir`.

5. Trigger a runtime discovery sweep via the `control` CLI:

   ```
   $ psctl plugin --scan --enable toxicity
   ```

---

## 4. Worked Example: Real-Time Toxicity Scorer Strategy

Below is a pared-down yet production-grade plug-in that applies a simple
wordlist-based toxicity score to each comment event. It demonstrates:

* Thread-safe look-up table using `ck_ht` (Concurrency Kit)  
* Dynamic model reload via SIGHUP  
* Minimal JSON parsing with `yyjson` for performance  

### 4.1 Directory Layout

```
toxicity_strategy/
├── Makefile
├── plugin.c
└── wordlist.txt
```

### 4.2 `plugin.c`

```c
/* ===========================================================================
 *   PulseSphere Strategy Plug-in: toxicity
 * ==========================================================================*/
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "ck_ht.h"             /* Lightweight lock-free hash table   */
#include "yyjson.h"            /* Ultra-fast DOM-less JSON parser    */
#include "pulsesphere/plugin.h"

#define MODULE_NAME    "toxicity"
#define MODULE_VERSION "1.4.2"

#define MAX_WORD_LEN   48
#define TOX_THRESHOLD  0.65        /* [0..1] toxic score to flag */

static ps_log_fn       g_log        = NULL;  /* set by host at register time */
static atomic_uint     g_reload_flag = 0;    /* SIGHUP triggered model swap  */

/* ----------------------------- Wordlist model -----------------------------*/

typedef struct {
    ck_ht_t    ht;           /* lock-free hash of toxic words */
    uint32_t   size;         /* number of entries             */
} wordlist_t;

static wordlist_t *g_model = NULL;

/* Forward declarations */
static int   load_wordlist(const char *path, wordlist_t **out);
static void  free_wordlist(wordlist_t *m);
static double compute_toxicity(wordlist_t *model, const char *text);

static void signal_handler(int signo)
{
    if (signo == SIGHUP)
        atomic_store(&g_reload_flag, 1);
}

static int init(ps_context_t *ctx, const char *config_json)
{
    (void)ctx;
    yyjson_doc *doc = yyjson_read(config_json, strlen(config_json), 0);
    if (!doc) {
        g_log(ctx, PS_LOG_ERROR, __func__, "Invalid JSON config");
        return -EINVAL;
    }

    yyjson_val *root = yyjson_doc_get_root(doc);
    const char *path = "/opt/pulsesphere/models/wordlist.txt";
    yyjson_val *vpath = yyjson_obj_get(root, "wordlist_path");
    if (vpath && yyjson_is_str(vpath))
        path = yyjson_get_str(vpath);

    if (load_wordlist(path, &g_model) != 0) {
        yyjson_doc_free(doc);
        return -ENOENT;
    }
    yyjson_doc_free(doc);

    /* install SIGHUP handler */
    struct sigaction sa = {.sa_handler = signal_handler};
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    sigaction(SIGHUP, &sa, NULL);

    g_log(ctx, PS_LOG_INFO, __func__,
          "toxicity model loaded (%u tokens) from %s",
          g_model->size, path);
    return 0;
}

static int process(ps_context_t *ctx,
                   const ps_event_t *in,
                   ps_event_t       *out)
{
    if (!in || !out) return -EINVAL;

    /* fast path: shallow copy input to output */
    memcpy(out, in, sizeof(*out));

    /* handle reload request once per worker thread */
    if (atomic_exchange(&g_reload_flag, 0)) {
        g_log(ctx, PS_LOG_INFO, __func__, "Reloading toxicity model");
        wordlist_t *new_model = NULL;
        if (load_wordlist("/opt/pulsesphere/models/wordlist.txt",
                          &new_model) == 0)
        {
            wordlist_t *old = atomic_exchange_ptr((void *)&g_model, new_model);
            free_wordlist(old);
        }
    }

    /* naive substring toxicity scoring */
    double score = compute_toxicity(g_model, in->raw_payload);

    /* Append score attribute to JSON payload in-place (cheap & dirty) */
    char *augmented = NULL;
    int rc = asprintf(&augmented,
                      "{\"payload\":%.*s,\"toxicity\":%.3f}",
                      (int)in->payload_len,
                      in->raw_payload,
                      score);
    if (rc == -1 || !augmented) {
        g_log(ctx, PS_LOG_ERROR, __func__, "OOM while augmenting event");
        return -ENOMEM;
    }
    out->raw_payload = augmented;
    out->payload_len = (size_t)rc;

    /* Tag event if score too high for moderation queue */
    if (score >= TOX_THRESHOLD) {
        g_log(ctx, PS_LOG_WARN, __func__,
              "Flagged toxic event (score=%.2f, src=%s)", score, in->source_id);
        /* The emitter may route flagged events based on metadata hint */
    }
    return 0;
}

static int flush(ps_context_t *ctx)
{
    (void)ctx;
    /* No internal buffers; nothing to flush. */
    return 0;
}

static void shutdown(ps_context_t *ctx)
{
    (void)ctx;
    free_wordlist(g_model);
    g_model = NULL;
}

static const ps_plugin_api_t plugin_api = {
    .abi_version  = PULSES_PHERE_ABI_VERSION,
    .name         = MODULE_NAME,
    .version      = MODULE_VERSION,
    .author       = "Community Trust & Safety Team",
    .description  = "Simple wordlist-based toxicity scorer",
    .init         = init,
    .process      = process,
    .flush        = flush,
    .shutdown     = shutdown
};

const ps_plugin_api_t*
ps_plugin_register(ps_log_fn log_fn)
{
    g_log = log_fn;
    return &plugin_api;
}

/* ---------------------------------------------------------------------------
 * Internal helpers
 * --------------------------------------------------------------------------*/
static int load_wordlist(const char *path, wordlist_t **out)
{
    FILE *fp = fopen(path, "r");
    if (!fp) return -errno;

    wordlist_t *m = calloc(1, sizeof(*m));
    if (!m) {
        fclose(fp);
        return -ENOMEM;
    }

    ck_ht_init(&m->ht, CK_HT_MODE_BYTESTRING, NULL, NULL, 1024, 6608231);

    char buf[MAX_WORD_LEN + 2];
    while (fgets(buf, sizeof(buf), fp)) {
        size_t len = strcspn(buf, "\r\n");
        buf[len] = '\0';
        ck_ht_entry_t entry;
        ck_ht_hash_t  h;

        ck_ht_hash(&h, &m->ht, buf, len);
        ck_ht_entry_set(&entry, h, buf, len, (uintptr_t)1);
        if (ck_ht_set(&m->ht, h, &entry)) m->size++;
    }
    fclose(fp);

    *out = m;
    return 0;
}

static void free_wordlist(wordlist_t *m)
{
    if (!m) return;
    ck_ht_destroy(&m->ht);
    free(m);
}

static double compute_toxicity(wordlist_t *model, const char *json)
{
    if (!model || !json) return 0.0;
    /* naive: measure toxic token frequency */
    size_t toks = 0, toxic = 0;

    yyjson_read_err err;
    yyjson_doc *doc = yyjson_read_opts(json, strlen(json), 0, NULL, &err);
    if (!doc) return 0.0;

    yyjson_val *payload = yyjson_doc_get_root(doc);
    yyjson_val *msg = yyjson_obj_get(payload, "message");
    const char *text = msg && yyjson_is_str(msg)
                       ? yyjson_get_str(msg)
                       : "";

    char *dup = strdup(text);
    if (!dup) {
        yyjson_doc_free(doc);
        return 0.0;
    }
    for (char *tok = strtok(dup, " \t.,!?:;\"\'"); tok; tok = strtok(NULL, " \t.,!?:;\"\'"))
    {
        toks++;
        size_t len = strlen(tok);
        ck_ht_entry_t entry;
        ck_ht_hash_t  h;

        ck_ht_hash(&h, &model->ht, tok, len);
        if (ck_ht_get(&model->ht, h, &entry))
            toxic++;
    }
    free(dup);
    yyjson_doc_free(doc);
    if (!toks) return 0.0;
    return (double)toxic / (double)toks;
}
```

### 4.3 `Makefile`

```makefile
PLUGIN  = libpulsesphere_strategy_toxicity.so
CFLAGS  = -fPIC -Wall -Werror -O3 -march=native \
          -I../../include                           \
          -I/usr/local/include/yyjson               \
          -I/usr/local/include/concurrencykit
LDFLAGS = -shared -Wl,-z,defs -Wl,-Bsymbolic-functions \
          -L/usr/local/lib -lyyjson -lck

SRC     = plugin.c

$(PLUGIN): $(SRC)
	$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)

clean:
	rm -f $(PLUGIN)
```

---

## 5. Building & Deploying

```bash
# inside the plug-in directory
$ make

# verify exported symbol
$ nm -D libpulsesphere_strategy_toxicity.so | grep ps_plugin_register

# copy / symlink
$ sudo cp libpulsesphere_strategy_toxicity.so /opt/pulsesphere/plugins/
```

The core daemon automatically invokes `ps_plugin_register()` during the
next discovery sweep.

---

## 6. Functional Test with `psctl`

```
$ psctl plugin --inspect toxicity
name       : toxicity
version    : 1.4.2
author     : Community Trust & Safety Team
state      : LOADED (3 instances)
uptime     : 22m 13s
```

Inject a mock event:

```
$ echo '{"message":"you are an idiot"}' | psctl ingest --source fake
```

Observe moderation alerts in the platform log.

---

## 7. Best Practices Cheat-Sheet

* Avoid global mutable state; prefer per-thread structures or atomics.  
* Never call blocking I/O on the critical path—off-load to internal
  queues + worker threads if needed.  
* Keep the plug-in footprint small; the host process shares address
  space across all strategies—one memory leak poisons them all.  
* Check `abi_version` at compile time (`static_assert`) to catch future
  changes early.  
* Use `-Wl,-z,defs` to ensure **all** unresolved symbols are caught at
  link time.

---

## 8. Troubleshooting

Symptom | Likely Cause | Remediation
--------|--------------|------------
`undefined symbol: ps_plugin_register` | Wrong function name/signature | Ensure exact symbol + `extern "C"`
`abi version mismatch` | Compiled against older/newer headers | Re-install SDK headers, recompile
High latency spike | Blocking I/O in `process()` | Move to async / thread-pool
Crash on unload | Static resources not freed | Implement `shutdown()` correctly

---

## 9. Glossary

Strategy Pattern – Behavioral design pattern that enables selecting an
algorithm’s implementation at runtime.

ABI – Application Binary Interface; dictates symbol names, calling
conventions, data structure layouts, and binary compatibility.

---

©2024 PulseSphere Contributors – Released under Apache License 2.0
```