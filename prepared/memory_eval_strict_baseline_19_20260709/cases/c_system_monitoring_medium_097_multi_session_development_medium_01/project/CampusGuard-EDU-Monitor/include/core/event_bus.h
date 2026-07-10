#ifndef CAMPUS_GUARD_CORE_EVENT_BUS_H
#define CAMPUS_GUARD_CORE_EVENT_BUS_H
/*
 * CampusGuard EDU Monitor – Event Bus (core/event_bus.h)
 *
 * The Event Bus is the central message dispatcher used by the Controller layer
 * to decouple producers (log collectors, security scanners, etc.) from
 * consumers (dashboard UI, alert engine, archival service, …).
 *
 *  • Thread-safe: internal locking guarantees safe concurrent publish/subscribe
 *    from multiple threads.
 *  • Reference-counted: both the bus itself and every subscription are ref-
 *    counted to prevent use-after-free while allowing zero-copy publications.
 *  • Zero-dependency API: only requires the C standard library + <pthread.h>.
 *
 *  Typical usage
 *  -------------
 *      cg_event_bus_t *bus = cg_event_bus_create();
 *
 *      cg_event_subscription_t *sub =
 *          cg_event_bus_subscribe(bus,
 *                                CG_EVT_ALERT_RAISED,
 *                                on_alert,            // callback
 *                                NULL);               // user data
 *
 *      … publish events somewhere else …
 *
 *      cg_event_subscription_unref(sub);
 *      cg_event_bus_unref(bus);
 *
 *  Build
 *  -----
 *      #include "core/event_bus.h"
 *
 *  Author: CampusGuard Engineering Team
 *  License: MIT
 */

#include <stddef.h>     /* size_t   */
#include <stdint.h>     /* uint*_t  */
#include <time.h>       /* timespec */
#include <pthread.h>    /* pthread  */

#ifdef __cplusplus
extern "C" {
#endif

/*-------------------------------------------------------------------------
 * Forward declarations / opaque handles
 *------------------------------------------------------------------------*/
typedef struct cg_event_bus         cg_event_bus_t;
typedef struct cg_event_subscription cg_event_subscription_t;

/*-------------------------------------------------------------------------
 * Return codes
 *------------------------------------------------------------------------*/
typedef enum {
    CG_EBUS_OK          =  0,  /* Success                                 */
    CG_EBUS_ERR         = -1,  /* Generic / unspecified failure           */
    CG_EBUS_NOMEM       = -2,  /* Allocation failed                       */
    CG_EBUS_INVALID     = -3,  /* Invalid argument                        */
    CG_EBUS_NOTFOUND    = -4,  /* Requested resource does not exist       */
    CG_EBUS_TIMEOUT     = -5   /* Operation timed out / would block long  */
} cg_ebus_rc;

/*-------------------------------------------------------------------------
 * Built-in event types – additional user events start at CG_EVT_USER_BASE
 *------------------------------------------------------------------------*/
typedef enum {
    CG_EVT_NONE = 0,                 /* Wild-card (subscribe to all)        */
    CG_EVT_LOG_RECORD,               /* New log line aggregated             */
    CG_EVT_ALERT_RAISED,             /* Alert triggered by rules engine     */
    CG_EVT_SCAN_FINISHED,            /* Security scan completed             */
    CG_EVT_BACKUP_PROGRESS,          /* Backup state update                 */
    CG_EVT_NODE_HEALTH_CHANGE,       /* Health probe result changed         */
    CG_EVT_SHUTDOWN,                 /* Service is shutting down            */

    /* User-defined events must have IDs > CG_EVT_USER_BASE */
    CG_EVT_USER_BASE = 0x1000
} cg_event_type_t;

/*-------------------------------------------------------------------------
 * Event object
 *------------------------------------------------------------------------*/
typedef struct cg_event {
    cg_event_type_t  type;           /* Classification                      */
    struct timespec  timestamp;      /* CLOCK_MONOTONIC timestamp           */
    const void      *payload;        /* Optional payload (may be NULL)      */
    size_t           payload_size;   /* Size of payload in bytes            */
} cg_event_t;

/*-------------------------------------------------------------------------
 * Callback prototype                                                   
 *------------------------------------------------------------------------*/
typedef void (*cg_event_cb)(const cg_event_t *event, void *user_data);

/*-------------------------------------------------------------------------
 * API – Bus lifecycle                                                   *
 *------------------------------------------------------------------------*/

/*
 * cg_event_bus_create
 *   Allocate and initialise a new, empty event bus with ref-count = 1.
 *
 * Returns: Pointer to bus or NULL on failure (errno is preserved).
 */
cg_event_bus_t *
cg_event_bus_create(void);

/*
 * cg_event_bus_ref / cg_event_bus_unref
 *   Increment / decrement the reference count of the bus.  When the count
 *   reaches zero all resources are freed and pending subscriptions are
 *   cancelled automatically.
 */
void cg_event_bus_ref  (cg_event_bus_t *bus);
void cg_event_bus_unref(cg_event_bus_t *bus);

/*-------------------------------------------------------------------------
 * API – Publication                                                     *
 *------------------------------------------------------------------------*/

/*
 * cg_event_bus_publish
 *   Synchronously dispatch an already-constructed event to all subscribers
 *   matching its type. The caller retains ownership of `event` and its
 *   payload – the bus never copies user memory.
 *
 * Returns: CG_EBUS_OK on success or a negative error code.
 */
int
cg_event_bus_publish(cg_event_bus_t  *bus,
                     const cg_event_t *event);

/*
 * cg_event_bus_publish_simple
 *   Convenience wrapper to create a transient event on the stack and publish
 *   it immediately without constructing a full cg_event_t beforehand.
 */
static inline int
cg_event_bus_publish_simple(cg_event_bus_t *bus,
                            cg_event_type_t type,
                            const void     *payload,
                            size_t          payload_size)
{
    cg_event_t ev = {
        .type         = type,
        .payload      = payload,
        .payload_size = payload_size
    };
    clock_gettime(CLOCK_MONOTONIC, &ev.timestamp);
    return cg_event_bus_publish(bus, &ev);
}

/*-------------------------------------------------------------------------
 * API – Subscription                                                    *
 *------------------------------------------------------------------------*/

/*
 * cg_event_bus_subscribe
 *   Register a callback for `event_type`.  If `event_type` equals
 *   CG_EVT_NONE the callback receives ALL events.
 *
 *   The bus takes an internal reference to itself; the caller must release
 *   the returned subscription with cg_event_subscription_unref().
 *
 * Returns: Valid subscription handle or NULL on failure.
 */
cg_event_subscription_t *
cg_event_bus_subscribe(cg_event_bus_t *bus,
                       cg_event_type_t event_type,
                       cg_event_cb     callback,
                       void           *user_data);

/*
 * cg_event_subscription_set_priority
 *   Change the execution order of a subscription. Higher priority callbacks
 *   run before lower priority ones for the same event. Default = 0.
 */
int
cg_event_subscription_set_priority(cg_event_subscription_t *sub,
                                   int                     priority);

/*
 * cg_event_subscription_unref
 *   Remove a subscription and free its resources.  Safe to call from within
 *   a callback (deferred removal).
 */
void
cg_event_subscription_unref(cg_event_subscription_t *sub);

/*-------------------------------------------------------------------------
 * Utility helpers                                                      *
 *------------------------------------------------------------------------*/

/*
 * cg_event_type_str
 *   Return a static, human-readable string for the given type. Unknown / user
 *   types are returned as "USER(<value>)".
 */
const char *
cg_event_type_str(cg_event_type_t type);

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* CAMPUS_GUARD_CORE_EVENT_BUS_H */