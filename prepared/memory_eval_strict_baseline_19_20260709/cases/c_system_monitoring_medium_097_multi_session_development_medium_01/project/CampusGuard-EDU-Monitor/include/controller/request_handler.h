/*
 * CampusGuard EDU Monitor
 * File: CampusGuard-EDU-Monitor/include/controller/request_handler.h
 *
 * Description:
 *   Generic, chain-of-responsibility request-handling framework used by the
 *   CampusGuard EDU Monitor “Controller” layer.  A controller builds a linked
 *   list of cg_request_handler_t objects; each node decides whether it can
 *   service the request (authorization, validation, dispatch, etc.).  The first
 *   handler that returns `true` claims the request and halts further
 *   propagation.  This header is intentionally self-contained; define
 *   CG_REQUEST_HANDLER_IMPLEMENTATION in *one* compilation unit to emit the
 *   function bodies.
 *
 * Usage example:
 *
 *   #define CG_REQUEST_HANDLER_IMPLEMENTATION
 *   #include "controller/request_handler.h"
 *
 *   static bool my_dispatcher(cg_request_handler_t *self,
 *                             const cg_request_t   *req,
 *                             const cg_user_ctx_t  *user)
 *   {
 *       // ... real dispatching here ...
 *       (void)self; (void)req; (void)user;
 *       return true;   // handled
 *   }
 *
 *   void init_controller(void)
 *   {
 *       cg_request_handler_t *chain = NULL;
 *       cg_rh_chain_init(&chain);
 *       cg_request_handler_t *dispatch =
 *           cg_rh_create(my_dispatcher, NULL, NULL);
 *       cg_rh_chain_append(&chain, dispatch);
 *       g_controller.request_chain = chain;
 *   }
 */

#ifndef CG_REQUEST_HANDLER_H
#define CG_REQUEST_HANDLER_H

/* ────────────────  System headers  ──────────────── */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ────────────────  Forward declarations  ──────────────── */
/* Opaque project-wide types.  Real definitions live elsewhere. */
typedef struct cg_request       cg_request_t;
typedef struct cg_user_ctx      cg_user_ctx_t;
typedef struct cg_logger        cg_logger_t;
typedef struct cg_event_bus     cg_event_bus_t;
typedef struct cg_acl           cg_acl_t;

/* ────────────────  Public API  ──────────────── */

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Function signature every handler must follow.
 *   self  – current handler instance
 *   req   – immutable request descriptor
 *   user  – caller’s security context (may be NULL for system-generated)
 *
 * Returns:
 *     true  –  request was handled; stop traversal
 *     false –  not handled; invoke next handler, if any
 */
typedef bool (*cg_handle_fn)(struct cg_request_handler *self,
                             const cg_request_t        *req,
                             const cg_user_ctx_t       *user);

/*
 * Generic request-handler node.
 * State allocation strategy:
 *     – The framework allocates/free’s the cg_request_handler_t container.
 *     – The handler is responsible for allocating its own private `state`
 *       (may be NULL) and supplying an optional `destroy_state` callback.
 */
typedef struct cg_request_handler {
    cg_handle_fn                     handle;        /* mandatory */
    void                            *state;         /* handler-specific data */
    struct cg_request_handler       *next;          /* next link in chain */
    void (*destroy_state)(void *state);             /* optional destructor */
} cg_request_handler_t;

/*-------------------------------------------------------------------------
 * Creation / destruction
 *------------------------------------------------------------------------*/

/*
 * cg_rh_create:
 *     Instantiate a new request handler node.
 *
 * Parameters:
 *     handle         – business-logic callback (must not be NULL)
 *     state          – opaque, handler-specific data (may be NULL)
 *     destroy_state  – destructor for `state` (may be NULL)
 *
 * Returns:
 *     Non-NULL pointer on success; NULL on allocation failure.
 */
cg_request_handler_t *
cg_rh_create(cg_handle_fn handle,
             void        *state,
             void (*destroy_state)(void *state));

/*
 * cg_rh_destroy_chain:
 *     Iteratively free the entire chain beginning at `head`.  Safe to call
 *     with NULL.
 */
void
cg_rh_destroy_chain(cg_request_handler_t *head);

/*-------------------------------------------------------------------------
 * Chain manipulation
 *------------------------------------------------------------------------*/

/*
 * cg_rh_chain_init:
 *     Convenience helper – sets `*head` to NULL.
 */
static inline void cg_rh_chain_init(cg_request_handler_t **head)
{
    if (head) *head = NULL;
}

/*
 * cg_rh_chain_append:
 *     Append `node` to the end of `*head`.  If `*head` is NULL, `node` becomes
 *     the new head.  Does nothing when `node` is NULL.
 *
 * Note: The caller retains ownership of `node` and must eventually destroy the
 *       entire chain via cg_rh_destroy_chain().
 */
void
cg_rh_chain_append(cg_request_handler_t **head,
                   cg_request_handler_t  *node);

/*-------------------------------------------------------------------------
 * Processing
 *------------------------------------------------------------------------*/

/*
 * cg_rh_process:
 *     Traverse the chain and invoke each handler until one returns `true`
 *     (handled) or the list terminates.  Returns the value yielded by the last
 *     invoked handler (false if chain is empty).
 */
bool
cg_rh_process(cg_request_handler_t *head,
              const cg_request_t   *req,
              const cg_user_ctx_t  *user);

/*-------------------------------------------------------------------------
 * Helpers – optional, ready-made handler constructors
 *
 * The following functions create commonly-used handlers employed by various
 * CampusGuard controllers.  They return NULL upon allocation failure.
 *------------------------------------------------------------------------*/

/* Authorization gate – validates `user` against an ACL. */
cg_request_handler_t *
cg_rh_create_authorization_gate(const cg_acl_t *acl);

/* Structured logger – records the request before passing it along. */
cg_request_handler_t *
cg_rh_create_logger(cg_logger_t *logger);

/* Asynchronous dispatcher – enqueues the request onto the event bus. */
cg_request_handler_t *
cg_rh_create_event_dispatcher(cg_event_bus_t *bus);

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ---------------------------------------------------------------------- */
/*                       Implementation section                           */
/* ---------------------------------------------------------------------- */
#ifdef CG_REQUEST_HANDLER_IMPLEMENTATION

/* ────────────────  System headers  ──────────────── */
#include <assert.h>
#include <stdlib.h>
#include <string.h>

/* ────────────────  Private helpers  ──────────────── */

static void *cg__calloc(size_t n, size_t sz)
{
    if (n == 0 || sz == 0)
        return NULL;
    return calloc(n, sz);
}

/* ────────────────  API implementation  ──────────────── */

cg_request_handler_t *
cg_rh_create(cg_handle_fn handle,
             void        *state,
             void (*destroy_state)(void *))
{
    if (!handle) {
        return NULL;
    }

    cg_request_handler_t *node =
        (cg_request_handler_t *)cg__calloc(1, sizeof(*node));

    if (!node) {
        return NULL;
    }

    node->handle        = handle;
    node->state         = state;
    node->destroy_state = destroy_state;
    node->next          = NULL;
    return node;
}

void
cg_rh_chain_append(cg_request_handler_t **head,
                   cg_request_handler_t  *node)
{
    if (!head || !node)
        return;

    if (*head == NULL) {
        *head = node;
        return;
    }

    cg_request_handler_t *iter = *head;
    while (iter->next)
        iter = iter->next;
    iter->next = node;
}

bool
cg_rh_process(cg_request_handler_t *head,
              const cg_request_t   *req,
              const cg_user_ctx_t  *user)
{
    bool handled = false;

    for (cg_request_handler_t *iter = head; iter; iter = iter->next) {
        handled = iter->handle(iter, req, user);
        if (handled)
            break;
    }
    return handled;
}

void
cg_rh_destroy_chain(cg_request_handler_t *head)
{
    while (head) {
        cg_request_handler_t *next = head->next;

        if (head->destroy_state && head->state)
            head->destroy_state(head->state);

        free(head);
        head = next;
    }
}

/*-------------------------------------------------------------------------*/
/*         Ready-made handler implementations (optional use)               */
/*-------------------------------------------------------------------------*/

static bool cg__authorization_handle(cg_request_handler_t *self,
                                     const cg_request_t   *req,
                                     const cg_user_ctx_t  *user)
{
    (void)req;
    if (!self || !user)          /* deny if no user context */
        return false;

    const cg_acl_t *acl = (const cg_acl_t *)self->state;
    if (!acl)
        return false;

    extern bool cg_acl_is_allowed(const cg_acl_t *,
                                  const cg_user_ctx_t *);
    if (cg_acl_is_allowed(acl, user))
        return false;  /* allowed -> continue chain */
    /* denied -> stop traversal */
    return true;
}

cg_request_handler_t *
cg_rh_create_authorization_gate(const cg_acl_t *acl)
{
    return cg_rh_create(cg__authorization_handle,
                        (void *)acl,
                        NULL /* acl owned by caller */);
}

/* ----------------------- Logger handler ----------------------- */

static bool cg__logger_handle(cg_request_handler_t *self,
                              const cg_request_t   *req,
                              const cg_user_ctx_t  *user)
{
    (void)self;
    extern void cg_logger_log_request(cg_logger_t *,
                                      const cg_request_t *,
                                      const cg_user_ctx_t *);

    cg_logger_t *logger = (cg_logger_t *)self->state;
    if (logger)
        cg_logger_log_request(logger, req, user);

    /* logging never consumes the request */
    return false;
}

cg_request_handler_t *
cg_rh_create_logger(cg_logger_t *logger)
{
    return cg_rh_create(cg__logger_handle,
                        logger,
                        NULL /* logger owned elsewhere */);
}

/* ----------------------- Dispatcher handler ----------------------- */

static bool cg__dispatcher_handle(cg_request_handler_t *self,
                                  const cg_request_t   *req,
                                  const cg_user_ctx_t  *user)
{
    (void)self; (void)user;
    cg_event_bus_t *bus = (cg_event_bus_t *)self->state;
    if (!bus)
        return false;

    extern bool cg_event_bus_publish(cg_event_bus_t *, const cg_request_t *);
    bool ok = cg_event_bus_publish(bus, req);
    /* If successfully enqueued we’ve handled the request. */
    return ok;
}

cg_request_handler_t *
cg_rh_create_event_dispatcher(cg_event_bus_t *bus)
{
    return cg_rh_create(cg__dispatcher_handle,
                        bus,
                        NULL /* bus lifetime managed elsewhere */);
}

#endif /* CG_REQUEST_HANDLER_IMPLEMENTATION */
#endif /* CG_REQUEST_HANDLER_H */
