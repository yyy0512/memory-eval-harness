/*
 * RetinaGuard Vision Suite
 * File:    src/core/events.h
 *
 * A minimal-overhead, thread-safe event bus that wires together the
 * Observer-Pattern hooks used throughout the RetinaGuard pipeline.
 *
 * This single-header library exposes the API when included normally and,
 * when RETINAGUARD_EVENTS_IMPLEMENTATION is defined *once* before including
 * it, compiles the full implementation as well (à la stb-style headers).
 *
 * Typical usage:
 *
 *      #define RETINAGUARD_EVENTS_IMPLEMENTATION
 *      #include "core/events.h"
 *
 *      static void on_inference(RGEventType t,
 *                               const void *payload,
 *                               size_t      sz,
 *                               void       *ctx)
 *      {
 *          (void)t; (void)ctx;
 *          const RGInferenceEvent *e = payload;
 *          printf("Result %.2f for image %s\n",
 *                 e->disease_score, e->image_id);
 *      }
 *
 *      int main(void)
 *      {
 *          rg_events_init();
 *          rg_events_subscribe(RG_EVENT_INFERENCE_COMPLETE,
 *                              on_inference, NULL);
 *          …
 *          rg_events_shutdown();
 *      }
 *
 * Copyright © 2024
 * RetinaGuard Medical Software Division.  All rights reserved.
 */

#ifndef RETINAGUARD_EVENTS_H
#define RETINAGUARD_EVENTS_H

/* ────────────────────────────────────────────────────────────────────────────
 *  Public interface
 * ────────────────────────────────────────────────────────────────────────── */

/* C89-compatible includes kept minimal for portability. */
#include <stddef.h>   /* size_t */
#include <stdint.h>   /* uint32_t */
#include <time.h>     /* time_t */

#ifdef __cplusplus
extern "C" {
#endif

/* Error/return codes common to all RG_* APIs.                                   */
#define RG_OK                 (0)
#define RG_ERR_NO_MEMORY      (-1)
#define RG_ERR_NOT_INITIALISED (-2)
#define RG_ERR_INVALID_ARG    (-3)
#define RG_ERR_NOT_FOUND      (-4)

/* ------------------------------------------------------------------------
 * Event type enumeration.
 *
 * Note: treat the enum as stable ABI; append new events to the end only.
 * ---------------------------------------------------------------------- */
typedef enum
{
    RG_EVENT_IMAGE_INGESTED = 0,
    RG_EVENT_PREPROCESS_COMPLETE,
    RG_EVENT_INFERENCE_COMPLETE,
    RG_EVENT_PROGRESSION_ALERT,
    RG_EVENT_PIPELINE_ERROR,
    RG_EVENT_MODEL_RETRAIN_COMPLETE,
    RG_EVENT_MODEL_VERSION_UPDATED,
    RG_EVENT_MONITOR_METRIC,
    RG_EVENT_VISUALIZATION_READY,
    RG_EVENT_MAX,                 /* Sentinel value (not a real event).        */

    RG_EVENT_ANY = 0xFFFF         /* Special wildcard for subscriptions.       */
} RGEventType;

/* ------------------------------------------------------------------------
 * Example payload structures (used by publisher & subscriber code).
 * The event bus sees them as opaque blobs; they are documented here for
 * convenience only.
 * ---------------------------------------------------------------------- */
typedef struct RGImageIngestedEvent
{
    char     image_id[64];
    uint32_t width;
    uint32_t height;
    time_t   timestamp;
} RGImageIngestedEvent;

typedef struct RGInferenceEvent
{
    char     image_id[64];
    double   disease_score;  /* 0.0-1.0 */
    uint8_t  disease_grade;  /* 0-4      */
    time_t   timestamp;
} RGInferenceEvent;

/* Extend with additional payload structs as needed. */

/* ------------------------------------------------------------------------
 * Callback signature used by observers.
 *
 *  - `event_type` identifies the event.
 *  - `event_payload` is an opaque pointer (may be NULL).
 *  - `payload_size` size of the payload in bytes (0 if none).
 *  - `user_ctx` is the pointer passed during subscription.
 * ---------------------------------------------------------------------- */
typedef void (*RGEventCallback)(RGEventType event_type,
                                const void *event_payload,
                                size_t      payload_size,
                                void       *user_ctx);

/* ------------------------------------------------------------------------
 * Lifecycle management.
 * ---------------------------------------------------------------------- */

/* Initialise the global event bus.  Must be called once before use.
 * Thread-safe: may be called concurrently but only the first call wins. */
int  rg_events_init(void);

/* Free all internal resources and make the bus unusable until re-initialised. */
void rg_events_shutdown(void);

/* ------------------------------------------------------------------------
 * Subscription management.
 * ---------------------------------------------------------------------- */

/* Subscribe to a single event type (or RG_EVENT_ANY for all events).
 * Returns RG_OK on success or an RG_ERR_* code.                                */
int  rg_events_subscribe(RGEventType     type,
                         RGEventCallback callback,
                         void           *user_ctx);

/* Remove a previously registered callback for the specified event.             */
int  rg_events_unsubscribe(RGEventType     type,
                           RGEventCallback callback,
                           void           *user_ctx);

/* ------------------------------------------------------------------------
 * Publishing.
 * ---------------------------------------------------------------------- */

/* Publish an event with an optional payload.  The call is synchronous: all
 * observers are invoked before the function returns.                           */
int  rg_events_publish(RGEventType type,
                       const void *event_payload,
                       size_t      payload_size);

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ────────────────────────────────────────────────────────────────────────────
 *  Optional single-file implementation
 * ────────────────────────────────────────────────────────────────────────── */
#ifdef RETINAGUARD_EVENTS_IMPLEMENTATION
/* This section is compiled exactly once in the project. */

#include <stdlib.h>   /* malloc, free */
#include <string.h>   /* memset */
#include <pthread.h>  /* pthread_mutex_* */

/* Internal subscriber node. */
typedef struct RGSubscriberNode
{
    RGEventType           type;
    RGEventCallback       cb;
    void                 *user_ctx;
    struct RGSubscriberNode *next;
} RGSubscriberNode;

/* Global event bus state. */
static struct
{
    int                initialised;
    pthread_mutex_t    mutex;   /* Guards the linked list. */
    RGSubscriberNode  *head;
} rg_bus = {0};

/* ───── Internal helpers ─────────────────────────────────────────────────── */

static int rg_bus_lock(void)
{
    return pthread_mutex_lock(&rg_bus.mutex);
}

static int rg_bus_unlock(void)
{
    return pthread_mutex_unlock(&rg_bus.mutex);
}

/* ───── API implementation ───────────────────────────────────────────────── */

int rg_events_init(void)
{
    if (rg_bus.initialised)
        return RG_OK;

    if (pthread_mutex_init(&rg_bus.mutex, NULL) != 0)
        return RG_ERR_NO_MEMORY;

    rg_bus.head        = NULL;
    rg_bus.initialised = 1;
    return RG_OK;
}

void rg_events_shutdown(void)
{
    if (!rg_bus.initialised)
        return;

    rg_bus_lock();
    RGSubscriberNode *iter = rg_bus.head;
    while (iter)
    {
        RGSubscriberNode *next = iter->next;
        free(iter);
        iter = next;
    }
    rg_bus.head = NULL;
    rg_bus_unlock();

    pthread_mutex_destroy(&rg_bus.mutex);
    rg_bus.initialised = 0;
}

static int rg_subscriber_match(const RGSubscriberNode *n,
                               RGEventType             type,
                               RGEventCallback         cb,
                               const void             *ctx)
{
    return (n->type == type || type == RG_EVENT_ANY) &&
           n->cb   == cb     &&
           n->user_ctx == ctx;
}

int rg_events_subscribe(RGEventType     type,
                        RGEventCallback callback,
                        void           *user_ctx)
{
    if (!rg_bus.initialised)
        return RG_ERR_NOT_INITIALISED;
    if (callback == NULL)
        return RG_ERR_INVALID_ARG;

    RGSubscriberNode *node = (RGSubscriberNode *)malloc(sizeof *node);
    if (!node)
        return RG_ERR_NO_MEMORY;

    node->type     = type;
    node->cb       = callback;
    node->user_ctx = user_ctx;

    rg_bus_lock();
    node->next     = rg_bus.head;
    rg_bus.head    = node;
    rg_bus_unlock();

    return RG_OK;
}

int rg_events_unsubscribe(RGEventType     type,
                          RGEventCallback callback,
                          void           *user_ctx)
{
    if (!rg_bus.initialised)
        return RG_ERR_NOT_INITIALISED;

    rg_bus_lock();
    RGSubscriberNode **prev_ptr = &rg_bus.head;
    RGSubscriberNode  *iter     = rg_bus.head;
    int removed = 0;

    while (iter)
    {
        if (rg_subscriber_match(iter, type, callback, user_ctx))
        {
            *prev_ptr = iter->next;
            free(iter);
            removed = 1;
            break;
        }
        prev_ptr = &iter->next;
        iter     = iter->next;
    }
    rg_bus_unlock();

    return removed ? RG_OK : RG_ERR_NOT_FOUND;
}

int rg_events_publish(RGEventType type,
                      const void *event_payload,
                      size_t      payload_size)
{
    if (!rg_bus.initialised)
        return RG_ERR_NOT_INITIALISED;

    /* Make a shallow copy of the subscriber list to avoid holding the lock
     * while user callbacks execute (prevents deadlocks).                     */
    rg_bus_lock();
    RGSubscriberNode *snapshot_head = NULL;
    RGSubscriberNode *snapshot_tail = NULL;
    for (RGSubscriberNode *it = rg_bus.head; it; it = it->next)
    {
        if (it->type == type || it->type == RG_EVENT_ANY)
        {
            RGSubscriberNode *copy = (RGSubscriberNode *)malloc(sizeof *copy);
            if (!copy)
            {
                /* Allocation failure—best effort: skip this subscriber.      */
                continue;
            }
            *copy        = *it;
            copy->next   = NULL;
            if (!snapshot_head)
                snapshot_head = snapshot_tail = copy;
            else
            {
                snapshot_tail->next = copy;
                snapshot_tail       = copy;
            }
        }
    }
    rg_bus_unlock();

    /* Invoke callbacks outside critical section. */
    for (RGSubscriberNode *it = snapshot_head; it; )
    {
        RGSubscriberNode *next = it->next;
        if (it->cb)
            it->cb(type, event_payload, payload_size, it->user_ctx);
        free(it);
        it = next;
    }

    return RG_OK;
}

#endif /* RETINAGUARD_EVENTS_IMPLEMENTATION */
#endif /* RETINAGUARD_EVENTS_H */
