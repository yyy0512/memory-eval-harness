/**
 * @file chain_processor.c
 * @author
 * @brief Implementation of the chain-of-responsibility processor used by
 *        LambdaUtility Orchestrator (system_automation).
 *
 * This module allows LambdaUtility Orchestrator to wire a series of
 * Command-pattern handlers together at runtime, passing an event payload
 * through the chain until one of the handlers claims responsibility or an
 * error occurs.  The processor is thread-safe and designed for the short-lived
 * execution model of serverless functions.
 *
 * Each handler must implement the `Command` interface declared in
 * `command.h`.  The life-cycle contract is:
 *
 *   1. The caller allocates/initialises a `Command` concrete
 *      implementation and adds it to a `chain_processor_t` instance with
 *      `chain_processor_add_handler()`.
 *   2. Ownership of the handler is transferred to the chain.  The handler
 *      will be `destroy()`-ed automatically when the chain is destroyed.
 *   3. When `chain_processor_execute()` is called, every handler’s
 *      `execute()` method is invoked in FIFO order until one returns
 *      CHAIN_STOP or CHAIN_ERR.
 *
 * The processor maintains coarse metrics that can be shipped to the
 * project’s central metrics Lambda: total execution time, per-handler
 * latency, and overall result code.
 *
 * Compile flags required (example):
 *   gcc -Wall -Wextra -pedantic -pthread -I./include -c chain_processor.c
 */

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "chain_processor.h"  /* Public interface for this module   */
#include "command.h"          /* Command pattern interface          */
#include "logger.h"           /* Project-wide logging abstraction   */
#include "metrics.h"          /* Lightweight metrics reporter       */

/* --------------------------------------------------------------------------
 * Internal helpers & data structures
 * -------------------------------------------------------------------------- */

/* One handler inside the linked list chain */
typedef struct chain_node {
    Command               *handler;
    struct chain_node     *next;
} chain_node_t;

/* Private implementation of the chain processor */
struct chain_processor {
    chain_node_t  *head;
    chain_node_t  *tail;
    pthread_mutex_t mtx;         /* Synchronise add/execute/destroy */
    int             sealed;      /* When true, handlers can no longer be added */
    char           *name;        /* Optional identifier for debugging */
};

/* Convenience macro for clock_gettime */
#define NOW(clock_ts) clock_gettime(CLOCK_MONOTONIC, &(clock_ts))

/* --------------------------------------------------------------------------
 * Utility functions
 * -------------------------------------------------------------------------- */

/* Calculate difference, in microseconds, between two timespec values */
static uint64_t
diff_us(const struct timespec *start, const struct timespec *end)
{
    time_t  sec  = end->tv_sec  - start->tv_sec;
    long    nsec = end->tv_nsec - start->tv_nsec;

    if (nsec < 0) {
        nsec += 1000000000L;
        --sec;
    }
    uint64_t micro = (uint64_t)sec * 1000000ULL + (uint64_t)(nsec / 1000L);
    return micro;
}

/* Safely free a chain_node_t (invokes handler->destroy). */
static void
free_chain_node(chain_node_t *node)
{
    if (!node) return;

    if (node->handler && node->handler->destroy) {
        node->handler->destroy(node->handler);
    }
    free(node);
}

/* --------------------------------------------------------------------------
 * Public API implementation
 * -------------------------------------------------------------------------- */

chain_processor_t *
chain_processor_create(const char *name)
{
    chain_processor_t *proc = calloc(1, sizeof(*proc));
    if (!proc) {
        log_error("chain_processor_create: out of memory allocating processor '%s'", name ?: "<unnamed>");
        return NULL;
    }

    int rc = pthread_mutex_init(&proc->mtx, NULL);
    if (rc != 0) {
        log_error("chain_processor_create: unable to init mutex (%s)", strerror(rc));
        free(proc);
        return NULL;
    }

    if (name) {
        proc->name = strdup(name);
    }

    return proc;
}

int
chain_processor_add_handler(chain_processor_t *proc, Command *handler)
{
    if (!proc || !handler) {
        errno = EINVAL;
        return -1;
    }

    int rc = pthread_mutex_lock(&proc->mtx);
    if (rc != 0) {
        errno = rc;
        return -1;
    }

    if (proc->sealed) {
        pthread_mutex_unlock(&proc->mtx);
        log_warn("chain_processor_add_handler: processor '%s' already sealed; cannot add handler",
                 proc->name ?: "<unnamed>");
        errno = EPERM;
        return -1;
    }

    chain_node_t *node = calloc(1, sizeof(*node));
    if (!node) {
        pthread_mutex_unlock(&proc->mtx);
        errno = ENOMEM;
        return -1;
    }
    node->handler = handler;

    if (!proc->head) {
        proc->head = proc->tail = node;
    } else {
        proc->tail->next = node;
        proc->tail = node;
    }

    pthread_mutex_unlock(&proc->mtx);
    return 0;
}

int
chain_processor_execute(chain_processor_t *proc,
                        void *event_payload,
                        const chain_exec_opts_t *opts)
{
    if (!proc) {
        errno = EINVAL;
        return CHAIN_ERR;
    }

    /* Prevent concurrent modification while we are executing.           */
    int rc = pthread_mutex_lock(&proc->mtx);
    if (rc != 0) {
        errno = rc;
        return CHAIN_ERR;
    }

    proc->sealed = 1;  /* No more handlers can be added from now on */

    chain_node_t         *cursor = proc->head;
    chain_result_t        final_result = CHAIN_OK;
    uint32_t              handler_index = 0;

    struct timespec exec_start, exec_end;
    NOW(exec_start);

    while (cursor) {

        if (opts && opts->timeout_ms > 0) {
            struct timespec now;
            NOW(now);
            uint64_t elapsed_us = diff_us(&exec_start, &now);
            if (elapsed_us / 1000ULL >= opts->timeout_ms) {
                log_error("chain_processor_execute: timeout (%u ms) hit after %u handlers",
                          opts->timeout_ms, handler_index);
                final_result = CHAIN_ERR;
                break;
            }
        }

        struct timespec h_start, h_end;
        NOW(h_start);

        chain_result_t r = CHAIN_OK;
        if (cursor->handler && cursor->handler->execute) {
            r = cursor->handler->execute(cursor->handler,
                                         event_payload,
                                         opts ? opts->user_data : NULL);
        } else {
            log_warn("chain_processor_execute: handler #%u in '%s' is NULL or missing execute()",
                     handler_index, proc->name ?: "<unnamed>");
        }

        NOW(h_end);

        uint64_t latency = diff_us(&h_start, &h_end);

        /* Push latency to central metrics */
        metrics_record_handler_latency(proc->name ?: "default_chain",
                                       handler_index,
                                       latency);

        log_debug("chain_processor_execute: handler #%u finished in %lums (result=%d)",
                  handler_index, latency / 1000UL, r);

        ++handler_index;

        if (r == CHAIN_STOP) {
            final_result = CHAIN_OK;
            break;
        } else if (r == CHAIN_ERR) {
            final_result = CHAIN_ERR;
            break;
        }

        cursor = cursor->next;
    }

    NOW(exec_end);

    uint64_t total_latency = diff_us(&exec_start, &exec_end);
    metrics_record_chain_latency(proc->name ?: "default_chain", total_latency);

    log_info("chain_processor_execute: chain '%s' completed in %.2fms (handlers=%u, result=%d)",
             proc->name ?: "<unnamed>",
             total_latency / 1000.0,
             handler_index,
             final_result);

    pthread_mutex_unlock(&proc->mtx);
    return final_result;
}

void
chain_processor_destroy(chain_processor_t *proc)
{
    if (!proc) {
        return;
    }

    pthread_mutex_lock(&proc->mtx);

    chain_node_t *node = proc->head;
    while (node) {
        chain_node_t *next = node->next;
        free_chain_node(node);
        node = next;
    }

    pthread_mutex_unlock(&proc->mtx);
    pthread_mutex_destroy(&proc->mtx);

    if (proc->name) {
        free(proc->name);
    }
    free(proc);
}

/* --------------------------------------------------------------------------
 * Unit-test hooks (compiled only in test builds)
 * -------------------------------------------------------------------------- */
#ifdef CHAIN_PROCESSOR_TESTING

#include "unity.h" /* Example test framework */

static int dummy_execute(Command *self, void *payload, void *user_data)
{
    (void)self; (void)payload; (void)user_data;
    return CHAIN_OK;
}

static void dummy_destroy(Command *self) { free(self); }

void test_chain_ok(void)
{
    chain_processor_t *proc = chain_processor_create("test_chain");
    TEST_ASSERT_NOT_NULL(proc);

    for (int i = 0; i < 3; ++i) {
        Command *cmd = calloc(1, sizeof(Command));
        cmd->execute = dummy_execute;
        cmd->destroy = dummy_destroy;
        TEST_ASSERT_EQUAL_INT(0, chain_processor_add_handler(proc, cmd));
    }

    chain_exec_opts_t opts = { .timeout_ms = 1000, .user_data = NULL };
    TEST_ASSERT_EQUAL_INT(CHAIN_OK, chain_processor_execute(proc, NULL, &opts));
    chain_processor_destroy(proc);
}

#endif /* CHAIN_PROCESSOR_TESTING */
