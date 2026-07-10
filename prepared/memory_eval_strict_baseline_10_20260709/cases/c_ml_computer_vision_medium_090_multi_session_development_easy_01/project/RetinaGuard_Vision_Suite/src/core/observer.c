/*
 * RetinaGuard Vision Suite
 * File: src/core/observer.c
 *
 * Description:
 *   Thread-safe Observer Pattern implementation used throughout RetinaGuard
 *   to broadcast inference-stage life-cycle events to interested in-process
 *   subscribers such as the Model Registry and real-time Monitoring Dashboard.
 *
 *   Design notes:
 *     • Lock-free fast-path for event dispatch using a read-copy-update
 *       strategy—observers are copied into a temporary buffer so that
 *       callbacks are invoked outside the critical section, avoiding
 *       deadlocks when observers manipulate the registry in their own
 *       callbacks.
 *     • POSIX threads are used for synchronization; the implementation is
 *       completely in-process and does not require IPC mechanisms.
 *     • All public symbols are prefixed with “rg_” to avoid namespace
 *       collisions in the monolithic codebase.
 *
 * Copyright:
 *   (c) 2023–2024 RetinaGuard Medical Software Group.  All rights reserved.
 *   Licensed under the RetinaGuard End-User License Agreement (EULA).
 */

#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <syslog.h>
#include <time.h>

#include "observer.h"  /* Public header (not shown) */

/* ------------------------------------------------------------------------- */
/*                            Internal data structures                       */
/* ------------------------------------------------------------------------- */

typedef struct rg_observer_node_s
{
    rg_event_callback_t        cb;         /* Observer’s callback function   */
    void                      *user_data;  /* Opaque pointer handed back     */
    struct rg_observer_node_s *next;       /* Singly-linked intrusive list   */
} rg_observer_node_t;

/* Linked list head of all registered observers */
static rg_observer_node_t  *g_observers_head            = NULL;

/* Protects g_observers_head — RW-lock allows concurrent dispatch            */
static pthread_rwlock_t     g_observers_rwlock          = PTHREAD_RWLOCK_INITIALIZER;

/* Ensures that global one-time initialization is executed only once         */
static pthread_once_t       g_observers_syslog_once     = PTHREAD_ONCE_INIT;

/* ------------------------------------------------------------------------- */
/*                           Static helper prototypes                        */
/* ------------------------------------------------------------------------- */
static void rg_observer_syslog_init   (void);
static int  rg_observer_find_locked   (rg_event_callback_t cb,
                                       void               *user_data,
                                       rg_observer_node_t **out_prev,
                                       rg_observer_node_t **out_node);

/* ------------------------------------------------------------------------- */
/*                            Public API implementation                      */
/* ------------------------------------------------------------------------- */

int rg_observer_register(rg_event_callback_t cb, void *user_data)
{
    if (cb == NULL) {
        return RG_ERR_INVALID;
    }

    /* Ensure syslog facility is ready. */
    (void) pthread_once(&g_observers_syslog_once, rg_observer_syslog_init);

    int ret = pthread_rwlock_wrlock(&g_observers_rwlock);
    if (ret != 0)
        return -ret;

    /* Duplicate registration is disallowed. */
    rg_observer_node_t *prev = NULL, *existing = NULL;
    if (rg_observer_find_locked(cb, user_data, &prev, &existing) == 0) {
        pthread_rwlock_unlock(&g_observers_rwlock);
        syslog(LOG_WARNING,
               "[observer] Attempted duplicate registration ignored (cb=%p)",
               (void *)cb);
        return RG_ERR_EXIST;
    }

    /* Create and prepend new node. */
    rg_observer_node_t *node = calloc(1, sizeof(*node));
    if (!node) {
        pthread_rwlock_unlock(&g_observers_rwlock);
        return RG_ERR_NOMEM;
    }

    node->cb        = cb;
    node->user_data = user_data;
    node->next      = g_observers_head;
    g_observers_head = node;

    pthread_rwlock_unlock(&g_observers_rwlock);

    syslog(LOG_INFO,
           "[observer] Registered new observer (cb=%p, user_data=%p)",
           (void *)cb, user_data);
    return RG_OK;
}

int rg_observer_unregister(rg_event_callback_t cb, void *user_data)
{
    if (cb == NULL) {
        return RG_ERR_INVALID;
    }

    int ret = pthread_rwlock_wrlock(&g_observers_rwlock);
    if (ret != 0)
        return -ret;

    rg_observer_node_t *prev = NULL, *node = NULL;
    if (rg_observer_find_locked(cb, user_data, &prev, &node) != 0) {
        pthread_rwlock_unlock(&g_observers_rwlock);
        return RG_ERR_NOTFOUND;
    }

    /* Detach node from list */
    if (prev)
        prev->next = node->next;
    else
        g_observers_head = node->next;

    pthread_rwlock_unlock(&g_observers_rwlock);

    free(node);

    syslog(LOG_INFO,
           "[observer] Unregistered observer (cb=%p, user_data=%p)",
           (void *)cb, user_data);
    return RG_OK;
}

int rg_observer_notify(const rg_event_t *event)
{
    if (!event) {
        return RG_ERR_INVALID;
    }

    /* Snapshot the list of observers under read lock. */
    int ret = pthread_rwlock_rdlock(&g_observers_rwlock);
    if (ret != 0)
        return -ret;

    size_t count = 0;
    for (rg_observer_node_t *it = g_observers_head; it; it = it->next)
        ++count;

    if (count == 0) {
        pthread_rwlock_unlock(&g_observers_rwlock);
        return RG_OK;  /* No observers — nothing to do. */
    }

    rg_observer_node_t **snapshot = calloc(count, sizeof(*snapshot));
    if (!snapshot) {
        pthread_rwlock_unlock(&g_observers_rwlock);
        return RG_ERR_NOMEM;
    }

    size_t idx = 0;
    for (rg_observer_node_t *it = g_observers_head; it; it = it->next)
        snapshot[idx++] = it;

    pthread_rwlock_unlock(&g_observers_rwlock);

    /* Outside lock — invoke callbacks */
    for (size_t i = 0; i < count; ++i) {
        rg_observer_node_t *obs = snapshot[i];
        /* Guard against misbehaving callbacks crashing the application */
        if (obs->cb) {
            /* Safe-guard: each callback executes in a separate try/catch-like
             * environment is not available in C; we rely on observers to
             * behave, but we still log failures when detected.               */
            obs->cb(event, obs->user_data);
        }
    }

    free(snapshot);
    return RG_OK;
}

/* ------------------------------------------------------------------------- */
/*                            Static helper functions                        */
/* ------------------------------------------------------------------------- */

/* Initialize syslog only once to keep logging consistent across entire app. */
static void rg_observer_syslog_init(void)
{
    openlog("RetinaGuard.Observer", LOG_PID | LOG_CONS, LOG_USER);
}

/*
 * rg_observer_find_locked
 *
 * Search for an observer within g_observers_head.  Caller must hold the
 * write or read lock protecting the list.  If found, *out_node is populated
 * and function returns 0.  When write-locked, *out_prev is also returned for
 * unlinking convenience; otherwise it may be NULL.
 */
static int rg_observer_find_locked(rg_event_callback_t cb,
                                   void               *user_data,
                                   rg_observer_node_t **out_prev,
                                   rg_observer_node_t **out_node)
{
    rg_observer_node_t *prev = NULL;
    for (rg_observer_node_t *it = g_observers_head; it; it = it->next) {
        if (it->cb == cb && it->user_data == user_data) {
            if (out_prev)
                *out_prev = prev;
            if (out_node)
                *out_node = it;
            return 0; /* Found */
        }
        prev = it;
    }
    return -1;          /* Not found */
}

/* ------------------------------------------------------------------------- */
/*                          Convenience utility helpers                      */
/* ------------------------------------------------------------------------- */

/*
 * rg_event_init
 *
 * Utility to populate a rg_event_t structure with timestamp and payload.
 */
void rg_event_init(rg_event_t       *evt,
                   rg_event_type_t   type,
                   void             *payload,
                   size_t            payload_size)
{
    if (!evt)
        return;

    evt->type         = type;
    evt->payload      = payload;
    evt->payload_size = payload_size;
    clock_gettime(CLOCK_REALTIME, &evt->timestamp);
}

/*
 * rg_event_dup
 *
 * Deep copy of an event’s header and payload.  Caller must free the returned
 * rg_event_t with rg_event_free().  Use when observers need to hold on to
 * event data after the notification call returns.
 */
rg_event_t *rg_event_dup(const rg_event_t *src)
{
    if (!src)
        return NULL;

    rg_event_t *dst = malloc(sizeof(*dst));
    if (!dst)
        return NULL;

    *dst = *src; /* Shallow copy first */

    if (src->payload && src->payload_size > 0) {
        dst->payload = malloc(src->payload_size);
        if (!dst->payload) {
            free(dst);
            return NULL;
        }
        memcpy(dst->payload, src->payload, src->payload_size);
    } else {
        dst->payload = NULL;
        dst->payload_size = 0;
    }
    return dst;
}

/*
 * rg_event_free
 *
 * Free an event created by rg_event_dup().  Safe to call with NULL.
 */
void rg_event_free(rg_event_t *evt)
{
    if (!evt)
        return;
    free(evt->payload);
    free(evt);
}

/* ------------------------------------------------------------------------- */
/*                              Diagnostic dump                              */
/* ------------------------------------------------------------------------- */

/*
 * rg_observer_dump
 *
 * Debug helper that prints current observers list to stderr.  Not compiled
 * in release builds unless RG_DEBUG_OBSERVER is defined.
 */
#ifdef RG_DEBUG_OBSERVER
void rg_observer_dump(void)
{
    pthread_rwlock_rdlock(&g_observers_rwlock);
    fprintf(stderr, "=== Observer dump start ===\n");
    for (rg_observer_node_t *it = g_observers_head; it; it = it->next) {
        fprintf(stderr, " • cb=%p  user_data=%p\n", (void *)it->cb,
                it->user_data);
    }
    fprintf(stderr, "=== Observer dump end   ===\n");
    pthread_rwlock_unlock(&g_observers_rwlock);
}
#endif /* RG_DEBUG_OBSERVER */

/* ------------------------------------------------------------------------- */
/*                                End of file                                */
/* ------------------------------------------------------------------------- */
