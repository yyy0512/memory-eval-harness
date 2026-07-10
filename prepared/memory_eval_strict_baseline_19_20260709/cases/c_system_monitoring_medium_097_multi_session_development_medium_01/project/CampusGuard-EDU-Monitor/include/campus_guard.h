```c
/**
 *  CampusGuard EDU Monitor
 *  =======================
 *  Public API Header
 *
 *  File:    campus_guard.h
 *  Project: system_monitoring
 *  Author:  CampusGuard Core Team
 *  License: MIT
 *
 *  This header exposes the core API that Model, View, and Controller
 *  layers rely on to interact with CampusGuard’s monitoring engine.
 *  The API follows a callback-oriented, event-driven style consistent
 *  with the Observer pattern and is designed to be thread-safe.
 *
 *  NOTE:
 *    All functions return CG_Status.  CG_OK indicates success;
 *    any other value represents a specific error condition.
 */

#ifndef CAMPUS_GUARD_H
#define CAMPUS_GUARD_H

/* --------------------------------------------------------------------------
 *  Standard Library Dependencies
 * -------------------------------------------------------------------------- */
#include <stddef.h>   /* size_t               */
#include <stdint.h>   /* uint*_t, int*_t      */
#include <stdbool.h>  /* bool                 */
#include <time.h>     /* time_t               */

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 *  Versioning
 * -------------------------------------------------------------------------- */
#define CG_VERSION_MAJOR  1
#define CG_VERSION_MINOR  4
#define CG_VERSION_PATCH  2

#define CG_STRINGIFY(x)   #x
#define CG_TOSTRING(x)    CG_STRINGIFY(x)

#define CG_VERSION_STRING \
        CG_TOSTRING(CG_VERSION_MAJOR) "." \
        CG_TOSTRING(CG_VERSION_MINOR) "." \
        CG_TOSTRING(CG_VERSION_PATCH)

/* --------------------------------------------------------------------------
 *  Compile-time Configuration Flags
 * -------------------------------------------------------------------------- */
#ifndef CG_MAX_OBSERVERS
#define CG_MAX_OBSERVERS  32          /* Maximum simultaneous observers      */
#endif

#ifndef CG_MAX_LABEL
#define CG_MAX_LABEL      64          /* Length of resource / metric label   */
#endif

#ifndef CG_MAX_MESSAGE
#define CG_MAX_MESSAGE    512         /* Generic message buffer length       */
#endif

/* --------------------------------------------------------------------------
 *  Error / Status Codes
 * -------------------------------------------------------------------------- */
typedef enum
{
    CG_OK = 0,
    CG_ERR                 = -1,  /* Unspecified failure                    */
    CG_ERR_INIT            = -2,  /* Library initialization failed          */
    CG_ERR_NO_MEM          = -3,  /* Out of memory                          */
    CG_ERR_NOT_FOUND       = -4,  /* Resource not found                     */
    CG_ERR_INVALID_ARG     = -5,  /* Invalid argument                       */
    CG_ERR_IO              = -6,  /* File or network I/O error              */
    CG_ERR_DB              = -7,  /* SQLite error                           */
    CG_ERR_PERMISSION      = -8,  /* Auth/ACL denied                        */
    CG_ERR_TIMEOUT         = -9,  /* Operation timed out                    */
    CG_ERR_LIMIT_REACHED   = -10, /* e.g. CG_MAX_OBSERVERS hit              */
    CG_ERR_BUSY            = -11, /* Engine busy / operation in progress    */
    CG_ERR_UNSUPPORTED     = -12  /* Feature not compiled in                */
} CG_Status;

/* --------------------------------------------------------------------------
 *  Enumerations
 * -------------------------------------------------------------------------- */

/* Event categories recognized by the system */
typedef enum
{
    CG_EVT_METRIC,          /* Metric update (CPU, mem, etc.)             */
    CG_EVT_ALERT,           /* Security alert                             */
    CG_EVT_SCAN_COMPLETE,   /* Vulnerability scan finished                */
    CG_EVT_BACKUP_COMPLETE, /* Backup job finished                        */
    CG_EVT_LOG_ROTATED,     /* Log file rotated                           */
    CG_EVT_INTERNAL,        /* Internal housekeeping event                */
    CG_EVT_USER             /* User-generated event                       */
} CG_EventKind;

/* Metric type enumeration                                                       */
typedef enum
{
    CG_METRIC_COUNTER,      /* monotonically increasing value             */
    CG_METRIC_GAUGE,        /* arbitrary value that may go up/down        */
    CG_METRIC_HISTOGRAM,    /* histogram bucket sample                    */
    CG_METRIC_STATE         /* discrete state (OK/WARN/CRIT)              */
} CG_MetricType;

/* Metric state values for CG_METRIC_STATE metrics                              */
typedef enum
{
    CG_STATE_OK = 0,
    CG_STATE_WARN,
    CG_STATE_CRIT,
    CG_STATE_UNKNOWN
} CG_MetricState;

/* --------------------------------------------------------------------------
 *  Core Data Structures
 * -------------------------------------------------------------------------- */

/* Opaque handles                                                               */
typedef struct CG_Context_s    CG_Context;    /* Engine instance            */
typedef struct CG_Event_s      CG_Event;      /* Event envelope             */
typedef struct CG_Metric_s     CG_Metric;     /* Metric payload             */

/* Event envelope                                                              */
struct CG_Event_s
{
    CG_EventKind  kind;
    time_t        ts_epoch;                  /* UTC epoch seconds           */
    char          source[CG_MAX_LABEL];      /* Host / subsystem label      */
    union
    {
        CG_Metric* metric;                   /* Populated when kind == METRIC */
        char       message[CG_MAX_MESSAGE];  /* Generic message buffer      */
        void*      user;                     /* For user-defined event data */
    } payload;
};

/* Metric payload                                                              */
struct CG_Metric_s
{
    CG_MetricType  type;
    char           name[CG_MAX_LABEL];
    char           unit[8];                  /* e.g. "%", "MB", "rpm"       */

    /* For histogram this holds the observed value before bucketing */
    double         value;

    /* State metrics use the 'state' field */
    CG_MetricState state;
};

/* Observer callback signature                                                 */
typedef void (*CG_ObserverFn)(const CG_Event* event, void* user_data);

/* --------------------------------------------------------------------------
 *  Public API
 * -------------------------------------------------------------------------- */

/**
 *  cg_init
 *  -------
 *  Initialize the CampusGuard engine.
 *
 *  ctx        Pointer to receive allocated context handle.
 *  db_path    Path to SQLite database file for persistence (UTF-8).
 *
 *  Returns CG_OK on success.
 */
CG_Status cg_init(CG_Context** ctx, const char* db_path);

/**
 *  cg_shutdown
 *  -----------
 *  Gracefully shut down the engine and free resources.
 */
CG_Status cg_shutdown(CG_Context* ctx);

/**
 *  cg_observer_register
 *  --------------------
 *  Subscribe to event stream.
 *
 *  cb          Callback executed for every matching event (non-blocking).
 *  user_data   Pointer passed through to callback unchanged.
 *  handle_out  Optional unique ID for later unregister; may be NULL.
 */
typedef uint32_t CG_ObserverID;
CG_Status cg_observer_register(CG_Context*      ctx,
                               CG_EventKind     filter,     /* CG_EVT_* or wildcard */
                               CG_ObserverFn    cb,
                               void*            user_data,
                               CG_ObserverID*   handle_out);

/**
 *  cg_observer_unregister
 *  ----------------------
 *  Remove a previously registered observer.
 */
CG_Status cg_observer_unregister(CG_Context* ctx, CG_ObserverID id);

/**
 *  cg_emit_event
 *  -------------
 *  Publish an event into the engine’s event bus.
 *
 *  NOTE: This is intended for internal components and authorized
 *        plugins.  External callers without proper ACL will receive
 *        CG_ERR_PERMISSION.
 */
CG_Status cg_emit_event(CG_Context* ctx, const CG_Event* evt);

/**
 *  cg_collect_metric
 *  -----------------
 *  Convenience wrapper: populate a CG_Event of type METRIC and emit.
 */
CG_Status cg_collect_metric(CG_Context* ctx,
                            const char* source,
                            const CG_Metric* metric);

/**
 *  cg_request_scan
 *  ---------------
 *  Schedule an on-demand security scan.  Returns immediately; observer
 *  will receive CG_EVT_SCAN_COMPLETE when finished.
 *
 *  target   Hostname or IP of VM to scan.
 *  profile  Scan profile name (e.g., "quick-tcp", "full-udp").
 *  job_id   Optional handle returned for progress polling.
 */
typedef uint64_t CG_JobID;
CG_Status cg_request_scan(CG_Context* ctx,
                          const char* target,
                          const char* profile,
                          CG_JobID*   job_id);

/**
 *  cg_trigger_backup
 *  -----------------
 *  Start a backup job for the specified VM or service group.
 */
CG_Status cg_trigger_backup(CG_Context* ctx,
                            const char* target,
                            CG_JobID*   job_id);

/**
 *  cg_fetch_logs
 *  -------------
 *  Retrieve historical logs for a resource within [from, to].
 *
 *  The provided buffer is filled with newline-delimited UTF-8 log lines.
 *  If buffer is NULL, required size is placed in *bytes_needed.
 */
CG_Status cg_fetch_logs(CG_Context* ctx,
                        const char* resource,
                        time_t      from,
                        time_t      to,
                        char*       buffer,
                        size_t      buffer_len,
                        size_t*     bytes_needed);

/**
 *  cg_get_last_error
 *  -----------------
 *  Retrieves the last error string (thread-local) for diagnostic output.
 *
 *  The returned string is immutable and owned by the library.
 */
const char* cg_get_last_error(void);

/**
 *  cg_version
 *  ----------
 *  Returns compiler-stringified version, e.g. "1.4.2".
 */
static inline const char* cg_version(void)
{
    return CG_VERSION_STRING;
}

/* --------------------------------------------------------------------------
 *  Thread Safety Notes
 * --------------------------------------------------------------------------
 *  - The engine is internally synchronized with a reader/writer lock.
 *  - Observer callbacks may execute on worker threads—callbacks should
 *    therefore be thread-safe and return quickly.
 *  - The API is async-friendly: long-running operations queue jobs and
 *    notify via events rather than block callers.
 */

/* --------------------------------------------------------------------------
 *  Optional Advanced APIs (may be compiled out via CMake options)
 * -------------------------------------------------------------------------- */
#ifdef CG_ENABLE_EXPERIMENTAL

/**
 *  cg_register_udf
 *  ---------------
 *  Register a user-defined function (UDF) that can be invoked from
 *  within alert rule expressions at runtime.
 *
 *  name   Case-sensitive function name.
 *  fn     Callback implementing the function. Must be stateless.
 */
typedef double (*CG_UdfFn)(const double* args, size_t argc);
CG_Status cg_register_udf(CG_Context* ctx,
                          const char*  name,
                          CG_UdfFn     fn);

#endif /* CG_ENABLE_EXPERIMENTAL */

/* --------------------------------------------------------------------------
 *  C++ Compatibility
 * -------------------------------------------------------------------------- */
#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CAMPUS_GUARD_H */
```