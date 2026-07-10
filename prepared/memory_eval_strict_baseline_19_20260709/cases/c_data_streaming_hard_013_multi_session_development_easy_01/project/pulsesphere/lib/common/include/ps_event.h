/*
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * File:    pulsesphere/lib/common/include/ps_event.h
 * Author:  PulseSphere Core Team
 *
 * Description:
 *   Public definition of the PulseSphere event model and the associated
 *   helper routines.  All producers and consumers in the event fabric
 *   must depend exclusively on the abstractions declared in this header
 *   to guarantee ABI stability between micro-services.
 *
 *   The header purposefully avoids heavyweight dependencies – it can be
 *   included by hot code paths (e.g. the zero-copy sharded ring-buffer
 *   inside the ingestion layer).
 *
 *   Implementations for the non-inline routines are provided in
 *   `ps_event.c` and must be linked into every service binary.
 *
 * Thread-Safety:
 *   ps_event objects are reference counted using C11 atomics.  Increment
 *   and decrement operations are lock-free on all Tier-1 platforms.
 */

#pragma once

/* -------------------------------------------------------------------------- */
/* Standard Library                                                           */
/* -------------------------------------------------------------------------- */
#include <stdint.h>     /* uint*_t                                          */
#include <stddef.h>     /* size_t                                           */
#include <stdbool.h>    /* bool                                             */
#include <time.h>       /* time_t                                           */
#include <stdatomic.h>  /* atomic_* / _Atomic                               */

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

#define PS_EVENT_SCHEMA_VERSION   3u  /* Increment on breaking changes      */

/* -------------------------------------------------------------------------- */
/* Error Handling                                                             */
/* -------------------------------------------------------------------------- */

/*
 * PulseSphere services return rich error codes instead of errno to prevent
 * cross-module collisions and to facilitate machine parsing.
 */
typedef enum
{
    PS_EVENT_OK               = 0,
    PS_EVENT_EINVAL           = 1,  /* Invalid argument                     */
    PS_EVENT_ENOMEM           = 2,  /* Allocation failure                   */
    PS_EVENT_ESERIALIZE       = 3,  /* Serialization error                  */
    PS_EVENT_EDESERIALIZE     = 4,  /* Deserialization error                */
    PS_EVENT_EUNSUPPORTED     = 5,  /* Unsupported / unknown feature        */
    PS_EVENT_EINTERNAL        = 6   /* Unspecified internal error           */
} ps_event_err_t;

/* -------------------------------------------------------------------------- */
/* Event Classification                                                       */
/* -------------------------------------------------------------------------- */

typedef enum
{
    PS_EVENT_LIKE        = 0,
    PS_EVENT_COMMENT     = 1,
    PS_EVENT_SHARE       = 2,
    PS_EVENT_FOLLOW      = 3,
    PS_EVENT_REACTION    = 4,
    PS_EVENT_MAX         = 5          /* Sentinel, must stay last           */
} ps_event_type_t;

/* Returns a constant string suitable for logging / metrics. */
const char *ps_event_type_to_str(ps_event_type_t type);

/* -------------------------------------------------------------------------- */
/* Forward Declarations                                                       */
/* -------------------------------------------------------------------------- */

/* Opaque, columnar key-value storage (defined in ps_kv_map.h). */
struct ps_kv_map;

/* -------------------------------------------------------------------------- */
/* Event Header                                                               */
/* -------------------------------------------------------------------------- */

typedef struct
{
    uint64_t event_id;          /* Mandatory 128-bit ULID (lower half).    */
    uint64_t event_id_hi;       /* Upper half – allows natural ordering.   */

    uint64_t producer_id;       /* Unique instance ID of producer service. */
    uint64_t sequence;          /* Per-producer monotonically increasing.  */

    time_t   ts_sec;            /* Wall-clock seconds since epoch (UTC).   */
    uint32_t ts_nsec;           /* Nanoseconds within second.              */

    uint16_t schema_version;    /* == PS_EVENT_SCHEMA_VERSION.             */
    uint8_t  event_type;        /* ps_event_type_t cast for packing.       */
    uint8_t  reserved;          /* For future flags (e.g. compression).    */
} ps_event_header_t;

/* Compile-time assertion for header size (cache-line alignment). */
_Static_assert(sizeof(ps_event_header_t) == 48,
               "ps_event_header_t layout unexpectedly changed");

/* -------------------------------------------------------------------------- */
/* Event Object                                                               */
/* -------------------------------------------------------------------------- */

typedef struct ps_event
{
    ps_event_header_t    hdr;        /* Lightweight fixed part             */
    struct ps_kv_map    *attributes; /* Flexible, optional payload         */
    _Atomic uint32_t     refcnt;     /* Atomic reference counter           */

    /* Additional extension hooks for zero-copy pipelines.  Each module
     * may store one pointer-sized token that it owns exclusively. */
    void                *user_tag;

} ps_event_t;

/* -------------------------------------------------------------------------- */
/* Memory Management (Reference Counting)                                     */
/* -------------------------------------------------------------------------- */

/*
 * Creates a new, empty event object initialised with sane defaults.
 *
 * Parameters:
 *   type       – Classification of the event.
 *   producerid – 64-bit identifier of the emitting service instance.
 *   out_event  – Set to the newly created instance on success.
 *
 * Returns:
 *   PS_EVENT_OK on success, an error code otherwise.
 */
ps_event_err_t ps_event_create(ps_event_type_t  type,
                               uint64_t         producerid,
                               ps_event_t     **out_event);

/*
 * Increments the reference count.  Safe to call with NULL.
 * Matches ps_event_release().
 */
static inline void
ps_event_retain(ps_event_t *evt)
{
    if (evt) atomic_fetch_add_explicit(&evt->refcnt, 1, memory_order_relaxed);
}

/*
 * Decrements the reference count and destroys the object if it reaches zero.
 * Safe to call with NULL.
 */
void ps_event_release(ps_event_t *evt);

/*
 * Performs a deep copy, including the attributes map.  The new instance
 * starts with a refcount of 1, independent of the source's counter.
 */
ps_event_err_t ps_event_clone(const ps_event_t *src, ps_event_t **dst);

/* -------------------------------------------------------------------------- */
/* (De-)Serialization                                                         */
/* -------------------------------------------------------------------------- */

/* Magic number for on-wire framing: "PSE\0" */
#define PS_EVENT_WIRE_MAGIC 0x00505345u

/*
 * Computes the number of bytes required to serialize `evt` into the
 * binary on-wire representation used by the inter-service event fabric.
 */
ps_event_err_t ps_event_wire_size(const ps_event_t *evt, size_t *out_size);

/*
 * Serializes `evt` into `buf`.
 *   buf_size must be >= size returned by ps_event_wire_size().
 *   bytes_written is optional.
 */
ps_event_err_t ps_event_serialize(const ps_event_t *evt,
                                  uint8_t          *buf,
                                  size_t            buf_size,
                                  size_t           *bytes_written);

/*
 * Deserializes an event from `buf` and sets *out_event to the new object.
 * The caller assumes ownership (refcount == 1).
 */
ps_event_err_t ps_event_deserialize(const uint8_t *buf,
                                    size_t         buf_size,
                                    ps_event_t    **out_event);

/* -------------------------------------------------------------------------- */
/* Validation & Utilities                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Shallow validation of the event header – cheap guard against corrupt or
 * malicious data before expensive processing is performed.
 */
ps_event_err_t ps_event_validate_header(const ps_event_header_t *hdr);

/*
 * High-level API helper: returns true if event contains the given attribute.
 * Fast path is O(1) under hash-map implementation.
 */
bool ps_event_has_attr(const ps_event_t *evt, const char *key);

/*
 * Retrieve borrowed pointer to attribute value (cstring).  Returns NULL if
 * the key is missing.  The pointer is invalidated once the event is freed or
 * if the attribute entry is modified.
 */
const char *ps_event_get_attr(const ps_event_t *evt, const char *key);

/*
 * Insert / update attribute (deep copy of value).  Returns error on OOM.
 */
ps_event_err_t ps_event_put_attr(ps_event_t *evt,
                                 const char *key,
                                 const char *value);

/* -------------------------------------------------------------------------- */
/* Logging Helpers                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Formats `evt` as a single-line JSON string into `buf`.
 * On truncation, output is always NUL-terminated and
 * ps_event_format() returns PS_EVENT_EINTERNAL.
 */
ps_event_err_t ps_event_format(const ps_event_t *evt,
                               char             *buf,
                               size_t            buf_size);

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

/* Exposes global counters for observability dashboards (prometheus, etc.). */
struct ps_event_metrics
{
    _Atomic uint64_t total_created;
    _Atomic uint64_t total_destroyed;
    _Atomic uint64_t total_serialized;
    _Atomic uint64_t total_deserialized;
};

extern struct ps_event_metrics g_ps_event_metrics;

/* -------------------------------------------------------------------------- */
/* Inline Implementations (performance critical)                              */
/* -------------------------------------------------------------------------- */

static inline ps_event_type_t
ps_event_type(const ps_event_t *evt)
{
    return (ps_event_type_t)evt->hdr.event_type;
}

static inline uint64_t
ps_event_id_lo(const ps_event_t *evt)
{
    return evt->hdr.event_id;
}

static inline uint64_t
ps_event_id_hi(const ps_event_t *evt)
{
    return evt->hdr.event_id_hi;
}

#ifdef __cplusplus
} /* extern "C" */
#endif