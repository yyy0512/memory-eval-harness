#ifndef PULSESPHERE_GEO_TAG_STRATEGY_H
#define PULSESPHERE_GEO_TAG_STRATEGY_H

/*
 *  PulseSphere – Real-Time Social Pulse Streaming Platform
 *  -------------------------------------------------------
 *  Geo-Tagging Strategy Plug-in Interface
 *
 *  This header defines the ABI between the core enrichment service
 *  and pluggable geo-tagging strategies that are discovered and loaded
 *  at runtime via dlopen(3)/LoadLibrary().
 *
 *  Each shared object must export a factory function returning a
 *  fully-populated ps_geo_tag_strategy_t.  The core will keep the
 *  returned v-table around for the entire lifetime of the plug-in.
 *
 *  The contract purposefully avoids exposing internal data structures
 *  of PulseSphere.  Callers interact solely through opaque handles
 *  and the well-defined DTOs below.
 *
 *  Author : PulseSphere Engineering
 *  License: Apache License, Version 2.0
 */

#include <stdint.h>
#include <stddef.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/*-----------------------------------------------------------------------------
 *  Symbol visibility helpers
 *-----------------------------------------------------------------------------*/
#if defined(_WIN32) || defined(_WIN64)
#  if defined(PULSESPHERE_GEO_TAG_EXPORTS)
#    define PS_GEO_API __declspec(dllexport)
#  else
#    define PS_GEO_API __declspec(dllimport)
#  endif
#else
#  define PS_GEO_API __attribute__((visibility("default")))
#endif

/*-----------------------------------------------------------------------------
 *  Forward declarations to decouple from the rest of the system.
 *-----------------------------------------------------------------------------*/
struct ps_event_s;          /* Immutable social pulse, defined in core */
typedef struct ps_event_s ps_event_t;

/*-----------------------------------------------------------------------------
 *  Error handling
 *-----------------------------------------------------------------------------*/
typedef enum
{
    PS_GEO_OK                =  0,  /* Success */
    PS_GEO_E_INVALID_ARG     = -1,  /* Invalid parameter(s) */
    PS_GEO_E_NOT_INITIALISED = -2,  /* Strategy has not been initialised */
    PS_GEO_E_LOOKUP_FAIL     = -3,  /* External lookup (e.g., DB, service) failed */
    PS_GEO_E_INTERNAL        = -4,  /* Unspecified internal error */
} ps_geo_err_t;

/* Converts an error code to a human-readable string (thread-safe) */
PS_GEO_API const char* ps_geo_strerror(ps_geo_err_t code);

/*-----------------------------------------------------------------------------
 *  DTO – geographic location produced by strategies
 *-----------------------------------------------------------------------------*/
typedef struct
{
    double      latitude;                  /* In decimal degrees  (-90..90)  */
    double      longitude;                 /* In decimal degrees (-180..180) */
    char        country_iso[3];            /* Two-letter ISO-3166-1 alpha-2  */
    const char *region;                    /* UTF-8, e.g., "California"      */
    const char *city;                      /* UTF-8, e.g., "San Francisco"   */
    const char *timezone;                  /* Olson/IANA TZ, e.g., "America/Los_Angeles" */
} ps_geo_location_t;

/*-----------------------------------------------------------------------------
 *  Strategy capabilities flags
 *-----------------------------------------------------------------------------*/
typedef enum
{
    PS_GEO_CAP_NONE        = 0x00,
    /* The same strategy instance can be invoked concurrently
     * from multiple threads without external locking            */
    PS_GEO_CAP_THREAD_SAFE = 0x01,
    /* Strategy requires network access (for observability)      */
    PS_GEO_CAP_NETWORK_IO  = 0x02,
    /* Strategy depends on a local datastore (e.g., MMAP DB)     */
    PS_GEO_CAP_LOCAL_DB    = 0x04
} ps_geo_cap_t;

/*-----------------------------------------------------------------------------
 *  Configuration handle passed opaquely back to the strategy.
 *  This allows strategies to store context without leaking
 *  implementation details to the core.
 *-----------------------------------------------------------------------------*/
typedef struct ps_geo_tag_strategy
{
    /* ABI version.  Increment on breaking changes. */
    uint32_t abi_version;

    /* Human-readable name and description for registry / metrics */
    const char *name;               /* e.g., "MaxMind-MMDB-v2"     */
    const char *description;        /* e.g., "GeoIP2 City Edition" */

    /* Optional semantic versioning for operational tooling */
    const char *semver;             /* e.g., "2.1.0"               */

    /* Capability flags (bitwise OR of ps_geo_cap_t) */
    uint32_t capabilities;

    /* Implementation specific opaque pointer (private state) */
    void *impl;

    /* ------------------------¯\_(ツ)_/¯------------------------- *
     * Mandatory life-cycle hooks
     * ----------------------------------------------------------- */

    /*
     * Initialise strategy and allocate resources.
     *
     * @param self          Strategy handle (populated by factory).
     * @param config_json   Zero-terminated UTF-8 JSON string containing
     *                      strategy-specific configuration.  May be NULL
     *                      if not required.
     * @param err_buf       Out parameter.  *err_buf will point to a
     *                      newly-allocated, 0-terminated error string
     *                      if the function returns anything other than
     *                      PS_GEO_OK.  Caller must free() the buffer.
     *
     * @return PS_GEO_OK on success or an error code < 0 otherwise.
     */
    ps_geo_err_t (*init)(struct ps_geo_tag_strategy *self,
                         const char                  *config_json,
                         char                       **err_buf);

    /*
     * Perform geo-tagging of an immutable social event.
     *
     * The implementation must NOT modify the supplied event.  The
     * location structure is owned by the caller and must be fully
     * set by the callee on success.  Strings may reference internal
     * memory that lives as long as the strategy.  The core will copy
     * them if longer retention is required.
     *
     * @param self       Strategy handle
     * @param event      Immutable social pulse
     * @param out_loc    On success, populated with resolved location
     *
     * @return PS_GEO_OK on success or an error code < 0 otherwise.
     */
    ps_geo_err_t (*tag)(struct ps_geo_tag_strategy *self,
                        const ps_event_t           *event,
                        ps_geo_location_t          *out_loc);

    /*
     * Free all strategy resources.  Will be called exactly once before
     * the shared object is unloaded.  Must be idempotent.
     */
    void (*destroy)(struct ps_geo_tag_strategy *self);

} ps_geo_tag_strategy_t;

/*-----------------------------------------------------------------------------
 *  Factory function symbol
 *
 *  Every geo-tagging plug-in must expose the following function.  The
 *  core will dlsym()/GetProcAddress() it directly.  Ownership of the
 *  returned pointer transfers to the caller, which will invoke destroy().
 *
 *  Return NULL on unrecoverable errors (e.g., incompatible ABI).
 *-----------------------------------------------------------------------------*/
typedef ps_geo_tag_strategy_t* (*ps_geo_strategy_factory_fn)(void);

/* Standardised symbol name – do NOT mangle */
#define PS_GEO_TAG_STRATEGY_FACTORY_NAME "ps_geo_strategy_create"

/* Export wrapper for implementation convenience */
#define PS_GEO_STRATEGY_FACTORY_EXPORT \
    PS_GEO_API ps_geo_tag_strategy_t* ps_geo_strategy_create(void)

/*-----------------------------------------------------------------------------
 *  ABI version currently supported by PulseSphere core
 *-----------------------------------------------------------------------------*/
#define PULSESPHERE_GEO_TAG_ABI_VERSION 0x0001u

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_GEO_TAG_STRATEGY_H */
