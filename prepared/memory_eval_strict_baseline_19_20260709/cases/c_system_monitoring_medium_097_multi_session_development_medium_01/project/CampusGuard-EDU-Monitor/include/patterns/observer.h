/*
 * observer.h
 *
 * Copyright (c) 2024
 * CampusGuard-EDU-Monitor <https://campusguard.example.edu>
 *
 * MIT License
 *
 * A generic, thread-safe Observer implementation used throughout the
 * CampusGuard EDU Monitor project.  The API is intentionally decoupled from
 * any specific subsystem so that metrics collection, security alerting,
 * backup orchestration, and deployment tooling can all share the same
 * infrastructure.
 *
 * ---------------------------------------------------------------------------
 *  Design notes
 * ---------------------------------------------------------------------------
 *  • Thread-safety:
 *      All mutating operations are internally synchronized with a pthread
 *      mutex, so observers may be registered, deregistered, and notified from
 *      multiple threads concurrently.
 *
 *  • Lifetime:
 *      Observers are reference-counted.  Destroying an observable will
 *      automatically release its observers.  However, callers that create
 *      observers explicitly should still destroy them when no longer needed.
 *
 *  • Re-entrancy:
 *      Callbacks are issued outside the internal lock to prevent deadlocks,
 *      but doing so means the set of observers could change while a callback
 *      chain is in progress.  Each callback therefore receives a stable view
 *      of its parameters, but the global list is not immutable.
 *
 *  • Error handling:
 *      Functions return cg_status_t.  A negative value indicates an error,
 *      while CG_OK (0) indicates success.
 */

#pragma once

/*---------------------------------------------------------------------------
 *  Standard library dependencies
 *---------------------------------------------------------------------------*/
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*---------------------------------------------------------------------------
 *  Public error codes
 *---------------------------------------------------------------------------*/
typedef enum cg_status {
    CG_OK            =  0,   /* Operation succeeded                      */
    CG_ERR           = -1,   /* Generic/unspecified error                */
    CG_ERR_NOMEM     = -2,   /* Out of memory                            */
    CG_ERR_INVAL     = -3,   /* Invalid argument                         */
    CG_ERR_EXISTS    = -4,   /* Duplicate observer registration          */
    CG_ERR_NOTFOUND  = -5    /* Observer not found                       */
} cg_status_t;

/*---------------------------------------------------------------------------
 *  Event identifiers understood by the CampusGuard ecosystem
 *---------------------------------------------------------------------------*/
typedef enum cg_event {
    /* System-monitoring events */
    CG_EVT_METRIC_UPDATED      = 0x0001,  /* Payload: cg_metric_t*            */
    CG_EVT_ALERT_RAISED        = 0x0002,  /* Payload: cg_alert_t*             */
    CG_EVT_ALERT_CLEARED       = 0x0003,  /* Payload: cg_alert_t*             */

    /* Security-scanning events */
    CG_EVT_SCAN_STARTED        = 0x0101,  /* Payload: cg_scan_ctx_t*          */
    CG_EVT_SCAN_COMPLETED      = 0x0102,  /* Payload: cg_scan_result_t*       */

    /* Backup / recovery events */
    CG_EVT_BACKUP_COMPLETED    = 0x0201,  /* Payload: cg_backup_info_t*       */
    CG_EVT_RESTORE_COMPLETED   = 0x0202,  /* Payload: cg_restore_info_t*      */

    /* Deployment events */
    CG_EVT_DEPLOY_STARTED      = 0x0301,  /* Payload: cg_deploy_job_t*        */
    CG_EVT_DEPLOY_FINISHED     = 0x0302,  /* Payload: cg_deploy_job_t*        */

    /* User-defined/custom events begin at 0x8000 */
    CG_EVT_CUSTOM_BASE         = 0x8000
} cg_event_t;

/*---------------------------------------------------------------------------
 *  Opaque type forward-declarations
 *---------------------------------------------------------------------------*/
typedef struct cg_observable cg_observable_t;
typedef struct cg_observer   cg_observer_t;

/*---------------------------------------------------------------------------
 *  Callback signature
 *---------------------------------------------------------------------------*/
/**
 * cg_notify_fn()
 *
 * @param observable The observable that triggered the event.
 * @param observer   The observer receiving the event.
 * @param event      The event identifier.  See cg_event_t.
 * @param payload    Event-specific payload (may be NULL).
 * @param user_data  Pointer supplied when the observer was created.
 *
 * The function must return CG_OK if it processed the event successfully,
 * or the appropriate cg_status_t error otherwise.
 *
 * Returning a non-zero status will NOT stop other observers from receiving
 * the event; however, the return value will be reported back to the caller
 * of cg_observable_notify().
 */
typedef cg_status_t (*cg_notify_fn)(const cg_observable_t *observable,
                                    const cg_observer_t   *observer,
                                    cg_event_t             event,
                                    const void            *payload,
                                    void                  *user_data);

/*---------------------------------------------------------------------------
 *  Observer lifecycle API
 *---------------------------------------------------------------------------*/
/**
 * cg_observer_create()
 *
 * Allocates and initialises a new observer.
 *
 * @param cb         Callback invoked for each event.
 * @param user_data  Context pointer passed back to the callback.
 * @param out_obs    Receives the newly created observer on success.
 *
 * Return: CG_OK on success, otherwise a negative cg_status_t error.
 */
cg_status_t
cg_observer_create(cg_notify_fn     cb,
                   void            *user_data,
                   cg_observer_t  **out_obs);

/**
 * cg_observer_retain() / cg_observer_release()
 *
 * Manual reference-counted retain/release.  These functions are only needed
 * when observers are shared across more than one observable.
 */
void cg_observer_retain  (cg_observer_t *observer);
void cg_observer_release (cg_observer_t *observer);

/**
 * cg_observer_get_userdata()
 *
 * Retrieves the user-data pointer associated with the observer.
 */
void *cg_observer_get_userdata(const cg_observer_t *observer);

/*---------------------------------------------------------------------------
 *  Observable lifecycle API
 *---------------------------------------------------------------------------*/
/**
 * cg_observable_create()
 *
 * Constructs an observable capable of holding zero or more observers.
 *
 * @param out_obsbl Receives the newly created observable.
 *
 * Return: CG_OK on success, otherwise a negative cg_status_t error.
 */
cg_status_t
cg_observable_create(cg_observable_t **out_obsbl);

/**
 * cg_observable_destroy()
 *
 * Releases all observers and destroys the observable itself.
 */
void
cg_observable_destroy(cg_observable_t *observable);

/*---------------------------------------------------------------------------
 *  Observer management
 *---------------------------------------------------------------------------*/
/**
 * cg_observable_register()
 *
 * Registers the specified observer with the observable.
 *
 * @return CG_OK, CG_ERR_EXISTS, or other negative error.
 */
cg_status_t
cg_observable_register(cg_observable_t *observable,
                       cg_observer_t   *observer);

/**
 * cg_observable_unregister()
 *
 * Deregisters the specified observer.  Safe to call even if the observer was
 * never registered; in that case CG_ERR_NOTFOUND is returned.
 */
cg_status_t
cg_observable_unregister(cg_observable_t *observable,
                         cg_observer_t   *observer);

/*---------------------------------------------------------------------------
 *  Event emission
 *---------------------------------------------------------------------------*/
/**
 * cg_observable_notify()
 *
 * Dispatches an event to all currently registered observers.  The function
 * iterates over a snapshot of observers to guarantee that each callback gets
 * at most one invocation per notify() call, even if observers are added or
 * removed concurrently.
 *
 * @param observable The event source.
 * @param event      Event identifier.
 * @param payload    Event-specific payload (optional).
 *
 * Return value is CG_OK if all observers returned CG_OK; if any observer
 * returns an error, the first such error is propagated back to the caller.
 */
cg_status_t
cg_observable_notify(cg_observable_t *observable,
                     cg_event_t       event,
                     const void      *payload);

/*---------------------------------------------------------------------------
 *  Convenience helpers
 *---------------------------------------------------------------------------*/
/**
 * cg_status_str()
 *
 * Converts a cg_status_t to a human-readable string—useful for debugging and
 * log messages.
 */
const char *
cg_status_str(cg_status_t rc);

/**
 * cg_event_str()
 *
 * Converts a cg_event_t to a human-readable string.
 * Unknown/custom events are rendered as "0x%04X".
 */
const char *
cg_event_str(cg_event_t event);

/*---------------------------------------------------------------------------
 *  Compile-time configuration macros
 *---------------------------------------------------------------------------*/
#ifndef CG_MAX_OBSERVERS_PER_SUBJECT
    /* DEFAULT: allow up to 256 observers per observable */
#   define CG_MAX_OBSERVERS_PER_SUBJECT 256
#endif

#ifdef __cplusplus
}
#endif