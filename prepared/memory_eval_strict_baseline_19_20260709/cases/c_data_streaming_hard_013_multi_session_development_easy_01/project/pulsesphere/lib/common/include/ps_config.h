#ifndef PS_CONFIG_H
#define PS_CONFIG_H
/*
 *  PulseSphere – Real-Time Social Pulse Streaming Platform
 *  -------------------------------------------------------
 *  ps_config.h
 *
 *  Central compile-time configuration header.  The sole purpose of this file
 *  is to provide a single, canonical location for all global #defines and
 *  feature-toggles that influence the public ABI or behaviour of the entire
 *  PulseSphere codebase.
 *
 *  This header is intended to be included anywhere within the project—
 *  internal libraries, plug-in SDKs, tools, and test-suites alike.  Keep this
 *  header entirely self-contained and free of project-internal includes to
 *  guarantee that build-time probes (e.g. pkg-config, autoconf, CMake) can
 *  parse it in isolation.
 *
 *  Author: PulseSphere Engineering Team
 *  Copyright (c) 2024
 */

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

/* --------------------------------------------------------------------------
 *  Versioning & Build Metadata
 * -------------------------------------------------------------------------- */
#define PS_VERSION_MAJOR       1
#define PS_VERSION_MINOR       2
#define PS_VERSION_PATCH       0
#define PS_VERSION_STRING      "1.2.0"

#ifndef PS_BUILD_ID
/* Optionally provided by the build system. */
#   define PS_BUILD_ID         "unknown"
#endif

#ifndef PS_GIT_COMMIT
/* Expanded by -DPS_GIT_COMMIT=\""$(git rev-parse --short HEAD)"\" */
#   define PS_GIT_COMMIT       "0000000"
#endif

#ifndef PS_BUILD_DATE
#   define PS_BUILD_DATE       __DATE__ " " __TIME__
#endif

/* --------------------------------------------------------------------------
 *  Compiler & Platform Detection
 * -------------------------------------------------------------------------- */

/* Compiler --------------------------------------------------------------- */
#if defined(__clang__)
#   define PS_COMPILER_CLANG 1
#elif defined(__GNUC__) || defined(__GNUG__)
#   define PS_COMPILER_GCC   1
#elif defined(_MSC_VER)
#   define PS_COMPILER_MSVC  1
#else
#   error "Unsupported compiler"
#endif

/* Operating System -------------------------------------------------------- */
#if defined(_WIN32) || defined(_WIN64)
#   define PS_OS_WINDOWS 1
#elif defined(__linux__)
#   define PS_OS_LINUX   1
#elif defined(__APPLE__) && defined(__MACH__)
#   define PS_OS_DARWIN  1
#else
#   error "Unsupported operating system"
#endif

/* CPU Architecture ------------------------------------------------------- */
#if defined(__x86_64__) || defined(_M_X64)
#   define PS_ARCH_X86_64 1
#   define PS_CACHELINE_SIZE 64
#elif defined(__aarch64__) || defined(_M_ARM64)
#   define PS_ARCH_ARM64  1
#   define PS_CACHELINE_SIZE 128 /* Modern ARM core */
#else
#   error "Unsupported CPU architecture"
#endif

/* Endianness ------------------------------------------------------------- */
#if defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__)
#   define PS_LITTLE_ENDIAN 1
#elif defined(__BYTE_ORDER__) && (__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__)
#   define PS_BIG_ENDIAN    1
#else
/* Fallback runtime detection possible, but we require little endian. */
#   error "Unable to determine endianness"
#endif

/* --------------------------------------------------------------------------
 *  Visibility & Inlining
 * -------------------------------------------------------------------------- */
#if defined(PS_COMPILER_MSVC)
#   define PS_FORCE_INLINE __forceinline
#   define PS_NOINLINE     __declspec(noinline)
#   define PS_EXPORT       __declspec(dllexport)
#   define PS_IMPORT       __declspec(dllimport)
#elif defined(PS_COMPILER_GCC) || defined(PS_COMPILER_CLANG)
#   define PS_FORCE_INLINE inline __attribute__((always_inline))
#   define PS_NOINLINE     __attribute__((noinline))
#   define PS_EXPORT       __attribute__((visibility("default")))
#   define PS_IMPORT       /* not used */
#else
#   define PS_FORCE_INLINE inline
#   define PS_NOINLINE
#   define PS_EXPORT
#   define PS_IMPORT
#endif

#ifdef PS_BUILD_SHARED
#   if defined(PS_LIBRARY)
#       define PS_API PS_EXPORT
#   else
#       define PS_API PS_IMPORT
#   endif
#else
#   define PS_API
#endif

/* --------------------------------------------------------------------------
 *  Diagnostics & Likely / Unlikely Hints
 * -------------------------------------------------------------------------- */
#if defined(PS_COMPILER_GCC) || defined(PS_COMPILER_CLANG)
#   define PS_LIKELY(x)   __builtin_expect(!!(x), 1)
#   define PS_UNLIKELY(x) __builtin_expect(!!(x), 0)
#else
#   define PS_LIKELY(x)   (x)
#   define PS_UNLIKELY(x) (x)
#endif

/* --------------------------------------------------------------------------
 *  Compile-time Assertions
 * -------------------------------------------------------------------------- */
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
#   define PS_STATIC_ASSERT _Static_assert
#else
/* Poor man's static assert */
#   define PS_STATIC_ASSERT(expr, msg) typedef char static_assertion_##msg[(expr)?1:-1]
#endif

/* --------------------------------------------------------------------------
 *  Debug / Release Build Flags
 * -------------------------------------------------------------------------- */
#if !defined(NDEBUG)
#   define PS_DEBUG 1
#else
#   define PS_DEBUG 0
#endif

/* --------------------------------------------------------------------------
 *  Feature Toggles
 *  (These can be overridden via compiler flags, e.g.
 *   -DPS_WITH_GEOIP=0  to disable GeoIP enrichment)
 * -------------------------------------------------------------------------- */
#ifndef PS_WITH_GEOIP
#   define PS_WITH_GEOIP               1
#endif

#ifndef PS_WITH_LANG_DETECT
#   define PS_WITH_LANG_DETECT         1
#endif

#ifndef PS_WITH_TOXICITY_SCORE
#   define PS_WITH_TOXICITY_SCORE      1
#endif

#ifndef PS_WITH_METRICS_EXPORTER
#   define PS_WITH_METRICS_EXPORTER    1
#endif

#ifndef PS_WITH_PROMPT_REPLAY_CACHE
#   define PS_WITH_PROMPT_REPLAY_CACHE 1
#endif

/* --------------------------------------------------------------------------
 *  Memory Sanitizer & Thread Sanitizer Instrumentation
 * -------------------------------------------------------------------------- */
#if defined(__has_feature)
#   if __has_feature(address_sanitizer)
#       define PS_WITH_ASAN 1
#   endif
#   if __has_feature(thread_sanitizer)
#       define PS_WITH_TSAN 1
#   endif
#endif

/* --------------------------------------------------------------------------
 *  Logging Levels
 * -------------------------------------------------------------------------- */
typedef enum {
    PS_LOG_TRACE = 0,
    PS_LOG_DEBUG = 1,
    PS_LOG_INFO  = 2,
    PS_LOG_WARN  = 3,
    PS_LOG_ERROR = 4,
    PS_LOG_FATAL = 5,
} ps_log_level_t;

/* Default log level (can be -DPS_LOG_LEVEL=<n>) */
#ifndef PS_LOG_LEVEL
#   if PS_DEBUG
#       define PS_LOG_LEVEL PS_LOG_DEBUG
#   else
#       define PS_LOG_LEVEL PS_LOG_INFO
#   endif
#endif

/* --------------------------------------------------------------------------
 *  Runtime Configuration Structure
 *  (Populated once during bootstrap; read-only afterwards)
 * -------------------------------------------------------------------------- */
typedef struct ps_runtime_config {
    /* Configure size of event batch window (in milliseconds). */
    uint32_t         batch_window_ms;

    /* Maximum number of parallel enrichment workers. */
    uint16_t         enrichment_workers;

    /* Set at start-up from CLI flag `--log-level`, overrides compile-time. */
    ps_log_level_t   log_level;

    /* Feature masks (bit-fields) */
    bool             enable_geoip           : 1;
    bool             enable_language_detect : 1;
    bool             enable_toxicity_score  : 1;
    bool             enable_metrics_export  : 1;
    bool             enable_replay_cache    : 1;

    /* Reserved for future use – must be zero. */
    uint32_t         _reserved;
} ps_runtime_config_t;

/* --------------------------------------------------------------------------
 *  Defaults (These values may be overridden by runtime config file/CLI)
 * -------------------------------------------------------------------------- */
#define PS_DEFAULT_BATCH_WINDOW_MS     500    /* 0.5 seconds */
#define PS_DEFAULT_ENRICHMENT_WORKERS  8

/* --------------------------------------------------------------------------
 *  Configuration Validation Helpers
 * -------------------------------------------------------------------------- */

/**
 * Validates a ps_runtime_config_t struct for logical correctness.
 * Returns true on success, false otherwise.
 */
static PS_FORCE_INLINE bool
ps_validate_runtime_config(const ps_runtime_config_t *cfg)
{
    if (PS_UNLIKELY(!cfg)) {
        return false;
    }

    if (cfg->batch_window_ms == 0 || cfg->batch_window_ms > 10 * 60 * 1000) {
        /* Batch window must be between 1ms and 10 minutes */
        return false;
    }

    if (cfg->enrichment_workers == 0 || cfg->enrichment_workers > 1024) {
        return false;
    }

    /* Add more validations as new fields are introduced. */
    return true;
}

/* --------------------------------------------------------------------------
 *  Compile-time Sanity Checks
 * -------------------------------------------------------------------------- */
PS_STATIC_ASSERT(sizeof(ps_runtime_config_t) <= 64,
                 ps_runtime_config_struct_must_remain_cache_friendly);

/* --------------------------------------------------------------------------
 *  Miscellaneous Utility Macros
 * -------------------------------------------------------------------------- */
#define PS_STRINGIFY(x)   #x
#define PS_TOSTRING(x)    PS_STRINGIFY(x)

#define PS_MIN(a,b) ((a) < (b) ? (a) : (b))
#define PS_MAX(a,b) ((a) > (b) ? (a) : (b))

/* --------------------------------------------------------------------------
 *  Environment Summary (semi-human readable)
 *  Usage: fprintf(stderr, "%s\n", PS_ENVIRONMENT_STRING);
 * -------------------------------------------------------------------------- */
#define PS_ENVIRONMENT_STRING \
        "PulseSphere/" PS_VERSION_STRING " (" \
        "build=" PS_BUILD_ID ", " \
        "commit=" PS_GIT_COMMIT ", " \
        "date=" PS_BUILD_DATE "; " \
        "compiler=" \
            /* clang/gcc/msvc with version */ \
            /* clang */ \
            (PS_COMPILER_CLANG ? "clang " __clang_version__ : \
            /* gcc   */ PS_COMPILER_GCC ? "gcc " __VERSION__ : \
            /* msvc  */ PS_COMPILER_MSVC ? "msvc" : "unknown") \
        ")"

#endif /* PS_CONFIG_H */
