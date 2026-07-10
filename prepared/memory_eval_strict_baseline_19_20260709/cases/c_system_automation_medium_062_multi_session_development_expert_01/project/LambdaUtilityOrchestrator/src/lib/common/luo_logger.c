#include "luo_logger.h"

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/*
 * luo_logger.c
 *
 * Centralized, thread-safe logging facility for the LambdaUtility Orchestrator.
 * Provides human-readable and structured-JSON output, pluggable back-end
 * destinations (stdout/stderr or file), dynamic log-level changes, and
 * safe log-file reopening (to cooperate with external rotation mechanisms).
 *
 * Typical usage:
 *
 *      luo_logger_init("backup_recovery", "/var/log/luo/backup.log",
 *                      LUO_LOG_LEVEL_INFO, /* use UTC = */true,
 *                      /* json = */false);
 *
 *      LUO_LOG_INFO("Initialized backup handler for %s", host_name);
 *
 * The public macro wrappers (defined in luo_logger.h) automatically capture
 * call-site metadata (file, func, line), resulting in rich context without
 * boilerplate at the call site.
 *
 * The implementation is intentionally self-contained—no third-party
 * dependencies—to minimize Lambda cold-start latency and simplify builds.
 */

/* -------------------------------------------------------------------------- */
/* Internal types & globals                                                   */
/* -------------------------------------------------------------------------- */

typedef struct
{
    char        subsystem[LUO_LOG_MAX_SUBSYS];
    int         min_lvl;
    bool        utc;
    bool        json;
    FILE       *fp;
    char        filepath[LUO_LOG_MAX_PATH];
    pthread_mutex_t lock;
    bool        initialized;
} luo_logger_t;

static luo_logger_t g_logger = {
    .min_lvl     = LUO_LOG_LEVEL_INFO,
    .utc         = true,
    .json        = false,
    .fp          = NULL,
    .filepath    = {0},
    .lock        = PTHREAD_MUTEX_INITIALIZER,
    .initialized = false,
};

/* Map numeric level to human readable string. */
static const char *s_level_str[] = {
    [LUO_LOG_LEVEL_TRACE] = "TRACE",
    [LUO_LOG_LEVEL_DEBUG] = "DEBUG",
    [LUO_LOG_LEVEL_INFO]  = "INFO",
    [LUO_LOG_LEVEL_WARN]  = "WARN",
    [LUO_LOG_LEVEL_ERROR] = "ERROR",
    [LUO_LOG_LEVEL_FATAL] = "FATAL",
};

#define UNUSED(x) ((void)(x))

/* -------------------------------------------------------------------------- */
/* Helper utilities                                                           */
/* -------------------------------------------------------------------------- */

/* Return current timestamp formatted as ISO-8601 (UTC or local). */
static void
timestamp_now(char *out_buf, size_t len, bool utc)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);

    struct tm tm_snapshot;
    if (utc)
        gmtime_r(&ts.tv_sec, &tm_snapshot);
    else
        localtime_r(&ts.tv_sec, &tm_snapshot);

    /* Format: 2023-04-28T15:23:42.123Z */
    strftime(out_buf, len, "%Y-%m-%dT%H:%M:%S", &tm_snapshot);

    /* Append milliseconds */
    size_t off = strlen(out_buf);
    snprintf(out_buf + off, len - off, ".%03ld%s",
             ts.tv_nsec / 1000000L, utc ? "Z" : "");
}

/* Safely duplicate string into fixed buffer. */
static void
copy_trunc(char *dst, size_t dst_sz, const char *src)
{
    if (!dst || dst_sz == 0)
        return;

    if (!src)
        src = "";

    strncpy(dst, src, dst_sz - 1);
    dst[dst_sz - 1] = '\0';
}

/* Open destination file (or stdout/stderr if NULL). */
static FILE *
open_destination(const char *path)
{
    if (path == NULL || strcmp(path, "stdout") == 0)
    {
        return stdout;
    }
    else if (strcmp(path, "stderr") == 0)
    {
        return stderr;
    }

    FILE *fp = fopen(path, "a");
    return fp;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

int
luo_logger_init(const char *subsystem,
                const char *path,
                int         min_level,
                bool        use_utc,
                bool        json_fmt)
{
    pthread_mutex_lock(&g_logger.lock);

    if (g_logger.initialized)
    {
        pthread_mutex_unlock(&g_logger.lock);
        return 0; /* Already initialized. */
    }

    if (min_level < LUO_LOG_LEVEL_TRACE || min_level > LUO_LOG_LEVEL_FATAL)
    {
        pthread_mutex_unlock(&g_logger.lock);
        return LUO_LOG_ERR_BAD_LEVEL;
    }

    FILE *fp = open_destination(path);
    if (!fp)
    {
        int err = errno;
        pthread_mutex_unlock(&g_logger.lock);
        return err;
    }

    g_logger.fp         = fp;
    g_logger.min_lvl    = min_level;
    g_logger.utc        = use_utc;
    g_logger.json       = json_fmt;
    g_logger.initialized = true;

    copy_trunc(g_logger.subsystem, sizeof(g_logger.subsystem), subsystem);
    copy_trunc(g_logger.filepath, sizeof(g_logger.filepath), path ? path : "stdout");

    /* Ensures we don't get interleaved timestamps/lines. */
    setvbuf(g_logger.fp, NULL, _IOLBF, 0);

    pthread_mutex_unlock(&g_logger.lock);
    return 0;
}

void
luo_logger_shutdown(void)
{
    pthread_mutex_lock(&g_logger.lock);

    if (!g_logger.initialized)
    {
        pthread_mutex_unlock(&g_logger.lock);
        return;
    }

    /* Don't close stdout/stderr as they're managed by the runtime. */
    if (g_logger.fp && g_logger.fp != stdout && g_logger.fp != stderr)
    {
        fclose(g_logger.fp);
    }

    memset(&g_logger, 0, sizeof(g_logger));
    g_logger.min_lvl     = LUO_LOG_LEVEL_INFO;
    g_logger.lock        = (pthread_mutex_t)PTHREAD_MUTEX_INITIALIZER;

    pthread_mutex_unlock(&g_logger.lock);
}

int
luo_logger_set_level(int new_level)
{
    if (new_level < LUO_LOG_LEVEL_TRACE || new_level > LUO_LOG_LEVEL_FATAL)
        return LUO_LOG_ERR_BAD_LEVEL;

    pthread_mutex_lock(&g_logger.lock);
    g_logger.min_lvl = new_level;
    pthread_mutex_unlock(&g_logger.lock);

    return 0;
}

int
luo_logger_reopen(void)
{
    pthread_mutex_lock(&g_logger.lock);

    if (!g_logger.initialized ||
        g_logger.fp == stdout ||
        g_logger.fp == stderr)
    {
        pthread_mutex_unlock(&g_logger.lock);
        return 0; /* Nothing to do for stdout/stderr */
    }

    FILE *new_fp = fopen(g_logger.filepath, "a");
    if (!new_fp)
    {
        int err = errno;
        pthread_mutex_unlock(&g_logger.lock);
        return err;
    }

    FILE *old_fp = g_logger.fp;
    g_logger.fp  = new_fp;

    /* Close after switch to minimize gap. */
    fclose(old_fp);

    pthread_mutex_unlock(&g_logger.lock);
    return 0;
}

/* Core logging function called by wrapper macros. */
void
luo_log_internal(int         level,
                 const char *src_file,
                 const char *func,
                 int         line,
                 const char *fmt,
                 ...)
{
    if (!g_logger.initialized || level < g_logger.min_lvl)
        return;

    char ts_buf[32];
    timestamp_now(ts_buf, sizeof(ts_buf), g_logger.utc);

    pthread_mutex_lock(&g_logger.lock);

    /* Build final log message. */
    va_list ap;
    va_start(ap, fmt);

    /* Format the user payload first into buffer. */
    char msg_buf[LUO_LOG_MAX_PAYLOAD];
    vsnprintf(msg_buf, sizeof(msg_buf), fmt, ap);

    va_end(ap);

    /* Thread ID (portable approximation). */
    unsigned long tid = (unsigned long)pthread_self();

    /* Choose output format. */
    if (g_logger.json)
    {
        /* Escape quotes in message – simplistic (only \ and "). */
        char esc_msg[LUO_LOG_MAX_PAYLOAD * 2];
        size_t p = 0;
        for (size_t i = 0; i < strlen(msg_buf) && p < sizeof(esc_msg) - 2; ++i)
        {
            if (msg_buf[i] == '\\' || msg_buf[i] == '"')
                esc_msg[p++] = '\\';
            esc_msg[p++] = msg_buf[i];
        }
        esc_msg[p] = '\0';

        fprintf(g_logger.fp,
                "{"
                "\"ts\":\"%s\","
                "\"lvl\":\"%s\","
                "\"subsys\":\"%s\","
                "\"tid\":%lu,"
                "\"file\":\"%s\","
                "\"func\":\"%s\","
                "\"line\":%d,"
                "\"msg\":\"%s\""
                "}\n",
                ts_buf,
                s_level_str[level],
                g_logger.subsystem,
                tid,
                src_file,
                func,
                line,
                esc_msg);
    }
    else
    {
        fprintf(g_logger.fp,
                "%s %-5s [%s] (tid:%lu) %s:%d %s(): %s\n",
                ts_buf,
                s_level_str[level],
                g_logger.subsystem,
                tid,
                src_file,
                line,
                func,
                msg_buf);
    }

    if (level == LUO_LOG_LEVEL_FATAL)
    {
        /* Flush and abort for fatal errors. */
        fflush(g_logger.fp);
        pthread_mutex_unlock(&g_logger.lock);
        abort();
    }

    pthread_mutex_unlock(&g_logger.lock);
}

/* -------------------------------------------------------------------------- */
/* Fallback stubs when logger not initialized                                 */
/* -------------------------------------------------------------------------- */

__attribute__((constructor))
static void
luo_logger_constructor(void)
{
    /* Default to stderr at INFO if the application doesn't call init. */
    /* This guarantees we see at least SOME output for critical failures. */
    luo_logger_init("default", "stderr", LUO_LOG_LEVEL_INFO, true, false);
}

__attribute__((destructor))
static void
luo_logger_destructor(void)
{
    luo_logger_shutdown();
}

/* -------------------------------------------------------------------------- */
/* End of file                                                                */
/* -------------------------------------------------------------------------- */
