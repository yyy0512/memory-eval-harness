/**
 * backup_agent.c
 *
 * CampusGuard-EDU-Monitor – Backup Agent
 *
 * This micro-service listens on a POSIX message queue for backup
 * requests, performs on-disk snapshots (optionally compressed) and
 * records the operation in SQLite.  Status updates are forwarded to
 * the global status bus so that the UI dashboard can reflect progress
 * in real time (Observer pattern).
 *
 * Author: CampusGuard Core Team
 * License: MIT
 */

#define _POSIX_C_SOURCE 200809L     /* For mq_*, getline(), sigaction */
#define _GNU_SOURCE                 /* For asprintf */

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <mqueue.h>
#include <time.h>
#include <unistd.h>
#include <syslog.h>

/* --------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */
#define CMD_QUEUE_NAME      "/campusguard_backup_cmd"
#define STATUS_QUEUE_NAME   "/campusguard_status_bus"
#define MAX_MSG_SIZE        512
#define MAX_PATH_LEN        512
#define DB_PATH             "/var/lib/campusguard/backup_meta.db"
#define AGENT_IDENT         "backup_agent"

/* --------------------------------------------------------------------------
 * Globals
 * -------------------------------------------------------------------------- */
static volatile sig_atomic_t g_shutdown_requested = 0;
static mqd_t g_cmd_q      = (mqd_t)-1;
static mqd_t g_status_q   = (mqd_t)-1;
static sqlite3 *g_db      = NULL;

/* --------------------------------------------------------------------------
 * Data structures
 * -------------------------------------------------------------------------- */
typedef struct {
    char src[MAX_PATH_LEN];
    char dest[MAX_PATH_LEN];
    bool compress;
} backup_job_t;

/* --------------------------------------------------------------------------
 * Utility helpers
 * -------------------------------------------------------------------------- */

/* Trim leading and trailing whitespace in place */
static void trim(char *s)
{
    char *end;

    while (*s && (*s == ' ' || *s == '\t' || *s == '\n'))
        s++;

    if (*s == 0)
        return;

    end = s + strlen(s) - 1;
    while (end > s && (*end == ' ' || *end == '\t' || *end == '\n'))
        end--;

    *(end + 1) = '\0';
}

/* Safe mkpath(2)-like recursive directory creation */
static int mkdir_p(const char *path, mode_t mode)
{
    char tmp[MAX_PATH_LEN];
    char *p = NULL;
    size_t len;

    errno = 0;

    strncpy(tmp, path, sizeof(tmp));
    tmp[sizeof(tmp) - 1] = '\0';
    len = strlen(tmp);

    if (len == 0)
        return -1;

    if (tmp[len - 1] == '/')
        tmp[len - 1] = '\0';

    for (p = tmp + 1; *p; ++p)
    {
        if (*p == '/')
        {
            *p = '\0';
            if (mkdir(tmp, mode) < 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }

    if (mkdir(tmp, mode) < 0 && errno != EEXIST)
        return -1;

    return 0;
}

/* Send status update to the global event bus */
static void publish_status(const char *level, const char *msg)
{
    if (g_status_q == (mqd_t)-1)
        return;

    char buffer[MAX_MSG_SIZE];
    snprintf(buffer, sizeof(buffer),
             "{\"module\":\"%s\",\"level\":\"%s\",\"msg\":\"%s\"}",
             AGENT_IDENT, level, msg);

    (void)mq_send(g_status_q, buffer, strlen(buffer) + 1, 0);
}

/* Return current UNIX epoch milliseconds */
static long long epoch_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000LL + tv.tv_usec / 1000;
}

/* --------------------------------------------------------------------------
 * SQLite helpers
 * -------------------------------------------------------------------------- */
static int db_init(void)
{
    const char *create_sql =
        "CREATE TABLE IF NOT EXISTS snapshots ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "src TEXT NOT NULL,"
        "dest TEXT NOT NULL,"
        "compress INTEGER NOT NULL,"
        "started_ms INTEGER,"
        "finished_ms INTEGER,"
        "status TEXT);";

    int rc = sqlite3_open(DB_PATH, &g_db);
    if (rc != SQLITE_OK)
        return rc;

    char *errmsg = NULL;
    rc = sqlite3_exec(g_db, create_sql, NULL, NULL, &errmsg);
    if (rc != SQLITE_OK)
    {
        syslog(LOG_ERR, "SQLite create table failed: %s", errmsg);
        sqlite3_free(errmsg);
    }
    return rc;
}

static int db_begin_snapshot(const backup_job_t *job, long long started_ms,
                             long long *rowid_out)
{
    const char *sql =
        "INSERT INTO snapshots (src, dest, compress, started_ms, status) "
        "VALUES (?,?,?,?, 'RUNNING');";
    sqlite3_stmt *stmt = NULL;
    int rc = sqlite3_prepare_v2(g_db, sql, -1, &stmt, NULL);
    if (rc != SQLITE_OK)
        return rc;

    sqlite3_bind_text(stmt, 1, job->src, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, job->dest, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 3, job->compress ? 1 : 0);
    sqlite3_bind_int64(stmt, 4, started_ms);

    rc = sqlite3_step(stmt);
    if (rc == SQLITE_DONE)
        *rowid_out = sqlite3_last_insert_rowid(g_db);
    else
        syslog(LOG_ERR, "SQLite insert failed: %s", sqlite3_errmsg(g_db));

    sqlite3_finalize(stmt);
    return rc == SQLITE_DONE ? SQLITE_OK : rc;
}

static void db_finish_snapshot(long long rowid, long long finished_ms,
                               const char *status)
{
    const char *sql =
        "UPDATE snapshots SET finished_ms=?, status=? WHERE id=?;";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(g_db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return;

    sqlite3_bind_int64(stmt, 1, finished_ms);
    sqlite3_bind_text(stmt, 2, status, -1, SQLITE_STATIC);
    sqlite3_bind_int64(stmt, 3, rowid);

    if (sqlite3_step(stmt) != SQLITE_DONE)
        syslog(LOG_ERR, "SQLite update failed: %s", sqlite3_errmsg(g_db));

    sqlite3_finalize(stmt);
}

/* --------------------------------------------------------------------------
 * Backup logic
 * -------------------------------------------------------------------------- */

/*
 * Copy directory tree using tar(1).  In production we'd re-implement
 * this in-proc or leverage libarchive, but for teaching purposes a
 * fork/exec keeps the code concise while still demonstrating job
 * orchestration, logging, and error handling.
 */
static int run_backup(const backup_job_t *job)
{
    char timestamp[32];
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    strftime(timestamp, sizeof(timestamp), "%Y%m%d%H%M%S", &tm_now);

    if (mkdir_p(job->dest, 0750) != 0)
    {
        syslog(LOG_ERR, "Failed to create destination path %s: %s",
               job->dest, strerror(errno));
        return -1;
    }

    char *archive_path = NULL;
    if (job->compress)
        asprintf(&archive_path, "%s/snapshot_%s.tar.gz", job->dest, timestamp);
    else
        asprintf(&archive_path, "%s/snapshot_%s.tar", job->dest, timestamp);

    if (!archive_path)
        return -1;

    char *cmd = NULL;
    if (job->compress)
        asprintf(&cmd, "tar -czf %s -C %s .", archive_path, job->src);
    else
        asprintf(&cmd, "tar -cf %s -C %s .", archive_path, job->src);

    if (!cmd)
    {
        free(archive_path);
        return -1;
    }

    syslog(LOG_INFO, "Executing backup command: %s", cmd);

    int ret = system(cmd);
    free(cmd);
    free(archive_path);

    if (ret == -1)
    {
        syslog(LOG_ERR, "system() failed: %s", strerror(errno));
        return -1;
    }
    else if (WEXITSTATUS(ret) != 0)
    {
        syslog(LOG_ERR, "Backup command exited with status %d",
               WEXITSTATUS(ret));
        return -1;
    }

    return 0;
}

/* --------------------------------------------------------------------------
 * Command parsing
 * -------------------------------------------------------------------------- */
static bool parse_job(const char *msg, backup_job_t *out_job)
{
    /* Expected format: BACKUP|<src>|<dest>|<compress> */
    char *dup = strdup(msg);
    if (!dup)
        return false;

    char *token;
    int field = 0;
    bool ok = false;

    for (token = strtok(dup, "|"); token; token = strtok(NULL, "|"))
    {
        trim(token);
        switch (field++)
        {
        case 0:
            if (strcmp(token, "BACKUP") != 0)
                goto done;
            break;
        case 1:
            strncpy(out_job->src, token, MAX_PATH_LEN);
            out_job->src[MAX_PATH_LEN - 1] = '\0';
            break;
        case 2:
            strncpy(out_job->dest, token, MAX_PATH_LEN);
            out_job->dest[MAX_PATH_LEN - 1] = '\0';
            break;
        case 3:
            out_job->compress = (atoi(token) != 0);
            ok = true;
            break;
        default:
            break;
        }
    }

done:
    free(dup);
    return ok && field == 4;
}

/* --------------------------------------------------------------------------
 * Signal handling
 * -------------------------------------------------------------------------- */
static void handle_signal(int sig)
{
    (void)sig;
    g_shutdown_requested = 1;
}

/* --------------------------------------------------------------------------
 * Thread – Command listener
 * -------------------------------------------------------------------------- */
static void *command_listener(void *arg)
{
    (void)arg;
    char buffer[MAX_MSG_SIZE];

    while (!g_shutdown_requested)
    {
        ssize_t n = mq_receive(g_cmd_q, buffer, sizeof(buffer), NULL);
        if (n < 0)
        {
            if (errno == EINTR)
                continue; /* interrupted by signal */
            if (errno == EAGAIN)
            {
                /* No message; sleep briefly for non-busy loop */
                usleep(100 * 1000);
                continue;
            }

            syslog(LOG_ERR, "mq_receive failed: %s", strerror(errno));
            break;
        }

        buffer[n] = '\0';
        backup_job_t job;
        if (!parse_job(buffer, &job))
        {
            syslog(LOG_WARNING, "Ignoring malformed command: %s", buffer);
            continue;
        }

        char status_msg[256];
        snprintf(status_msg, sizeof(status_msg),
                 "Started backup from %s to %s (compress=%d)",
                 job.src, job.dest, job.compress);
        publish_status("INFO", status_msg);

        long long start_ms = epoch_ms();
        long long rowid = 0;
        if (db_begin_snapshot(&job, start_ms, &rowid) != SQLITE_OK)
            rowid = 0;

        int rc = run_backup(&job);

        long long end_ms = epoch_ms();
        if (rowid > 0)
            db_finish_snapshot(rowid, end_ms, rc == 0 ? "OK" : "FAIL");

        snprintf(status_msg, sizeof(status_msg),
                 "Backup %s for source %s",
                 rc == 0 ? "completed" : "failed", job.src);
        publish_status(rc == 0 ? "INFO" : "ERROR", status_msg);
    }

    return NULL;
}

/* --------------------------------------------------------------------------
 * Initialization
 * -------------------------------------------------------------------------- */
static int init_message_queues(void)
{
    struct mq_attr attr = {
        .mq_flags   = 0,
        .mq_maxmsg  = 10,
        .mq_msgsize = MAX_MSG_SIZE,
        .mq_curmsgs = 0
    };

    g_cmd_q = mq_open(CMD_QUEUE_NAME, O_RDONLY | O_NONBLOCK | O_CREAT, 0640, &attr);
    if (g_cmd_q == (mqd_t)-1)
        return -1;

    g_status_q = mq_open(STATUS_QUEUE_NAME, O_WRONLY | O_NONBLOCK | O_CREAT, 0640, &attr);
    if (g_status_q == (mqd_t)-1)
        return -1;

    return 0;
}

static void cleanup(void)
{
    if (g_cmd_q != (mqd_t)-1)
        mq_close(g_cmd_q);
    if (g_status_q != (mqd_t)-1)
        mq_close(g_status_q);
    if (g_db)
        sqlite3_close(g_db);
    syslog(LOG_INFO, "Backup agent shut down gracefully");
}

/* --------------------------------------------------------------------------
 * Main entry
 * -------------------------------------------------------------------------- */
int main(int argc, char *argv[])
{
    (void)argc; (void)argv;

    openlog(AGENT_IDENT, LOG_PID | LOG_CONS, LOG_DAEMON);
    syslog(LOG_INFO, "Agent starting");

    /* Catch termination signals */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handle_signal;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    if (init_message_queues() != 0)
    {
        syslog(LOG_ERR, "Failed to open message queues: %s", strerror(errno));
        return EXIT_FAILURE;
    }

    if (db_init() != SQLITE_OK)
    {
        syslog(LOG_ERR, "Failed to initialize SQLite");
        return EXIT_FAILURE;
    }

    pthread_t listener_thread;
    if (pthread_create(&listener_thread, NULL, command_listener, NULL) != 0)
    {
        syslog(LOG_ERR, "pthread_create() failed");
        return EXIT_FAILURE;
    }

    /* Wait for shutdown */
    while (!g_shutdown_requested)
        pause();

    /* Wake listener and join */
    pthread_cancel(listener_thread);
    pthread_join(listener_thread, NULL);

    cleanup();
    return EXIT_SUCCESS;
}