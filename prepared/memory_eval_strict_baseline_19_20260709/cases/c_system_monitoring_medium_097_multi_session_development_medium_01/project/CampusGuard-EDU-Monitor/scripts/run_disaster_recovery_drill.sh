```c
/*
 *  CampusGuard EDU Monitor – Disaster-Recovery Drill Runner
 *
 *  File:    scripts/run_disaster_recovery_drill.c
 *  Purpose: Executable invoked by the UI-layer shell wrapper
 *           “run_disaster_recovery_drill.sh”.  It coordinates a
 *           full-stack disaster-recovery (DR) drill by validating
 *           user permissions, checking backup snapshots tracked in
 *           the local SQLite metadata store, restoring them to an
 *           isolated sandbox, and reporting results back to the
 *           internal Event Bus.
 *
 *  Build:   cc -Wall -Wextra -pedantic -std=c17 \
 *              -lpthread -lsqlite3 \
 *              -o run_disaster_recovery_drill \
 *              scripts/run_disaster_recovery_drill.c
 *
 *  Copyright © 2024
 *  CampusGuard EDU – All rights reserved.
 */

#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <syslog.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* --------------------------------------------------------------------------
 *  Constants & Definitions
 * --------------------------------------------------------------------------*/
#define DB_PATH               "/var/lib/campusguard/snapshots.db"
#define EVENT_BUS_SOCK        "/run/campusguard/event_bus.sock"
#define MAX_SERVICE_NAME_LEN  64
#define MAX_PLAN_SERVICES     32
#define RESTORE_SIM_SECONDS   3        /* Each restore is simulated to take N seconds */

/* Exit codes that integrate with the wider CampusGuard Controller. */
enum {
    EXIT_SUCCESS_DRILL      = 0,
    EXIT_FAILURE_ARGS       = 64,
    EXIT_FAILURE_PERM       = 65,
    EXIT_FAILURE_DB         = 66,
    EXIT_FAILURE_RUNTIME    = 70
};

/* DR Drill Result for a single service. */
typedef struct {
    char   service_name[MAX_SERVICE_NAME_LEN];
    bool   snapshot_found;
    bool   restore_ok;
    char   err_msg[128];
} drill_result_t;

/* Handler interface for Chain-of-Responsibility */
typedef struct handler {
    bool (*handle)(struct handler *self, void *ctx, char *err_msg, size_t err_sz);
    struct handler *next;
} handler_t;

/* --------------------------------------------------------------------------
 *  Logging Helpers
 * --------------------------------------------------------------------------*/
static void vlog(int prio, const char *fmt, va_list ap)
{
    vsyslog(prio, fmt, ap);              /* System journal */
    vfprintf(stderr, fmt, ap);           /* Console (for interactive runs) */
    fprintf(stderr, "\n");
}

static void log_msg(int prio, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vlog(prio, fmt, ap);
    va_end(ap);
}

/* --------------------------------------------------------------------------
 *  Utility – Secure getuid() permission validation
 * --------------------------------------------------------------------------*/
static bool check_permissions(void)
{
    /* Only allow root or members of ‘campusguard’ group (gid lookup omitted). */
    return geteuid() == 0;
}

static bool permission_handler(struct handler *self, void *ctx,
                               char *err_msg, size_t err_sz)
{
    (void) self; (void) ctx;
    if (!check_permissions()) {
        snprintf(err_msg, err_sz, "Insufficient permissions: run as root.");
        return false;
    }
    return true;
}

/* --------------------------------------------------------------------------
 *  Utility – Maintenance window validation
 * --------------------------------------------------------------------------*/
static bool maintenance_window_ok(void)
{
    /* Example policy: DR drills allowed 00:00-06:00 local time. */
    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    return (tm_now.tm_hour >= 0 && tm_now.tm_hour < 6);
}

static bool window_handler(struct handler *self, void *ctx,
                           char *err_msg, size_t err_sz)
{
    (void) self; (void) ctx;
    if (!maintenance_window_ok()) {
        snprintf(err_msg, err_sz,
                 "Outside maintenance window (00:00-06:00)");
        return false;
    }
    return true;
}

/* --------------------------------------------------------------------------
 *  Event Bus – simple UNIX-domain socket publisher
 * --------------------------------------------------------------------------*/
static void bus_publish(const char *json_payload)
{
    int sock = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (sock == -1)
        return;

    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    strncpy(addr.sun_path, EVENT_BUS_SOCK, sizeof(addr.sun_path) - 1);

    /* Best-effort fire-and-forget */
    sendto(sock, json_payload, strlen(json_payload), 0,
           (struct sockaddr *)&addr, sizeof(addr));

    close(sock);
}

/* --------------------------------------------------------------------------
 *  Snapshot verification – SQLite lookup
 * --------------------------------------------------------------------------*/
static bool snapshot_exists(sqlite3 *db, const char *service)
{
    static const char *sql =
        "SELECT 1 FROM snapshots "
        " WHERE service = ?1 "
        "   AND status  = 'OK' "
        " ORDER BY taken_at DESC LIMIT 1";

    sqlite3_stmt *stmt = NULL;
    bool found = false;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK)
        return false;

    sqlite3_bind_text(stmt, 1, service, -1, SQLITE_TRANSIENT);

    int rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW)
        found = true;

    sqlite3_finalize(stmt);
    return found;
}

/* --------------------------------------------------------------------------
 *  Thread worker – simulate restore for a service
 * --------------------------------------------------------------------------*/
typedef struct {
    const char      *service;
    sqlite3         *db_conn;
    drill_result_t  *result_slot;
    atomic_uint     *progress_ctr;
} worker_ctx_t;

static void *worker_thread(void *arg)
{
    worker_ctx_t *wctx = arg;
    drill_result_t *res = wctx->result_slot;

    strncpy(res->service_name, wctx->service, sizeof(res->service_name)-1);

    /* 1. Verify snapshot */
    if (!(res->snapshot_found = snapshot_exists(wctx->db_conn, wctx->service))) {
        snprintf(res->err_msg, sizeof(res->err_msg),
                 "Snapshot not found.");
        goto done;
    }

    /* 2. Simulate RESTORE operation */
    sleep(RESTORE_SIM_SECONDS);

    /* 3. “Health check” – Here we just mark success */
    res->restore_ok = true;

done:
    atomic_fetch_add_explicit(wctx->progress_ctr, 1, memory_order_release);
    return NULL;
}

/* --------------------------------------------------------------------------
 *  Command-line plan parsing
 * --------------------------------------------------------------------------*/
static size_t parse_plan_file(const char *plan_path, char services[][MAX_SERVICE_NAME_LEN])
{
    FILE *fp = fopen(plan_path, "r");
    if (!fp) {
        log_msg(LOG_ERR, "Unable to open plan file %s: %s", plan_path,
                strerror(errno));
        return 0;
    }

    char line[128];
    size_t count = 0;
    while (fgets(line, sizeof(line), fp) && count < MAX_PLAN_SERVICES) {
        char *newline = strchr(line, '\n');
        if (newline) *newline = '\0';
        if (strlen(line) == 0 || line[0] == '#')
            continue;
        strncpy(services[count++], line, MAX_SERVICE_NAME_LEN-1);
    }

    fclose(fp);
    return count;
}

/* --------------------------------------------------------------------------
 *  Main
 * --------------------------------------------------------------------------*/
static void usage(const char *argv0)
{
    fprintf(stderr,
        "Usage: %s [-p plan.txt] [--dry-run] [--force]\n"
        "Options:\n"
        "  -p FILE   Service plan file (default: /etc/campusguard/dr_plan.txt)\n"
        "  --dry-run Validate prerequisites but skip restore.\n"
        "  --force   Ignore maintenance window restriction.\n",
        argv0);
}

int main(int argc, char **argv)
{
    openlog("campusguard_drill", LOG_PID | LOG_CONS, LOG_DAEMON);

    const char *plan_path = "/etc/campusguard/dr_plan.txt";
    bool dry_run = false;
    bool force   = false;

    /* --- Simple CLI parser --------------------------------------------- */
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "-p") && i + 1 < argc) {
            plan_path = argv[++i];
        } else if (!strcmp(argv[i], "--dry-run")) {
            dry_run = true;
        } else if (!strcmp(argv[i], "--force")) {
            force = true;
        } else {
            usage(argv[0]);
            exit(EXIT_FAILURE_ARGS);
        }
    }

    /* --- Chain-of-Responsibility validation ----------------------------- */
    char err_msg[128] = {0};
    handler_t perm_h  = { .handle = permission_handler, .next = NULL };
    handler_t window_h = { .handle = window_handler, .next = &perm_h };
    handler_t *h = force ? &perm_h : &window_h;

    for (; h; h = h->next) {
        if (!h->handle(h, NULL, err_msg, sizeof(err_msg))) {
            log_msg(LOG_ERR, "%s", err_msg);
            exit(EXIT_FAILURE_PERM);
        }
    }

    /* --- Load service plan --------------------------------------------- */
    char services[MAX_PLAN_SERVICES][MAX_SERVICE_NAME_LEN] = {{0}};
    size_t svc_count = parse_plan_file(plan_path, services);

    if (svc_count == 0) {
        log_msg(LOG_ERR, "No services found in plan file.");
        exit(EXIT_FAILURE_ARGS);
    }

    log_msg(LOG_INFO, "Starting DR drill for %zu services (%s).",
            svc_count, dry_run ? "dry-run" : "live");

    /* --- Initialize DB connection -------------------------------------- */
    sqlite3 *db = NULL;
    if (sqlite3_open_v2(DB_PATH, &db, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        log_msg(LOG_ERR, "SQLite open failed: %s", sqlite3_errmsg(db));
        sqlite3_close(db);
        exit(EXIT_FAILURE_DB);
    }

    /* --- Spawn restore workers ----------------------------------------- */
    drill_result_t results[MAX_PLAN_SERVICES] = {{{0}}};
    pthread_t threads[MAX_PLAN_SERVICES]      = {0};
    worker_ctx_t wctx[MAX_PLAN_SERVICES];
    atomic_uint progress = ATOMIC_VAR_INIT(0);

    if (!dry_run) {
        for (size_t i = 0; i < svc_count; ++i) {
            wctx[i] = (worker_ctx_t){
                .service      = services[i],
                .db_conn      = db,
                .result_slot  = &results[i],
                .progress_ctr = &progress
            };
            if (pthread_create(&threads[i], NULL, worker_thread, &wctx[i]) != 0) {
                log_msg(LOG_ERR, "Thread creation failed for %s", services[i]);
                results[i].restore_ok = false;
                snprintf(results[i].err_msg,
                         sizeof(results[i].err_msg),
                         "pthread_create: %s", strerror(errno));
                atomic_fetch_add(&progress, 1);
            }
        }
    } else {
        /* Dry-run only validates snapshots synchronously */
        for (size_t i = 0; i < svc_count; ++i) {
            strncpy(results[i].service_name, services[i],
                    sizeof(results[i].service_name)-1);
            results[i].snapshot_found = snapshot_exists(db, services[i]);
            results[i].restore_ok     = results[i].snapshot_found;
            if (!results[i].snapshot_found)
                snprintf(results[i].err_msg, sizeof(results[i].err_msg),
                         "Snapshot not found.");
            atomic_fetch_add(&progress, 1);
        }
    }

    /* --- Progress reporting loop --------------------------------------- */
    while (atomic_load(&progress) < svc_count) {
        log_msg(LOG_INFO, "Progress: %u / %zu completed.",
                atomic_load(&progress), svc_count);
        sleep(1);
    }

    /* --- Join threads --------------------------------------------------- */
    if (!dry_run) {
        for (size_t i = 0; i < svc_count; ++i)
            pthread_join(threads[i], NULL);
    }

    /* --- Summary -------------------------------------------------------- */
    size_t ok_cnt = 0;
    for (size_t i = 0; i < svc_count; ++i) {
        if (results[i].restore_ok)
            ++ok_cnt;
        const char *status = results[i].restore_ok ? "OK" : "FAILED";
        log_msg(results[i].restore_ok ? LOG_INFO : LOG_ERR,
                "[%s] %s – %s",
                results[i].service_name, status,
                results[i].err_msg[0] ? results[i].err_msg : "No errors");
    }

    log_msg(LOG_INFO, "DR drill finished: %zu / %zu succeeded.",
            ok_cnt, svc_count);

    /* --- Publish to Event Bus ------------------------------------------ */
    char payload[256];
    snprintf(payload, sizeof(payload),
             "{\"type\":\"drill_result\",\"success\":%zu,\"total\":%zu}",
             ok_cnt, svc_count);
    bus_publish(payload);

    sqlite3_close(db);
    closelog();

    return (ok_cnt == svc_count) ? EXIT_SUCCESS_DRILL : EXIT_FAILURE_RUNTIME;
}
```