/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * -----------------------------------------------------
 * File:    pulsesphere/services/analytics_sink_service/src/batch_manager.c
 * License: Apache 2.0
 *
 * Batch Manager
 * -------------
 * Responsible for aggregating immutable pulse events into fault-tolerant,
 * time-based windows, reconciling late / out-of-order arrivals, and streaming
 * ready batches to downstream analytical sinks.  A dedicated background thread
 * ensures windows are flushed once they are complete while guaranteeing that
 * events arriving within an “allowed-lateness” grace period are still honoured.
 *
 * The API is thread-safe and optimised for high-throughput ingestion paths.
 */

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

/* -------------------------------------------------------------------------- */
/*                                 Logging API                                */
/* -------------------------------------------------------------------------- */

#ifndef BM_LOG_LEVEL
#define BM_LOG_LEVEL 2 /* 0=OFF 1=ERROR 2=INFO 3=DEBUG */
#endif

static inline void bm_log(int level, const char *fmt, ...) {
    if (level > BM_LOG_LEVEL) {
        return;
    }
    static const char *lvlstr[] = {"OFF", "ERR", "INF", "DBG"};
    char buff[64];
    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm t;
    localtime_r(&tv.tv_sec, &t);
    strftime(buff, sizeof(buff), "%Y-%m-%d %H:%M:%S", &t);

    fprintf(stderr, "[%s.%03ld] [%s] ", buff, tv.tv_usec / 1000, lvlstr[level]);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

/* -------------------------------------------------------------------------- */
/*                              Data Definitions                              */
/* -------------------------------------------------------------------------- */

/* Immutable social pulse */
typedef struct pulse_event {
    uint64_t id;             /* Globally unique event id */
    int64_t  ts_ms;          /* Event time (epoch-millis) */
    char     type[16];       /* e.g. LIKE, COMMENT, ...   */
    char     payload[256];   /* JSON blob or opaque bytes */
} pulse_event_t;

/* Forward declarations */
struct batch_window;
typedef struct batch_window batch_window_t;

/* Linked list node holding an event */
typedef struct event_node {
    pulse_event_t            ev;
    struct event_node       *next;
} event_node_t;

/* Batch window for a fixed time interval */
struct batch_window {
    int64_t         start_ms;
    int64_t         end_ms;
    size_t          count;
    event_node_t   *head;
    event_node_t   *tail;
    batch_window_t *next;
};

/* Callback used to push a complete window to the downstream sink */
typedef int (*sink_fn_t)(const pulse_event_t *events, size_t count,
                         int64_t window_start_ms, int64_t window_end_ms);

/* Batch manager handle */
typedef struct batch_manager {
    /* Configuration */
    int64_t    window_size_ms;
    int64_t    allowed_lateness_ms;
    sink_fn_t  sink_cb;

    /* Runtime state */
    batch_window_t *windows_head; /* Sorted by start_ms */
    pthread_mutex_t mtx;
    pthread_cond_t  cv;
    bool            shutdown;
    pthread_t       flusher_tid;
} batch_manager_t;

/* -------------------------------------------------------------------------- */
/*                          Time Utility Functions                            */
/* -------------------------------------------------------------------------- */

/* Get current epoch-milliseconds */
static inline int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return ((int64_t)ts.tv_sec * 1000ll) + (ts.tv_nsec / 1000000ll);
}

/* Align a timestamp to the start of its window */
static inline int64_t align_to_window(int64_t epoch_ms, int64_t window_ms) {
    return epoch_ms - (epoch_ms % window_ms);
}

/* -------------------------------------------------------------------------- */
/*                      Internal Memory Management Helpers                    */
/* -------------------------------------------------------------------------- */

static event_node_t *event_node_new(const pulse_event_t *ev) {
    event_node_t *node = (event_node_t *)malloc(sizeof(*node));
    if (!node) {
        bm_log(1, "OOM: unable to allocate event node");
        return NULL;
    }
    node->ev = *ev; /* struct copy (immutable) */
    node->next = NULL;
    return node;
}

static void event_list_free(event_node_t *head) {
    while (head) {
        event_node_t *tmp = head;
        head = head->next;
        free(tmp);
    }
}

static batch_window_t *batch_window_new(int64_t start_ms, int64_t window_ms) {
    batch_window_t *bw = (batch_window_t *)calloc(1, sizeof(*bw));
    if (!bw) {
        bm_log(1, "OOM: unable to allocate batch window");
        return NULL;
    }
    bw->start_ms = start_ms;
    bw->end_ms   = start_ms + window_ms;
    return bw;
}

static void batch_window_free(batch_window_t *bw) {
    if (!bw) return;
    event_list_free(bw->head);
    free(bw);
}

/* -------------------------------------------------------------------------- */
/*                      Window List Management Routines                       */
/* -------------------------------------------------------------------------- */

/* Find or create window that an event belongs to */
static batch_window_t *
window_get_or_create(batch_manager_t *bm, int64_t window_start_ms) {

    batch_window_t *prev = NULL;
    batch_window_t *cur  = bm->windows_head;

    while (cur && cur->start_ms < window_start_ms) {
        prev = cur;
        cur  = cur->next;
    }

    if (cur && cur->start_ms == window_start_ms) {
        return cur; /* Found */
    }

    /* Not found -> allocate new */
    batch_window_t *new_win = batch_window_new(window_start_ms,
                                               bm->window_size_ms);
    if (!new_win) return NULL;

    /* Insert into sorted list */
    if (!prev) {
        new_win->next     = bm->windows_head;
        bm->windows_head  = new_win;
    } else {
        new_win->next = prev->next;
        prev->next    = new_win;
    }
    return new_win;
}

/* Remove and return first window if it is ready to be flushed */
static batch_window_t *
window_pop_ready(batch_manager_t *bm, int64_t now) {

    if (!bm->windows_head) return NULL;

    batch_window_t *head = bm->windows_head;
    if (head->end_ms + bm->allowed_lateness_ms <= now) {
        bm->windows_head = head->next;
        head->next = NULL;
        return head;
    }
    return NULL;
}

/* -------------------------------------------------------------------------- */
/*                      Sink Invocation and Window Flush                      */
/* -------------------------------------------------------------------------- */

static void flush_window_to_sink(batch_manager_t *bm, batch_window_t *bw) {
    if (!bw || bw->count == 0) {
        batch_window_free(bw);
        return;
    }

    /* Consolidate into contiguous buffer for efficient sink push */
    pulse_event_t *buffer = (pulse_event_t *)malloc(sizeof(pulse_event_t) *
                                                    bw->count);
    if (!buffer) {
        bm_log(1, "OOM: failed to allocate flush buffer (count=%zu)", bw->count);
        batch_window_free(bw);
        return;
    }

    event_node_t *node = bw->head;
    size_t idx = 0;
    while (node) {
        buffer[idx++] = node->ev;
        node = node->next;
    }

    /* Call user-defined sink */
    int rc = bm->sink_cb(buffer, bw->count, bw->start_ms, bw->end_ms);
    if (rc != 0) {
        bm_log(1, "sink callback returned error=%d (start=%" PRId64 ")", rc,
               bw->start_ms);
        /* In production we might retry or persist batch for manual recovery */
    } else {
        bm_log(2, "flushed window [%" PRId64 " - %" PRId64 "] (%zu events)",
               bw->start_ms, bw->end_ms, bw->count);
    }

    free(buffer);
    batch_window_free(bw);
}

/* -------------------------------------------------------------------------- */
/*                       Background Flusher Thread Logic                      */
/* -------------------------------------------------------------------------- */

static void *flusher_thread_main(void *arg) {
    batch_manager_t *bm = (batch_manager_t *)arg;
    const int64_t sleep_fallback_ms = bm->window_size_ms / 2;

    pthread_mutex_lock(&bm->mtx);
    while (!bm->shutdown) {
        int64_t now = now_ms();
        batch_window_t *ready = window_pop_ready(bm, now);

        if (ready) {
            /* flush outside mutex to minimise contention */
            pthread_mutex_unlock(&bm->mtx);
            flush_window_to_sink(bm, ready);
            pthread_mutex_lock(&bm->mtx);
            continue; /* check next */
        }

        /* Determine how long to wait:
         *  - until first window becomes flushable
         *  - or fallback value if no windows present
         */
        int64_t wait_ms;
        if (bm->windows_head) {
            int64_t target = bm->windows_head->end_ms +
                             bm->allowed_lateness_ms;
            wait_ms = target - now;
            if (wait_ms < 0) wait_ms = 0; /* already overdue, process soon */
        } else {
            wait_ms = sleep_fallback_ms;
        }

        /* Convert to timespec for timedwait */
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec  += wait_ms / 1000;
        ts.tv_nsec += (wait_ms % 1000) * 1000000ll;
        if (ts.tv_nsec >= 1000000000ll) {
            ts.tv_sec += 1;
            ts.tv_nsec -= 1000000000ll;
        }

        pthread_cond_timedwait(&bm->cv, &bm->mtx, &ts);
    }
    pthread_mutex_unlock(&bm->mtx);
    return NULL;
}

/* -------------------------------------------------------------------------- */
/*                          Public API Implementation                         */
/* -------------------------------------------------------------------------- */

/* Initialize Batch Manager */
int batch_manager_init(batch_manager_t      *bm,
                       int64_t               window_size_ms,
                       int64_t               allowed_lateness_ms,
                       sink_fn_t             sink_cb) {

    if (!bm || !sink_cb || window_size_ms <= 0 || allowed_lateness_ms < 0) {
        return EINVAL;
    }

    memset(bm, 0, sizeof(*bm));
    bm->window_size_ms       = window_size_ms;
    bm->allowed_lateness_ms  = allowed_lateness_ms;
    bm->sink_cb              = sink_cb;

    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_ADAPTIVE_NP);
    pthread_mutex_init(&bm->mtx, &attr);
    pthread_mutexattr_destroy(&attr);
    pthread_cond_init(&bm->cv, NULL);

    /* Start flusher thread */
    if (pthread_create(&bm->flusher_tid, NULL, flusher_thread_main, bm) != 0) {
        return errno ? errno : -1;
    }
    return 0;
}

/* Gracefully shut down Batch Manager */
void batch_manager_shutdown(batch_manager_t *bm) {
    if (!bm) return;

    pthread_mutex_lock(&bm->mtx);
    bm->shutdown = true;
    pthread_cond_broadcast(&bm->cv);
    pthread_mutex_unlock(&bm->mtx);

    pthread_join(bm->flusher_tid, NULL);

    /* Flush remaining windows */
    pthread_mutex_lock(&bm->mtx);
    batch_window_t *cur = bm->windows_head;
    bm->windows_head = NULL;
    pthread_mutex_unlock(&bm->mtx);

    while (cur) {
        batch_window_t *next = cur->next;
        flush_window_to_sink(bm, cur);
        cur = next;
    }

    pthread_mutex_destroy(&bm->mtx);
    pthread_cond_destroy(&bm->cv);
}

/* Offer a new event to the batch manager (thread-safe) */
int batch_manager_offer_event(batch_manager_t *bm, const pulse_event_t *ev) {
    if (!bm || !ev) return EINVAL;

    int64_t wstart = align_to_window(ev->ts_ms, bm->window_size_ms);

    pthread_mutex_lock(&bm->mtx);
    batch_window_t *win = window_get_or_create(bm, wstart);
    if (!win) {
        pthread_mutex_unlock(&bm->mtx);
        return ENOMEM;
    }

    event_node_t *node = event_node_new(ev);
    if (!node) {
        pthread_mutex_unlock(&bm->mtx);
        return ENOMEM;
    }

    /* Append to window’s event list */
    if (!win->head) {
        win->head = win->tail = node;
    } else {
        win->tail->next = node;
        win->tail = node;
    }
    win->count++;

    /* Signal flusher thread if window might be ready (optimistic) */
    int64_t now = now_ms();
    if (win->end_ms + bm->allowed_lateness_ms <= now) {
        pthread_cond_signal(&bm->cv);
    }
    pthread_mutex_unlock(&bm->mtx);
    return 0;
}

/* Force flush of all windows (e.g., during service rotate) */
void batch_manager_force_flush(batch_manager_t *bm) {
    if (!bm) return;
    pthread_mutex_lock(&bm->mtx);
    pthread_cond_signal(&bm->cv); /* wake flusher */
    pthread_mutex_unlock(&bm->mtx);
}

/* -------------------------------------------------------------------------- */
/*                              Example Sink (Mock)                           */
/* -------------------------------------------------------------------------- */

#ifdef BATCH_MANAGER_TEST_MAIN
/* Simple sink that prints event counts */
static int mock_sink(const pulse_event_t *events, size_t n,
                     int64_t start_ms, int64_t end_ms) {

    (void) events; /* silence unused warning */
    bm_log(2, "MOCK-SINK  window[%" PRId64 " - %" PRId64 "], n=%zu",
           start_ms, end_ms, n);
    return 0;
}

static void produce_events(batch_manager_t *bm, int total) {
    for (int i = 0; i < total; ++i) {
        pulse_event_t ev = {
            .id = (uint64_t)i,
            .ts_ms = now_ms() - (rand() % 5000), /* some late events */
        };
        snprintf(ev.type, sizeof(ev.type), "LIKE");
        snprintf(ev.payload, sizeof(ev.payload), "{\"index\":%d}", i);
        batch_manager_offer_event(bm, &ev);
        usleep(10000); /* 10ms */
    }
}

int main(void) {
    batch_manager_t bm;
    batch_manager_init(&bm,            /* handle */
                       1000,           /* 1 second window */
                       2000,           /* 2 second lateness allowance */
                       mock_sink);     /* sink cb */

    produce_events(&bm, 100);
    sleep(5); /* give time to flush */

    batch_manager_shutdown(&bm);
    return 0;
}
#endif /* BATCH_MANAGER_TEST_MAIN */

/* -------------------------------------------------------------------------- */
/*                                   EOF                                      */
/* -------------------------------------------------------------------------- */
