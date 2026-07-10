```c
/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * ps_logger.c  ‑  Common logger implementation used by all PulseSphere
 *                 components (data_ingestion, stream_processing, etc.).
 *
 * Author: PulseSphere Core Team
 * License: MIT
 *
 * A light-weight, thread-safe, multi-sink logger with the following features:
 *   • Log levels (TRACE, DEBUG, INFO, WARN, ERROR, FATAL)
 *   • Optional ANSI colorised console output
 *   • Timestamp with millisecond precision
 *   • Optional file sink with configurable log rotation (size-based)
 *   • Syslog integration (POSIX systems only)
 *   • Support for pluggable “log observers” via callback registration
 */

#define _POSIX_C_SOURCE 200809L

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "ps_logger.h"

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal constants & macros                                              */
/* ────────────────────────────────────────────────────────────────────────── */

#define PS_LOG_DEFAULT_MAX_FILE_SIZE (10 * 1024 * 1024) /* 10 MiB */
#define PS_LOG_MAX_OBSERVERS         8
#define PS_LOG_MAX_MSG_LEN           2048
#define PS_LOG_TS_BUF                32

/* Some ANSI colour helpers. */
#define COL_RED     "\033[31m"
#define COL_GREEN   "\033[32m"
#define COL_YELLOW  "\033[33m"
#define COL_BLUE    "\033[34m"
#define COL_MAGENTA "\033[35m"
#define COL_CYAN    "\033[36m"
#define COL_RESET   "\033[0m"

/* ────────────────────────────────────────────────────────────────────────── */
/* Structures                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

typedef struct
{
    ps_log_callback_t callback;
    void             *user_data;
} observer_entry_t;

/* ────────────────────────────────────────────────────────────────────────── */
/* Static (module-private) state                                            */
/* ────────────────────────────────────────────────────────────────────────── */

static struct
{
    bool             initialised;
    bool             console_enabled;
    bool             console_colors;
    bool             syslog_enabled;

    ps_log_level_t   level_threshold;

    /* File sink */
    FILE            *fp;
    char             log_path[PATH_MAX];
    size_t           max_file_size;

    /* Synchronisation */
    pthread_mutex_t  mutex;

    /* Observers */
    observer_entry_t observers[PS_LOG_MAX_OBSERVERS];
    size_t           observer_count;
} g_ctx = {
    .initialised      = false,
    .console_enabled  = true,
    .console_colors   = true,
    .syslog_enabled   = false,
    .level_threshold  = PS_LOG_INFO,
    .fp               = NULL,
    .max_file_size    = PS_LOG_DEFAULT_MAX_FILE_SIZE,
    .mutex            = PTHREAD_MUTEX_INITIALIZER,
    .observer_count   = 0,
};

/* Forward declarations */
static void         rotate_file_if_needed(void);
static const char * level_to_string(ps_log_level_t lvl);
static const char * level_to_color(ps_log_level_t lvl);
static void         emit_to_console(const char *timestamp,
                                    ps_log_level_t lvl,
                                    const char *message);
static void         emit_to_file(const char *timestamp,
                                 ps_log_level_t lvl,
                                 const char *message);
static void         notify_observers(ps_log_level_t lvl,
                                     const char      *ts,
                                     const char      *msg);
static void         build_timestamp(char out_buf[PS_LOG_TS_BUF]);
static pid_t        ps_gettid(void);

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

int ps_logger_init(const ps_logger_cfg_t *cfg)
{
    if (g_ctx.initialised) { return 0; }
    if (!cfg) { errno = EINVAL; return -1; }

    pthread_mutex_lock(&g_ctx.mutex);

    g_ctx.console_enabled  = cfg->enable_console;
    g_ctx.console_colors   = cfg->console_use_color;
    g_ctx.syslog_enabled   = cfg->enable_syslog;
    g_ctx.level_threshold  = cfg->level;
    g_ctx.max_file_size    = (cfg->max_file_size > 0)
                             ? cfg->max_file_size
                             : PS_LOG_DEFAULT_MAX_FILE_SIZE;

    /* Prepare file sink if requested. */
    if (cfg->log_path && *cfg->log_path)
    {
        strncpy(g_ctx.log_path, cfg->log_path, sizeof(g_ctx.log_path) - 1);
        g_ctx.fp = fopen(g_ctx.log_path, "a");
        if (!g_ctx.fp)
        {
            pthread_mutex_unlock(&g_ctx.mutex);
            return -1; /* errno has reason */
        }
        /* Line-buffered file IO is generally fine for log files. */
        setvbuf(g_ctx.fp, NULL, _IOLBF, 1024);
    }

    /* Syslog is optional and only meaningful on POSIX platforms.
       We rely on libc's syslog(). */
#ifdef __unix__
    if (g_ctx.syslog_enabled)
    {
        openlog(cfg->app_name ? cfg->app_name : "pulsesphere",
                LOG_PID | LOG_NDELAY, LOG_USER);
    }
#endif

    g_ctx.initialised = true;
    pthread_mutex_unlock(&g_ctx.mutex);
    return 0;
}

void ps_logger_shutdown(void)
{
    pthread_mutex_lock(&g_ctx.mutex);

    if (!g_ctx.initialised)
    {
        pthread_mutex_unlock(&g_ctx.mutex);
        return;
    }

    if (g_ctx.fp)
    {
        fclose(g_ctx.fp);
        g_ctx.fp = NULL;
    }

#ifdef __unix__
    if (g_ctx.syslog_enabled)
    {
        closelog();
    }
#endif

    g_ctx.initialised = false;
    pthread_mutex_unlock(&g_ctx.mutex);
}

int ps_logger_register_observer(ps_log_callback_t cb, void *user_data)
{
    if (!cb) { return -1; }

    pthread_mutex_lock(&g_ctx.mutex);
    if (g_ctx.observer_count >= PS_LOG_MAX_OBSERVERS)
    {
        pthread_mutex_unlock(&g_ctx.mutex);
        return -1;
    }

    g_ctx.observers[g_ctx.observer_count].callback  = cb;
    g_ctx.observers[g_ctx.observer_count].user_data = user_data;
    g_ctx.observer_count++;

    pthread_mutex_unlock(&g_ctx.mutex);
    return 0;
}

void ps_log_impl(ps_log_level_t lvl,
                 const char    *file,
                 const char    *func,
                 int            line,
                 const char    *fmt, ...)
{
    if (!g_ctx.initialised || lvl < g_ctx.level_threshold) { return; }

    char msg_buf[PS_LOG_MAX_MSG_LEN];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg_buf, sizeof(msg_buf), fmt, ap);
    va_end(ap);

    char ts_buf[PS_LOG_TS_BUF];
    build_timestamp(ts_buf);

    pthread_mutex_lock(&g_ctx.mutex);

    /* Console sink */
    if (g_ctx.console_enabled)
    {
        emit_to_console(ts_buf, lvl, msg_buf);
    }

    /* File sink */
    if (g_ctx.fp)
    {
        emit_to_file(ts_buf, lvl, msg_buf);
        rotate_file_if_needed();
    }

    /* Syslog sink */
#ifdef __unix__
    if (g_ctx.syslog_enabled)
    {
        /* Map to syslog priorities (rough mapping). */
        static const int table[] = {
            LOG_DEBUG, /* TRACE */
            LOG_DEBUG, /* DEBUG */
            LOG_INFO,  /* INFO  */
            LOG_WARNING,
            LOG_ERR,
            LOG_CRIT
        };
        int prio = table[lvl];
        syslog(prio, "[%s] %s", level_to_string(lvl), msg_buf);
    }
#endif

    /* Observer callbacks */
    notify_observers(lvl, ts_buf, msg_buf);

    pthread_mutex_unlock(&g_ctx.mutex);

    /* In case of FATAL, abort the program after flushing output. */
    if (lvl == PS_LOG_FATAL)
    {
        /* Flush stdio buffers. */
        fflush(NULL);
        /* Let the caller decide to handle signals; abort for now. */
        abort();
    }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helper functions                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

static const char *level_to_string(ps_log_level_t lvl)
{
    switch (lvl)
    {
        case PS_LOG_TRACE: return "TRACE";
        case PS_LOG_DEBUG: return "DEBUG";
        case PS_LOG_INFO:  return " INFO";
        case PS_LOG_WARN:  return " WARN";
        case PS_LOG_ERROR: return "ERROR";
        case PS_LOG_FATAL: return "FATAL";
        default:           return "UNKWN";
    }
}

static const char *level_to_color(ps_log_level_t lvl)
{
    if (!g_ctx.console_colors) { return ""; }

    switch (lvl)
    {
        case PS_LOG_TRACE: return COL_CYAN;
        case PS_LOG_DEBUG: return COL_BLUE;
        case PS_LOG_INFO:  return COL_GREEN;
        case PS_LOG_WARN:  return COL_YELLOW;
        case PS_LOG_ERROR: return COL_RED;
        case PS_LOG_FATAL: return COL_MAGENTA;
        default:           return "";
    }
}

static void emit_to_console(const char *timestamp,
                            ps_log_level_t lvl,
                            const char *message)
{
    const char *color = level_to_color(lvl);
    const char *reset = g_ctx.console_colors ? COL_RESET : "";

    fprintf(stderr, "%s%s [%s] %s%s\n",
            color, timestamp, level_to_string(lvl), message, reset);
}

static void emit_to_file(const char *timestamp,
                         ps_log_level_t lvl,
                         const char *message)
{
    assert(g_ctx.fp);
    fprintf(g_ctx.fp, "%s [%s] %s\n", timestamp,
            level_to_string(lvl), message);
}

static void notify_observers(ps_log_level_t lvl,
                             const char      *ts,
                             const char      *msg)
{
    for (size_t i = 0; i < g_ctx.observer_count; ++i)
    {
        g_ctx.observers[i].callback(lvl, ts, msg, g_ctx.observers[i].user_data);
    }
}

static void build_timestamp(char out_buf[PS_LOG_TS_BUF])
{
    struct timeval tv;
    gettimeofday(&tv, NULL);

    struct tm tm_info;
    localtime_r(&tv.tv_sec, &tm_info);

    int len = strftime(out_buf, PS_LOG_TS_BUF, "%Y-%m-%dT%H:%M:%S", &tm_info);
    snprintf(out_buf + len, PS_LOG_TS_BUF - len, ".%03ld",
             tv.tv_usec / 1000);
}

static void rotate_file_if_needed(void)
{
    if (!g_ctx.fp || g_ctx.max_file_size == 0) { return; }

    long pos = ftell(g_ctx.fp);
    if (pos < 0) { return; }

    if ((size_t)pos >= g_ctx.max_file_size)
    {
        fclose(g_ctx.fp);

        /* Create rotated filename: <path>.YYYYmmdd_HHMMSS.pid */
        char rotated_path[PATH_MAX];
        struct timeval tv;
        gettimeofday(&tv, NULL);
        struct tm tm_info;
        localtime_r(&tv.tv_sec, &tm_info);

        char ts[32];
        strftime(ts, sizeof(ts), "%Y%m%d_%H%M%S", &tm_info);

        snprintf(rotated_path, sizeof(rotated_path), "%s.%s.%d",
                 g_ctx.log_path, ts, (int)getpid());

        rename(g_ctx.log_path, rotated_path);

        g_ctx.fp = fopen(g_ctx.log_path, "a");
        if (g_ctx.fp)
        {
            setvbuf(g_ctx.fp, NULL, _IOLBF, 1024);
        }
        else
        {
            /* Disable file logging, but keep application running. */
            g_ctx.max_file_size = 0;
        }
    }
}

static pid_t ps_gettid(void)
{
#ifdef SYS_gettid
    return (pid_t)syscall(SYS_gettid);
#else
    return (pid_t)getpid(); /* Fallback */
#endif
}
```