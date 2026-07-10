/**
 * PulseSphere - Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * Module      : analytics_sink_service / Data-Lake Writer
 * File        : data_lake_writer.h
 *
 * Description :
 *   Public interface for the Data-Lake writer component. The writer is
 *   responsible for persisting curated/enriched pulses into the enterprise
 *   Data-Lake (object storage, HDFS, cloud buckets, etc.).  The component
 *   offers a high-throughput, back-pressure-aware, thread-safe batching
 *   mechanism, pluggable sink back-ends, and exactly-once semantics on best
 *   effort.  This header is deliberately kept C-only (no C++ism) and does
 *   not expose internal representations, thereby allowing alternative
 *   implementations to be hot-swapped without recompilation of dependents.
 *
 * Author      : PulseSphere Core Team <core@pulsesphere.io>
 * License     : MIT
 */

#ifndef PULSAPHERE_ANALYTICS_SINK_SERVICE_DATA_LAKE_WRITER_H
#define PULSAPHERE_ANALYTICS_SINK_SERVICE_DATA_LAKE_WRITER_H

/* -------------------------------------------------------------------------- */
/*  System & Standard Library Headers                                         */
/* -------------------------------------------------------------------------- */
#include <stddef.h>     /* size_t                      */
#include <stdint.h>     /* uintXX_t                   */
#include <stdbool.h>    /* bool                       */

#if defined(__cplusplus)
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/*  Forward Declarations / Opaque Handles                                     */
/* -------------------------------------------------------------------------- */
typedef struct ps_dlw_writer_s ps_dlw_writer_t;   /* Opaque writer instance  */
typedef struct ps_dlw_buffer_s ps_dlw_buffer_t;   /* Opaque buffer snapshot  */

/* -------------------------------------------------------------------------- */
/*  Public Constants & Limits                                                 */
/* -------------------------------------------------------------------------- */
#define PS_DLW_MAX_ENDPOINT_LEN      255u
#define PS_DLW_MAX_BUCKET_LEN        127u
#define PS_DLW_MAX_ACCESS_KEY_LEN    127u
#define PS_DLW_MAX_SECRET_KEY_LEN    127u
#define PS_DLW_MAX_REGION_LEN        63u
#define PS_DLW_MAX_PROVIDER_LEN      63u
#define PS_DLW_MAX_PATH_PREFIX_LEN   255u

/* -------------------------------------------------------------------------- */
/*  Error & Status Codes                                                      */
/* -------------------------------------------------------------------------- */
typedef enum
{
    PS_DLW_OK = 0,                  /* operation succeeded                   */
    PS_DLW_E_AGAIN,                 /* temporary resource exhaustion         */
    PS_DLW_E_INIT,                  /* initialization / configuration error  */
    PS_DLW_E_IO,                    /* I/O related failure                   */
    PS_DLW_E_OOM,                   /* out of memory                         */
    PS_DLW_E_CANCELED,              /* operation has been canceled           */
    PS_DLW_E_TIMEOUT,               /* operation timed out                   */
    PS_DLW_E_INVALID_ARG,           /* invalid argument provided             */
    PS_DLW_E_SHUTDOWN,              /* writer already shut down              */
    PS_DLW_E_NOT_SUPPORTED,         /* feature not supported                 */
    PS_DLW_E_STATE,                 /* invalid internal state                */
    PS_DLW_E_UNKNOWN                /* unspecified failure                   */
} ps_dlw_rc_e;

/* Human-readable status string */
const char *ps_dlw_rc_str(ps_dlw_rc_e rc);

/* -------------------------------------------------------------------------- */
/*  Configuration Structure                                                   */
/* -------------------------------------------------------------------------- */
typedef struct
{
    /* ------------------------------------------------------------------ */
    /*  Connectivity / Destination                                        */
    /* ------------------------------------------------------------------ */
    char        endpoint[PS_DLW_MAX_ENDPOINT_LEN + 1]; /* e.g. s3.amazonaws.com  */
    char        bucket  [PS_DLW_MAX_BUCKET_LEN   + 1]; /* target bucket / path   */
    char        region  [PS_DLW_MAX_REGION_LEN   + 1]; /* region identifier      */
    char        provider[PS_DLW_MAX_PROVIDER_LEN + 1]; /* "s3", "gcs", "hdfs"    */

    /* ------------------------------------------------------------------ */
    /*  Security                                                          */
    /* ------------------------------------------------------------------ */
    char        access_key[PS_DLW_MAX_ACCESS_KEY_LEN + 1];
    char        secret_key[PS_DLW_MAX_SECRET_KEY_LEN + 1];
    bool        use_tls;                   /* enable TLS/SSL               */
    const char *ca_bundle_path;            /* optional CA cert bundle      */

    /* ------------------------------------------------------------------ */
    /*  Batching & Sizing                                                 */
    /* ------------------------------------------------------------------ */
    size_t      max_batch_events;   /* number of events before auto-flush   */
    size_t      max_batch_bytes;    /* accumulate until N bytes flush       */
    uint32_t    flush_interval_ms;  /* flush after N ms even if not full    */

    /* ------------------------------------------------------------------ */
    /*  Paths & Object Naming                                             */
    /* ------------------------------------------------------------------ */
    char        path_prefix[PS_DLW_MAX_PATH_PREFIX_LEN + 1]; /* e.g. daily/2023/05/ */

    /* ------------------------------------------------------------------ */
    /*  Runtime                                                           */
    /* ------------------------------------------------------------------ */
    uint32_t    io_threads;         /* # of parallel I/O threads            */
    uint32_t    retry_attempts;     /* number of retries on transient errs  */
    uint32_t    retry_backoff_ms;   /* exponential back-off base            */

    /* ------------------------------------------------------------------ */
    /*  Flags                                                             */
    /* ------------------------------------------------------------------ */
    bool        enable_metrics;     /* export writer metrics via /metrics   */
    bool        strict_ordering;    /* honor event order across flushes     */
    bool        synchronous;        /* block caller until persisted         */
} ps_dlw_cfg_t;

/* -------------------------------------------------------------------------- */
/*  Statistics                                                                */
/* -------------------------------------------------------------------------- */
typedef struct
{
    uint64_t    events_total;       /* total # of events handed to writer   */
    uint64_t    events_flushed;     /* events successfully persisted        */
    uint64_t    bytes_total;        /* number of bytes accepted             */
    uint64_t    bytes_flushed;      /* bytes confirmed persisted            */

    uint32_t    flush_count;        /* total flush cycles executed          */
    uint32_t    error_count;        /* permanent errors encountered         */
    uint32_t    retry_count;        /* retries performed                    */

    uint64_t    last_flush_epoch_ms;/* wall-clock of last successful flush  */

    /* Reserved for future fields */
    uint64_t    _reserved[4];

} ps_dlw_stats_t;

/* -------------------------------------------------------------------------- */
/*  Lifecycle Functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Create a new writer instance with the given configuration.
 *
 * Parameters
 * ----------
 *  cfg : pointer to configuration structure (copied internally)
 *
 * Return
 * ------
 *  non-NULL pointer on success, NULL on failure (see errno / ps_dlw_rc_str()).
 */
ps_dlw_writer_t *ps_dlw_create(const ps_dlw_cfg_t *cfg);

/**
 * Request a graceful shutdown / flush of all outstanding data and free all
 * resources. Blocking operation; can be safely invoked with NULL.
 */
void ps_dlw_destroy(ps_dlw_writer_t *writer);

/* -------------------------------------------------------------------------- */
/*  Data Submission / Back-Pressure                                           */
/* -------------------------------------------------------------------------- */

/**
 * Submit a single serialized event to the writer.
 *
 * Notes :
 *   – The memory pointed to by `payload` is copied asynchronously
 *   – The call is thread-safe and can be invoked from multiple workers
 *   – In case of PS_DLW_E_AGAIN the caller SHOULD retry later (non-fatal)
 *
 * Parameters
 * ----------
 *  writer   : writer handle returned by ps_dlw_create()
 *  payload  : pointer to serialized, immutable event data
 *  len      : size of the payload in bytes
 *  event_id : application-level unique identifier for deduplication
 *
 * Returns
 * -------
 *  ps_dlw_rc_e status code
 */
ps_dlw_rc_e
ps_dlw_write(ps_dlw_writer_t *writer,
             const void      *payload,
             size_t           len,
             uint64_t         event_id);

/**
 * Force flushing of all in-memory batches, blocking until completion.
 * Primarily intended for test-cases and graceful shutdown sequences.
 */
ps_dlw_rc_e ps_dlw_flush(ps_dlw_writer_t *writer);

/**
 * Cancel all in-flight requests, flush nothing, and unblock any waiters.
 * After calling this routine, the writer transitions into the SHUTDOWN state.
 */
ps_dlw_rc_e ps_dlw_cancel(ps_dlw_writer_t *writer);

/* -------------------------------------------------------------------------- */
/*  Metrics & Monitoring                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Obtain a snapshot of internal statistics.  The function is lock-free and
 * wait-free; partial updates are possible but values are consistent enough
 * for monitoring purposes.
 */
void ps_dlw_stats(ps_dlw_writer_t *writer, ps_dlw_stats_t *out_stats);

/* -------------------------------------------------------------------------- */
/*  Advanced / Expert                                                         */
/* -------------------------------------------------------------------------- */

/* Opaque snapshot handle used by zero-copy buffered read-backs */
typedef void (*ps_dlw_buffer_release_fn)(ps_dlw_buffer_t *);

/**
 * Obtain a read-only memory view of the currently accumulated batch.  Intended
 * for real-time dashboard previews.  The caller MUST NOT free the returned
 * memory and MUST call the provided `release` callback when finished so the
 * writer can safely mutate / reuse the buffer.
 *
 * Returns NULL if no data is available or on error.
 */
const void *
ps_dlw_peek_current_batch(ps_dlw_writer_t           *writer,
                          size_t                    *out_len,
                          ps_dlw_buffer_release_fn  *out_release_fn);

/* -------------------------------------------------------------------------- */
/*  Logging Helper (simple macro wrapper, overridable by defining PS_LOG)     */
/* -------------------------------------------------------------------------- */
#ifndef PS_LOG
#include <stdio.h>
#define PS_LOG(fmt, ...) \
    do { fprintf(stderr, "[ps-dlw] " fmt "\n", ##__VA_ARGS__); } while (0)
#endif /* PS_LOG */

/* -------------------------------------------------------------------------- */
#if defined(__cplusplus)
}   /* extern "C" */
#endif

#endif /* PULSAPHERE_ANALYTICS_SINK_SERVICE_DATA_LAKE_WRITER_H */
