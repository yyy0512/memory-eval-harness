/*
 * =============================================================================
 *  PulseSphere: Real-Time Social Pulse Streaming Platform
 *  ------------------------------------------------------
 *  File:    pulsesphere/services/enrichment_service/include/strategy_loader.h
 *  Author:  PulseSphere Core Team
 *
 *  Description:
 *      Public API for dynamically loading and unloading enrichment strategy
 *      plug-ins (.so, .dylib, .dll) at runtime.  Strategies implement the
 *      interface defined in `enrichment_strategy.h` and are discovered through
 *      a simple symbol table convention.  The loader performs:
 *
 *          • Runtime version negotiation
 *          • Safe symbol resolution
 *          • Reference counting & thread-safe unloading
 *          • Detailed error reporting
 *
 *      This header is meant to be consumed by production code in the
 *      enrichment service as well as by third-party plug-ins compiled out-of-
 *      tree.
 *
 *  Build:
 *      Requires a POSIX-compliant platform with dlopen(3)/dlsym(3) or Windows
 *      equivalent.  The implementation (.c) must account for platform
 *      differences (see strategy_loader_posix.c, strategy_loader_win32.c).
 *
 *  License: Apache-2.0
 * =============================================================================
 */

#ifndef PULSESPHERE_ENRICHMENT_SERVICE_STRATEGY_LOADER_H
#define PULSESPHERE_ENRICHMENT_SERVICE_STRATEGY_LOADER_H

/* ------------------------------------------------------------------------- */
/*  System headers                                                            */
/* ------------------------------------------------------------------------- */
#include <stdint.h>     /* uint32_t                                         */
#include <stddef.h>     /* size_t                                           */

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------------- */
/*  Forward declarations & opaque handles                                    */
/* ------------------------------------------------------------------------- */

struct ps_enrichment_strategy;   /* defined in enrichment_strategy.h         */
typedef struct ps_enrichment_strategy ps_enrichment_strategy_t;

/*
 * Opaque handle returned by the loader.  Clients treat this as a token that
 * represents a successfully loaded shared object + resolved v-table.
 */
typedef struct ps_strategy_handle ps_strategy_handle_t;

/* ------------------------------------------------------------------------- */
/*  Versioning                                                               */
/* ------------------------------------------------------------------------- */

/*
 * Strategy ABI version expected by the running enrichment service.  Must be
 * incremented whenever `ps_enrichment_strategy` changes in a breaking way.
 *
 * Plug-ins embedding an incompatible version will be rejected at load-time.
 */
#define PULSESPHERE_STRATEGY_ABI_VERSION  0x0001u

/* ------------------------------------------------------------------------- */
/*  Error handling                                                            */
/* ------------------------------------------------------------------------- */

/*
 * Enumerates all recoverable/non-recoverable loader errors.  Extend carefully,
 * keeping ordering intact to preserve binary compatibility.
 */
typedef enum
{
    PS_STRAT_LOADER_OK = 0,              /* success                              */
    PS_STRAT_LOADER_EINVAL,             /* invalid argument                     */
    PS_STRAT_LOADER_ENOMEM,             /* allocation failed                    */
    PS_STRAT_LOADER_EDLOPEN,            /* shared object could not be opened    */
    PS_STRAT_LOADER_ESYM,               /* required symbol missing              */
    PS_STRAT_LOADER_EABIVER,            /* ABI version mismatch                 */
    PS_STRAT_LOADER_EINIT,              /* strategy->init(..) failed            */
    PS_STRAT_LOADER_EBUSY,              /* attempt to unload while in-use       */
    PS_STRAT_LOADER_EUNKNOWN            /* unspecified failure                  */
} ps_strat_loader_status_t;

/*
 * Returns a human-readable NUL-terminated string describing |status|.
 * The pointer must NOT be freed by the caller.
 */
const char *ps_strat_loader_strerror(ps_strat_loader_status_t status);

/* ------------------------------------------------------------------------- */
/*  Loader API                                                                */
/* ------------------------------------------------------------------------- */

/*
 * ps_strategy_loader_load
 * -----------------------
 * Dynamically loads the shared object at |path|, validates the ABI, resolves
 * mandatory symbols, and calls the strategy's init() entry-point.  On success,
 * |*out_handle| receives an opaque handle for subsequent invocations.
 *
 * Parameters:
 *      path        – absolute or relative path to plug-in
 *      user_data   – caller-supplied context forwarded to strategy::init()
 *      out_handle  – (out) receives handle; untouched on failure
 *
 * Returns:
 *      PS_STRAT_LOADER_OK on success, specific error code otherwise.
 *
 * Thread safety:
 *      This function is thread-safe; internal initialization is protected.
 */
ps_strat_loader_status_t
ps_strategy_loader_load(const char        *path,
                        void              *user_data,
                        ps_strategy_handle_t **out_handle);

/*
 * ps_strategy_loader_get_strategy
 * -------------------------------
 * Convenience accessor for the resolved v-table.  The returned pointer is owned
 * by the handle and remains valid until ps_strategy_loader_unload() succeeds.
 */
ps_enrichment_strategy_t *
ps_strategy_loader_get_strategy(ps_strategy_handle_t *handle);

/*
 * ps_strategy_loader_ref / ps_strategy_loader_unref
 * ------------------------------------------------
 * Increments/decrements the reference count of |handle|.  Actual unloading
 * occurs when the refcount reaches zero.  Safe to call from multiple threads.
 */
void ps_strategy_loader_ref(ps_strategy_handle_t *handle);
void ps_strategy_loader_unref(ps_strategy_handle_t *handle);

/*
 * ps_strategy_loader_unload
 * -------------------------
 * Attempts to unload the strategy immediately (internal refcount must be 1).
 * On success, the handle is freed and *handle becomes invalid.
 *
 * Returns:
 *      PS_STRAT_LOADER_OK on success,
 *      PS_STRAT_LOADER_EBUSY if other references exist.
 */
ps_strat_loader_status_t
ps_strategy_loader_unload(ps_strategy_handle_t *handle);


/* ------------------------------------------------------------------------- */
/*  Introspection helpers                                                     */
/* ------------------------------------------------------------------------- */

/*
 * Retrieves the canonical name and semantic version of the loaded strategy.
 * Output strings are null-terminated and allocated by the caller.
 */
ps_strat_loader_status_t
ps_strategy_loader_name(ps_strategy_handle_t *handle,
                        char                 *out_name,
                        size_t                name_cap,
                        uint32_t             *out_version_major,
                        uint32_t             *out_version_minor);

/* ------------------------------------------------------------------------- */
/*  Loader configuration                                                      */
/* ------------------------------------------------------------------------- */

/*
 * Type of user-provided callback to report asynchronous loader errors or
 * diagnostic messages.  Implementations must be re-entrant.
 */
typedef void (*ps_strategy_loader_log_fn)(int level,
                                          const char *component,
                                          const char *fmt, ...);

#define PS_STRAT_LOG_DEBUG   0
#define PS_STRAT_LOG_INFO    1
#define PS_STRAT_LOG_WARN    2
#define PS_STRAT_LOG_ERROR   3

/*
 * Registers a global logging callback.  Passing NULL disables logging.
 * This function is NOT thread-safe and must be called during single-threaded
 * program startup prior to any other loader APIs.
 */
void ps_strategy_loader_set_logger(ps_strategy_loader_log_fn logger);

/* ------------------------------------------------------------------------- */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_ENRICHMENT_SERVICE_STRATEGY_LOADER_H */
