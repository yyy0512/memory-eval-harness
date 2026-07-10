/*
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * File:    pulsesphere/services/analytics_sink_service/include/batch_manager.h
 * Author:  PulseSphere Core Team
 *
 * Copyright (c) 2023-2024 PulseSphere.
 *
 * Description:
 *   Thread-safe batching utility that collects validated pulse events and
 *   forwards them to downstream analytics sinks in configurable windows.
 *   The manager supports back-pressure, size/time-based rotation, metrics
 *   introspection, and graceful shutdown semantics.
 *
 *   This header is self-contained: include it wherever you need the public
 *   interface.  Define BATCH_MANAGER_IMPLEMENTATION in *exactly one*
 *   translation unit *before* including this file to obtain the full
 *   implementation.
 */

#pragma once

/* ────────────────────────────────────────────────────────────
 *  System / Standard Headers
 * ──────────────────────────────────────────────────────────── */
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>

/* Forward declaration of the canonical PulseSphere event. */
typedef struct ps_event_t ps_event_t;

/* ────────────────────────────────────────────────────────────
 *  Constant & Macro Definitions
 * ──────────────────────────────────────────────────────────── */
#define PS_BATCH_MGR_VERSION     "1.0.0"
#define PS_BATCH_MGR_MAX_NAME    64

/* Compile-time safety: C11, POSIX Threads are required. */
#if !defined(__STDC_VERSION__) || (__STDC_VERSION__ < 201112L)
#   error "The Batch Manager requires at least C11."
#endif

/* ────────────────────────────────────────────────────────────
 *  Enumerations
 * ──────────────────────────────────────────────────────────── */
typedef enum {
    PS_BATCH_OK           = 0,   /* Success */
    PS_BATCH_EINVAL       = 1,   /* Invalid parameter */
    PS_BATCH_ENOMEM       = 2,   /* Allocation failure */
    PS_BATCH_EBUSY        = 3,   /* Manager already running */
    PS_BATCH_ESTATE       = 4,   /* Invalid state transition */
    PS_BATCH_EINTERNAL    = 5    /* Unexpected internal error */
} ps_batch_err_t;

/* ────────────────────────────────────────────────────────────
 *  Metrics & Stats
 * ──────────────────────────────────────────────────────────── */
typedef struct {
    uint64_t batches_flushed;    /* Total # of batches sent to sink.   */
    uint64_t events_flushed;     /* Total # of events flushed.         */
    uint64_t events_dropped;     /* Events dropped due to back-pressure*/
    uint64_t mem_bytes_alloc;    /* Bytes allocated for internal buf.  */
} ps_batch_metrics_t;

/* ────────────────────────────────────────────────────────────
 *  Sink Callback Prototype
 * ────────────────────────────────────────────────────────────
 *  @events      Array of const* ps_event_t   (length = event_count)
 *  @event_count Number of elements in events
 *  @user_data   Opaque pointer from config
 *
 *  The callee *must* guarantee that it either frees each event or
 *  transfers ownership elsewhere.  The array itself is ephemeral and
 *  will be invalid after the callback returns.
 */
typedef void (*ps_batch_sink_fn)(
        const ps_event_t *const *events,
        size_t                   event_count,
        void                    *user_data);

/* ────────────────────────────────────────────────────────────
 *  Configuration
 * ──────────────────────────────────────────────────────────── */
typedef struct {
    char              name[PS_BATCH_MGR_MAX_NAME]; /* Optional identifier        */

    /* Rotation policy */
    size_t            max_events;    /* Flush after this many events.  (0 = disable) */
    size_t            max_bytes;     /* Flush after total payload > X. (0 = disable) */
    uint32_t          flush_interval_ms; /* Flush after interval elapsed. (0 = disable) */

    /* Back-pressure: maximum # pending events before add() fails.  0 = unbounded. */
    size_t            max_pending_events;

    /* Callback invoked when a batch is ready. */
    ps_batch_sink_fn  sink_cb;
    void             *sink_cb_user_data;

    /* Optional metrics collection */
    bool              enable_metrics;
} ps_batch_cfg_t;


/* ────────────────────────────────────────────────────────────
 *  Opaque Manager Handle
 * ──────────────────────────────────────────────────────────── */
typedef struct ps_batch_manager ps_batch_manager_t;


/* ────────────────────────────────────────────────────────────
 *  Public API
 * ──────────────────────────────────────────────────────────── */

/* Create a new batch manager instance.
 * Returns NULL on failure; *err_out is set accordingly (may be NULL). */
ps_batch_manager_t *
ps_batch_manager_create(const ps_batch_cfg_t *cfg, ps_batch_err_t *err_out);

/* Start internal timer/flush thread(s). Safe to call multiple times.
 * Returns PS_BATCH_OK on success. */
ps_batch_err_t
ps_batch_manager_start(ps_batch_manager_t *mgr);

/* Stop the manager and flush any remaining events synchronously.
 * After stop, the instance can be started again. */
ps_batch_err_t
ps_batch_manager_stop(ps_batch_manager_t *mgr);

/* Destroy the manager and free all resources.
 * After destruction, the handle is invalid. */
void
ps_batch_manager_destroy(ps_batch_manager_t *mgr);

/* Add an event to the current batch.
 * Ownership of `evt` transfers to the manager on success.
 * Returns non-zero ps_batch_err_t on error. */
ps_batch_err_t
ps_batch_manager_add_event(ps_batch_manager_t *mgr, const ps_event_t *evt, size_t approx_evt_size);

/* Retrieve latest metrics snapshot into `out`. Returns PS_BATCH_OK or error. */
ps_batch_err_t
ps_batch_manager_get_metrics(const ps_batch_manager_t *mgr, ps_batch_metrics_t *out);

/* Convenience: Get number of events currently waiting in buffer.
 * Primarily intended for observability. */
size_t
ps_batch_manager_pending_events(const ps_batch_manager_t *mgr);


/* ────────────────────────────────────────────────────────────
 *  Optional Inline Helpers
 * ──────────────────────────────────────────────────────────── */
static inline bool
ps_batch_manager_is_valid(const ps_batch_manager_t *mgr) {
    return mgr != NULL;
}


/* ────────────────────────────────────────────────────────────
 *  Implementation
 * ──────────────────────────────────────────────────────────── */
#ifdef BATCH_MANAGER_IMPLEMENTATION
/* The remainder of this file provides the full implementation when
 * BATCH_MANAGER_IMPLEMENTATION is defined *before* inclusion.      */

#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <errno.h>
#include <sys/time.h>

/* Internal batch manager object */
struct ps_batch_manager {
    ps_batch_cfg_t   cfg;

    /* Dynamic buffer of pending events */
    ps_event_t     **buffer;
    size_t           capacity;      /* == cfg.max_pending_events or cfg.max_events */
    size_t           count;         /* # currently stored events */
    size_t           bytes;         /* Approximate bytes currently stored */

    /* Synchronisation */
    pthread_mutex_t  mtx;
    pthread_cond_t   cv;
    bool             running;
    pthread_t        thread;

    /* Metrics */
    ps_batch_metrics_t metrics;
};


/* ────────────────────────────────────────────────────────────
 *  Helper – current time in milliseconds (monotonic)
 * ──────────────────────────────────────────────────────────── */
static uint64_t _ps_now_ms(void)
{
    struct timespec ts;
#if defined(CLOCK_MONOTONIC_RAW)
    clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
#else
    clock_gettime(CLOCK_MONOTONIC, &ts);
#endif
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)ts.tv_nsec / 1000000ULL;
}

/* ────────────────────────────────────────────────────────────
 *  Forward declarations
 * ──────────────────────────────────────────────────────────── */
static void *_ps_batch_thread(void *arg);
static void  _ps_internal_flush(ps_batch_manager_t *mgr);

/* ────────────────────────────────────────────────────────────
 *  Validation Helpers
 * ──────────────────────────────────────────────────────────── */
static bool _cfg_is_valid(const ps_batch_cfg_t *cfg, ps_batch_err_t *err)
{
    if (!cfg || !cfg->sink_cb) {
        if (err) *err = PS_BATCH_EINVAL;
        return false;
    }
    if (cfg->max_events == 0 && cfg->max_bytes == 0 && cfg->flush_interval_ms == 0) {
        if (err) *err = PS_BATCH_EINVAL;
        return false; /* At least one rotation policy must be set */
    }
    if (cfg->max_pending_events && cfg->max_pending_events < cfg->max_events) {
        if (err) *err = PS_BATCH_EINVAL;
        return false; /* pending limit cannot be less than batch size */
    }
    return true;
}

/* ────────────────────────────────────────────────────────────
 *  Public – Create
 * ──────────────────────────────────────────────────────────── */
ps_batch_manager_t *
ps_batch_manager_create(const ps_batch_cfg_t *cfg, ps_batch_err_t *err_out)
{
    ps_batch_err_t err = PS_BATCH_OK;
    if (!_cfg_is_valid(cfg, &err)) {
        if (err_out) *err_out = err;
        return NULL;
    }

    ps_batch_manager_t *mgr = calloc(1, sizeof(*mgr));
    if (!mgr) {
        if (err_out) *err_out = PS_BATCH_ENOMEM;
        return NULL;
    }
    mgr->cfg = *cfg; /* Shallow copy */

    /* Determine capacity: prefer explicit pending limit, else batch size, else unlimited */
    mgr->capacity = (cfg->max_pending_events ? cfg->max_pending_events :
                    (cfg->max_events ? cfg->max_events : 1024));
    mgr->buffer = calloc(mgr->capacity, sizeof(ps_event_t *));
    if (!mgr->buffer) {
        free(mgr);
        if (err_out) *err_out = PS_BATCH_ENOMEM;
        return NULL;
    }
    mgr->metrics.mem_bytes_alloc = mgr->capacity * sizeof(ps_event_t *);
    pthread_mutex_init(&mgr->mtx, NULL);
    pthread_cond_init(&mgr->cv, NULL);

    if (err_out) *err_out = PS_BATCH_OK;
    return mgr;
}

/* ────────────────────────────────────────────────────────────
 *  Public – Destroy
 * ──────────────────────────────────────────────────────────── */
void
ps_batch_manager_destroy(ps_batch_manager_t *mgr)
{
    if (!mgr) return;

    ps_batch_manager_stop(mgr);

    /* Free any lingering events to avoid leaks.  We do not know the
     * concrete ps_event_t layout here; delegate to user sink with NULL. */
    if (mgr->count && mgr->cfg.sink_cb) {
        mgr->cfg.sink_cb((const ps_event_t *const *)mgr->buffer,
                         mgr->count, mgr->cfg.sink_cb_user_data);
    }

    free(mgr->buffer);
    pthread_mutex_destroy(&mgr->mtx);
    pthread_cond_destroy(&mgr->cv);
    free(mgr);
}

/* ────────────────────────────────────────────────────────────
 *  Public – Start
 * ──────────────────────────────────────────────────────────── */
ps_batch_err_t
ps_batch_manager_start(ps_batch_manager_t *mgr)
{
    if (!mgr) return PS_BATCH_EINVAL;

    pthread_mutex_lock(&mgr->mtx);
    if (mgr->running) {
        pthread_mutex_unlock(&mgr->mtx);
        return PS_BATCH_EBUSY;
    }
    mgr->running = true;
    if (pthread_create(&mgr->thread, NULL, _ps_batch_thread, mgr) != 0) {
        mgr->running = false;
        pthread_mutex_unlock(&mgr->mtx);
        return PS_BATCH_EINTERNAL;
    }
    pthread_mutex_unlock(&mgr->mtx);
    return PS_BATCH_OK;
}

/* ────────────────────────────────────────────────────────────
 *  Public – Stop
 * ──────────────────────────────────────────────────────────── */
ps_batch_err_t
ps_batch_manager_stop(ps_batch_manager_t *mgr)
{
    if (!mgr) return PS_BATCH_EINVAL;

    pthread_mutex_lock(&mgr->mtx);
    if (!mgr->running) {
        pthread_mutex_unlock(&mgr->mtx);
        return PS_BATCH_ESTATE;
    }
    mgr->running = false;
    pthread_cond_signal(&mgr->cv);
    pthread_mutex_unlock(&mgr->mtx);

    pthread_join(mgr->thread, NULL);

    /* Ensure final flush */
    pthread_mutex_lock(&mgr->mtx);
    _ps_internal_flush(mgr);
    pthread_mutex_unlock(&mgr->mtx);
    return PS_BATCH_OK;
}

/* ────────────────────────────────────────────────────────────
 *  Public – Add Event
 * ──────────────────────────────────────────────────────────── */
ps_batch_err_t
ps_batch_manager_add_event(ps_batch_manager_t *mgr,
                           const ps_event_t   *evt,
                           size_t              approx_evt_size)
{
    if (!mgr || !evt) return PS_BATCH_EINVAL;

    pthread_mutex_lock(&mgr->mtx);

    /* Back-pressure limit */
    if (mgr->capacity && mgr->count >= mgr->capacity) {
        mgr->metrics.events_dropped++;
        pthread_mutex_unlock(&mgr->mtx);
        return PS_BATCH_EBUSY;
    }

    /* Grow buffer if unlimited and needed */
    if (mgr->count >= mgr->capacity) {
        size_t new_cap = mgr->capacity * 2;
        ps_event_t **newbuf = realloc(mgr->buffer, new_cap * sizeof(ps_event_t *));
        if (!newbuf) {
            mgr->metrics.events_dropped++;
            pthread_mutex_unlock(&mgr->mtx);
            return PS_BATCH_ENOMEM;
        }
        mgr->buffer = newbuf;
        mgr->capacity = new_cap;
        mgr->metrics.mem_bytes_alloc = mgr->capacity * sizeof(ps_event_t *);
    }

    /* Store event */
    mgr->buffer[mgr->count++] = (ps_event_t *)evt; /* cast away const for storage */
    mgr->bytes += approx_evt_size;

    /* Check rotation policy */
    bool trigger = false;
    if (mgr->cfg.max_events && mgr->count >= mgr->cfg.max_events) trigger = true;
    else if (mgr->cfg.max_bytes && mgr->bytes >= mgr->cfg.max_bytes) trigger = true;

    if (trigger) _ps_internal_flush(mgr);

    pthread_mutex_unlock(&mgr->mtx);
    return PS_BATCH_OK;
}

/* ────────────────────────────────────────────────────────────
 *  Public – Get Metrics
 * ──────────────────────────────────────────────────────────── */
ps_batch_err_t
ps_batch_manager_get_metrics(const ps_batch_manager_t *mgr,
                             ps_batch_metrics_t       *out)
{
    if (!mgr || !out) return PS_BATCH_EINVAL;
    pthread_mutex_lock((pthread_mutex_t *)&mgr->mtx); /* cast to discard const */
    *out = mgr->metrics;
    pthread_mutex_unlock((pthread_mutex_t *)&mgr->mtx);
    return PS_BATCH_OK;
}

size_t
ps_batch_manager_pending_events(const ps_batch_manager_t *mgr)
{
    if (!mgr) return 0;
    pthread_mutex_lock((pthread_mutex_t *)&mgr->mtx);
    size_t cnt = mgr->count;
    pthread_mutex_unlock((pthread_mutex_t *)&mgr->mtx);
    return cnt;
}

/* ────────────────────────────────────────────────────────────
 *  Internal – Flush helper
 * ──────────────────────────────────────────────────────────── */
static void _ps_internal_flush(ps_batch_manager_t *mgr)
{
    if (mgr->count == 0) return;

    /* Snapshot current batch */
    size_t   n     = mgr->count;
    ps_event_t **evts = malloc(n * sizeof(ps_event_t *));
    if (!evts) {
        /* Allocation failure – drop events */
        mgr->metrics.events_dropped += n;
        mgr->count = 0;
        mgr->bytes = 0;
        return;
    }
    memcpy(evts, mgr->buffer, n * sizeof(ps_event_t *));
    mgr->count = 0;
    mgr->bytes = 0;

    pthread_mutex_unlock(&mgr->mtx); /* Release lock before user callback */

    /* Invoke sink */
    mgr->cfg.sink_cb((const ps_event_t *const *)evts, n, mgr->cfg.sink_cb_user_data);

    pthread_mutex_lock(&mgr->mtx); /* Reacquire */

    mgr->metrics.batches_flushed++;
    mgr->metrics.events_flushed += n;
    free(evts);
}

/* ────────────────────────────────────────────────────────────
 *  Internal – Timer Thread
 * ──────────────────────────────────────────────────────────── */
static void *_ps_batch_thread(void *arg)
{
    ps_batch_manager_t *mgr = arg;
    uint64_t last_flush = _ps_now_ms();

    pthread_mutex_lock(&mgr->mtx);
    for (;;) {
        uint32_t interval = mgr->cfg.flush_interval_ms;
        if (!mgr->running) break;

        if (interval == 0) {
            /* Wait indefinitely until signalled */
            pthread_cond_wait(&mgr->cv, &mgr->mtx);
        } else {
            uint64_t now = _ps_now_ms();
            uint64_t elapsed = now - last_flush;
            if (elapsed >= interval) {
                _ps_internal_flush(mgr);
                last_flush = now;
            }

            struct timespec ts;
            uint64_t wait_ms = interval - (elapsed % interval);
            ts.tv_sec  = wait_ms / 1000;
            ts.tv_nsec = (wait_ms % 1000) * 1000000ULL;
            pthread_cond_timedwait(&mgr->cv, &mgr->mtx, &ts);
        }
    }
    pthread_mutex_unlock(&mgr->mtx);
    return NULL;
}

#endif /* BATCH_MANAGER_IMPLEMENTATION */
