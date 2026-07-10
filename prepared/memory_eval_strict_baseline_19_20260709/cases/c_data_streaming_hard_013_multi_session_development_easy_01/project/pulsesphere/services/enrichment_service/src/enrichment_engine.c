```c
/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ======================================================
 * File:    enrichment_engine.c
 * Module:  Enrichment Service / Enrichment Engine
 *
 * Description:
 * ------------
 *  Thread-pool–driven enrichment engine that fan-outs every incoming
 *  `ps_event_t` to a chain of dynamically-loaded enrichment plug-ins
 *  (Strategy Pattern).  Plug-ins are .so shared objects that expose
 *
 *      int  enricher_init   (void **ctx);
 *      int  enricher_enrich (ps_event_t *event, void *ctx);
 *      void enricher_cleanup(void  *ctx);
 *
 *  The engine is responsible for:
 *   • Loading / unloading plug-ins on start-up / shutdown
 *   • Moving events through a lock-protected, condition-variable queue
 *   • Executing plug-ins in parallel worker threads
 *   • Propagating enriched events further downstream (omitted here,
 *     provided by adjacent service via callback hook)
 *
 *  NOTE: Only the enrichment engine core is implemented here.  Downstream
 *  publishing and metrics collection live in other compilation units.
 *
 * Copyright (c) 2024
 * SPDX-License-Identifier: MIT
 */

#define _GNU_SOURCE     /* dlopen, pthread_yield, etc. */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <errno.h>
#include <stdarg.h>
#include <pthread.h>
#include <unistd.h>
#include <signal.h>
#include <dlfcn.h>
#include <syslog.h>
#include <time.h>

/* ──────────────────────────────────────────────────────────────── */
/*                             Macros                              */
/* ──────────────────────────────────────────────────────────────── */

#define ENGINE_DEFAULT_THREADS      4
#define ENGINE_QUEUE_CAPACITY       8192    /* Must be > 1 */
#define ENGINE_MAX_ENRICHERS        32
#define CONFIG_ENV_THREADS          "PULSPH_THREADS"
#define CONFIG_ENV_PLUGINS          "PULSPH_PLUGINS"   /* comma-separated list */

/* Simple logging wrapper */
#define LOG_PRI(pri, fmt, ...)  syslog((pri), "[enrichment_engine] " fmt, ##__VA_ARGS__)
#define LOG_ERR(fmt, ...)       LOG_PRI(LOG_ERR,   fmt, ##__VA_ARGS__)
#define LOG_WARN(fmt, ...)      LOG_PRI(LOG_WARNING, fmt, ##__VA_ARGS__)
#define LOG_INFO(fmt, ...)      LOG_PRI(LOG_INFO,  fmt, ##__VA_ARGS__)
#define LOG_DBG(fmt, ...)       LOG_PRI(LOG_DEBUG, fmt, ##__VA_ARGS__)

/* ──────────────────────────────────────────────────────────────── */
/*                       Public Data Structures                    */
/* ──────────────────────────────────────────────────────────────── */

/*
 * Minimal PulseSphere event definition.
 * In the real code-base this lives in <ps_event.h>.
 */
typedef struct
{
    uint64_t id;                 /* unique identifier */
    uint64_t timestamp_ms;       /* epoch milliseconds */
    char     source[32];         /* originating platform */
    char    *payload;            /* JSON payload (null-terminated) */
    size_t   payload_len;        /* length in bytes, NOT including NUL */
} ps_event_t;

/* Exposed public API — forward declarations */
int  enrichment_engine_init   (const char *config_path); /* may be NULL */
int  enrichment_engine_submit (const ps_event_t *event);
void enrichment_engine_shutdown(void);

/* Callback that allows publishing enriched events downstream.
 * Must be implemented by a different compilation unit and
 * linked together with the service.
 */
extern void publisher_publish(const ps_event_t *event);

/* ──────────────────────────────────────────────────────────────── */
/*                  Plug-in (Strategy)  Infrastructure             */
/* ──────────────────────────────────────────────────────────────── */

typedef int  (*enricher_init_fn_t)   (void **ctx);
typedef int  (*enricher_fn_t)        (ps_event_t *event, void *ctx);
typedef void (*enricher_cleanup_fn_t)(void *ctx);

typedef struct
{
    char                    name[64];
    void                   *dl_handle;     /* handle from dlopen() */
    enricher_fn_t           enrich;
    enricher_cleanup_fn_t   cleanup;
    void                   *ctx;           /* plug-in private context */
} enricher_t;

/* ──────────────────────────────────────────────────────────────── */
/*                       Event Queue (FIFO)                        */
/* ──────────────────────────────────────────────────────────────── */

/* Bounded, blocking queue implemented with a circular buffer */
typedef struct
{
    ps_event_t          **buf;
    size_t                cap;
    size_t                head;
    size_t                tail;

    pthread_mutex_t       mtx;
    pthread_cond_t        cv_not_full;
    pthread_cond_t        cv_not_empty;
    bool                  closed;
} event_queue_t;

/* Forward declarations */
static int  queue_init   (event_queue_t *q, size_t capacity);
static void queue_close  (event_queue_t *q);
static void queue_destroy(event_queue_t *q);
static int  queue_push   (event_queue_t *q, ps_event_t *ev);
static ps_event_t *queue_pop(event_queue_t *q);

/* ──────────────────────────────────────────────────────────────── */
/*                    Enrichment Engine  State                     */
/* ──────────────────────────────────────────────────────────────── */

typedef struct
{
    pthread_t        *workers;
    size_t            n_workers;

    enricher_t        enricher[ENGINE_MAX_ENRICHERS];
    size_t            n_enrichers;

    event_queue_t     queue;
    volatile bool     running;
} enrichment_engine_t;

static enrichment_engine_t engine = {.running = false};

/* ──────────────────────────────────────────────────────────────── */
/*                        Utility Functions                        */
/* ──────────────────────────────────────────────────────────────── */

static void *xmalloc(size_t sz)
{
    void *p = malloc(sz);
    if (!p)
    {
        LOG_ERR("Out of memory (%zu bytes)", sz);
        abort();
    }
    return p;
}

/* Deep copy event including payload */
static ps_event_t *event_clone(const ps_event_t *src)
{
    ps_event_t *dest = xmalloc(sizeof(*dest));
    *dest = *src; /* copy POD fields */

    if (src->payload && src->payload_len)
    {
        dest->payload = xmalloc(src->payload_len + 1);
        memcpy(dest->payload, src->payload, src->payload_len);
        dest->payload[src->payload_len] = '\0';
    }
    else
    {
        dest->payload     = NULL;
        dest->payload_len = 0;
    }
    return dest;
}

static void event_free(ps_event_t *ev)
{
    if (!ev) return;
    free(ev->payload);
    free(ev);
}

/* ──────────────────────────────────────────────────────────────── */
/*                     Plug-in Loading / Unloading                 */
/* ──────────────────────────────────────────────────────────────── */

static int load_plugins(const char *csv_list)
{
    if (!csv_list || !*csv_list)
    {
        LOG_WARN("No enrichment plug-ins configured (env %s)", CONFIG_ENV_PLUGINS);
        return 0;
    }

    char *list_dup = strdup(csv_list);
    if (!list_dup)
        return -1;

    char *saveptr = NULL;
    char *token   = strtok_r(list_dup, ",", &saveptr);
    size_t idx    = 0;

    while (token && idx < ENGINE_MAX_ENRICHERS)
    {
        char *path = token;
        while (*path == ' ') ++path;                 /* trim left */
        char *end;
        for (end = path + strlen(path) - 1; end >= path && *end == ' '; --end)
            *end = '\0';                             /* trim right */

        void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!handle)
        {
            LOG_ERR("Failed to load plug-in '%s': %s", path, dlerror());
            token = strtok_r(NULL, ",", &saveptr);
            continue;
        }

        enricher_init_fn_t    init    = (enricher_init_fn_t)   dlsym(handle, "enricher_init");
        enricher_fn_t         enrich  = (enricher_fn_t)        dlsym(handle, "enricher_enrich");
        enricher_cleanup_fn_t cleanup = (enricher_cleanup_fn_t)dlsym(handle, "enricher_cleanup");

        if (!enrich)
        {
            LOG_ERR("Plug-in '%s' missing mandatory symbol 'enricher_enrich'", path);
            dlclose(handle);
            token = strtok_r(NULL, ",", &saveptr);
            continue;
        }

        if (!cleanup) cleanup = NULL; /* optional */

        void *ctx = NULL;
        if (init && init(&ctx) != 0)
        {
            LOG_ERR("Plug-in '%s' init failed", path);
            dlclose(handle);
            token = strtok_r(NULL, ",", &saveptr);
            continue;
        }

        enricher_t *slot = &engine.enricher[idx++];
        strncpy(slot->name, path, sizeof(slot->name) - 1);
        slot->dl_handle = handle;
        slot->enrich    = enrich;
        slot->cleanup   = cleanup;
        slot->ctx       = ctx;

        LOG_INFO("Loaded plug-in '%s'", path);
        token = strtok_r(NULL, ",", &saveptr);
    }

    free(list_dup);

    engine.n_enrichers = idx;
    LOG_INFO("Total plug-ins loaded: %zu", idx);
    return 0;
}

static void unload_plugins(void)
{
    for (size_t i = 0; i < engine.n_enrichers; ++i)
    {
        enricher_t *e = &engine.enricher[i];
        if (e->cleanup)
            e->cleanup(e->ctx);
        if (e->dl_handle)
            dlclose(e->dl_handle);
        memset(e, 0, sizeof(*e));
    }
    engine.n_enrichers = 0;
}

/* ──────────────────────────────────────────────────────────────── */
/*                         Worker Thread                           */
/* ──────────────────────────────────────────────────────────────── */

static void *worker_loop(void *arg)
{
    (void)arg; /* unused */

    /* Use cancellation-safe functions only inside while(running) */
    while (engine.running)
    {
        ps_event_t *ev = queue_pop(&engine.queue);
        if (!ev)               /* queue closed & empty */
            break;

        /* Execute chain of enrichers */
        for (size_t i = 0; i < engine.n_enrichers; ++i)
        {
            enricher_t *plug = &engine.enricher[i];
            int rc = plug->enrich(ev, plug->ctx);
            if (rc != 0)
            {
                LOG_WARN("Enricher '%s' returned %d for event %" PRIu64,
                         plug->name, rc, ev->id);
                /* optional: skip rest of chain on hard failure */
            }
        }

        /* Forward enriched event downstream */
        publisher_publish(ev);

        event_free(ev);
    }

    return NULL;
}

/* ──────────────────────────────────────────────────────────────── */
/*                     Public API —  Implementation                */
/* ──────────────────────────────────────────────────────────────── */

int enrichment_engine_init(const char *config_path)
{
    (void)config_path; /* Currently not needed — env vars are used */

    openlog("pulsesphere", LOG_PID | LOG_CONS, LOG_USER);

    /* Load plug-ins */
    const char *csv = getenv(CONFIG_ENV_PLUGINS);
    if (load_plugins(csv) != 0)
        return -1;

    /* Initialize queue */
    if (queue_init(&engine.queue, ENGINE_QUEUE_CAPACITY) != 0)
        return -1;

    /* Determine worker count */
    size_t n_threads = ENGINE_DEFAULT_THREADS;
    const char *env_threads = getenv(CONFIG_ENV_THREADS);
    if (env_threads && *env_threads)
    {
        long val = strtol(env_threads, NULL, 10);
        if (val > 0 && val < 128)
            n_threads = (size_t)val;
    }

    engine.workers   = xmalloc(sizeof(pthread_t) * n_threads);
    engine.n_workers = n_threads;
    engine.running   = true;

    /* Spawn workers */
    int err;
    for (size_t i = 0; i < n_threads; ++i)
    {
        err = pthread_create(&engine.workers[i], NULL, worker_loop, NULL);
        if (err)
        {
            LOG_ERR("Failed to create worker thread: %s", strerror(err));
            engine.running = false;
            return -1;
        }
    }

    LOG_INFO("Enrichment engine started with %zu worker threads", n_threads);
    return 0;
}

int enrichment_engine_submit(const ps_event_t *event)
{
    if (!engine.running)
        return -1;

    ps_event_t *copy = event_clone(event);
    return queue_push(&engine.queue, copy);
}

void enrichment_engine_shutdown(void)
{
    if (!engine.running)
        return;

    LOG_INFO("Shutting down enrichment engine...");

    engine.running = false;
    queue_close(&engine.queue);

    /* Join workers */
    for (size_t i = 0; i < engine.n_workers; ++i)
        pthread_join(engine.workers[i], NULL);

    /* Cleanup */
    free(engine.workers);
    queue_destroy(&engine.queue);
    unload_plugins();

    closelog();
}

/* ──────────────────────────────────────────────────────────────── */
/*                   Event Queue  —  Implementation                 */
/* ──────────────────────────────────────────────────────────────── */

static int queue_init(event_queue_t *q, size_t capacity)
{
    if (capacity < 2)
        return -1;

    q->buf  = calloc(capacity, sizeof(ps_event_t *));
    if (!q->buf)
        return -1;

    q->cap  = capacity;
    q->head = q->tail = 0;
    q->closed = false;

    pthread_mutex_init(&q->mtx, NULL);
    pthread_cond_init(&q->cv_not_full,  NULL);
    pthread_cond_init(&q->cv_not_empty, NULL);
    return 0;
}

static void queue_close(event_queue_t *q)
{
    pthread_mutex_lock(&q->mtx);
    q->closed = true;
    pthread_cond_broadcast(&q->cv_not_empty);
    pthread_cond_broadcast(&q->cv_not_full);
    pthread_mutex_unlock(&q->mtx);
}

static void queue_destroy(event_queue_t *q)
{
    /* Free any remaining events */
    for (size_t i = q->head; i != q->tail; i = (i + 1) % q->cap)
        event_free(q->buf[i]);
    free(q->buf);

    pthread_mutex_destroy(&q->mtx);
    pthread_cond_destroy(&q->cv_not_full);
    pthread_cond_destroy(&q->cv_not_empty);
}

static bool queue_full(const event_queue_t *q)
{
    return ((q->tail + 1) % q->cap) == q->head;
}

static bool queue_empty(const event_queue_t *q)
{
    return q->head == q->tail;
}

static int queue_push(event_queue_t *q, ps_event_t *ev)
{
    int rc = 0;
    pthread_mutex_lock(&q->mtx);

    while (!q->closed && queue_full(q))
        pthread_cond_wait(&q->cv_not_full, &q->mtx);

    if (q->closed)
    {
        rc = -1;
    }
    else
    {
        q->buf[q->tail] = ev;
        q->tail = (q->tail + 1) % q->cap;
        pthread_cond_signal(&q->cv_not_empty);
    }

    pthread_mutex_unlock(&q->mtx);
    return rc;
}

static ps_event_t *queue_pop(event_queue_t *q)
{
    ps_event_t *ev = NULL;
    pthread_mutex_lock(&q->mtx);

    while (!q->closed && queue_empty(q))
        pthread_cond_wait(&q->cv_not_empty, &q->mtx);

    if (!queue_empty(q))
    {
        ev = q->buf[q->head];
        q->head = (q->head + 1) % q->cap;
        pthread_cond_signal(&q->cv_not_full);
    }

    pthread_mutex_unlock(&q->mtx);
    return ev;
}
```