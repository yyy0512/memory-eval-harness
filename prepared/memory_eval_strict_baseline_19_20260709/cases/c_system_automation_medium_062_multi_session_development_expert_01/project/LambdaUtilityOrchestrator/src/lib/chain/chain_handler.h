```c
/**
 * @file chain_handler.h
 * @author
 * @date 2024-06-11
 *
 * LambdaUtility Orchestrator – Chain-of-Responsibility core
 *
 * The chain handler is the plumbing that lets discrete Lambda “steps” be
 * composed at run-time into sophisticated automation pipelines.  Each link in
 * the chain is a small, stateless function that tries to “do its part”; if it
 * cannot, the request is propagated to the next handler.  This header exposes
 * the opaque type, life-cycle helpers, and the dispatch helper that climbs
 * the chain until the request is either handled or no handlers remain.
 *
 * Thread-safe by design: handlers are immutable after initialization, and each
 * invocation receives its own context object, so concurrent invocations can
 * share the same chain without additional synchronization.
 *
 *  ┌──────────────┐
 *  │ luo_command  │  <-- “what needs to be done”
 *  └──────────────┘
 *        │
 *        ▼
 *  ┌──────────────┐
 *  │ handler A    │──handled?──► result
 *  └──────────────┘
 *        │
 *   else ▼
 *  ┌──────────────┐
 *  │ handler B    │──handled?──► result
 *  └──────────────┘
 *        │
 *   else ▼    …etc.
 *
 * Copyright 2024
 * SPDX-License-Identifier: MIT
 */
#ifndef LUO_CHAIN_HANDLER_H
#define LUO_CHAIN_HANDLER_H

#ifdef __cplusplus
extern "C" {
#endif

/* ────────────────────────────────────────────────────────────────────────────
 * Standard headers
 * ────────────────────────────────────────────────────────────────────────── */
#include <stddef.h>   /* size_t */
#include <stdint.h>   /* uint32_t */
#include <stdbool.h>  /* bool   */
#include <stdlib.h>   /* malloc/free */
#include <string.h>   /* memset */
#include <errno.h>

/* ────────────────────────────────────────────────────────────────────────────
 * Forward declarations
 * ────────────────────────────────────────────────────────────────────────── */

/* Opaque command type produced by the dispatcher (see command.h) */
typedef struct luo_command   luo_command_t;

/* Each handler returns one of these status codes. */
typedef enum luo_chain_status {
    LUO_CHAIN_OK = 0,          /* Command was fully handled.                    */
    LUO_CHAIN_UNHANDLED = 1,   /* This handler could not handle; propagate.     */
    LUO_CHAIN_ERR = -1         /* A fatal error occurred.                       */
} luo_chain_status_t;

/* ────────────────────────────────────────────────────────────────────────────
 * Core handler type
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Internal context structure for a single link in the chain.
 * The struct is intentionally opaque to consumers—interactions are performed
 * exclusively through the API functions declared below.
 */
typedef struct luo_chain_handler {
    luo_chain_status_t (*handle)(struct luo_chain_handler    *self,
                                 const luo_command_t         *cmd,
                                 void                        *user_data);
    /* user_data is passed unmodified to the handle() callback */
    void  *user_data;

    /* Next link in the chain (NULL for end-of-chain) */
    struct luo_chain_handler *next;
} luo_chain_handler_t;

/* ────────────────────────────────────────────────────────────────────────────
 * Public API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * luo_chain_handler_create
 *
 * Allocate and initialize a new chain handler.  The returned object is heap
 * allocated and must be eventually released with luo_chain_handler_destroy().
 *
 * @param handle_cb A non-NULL callback that attempts to process the
 *                  luo_command_t.  The callback may return:
 *                    • LUO_CHAIN_OK        success
 *                    • LUO_CHAIN_UNHANDLED cannot handle – continue chain
 *                    • LUO_CHAIN_ERR       unrecoverable error
 * @param user_data Arbitrary pointer forwarded to `handle_cb`.
 *
 * @return Newly allocated handler or NULL on allocation failure.
 */
static inline luo_chain_handler_t *
luo_chain_handler_create(
        luo_chain_status_t (*handle_cb)(luo_chain_handler_t *self,
                                        const luo_command_t *cmd,
                                        void *user_data),
        void *user_data)
{
    if (!handle_cb) {
        errno = EINVAL;
        return NULL;
    }

    luo_chain_handler_t *h = (luo_chain_handler_t *)calloc(1, sizeof(*h));
    if (!h) {
        /* errno already set by calloc */
        return NULL;
    }

    h->handle    = handle_cb;
    h->user_data = user_data;
    h->next      = NULL;

    return h;
}

/**
 * luo_chain_handler_destroy
 *
 * Recursively frees a chain starting from `handler`.  If you only want to
 * remove a single link without touching the remainder, unlink it first.
 *
 * Thread Safety: caller must ensure no concurrent invocations are in flight.
 */
static inline void
luo_chain_handler_destroy(luo_chain_handler_t *handler)
{
    while (handler) {
        luo_chain_handler_t *next = handler->next;
        free(handler);
        handler = next;
    }
}

/**
 * luo_chain_handler_append
 *
 * Append `next` to the end of `chain_head`.  Ownership of `next` transfers to
 * the chain.  Both parameters must be non-NULL.
 *
 * Complexity: O(N) where N is the current chain length.
 *
 * Returns 0 on success, -1 on error (errno set).
 */
static inline int
luo_chain_handler_append(luo_chain_handler_t *chain_head,
                         luo_chain_handler_t *next)
{
    if (!chain_head || !next) {
        errno = EINVAL;
        return -1;
    }

    luo_chain_handler_t *it = chain_head;
    while (it->next) {
        it = it->next;
    }
    it->next = next;
    return 0;
}

/**
 * luo_chain_handle
 *
 * Walk the chain starting at `chain_head`, feeding the command into each link
 * until one claims it handled the request or an error is reported.
 *
 * The traversal stops at the first handler that returns something other than
 * LUO_CHAIN_UNHANDLED.
 *
 * @param chain_head Non-NULL head of the chain.
 * @param cmd        Non-NULL command to process.
 *
 * @return LUO_CHAIN_OK if handled,
 *         LUO_CHAIN_UNHANDLED if no handler took responsibility,
 *         LUO_CHAIN_ERR if any handler reported a fatal condition.
 */
static inline luo_chain_status_t
luo_chain_handle(luo_chain_handler_t *chain_head,
                 const luo_command_t *cmd)
{
    if (!chain_head || !cmd) {
        return LUO_CHAIN_ERR;
    }

    luo_chain_handler_t *cur = chain_head;
    while (cur) {
        luo_chain_status_t rc = cur->handle(cur, cmd, cur->user_data);
        if (rc != LUO_CHAIN_UNHANDLED) {
            return rc; /* handled or fatal */
        }
        cur = cur->next;
    }
    return LUO_CHAIN_UNHANDLED; /* nobody claimed it */
}

/**
 * luo_chain_length
 *
 * Utility: counts links in the chain (for diagnostics, telemetry, tests).
 */
static inline size_t
luo_chain_length(const luo_chain_handler_t *chain_head)
{
    size_t n = 0;
    for (const luo_chain_handler_t *it = chain_head; it; it = it->next) {
        ++n;
    }
    return n;
}

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* LUO_CHAIN_HANDLER_H */
```