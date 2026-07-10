/**
 * RetinaGuard_Vision_Suite/src/core/observer.h
 *
 * Copyright (c) 2024
 * RetinaGuard Vision Suite — Diabetic-Retinopathy Computer-Vision Platform
 *
 * This file is part of the RetinaGuard Vision Suite and implements a light-weight,
 * in-process Observer pattern used across the monolithic application to broadcast
 * pipeline events (e.g., image ingestion, inference complete, model re-train, etc.)
 * to interested subsystems such as the model-registry and the monitoring dashboard.
 *
 * The implementation purposely remains header-only to avoid an additional compile
 * unit and to ensure that the compiler can inline trivial fast paths.  A mutex
 * guarantees thread-safety because the pipeline executes in a multi-threaded
 * environment (OpenMP parallel sections, GUI thread, async EMR callbacks, …).
 *
 * Usage
 * -----
 *   // Register an observer.
 *   static void on_event(RG_EventType type,
 *                        const void *payload,
 *                        size_t payload_sz,
 *                        void *user_ctx)
 *   {
 *       (void)payload_sz;
 *       printf("Observer <%s> received event %d\n",(char*)user_ctx,type);
 *   }
 *
 *   uint32_t obs_id;
 *   rg_observer_register(on_event, "UI-Thread", &obs_id);
 *
 *   // Broadcast an event.
 *   rg_observer_notify(RG_EVENT_MODEL_INFERENCE_COMPLETED, &stats, sizeof(stats));
 *
 *   // Cleanup.
 *   rg_observer_unregister(obs_id);
 *
 * NOTE:
 *   The observer layer never interprets the payload; it is transported as an
 *   opaque blob (pointer + size) to decouple publishers from subscribers.
 */

#ifndef RETINAGUARD_CORE_OBSERVER_H
#define RETINAGUARD_CORE_OBSERVER_H

/* --------------------------------------------------------------------------
 * Standard Library Includes
 * --------------------------------------------------------------------------*/
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdlib.h>
#include <pthread.h>
#include <string.h>
#include <errno.h>

/* --------------------------------------------------------------------------
 * Public Constants & Macros
 * --------------------------------------------------------------------------*/

#ifndef RG_MAX_OBSERVERS
/* Upper bound on simultaneously registered observers.
 * This can be overridden at compile-time if necessary. */
#define RG_MAX_OBSERVERS 32
#endif

/* Public return codes */
#define RG_OK                (0)
#define RG_ERR_ARG          (-1)
#define RG_ERR_NO_MEM       (-2)
#define RG_ERR_CAPACITY     (-3)
#define RG_ERR_NOT_FOUND    (-4)
#define RG_ERR_INTERNAL     (-5)

/* --------------------------------------------------------------------------
 * Event Definitions
 * --------------------------------------------------------------------------*/

/* Enumerates all events that can be broadcast inside the RetinaGuard suite.
 * New events must be appended (never renumbered) to preserve ABI stability. */
typedef enum
{
    RG_EVENT_IMAGE_INGESTED = 0,
    RG_EVENT_PREPROCESS_COMPLETE,
    RG_EVENT_FEATURES_EXTRACTED,
    RG_EVENT_MODEL_INFERENCE_COMPLETED,
    RG_EVENT_EVAL_METRICS_AVAILABLE,
    RG_EVENT_RETRAIN_CYCLE_STARTED,
    RG_EVENT_RETRAIN_CYCLE_COMPLETED,
    RG_EVENT_SYSTEM_SHUTDOWN,

    RG_EVENT__COUNT /* sentinel—must be last */
} RG_EventType;

/* Forward declaration for callback signature */
typedef void (*rg_event_cb)(RG_EventType     type,
                            const void      *payload,
                            size_t           payload_size,
                            void            *user_ctx);

/* --------------------------------------------------------------------------
 * Observer Handle
 * --------------------------------------------------------------------------*/
typedef struct
{
    uint32_t     id;         /* unique identifier */
    rg_event_cb  cb;         /* user-supplied callback */
    void        *user_ctx;   /* forwarded at notification time */
    bool         in_use;     /* slot allocation flag          */
} rg_observer_t;

/* --------------------------------------------------------------------------
 * Internal Global State (header-only, so static)
 * --------------------------------------------------------------------------*/
static struct
{
    rg_observer_t observers[RG_MAX_OBSERVERS];
    uint32_t      id_counter; /* monotonically increasing, never wraps 32-bit */
    pthread_mutex_t lock;
    bool          init_once;
} rg_obs_state = {
    .observers   = {0},
    .id_counter  = 1,   /* 0 reserved for ‘invalid’ */
    .lock        = PTHREAD_MUTEX_INITIALIZER,
    .init_once   = false,
};

/* --------------------------------------------------------------------------
 * Local Helpers
 * --------------------------------------------------------------------------*/
static inline void
_rg_lazy_init(void)
{
    if (__builtin_expect(!rg_obs_state.init_once, 0))
    {
        /* Ensure observers[] marked unused */
        for (size_t i = 0; i < RG_MAX_OBSERVERS; ++i)
            rg_obs_state.observers[i].in_use = false;

        rg_obs_state.init_once = true;
    }
}

/* --------------------------------------------------------------------------
 * Public API — Registration
 * --------------------------------------------------------------------------*/

/**
 * rg_observer_register
 *
 * Registers a new observer callback that will receive every future event.
 *
 * Parameters
 * ----------
 * cb          : (IN)  Function pointer invoked on event notification.
 * user_ctx    : (IN)  Arbitrary user data returned verbatim to the callback.
 * out_id      : (OUT) Unique identifier used for later unregistration.
 *
 * Returns
 * -------
 * RG_OK on success; negative RG_ERR_* code on failure.
 */
static inline int
rg_observer_register(rg_event_cb cb, void *user_ctx, uint32_t *out_id)
{
    if (!cb || !out_id)
        return RG_ERR_ARG;

    _rg_lazy_init();

    if (pthread_mutex_lock(&rg_obs_state.lock) != 0)
        return RG_ERR_INTERNAL;

    int rc = RG_ERR_CAPACITY;

    /* Find first available slot */
    for (size_t i = 0; i < RG_MAX_OBSERVERS; ++i)
    {
        if (!rg_obs_state.observers[i].in_use)
        {
            rg_obs_state.observers[i].in_use   = true;
            rg_obs_state.observers[i].cb       = cb;
            rg_obs_state.observers[i].user_ctx = user_ctx;
            rg_obs_state.observers[i].id       = rg_obs_state.id_counter++;

            *out_id = rg_obs_state.observers[i].id;
            rc      = RG_OK;
            break;
        }
    }

    pthread_mutex_unlock(&rg_obs_state.lock);
    return rc;
}

/* --------------------------------------------------------------------------
 * Public API — Unregistration
 * --------------------------------------------------------------------------*/

/**
 * rg_observer_unregister
 *
 * Removes a previously registered observer so it no longer
 * receives event notifications.
 *
 * Parameters
 * ----------
 * id : (IN) Identifier obtained from rg_observer_register().
 *
 * Returns
 * -------
 * RG_OK on success; RG_ERR_NOT_FOUND if id is unknown.
 */
static inline int
rg_observer_unregister(uint32_t id)
{
    if (id == 0)
        return RG_ERR_ARG;

    if (pthread_mutex_lock(&rg_obs_state.lock) != 0)
        return RG_ERR_INTERNAL;

    int rc = RG_ERR_NOT_FOUND;

    for (size_t i = 0; i < RG_MAX_OBSERVERS; ++i)
    {
        if (rg_obs_state.observers[i].in_use && rg_obs_state.observers[i].id == id)
        {
            rg_obs_state.observers[i].in_use = false;
            /* zero-out slot for good measure */
            memset(&rg_obs_state.observers[i], 0, sizeof(rg_observer_t));
            rc = RG_OK;
            break;
        }
    }

    pthread_mutex_unlock(&rg_obs_state.lock);
    return rc;
}

/* --------------------------------------------------------------------------
 * Public API — Broadcast
 * --------------------------------------------------------------------------*/

/**
 * rg_observer_notify
 *
 * Broadcasts an event to every registered observer. The payload is treated
 * as a read-only, opaque memory region and MUST remain valid for the duration
 * of this call. The function returns only after all callbacks have returned.
 *
 * Parameters
 * ----------
 * type        : (IN) Event enumeration.
 * payload     : (IN) Pointer to event-specific data (nullable).
 * payload_sz  : (IN) Size of payload in bytes (0 if NULL).
 *
 * Returns
 * -------
 * RG_OK on success; RG_ERR_ARG if parameters invalid.
 */
static inline int
rg_observer_notify(RG_EventType type, const void *payload, size_t payload_sz)
{
    if (type < 0 || type >= RG_EVENT__COUNT)
        return RG_ERR_ARG;
    if ((payload == NULL) != (payload_sz == 0))
        return RG_ERR_ARG;

    /* We take a snapshot of active observers to minimize lock duration
     * and to prevent re-entrancy issues if callbacks register/unregister. */
    rg_observer_t snapshot[RG_MAX_OBSERVERS];
    size_t        snapshot_cnt = 0;

    if (pthread_mutex_lock(&rg_obs_state.lock) != 0)
        return RG_ERR_INTERNAL;

    for (size_t i = 0; i < RG_MAX_OBSERVERS; ++i)
    {
        if (rg_obs_state.observers[i].in_use)
            snapshot[snapshot_cnt++] = rg_obs_state.observers[i];
    }

    pthread_mutex_unlock(&rg_obs_state.lock);

    /* Invoke callbacks outside lock. */
    for (size_t i = 0; i < snapshot_cnt; ++i)
    {
        if (snapshot[i].cb)
        {
            /* Guard against misbehaving callbacks crashing the system. */
            snapshot[i].cb(type, payload, payload_sz, snapshot[i].user_ctx);
        }
    }

    return RG_OK;
}

/* --------------------------------------------------------------------------
 * Public API — Query Helpers
 * --------------------------------------------------------------------------*/

/**
 * rg_observer_count
 *
 * Return the number of currently registered observers.
 */
static inline size_t
rg_observer_count(void)
{
    size_t cnt = 0;
    if (pthread_mutex_lock(&rg_obs_state.lock) == 0)
    {
        for (size_t i = 0; i < RG_MAX_OBSERVERS; ++i)
            if (rg_obs_state.observers[i].in_use) ++cnt;

        pthread_mutex_unlock(&rg_obs_state.lock);
    }
    return cnt;
}

#endif /* RETINAGUARD_CORE_OBSERVER_H */
