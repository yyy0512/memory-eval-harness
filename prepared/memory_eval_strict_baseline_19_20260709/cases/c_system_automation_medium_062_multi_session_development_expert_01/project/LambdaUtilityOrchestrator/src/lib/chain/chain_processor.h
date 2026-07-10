/*
 *  LambdaUtility Orchestrator
 *  chain_processor.h  (header-only implementation)
 *
 *  This module provides a small, dependency-free Chain-of-Responsibility
 *  utility used throughout the LambdaUtility Orchestrator to chain
 *  together discrete “Lambda-style” commands at run time.
 *
 *  Usage:
 *      #define LUO_CHAIN_PROCESSOR_IMPLEMENTATION
 *      #include "chain_processor.h"
 *
 *      or, to merely include the declarations:
 *      #include "chain_processor.h"
 *
 *  The implementation is released under MIT license.
 */

#ifndef LUO_CHAIN_PROCESSOR_H
#define LUO_CHAIN_PROCESSOR_H

/* ───── Standard Library ──────────────────────────────────────────────── */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ───── Optional Debug Logging ──────────────────────────────────────────
 * Define LUO_CHAIN_TRACE to enable very chatty logging.
 * Define LUO_CHAIN_DEBUG to enable moderate logging.
 * By default, logging is compiled out.
 */
#if defined(LUO_CHAIN_TRACE) || defined(LUO_CHAIN_DEBUG)
#include <time.h>
static inline void _luo_log(const char *lvl,
                            const char *file,
                            int line,
                            const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);

    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    fprintf(stderr,
            "[%ld.%03ld] luo/%s %s:%d: ",
            ts.tv_sec,
            ts.tv_nsec / 1000000,
            lvl,
            file,
            line);
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");

    va_end(ap);
}
#   define LUO_LOG_TRACE(...) _luo_log("TRACE", __FILE__, __LINE__, __VA_ARGS__)
#   define LUO_LOG_DEBUG(...) _luo_log("DEBUG", __FILE__, __LINE__, __VA_ARGS__)
#else
#   define LUO_LOG_TRACE(...) ((void)0)
#   define LUO_LOG_DEBUG(...) ((void)0)
#endif /* logging */

/* ───── Result / Status codes ─────────────────────────────────────────── */
typedef enum luo_status {
    LUO_STATUS_OK      = 0,   /* successful execution                       */
    LUO_STATUS_FAIL    = 1,   /* unrecoverable failure, abort the chain     */
    LUO_STATUS_RETRY   = 2,   /* temporary failure, caller may retry later  */
    LUO_STATUS_SKIP    = 3,   /* handled but intentionally skipped          */
    LUO_STATUS_INVALID = 4    /* invalid arguments or configuration         */
} luo_status_t;

/* ───── Forward declarations ─────────────────────────────────────────── */
typedef struct luo_command     luo_command_t;
typedef struct luo_chain       luo_chain_t;

/* ───── Command “interface” ─────────────────────────────────────────────
 * execute()
 *   Must perform the command’s job and return a luo_status_t.
 *   'event_payload' is the opaque JSON or CBOR event payload that
 *   triggered the command.  'userdata' is whatever was passed to the
 *   chain during execution—often a per-invocation struct.
 *
 * cleanup()
 *   Called exactly once when a command is evicted from a chain or when
 *   the chain is destroyed.  Implementations must release any resources
 *   owned by the command.
 */
typedef luo_status_t (*luo_command_exec_fn)(luo_command_t *self,
                                            void           *event_payload,
                                            void           *userdata);

typedef void         (*luo_command_cleanup_fn)(luo_command_t *self);

/* ───── Command object ───────────────────────────────────────────────── */
struct luo_command {
    luo_command_exec_fn    execute;
    luo_command_cleanup_fn cleanup;
    void                  *ctx;      /* implementation-specific context     */
    luo_command_t         *next;     /* chain linkage                       */
};

/* ───── Chain object ─────────────────────────────────────────────────── */
struct luo_chain {
    luo_command_t *head;
    luo_command_t *tail;
    size_t         length;
};

/* ───── Public API ───────────────────────────────────────────────────── */
#ifdef __cplusplus
extern "C" {
#endif

/*
 * luo_command_init()
 * Initialize an already-allocated luo_command_t.
 * The command will NOT be freed automatically; caller decides lifetime.
 */
static inline luo_status_t
luo_command_init(luo_command_t           *command,
                 luo_command_exec_fn      exec_cb,
                 luo_command_cleanup_fn   cleanup_cb,
                 void                   *ctx)
{
    if (!command || !exec_cb) {
        return LUO_STATUS_INVALID;
    }

    command->execute = exec_cb;
    command->cleanup = cleanup_cb;
    command->ctx     = ctx;
    command->next    = NULL;

    return LUO_STATUS_OK;
}

/*
 * luo_chain_create() / luo_chain_destroy()
 * Allocate and destroy a chain container.
 */
luo_chain_t *
luo_chain_create(void);

void
luo_chain_destroy(luo_chain_t *chain);

/*
 * luo_chain_add()
 * Append 'command' to the end of the chain. The chain takes ownership of
 * the command pointer and will invoke command->cleanup() during teardown.
 *
 * Returns:
 *   LUO_STATUS_OK       success
 *   LUO_STATUS_INVALID  bad args
 *   LUO_STATUS_FAIL     allocation failure
 */
luo_status_t
luo_chain_add(luo_chain_t *chain, luo_command_t *command);

/*
 * luo_chain_execute()
 * Execute the chain left-to-right. If a command returns LUO_STATUS_FAIL,
 * execution stops immediately and the failure is propagated back to the
 * caller. If it returns LUO_STATUS_RETRY, the chain stops and propagates
 * the retry status. Any other non-OK status also aborts the chain.
 *
 * Returns the status from the FIRST non-LUO_STATUS_OK command, or
 * LUO_STATUS_OK if all commands succeed.
 */
luo_status_t
luo_chain_execute(luo_chain_t *chain,
                  void        *event_payload,
                  void        *userdata);

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ───── Implementation ──────────────────────────────────────────────── */
#ifdef LUO_CHAIN_PROCESSOR_IMPLEMENTATION

/* Internal helper: free command list */
static void
_luo_free_command_list(luo_command_t *cmd)
{
    while (cmd) {
        luo_command_t *next = cmd->next;

        if (cmd->cleanup) {
            LUO_LOG_TRACE("Cleaning up command %p", (void *)cmd);
            cmd->cleanup(cmd);
        }

        free(cmd);
        cmd = next;
    }
}

luo_chain_t *
luo_chain_create(void)
{
    luo_chain_t *chain = (luo_chain_t *)calloc(1, sizeof(luo_chain_t));
    if (!chain) {
        return NULL;
    }

    chain->head   = NULL;
    chain->tail   = NULL;
    chain->length = 0;

    LUO_LOG_DEBUG("Created new chain %p", (void *)chain);
    return chain;
}

void
luo_chain_destroy(luo_chain_t *chain)
{
    if (!chain) { return; }

    _luo_free_command_list(chain->head);
    LUO_LOG_DEBUG("Destroyed chain %p", (void *)chain);
    free(chain);
}

luo_status_t
luo_chain_add(luo_chain_t *chain, luo_command_t *command)
{
    if (!chain || !command) {
        return LUO_STATUS_INVALID;
    }

    /* Ensure the command is not already part of another chain */
    command->next = NULL;

    if (!chain->head) {
        chain->head = chain->tail = command;
    } else {
        chain->tail->next = command;
        chain->tail       = command;
    }

    chain->length++;

    LUO_LOG_DEBUG("Added command %p to chain %p (len=%zu)",
                  (void *)command, (void *)chain, chain->length);

    return LUO_STATUS_OK;
}

luo_status_t
luo_chain_execute(luo_chain_t *chain,
                  void        *event_payload,
                  void        *userdata)
{
    if (!chain) {
        return LUO_STATUS_INVALID;
    }

    luo_status_t overall_status = LUO_STATUS_OK;
    luo_command_t *current = chain->head;

    size_t step = 0;
    while (current) {
        LUO_LOG_DEBUG("Executing command #%zu %p", step, (void *)current);

        luo_status_t rc = current->execute(current, event_payload, userdata);
        LUO_LOG_TRACE("Command #%zu returned %d", step, rc);

        if (rc != LUO_STATUS_OK) {
            overall_status = rc;
            break;
        }

        current = current->next;
        ++step;
    }

    return overall_status;
}

#endif /* LUO_CHAIN_PROCESSOR_IMPLEMENTATION */
#endif /* LUO_CHAIN_PROCESSOR_H */
