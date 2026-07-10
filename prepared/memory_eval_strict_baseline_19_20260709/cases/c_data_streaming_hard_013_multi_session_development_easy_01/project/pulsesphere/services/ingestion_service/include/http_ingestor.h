/*
 * PulseSphere - Real-Time Social Pulse Streaming Platform
 * Copyright (c) 2023-2024
 *
 * File: services/ingestion_service/include/http_ingestor.h
 * Description: Public interface of the HTTP Ingestor component.  The HTTP
 *              Ingestor exposes a lightweight, high-throughput HTTP endpoint
 *              (currently implemented on top of libmicrohttpd) that accepts
 *              incoming social-pulse events via POST/PUT requests, performs
 *              lightweight validation, and forwards the raw payload to the
 *              internal event bus for downstream processing.
 *
 *  NOTE:  This header purposefully keeps the implementation details opaque.
 *         Users of this API interact through the stable interface below.
 */

#ifndef PULSESHPERE_INGESTION_HTTP_INGESTOR_H
#define PULSESHPERE_INGESTION_HTTP_INGESTOR_H

/*--- system ----------------------------------------------------------------*/
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*-----------------------------------------------------------------------------
 *  Versioning
 *---------------------------------------------------------------------------*/
#define HTTP_INGESTOR_MAJOR      1
#define HTTP_INGESTOR_MINOR      0
#define HTTP_INGESTOR_PATCH      0

#define HTTP_INGESTOR_VERSION_STR "1.0.0"

/*-----------------------------------------------------------------------------
 *  Forward declarations and opaque data types
 *---------------------------------------------------------------------------*/
struct http_ingestor_s;
typedef struct http_ingestor_s http_ingestor_t;

/*-----------------------------------------------------------------------------
 *  Error handling
 *---------------------------------------------------------------------------*/
typedef enum http_ingestor_err_e
{
    HTTP_INGESTOR_OK = 0,
    HTTP_INGESTOR_E_INVALID_ARGUMENT,
    HTTP_INGESTOR_E_MEMORY,              /* Memory allocation failure           */
    HTTP_INGESTOR_E_BIND,                /* Port binding failure                */
    HTTP_INGESTOR_E_THREAD,              /* Threading/async runtime failure     */
    HTTP_INGESTOR_E_ALREADY_RUNNING,
    HTTP_INGESTOR_E_NOT_RUNNING,
    HTTP_INGESTOR_E_INTERNAL,            /* Generic internal error              */
} http_ingestor_err_t;

/* Helper: Convert error code to human readable string */
const char *
http_ingestor_err_str(http_ingestor_err_t err) __attribute__((nonnull));

/*-----------------------------------------------------------------------------
 *  Configuration
 *---------------------------------------------------------------------------*/
typedef struct http_ingestor_cfg_s
{
    uint16_t   port;               /* TCP port to bind on                        */
    uint32_t   backlog;            /* Listen backlog size                        */
    uint32_t   worker_threads;     /* # of threads used by the underlying server */
    size_t     max_payload_size;   /* Hard upper limit on accepted body size     */
    unsigned   request_timeout_ms; /* Connection-level timeout                   */
    bool       enable_tls;         /* Whether to serve TLS (requires cert files) */

    /* TLS only: */
    const char *tls_private_key_path;
    const char *tls_certificate_path;

    /* Optional, user-supplied logging facility (may be NULL) */
    void (*logger)(int level, const char *fmt, ...) __attribute__((format(printf,2,3)));
} http_ingestor_cfg_t;

/**
 * http_ingestor_cfg_init_default:
 * Initialize a configuration structure with sane defaults.
 *
 * Parameters:
 *  cfg - Pointer to configuration structure to initialize
 */
static inline void
http_ingestor_cfg_init_default(http_ingestor_cfg_t *cfg)
{
    if (!cfg) return;

    cfg->port                  = 8080;
    cfg->backlog               = 256;
    cfg->worker_threads        = 4;
    cfg->max_payload_size      = 1u << 20;   /* 1 MiB                          */
    cfg->request_timeout_ms    = 15_000;     /* 15 seconds                     */
    cfg->enable_tls            = false;
    cfg->tls_private_key_path  = NULL;
    cfg->tls_certificate_path  = NULL;
    cfg->logger                = NULL;
}

/*-----------------------------------------------------------------------------
 *  Ingestion callback
 *---------------------------------------------------------------------------*/
/**
 * Prototype of the ingestion callback invoked for every successfully received
 * HTTP request that carries a social pulse payload.  The memory pointed to by
 * `payload` is only valid for the lifetime of the callback invocation.
 *
 * Returning a non-zero value indicates that the payload should be considered
 * malformed or otherwise dropped; zero means success.
 */
typedef int (*http_ingestor_payload_cb)(
        const char *payload,
        size_t      payload_len,
        void       *user_ctx);  /* User context passed at registration */

/*-----------------------------------------------------------------------------
 *  Public API
 *---------------------------------------------------------------------------*/

/**
 * Create a new HTTP Ingestor instance.
 *
 * cfg            - Pointer to configuration
 * on_payload     - Mandatory callback for each accepted payload
 * user_ctx       - Opaque pointer passed to `on_payload`
 * out_ingestor   - [out] newly created instance
 *
 * Returns: http_ingestor_err_t
 */
http_ingestor_err_t
http_ingestor_create(const http_ingestor_cfg_t  *cfg,
                     http_ingestor_payload_cb    on_payload,
                     void                       *user_ctx,
                     http_ingestor_t           **out_ingestor)
                     __attribute__((nonnull(1,2,4)));

/**
 * Start accepting HTTP requests.  Must be called once per instance.
 *
 * Returns: HTTP_INGESTOR_OK on success or an error code.
 */
http_ingestor_err_t
http_ingestor_start(http_ingestor_t *ing) __attribute__((nonnull));

/**
 * Stop the HTTP server.  This is a blocking call that waits until all active
 * connections have terminated.
 *
 * force = true  ->  Abort connections immediately
 * force = false ->  Gracefully finish in-flight requests
 */
http_ingestor_err_t
http_ingestor_stop(http_ingestor_t *ing, bool force) __attribute__((nonnull));

/**
 * Destroy the instance and free resources.  The pointer is set to NULL on
 * successful completion.
 */
void
http_ingestor_destroy(http_ingestor_t **ing) __attribute__((nonnull));

/*-----------------------------------------------------------------------------
 *  Metrics
 *---------------------------------------------------------------------------*/
typedef struct http_ingestor_stats_s
{
    uint64_t accepted_requests;
    uint64_t rejected_requests;
    uint64_t bytes_received;
    uint64_t active_connections;
} http_ingestor_stats_t;

/**
 * Get a snapshot of current runtime statistics.
 */
http_ingestor_err_t
http_ingestor_get_stats(const http_ingestor_t *ing,
                        http_ingestor_stats_t  *out_stats)
                        __attribute__((nonnull));

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESHPERE_INGESTION_HTTP_INGESTOR_H */
