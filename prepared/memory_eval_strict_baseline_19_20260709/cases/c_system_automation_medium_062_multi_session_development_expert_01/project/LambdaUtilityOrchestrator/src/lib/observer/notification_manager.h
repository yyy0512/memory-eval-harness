/*
 * LambdaUtility Orchestrator
 * File: notification_manager.h
 *
 * A thread-safe Observer registry that multiplexes system-level events
 * to concrete notification back-ends (Slack, e-mail, SMS, etc.).
 *
 * The implementation is header-only: simply include this header from any
 * translation unit, but define NOTIFICATION_MANAGER_IMPLEMENTATION in
 * exactly one source file before including it, e.g.:
 *
 *      #define NOTIFICATION_MANAGER_IMPLEMENTATION
 *      #include "observer/notification_manager.h"
 *
 * When the macro is not defined, only the public API is visible.
 *
 * Author: LambdaUtility Engineering <eng@lambdautility.io>
 * License: MIT
 */

#ifndef LUO_NOTIFICATION_MANAGER_H
#define LUO_NOTIFICATION_MANAGER_H

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public Includes                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Type Declarations                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/* Severity levels follow RFC-5424 semantics. */
typedef enum {
    LUO_SEVERITY_DEBUG     = 7,
    LUO_SEVERITY_INFO      = 6,
    LUO_SEVERITY_NOTICE    = 5,
    LUO_SEVERITY_WARNING   = 4,
    LUO_SEVERITY_ERROR     = 3,
    LUO_SEVERITY_CRITICAL  = 2,
    LUO_SEVERITY_ALERT     = 1,
    LUO_SEVERITY_EMERGENCY = 0
} luo_severity_e;

/* Event propagated to observers.  Strings are NUL-terminated UTF-8. */
typedef struct {
    luo_severity_e  severity;
    const char     *subject;
    const char     *message;
    uint64_t        epoch_ms;   /* Unix time in milliseconds. */
    void           *user_data;  /* Arbitrary pointer forwarded unmodified. */
} luo_notification_event_t;

/* Observer callback prototype.  Return 0 on success, <0 on error. */
typedef int (*luo_observer_fn)(const luo_notification_event_t *event, void *ctx);

/* Observer handle.  `id` must be unique within a manager instance. */
typedef struct {
    char            id[64];      /* Stable identifier, e.g., "slack".        */
    luo_observer_fn callback;    /* Function invoked on Publish.             */
    void           *ctx;         /* Passed verbatim to `callback`.           */
} luo_notification_observer_t;

/* Opaque manager handle. */
typedef struct luo_notification_manager luo_notification_manager_t;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public API                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/* Initialize a manager instance.
 * `initial_capacity` is rounded up to at least 4.
 *
 * RETURN: 0 on success, -1 on allocation failure.
 */
int  luo_notification_manager_init(luo_notification_manager_t **out_mgr,
                                   size_t initial_capacity);

/* Release all resources held by `mgr`.  Safe to pass NULL. */
void luo_notification_manager_destroy(luo_notification_manager_t *mgr);

/* Register a new observer.  Existing ID => -2 (EEXIST).
 * RETURN: 0 on success, -1 on allocation or parameter error, -2 on duplicate.
 */
int  luo_notification_manager_subscribe(luo_notification_manager_t      *mgr,
                                        const luo_notification_observer_t *observer);

/* Deregister observer by ID.  RETURN: 0 on success, -1 if not found. */
int  luo_notification_manager_unsubscribe(luo_notification_manager_t *mgr,
                                          const char *observer_id);

/* Broadcast an event to all observers.
 * RETURN: number of observers notified, or -1 on error.
 */
int  luo_notification_manager_publish(luo_notification_manager_t       *mgr,
                                      const luo_notification_event_t   *event);

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Inline Helpers (header-only utilities, no state)                         */
/* ────────────────────────────────────────────────────────────────────────── */

static inline uint64_t
luo_epoch_ms_now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000ULL + (ts.tv_nsec / 1000000ULL);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Implementation Section (optional)                                        */
/* ────────────────────────────────────────────────────────────────────────── */

#ifdef NOTIFICATION_MANAGER_IMPLEMENTATION
/*                                                                   *
 *               DO NOT INCLUDE THIS BLOCK IN MORE                   *
 *         THAN ONE TRANSLATION UNIT OF THE FINAL PROGRAM.           *
 *                                                                   */
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>

/* Internal representation. */
struct luo_notification_manager {
    pthread_mutex_t                mtx;
    luo_notification_observer_t   *observers;
    size_t                         size;
    size_t                         capacity;
};

/* -- Private helpers ----------------------------------------------------- */

#define LUO_MIN_CAPACITY 4

static int
luo__grow_observer_array(luo_notification_manager_t *mgr, size_t min_capacity)
{
    size_t new_cap = mgr->capacity ? mgr->capacity : LUO_MIN_CAPACITY;
    while (new_cap < min_capacity)
        new_cap <<= 1; /* geometric growth */

    void *tmp = realloc(mgr->observers, new_cap * sizeof *mgr->observers);
    if (!tmp)
        return -1;

    mgr->observers = tmp;
    mgr->capacity  = new_cap;
    return 0;
}

static ssize_t
luo__find_observer_idx(luo_notification_manager_t *mgr, const char *id)
{
    for (size_t i = 0; i < mgr->size; ++i)
        if (strncmp(mgr->observers[i].id, id, sizeof mgr->observers[i].id) == 0)
            return (ssize_t)i;
    return -1;
}

/* -- Public-API implementations ----------------------------------------- */

int
luo_notification_manager_init(luo_notification_manager_t **out_mgr,
                              size_t initial_capacity)
{
    if (!out_mgr)
        return -1;

    luo_notification_manager_t *mgr = calloc(1, sizeof *mgr);
    if (!mgr)
        return -1;

    if (pthread_mutex_init(&mgr->mtx, NULL) != 0) {
        free(mgr);
        return -1;
    }

    mgr->capacity = 0;
    mgr->size     = 0;
    mgr->observers = NULL;

    /* Pre-allocate if requested. */
    if (initial_capacity < LUO_MIN_CAPACITY)
        initial_capacity = LUO_MIN_CAPACITY;

    if (luo__grow_observer_array(mgr, initial_capacity) != 0) {
        pthread_mutex_destroy(&mgr->mtx);
        free(mgr);
        return -1;
    }

    *out_mgr = mgr;
    return 0;
}

void
luo_notification_manager_destroy(luo_notification_manager_t *mgr)
{
    if (!mgr)
        return;

    pthread_mutex_lock(&mgr->mtx);
    free(mgr->observers);
    mgr->observers = NULL;
    mgr->size      = 0;
    mgr->capacity  = 0;
    pthread_mutex_unlock(&mgr->mtx);

    pthread_mutex_destroy(&mgr->mtx);
    free(mgr);
}

int
luo_notification_manager_subscribe(luo_notification_manager_t      *mgr,
                                   const luo_notification_observer_t *observer)
{
    if (!mgr || !observer || !observer->callback || observer->id[0] == '\0')
        return -1;

    int rc = 0;
    pthread_mutex_lock(&mgr->mtx);

    if (luo__find_observer_idx(mgr, observer->id) >= 0) {
        rc = -2; /* duplicate */
        goto exit;
    }

    if (mgr->size == mgr->capacity && luo__grow_observer_array(mgr, mgr->size + 1) != 0) {
        rc = -1;
        goto exit;
    }

    mgr->observers[mgr->size++] = *observer;

exit:
    pthread_mutex_unlock(&mgr->mtx);
    return rc;
}

int
luo_notification_manager_unsubscribe(luo_notification_manager_t *mgr,
                                     const char *observer_id)
{
    if (!mgr || !observer_id || observer_id[0] == '\0')
        return -1;

    int rc = 0;
    pthread_mutex_lock(&mgr->mtx);

    ssize_t idx = luo__find_observer_idx(mgr, observer_id);
    if (idx < 0) {
        rc = -1;
        goto exit;
    }

    /* Replace removed element with last to keep array dense. */
    mgr->observers[idx] = mgr->observers[--mgr->size];

exit:
    pthread_mutex_unlock(&mgr->mtx);
    return rc;
}

int
luo_notification_manager_publish(luo_notification_manager_t       *mgr,
                                 const luo_notification_event_t   *event)
{
    if (!mgr || !event)
        return -1;

    /* Snapshot the observer list to minimize lock duration. */
    luo_notification_observer_t *snapshot = NULL;
    size_t                       snap_sz  = 0;

    pthread_mutex_lock(&mgr->mtx);
    if (mgr->size > 0) {
        snapshot = malloc(mgr->size * sizeof *snapshot);
        if (!snapshot) {
            pthread_mutex_unlock(&mgr->mtx);
            return -1;
        }
        memcpy(snapshot, mgr->observers, mgr->size * sizeof *snapshot);
        snap_sz = mgr->size;
    }
    pthread_mutex_unlock(&mgr->mtx);

    int notified = 0;
    for (size_t i = 0; i < snap_sz; ++i) {
        int cb_rc = snapshot[i].callback(event, snapshot[i].ctx);
        if (cb_rc >= 0)
            ++notified;
        else
            /* In production we would log this failure path. */
            (void)cb_rc;
    }

    free(snapshot);
    return notified;
}

#endif /* NOTIFICATION_MANAGER_IMPLEMENTATION */
#endif /* LUO_NOTIFICATION_MANAGER_H */
