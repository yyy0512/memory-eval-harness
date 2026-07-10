#ifndef PULSESPHERE_ENRICHMENT_ENGINE_H
#define PULSESPHERE_ENRICHMENT_ENGINE_H
/**
 *  PulseSphere – Real-Time Social Pulse Streaming Platform
 *  -------------------------------------------------------
 *  Enrichment Engine Public Interface
 *
 *  The enrichment engine is responsible for orchestrating a mutually-exclusive,
 *  pluggable chain of enrichment plug-ins (geo-tagging, language detection,
 *  toxicity scoring, etc.) that transform raw, immutable pulse events into a
 *  richly annotated form.  Plug-ins are compiled as shared libraries and loaded
 *  at runtime; each plug-in adheres to the ABI described in this header.
 *
 *  Author: PulseSphere Core Engineering Team
 *  License: Apache-2.0
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * Forward declarations (opaque handles) – hidden implementation details.
 * -------------------------------------------------------------------------- */
typedef struct ps_event              ps_event_t;              /* defined in core/event.h */
typedef struct ps_enrichment_engine  ps_enrichment_engine_t;  /* defined in enrichment_engine.c */

/* --------------------------------------------------------------------------
 * Error handling helpers
 * -------------------------------------------------------------------------- */

/**
 * All functions that can fail take a (char **err) argument.  When the function
 * reports an error (returning false or NULL), *err will be set to a newly
 * allocated, NUL-terminated error string explaining the failure.  The caller is
 * responsible for freeing the string with `ps_enrichment_err_free()`.
 */
void ps_enrichment_err_free(char *err);

/* --------------------------------------------------------------------------
 * Plug-in ABI – every enrichment plug-in must export one `ps_enrichment_plugin`
 * instance named `ps_enrichment_plugin_export` with default symbol visibility.
 * -------------------------------------------------------------------------- */

/* ABI version – bump when struct layout or semantics change */
#define PS_ENRICHMENT_PLUGIN_ABI_VERSION 0x0001u

/**
 * Plug-in life-cycle hooks.
 * All hooks must be thread-safe unless stated otherwise.
 */
typedef bool (*ps_plugin_init_fn)(const char *config_json,        /* plug-in specific conf    */
                                  char       **err);              /* malloc'ed on failure     */

typedef bool (*ps_plugin_enrich_fn)(ps_enrichment_engine_t *eng,  /* engine that hosts plug-in*/
                                    ps_event_t              *ev,  /* event to be mutated      */
                                    char                   **err);/* malloc'ed on failure     */

typedef void (*ps_plugin_shutdown_fn)(void);                      /* last chance cleanup      */

/**
 * Plug-in descriptor – immutable, constant data living in .rodata.
 */
typedef struct ps_enrichment_plugin
{
    uint32_t                abi_version;  /* must equal PS_ENRICHMENT_PLUGIN_ABI_VERSION */
    const char             *name;         /* human readable name                         */
    const char             *version;      /* semantic version of the plug-in             */
    ps_plugin_init_fn       init;         /* optional (may be NULL)                      */
    ps_plugin_enrich_fn     enrich;       /* mandatory                                   */
    ps_plugin_shutdown_fn   shutdown;     /* optional                                    */
    void                   *reserved[4];  /* future-proof padding                        */
} ps_enrichment_plugin_t;

/* GCC/Clang default-visibility export macro */
#if defined(__GNUC__) || defined(__clang__)
#   define PS_PLUGIN_EXPORT  __attribute__((visibility("default"))) const ps_enrichment_plugin_t
#else
#   define PS_PLUGIN_EXPORT  const ps_enrichment_plugin_t
#endif

/* --------------------------------------------------------------------------
 * Engine configuration – consumer side API
 * -------------------------------------------------------------------------- */

/**
 * Type of the callback invoked after an event has been successfully enriched.
 * The callback executes in a worker thread of the enrichment engine; therefore
 * it must be non-blocking and must not call any engine function that could
 * acquire a lock held by the worker.
 *
 * @param event     Read-only, enriched view of the original event.
 * @param user_ctx  Value provided in the registration call.
 */
typedef void (*ps_enriched_event_cb)(const ps_event_t *event, void *user_ctx);

/**
 * Create a new enrichment engine instance.
 *
 * @param config_path      Path to a JSON/YAML configuration document.  May be
 *                         NULL when defaults are acceptable.
 * @param queue_size       Upper bound of the internal lock-free queue.
 * @param err              Receives a malloc'ed string on failure (see above).
 *
 * @return Non-NULL handle on success; NULL on error.
 */
ps_enrichment_engine_t *
ps_enrichment_engine_create(const char *config_path,
                            size_t      queue_size,
                            char      **err);

/**
 * Register a plug-in with the engine.  Registration fails if the ABI version
 * mismatches, the name is already taken, or the plug-in initialization hook
 * returns an error.
 *
 * @note This function is NOT thread-safe and must be called before
 *       `ps_enrichment_engine_start()`.
 */
bool
ps_enrichment_engine_register_plugin(ps_enrichment_engine_t        *engine,
                                     const ps_enrichment_plugin_t  *plugin,
                                     char                         **err);

/**
 * Begin processing.  Spawns `worker_threads` threads that pull events from the
 * ingest queue, execute enrichment plug-ins in the order of registration, and
 * dispatch the enriched events to the user callback.
 *
 * @param engine           Engine instance.
 * @param worker_threads   Number of worker threads (>0).
 * @param enriched_cb      Callback to receive enriched events (non-NULL).
 * @param user_ctx         Opaque pointer delivered to the callback.
 * @param err              Filled on failure.
 */
bool
ps_enrichment_engine_start(ps_enrichment_engine_t *engine,
                           size_t                  worker_threads,
                           ps_enriched_event_cb    enriched_cb,
                           void                   *user_ctx,
                           char                  **err);

/**
 * Gracefully stop workers.  No new events will be accepted, outstanding events
 * will be finished, and all plug-ins will receive their shutdown hooks.
 *
 * @param engine          Engine instance.
 * @param timeout_ms      Max time to wait; 0 means wait indefinitely.
 *
 * @return true on orderly shutdown, false if timeout elapsed.
 */
bool
ps_enrichment_engine_stop(ps_enrichment_engine_t *engine,
                          uint64_t                timeout_ms);

/**
 * Destroy engine instance and free resources.  The caller must have previously
 * invoked `ps_enrichment_engine_stop()`.  Passing NULL is a no-op.
 */
void
ps_enrichment_engine_destroy(ps_enrichment_engine_t *engine);

/* --------------------------------------------------------------------------
 * Event ingestion API
 * -------------------------------------------------------------------------- */

/**
 * Submit a new event for enrichment.  Ownership of the event is transferred to
 * the engine even when the function fails (except when it fails with ENOMEM).
 *
 * @note This function is thread-safe and wait-free for the fast path.
 *
 * @param engine  Engine handle.
 * @param event   Heap-allocated event; must not be NULL.
 * @param err     Receives a message on failure.
 *
 * @return true if the event was enqueued successfully.
 */
bool
ps_enrichment_engine_submit_event(ps_enrichment_engine_t *engine,
                                  ps_event_t             *event,
                                  char                  **err);

/* --------------------------------------------------------------------------
 * Runtime statistics helpers – optional, for observability dashboards.
 * -------------------------------------------------------------------------- */

/**
 * Snapshot of runtime counters.  All fields are monotonically increasing.
 */
typedef struct ps_enrichment_stats
{
    uint64_t events_received;         /* # of events accepted via API          */
    uint64_t events_enriched;         /* # of events that completed pipeline   */
    uint64_t events_failed;           /* # of events that triggered an error   */
    uint64_t plugin_failures;         /* # of plug-in returned errors          */
    uint64_t bytes_in;                /* cumulative raw input size             */
    uint64_t bytes_out;               /* cumulative enriched size              */
} ps_enrichment_stats_t;

/**
 * Retrieve a consistent snapshot of statistics.
 */
void
ps_enrichment_engine_get_stats(const ps_enrichment_engine_t *engine,
                               ps_enrichment_stats_t        *out_stats);

/* -------------------------------------------------------------------------- */

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* PULSESPHERE_ENRICHMENT_ENGINE_H */
