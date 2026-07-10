#ifndef LUO_LOGGER_H
#define LUO_LOGGER_H
/*
 * LambdaUtility Orchestrator
 * Common Logger Interface (header-only)
 *
 * Copyright (c) 2024
 *
 * A pragmatic, ANSI-color aware, header-only logging facility tailored for
 * AWS Lambda–style workloads.  Designed for low-latency, zero-config usage
 * while still allowing run-time reconfiguration via environment variables.
 *
 * Usage:
 *   LUO_LOG_INFO("Service started on port %d", port);
 *   LUO_LOG_ERROR("Unhandled error: %s", err_msg);
 *
 * Compile-time options (define before including this header):
 *   - LUO_LOG_LEVEL=<level>   Sets default log level (0-5)
 *   - LUO_LOGGER_DISABLE_COLORS
 *
 * Run-time options (environment variables):
 *   - LUO_LOG_LEVEL           Overrides default log level
 *   - LUO_LOG_COLOR={auto|on|off}
 *
 * Thread safety: each logging call internally acquires a low-contention
 * spin-lock (on POSIX) or falls back to stdio mutexes on non-POSIX targets.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdarg.h>
#include <time.h>
#include <string.h>
#include <signal.h>

#if defined(__unix__) || defined(__APPLE__)
#   include <unistd.h>
#   include <pthread.h>
#   define LUO_LOGGER_HAVE_PTHREAD 1
#else
#   define LUO_LOGGER_HAVE_PTHREAD 0
#endif

/* ---------- Log-level definitions --------------------------------------- */
typedef enum {
    LUO_LOG_LEVEL_TRACE = 0,
    LUO_LOG_LEVEL_DEBUG = 1,
    LUO_LOG_LEVEL_INFO  = 2,
    LUO_LOG_LEVEL_WARN  = 3,
    LUO_LOG_LEVEL_ERROR = 4,
    LUO_LOG_LEVEL_FATAL = 5,
    LUO_LOG_LEVEL_OFF   = 6
} luo_log_level_t;

/* Allow compile-time override */
#ifndef LUO_LOG_LEVEL
#   define LUO_LOG_LEVEL LUO_LOG_LEVEL_INFO
#endif

/* ---------- Internal static state --------------------------------------- */
static volatile sig_atomic_t g_luo_log_level = LUO_LOG_LEVEL;

#if LUO_LOGGER_HAVE_PTHREAD
static pthread_mutex_t g_luo_log_mutex = PTHREAD_MUTEX_INITIALIZER;
#   define _luo_log_lock()   pthread_mutex_lock(&g_luo_log_mutex)
#   define _luo_log_unlock() pthread_mutex_unlock(&g_luo_log_mutex)
#else
/* Rely on stdio being thread-safe on non-POSIX systems */
#   define _luo_log_lock()   ((void)0)
#   define _luo_log_unlock() ((void)0)
#endif

/* ---------- Helpers ------------------------------------------------------ */
static inline const char *
_luo_level_to_string(luo_log_level_t lvl)
{
    switch (lvl) {
        case LUO_LOG_LEVEL_TRACE: return "TRACE";
        case LUO_LOG_LEVEL_DEBUG: return "DEBUG";
        case LUO_LOG_LEVEL_INFO:  return "INFO ";
        case LUO_LOG_LEVEL_WARN:  return "WARN ";
        case LUO_LOG_LEVEL_ERROR: return "ERROR";
        case LUO_LOG_LEVEL_FATAL: return "FATAL";
        default:                  return "UNKWN";
    }
}

static inline const char *
_luo_level_to_color(luo_log_level_t lvl)
{
#ifndef LUO_LOGGER_DISABLE_COLORS
    switch (lvl) {
        case LUO_LOG_LEVEL_TRACE: return "\033[94m"; /* Bright Blue  */
        case LUO_LOG_LEVEL_DEBUG: return "\033[36m"; /* Cyan          */
        case LUO_LOG_LEVEL_INFO:  return "\033[32m"; /* Green         */
        case LUO_LOG_LEVEL_WARN:  return "\033[33m"; /* Yellow        */
        case LUO_LOG_LEVEL_ERROR: return "\033[31m"; /* Red           */
        case LUO_LOG_LEVEL_FATAL: return "\033[41m"; /* Red BG        */
        default:                  return "\033[0m";
    }
#else
    (void)lvl;
    return "";
#endif
}

static inline int
_luo_should_use_color(void)
{
#ifdef LUO_LOGGER_DISABLE_COLORS
    return 0;
#else
#   ifdef _WIN32
    /* Colorized output on Windows consoles requires additional API calls.
       Keep it simple: disable by default. */
    return 0;
#   else
    const char *env = getenv("LUO_LOG_COLOR");
    if (env) {
        if (strcasecmp(env, "on") == 0)   return 1;
        if (strcasecmp(env, "off") == 0)  return 0;
        /* "auto" falls through to below */
    }
    return isatty(fileno(stdout));
#   endif
#endif
}

/* ---------- Initialization ---------------------------------------------- */
static inline void
luo_log_set_level(luo_log_level_t lvl)
{
    if (lvl >= LUO_LOG_LEVEL_TRACE && lvl <= LUO_LOG_LEVEL_OFF) {
        g_luo_log_level = lvl;
    }
}

/* Automatically executed once per translation unit */
__attribute__((constructor))
static void _luo_logger_autoinit(void)
{
    const char *lvl_env = getenv("LUO_LOG_LEVEL");
    if (!lvl_env) return;

    if (strcasecmp(lvl_env, "TRACE") == 0) luo_log_set_level(LUO_LOG_LEVEL_TRACE);
    else if (strcasecmp(lvl_env, "DEBUG") == 0) luo_log_set_level(LUO_LOG_LEVEL_DEBUG);
    else if (strcasecmp(lvl_env, "INFO") == 0)  luo_log_set_level(LUO_LOG_LEVEL_INFO);
    else if (strcasecmp(lvl_env, "WARN") == 0)  luo_log_set_level(LUO_LOG_LEVEL_WARN);
    else if (strcasecmp(lvl_env, "ERROR") == 0) luo_log_set_level(LUO_LOG_LEVEL_ERROR);
    else if (strcasecmp(lvl_env, "FATAL") == 0) luo_log_set_level(LUO_LOG_LEVEL_FATAL);
    else if (strcasecmp(lvl_env, "OFF") == 0)   luo_log_set_level(LUO_LOG_LEVEL_OFF);
}

/* ---------- Core logging routine ---------------------------------------- */
/*
 * Low-level logging function.
 * Prefer the convenience macros defined below instead of calling directly.
 */
static inline void
luo_logger_log(luo_log_level_t level,
               const char      *file,
               int              line,
               const char      *fmt,
               ...)
{
    if (level < g_luo_log_level || level == LUO_LOG_LEVEL_OFF) {
        return;
    }

    /* Timestamp */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);

    char time_buf[32];
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);
    strftime(time_buf, sizeof time_buf, "%Y-%m-%dT%H:%M:%S", &tm);

    /* Build user message */
    char msgbuf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(msgbuf, sizeof msgbuf, fmt, ap);
    va_end(ap);

    /* Fallback for truncated messages */
    if (n < 0) {
        /* vsnprintf error */
        return;
    } else if ((size_t)n >= sizeof msgbuf) {
        /* Allocate dynamically for very large logs */
        size_t needed = (size_t)n + 1;
        char *dynbuf = (char *)malloc(needed);
        if (!dynbuf) return;
        va_start(ap, fmt);
        vsnprintf(dynbuf, needed, fmt, ap);
        va_end(ap);
        strncpy(msgbuf, dynbuf, sizeof msgbuf - 4);
        strcpy(msgbuf + sizeof msgbuf - 4, "...");
        free(dynbuf);
    }

    /* Write atomically */
    _luo_log_lock();

    const int use_color = _luo_should_use_color();
#ifndef LUO_LOGGER_DISABLE_COLORS
    if (use_color) {
        fprintf(stdout,
                "%s.%03ld %s%-5s\033[0m [%s:%d] %s\n",
                time_buf,
                ts.tv_nsec / 1000000L,
                _luo_level_to_color(level),
                _luo_level_to_string(level),
                file, line,
                msgbuf);
    } else
#endif
    {
        fprintf(stdout,
                "%s.%03ld %-5s [%s:%d] %s\n",
                time_buf,
                ts.tv_nsec / 1000000L,
                _luo_level_to_string(level),
                file, line,
                msgbuf);
    }

    fflush(stdout);
    _luo_log_unlock();

    /* Fatal logs abort the process to allow Lambda to surface errors quickly */
    if (level == LUO_LOG_LEVEL_FATAL) {
        abort();
    }
}

/* ---------- Public convenience macros ----------------------------------- */
#define LUO_LOG_TRACE(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_TRACE, __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

#define LUO_LOG_DEBUG(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_DEBUG, __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

#define LUO_LOG_INFO(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_INFO,  __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

#define LUO_LOG_WARN(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_WARN,  __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

#define LUO_LOG_ERROR(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_ERROR, __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

#define LUO_LOG_FATAL(fmt, ...) \
    luo_logger_log(LUO_LOG_LEVEL_FATAL, __FILE__, __LINE__, (fmt), ##__VA_ARGS__)

/* ---------- One-time logging helper ------------------------------------- */
#define LUO_LOG_ONCE(level_macro, fmt, ...)                  \
    do {                                                     \
        static int _once_flag = 0;                           \
        if (!_once_flag) {                                   \
            _once_flag = 1;                                  \
            level_macro(fmt, ##__VA_ARGS__);                 \
        }                                                    \
    } while (0)

#endif /* LUO_LOGGER_H */