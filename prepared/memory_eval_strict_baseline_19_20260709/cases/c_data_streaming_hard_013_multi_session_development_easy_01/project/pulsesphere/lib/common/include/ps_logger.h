/*
 * ps_logger.h
 *
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * Production-grade, thread-safe logging facility with pluggable sinks,
 * ANSI color support, and compile-time log-level stripping.
 *
 * This header is completely self-contained: it exposes the public API and,
 * unless PS_LOGGER_HEADER_ONLY is defined, also provides a compact
 * implementation.  In high-performance scenarios the implementation can be
 * moved to a dedicated compilation unit by defining PS_LOGGER_HEADER_ONLY
 * before including this file in exactly one translation unit and re-building.
 *
 * Author : PulseSphere Core Team <core@pulsesphere.io>
 * License: Apache-2.0
 */

#ifndef PULSESPHERE_PS_LOGGER_H
#define PULSESPHERE_PS_LOGGER_H

/* ------------------------------------------------------------------------- */
/*  Standard Library Dependencies                                            */
/* ------------------------------------------------------------------------- */
#include <stdio.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>
#include <string.h>

#if defined(_WIN32) && !defined(__MINGW32__)
  #include <windows.h>   /* For Windows console colors */
  #pragma warning(disable : 4996) /* _CRT_SECURE_NO_WARNINGS */
#else
  #include <pthread.h>
  #include <unistd.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------------- */
/*  Compile-time Configuration                                               */
/* ------------------------------------------------------------------------- */

/* Lowest log level that will be compiled into the binary.
 * Use ‑DPS_LOG_COMPILE_LEVEL=PS_LOG_LEVEL_WARN to strip TRACE/DEBUG/INFO.   */
#ifndef PS_LOG_COMPILE_LEVEL
#define PS_LOG_COMPILE_LEVEL  PS_LOG_LEVEL_TRACE
#endif

/* Enable/disable ANSI color sequences (1 = enabled, 0 = disabled) */
#ifndef PS_LOG_ENABLE_COLOR
#define PS_LOG_ENABLE_COLOR  1
#endif

/* Maximum length of a single formatted log line (including metadata) */
#ifndef PS_LOG_LINE_MAX
#define PS_LOG_LINE_MAX  4096
#endif

/* ------------------------------------------------------------------------- */
/*  Public Data Types                                                        */
/* ------------------------------------------------------------------------- */

/* Verbosity levels ordered by severity */
typedef enum
{
    PS_LOG_LEVEL_TRACE = 0,
    PS_LOG_LEVEL_DEBUG,
    PS_LOG_LEVEL_INFO,
    PS_LOG_LEVEL_WARN,
    PS_LOG_LEVEL_ERROR,
    PS_LOG_LEVEL_FATAL,
    PS_LOG_LEVEL_NONE   /* Used to silence a logger entirely              */
} ps_log_level_t;

/* Forward declaration                                                     */
struct ps_logger;

/* Sink callback invoked for each message if the logger is configured with
 * a custom sink instead of an ordinary FILE*.  The callback is executed
 * with the logger's internal mutex already held.                           */
typedef void (*ps_log_sink_fn)(struct ps_logger      *logger,
                               ps_log_level_t         level,
                               const char            *timestamp_iso8601,
                               const char            *file,
                               int                    line,
                               const char            *func,
                               const char            *formatted_msg,
                               void                  *user_data);

/* Logger instance                                                          */
typedef struct ps_logger
{
    ps_log_level_t    level_threshold;   /* RUN-TIME threshold             */
    bool              use_color;         /* Emit ANSI color sequences?     */
    bool              owns_file;         /* fclose() on destroy?           */
    FILE             *fp;                /* Destination stream             */
    ps_log_sink_fn    sink_cb;           /* Optional alternative sink      */
    void             *sink_user_data;    /* Passed to sink_cb              */

#if defined(_WIN32) && !defined(__MINGW32__)
    HANDLE            hconsole;          /* Windows console handle         */
#else
    pthread_mutex_t   mutex;             /* Thread-safety                  */
#endif
} ps_logger_t;

/* ------------------------------------------------------------------------- */
/*  Public API                                                               */
/* ------------------------------------------------------------------------- */

/* Obtain the global singleton logger.
 *    – Lazy-initialized on first use with INFO level to stderr.             */
ps_logger_t *ps_logger_default(void);

/* Initialize a user-allocated logger.  Must be destroyed with
 * ps_logger_destroy() when no longer needed.                                */
bool ps_logger_init(ps_logger_t          *logger,
                    ps_log_level_t        threshold,
                    FILE                 *fp_or_null, /* default = stderr   */
                    bool                  enable_color);

/* Replace the destination stream with a user-supplied sink callback.       */
bool ps_logger_set_sink(ps_logger_t      *logger,
                        ps_log_sink_fn    sink,
                        void             *user_data);

/* Adjust the run-time log level threshold.                                 */
void ps_logger_set_level(ps_logger_t     *logger,
                         ps_log_level_t   threshold);

/* Releases resources (closes file if owned, destroys mutex, …)             */
void ps_logger_destroy(ps_logger_t       *logger);

/* ------------------------------------------------------------------------- */
/*  Core logging function (not intended for direct use)                      */
/* ------------------------------------------------------------------------- */
void _ps_logger_log(ps_logger_t   *logger,
                    ps_log_level_t level,
                    const char    *file,
                    int            line,
                    const char    *func,
                    const char    *fmt, ...)
                    __attribute__((format(printf,6,7)));

/* ------------------------------------------------------------------------- */
/*  Convenience Macros (instance-based)                                      */
/* ------------------------------------------------------------------------- */

#define PS_LOGT(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_TRACE, __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)
#define PS_LOGD(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_DEBUG, __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)
#define PS_LOGI(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_INFO,  __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)
#define PS_LOGW(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_WARN,  __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)
#define PS_LOGE(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_ERROR, __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)
#define PS_LOGF(L, FMT, ...)  _ps_logger_log((L), PS_LOG_LEVEL_FATAL, __FILE__, __LINE__, __func__, (FMT), ##__VA_ARGS__)

/* ------------------------------------------------------------------------- */
/*  Global Logger shortcuts (opt-out via –DPS_DISABLE_GLOBAL_LOGGER)         */
/* ------------------------------------------------------------------------- */
#ifndef PS_DISABLE_GLOBAL_LOGGER
  #define PS_LOGT_G(FMT, ...) PS_LOGT(ps_logger_default(), (FMT), ##__VA_ARGS__)
  #define PS_LOGD_G(FMT, ...) PS_LOGD(ps_logger_default(), (FMT), ##__VA_ARGS__)
  #define PS_LOGI_G(FMT, ...) PS_LOGI(ps_logger_default(), (FMT), ##__VA_ARGS__)
  #define PS_LOGW_G(FMT, ...) PS_LOGW(ps_logger_default(), (FMT), ##__VA_ARGS__)
  #define PS_LOGE_G(FMT, ...) PS_LOGE(ps_logger_default(), (FMT), ##__VA_ARGS__)
  #define PS_LOGF_G(FMT, ...) PS_LOGF(ps_logger_default(), (FMT), ##__VA_ARGS__)
#endif /* PS_DISABLE_GLOBAL_LOGGER */

/* ------------------------------------------------------------------------- */
/*  Implementation                                                           */
/* ------------------------------------------------------------------------- */
#if !defined(PS_LOGGER_HEADER_ONLY) || defined(PS_LOGGER_IMPLEMENTATION)

#ifndef PS_LOGGER_IMPLEMENTED
#define PS_LOGGER_IMPLEMENTED 1

/* ----------------------------- Helpers ---------------------------------- */

static const char *_ps_level_str(ps_log_level_t lvl)
{
    switch (lvl) {
        case PS_LOG_LEVEL_TRACE: return "TRACE";
        case PS_LOG_LEVEL_DEBUG: return "DEBUG";
        case PS_LOG_LEVEL_INFO:  return "INFO ";
        case PS_LOG_LEVEL_WARN:  return "WARN ";
        case PS_LOG_LEVEL_ERROR: return "ERROR";
        case PS_LOG_LEVEL_FATAL: return "FATAL";
        default:                 return "UNKWN";
    }
}

#if PS_LOG_ENABLE_COLOR
static const char *_ps_level_color(ps_log_level_t lvl)
{
    switch (lvl) {
        case PS_LOG_LEVEL_TRACE: return "\x1b[94m"; /* Bright Blue  */
        case PS_LOG_LEVEL_DEBUG: return "\x1b[36m"; /* Cyan          */
        case PS_LOG_LEVEL_INFO:  return "\x1b[32m"; /* Green         */
        case PS_LOG_LEVEL_WARN:  return "\x1b[33m"; /* Yellow        */
        case PS_LOG_LEVEL_ERROR: return "\x1b[31m"; /* Red           */
        case PS_LOG_LEVEL_FATAL: return "\x1b[35m"; /* Magenta       */
        default:                 return "\x1b[0m";
    }
}
#endif /* PS_LOG_ENABLE_COLOR */

/* ISO-8601 timestamp with millisecond precision                           */
static void _ps_now_iso8601(char *buf, size_t len)
{
    struct timespec ts;
#if defined(_POSIX_C_SOURCE) && _POSIX_C_SOURCE >= 199309L
    clock_gettime(CLOCK_REALTIME, &ts);
#else
    /* Fall-back for exotic systems */
    struct timeval tv;
    gettimeofday(&tv, NULL);
    ts.tv_sec  = tv.tv_sec;
    ts.tv_nsec = tv.tv_usec * 1000;
#endif

    struct tm tm_info;
#if defined(_WIN32) && !defined(__MINGW32__)
    localtime_s(&tm_info, &ts.tv_sec);
#else
    localtime_r(&ts.tv_sec, &tm_info);
#endif

    int written = (int)strftime(buf, len, "%Y-%m-%dT%H:%M:%S", &tm_info);
    if (written > 0 && (size_t)written < len) {
        snprintf(buf + written, len - (size_t)written, ".%03ld%+03ld:%02ld",
                 ts.tv_nsec / 1000000,
                 tm_info.tm_gmtoff / 3600,
                 labs((long)(tm_info.tm_gmtoff / 60)) % 60);
    }
}

/* ----------------------------- Mutexes ---------------------------------- */

#if !defined(_WIN32) || defined(__MINGW32__)
static void _ps_mutex_init(pthread_mutex_t *m)   { pthread_mutex_init(m, NULL); }
static void _ps_mutex_lock(pthread_mutex_t *m)   { pthread_mutex_lock(m); }
static void _ps_mutex_unlock(pthread_mutex_t *m) { pthread_mutex_unlock(m); }
static void _ps_mutex_destroy(pthread_mutex_t *m){ pthread_mutex_destroy(m); }
#else
static void _ps_mutex_init(void *unused)   { (void)unused; }
static void _ps_mutex_lock(void *unused)   { (void)unused; }
static void _ps_mutex_unlock(void *unused) { (void)unused; }
static void _ps_mutex_destroy(void *unused){ (void)unused; }
#endif

/* ----------------------------- Implementation --------------------------- */

bool ps_logger_init(ps_logger_t *logger,
                    ps_log_level_t threshold,
                    FILE *fp_or_null,
                    bool enable_color)
{
    if (!logger)
        return false;

    memset(logger, 0, sizeof(*logger));

    logger->level_threshold = threshold;
    logger->use_color       = enable_color && PS_LOG_ENABLE_COLOR;

    if (fp_or_null) {
        logger->fp       = fp_or_null;
        logger->owns_file = false;
    } else {
        logger->fp       = stderr;
        logger->owns_file = false;
    }

#if defined(_WIN32) && !defined(__MINGW32__)
    logger->hconsole = GetStdHandle(STD_ERROR_HANDLE);
#else
    _ps_mutex_init(&logger->mutex);
#endif
    return true;
}

ps_logger_t *ps_logger_default(void)
{
    static ps_logger_t _global;
    static bool        _initialized = false;

#if defined(_WIN32) && !defined(__MINGW32__)
    static CRITICAL_SECTION _cs;
    static bool _cs_init = false;
    if (!_cs_init) { InitializeCriticalSection(&_cs); _cs_init = true; }
    EnterCriticalSection(&_cs);
#else
    static pthread_mutex_t _guard = PTHREAD_MUTEX_INITIALIZER;
    pthread_mutex_lock(&_guard);
#endif

    if (!_initialized) {
        ps_logger_init(&_global, PS_LOG_LEVEL_INFO, stderr, true);
        _initialized = true;
    }

#if defined(_WIN32) && !defined(__MINGW32__)
    LeaveCriticalSection(&_cs);
#else
    pthread_mutex_unlock(&_guard);
#endif
    return &_global;
}

bool ps_logger_set_sink(ps_logger_t *logger,
                        ps_log_sink_fn sink,
                        void *user_data)
{
    if (!logger)
        return false;

#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_lock(&logger->mutex);
#endif

    logger->sink_cb        = sink;
    logger->sink_user_data = user_data;

#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_unlock(&logger->mutex);
#endif
    return true;
}

void ps_logger_set_level(ps_logger_t *logger,
                         ps_log_level_t threshold)
{
    if (!logger)
        return;
    logger->level_threshold = threshold;
}

void ps_logger_destroy(ps_logger_t *logger)
{
    if (!logger)
        return;

#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_lock(&logger->mutex);
#endif

    if (logger->owns_file && logger->fp) {
        fclose(logger->fp);
        logger->fp = NULL;
    }

#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_unlock(&logger->mutex);
    _ps_mutex_destroy(&logger->mutex);
#endif
}

/* Core formatter */
void _ps_logger_log(ps_logger_t   *logger,
                    ps_log_level_t level,
                    const char    *file,
                    int            line,
                    const char    *func,
                    const char    *fmt, ...)
{
    /* Compile-time stripping */
    if (level < PS_LOG_COMPILE_LEVEL)
        return;

    /* Fallback to global logger if none provided */
    if (!logger)
        logger = ps_logger_default();

    /* Run-time threshold */
    if (level < logger->level_threshold || level == PS_LOG_LEVEL_NONE)
        return;

    char timestamp[40];
    _ps_now_iso8601(timestamp, sizeof(timestamp));

    /* Format user message */
    char user_msg[PS_LOG_LINE_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(user_msg, sizeof(user_msg), fmt, ap);
    va_end(ap);

    /* Final line buffer */
    char line_buf[PS_LOG_LINE_MAX];

    /* Compose message with metadata */
    int n = snprintf(line_buf, sizeof(line_buf),
                     "%s %-5s [%s:%d %s] %s\n",
                     timestamp,
                     _ps_level_str(level),
                     file, line, func,
                     user_msg);

    if (n < 0)
        return; /* encoding error */

    /* Acquire lock */
#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_lock(&logger->mutex);
#endif

    /* Custom sink overrides default stream */
    if (logger->sink_cb) {
        logger->sink_cb(logger, level, timestamp, file, line,
                        func, user_msg, logger->sink_user_data);
    } else if (logger->fp) {
#if PS_LOG_ENABLE_COLOR
        if (logger->use_color && isatty(fileno(logger->fp))) {
            fprintf(logger->fp, "%s%s\x1b[0m", _ps_level_color(level), line_buf);
        } else
#endif
        {
            fputs(line_buf, logger->fp);
        }
        fflush(logger->fp);
    }

    /* Release lock */
#if !defined(_WIN32) || defined(__MINGW32__)
    _ps_mutex_unlock(&logger->mutex);
#endif
}

#endif /* PS_LOGGER_IMPLEMENTED */
#endif /* !PS_LOGGER_HEADER_ONLY || PS_LOGGER_IMPLEMENTATION */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_PS_LOGGER_H */
