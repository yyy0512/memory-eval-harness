/**
 * LambdaUtility Orchestrator
 * File: src/lib/observer/observer.h
 *
 * Copyright (c) 2024─present LambdaUtility
 *
 * Description:
 *   Public API for the in-process Observer subsystem.
 *   Observers are lightweight fan-out endpoints (Slack, E-mail, SMS, etc.)
 *   that are interested in well-defined automation events emitted by any
 *   Command in the system.  The API is thread-safe, allocation-free on the
 *   hot path, and optimized for short-lived Lambda executions.
 *
 *   +-------------------------------------------------------------+
 *   |            Subject (command dispatcher)                     |
 *   |  ┌───────────────────────────────────────────────────────┐   |
 *   |  |  ObserverRegistry (mutex-protected singly list)       |   |
 *   |  └───────────────────────────────────────────────────────┘   |
 *   |       │ attach/detach/notify()                              |
 *   +-------┼-----------------------------------------------------+
 *           ▼
 *   ┌───────────────────────┐    ┌───────────────────────┐
 *   │ SlackObserver         │    │ EmailObserver         │
 *   └───────────────────────┘    └───────────────────────┘
 *
 * Usage pattern (simplified):
 *
 *      ObserverRegistry registry;
 *      observer_registry_init(&registry);
 *
 *      Observer slack   = OBSERVER_INIT(slack_callback,   NULL);
 *      Observer email   = OBSERVER_INIT(email_callback,   NULL);
 *      observer_attach(&registry, &slack);
 *      observer_attach(&registry, &email);
 *
 *      ObserverEvent ev = OBSERVER_EVENT_INIT(OB_EV_BACKUP_FINISHED,
 *                                             "{\"db\":\"prod\"}");
 *      observer_notify(&registry, &ev);
 *
 *      observer_registry_cleanup(&registry);
 */

#ifndef LU_OBSERVER_H
#define LU_OBSERVER_H

/* -------------------------------------------------------------------------- */
/*  Standard headers                                                           */
/* -------------------------------------------------------------------------- */
#include <stdint.h>     /* uint32_t, etc. */
#include <stddef.h>     /* size_t         */
#include <pthread.h>    /* pthread_mutex  */
#include <time.h>       /* time_t         */

/* -------------------------------------------------------------------------- */
/*  Configuration macros                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Maximum length (bytes) allowed for ObserverEvent.payload.
 * Adjust in deployment configurations if larger JSON objects are required.
 */
#ifndef LU_OBSERVER_PAYLOAD_MAX
#   define LU_OBSERVER_PAYLOAD_MAX   2048U
#endif

/* -------------------------------------------------------------------------- */
/*  Error codes                                                               */
/* -------------------------------------------------------------------------- */

typedef enum
{
    OB_OK               = 0,  /* Success                        */
    OB_EINVAL           = 1,  /* Invalid argument               */
    OB_EEXISTS          = 2,  /* Observer already attached      */
    OB_ENOTFOUND        = 3,  /* Observer not attached          */
    OB_EMUTEX           = 4,  /* Mutex operation failure        */
    OB_EOVERFLOW        = 5,  /* Payload too large              */
    OB_EUNKNOWN         = 255 /* Unknown/unmapped error         */
} ob_err_t;

/* -------------------------------------------------------------------------- */
/*  Event types                                                               */
/* -------------------------------------------------------------------------- */

typedef enum
{
    OB_EV_UNKNOWN = 0,

    /* Core capabilities */
    OB_EV_ALERT_RAISED,
    OB_EV_CONFIG_PUSHED,
    OB_EV_BACKUP_FINISHED,
    OB_EV_DEPLOYMENT_SUCCESS,
    OB_EV_METRICS_RECORDED,

    /* Add new events above this line */
    OB_EV__MAX
} ob_event_type_t;

/* -------------------------------------------------------------------------- */
/*  Event structure                                                           */
/* -------------------------------------------------------------------------- */

/**
 * struct ObserverEvent
 *
 * Event object passed from Subject to every Observer. All members
 * are POD to make the object easily transferable across thread /
 * IPC boundaries should future orchestration back-ends require it.
 */
typedef struct
{
    ob_event_type_t  type;                          /* Event discriminator  */
    char             payload[LU_OBSERVER_PAYLOAD_MAX]; /* JSON payload      */
    size_t           payload_len;                   /* strlen(payload)     */
    time_t           timestamp;                    /* monotonic event time */
} ObserverEvent;

/* Convenience macro for zero-initializing an event */
#define OBSERVER_EVENT_INIT(_type, _json)                              \
    { .type = (_type),                                                 \
      .payload = {0},                                                  \
      .payload_len = 0U,                                               \
      .timestamp = time(NULL) }                                        \
    /* ^ payload will be populated by observer_event_set_payload() */

/* -------------------------------------------------------------------------- */
/*  Forward declarations                                                      */
/* -------------------------------------------------------------------------- */

struct Observer;

/**
 * Observer callback signature.
 *
 * @param ev         The event pointer (never NULL).
 * @param user_data  Context pointer supplied when observer was created.
 */
typedef void (*observer_on_event_f)(const ObserverEvent *ev, void *user_data);

/* -------------------------------------------------------------------------- */
/*  Observer object                                                           */
/* -------------------------------------------------------------------------- */

/**
 * struct Observer
 *
 * Public fields:
 *   on_event   - Function called for every event.
 *   user_data  - Opaque pointer passed to on_event().
 *
 * Implementation details:
 *   next       - Singly-linked list node for registry bookkeeping.
 */
typedef struct Observer
{
    observer_on_event_f  on_event;
    void                *user_data;

    /* Internal members ─ do not access directly. */
    struct Observer     *next;
} Observer;

/* Static initializer for stack-allocated Observers. */
#define OBSERVER_INIT(cb, ctx)  { .on_event = (cb), .user_data = (ctx), .next = NULL }

/* -------------------------------------------------------------------------- */
/*  Observer Registry (the Subject)                                           */
/* -------------------------------------------------------------------------- */

/**
 * struct ObserverRegistry
 *
 * Thread-safe container managing zero or more Observer objects.
 * Lock granularity is coarse (full list) given the small list size
 * typical for serverless Lambdas.
 */
typedef struct
{
    pthread_mutex_t  mutex;    /* Protects the linked list */
    Observer        *head;     /* Singly-linked list head  */
} ObserverRegistry;

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * observer_registry_init
 *
 * Initialize an ObserverRegistry.  Must be called before any other
 * function in this unit. The registry does NOT take ownership of any
 * Observer memory; lifetime management is delegated to the caller.
 *
 * @param reg  Pointer to registry object.
 * @return     OB_OK on success, error code otherwise.
 */
static inline ob_err_t
observer_registry_init(ObserverRegistry *reg)
{
    if (!reg)
        return OB_EINVAL;

    int rc = pthread_mutex_init(&reg->mutex, NULL);
    if (rc != 0)
        return OB_EMUTEX;

    reg->head = NULL;
    return OB_OK;
}

/**
 * observer_registry_cleanup
 *
 * Destroy registry resources. Observers must already be detached or expire
 * naturally; otherwise, their references will be leaked (safe, but sloppy).
 *
 * @param reg  Registry to destroy.
 */
static inline void
observer_registry_cleanup(ObserverRegistry *reg)
{
    if (!reg)
        return;

    /* Nothing to do if mutex init failed earlier. */
    pthread_mutex_destroy(&reg->mutex);
    reg->head = NULL;
}

/**
 * observer_attach
 *
 * Register an observer with the given registry.
 *
 * @param reg       Registry pointer.
 * @param observer  Observer pointer (must remain valid until detached).
 *
 * @return OB_OK, OB_EINVAL, OB_EEXISTS, or OB_EMUTEX.
 */
static inline ob_err_t
observer_attach(ObserverRegistry *reg, Observer *observer)
{
    if (!reg || !observer || !observer->on_event)
        return OB_EINVAL;

    ob_err_t ret = OB_OK;
    if (pthread_mutex_lock(&reg->mutex) != 0)
        return OB_EMUTEX;

    /* Prevent duplicates */
    for (Observer *cur = reg->head; cur; cur = cur->next)
    {
        if (cur == observer)
        {
            ret = OB_EEXISTS;
            goto unlock;
        }
    }

    /* Insert at head for O(1) attach */
    observer->next = reg->head;
    reg->head      = observer;

unlock:
    pthread_mutex_unlock(&reg->mutex);
    return ret;
}

/**
 * observer_detach
 *
 * Unregister an observer. Detach is idempotent: attempting to remove an
 * unknown observer returns OB_ENOTFOUND.
 *
 * @return OB_OK, OB_ENOTFOUND, OB_EMUTEX, or OB_EINVAL.
 */
static inline ob_err_t
observer_detach(ObserverRegistry *reg, Observer *observer)
{
    if (!reg || !observer)
        return OB_EINVAL;

    ob_err_t ret = OB_ENOTFOUND;
    if (pthread_mutex_lock(&reg->mutex) != 0)
        return OB_EMUTEX;

    Observer **indirect = &reg->head;
    while (*indirect)
    {
        if (*indirect == observer)
        {
            *indirect       = observer->next;
            observer->next  = NULL;
            ret             = OB_OK;
            break;
        }
        indirect = &(*indirect)->next;
    }

    pthread_mutex_unlock(&reg->mutex);
    return ret;
}

/**
 * observer_event_set_payload
 *
 * Safely copy a JSON payload into the event buffer (size-bounded).
 *
 * @param ev      Event handle.
 * @param json    NULL-terminated JSON string.
 *
 * @return OB_OK, OB_EOVERFLOW, or OB_EINVAL.
 */
static inline ob_err_t
observer_event_set_payload(ObserverEvent *ev, const char *json)
{
    if (!ev || !json)
        return OB_EINVAL;

    size_t len = 0U;
    while (json[len] != '\0')
        ++len;

    if (len >= LU_OBSERVER_PAYLOAD_MAX)
        return OB_EOVERFLOW;

    for (size_t i = 0; i < len; ++i)
        ev->payload[i] = json[i];
    ev->payload[len]  = '\0';
    ev->payload_len   = len;
    return OB_OK;
}

/**
 * observer_notify
 *
 * Broadcast an event to every registered observer. The function
 * guarantees that callbacks execute in the order of attachment
 * (LIFO, because list is head-inserted).
 *
 * This call is synchronous; long-running observers will increase
 * total latency.  For async fan-out, register observers that
 * immediately push to a queue.
 *
 * @return OB_OK, OB_EMUTEX, or OB_EINVAL.
 */
static inline ob_err_t
observer_notify(ObserverRegistry *reg, const ObserverEvent *ev)
{
    if (!reg || !ev)
        return OB_EINVAL;

    if (pthread_mutex_lock(&reg->mutex) != 0)
        return OB_EMUTEX;

    for (Observer *cur = reg->head; cur; cur = cur->next)
    {
        /* Failure inside the callback is not handled here. */
        cur->on_event(ev, cur->user_data);
    }

    pthread_mutex_unlock(&reg->mutex);
    return OB_OK;
}

#endif /* LU_OBSERVER_H */
