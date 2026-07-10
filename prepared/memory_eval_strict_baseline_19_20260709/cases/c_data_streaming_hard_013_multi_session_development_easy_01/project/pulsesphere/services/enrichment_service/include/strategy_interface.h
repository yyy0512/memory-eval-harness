/*
 *  strategy_interface.h
 *
 *  PulseSphere – Real-Time Social Pulse Streaming Platform
 *  -------------------------------------------------------
 *  Public C interface that every enrichment strategy plug-in MUST implement.
 *
 *  Purpose
 *  -------
 *  Allows run-time discovery and hot-swapping of alternative enrichment
 *  algorithms (geo-tagging, toxicity scoring, language detection, etc.)
 *  without recompilation of the core service.  Each plug-in is a shared
 *  library (.so/.dll) that exports a single ps_register_strategy() symbol
 *  returning a statically-allocated v-table describing the strategy.
 *
 *  Threading contract
 *  ------------------
 *  • The core service MAY invoke `enrich()` from multiple worker threads
 *    concurrently. Implementations MUST therefore guarantee thread safety
 *    or declare `thread_safe == false` in the meta-data.
 *  • `init()` and `destroy()` are called exactly once on the management
 *    thread. They can be used to allocate/free global resources.
 *
 *  Ownership rules
 *  ---------------
 *  • All memory returned in `out_event` is owned by the core service, which
 *    will free it with the allocator supplied in the context.
 *  • Plug-ins MUST NOT call free(3) directly; always use ctx->mem_free.
 *
 *  Created on: 2024-05-18
 *  Author     : PulseSphere Core Team
 */

#ifndef PULSESPHERE_ENRICHMENT_STRATEGY_INTERFACE_H
#define PULSESPHERE_ENRICHMENT_STRATEGY_INTERFACE_H

/* ─── Standard headers ─────────────────────────────────────────────────────── */
#include <stdint.h>     /* uint32_t, uint64_t … */
#include <stddef.h>     /* size_t              */
#include <stdbool.h>    /* bool                */

/* ─── Platform-agnostic export macros ──────────────────────────────────────── */
#if defined(_WIN32) || defined(__CYGWIN__)
  #ifdef BUILDING_PULSESPHERE_STRATEGY
    #define PS_EXPORT __declspec(dllexport)
  #else
    #define PS_EXPORT __declspec(dllimport)
  #endif
#else
  #define PS_EXPORT __attribute__((visibility("default")))
#endif

/* ─── ABI compatibility info ───────────────────────────────────────────────── */
#define PS_STRATEGY_API_MAJOR   1U   /* Increment on breaking changes */
#define PS_STRATEGY_API_MINOR   0U   /* Increment on additive changes */

/* ─── Forward declarations to avoid heavy dependencies ────────────────────── */
typedef struct ps_raw_event      ps_raw_event_t;     /* immutable inbound event */
typedef struct ps_curated_event  ps_curated_event_t; /* enriched outbound event */
typedef struct ps_logger         ps_logger_t;        /* logging facade          */

/* ─── Result / error codes ─────────────────────────────────────────────────── */
typedef enum
{
    PS_OK                    =  0, /* Success                               */
    PS_ERR_INTERNAL          = -1, /* Unspecified internal error            */
    PS_ERR_INVALID_ARGUMENT  = -2, /* NULL or out-of-range parameter        */
    PS_ERR_NOMEM             = -3, /* Memory allocation failure             */
    PS_ERR_TRANSIENT         = -4, /* Temporary, retry might succeed        */
    PS_ERR_PERMANENT         = -5  /* Non-recoverable, skip this event      */
} ps_status_t;

/* ─── Memory allocator contract ───────────────────────────────────────────── */
typedef void *(*ps_mem_alloc_f)(void *user_ctx, size_t size);
typedef void  (*ps_mem_free_f )(void *user_ctx, void *ptr);

/* ─── Strategy context handed to every callback ───────────────────────────── */
typedef struct ps_strategy_context
{
    uint32_t        api_major;     /* = PS_STRATEGY_API_MAJOR              */
    uint32_t        api_minor;     /* = PS_STRATEGY_API_MINOR              */

    /* Service facilities ---------------------------------------------------- */
    ps_logger_t    *logger;        /* Logging sink injected by host        */
    ps_mem_alloc_f  mem_alloc;     /* Host-provided allocator              */
    ps_mem_free_f   mem_free;      /* Companion de-allocator               */
    void           *mem_user_ctx;  /* Opaque context for allocator         */

    /* Plug-in private data -------------------------------------------------- */
    void           *user_state;    /* Strategy can store anything here     */

    /* Reserved for future expansion ---------------------------------------- */
    void           *reserved[4];
} ps_strategy_context_t;

/* ─── Strategy capabilities & metadata ────────────────────────────────────── */
typedef struct ps_strategy_capabilities
{
    const char *name;          /* Short human-readable name                  */
    const char *author;        /* "Jane Doe <jane@corp.com>"                 */
    const char *version;       /* Free-form semantic version string          */
    const char *description;   /* Longer multi-line description (UTF-8)      */
    bool        thread_safe;   /* true  -> enrich() can be called in parallel
                                  false -> core will apply a mutex          */
} ps_strategy_capabilities_t;

/* ─── Strategy v-table ─────────────────────────────────────────────────────── */
typedef struct ps_enrichment_strategy
{
    /* Mandatory: must be non-NULL ------------------------------------------ */
    const ps_strategy_capabilities_t *meta;

    /* Initialize global resources (e.g., model loading, network sockets)
     *  – config_json: UTF-8 JSON string containing arbitrary configuration
     *                 supplied by orchestration layer.
     *  – ctx        : Writable context pointer (see above).
     * Return PS_OK on success.
     */
    ps_status_t (*init)(
        ps_strategy_context_t *ctx,
        const char            *config_json);

    /* Enrich a single immutable event.
     *  – in_event : Pointer to raw event (owned by core, read-only).
     *  – out_event: [out] newly allocated enriched event on success;
     *               implementations MUST allocate with ctx->mem_alloc.
     * Return:
     *  – PS_OK          : success, out_event set (non-NULL).
     *  – PS_ERR_TRANSIENT: temporary failure – core MAY retry later.
     *  – PS_ERR_PERMANENT: permanent failure – event will be dropped.
     */
    ps_status_t (*enrich)(
        ps_strategy_context_t *ctx,
        const ps_raw_event_t  *in_event,
        ps_curated_event_t   **out_event);

    /* Flush any batched state (optional, may be NULL).
     * Called periodically as well as during graceful shutdown.
     */
    ps_status_t (*flush)(ps_strategy_context_t *ctx);

    /* Release all resources.
     * After return the strategy will never be called again.
     * Must be idempotent.
     */
    void (*destroy)(ps_strategy_context_t *ctx);

} ps_enrichment_strategy_t;

/* ─── Plug-in entry point ──────────────────────────────────────────────────── */
/*
 * Each shared library MUST export a function with the following signature.
 * Returning PS_OK indicates that `*out_strategy` has been populated with a
 * valid pointer to a static (immutable) ps_enrichment_strategy_t instance.
 * The structure MUST remain alive for the lifetime of the process.
 *
 * Typical implementation pattern:
 *
 *  static const ps_strategy_capabilities_t META = { … };
 *  static const ps_enrichment_strategy_t STRAT = { &META, init, enrich, flush, destroy };
 *
 *  PS_EXPORT
 *  ps_status_t ps_register_strategy(const ps_enrichment_strategy_t **out_strategy)
 *  {
 *      *out_strategy = &STRAT;
 *      return PS_OK;
 *  }
 */
typedef ps_status_t (*ps_register_strategy_f)(
        const ps_enrichment_strategy_t **out_strategy);

PS_EXPORT
ps_status_t ps_register_strategy(
        const ps_enrichment_strategy_t **out_strategy);

/* ─── Utility helpers (optional) ───────────────────────────────────────────── */
#ifdef __cplusplus
extern "C" {
#endif

/* Log helper that gracefully handles NULL logger pointer. */
static inline void
ps_log(ps_strategy_context_t *ctx,
       int                    level,
       const char            *fmt, ...);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_ENRICHMENT_STRATEGY_INTERFACE_H */


/* ─── Implementation of header-only helpers ───────────────────────────────── */
#ifdef PULSESPHERE_STRATEGY_INTERFACE_IMPL
#include <stdarg.h>
#include <stdio.h>

static inline void
ps_log(ps_strategy_context_t *ctx,
       int                    level,
       const char            *fmt, ...)
{
    if (!ctx || !ctx->logger || !fmt) { return; }

    /* Assume ps_logger_t provides ps_logger_log(ps_logger_t*, int, const char*) */
    char  buf[1024];
    va_list ap;
    va_start(ap, fmt);
    (void)vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);

    extern void ps_logger_log(ps_logger_t *, int, const char *);
    ps_logger_log(ctx->logger, level, buf);
}
#endif /* PULSESPHERE_STRATEGY_INTERFACE_IMPL */