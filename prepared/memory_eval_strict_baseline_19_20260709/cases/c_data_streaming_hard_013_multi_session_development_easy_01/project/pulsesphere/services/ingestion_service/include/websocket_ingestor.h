#ifndef PULSESPHERE_WEBSOCKET_INGESTOR_H_
#define PULSESPHERE_WEBSOCKET_INGESTOR_H_

/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * -----------------------------------------------------
 * File  : websocket_ingestor.h
 * Author: PulseSphere Core Team
 *
 * (c) 2024 PulseSphere Contributors – All rights reserved.
 *
 * Description:
 *   Public interface for the WebSocketIngestor component.  The ingestor
 *   establishes and maintains multiple WebSocket connections to 3rd-party
 *   social networks (e.g., Twitter, Reddit, Mastodon) and proprietary
 *   WebSocket gateways.  Raw messages are framed, minimally validated,
 *   and pushed into the internal event fabric (ring-buffer) for further
 *   processing by the enrichment and validation pipeline.
 *
 *   The ingestor is designed for high throughput and resilience:
 *     • Automatic exponential-backoff reconnection
 *     • Heart-beat/ping handling
 *     • TLS with runtime certificate hot-reload
 *     • Configurable concurrency level (event-loop threads)
 *     • Backpressure signalling (consumer-provided)
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Forward declaration to prevent header pollution */
struct lws;               /* libwebsockets context          */
struct lws_context;        /* libwebsockets per-process ctx  */
struct ring_buffer;        /* Project-wide lock-free ring    */

/* --------------------------------------------------------------------------
 * Pulse Event – minimal envelope emitted by WebSocketIngestor.
 * Down-stream stages append richer metadata; therefore keep this struct
 * intentionally compact and POD-style.
 * ------------------------------------------------------------------------ */
typedef struct ps_raw_event
{
    uint64_t   seq_no;         /* Monotonic sequence within connection      */
    time_t     received_ts;    /* Time at socket-level receive              */
    size_t     len;            /* Length of `payload` in bytes              */
    char      *payload;        /* Raw JSON/Protobuf text (NULL-terminated)  */
} ps_raw_event_t;


/* --------------------------------------------------------------------------
 * Backpressure feedback.
 *
 * Consumer must periodically report its ability to accept more data.
 * The ingestor will throttle reads when buffer is congested.
 * ------------------------------------------------------------------------ */
typedef enum
{
    PS_INGESTOR_OK          = 0,  /* Consumer healthy, proceed normally   */
    PS_INGESTOR_HIGH_WATER  = 1,  /* Approaching capacity, mild throttle  */
    PS_INGESTOR_AT_CAPACITY = 2   /* Stop reads until state improves      */

} ps_backpressure_t;

/* Callback prototype for backpressure.
 * NB: Implementation must be fast, lock-free preferred.
 */
typedef ps_backpressure_t (*ps_backpressure_cb)(void *user_ctx);

/* --------------------------------------------------------------------------
 * WebSocket peer configuration.
 * ------------------------------------------------------------------------ */
typedef struct ps_ws_endpoint_cfg
{
    const char *url;               /* wss://example.com/stream                    */
    const char *subprotocol;       /* e.g., "json", may be NULL                   */
    const char *origin;            /* Optional Origin header                      */

    /* Auth/Z parameters */
    const char *access_token;      /* Bearer/Token-based authentication           */
    const char *api_key;           /* Alternative credential                      */

    /* TLS specifics */
    const char *ca_cert_file;      /* Path to CA bundle.  NULL => system default  */
    const char *client_cert_file;  /* Path to client cert (mutual TLS), optional  */
    const char *client_key_file;   /* Path to client key, optional                */

    /* Operational tuning */
    uint32_t    reconnect_initial_ms;  /* Initial backoff in milliseconds      */
    uint32_t    reconnect_max_ms;      /* Cap for backoff                      */
    uint32_t    ping_interval_sec;     /* Send ping if idle                    */
} ps_ws_endpoint_cfg_t;


/* --------------------------------------------------------------------------
 * Aggregate ingestor configuration.
 * ------------------------------------------------------------------------ */
typedef struct ps_ingestor_cfg
{
    ps_ws_endpoint_cfg_t *endpoints;   /* Array of endpoints         */
    size_t                endpoint_cnt;

    size_t                ring_capacity;       /* Default 64k events    */
    uint32_t              io_threads;          /* # of lws service threads */

    ps_backpressure_cb    bp_callback;         /* Consumer feed-back    */
    void                 *bp_user_ctx;

    /* Misc */
    uint32_t              log_verbosity;       /* 0 = ERROR .. 3 = DEBUG */
} ps_ingestor_cfg_t;


/* Forward handle type (opaque) */
typedef struct ps_ws_ingestor ps_ws_ingestor_t;


/* --------------------------------------------------------------------------
 * API
 * ------------------------------------------------------------------------ */

/*
 * ps_ws_ingestor_create
 *   Allocate and fully initialize a new WebSocket ingestor instance.
 *
 * Parameters:
 *   cfg         – Pointer to a fully populated configuration object.
 *   out_handle  – Upon success, receives opaque handle to the ingestor.
 *
 * Returns:
 *   true  on success
 *   false on failure (check errno for details: ENOMEM, EINVAL, etc.)
 */
bool
ps_ws_ingestor_create(const ps_ingestor_cfg_t *cfg,
                      ps_ws_ingestor_t **out_handle);


/*
 * ps_ws_ingestor_start
 *   Start all event loop threads and initiate connections.
 *
 * Thread-Safety:
 *   May be called from a single management thread.  Non-blocking.
 *
 * Returns:
 *   0 on success
 *  <0 on error (POSIX errno style)
 */
int
ps_ws_ingestor_start(ps_ws_ingestor_t *ingestor);


/*
 * ps_ws_ingestor_stop
 *   Idempotent, cooperative shutdown.  Waits for active connections to
 *   close gracefully; interrupts are honoured upon second call.
 */
void
ps_ws_ingestor_stop(ps_ws_ingestor_t *ingestor);


/*
 * ps_ws_ingestor_destroy
 *   Free all resources.  Must not be called while any thread still executes
 *   inside ingestor.  Block until full teardown.
 */
void
ps_ws_ingestor_destroy(ps_ws_ingestor_t *ingestor);


/*
 * ps_ws_ingestor_get_ring
 *   Provides handle to underlying lock-free ring buffer for zero-copy
 *   consumption.  Ownership is not transferred.
 *
 * Returns:
 *   Pointer to internal ring buffer or NULL if ingestor not started.
 */
struct ring_buffer *
ps_ws_ingestor_get_ring(ps_ws_ingestor_t *ingestor);


/*
 * ps_ws_ingestor_reconfigure_tls
 *   Hot-reload updated certificates without downtime.  Thread-safe.
 *
 * Parameters:
 *   ca_cert_file      – New CA bundle path or NULL to keep current
 *   client_cert_file  – New client cert path or NULL …
 *   client_key_file   – New client key path or NULL …
 *
 * Returns:
 *   true on success, false on failure (details logged).
 */
bool
ps_ws_ingestor_reconfigure_tls(ps_ws_ingestor_t *ingestor,
                               const char *ca_cert_file,
                               const char *client_cert_file,
                               const char *client_key_file);


/*
 * ps_ws_ingestor_version
 *   Retrieve semantic version string of the ingestor component.
 *   Example: "2.1.0"  (caller must not free)
 */
const char *
ps_ws_ingestor_version(void);


/*
 * ps_ws_ingestor_metrics_snapshot
 *   Populates user-provided buffer with a stable snapshot of live metrics
 *   (connections open, bytes rx/tx, latency stats).
 *
 * Parameters:
 *   dst     – pointer to caller-allocated struct (defined elsewhere).
 *   dst_len – size of struct to ensure backwards compatibility.
 *
 * Returns:
 *   true  if snapshot completed
 *   false if buffer too small (required size stored in *dst_len)
 */
bool
ps_ws_ingestor_metrics_snapshot(void *dst, size_t *dst_len);


/*
 * Convenience macro for compile-time version check.
 * Usage:
 *   #if PS_WS_INGESTOR_VERSION_GE(2,0,0)
 *       ...
 *   #endif
 */
#define PS_WS_INGESTOR_VERSION_MAJOR 2
#define PS_WS_INGESTOR_VERSION_MINOR 1
#define PS_WS_INGESTOR_VERSION_PATCH 0

#define PS_WS_INGESTOR_VERSION_GE(MAJ, MIN, PAT) \
    ((PS_WS_INGESTOR_VERSION_MAJOR >  (MAJ)) || \
     (PS_WS_INGESTOR_VERSION_MAJOR == (MAJ) && \
      PS_WS_INGESTOR_VERSION_MINOR >  (MIN)) || \
     (PS_WS_INGESTOR_VERSION_MAJOR == (MAJ) && \
      PS_WS_INGESTOR_VERSION_MINOR == (MIN) && \
      PS_WS_INGESTOR_VERSION_PATCH >= (PAT)))

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_WEBSOCKET_INGESTOR_H_ */
