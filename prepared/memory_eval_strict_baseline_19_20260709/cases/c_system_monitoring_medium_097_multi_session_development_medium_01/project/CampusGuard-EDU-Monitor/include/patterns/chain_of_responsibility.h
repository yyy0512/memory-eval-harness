#ifndef CAMPUS_GUARD_EDU_MONITOR_PATTERNS_CHAIN_OF_RESPONSIBILITY_H
#define CAMPUS_GUARD_EDU_MONITOR_PATTERNS_CHAIN_OF_RESPONSIBILITY_H
/*
 * CampusGuard EDU Monitor
 * Chain-of-Responsibility Pattern (generic utilities)
 *
 * This header provides a small, self-contained implementation of a
 * thread-safe Chain-of-Responsibility that is used throughout the
 * CampusGuard monitoring suite.  Controllers push CG_Request objects
 * into the chain; each handler inspects the request and either:
 *
 *   1.  handles it (return CG_HANDLER_OK)
 *   2.  propagates it further down the chain (return CG_HANDLER_PASS)
 *   3.  stops the chain due to an error (return CG_HANDLER_ERR or < 0)
 *
 * Although the implementation is generic, concrete handlers such as
 * “PermissionValidator”, “JobQueue”, or “MeshDispatcher” are defined in
 * their respective modules and plugged into a chain at runtime.
 *
 * This file is intentionally header-only to simplify distribution in an
 * educational setting.  Define CG_COR_STATIC for static linkage, or
 * leave undefined for inline linkage in multiple translation units.
 */

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>     /* for uid_t */

/* ──────────────────────────────────────────────────────────────────────────── */
/*                    Compile-time configuration & logging                     */
/* ──────────────────────────────────────────────────────────────────────────── */
#ifndef CG_COR_MALLOC
#  define CG_COR_MALLOC  malloc
#endif

#ifndef CG_COR_FREE
#  define CG_COR_FREE    free
#endif

#ifdef CG_CHAIN_ENABLE_LOGGING
#  define CG_COR_LOG(fmt, ...) \
        fprintf(stderr, "[CG COR] " fmt "\n", ##__VA_ARGS__)
#else
#  define CG_COR_LOG(...) (void)0
#endif

/* ──────────────────────────────────────────────────────────────────────────── */
/*                                  Requests                                   */
/* ──────────────────────────────────────────────────────────────────────────── */

/* Enumerates the high-level request categories the platform recognises. */
typedef enum {
        CG_REQ_VIEW_LOGS      = 0,
        CG_REQ_SECURITY_SCAN  = 1,
        CG_REQ_BACKUP         = 2,
        CG_REQ_RECOVERY       = 3,
        CG_REQ_DEPLOY         = 4,
        CG_REQ_CUSTOM         = 255        /* user-defined */
} CG_RequestType;

/* Error/return codes recognised by handlers. */
typedef enum {
        CG_HANDLER_OK   =  0,   /* request successfully processed          */
        CG_HANDLER_PASS =  1,   /* handler chose not to process; continue  */
        CG_HANDLER_ERR  = -1    /* unrecoverable error; abort chain        */
} CG_HandlerResult;

/* A request envelope that flows through the chain. */
typedef struct {
        char            correlation_id[37]; /* UUID v4 style string       */
        CG_RequestType  type;               /* category of request        */
        uid_t           user_id;            /* originating user           */
        uint32_t        user_role_mask;     /* RBAC style bitmask         */
        const char     *resource;           /* logical target (may be NULL)*/
        void           *payload;            /* opaque payload             */
        size_t          payload_size;       /* size of payload            */
        struct timespec ts_created;         /* wall-clock creation time   */
} CG_Request;

/* ──────────────────────────────────────────────────────────────────────────── */
/*                                Handlers                                     */
/* ──────────────────────────────────────────────────────────────────────────── */
typedef struct CG_Handler CG_Handler;

/* Prototype for predicate that decides whether the handler will engage. */
typedef bool (*CG_HandlerCanHandleFn)(CG_Handler       *self,
                                      const CG_Request *req);

/* Prototype for the actual processing function. */
typedef CG_HandlerResult
            (*CG_HandlerHandleFn)(CG_Handler *self, CG_Request *req);

/* Prototype for destructor callback (may be NULL). */
typedef void (*CG_HandlerDestroyFn)(CG_Handler *self);

struct CG_Handler {
        const char               *name;
        CG_HandlerCanHandleFn     can_handle;
        CG_HandlerHandleFn        handle;
        CG_HandlerDestroyFn       destroy;
        void                     *context;      /* user data */
        CG_Handler               *next;         /* next link */
};

/* ──────────────────────────────────────────────────────────────────────────── */
/*                      Public Construction / Destruction                      */
/* ──────────────────────────────────────────────────────────────────────────── */

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Allocate and initialise a new handler node.
 *
 * name        Human-readable identifier (copied).
 * can_handle  Predicate (may be NULL => always handle).
 * handle      Processing callback (must not be NULL).
 * destroy     Destructor (may be NULL).
 * context     Opaque pointer passed to callbacks.
 *
 * Returns a fully-allocated handler, or NULL on failure.
 */
static inline CG_Handler *
cg_handler_create(const char            *name,
                  CG_HandlerCanHandleFn  can_handle,
                  CG_HandlerHandleFn     handle,
                  CG_HandlerDestroyFn    destroy,
                  void                  *context)
{
        if (!handle) {
                CG_COR_LOG("handler \"%s\" must provide a handle() callback",
                           name ? name : "(unnamed)");
                return NULL;
        }

        CG_Handler *h = (CG_Handler *)CG_COR_MALLOC(sizeof *h);
        if (!h)
                return NULL;

        memset(h, 0, sizeof *h);
        h->name       = name ? strdup(name) : "unnamed-handler";
        h->can_handle = can_handle;
        h->handle     = handle;
        h->destroy    = destroy;
        h->context    = context;
        h->next       = NULL;
        return h;
}

/*
 * Append `handler` to the tail of `chain`.
 *
 * The caller owns the pointer to the head; passing &head is required
 * for in-place updates (e.g., when *chain == NULL).
 */
static inline void
cg_handler_append(CG_Handler **chain, CG_Handler *handler)
{
        if (!chain || !handler)
                return;

        if (!*chain) {                   /* empty chain */
                *chain = handler;
                return;
        }
        CG_Handler *cur = *chain;
        while (cur->next)
                cur = cur->next;
        cur->next = handler;
}

/*
 * Releases an entire handler chain (recursively).  Calls destroy() for
 * each node and frees the memory.
 */
static inline void
cg_handler_chain_destroy(CG_Handler *chain)
{
        while (chain) {
                CG_Handler *next = chain->next;
                if (chain->destroy)
                        chain->destroy(chain);
                free((char *)chain->name);       /* strdup’d */
                CG_COR_FREE(chain);
                chain = next;
        }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*                          Thread-safe processing                             */
/* ──────────────────────────────────────────────────────────────────────────── */

/*
 * Internal read-write lock guarding modifications to the chain.  Because
 * handlers are rarely appended at runtime in the current design, a single
 * global lock suffices and keeps the API simple.  If future requirements
 * demand per-chain granularity, this can be refactored easily.
 */
static pthread_rwlock_t cg_cor_chain_rwlock = PTHREAD_RWLOCK_INITIALIZER;

/*
 * Iterate over the chain and attempt to process the request.  The first
 * handler that returns CG_HANDLER_OK terminates the chain successfully.
 * If every handler returns CG_HANDLER_PASS, the function itself returns
 * CG_HANDLER_PASS to let callers decide what "unhandled" means.
 *
 * Returns:
 *   CG_HANDLER_OK   request fully processed
 *   CG_HANDLER_PASS no handler took responsibility
 *   < 0             an error occurred (processing aborted)
 */
static inline CG_HandlerResult
cg_handler_process(CG_Handler *chain, CG_Request *req)
{
        if (!chain || !req)
                return CG_HANDLER_ERR;

        CG_HandlerResult result = CG_HANDLER_PASS;

        /* Acquire read lock so requests may flow concurrently. */
        pthread_rwlock_rdlock(&cg_cor_chain_rwlock);

        for (CG_Handler *cur = chain; cur; cur = cur->next) {

                const bool willing =
                        (!cur->can_handle || cur->can_handle(cur, req));

                if (!willing) {
                        continue;       /* pass silently */
                }

                CG_COR_LOG("handler \"%s\" accepted request %s",
                           cur->name, req->correlation_id);

                result = cur->handle(cur, req);

                if (result == CG_HANDLER_OK || result < 0)
                        break;          /* stop chain */
                /* else continue with next handler */
        }

        pthread_rwlock_unlock(&cg_cor_chain_rwlock);
        return result;
}

/*
 * Registers another handler to the end of the global chain in a
 * thread-safe manner.  Modules that build their own private chains may
 * call cg_handler_append() directly instead.
 */
static inline int
cg_handler_register_threadsafe(CG_Handler **chain_head,
                               CG_Handler   *new_handler)
{
        if (!chain_head || !new_handler)
                return -1;

        pthread_rwlock_wrlock(&cg_cor_chain_rwlock);
        cg_handler_append(chain_head, new_handler);
        pthread_rwlock_unlock(&cg_cor_chain_rwlock);

        return 0;
}

/* ──────────────────────────────────────────────────────────────────────────── */
/*                              Helper Utilities                               */
/* ──────────────────────────────────────────────────────────────────────────── */

/*
 * Generates a UUID-v4-style string into `buf` (expects >= 37 bytes).
 * The implementation is pseudo-random and not cryptographically secure,
 * but perfectly adequate for correlation inside the monitoring suite.
 */
static inline void
cg_generate_uuid4(char buf[37])
{
        const char *hex = "0123456789abcdef";
        unsigned char rnd[16];
        for (size_t i = 0; i < sizeof rnd; ++i)
                rnd[i] = (unsigned char)(rand() % 256);

        /* Set the version (4) and variant (RFC 4122) bits. */
        rnd[6] = (rnd[6] & 0x0F) | 0x40;
        rnd[8] = (rnd[8] & 0x3F) | 0x80;

        int p = 0;
        for (size_t i = 0; i < 16; ++i) {
                buf[p++] = hex[(rnd[i] >> 4) & 0xF];
                buf[p++] = hex[rnd[i] & 0xF];
                if (i == 3 || i == 5 || i == 7 || i == 9)
                        buf[p++] = '-';
        }
        buf[p] = '\0';
}

/*
 * Convenience wrapper that initialises the timestamp and generates a
 * fresh correlation_id for a request object.
 */
static inline void
cg_request_init(CG_Request      *req,
                CG_RequestType   type,
                uid_t            uid,
                uint32_t         role_mask,
                const char      *resource)
{
        if (!req) return;

        memset(req, 0, sizeof *req);
        cg_generate_uuid4(req->correlation_id);
        req->type           = type;
        req->user_id        = uid;
        req->user_role_mask = role_mask;
        req->resource       = resource;
        clock_gettime(CLOCK_REALTIME, &req->ts_created);
}

/* ──────────────────────────────────────────────────────────────────────────── */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CAMPUS_GUARD_EDU_MONITOR_PATTERNS_CHAIN_OF_RESPONSIBILITY_H */