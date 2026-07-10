/**
 * RetinaGuard Vision Suite - Common Header
 *
 * File:    common.h
 * Author:  RetinaGuard Engineering
 *
 * Summary:
 *   Project-wide definitions, utilities, and abstractions that must be visible
 *   throughout the RetinaGuard Vision Suite code-base.  This header is the only
 *   file that application modules outside of a given subsystem should include
 *   directly; all other headers should restrict their visibility to their
 *   respective sub-directories.
 *
 *   The intent is to:
 *     • Provide a single point of truth for compile-time feature flags,
 *       cross-platform compatibility shims, build-time metadata, and logging
 *       configuration.
 *     • Avoid unnecessary re-compilation cascades by keeping this header
 *       concise and stable.  Additions here should be justified and carefully
 *       reviewed.
 *
 * License:
 *   SPDX-License-Identifier: MIT
 */

#ifndef RETINAGUARD_COMMON_H
#define RETINAGUARD_COMMON_H

/* ────────────────────────────────────────────────────────────────────────── */
/*  Standard Library Includes                                                */
/* ────────────────────────────────────────────────────────────────────────── */

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ────────────────────────────────────────────────────────────────────────── */
/*  C++ Compatibility                                                        */
/* ────────────────────────────────────────────────────────────────────────── */
#ifdef __cplusplus
#   define RG_EXTERN_C_BEGIN extern "C" {
#   define RG_EXTERN_C_END   }
#else
#   define RG_EXTERN_C_BEGIN
#   define RG_EXTERN_C_END
#endif

RG_EXTERN_C_BEGIN

/* ────────────────────────────────────────────────────────────────────────── */
/*  Build-Time Metadata                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

#define RG_VERSION_MAJOR 1
#define RG_VERSION_MINOR 3
#define RG_VERSION_PATCH 0

#define RG_STRINGIFY(x)   #x
#define RG_TOSTR(x)       RG_STRINGIFY(x)

#define RG_VERSION_STRING \
    RG_TOSTR(RG_VERSION_MAJOR) "." RG_TOSTR(RG_VERSION_MINOR) "." RG_TOSTR(RG_VERSION_PATCH)

/* Git commit & build timestamp are fed by the build system (CMake). */
#ifndef RG_GIT_SHA
#   define RG_GIT_SHA "unknown"
#endif

#ifndef RG_BUILD_TIMESTAMP
#   define RG_BUILD_TIMESTAMP __DATE__ " " __TIME__
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Platform Detection                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

#if defined(_WIN32) || defined(_WIN64)
#   define RG_PLATFORM_WINDOWS 1
#else
#   define RG_PLATFORM_WINDOWS 0
#endif

#if defined(__APPLE__)
#   define RG_PLATFORM_MACOS   1
#else
#   define RG_PLATFORM_MACOS   0
#endif

#if defined(__linux__)
#   define RG_PLATFORM_LINUX   1
#else
#   define RG_PLATFORM_LINUX   0
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Symbol Visibility / DLL Export                                           */
/* ────────────────────────────────────────────────────────────────────────── */

#if RG_PLATFORM_WINDOWS
#   ifdef RETINAGUARD_EXPORT_SYMBOLS
#       define RG_API __declspec(dllexport)
#   else
#       define RG_API __declspec(dllimport)
#   endif
#else
#   define RG_API __attribute__((visibility("default")))
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Compile-Time Feature Flags                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/* Enable/disable verbose diagnostic logging (0-3). */
#ifndef RG_LOG_LEVEL
#   define RG_LOG_LEVEL 2   /* Default: INFO */
#endif

/* Enable memory allocation tracking for leak diagnostics. */
#ifndef RG_MEM_TRACKING
#   define RG_MEM_TRACKING 0
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Generic Helper Macros                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

#define RG_UNUSED(x)       (void)(x)
#define RG_ARRAY_LEN(a)    (sizeof(a) / sizeof(*(a)))
#define RG_MIN(a, b)       (((a) < (b)) ? (a) : (b))
#define RG_MAX(a, b)       (((a) > (b)) ? (a) : (b))

#if defined(__GNUC__) || defined(__clang__)
#   define RG_LIKELY(x)    __builtin_expect(!!(x), 1)
#   define RG_UNLIKELY(x)  __builtin_expect(!!(x), 0)
#   define RG_PRINTF(fmt_idx, arg_idx) \
        __attribute__((format(printf, fmt_idx, arg_idx)))
#else
#   define RG_LIKELY(x)    (x)
#   define RG_UNLIKELY(x)  (x)
#   define RG_PRINTF(fmt_idx, arg_idx)
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Status / Error Handling                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Enumerated return codes used across all subsystems.  Positive values may be
 * used for informational codes in the future; 0 represents success.
 */
typedef enum
{
    RG_STATUS_OK = 0,

    /* Generic failures */
    RG_STATUS_ERR          = -1,   /* Unspecified error */
    RG_STATUS_NO_MEMORY    = -2,   /* malloc/calloc/realloc failed */
    RG_STATUS_IO_ERROR     = -3,   /* File or network I/O error */
    RG_STATUS_INVALID_ARG  = -4,   /* Invalid parameter passed */
    RG_STATUS_TIMEOUT      = -5,   /* Operation timed out */
    RG_STATUS_NOT_IMPL     = -6,   /* Feature not implemented yet */

    /* Domain-specific failures */
    RG_STATUS_BAD_IMAGE    = -100, /* Image failed QC checks */
    RG_STATUS_MODEL_FAIL   = -101, /* Model inference error */
    RG_STATUS_EMR_FAIL     = -102, /* EMR integration error */

} RG_Status;

/**
 * Human-readable status string.
 */
static inline const char *rg_status_str(RG_Status status)
{
    switch (status)
    {
        case RG_STATUS_OK:          return "OK";
        case RG_STATUS_ERR:         return "Unspecified error";
        case RG_STATUS_NO_MEMORY:   return "Out of memory";
        case RG_STATUS_IO_ERROR:    return "I/O error";
        case RG_STATUS_INVALID_ARG: return "Invalid argument";
        case RG_STATUS_TIMEOUT:     return "Timeout";
        case RG_STATUS_NOT_IMPL:    return "Not implemented";
        case RG_STATUS_BAD_IMAGE:   return "Image quality failure";
        case RG_STATUS_MODEL_FAIL:  return "Model inference failure";
        case RG_STATUS_EMR_FAIL:    return "EMR integration failure";
        default:                    return "Unknown error";
    }
}

/* Shorthand macro to bail out on error. */
#define RG_CHK(expr)                                   \
    do {                                               \
        RG_Status _status = (expr);                    \
        if (RG_UNLIKELY(_status != RG_STATUS_OK))      \
        {                                              \
            return _status;                            \
        }                                              \
    } while (0)

/* ────────────────────────────────────────────────────────────────────────── */
/*  Logging                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Severity levels recognised by the logging back-end.
 */
typedef enum
{
    RG_LOG_ERROR = 0,
    RG_LOG_WARN  = 1,
    RG_LOG_INFO  = 2,
    RG_LOG_DEBUG = 3
} RG_LogSeverity;

/* Forward declaration implemented in logger.c */
RG_API void rg_log_write(RG_LogSeverity severity,
                         const char    *file,
                         int            line,
                         const char    *fmt, ...) RG_PRINTF(4, 5);

/* Convenience macros (compile-time filtered by RG_LOG_LEVEL). */
#if RG_LOG_LEVEL >= RG_LOG_ERROR
#   define RG_LOGE(fmt, ...) \
        rg_log_write(RG_LOG_ERROR, __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#else
#   define RG_LOGE(fmt, ...) ((void)0)
#endif

#if RG_LOG_LEVEL >= RG_LOG_WARN
#   define RG_LOGW(fmt, ...) \
        rg_log_write(RG_LOG_WARN,  __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#else
#   define RG_LOGW(fmt, ...) ((void)0)
#endif

#if RG_LOG_LEVEL >= RG_LOG_INFO
#   define RG_LOGI(fmt, ...) \
        rg_log_write(RG_LOG_INFO,  __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#else
#   define RG_LOGI(fmt, ...) ((void)0)
#endif

#if RG_LOG_LEVEL >= RG_LOG_DEBUG
#   define RG_LOGD(fmt, ...) \
        rg_log_write(RG_LOG_DEBUG, __FILE__, __LINE__, fmt, ##__VA_ARGS__)
#else
#   define RG_LOGD(fmt, ...) ((void)0)
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Memory Allocation Wrappers                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * RAII-style wrappers that hook into the project-wide memory tracker (when
 * enabled) and guarantee non-NULL returns (or abort the process if out-of-
 * memory).  Implementations live in memory.c.
 */
RG_API void *rg_malloc(size_t size);
RG_API void *rg_calloc(size_t n_items, size_t size_per_item);
RG_API void *rg_realloc(void *ptr, size_t new_size);
RG_API void  rg_free(void *ptr);

#if RG_MEM_TRACKING
/* Retrieve current memory usage snapshot (bytes allocated). */
RG_API size_t rg_mem_bytes_live(void);
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/*  Time Utilities                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * High-resolution monotonic timestamp (nanoseconds since unspecified epoch).
 * Wraps platform APIs (clock_gettime on POSIX, QueryPerformanceCounter on
 * Windows).  Implemented in timeutil.c.
 */
RG_API uint64_t rg_timestamp_now_ns(void);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Observer Pattern: Event Definitions                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Event types broadcast from the inference pipeline to subscribers such as the
 * model registry and real-time monitoring dashboard.
 */
typedef enum
{
    RG_EVT_NONE = 0,

    RG_EVT_IMAGE_INGESTED,     /* Raw fundus image captured */
    RG_EVT_IMAGE_PREPROCESSED, /* After QC & preprocessing */
    RG_EVT_FEATURES_EXTRACTED, /* Feature vectors ready     */
    RG_EVT_INFERENCE_DONE,     /* Model output available    */
    RG_EVT_REPORT_GENERATED,   /* Evaluation report created */
    RG_EVT_ALERT_TRIGGERED,    /* Clinician alert dispatched */

    RG_EVT_MAX
} RG_EventType;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Event Payload (Forward Declaration)                                      */
/* ────────────────────────────────────────────────────────────────────────── */

struct rg_event_payload;  /* Defined per-event in events.h */

/* Broadcast function implemented in event_bus.c */
RG_API void rg_event_publish(RG_EventType            type,
                             const struct rg_event_payload *payload);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Inline Utility Functions                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Clamp a floating-point value between min and max.
 */
static inline float rg_clamp_f32(float value, float min, float max)
{
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  End of Header                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

RG_EXTERN_C_END
#endif /* RETINAGUARD_COMMON_H */
