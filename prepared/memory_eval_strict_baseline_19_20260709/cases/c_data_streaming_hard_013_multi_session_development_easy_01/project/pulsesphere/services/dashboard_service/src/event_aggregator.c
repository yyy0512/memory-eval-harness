/*
 * PulseSphere Dashboard Service - Event Aggregator
 *
 * File:    event_aggregator.c
 * Author:  PulseSphere Core Team
 * License: Apache 2.0
 *
 * Description:
 *   High-throughput, low-latency in-memory aggregator that maintains a
 *   sliding-window view of live “social pulse” events for the dashboard
 *   micro-service.  A lock-free bounded ring-buffer decouples event
 *   producers (streaming fabric consumer threads) from a single consumer
 *   aggregator thread that performs real-time aggregation.
 *
 *   Metrics currently tracked:
 *     – Per-event-type counts over an N-second tumbling window
 *
 *   The implementation is self-contained and depends only on the C11
 *   standard library (atomics + threads).
 */

#define _POSIX_C_SOURCE 200809L /* For clock_gettime() */
#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* -------------------------------------------------------------------------- */
/*                               Public API                                   */
/* -------------------------------------------------------------------------- */

typedef enum
{
    PULSE_LIKE = 0,
    PULSE_COMMENT,
    PULSE_SHARE,
    PULSE_FOLLOW,
    PULSE_REACTION,
    PULSE_TYPE_COUNT
} PulseType;

typedef struct
{
    PulseType type;      /* Event type                                        */
    char      tag[64];   /* Free-form tag or topic identifier (UTF-8)         */
    int32_t   sentiment; /* ‑100 … 100 normalized sentiment score             */
    time_t    ts;        /* Seconds since epoch                               */
} PulseEvent;

/* Snapshot structure returned to dashboard renderers */
typedef struct
{
    uint64_t per_type[PULSE_TYPE_COUNT];
    time_t   generated_at;
} EventAggregateSnapshot;

/*
 * Initialize the aggregator.
 *
 * window_seconds: Duration of sliding window (seconds, ≥ 1)
 * queue_capacity: Power-of-two capacity of internal ring buffer (≥ 2)
 *
 * Returns 0 on success, ‑1 on failure (errno set).
 */
int  event_aggregator_init(size_t window_seconds, size_t queue_capacity);

/*
 * Ingest a new pulse event.
 *
 * The call is non-blocking.  If the ring buffer is full the event will
 * be dropped and ‑1 is returned (the caller may log the loss).
 *
 * Returns 0 on success; ‑1 on drop (errno == EAGAIN) or other error.
 */
int  event_aggregator_ingest(const PulseEvent *event);

/*
 * Collect a consistent snapshot of current aggregates.  May be called
 * concurrently from multiple threads.
 *
 * Returns 0 on success, ‑1 on failure (errno set).
 */
int  event_aggregator_collect_snapshot(EventAggregateSnapshot *out_snapshot);

/*
 * Shut down the background aggregator thread and free all resources.
 * No other aggregator API may be used afterwards.
 */
void event_aggregator_shutdown(void);

/* -------------------------------------------------------------------------- */
/*                        Internal implementation details                     */
/* -------------------------------------------------------------------------- */

/* ---------- Lock-free bounded MPMC ring buffer --------------------------- */

typedef struct
{
    PulseEvent             evt;
    atomic_bool            ready; /* 1 when slot contains valid event         */
} RingSlot;

typedef struct
{
    RingSlot      *slots;
    size_t         capacity;  /* Power-of-two                                */
    atomic_size_t  head;      /* Next free slot for producers                */
    atomic_size_t  tail;      /* Next occupied slot for consumer             */
} EventRingBuffer;

/* Forward declarations */
static int  ring_init(EventRingBuffer *rb, size_t capacity);
static void ring_destroy(EventRingBuffer *rb);
static int  ring_push(EventRingBuffer *rb, const PulseEvent *evt); /* 0/-1 */
static int  ring_pop(EventRingBuffer *rb, PulseEvent *out_evt);    /* 0/-1 */

/* ---------- Aggregator state --------------------------------------------- */

typedef struct
{
    time_t   second;                        /* Bucket second (epoch)         */
    uint64_t type_counts[PULSE_TYPE_COUNT]; /* Counts within the second      */
} TimeBucket;

typedef struct
{
    EventRingBuffer queue;

    TimeBucket     *buckets;               /* window_seconds sized ring      */
    size_t          window_seconds;

    atomic_uint64_t global_counts[PULSE_TYPE_COUNT];

    pthread_t       thread;
    atomic_bool     running;

    /* Statistics */
    atomic_uint64_t dropped_events;
} AggregatorState;

static AggregatorState g_aggr = {0};

/* ---------- Utility ------------------------------------------------------ */

static inline uint64_t timestamp_sec(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec;
}

/* -------------------------------------------------------------------------- */
/*                             Ring-buffer code                               */
/* -------------------------------------------------------------------------- */

static int ring_init(EventRingBuffer *rb, size_t capacity)
{
    /* Require power-of-two capacity for mask magic */
    if (capacity < 2 || (capacity & (capacity - 1u)) != 0)
    {
        errno = EINVAL;
        return -1;
    }

    rb->slots = calloc(capacity, sizeof(RingSlot));
    if (!rb->slots)
        return -1;

    rb->capacity = capacity;
    atomic_init(&rb->head, 0u);
    atomic_init(&rb->tail, 0u);

    for (size_t i = 0; i < capacity; ++i)
        atomic_init(&rb->slots[i].ready, false);

    return 0;
}

static void ring_destroy(EventRingBuffer *rb)
{
    free(rb->slots);
    memset(rb, 0, sizeof(*rb));
}

static int ring_push(EventRingBuffer *rb, const PulseEvent *evt)
{
    size_t capacity = rb->capacity;
    size_t head     = atomic_load_explicit(&rb->head, memory_order_relaxed);
    size_t tail     = atomic_load_explicit(&rb->tail, memory_order_acquire);

    if ((head - tail) == capacity) /* Full */
        return -1;

    RingSlot *slot = &rb->slots[head & (capacity - 1u)];
    /* Wait until previous consumer marks slot as free (ready == false) */
    bool expected = false;
    while (!atomic_compare_exchange_weak_explicit(&slot->ready,
                                                  &expected,
                                                  true,
                                                  memory_order_release,
                                                  memory_order_relaxed))
    {
        expected = false;
    }

    slot->evt = *evt; /* Shallow copy (all POD) */

    atomic_store_explicit(&rb->head, head + 1, memory_order_release);
    return 0;
}

static int ring_pop(EventRingBuffer *rb, PulseEvent *out_evt)
{
    size_t capacity = rb->capacity;
    size_t tail     = atomic_load_explicit(&rb->tail, memory_order_relaxed);
    size_t head     = atomic_load_explicit(&rb->head, memory_order_acquire);

    if (tail == head) /* Empty */
        return -1;

    RingSlot *slot = &rb->slots[tail & (capacity - 1u)];
    if (!atomic_load_explicit(&slot->ready, memory_order_acquire))
        return -1; /* Inconsistent (shouldn’t happen) */

    *out_evt = slot->evt;

    atomic_store_explicit(&slot->ready, false, memory_order_release);
    atomic_store_explicit(&rb->tail, tail + 1, memory_order_release);
    return 0;
}

/* -------------------------------------------------------------------------- */
/*                        Aggregation thread                                  */
/* -------------------------------------------------------------------------- */

static void process_event(const PulseEvent *evt)
{
    AggregatorState *ag = &g_aggr;

    time_t ev_sec  = evt->ts;
    size_t idx     = (size_t)(ev_sec % ag->window_seconds);
    TimeBucket *b  = &ag->buckets[idx];

    /* If bucket corresponds to an older second, reset it before reuse */
    if (b->second != ev_sec)
    {
        /* Subtract old bucket counts from global totals */
        for (int t = 0; t < PULSE_TYPE_COUNT; ++t)
        {
            uint64_t old_count = b->type_counts[t];
            if (old_count)
            {
                atomic_fetch_sub_explicit(&ag->global_counts[t],
                                          old_count,
                                          memory_order_relaxed);
                b->type_counts[t] = 0;
            }
        }
        b->second = ev_sec;
    }

    /* Update bucket & global totals */
    b->type_counts[evt->type] += 1;
    atomic_fetch_add_explicit(&ag->global_counts[evt->type],
                              1,
                              memory_order_relaxed);
}

static void *aggregator_thread_fn(void *arg)
{
    (void)arg;
    PulseEvent evt;

    while (atomic_load_explicit(&g_aggr.running, memory_order_acquire))
    {
        int rc = ring_pop(&g_aggr.queue, &evt);
        if (rc == 0)
        {
            process_event(&evt);
        }
        else
        {
            /* Queue empty — sleep briefly to yield CPU */
            struct timespec ts = {.tv_sec = 0, .tv_nsec = 1000000}; /* 1 ms */
            nanosleep(&ts, NULL);
        }
    }

    /* Drain remaining events before exit */
    while (ring_pop(&g_aggr.queue, &evt) == 0)
        process_event(&evt);

    return NULL;
}

/* -------------------------------------------------------------------------- */
/*                         Public API implementation                          */
/* -------------------------------------------------------------------------- */

int event_aggregator_init(size_t window_seconds, size_t queue_capacity)
{
    if (window_seconds == 0)
    {
        errno = EINVAL;
        return -1;
    }

    memset(&g_aggr, 0, sizeof(g_aggr));

    if (ring_init(&g_aggr.queue, queue_capacity) != 0)
        return -1;

    g_aggr.window_seconds = window_seconds;
    g_aggr.buckets        = calloc(window_seconds, sizeof(TimeBucket));
    if (!g_aggr.buckets)
    {
        ring_destroy(&g_aggr.queue);
        return -1;
    }

    for (size_t i = 0; i < PULSE_TYPE_COUNT; ++i)
        atomic_init(&g_aggr.global_counts[i], 0);

    atomic_init(&g_aggr.dropped_events, 0);
    atomic_init(&g_aggr.running, true);

    /* Launch background aggregator thread */
    int rc = pthread_create(&g_aggr.thread,
                            NULL,
                            aggregator_thread_fn,
                            NULL);
    if (rc != 0)
    {
        errno = rc;
        free(g_aggr.buckets);
        ring_destroy(&g_aggr.queue);
        return -1;
    }

    return 0;
}

int event_aggregator_ingest(const PulseEvent *event)
{
    if (!event || event->type >= PULSE_TYPE_COUNT)
    {
        errno = EINVAL;
        return -1;
    }

    PulseEvent evt_copy = *event;

    /* If caller left ts == 0, stamp with now */
    if (evt_copy.ts == 0)
        evt_copy.ts = (time_t)timestamp_sec();

    if (!atomic_load_explicit(&g_aggr.running, memory_order_acquire))
    {
        errno = ECANCELED;
        return -1;
    }

    if (ring_push(&g_aggr.queue, &evt_copy) != 0)
    {
        /* Drop event */
        atomic_fetch_add_explicit(&g_aggr.dropped_events,
                                  1,
                                  memory_order_relaxed);
        errno = EAGAIN;
        return -1;
    }

    return 0;
}

int event_aggregator_collect_snapshot(EventAggregateSnapshot *out_snapshot)
{
    if (!out_snapshot)
    {
        errno = EINVAL;
        return -1;
    }

    for (int t = 0; t < PULSE_TYPE_COUNT; ++t)
    {
        out_snapshot->per_type[t] =
            atomic_load_explicit(&g_aggr.global_counts[t],
                                 memory_order_relaxed);
    }

    out_snapshot->generated_at = (time_t)timestamp_sec();
    return 0;
}

void event_aggregator_shutdown(void)
{
    if (!atomic_exchange_explicit(&g_aggr.running, false,
                                  memory_order_acq_rel))
        return; /* Already shutdown */

    pthread_join(g_aggr.thread, NULL);
    ring_destroy(&g_aggr.queue);
    free(g_aggr.buckets);
    memset(&g_aggr, 0, sizeof(g_aggr));
}

/* -------------------------------------------------------------------------- */
/*                          Test harness (optional)                           */
/* -------------------------------------------------------------------------- */
#ifdef EVENT_AGGREGATOR_SELFTEST
/*
 * Compile:
 *   cc -std=c11 -pthread -D EVENT_AGGREGATOR_SELFTEST event_aggregator.c -o test
 */
#include <unistd.h>

static void *producer_thread(void *arg)
{
    (void)arg;
    PulseEvent ev = {.type = PULSE_LIKE, .ts = 0};
    for (int i = 0; i < 50000; ++i)
    {
        ev.type = (PulseType)(i % PULSE_TYPE_COUNT);
        snprintf(ev.tag, sizeof(ev.tag), "tag-%d", i % 100);
        (void)event_aggregator_ingest(&ev);
    }
    return NULL;
}

int main(void)
{
    if (event_aggregator_init(10, 1024) != 0)
    {
        perror("init");
        return 1;
    }

    pthread_t prod[4];
    for (size_t i = 0; i < 4; ++i)
        pthread_create(&prod[i], NULL, producer_thread, NULL);

    for (int sec = 0; sec < 5; ++sec)
    {
        EventAggregateSnapshot snap;
        sleep(1);
        event_aggregator_collect_snapshot(&snap);
        printf("Snapshot @%ld:", snap.generated_at);
        for (int t = 0; t < PULSE_TYPE_COUNT; ++t)
            printf(" %lu", (unsigned long)snap.per_type[t]);
        putchar('\n');
    }

    for (size_t i = 0; i < 4; ++i)
        pthread_join(prod[i], NULL);

    event_aggregator_shutdown();
    return 0;
}
#endif
