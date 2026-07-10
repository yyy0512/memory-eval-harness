/*
 * LambdaUtility Orchestrator
 * File: src/lib/observer/notification_manager.c
 *
 * An implementation of an Observer pattern dispatcher that multiplexes
 * NotificationEvent objects to a dynamic set of Notifier observers
 * (Slack, email, SMS, etc.).  The manager is designed to be re-entrant,
 * thread-safe, and allocation-fail–tolerant, making it suitable for
 * short-lived serverless invocations as well as longer batch workflows.
 *
 * Copyright (c) 2024  LambdaUtility
 */

#include "notification_manager.h"      /* public interface */
#include "logger.h"                    /* lightweight structured logging */
#include "error_codes.h"               /* shared error-code contract      */

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

/* --------------------------------------------------------------------------
 * Private helpers & internal definitions
 * --------------------------------------------------------------------------*/

/* initial observer array size; grows geometrically */
#define LU_OBSERVER_DEFAULT_CAP 4U
/* growth factor when capacity is exhausted            */
#define LU_OBSERVER_GROWTH_FACTOR 2U

static int realloc_observer_array(NotificationManager *mgr, size_t new_capacity);

/* Checks whether two notifier pointers are identical. */
static inline int equals_notifier(const Notifier *a, const Notifier *b)
{
    return a == b;
}

/* --------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------*/

int notification_manager_init(NotificationManager *mgr, const char *name)
{
    if (mgr == NULL) {
        LU_LOG_ERROR("[NotificationManager] init failed: mgr==NULL");
        return LU_ERR_INVALID_ARG;
    }

    memset(mgr, 0, sizeof(*mgr));

    mgr->observers = calloc(LU_OBSERVER_DEFAULT_CAP, sizeof(Notifier *));
    if (mgr->observers == NULL) {
        LU_LOG_ERROR("[NotificationManager] init failed: calloc: %s", strerror(errno));
        return LU_ERR_ALLOC;
    }

    mgr->capacity = LU_OBSERVER_DEFAULT_CAP;
    mgr->name = name ? strdup(name) : NULL;

    if (pthread_mutex_init(&mgr->lock, NULL) != 0) {
        LU_LOG_ERROR("[NotificationManager] mutex init failed");
        free(mgr->observers);
        free(mgr->name);
        return LU_ERR_MUTEX;
    }

    LU_LOG_DEBUG("[NotificationManager] \"%s\" initialized with cap=%zu",
                 mgr->name ? mgr->name : "(anon)", mgr->capacity);

    return LU_SUCCESS;
}

int notification_manager_register(NotificationManager *mgr, Notifier *observer)
{
    if (mgr == NULL || observer == NULL) {
        return LU_ERR_INVALID_ARG;
    }

    int rc = pthread_mutex_lock(&mgr->lock);
    if (rc != 0) {
        LU_LOG_ERROR("[NotificationManager] register: mutex lock failed");
        return LU_ERR_MUTEX;
    }

    /* Prevent duplicate registrations. */
    for (size_t i = 0; i < mgr->count; ++i) {
        if (equals_notifier(mgr->observers[i], observer)) {
            pthread_mutex_unlock(&mgr->lock);
            return LU_SUCCESS; /* already registered */
        }
    }

    /* Resize if necessary */
    if (mgr->count == mgr->capacity) {
        size_t new_capacity = mgr->capacity * LU_OBSERVER_GROWTH_FACTOR;
        rc = realloc_observer_array(mgr, new_capacity);
        if (rc != LU_SUCCESS) {
            pthread_mutex_unlock(&mgr->lock);
            return rc;
        }
    }

    mgr->observers[mgr->count++] = observer;

    LU_LOG_INFO("[NotificationManager] registered observer=%s (total=%zu)",
                observer->name ? observer->name : "(unnamed)", mgr->count);

    pthread_mutex_unlock(&mgr->lock);
    return LU_SUCCESS;
}

int notification_manager_unregister(NotificationManager *mgr, Notifier *observer)
{
    if (mgr == NULL || observer == NULL) {
        return LU_ERR_INVALID_ARG;
    }

    int rc = pthread_mutex_lock(&mgr->lock);
    if (rc != 0) {
        LU_LOG_ERROR("[NotificationManager] unregister: mutex lock failed");
        return LU_ERR_MUTEX;
    }

    size_t idx = SIZE_MAX;
    for (size_t i = 0; i < mgr->count; ++i) {
        if (equals_notifier(mgr->observers[i], observer)) {
            idx = i;
            break;
        }
    }

    if (idx == SIZE_MAX) {
        pthread_mutex_unlock(&mgr->lock);
        return LU_ERR_NOT_FOUND; /* observer not registered */
    }

    /* Slide remaining items left to close the gap. */
    memmove(&mgr->observers[idx],
            &mgr->observers[idx + 1],
            (mgr->count - idx - 1) * sizeof(Notifier *));

    mgr->count--;

    LU_LOG_INFO("[NotificationManager] unregistered observer=%s (total=%zu)",
                observer->name ? observer->name : "(unnamed)", mgr->count);

    pthread_mutex_unlock(&mgr->lock);
    return LU_SUCCESS;
}

int notification_manager_notify(NotificationManager *mgr,
                                const NotificationEvent *event,
                                NotificationDispatchStats *stats_out)
{
    if (mgr == NULL || event == NULL) {
        return LU_ERR_INVALID_ARG;
    }

    NotificationDispatchStats local_stats = { 0 };

    int rc = pthread_mutex_lock(&mgr->lock);
    if (rc != 0) {
        LU_LOG_ERROR("[NotificationManager] notify: mutex lock failed");
        return LU_ERR_MUTEX;
    }

    size_t dispatched = 0;
    size_t failed     = 0;

    /* Snapshot list to reduce lock contention; observers themselves are
     * assumed immutable after registration, so addresses remain valid. */
    size_t snapshot_count = mgr->count;
    Notifier **snapshot   = NULL;

    if (snapshot_count > 0) {
        snapshot = malloc(snapshot_count * sizeof(Notifier *));
        if (!snapshot) {
            pthread_mutex_unlock(&mgr->lock);
            return LU_ERR_ALLOC;
        }
        memcpy(snapshot, mgr->observers, snapshot_count * sizeof(Notifier *));
    }

    pthread_mutex_unlock(&mgr->lock);

    for (size_t i = 0; i < snapshot_count; ++i) {
        Notifier *obs = snapshot[i];
        if (obs == NULL || obs->send == NULL) {
            failed++;
            continue;
        }
        int send_rc = obs->send(obs, event);
        if (send_rc == LU_SUCCESS) {
            dispatched++;
        } else {
            failed++;
            LU_LOG_WARN("[NotificationManager] observer=%s send failed: rc=%d",
                        obs->name ? obs->name : "(unnamed)", send_rc);
        }
    }

    free(snapshot);

    local_stats.dispatched = dispatched;
    local_stats.failed     = failed;

    if (stats_out) {
        *stats_out = local_stats;
    }

    LU_LOG_DEBUG("[NotificationManager] event \"%s\" dispatched=%zu failed=%zu",
                 event->title ? event->title : "(untitled)",
                 dispatched, failed);

    return failed == 0 ? LU_SUCCESS : LU_PARTIAL_SUCCESS;
}

void notification_manager_cleanup(NotificationManager *mgr)
{
    if (mgr == NULL) {
        return;
    }

    pthread_mutex_lock(&mgr->lock);

    free(mgr->observers);
    mgr->observers = NULL;
    mgr->capacity  = 0;
    mgr->count     = 0;

    free(mgr->name);
    mgr->name = NULL;

    pthread_mutex_unlock(&mgr->lock);
    pthread_mutex_destroy(&mgr->lock);

    LU_LOG_DEBUG("[NotificationManager] cleaned up");
}

/* --------------------------------------------------------------------------
 * Private helpers
 * --------------------------------------------------------------------------*/

/*
 * realloc_observer_array
 *
 * Grows or shrinks the observer pointer array.  Caller must hold the lock.
 */
static int realloc_observer_array(NotificationManager *mgr, size_t new_capacity)
{
    if (new_capacity == 0) {
        return LU_ERR_INVALID_ARG;
    }

    Notifier **tmp = realloc(mgr->observers, new_capacity * sizeof(Notifier *));
    if (tmp == NULL) {
        LU_LOG_ERROR("[NotificationManager] realloc failed: %s", strerror(errno));
        return LU_ERR_ALLOC;
    }

    /* Zero out new memory segment if we grew the capacity. */
    if (new_capacity > mgr->capacity) {
        size_t start = mgr->capacity;
        size_t len   = new_capacity - mgr->capacity;
        memset(tmp + start, 0, len * sizeof(Notifier *));
    }

    mgr->observers = tmp;
    mgr->capacity  = new_capacity;

    LU_LOG_DEBUG("[NotificationManager] capacity resized to %zu", new_capacity);
    return LU_SUCCESS;
}