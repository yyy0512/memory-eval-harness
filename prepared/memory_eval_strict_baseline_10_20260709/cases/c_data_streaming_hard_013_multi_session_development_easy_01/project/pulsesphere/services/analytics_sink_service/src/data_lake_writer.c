/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * analytics_sink_service / data_lake_writer.c
 *
 * A high-throughput, fault-tolerant writer that persists curated
 * social-pulse events to the Data Lake in time-partitioned,
 * size-bounded, GZIP-compressed ND-JSON files.
 *
 * Author: PulseSphere Core Team
 * License: MIT (see LICENSE file)
 */

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>

/* --------------------------------------------------------------------------
 *                             Config & Constants
 * --------------------------------------------------------------------------*/

#define DLW_MAX_PATH           1024
#define DLW_DEFAULT_BUF_CAP    (1 << 20)        /* 1 MiB                             */
#define DLW_DEFAULT_ROT_SIZE   (128UL << 20)    /* 128 MiB                           */
#define DLW_DEFAULT_ROT_SEC    900              /* 15 minutes                        */
#define DLW_TMP_SUFFIX         ".part"          /* Temporary suffix while streaming  */
#define DLW_FINAL_EXT          ".json.gz"       /* GZIP-compressed ND-JSON           */
#define DLW_TIME_FMT           "%Y/%m/%d/%H"    /* Partition directory layout        */

#ifndef ARR_LEN
#define ARR_LEN(a) (sizeof(a) / sizeof((a)[0]))
#endif

/* --------------------------------------------------------------------------
 *                                Utilities
 * --------------------------------------------------------------------------*/

/* Log helpers – thread-safe, minimal overhead */
static inline void dlw_log_err(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);

    char timebuf[64] = {0};
    time_t now       = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    strftime(timebuf, sizeof timebuf, "%F %T", &tm_now);

    fprintf(stderr, "[%s] [DLW] ERROR: ", timebuf);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);

    va_end(ap);
}

static inline void dlw_log_dbg(const char *fmt, ...)
{
#ifdef NDEBUG
    (void)fmt;
#else
    va_list ap;
    va_start(ap, fmt);
    char timebuf[64] = {0};
    time_t now       = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    strftime(timebuf, sizeof timebuf, "%F %T", &tm_now);
    fprintf(stderr, "[%s] [DLW] DEBUG: ", timebuf);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
#endif
}

/* mkdir -p utility */
static int dlw_mkdir_p(const char *path)
{
    char tmp[DLW_MAX_PATH];
    size_t len = strnlen(path, DLW_MAX_PATH);
    if (len == 0 || len == DLW_MAX_PATH)
        return -1;

    strncpy(tmp, path, len);
    tmp[len] = '\0';

    for (char *p = tmp + 1; *p; ++p)
    {
        if (*p == '/')
        {
            *p = '\0';
            if (mkdir(tmp, 0755) && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }

    if (mkdir(tmp, 0755) && errno != EEXIST)
        return -1;

    return 0;
}

/* --------------------------------------------------------------------------
 *                              Public Interface
 * --------------------------------------------------------------------------*/

typedef struct data_lake_writer
{
    /* static config */
    char   base_path[DLW_MAX_PATH];  /* root directory for partitions    */
    size_t rotate_size_bytes;        /* rotate when size exceeds         */
    int    rotate_interval_sec;      /* rotate after interval (seconds)  */
    int    compress;                 /* 0 = raw ND-JSON, 1 = gzip         */

    /* runtime state (guarded by lock) */
    pthread_mutex_t lock;
    gzFile          gz_fp;           /* underlying gzFile (NULL if none) */
    char            cur_file[DLW_MAX_PATH];
    char            cur_partition[64];
    time_t          cur_open_time;
    size_t          cur_bytes;

    /* buffered I/O */
    uint8_t *buffer;
    size_t   buf_len;
    size_t   buf_cap;

} DataLakeWriter;

/* --------------------------------------------------------------------------
 *                        Forward Declarations (private)
 * --------------------------------------------------------------------------*/

static int  dlw_open_new_file(DataLakeWriter *w, time_t ts);
static int  dlw_flush_locked(DataLakeWriter *w);
static void dlw_rotate_if_needed(DataLakeWriter *w, time_t now);

/* --------------------------------------------------------------------------
 *                             Initialization
 * --------------------------------------------------------------------------*/

DataLakeWriter *dlw_create(const char *base_path,
                           size_t      rotate_size_bytes,
                           int         rotate_interval_sec,
                           int         compress)
{
    if (!base_path)
        return NULL;

    DataLakeWriter *w = calloc(1, sizeof *w);
    if (!w)
        return NULL;

    snprintf(w->base_path, sizeof w->base_path, "%s", base_path);
    w->rotate_size_bytes  = rotate_size_bytes ? rotate_size_bytes
                                              : DLW_DEFAULT_ROT_SIZE;
    w->rotate_interval_sec = rotate_interval_sec ? rotate_interval_sec
                                                 : DLW_DEFAULT_ROT_SEC;
    w->compress            = compress;

    w->buf_cap = DLW_DEFAULT_BUF_CAP;
    w->buffer  = malloc(w->buf_cap);
    if (!w->buffer)
    {
        free(w);
        return NULL;
    }

    pthread_mutex_init(&w->lock, NULL);

    /* Pre-open first file so writes are non-blocking */
    if (dlw_open_new_file(w, time(NULL)) != 0)
    {
        dlw_log_err("Failed to open initial Data Lake file");
        dlw_destroy(w);
        return NULL;
    }

    return w;
}

void dlw_destroy(DataLakeWriter *w)
{
    if (!w)
        return;

    pthread_mutex_lock(&w->lock);

    if (w->gz_fp)
        gzclose(w->gz_fp);

    free(w->buffer);

    pthread_mutex_unlock(&w->lock);
    pthread_mutex_destroy(&w->lock);
    free(w);
}

/* --------------------------------------------------------------------------
 *                               Core API
 * --------------------------------------------------------------------------*/

/*
 * dlw_write_event
 * ---------------
 * Append a single pre-serialized JSON event plus a newline.  The writer
 * is thread-safe and can be called concurrently.
 */
int dlw_write_event(DataLakeWriter *w, const char *json)
{
    if (!w || !json)
        return -1;

    size_t len = strlen(json);

    pthread_mutex_lock(&w->lock);

    /* ensure space in buffer */
    if (w->buf_len + len + 1 > w->buf_cap)
    {
        if (dlw_flush_locked(w) != 0)
        {
            pthread_mutex_unlock(&w->lock);
            return -1;
        }
    }

    memcpy(w->buffer + w->buf_len, json, len);
    w->buf_len += len;
    w->buffer[w->buf_len++] = '\n';

    /* Auto-flush for giant single events */
    if (w->buf_len > w->buf_cap / 2)
        dlw_flush_locked(w);

    dlw_rotate_if_needed(w, time(NULL));

    pthread_mutex_unlock(&w->lock);
    return 0;
}

/*
 * dlw_flush
 * ---------
 * Flush all in-memory buffers to disk for durability.  Safe to call from
 * any thread; may block.
 */
int dlw_flush(DataLakeWriter *w)
{
    if (!w)
        return -1;

    pthread_mutex_lock(&w->lock);
    int rc = dlw_flush_locked(w);
    pthread_mutex_unlock(&w->lock);

    return rc;
}

/* --------------------------------------------------------------------------
 *                        Internal Implementation
 * --------------------------------------------------------------------------*/

static int dlw_flush_locked(DataLakeWriter *w)
{
    if (w->buf_len == 0)
        return 0;

    if (!w->gz_fp)
    {
        dlw_log_err("Attempted flush with null gz_fp");
        return -1;
    }

    int written = gzwrite(w->gz_fp, w->buffer, (unsigned)w->buf_len);
    if (written == 0)
    {
        dlw_log_err("gzwrite failed: %s", gzerror(w->gz_fp, NULL));
        return -1;
    }

    w->cur_bytes += written;
    w->buf_len = 0;

    /* Ensure data reaches OS buffers when rotating soon */
    gzflush(w->gz_fp, Z_SYNC_FLUSH);

    return 0;
}

static void dlw_finalize_current_file(DataLakeWriter *w)
{
    if (!w->gz_fp)
        return;

    /* Flush buffered data */
    if (w->buf_len)
        dlw_flush_locked(w);

    /* Close file */
    gzclose(w->gz_fp);
    w->gz_fp = NULL;

    /* Atomically rename *.part --> final */
    char final_path[DLW_MAX_PATH];
    snprintf(final_path, sizeof final_path, "%s",
             w->cur_file); /* start with full tmp path */
    size_t tmp_len = strlen(final_path);

    if (tmp_len > strlen(DLW_TMP_SUFFIX) &&
        strcmp(final_path + tmp_len - strlen(DLW_TMP_SUFFIX),
               DLW_TMP_SUFFIX) == 0)
    {
        final_path[tmp_len - strlen(DLW_TMP_SUFFIX)] = '\0'; /* strip suffix */

        if (rename(w->cur_file, final_path) != 0)
        {
            dlw_log_err("Failed to rename %s to %s: %s",
                        w->cur_file, final_path, strerror(errno));
        }
        else
        {
            dlw_log_dbg("Finalized file %s", final_path);
        }
    }
}

static int dlw_open_new_file(DataLakeWriter *w, time_t ts)
{
    /* build partition dir */
    struct tm tm_ts;
    gmtime_r(&ts, &tm_ts);

    strftime(w->cur_partition,
             sizeof w->cur_partition,
             DLW_TIME_FMT,
             &tm_ts); /* e.g., 2024/03/30/17 */

    char dir[DLW_MAX_PATH];
    snprintf(dir, sizeof dir, "%s/%s", w->base_path, w->cur_partition);

    if (dlw_mkdir_p(dir) != 0)
    {
        dlw_log_err("mkdir_p failed for %s: %s", dir, strerror(errno));
        return -1;
    }

    /* file name format: epoch-seconds-pid.json.gz.part */
    char fname[128];
    snprintf(fname,
             sizeof fname,
             "%ld-%d%s%s",
             (long)ts,
             getpid(),
             DLW_FINAL_EXT,
             DLW_TMP_SUFFIX);

    snprintf(w->cur_file, sizeof w->cur_file, "%s/%s", dir, fname);

    /* open as temporary .part file */
    int fd = open(w->cur_file,
                  O_CREAT | O_WRONLY | O_TRUNC,
                  0644);
    if (fd == -1)
    {
        dlw_log_err("open(%s) failed: %s", w->cur_file, strerror(errno));
        return -1;
    }

    /* wrap descriptor in gzFile */
    w->gz_fp = gzdopen(fd, "wb6"); /* compression level 6 */
    if (!w->gz_fp)
    {
        dlw_log_err("gzdopen failed on %s", w->cur_file);
        close(fd);
        return -1;
    }

    w->cur_bytes     = 0;
    w->buf_len       = 0;
    w->cur_open_time = ts;

    dlw_log_dbg("Opened new Data Lake file %s", w->cur_file);
    return 0;
}

static void dlw_rotate_if_needed(DataLakeWriter *w, time_t now)
{
    bool do_rotate = false;

    if (w->cur_bytes >= w->rotate_size_bytes)
        do_rotate = true;
    else if ((now - w->cur_open_time) >= w->rotate_interval_sec)
        do_rotate = true;

    if (!do_rotate)
        return;

    /* Finalize and open a new file */
    dlw_finalize_current_file(w);
    if (dlw_open_new_file(w, now) != 0)
    {
        /* If we cannot open new file, we better keep old handle null
         * so writes fail fast rather than silently dropping data. */
        dlw_log_err("Failed to rotate to new file; writer will be disabled");
    }
}

/* --------------------------------------------------------------------------
 *                          Graceful Shutdown Hooks
 * --------------------------------------------------------------------------*/

static DataLakeWriter *g_writer = NULL;

static void dlw_at_exit(void)
{
    if (!g_writer)
        return;

    dlw_log_dbg("dlw_at_exit invoked");
    dlw_destroy(g_writer);
}

static void dlw_sig_handler(int sig)
{
    (void)sig; /* unused */
    dlw_at_exit();
    _exit(EXIT_SUCCESS);
}

/* --------------------------------------------------------------------------
 *                            Example Entry Point
 *
 * In real production code, the writer would be driven by the analytics
 * sink service’s eventing loop.  Here we provide a minimal harness so
 * the translation unit can be compiled and smoke-tested standalone.
 * --------------------------------------------------------------------------*/
#ifdef DLW_STANDALONE_TEST

static void install_signal_handlers(void)
{
    const int signals[] = {SIGINT, SIGTERM, SIGQUIT};
    struct sigaction sa = {
        .sa_handler = dlw_sig_handler,
    };
    for (size_t i = 0; i < ARR_LEN(signals); ++i)
        sigaction(signals[i], &sa, NULL);
}

int main(void)
{
    install_signal_handlers();
    g_writer = dlw_create("/tmp/pulsesphere/datalake", 0, 0, 1);
    if (!g_writer)
        return EXIT_FAILURE;

    atexit(dlw_at_exit);

    /* Simulate incoming events */
    for (int i = 0; i < 100000; ++i)
    {
        char buf[128];
        snprintf(buf,
                 sizeof buf,
                 "{\"event_id\":%d,\"type\":\"like\",\"at\":%ld}",
                 i,
                 time(NULL));
        if (dlw_write_event(g_writer, buf) != 0)
        {
            dlw_log_err("Write failed at i=%d", i);
            break;
        }
    }

    dlw_flush(g_writer);
    return EXIT_SUCCESS;
}
#endif /* DLW_STANDALONE_TEST */
