/*
 * PulseSphere - Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * File:        pulsesphere/lib/common/include/ps_common.h
 * Description: Project-wide common declarations, utilities and
 *              convenience macros.  Everything that is required
 *              frequently by multiple modules but does not belong
 *              to a single functional domain should live here.
 *
 * NOTE:
 *   This header is intentionally kept header-only (static inline /
 *   macros) so that it can be used freely without forcing an extra
 *   library link step.  All functions are therefore declared
 *   `static inline` and will be inlined by the compiler when
 *   optimisation is enabled.
 *
 * Copyright (c) 2024
 * SPDX-License-Identifier: MIT
 */

#ifndef PS_COMMON_H
#define PS_COMMON_H

/* ---------------------------------------------------------------------
 *  Standard headers
 * ------------------------------------------------------------------ */
#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---------------------------------------------------------------------
 *  External linkage for C++
 * ------------------------------------------------------------------ */
#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------
 *  Compiler / platform specific helpers
 * ------------------------------------------------------------------ */
#if defined(__GNUC__) || defined(__clang__)
#   define PS_LIKELY(x)      __builtin_expect(!!(x), 1)
#   define PS_UNLIKELY(x)    __builtin_expect(!!(x), 0)
#   define PS_NONNULL(...)   __attribute__((nonnull(__VA_ARGS__)))
#   define PS_UNUSED         __attribute__((unused))
#   define PS_ALIGNED(x)     __attribute__((aligned(x)))
#else
#   define PS_LIKELY(x)      (x)
#   define PS_UNLIKELY(x)    (x)
#   define PS_NONNULL(...)
#   define PS_UNUSED
#   define PS_ALIGNED(x)
#endif

#if !defined(PS_CACHE_LINE)
#   define PS_CACHE_LINE     64U     /* reasonable default */
#endif

/* ---------------------------------------------------------------------
 *  Error handling
 * ------------------------------------------------------------------ */
typedef enum ps_err
{
    PS_ERR_OK         = 0,   /* Everything is fine */
    PS_ERR_OOM        = -1,  /* Out of memory */
    PS_ERR_INVALID    = -2,  /* Invalid argument / state */
    PS_ERR_AGAIN      = -3,  /* Temporary unavailable, try again */
    PS_ERR_IO         = -4,  /* I/O error */
    PS_ERR_TIMEOUT    = -5,  /* Operation timed out */
    PS_ERR_NOTSUP     = -6,  /* Feature not supported */
    PS_ERR_PERM       = -7,  /* Permission denied */
    PS_ERR_OVERFLOW   = -8,  /* Value too large */
} ps_err_t;

/* Return const textual representation of error code */
static inline const char *
ps_err_str(const ps_err_t err)
{
    switch (err)
    {
        case PS_ERR_OK:        return "OK";
        case PS_ERR_OOM:       return "Out of memory";
        case PS_ERR_INVALID:   return "Invalid argument";
        case PS_ERR_AGAIN:     return "Temporary unavailable";
        case PS_ERR_IO:        return "I/O error";
        case PS_ERR_TIMEOUT:   return "Timed out";
        case PS_ERR_NOTSUP:    return "Not supported";
        case PS_ERR_PERM:      return "Permission denied";
        case PS_ERR_OVERFLOW:  return "Overflow";
        default:               return "Unknown error";
    }
}

/* ---------------------------------------------------------------------
 *  High-resolution time helpers
 * ------------------------------------------------------------------ */
/* Monotonic nanoseconds since unspecified epoch */
static inline uint64_t
ps_hrtime_ns(void)
{
    struct timespec ts;
    /* Use CLOCK_MONOTONIC for monotonic time */
    if (PS_UNLIKELY(clock_gettime(CLOCK_MONOTONIC, &ts) != 0))
        return 0;
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* Epoch (UTC) milliseconds */
static inline uint64_t
ps_epoch_ms(void)
{
    struct timespec ts;
    if (PS_UNLIKELY(clock_gettime(CLOCK_REALTIME, &ts) != 0))
        return 0;
    return (uint64_t)ts.tv_sec * 1000ULL + (uint64_t)(ts.tv_nsec / 1000000UL);
}

/* ---------------------------------------------------------------------
 *  Logging subsystem (light-weight)
 * ------------------------------------------------------------------ */
typedef enum ps_log_level
{
    PS_LOG_TRACE = 0,
    PS_LOG_DEBUG,
    PS_LOG_INFO,
    PS_LOG_WARN,
    PS_LOG_ERROR,
    PS_LOG_FATAL,
    PS_LOG_NONE        /* must stay last */
} ps_log_level_t;

/* Compile-time default log level if not set by application */
#ifndef PS_LOG_DEFAULT_LEVEL
#   define PS_LOG_DEFAULT_LEVEL  PS_LOG_INFO
#endif

/* External global variable can be overridden by application */
#ifndef PS_LOG_LEVEL_STATIC
    extern atomic_int g_ps_log_level;
#else
    static atomic_int g_ps_log_level = ATOMIC_VAR_INIT(PS_LOG_DEFAULT_LEVEL);
#endif

/* ANSI colour escape codes (disabled on WIN32 w/out VT processing) */
#ifndef PS_NO_COLOR
#   define PS_COLOR_TRACE   "\x1b[38;5;246m"
#   define PS_COLOR_DEBUG   "\x1b[38;5;33m"
#   define PS_COLOR_INFO    "\x1b[38;5;34m"
#   define PS_COLOR_WARN    "\x1b[38;5;214m"
#   define PS_COLOR_ERROR   "\x1b[38;5;196m"
#   define PS_COLOR_FATAL   "\x1b[38;5;199m"
#   define PS_COLOR_RESET   "\x1b[0m"
#else
#   define PS_COLOR_TRACE   ""
#   define PS_COLOR_DEBUG   ""
#   define PS_COLOR_INFO    ""
#   define PS_COLOR_WARN    ""
#   define PS_COLOR_ERROR   ""
#   define PS_COLOR_FATAL   ""
#   define PS_COLOR_RESET   ""
#endif

/* Internal helper – do not call directly */
static inline void
ps_log_write(const ps_log_level_t lvl,
             const char          *file,
             const int            line,
             const char          *func,
             const char          *fmt, ...)
{
    static const char *lvl_str[] = {
        "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"
    };
    static const char *lvl_color[] = {
        PS_COLOR_TRACE, PS_COLOR_DEBUG, PS_COLOR_INFO,
        PS_COLOR_WARN,  PS_COLOR_ERROR, PS_COLOR_FATAL
    };

    if (PS_UNLIKELY(lvl < 0 || lvl >= PS_LOG_NONE))
        return;

    /* Fast path: skip early if message will not be logged */
    int current = atomic_load_explicit(&g_ps_log_level, memory_order_relaxed);
    if (PS_LIKELY(lvl < current))
        return;

    /* Format timestamp */
    uint64_t ts_ms = ps_epoch_ms();
    uint64_t sec   = ts_ms / 1000ULL;
    uint64_t msec  = ts_ms % 1000ULL;

    /* Emit header */
    fprintf(stderr, "%s[%lu.%03lu] %-5s %-15s:%-4d %-17s | ",
            lvl_color[lvl], (unsigned long)sec, (unsigned long)msec,
            lvl_str[lvl], file, line, func);

    /* Format user message */
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);

    /* Reset colour and newline */
    fprintf(stderr, "%s\n", PS_COLOR_RESET);

    if (lvl == PS_LOG_FATAL)
        abort(); /* Immediate abort on fatal */
}

/* Public macros – caller can use PS_LOG(level, "text %d", value); */
#define PS_LOG(lvl, ...) \
    ps_log_write((lvl), __FILE__, __LINE__, __func__, __VA_ARGS__)

#define PS_TRACE(...)   PS_LOG(PS_LOG_TRACE, __VA_ARGS__)
#define PS_DEBUG(...)   PS_LOG(PS_LOG_DEBUG, __VA_ARGS__)
#define PS_INFO(...)    PS_LOG(PS_LOG_INFO,  __VA_ARGS__)
#define PS_WARN(...)    PS_LOG(PS_LOG_WARN,  __VA_ARGS__)
#define PS_ERROR(...)   PS_LOG(PS_LOG_ERROR, __VA_ARGS__)
#define PS_FATAL(...)   PS_LOG(PS_LOG_FATAL, __VA_ARGS__)

/* ---------------------------------------------------------------------
 *  Memory allocation helpers
 * ------------------------------------------------------------------ */
/* Safe malloc that aborts on OOM – fast code-path used for critical objects */
static inline void *
ps_xmalloc(size_t sz)
{
    void *p = malloc(sz);
    if (PS_UNLIKELY(p == NULL))
    {
        PS_FATAL("Out of memory allocating %zu bytes", sz);
        /* ps_log_write will abort() */
    }
    return p;
}

/* Realloc that handles NULL like malloc and aborts on failure */
static inline void *
ps_xrealloc(void *ptr, size_t sz)
{
    void *p = realloc(ptr, sz);
    if (PS_UNLIKELY(p == NULL))
    {
        PS_FATAL("Out of memory reallocating %zu bytes", sz);
        /* ps_log_write will abort() */
    }
    return p;
}

/* Aligned allocation (C11 aligned_alloc) with fallback for POSIX */
static inline void *
ps_xaligned_alloc(size_t alignment, size_t sz)
{
#if defined(_ISOC11_SOURCE)
    void *p = aligned_alloc(alignment, sz);
    if (PS_UNLIKELY(p == NULL))
    {
        PS_FATAL("Out of memory (aligned) allocating %zu bytes", sz);
    }
    return p;
#elif defined(_POSIX_VERSION)
    void *p = NULL;
    int rc = posix_memalign(&p, alignment, sz);
    if (PS_UNLIKELY(rc != 0))
    {
        PS_FATAL("posix_memalign(%zu, %zu) failed: %s",
                 alignment, sz, strerror(rc));
    }
    return p;
#else
    /* Fallback – not aligned */
    (void)alignment;
    return ps_xmalloc(sz);
#endif
}

/* ---------------------------------------------------------------------
 *  Atomic counter helper
 * ------------------------------------------------------------------ */
typedef struct ps_counter
{
    atomic_uint_least64_t value;
    uint8_t _pad[PS_CACHE_LINE - sizeof(atomic_uint_least64_t)];
} PS_ALIGNED(PS_CACHE_LINE) ps_counter_t;

static inline void
ps_counter_init(ps_counter_t *c, uint64_t initial)
{
    atomic_init(&c->value, initial);
}

/* Atomically add delta, return previous value */
static inline uint64_t
ps_counter_add(ps_counter_t *c, uint64_t delta)
{
    return atomic_fetch_add_explicit(&c->value,
                                     delta, memory_order_relaxed);
}

/* Atomically increment, return new value */
static inline uint64_t
ps_counter_inc(ps_counter_t *c)
{
    return atomic_fetch_add_explicit(&c->value,
                                     1, memory_order_relaxed) + 1;
}

/* Atomically read value */
static inline uint64_t
ps_counter_get(const ps_counter_t *c)
{
    return atomic_load_explicit(&c->value, memory_order_relaxed);
}

/* ---------------------------------------------------------------------
 *  Miscellaneous utilities
 * ------------------------------------------------------------------ */
/* Next power of two for 32-bit integers */
static inline uint32_t
ps_next_pow2_u32(uint32_t v)
{
    if (v == 0) return 1;
    v--;
    v |= v >> 1;
    v |= v >> 2;
    v |= v >> 4;
    v |= v >> 8;
    v |= v >> 16;
    return v + 1;
}

/* Hexdump – debug helper */
static inline void
ps_hexdump(const void *ptr, size_t len)
{
    const unsigned char *buf = (const unsigned char *)ptr;
    for (size_t i = 0; i < len; i++)
    {
        if (i % 16 == 0)
            fprintf(stderr, "%08zx | ", i);

        fprintf(stderr, "%02x ", buf[i]);

        if ((i + 1) % 8 == 0 && (i + 1) % 16 != 0)
            fputc(' ', stderr);

        if ((i + 1) % 16 == 0)
        {
            fprintf(stderr, "\n");
        }
    }
    if (len % 16 != 0)
        fprintf(stderr, "\n");
}

/* ---------------------------------------------------------------------
 *  Compile-time checks
 * ------------------------------------------------------------------ */
/* Ensure that ps_counter_t is cache-line padded */
_Static_assert(sizeof(ps_counter_t) == PS_CACHE_LINE,
               "ps_counter_t size mismatch – must equal cache line size");

/* ---------------------------------------------------------------------
 *  End of header
 * ------------------------------------------------------------------ */
#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PS_COMMON_H */
