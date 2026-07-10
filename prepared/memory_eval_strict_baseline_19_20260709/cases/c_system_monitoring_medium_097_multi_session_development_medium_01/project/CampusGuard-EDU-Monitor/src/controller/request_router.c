```c
/**
 * CampusGuard EDU Monitor
 * src/controller/request_router.c
 *
 * The request router is the first stop for any inbound user-generated
 * action arriving from the View layer (GTK/ncurses dashboards).  It
 * implements a classic Chain-of-Responsibility that validates ACLs,
 * enqueues work on the event-driven message bus, and finally dispatches
 * to an appropriate micro-agent living in the Service Mesh.
 *
 * Copyright (c) 2024
 * SPDX-License-Identifier: MIT
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>
#include <pthread.h>
#include <errno.h>

#include "controller/request_router.h"
#include "infra/validator.h"
#include "infra/logger.h"
#include "infra/message_bus.h"
#include "infra/service_mesh.h"

/* -------------------------------------------------------------------------- */
/*                              Local Definitions                             */
/* -------------------------------------------------------------------------- */

/* Maximum number of handlers in the chain. Extend as needed. */
#define RR_MAX_HANDLERS  8

/* How long (sec) the router waits before giving up on message-bus publish */
#define RR_MSG_BUS_TIMEOUT_SEC  5

/* -------------------------------------------------------------------------- */
/*                              Data Structures                               */
/* -------------------------------------------------------------------------- */

/**
 * A handler in the routing chain.
 */
typedef enum {
    RR_HANDLER_OK     = 0,   /* Handler processed request fully.            */
    RR_HANDLER_PASS   = 1,   /* Handler passed request to next handler.     */
    RR_HANDLER_ERR    = -1   /* Handler failed – abort the chain.           */
} rr_handler_rc_t;

typedef rr_handler_rc_t (*rr_handler_fn)(RequestRouter       *router,
                                         const cg_request_t  *req,
                                         void                *ctx);

/**
 * Router instance (opaque to callers, public typedef lies in header).
 */
struct request_router {
    pthread_mutex_t      lock;                         /* Concurrency guard        */
    Validator           *validator;                    /* ACL validator            */
    MessageBus          *bus;                          /* Event-driven bus         */
    ServiceMesh         *mesh;                         /* Micro-agent dispatcher   */
    rr_handler_fn        chain[RR_MAX_HANDLERS];       /* Chain of handlers        */
    uint8_t              chain_len;                    /* Effective length         */
    bool                 running;                      /* Lifecycle flag           */
};

/* -------------------------------------------------------------------------- */
/*                       Forward Declarations (static)                        */
/* -------------------------------------------------------------------------- */

static rr_handler_rc_t rr_permission_handler(RequestRouter *router,
                                             const cg_request_t *req,
                                             void *ctx);

static rr_handler_rc_t rr_enqueue_handler(RequestRouter *router,
                                          const cg_request_t *req,
                                          void *ctx);

static rr_handler_rc_t rr_dispatch_handler(RequestRouter *router,
                                           const cg_request_t *req,
                                           void *ctx);

/* -------------------------------------------------------------------------- */
/*                              Public Methods                                */
/* -------------------------------------------------------------------------- */

RequestRouter *request_router_create(Validator  *validator,
                                     MessageBus *bus,
                                     ServiceMesh *mesh)
{
    if (!validator || !bus || !mesh) {
        LOG_ERROR("request_router_create: NULL dependency received");
        return NULL;
    }

    RequestRouter *router = calloc(1, sizeof(*router));
    if (!router) {
        LOG_ERROR("request_router_create: Out of memory");
        return NULL;
    }

    router->validator = validator;
    router->bus       = bus;
    router->mesh      = mesh;
    router->running   = true;

    pthread_mutex_init(&router->lock, NULL);

    /* Build default chain.  Order matters. */
    router->chain[0] = rr_permission_handler;
    router->chain[1] = rr_enqueue_handler;
    router->chain[2] = rr_dispatch_handler;
    router->chain_len = 3;

    LOG_INFO("RequestRouter created with %u handler(s)", router->chain_len);
    return router;
}

void request_router_destroy(RequestRouter *router)
{
    if (!router) return;

    pthread_mutex_destroy(&router->lock);
    free(router);
    LOG_INFO("RequestRouter destroyed");
}

int request_router_route(RequestRouter *router, const cg_request_t *req)
{
    if (!router || !req) {
        LOG_ERROR("request_router_route: invalid parameter");
        return -EINVAL;
    }

    pthread_mutex_lock(&router->lock);

    if (!router->running) {
        pthread_mutex_unlock(&router->lock);
        LOG_WARN("RequestRouter is shut down – ignoring request");
        return -ESHUTDOWN;
    }

    rr_handler_rc_t rc  = RR_HANDLER_PASS;
    uint8_t         idx = 0;

    while (idx < router->chain_len && rc == RR_HANDLER_PASS) {
        rr_handler_fn fn = router->chain[idx++];
        rc = fn(router, req, NULL);
    }

    pthread_mutex_unlock(&router->lock);

    if (rc == RR_HANDLER_OK) {
        LOG_DEBUG("Request %s routed successfully", req->id);
        return 0;
    }
    if (rc == RR_HANDLER_PASS) {
        /* Nobody claimed the request. Log + error out. */
        LOG_WARN("Request %s reached end of chain unhandled", req->id);
        return -ENOSYS;
    }

    /* rc == RR_HANDLER_ERR */
    LOG_ERROR("Request %s failed during routing (handler index %u)", req->id, idx - 1);
    return -EIO;
}

/* -------------------------------------------------------------------------- */
/*                              Handler Section                               */
/* -------------------------------------------------------------------------- */

/**
 * Permission Handler
 * ------------------
 * Ask the Validator subsystem whether the requesting user has the
 * necessary rights to execute the requested action.
 */
static rr_handler_rc_t rr_permission_handler(RequestRouter       *router,
                                             const cg_request_t  *req,
                                             void                *ctx)
{
    (void)ctx; /* unused */

    cg_acl_decision_t decision = validator_authorize(router->validator,
                                                     req->user,
                                                     req->type,
                                                     req->scope);
    if (decision == CG_ACL_ALLOW) {
        return RR_HANDLER_PASS;
    }

    LOG_WARN("Permission denied for user %s on action %d", req->user, req->type);
    return RR_HANDLER_ERR;
}

/**
 * Enqueue Handler
 * ---------------
 * Wrap the request inside an Event message and push it onto the
 * distributed Message Bus so that workers can pick it up.
 */
static rr_handler_rc_t rr_enqueue_handler(RequestRouter       *router,
                                          const cg_request_t  *req,
                                          void                *ctx)
{
    (void)ctx;

    cg_event_t evt = {
        .id        = req->id,
        .timestamp = time(NULL),
        .payload   = (void *)req,
        .event_type= CG_EVT_REQUEST_RECEIVED
    };

    int rc = message_bus_publish(router->bus, &evt, RR_MSG_BUS_TIMEOUT_SEC);
    if (rc == 0) {
        return RR_HANDLER_PASS;
    }

    LOG_ERROR("Failed to publish request %s to MessageBus (rc=%d)", req->id, rc);
    return RR_HANDLER_ERR;
}

/**
 * Dispatch Handler
 * ----------------
 * Use the Service Mesh to locate the micro-service that implements the
 * request type and send it off.
 */
static rr_handler_rc_t rr_dispatch_handler(RequestRouter       *router,
                                           const cg_request_t  *req,
                                           void                *ctx)
{
    (void)ctx;

    const char *service_name = service_mesh_lookup(router->mesh, req->type);
    if (!service_name) {
        LOG_ERROR("No service mesh target found for request type %d", req->type);
        return RR_HANDLER_ERR;
    }

    int rc = service_mesh_dispatch(router->mesh, service_name, req);
    if (rc == 0) {
        return RR_HANDLER_OK;      /* Final handler — stop chain here       */
    }

    LOG_ERROR("Service mesh dispatch failed for %s (rc=%d)", service_name, rc);
    return RR_HANDLER_ERR;
}

/* -------------------------------------------------------------------------- */
/*                              Extensibility APIs                            */
/* -------------------------------------------------------------------------- */

int request_router_add_handler(RequestRouter  *router,
                               rr_handler_fn   fn,
                               uint8_t         position)
{
    if (!router || !fn) return -EINVAL;

    if (router->chain_len >= RR_MAX_HANDLERS) {
        LOG_ERROR("Cannot add handler: chain is full");
        return -ENOBUFS;
    }

    pthread_mutex_lock(&router->lock);

    /* When position >= chain_len, append at end. Otherwise shift right. */
    if (position >= router->chain_len) {
        router->chain[router->chain_len++] = fn;
    } else {
        memmove(&router->chain[position + 1],
                &router->chain[position],
                (router->chain_len - position) * sizeof(rr_handler_fn));
        router->chain[position] = fn;
        router->chain_len++;
    }

    pthread_mutex_unlock(&router->lock);

    LOG_INFO("Custom handler added at position %u (new length %u)",
             position, router->chain_len);
    return 0;
}

void request_router_shutdown(RequestRouter *router)
{
    if (!router) return;

    pthread_mutex_lock(&router->lock);
    router->running = false;
    pthread_mutex_unlock(&router->lock);

    LOG_INFO("RequestRouter shutdown initiated");
}

/* -------------------------------------------------------------------------- */
/*                               Debug Helpers                                */
/* -------------------------------------------------------------------------- */

#ifdef CG_ROUTER_UNIT_TEST
/* Simple unit test clone – compile with -DCG_ROUTER_UNIT_TEST */
#include "tests/test_harness.h"
static void run_basic_router_test(void)
{
    /* Build dummy dependencies ... */
    Validator   *v   = validator_mock_create();
    MessageBus  *bus = message_bus_mock_create();
    ServiceMesh *sm  = service_mesh_mock_create();

    RequestRouter *rr = request_router_create(v, bus, sm);
    cg_request_t  req = {
        .id     = "123e4567-e89b-12d3-a456-426655440000",
        .type   = CG_REQ_START_SCAN,
        .scope  = "/lab-vms",
        .user   = "studentA",
    };

    int rc = request_router_route(rr, &req);
    TEST_ASSERT(rc == 0);

    request_router_destroy(rr);
    validator_mock_destroy(v);
    message_bus_mock_destroy(bus);
    service_mesh_mock_destroy(sm);
}
TEST_MAIN(run_basic_router_test)
#endif /* CG_ROUTER_UNIT_TEST */
```