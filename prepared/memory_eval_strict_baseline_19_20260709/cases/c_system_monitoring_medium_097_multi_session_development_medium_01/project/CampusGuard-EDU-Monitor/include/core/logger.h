#ifndef CAMPUSGUARD_EDU_MONITOR_CORE_LOGGER_H
#define CAMPUSGUARD_EDU_MONITOR_CORE_LOGGER_H
/*
 * CampusGuard EDU Monitor
 * -----------------------
 * core/logger.h
 *
 * A tiny but powerful logging facility used throughout the CampusGuard
 * monitoring suite.  The interface provides:
 *
 *   • Multiple log levels with compile-time and run-time filtering
 *   • File, stderr, and syslog backends
 *   • Custom user-defined sinks (e.g., to publish to a message bus)
 *   • Thread-safe writes through a POSIX mutex
 *   • printf-style format checking via compiler attributes
 *
 * Copyright (c) 2024, CampusGuard Project
 * SPDX-License-Identifier: MIT
 */

#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/*---------------------------------------------------------------------------
 * Build-time filtering
 *---------------------------------------------------------------------------*/
#ifndef CG_LOG_LEVEL_DEFAULT
    /* Compile-time minimum level (change via -DCG_LOG_LEVEL_DEFAULT=...) */
    #define CG_LOG_LEVEL_DEFAULT LOG_LEVEL_INFO
#endif

/*---------------------------------------------------------------------------
 * Enumerations
 *---------------------------------------------------------------------------*/
typedef enum logger_level {
    LOG_LEVEL_TRACE = 0,
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_WARN,
    LOG_LEVEL_ERROR,
    LOG_LEVEL_FATAL,
    LOG_LEVEL_OFF
} logger_level_t;

/*---------------------------------------------------------------------------
 * Forward declarations
 *---------------------------------------------------------------------------*/
struct logger_sink;

/*---------------------------------------------------------------------------
 * Logger configuration passed to logger_init()
 *---------------------------------------------------------------------------*/
typedef struct logger_config {
    /* Path to a log file (NULL to disable).  If the file cannot be opened,
       the logger will silently fallback to stderr. */
    const char      *file_path;

    /* When true, output is duplicated to stderr in addition to file/syslog. */
    bool             tee_to_stderr;

    /* Enable POSIX syslog(3) integration. */
    bool             enable_syslog;

    /* Initial log level threshold. */
    logger_level_t   level;

    /* Optional user-defined sink linked list (may be NULL). */
    struct logger_sink *custom_sink;
} logger_config_t;

/*---------------------------------------------------------------------------
 * Sink API
 *---------------------------------------------------------------------------*/
/* Signature for custom sink callbacks.  The callback will be invoked after
   the message has been formatted but before built-in backends are called. */
typedef void (*logger_sink_fn)(logger_level_t level,
                               const struct timespec *ts,
                               const char *msg,
                               size_t msg_len,
                               void *user_data);

typedef struct logger_sink {
    logger_sink_fn   fn;
    void            *user_data;
    struct logger_sink *next;
} logger_sink_t;

/*---------------------------------------------------------------------------
 * Public interface
 *---------------------------------------------------------------------------*/

/* Initialize the logger.  Should be called once at startup.
 * Returns 0 on success, negative errno on failure. */
int  logger_init(const logger_config_t *cfg);

/* Flush and close any open resources.  Safe to call multiple times. */
void logger_shutdown(void);

/* Dynamically adjust the minimum level for all subsequent log entries. */
void logger_set_level(logger_level_t level);

/* Obtain the current run-time log level. */
logger_level_t logger_get_level(void);

/* Add a custom sink at run-time.  Ownership of |sink| remains with the caller,
   but it must remain valid until logger_remove_sink() or shutdown. */
int  logger_add_sink(logger_sink_t *sink);

/* Remove a previously added sink (O(n)).  Returns 0 if removed, -ENOENT if not found. */
int  logger_remove_sink(logger_sink_t *sink);

/* Core logging function.  Application code should use the LOG_* macros below.
   'format' must be a %-style string as in printf(3). */
void logger_log(logger_level_t level,
                const char *file,
                const char *func,
                int line,
                const char *format, ...)
#if defined(__GNUC__) || defined(__clang__)
                __attribute__((format(printf,5,6)))
#endif
                ;

/*---------------------------------------------------------------------------
 * Convenience macros
 *---------------------------------------------------------------------------*/
#define _CG_LOG_SHOULD_LOG(lvl) ((lvl) >= CG_LOG_LEVEL_DEFAULT && (lvl) >= logger_get_level())

#define _CG_LOG(lvl, fmt, ...)                                      \
    do {                                                            \
        if (_CG_LOG_SHOULD_LOG(lvl)) {                              \
            logger_log((lvl), __FILE__, __func__, __LINE__,         \
                       (fmt), ##__VA_ARGS__);                       \
        }                                                           \
    } while (0)

#define LOG_TRACE(fmt, ...)  _CG_LOG(LOG_LEVEL_TRACE, (fmt), ##__VA_ARGS__)
#define LOG_DEBUG(fmt, ...)  _CG_LOG(LOG_LEVEL_DEBUG, (fmt), ##__VA_ARGS__)
#define LOG_INFO(fmt, ...)   _CG_LOG(LOG_LEVEL_INFO,  (fmt), ##__VA_ARGS__)
#define LOG_WARN(fmt, ...)   _CG_LOG(LOG_LEVEL_WARN,  (fmt), ##__VA_ARGS__)
#define LOG_ERROR(fmt, ...)  _CG_LOG(LOG_LEVEL_ERROR, (fmt), ##__VA_ARGS__)
#define LOG_FATAL(fmt, ...)  _CG_LOG(LOG_LEVEL_FATAL, (fmt), ##__VA_ARGS__)

/*---------------------------------------------------------------------------
 * Misc utility
 *---------------------------------------------------------------------------*/
/* Return a constant string representation of |level|. */
const char *logger_level_str(logger_level_t level);

#ifdef __cplusplus
}
#endif

#endif /* CAMPUSGUARD_EDU_MONITOR_CORE_LOGGER_H */
