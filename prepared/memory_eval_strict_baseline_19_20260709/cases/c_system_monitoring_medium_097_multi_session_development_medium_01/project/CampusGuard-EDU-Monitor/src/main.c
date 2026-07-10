/*
 * CampusGuard EDU Monitor
 * File: src/main.c
 *
 * The main entry point of the CampusGuard EDU Monitor daemon.  This process
 * is responsible for boot-strapping the MVC framework, wiring the Observer
 * pattern, starting the event loop, and gracefully shutting everything down.
 *
 * Author: CampusGuard Core Team
 * License: MIT
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <poll.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <syslog.h>
#include <time.h>
#include <unistd.h>

#include "controller/controller.h"   /* MVC Controller façade           */
#include "core/bus.h"                /* Event-Driven message bus         */
#include "core/logger.h"             /* Structured logger                */
#include "model/database.h"          /* SQLite data-models               */
#include "view/dashboard.h"          /* GTK/ncurses dashboard            */

/*---------------------------------------------------------------------------
 * Constants & Macros
 *--------------------------------------------------------------------------*/
#define DEFAULT_CONFIG_FILE "/etc/campusguard/campusguard.conf"
#define DEFAULT_SQLITE_FILE "/var/lib/campusguard/campusguard.db"
#define POLL_TIMEOUT_MS     500      /* Half-second UI refresh rate      */

#ifndef VERSION
#  define VERSION "dev-build"
#endif

/*---------------------------------------------------------------------------
 * Structures
 *--------------------------------------------------------------------------*/
/* Central application context passed around to sub-systems */
typedef struct AppContext
{
    char            *config_path;
    char            *db_path;

    sqlite3         *db;             /* Models                           */
    CG_Bus          *bus;            /* Event bus                        */
    CG_Controller   *controller;     /* Chain-of-Responsibility root     */

    int              wake_fd;        /* EventFD for cross-thread wakeup  */
    volatile sig_atomic_t shutting_down;
} AppContext;

/*---------------------------------------------------------------------------
 * Forward Declarations
 *--------------------------------------------------------------------------*/
static void         print_usage            (const char *prog);
static int          parse_cli              (int argc, char **argv,
                                            AppContext *ctx);
static int          init_subsystems        (AppContext *ctx);
static void         shutdown_subsystems    (AppContext *ctx);
static void         install_signal_handlers(AppContext *ctx);
static void         signal_handler         (int sig);
static void        *log_aggregator_thread  (void *arg);
static int          kick_event_loop        (AppContext *ctx);

/*---------------------------------------------------------------------------
 * Globals
 *--------------------------------------------------------------------------*/
static AppContext *g_ctx = NULL;     /* Exposed to signal handler        */

/*---------------------------------------------------------------------------
 * MAIN
 *--------------------------------------------------------------------------*/
int main(int argc, char **argv)
{
    int rc = EXIT_FAILURE;
    AppContext ctx = {
        .config_path   = NULL,
        .db_path       = NULL,
        .db            = NULL,
        .bus           = NULL,
        .controller    = NULL,
        .wake_fd       = -1,
        .shutting_down = 0
    };

    g_ctx = &ctx;

    /*----------------------------------------------------------------------
     * Parse CLI arguments
     *---------------------------------------------------------------------*/
    if (parse_cli(argc, argv, &ctx) != 0) {
        goto out;
    }

    /*----------------------------------------------------------------------
     * Sub-system bootstrap
     *---------------------------------------------------------------------*/
    if (init_subsystems(&ctx) != 0) {
        goto out;
    }

    syslog(LOG_INFO, "CampusGuard EDU Monitor %s started.", VERSION);

    /*----------------------------------------------------------------------
     * Event Loop
     *---------------------------------------------------------------------*/
    rc = kick_event_loop(&ctx);

    /*----------------------------------------------------------------------
     * Shutdown
     *---------------------------------------------------------------------*/
out:
    shutdown_subsystems(&ctx);
    syslog(LOG_INFO, "CampusGuard EDU Monitor terminates with code %d.", rc);
    closelog();

    return rc;
}

/*---------------------------------------------------------------------------
 * Command-line Parsing
 *--------------------------------------------------------------------------*/
static struct option long_opts[] = {
    { "config", required_argument, NULL, 'c' },
    { "database", required_argument, NULL, 'd' },
    { "version", no_argument, NULL, 'v' },
    { "help",    no_argument, NULL, 'h' },
    { 0, 0, 0, 0 }
};

static int parse_cli(int argc, char **argv, AppContext *ctx)
{
    int opt;
    while ((opt = getopt_long(argc, argv, "c:d:vh", long_opts, NULL)) != -1) {
        switch (opt) {
        case 'c':
            ctx->config_path = strdup(optarg);
            break;
        case 'd':
            ctx->db_path = strdup(optarg);
            break;
        case 'v':
            fprintf(stdout, "CampusGuard EDU Monitor version %s\n", VERSION);
            exit(EXIT_SUCCESS);
        case 'h':
        default:
            print_usage(argv[0]);
            return -1;
        }
    }

    if (!ctx->config_path)
        ctx->config_path = strdup(DEFAULT_CONFIG_FILE);

    if (!ctx->db_path)
        ctx->db_path = strdup(DEFAULT_SQLITE_FILE);

    return 0;
}

static void print_usage(const char *prog)
{
    fprintf(stderr,
        "Usage: %s [options]\n"
        "Options:\n"
        "  -c, --config <file>    Path to config file (default: %s)\n"
        "  -d, --database <file>  SQLite database file (default: %s)\n"
        "  -v, --version          Show version information\n"
        "  -h, --help             Show this help message\n",
        prog, DEFAULT_CONFIG_FILE, DEFAULT_SQLITE_FILE);
}

/*---------------------------------------------------------------------------
 * Subsystem Initialization / Shutdown
 *--------------------------------------------------------------------------*/
static int init_subsystems(AppContext *ctx)
{
    int rc = -1;

    /* openlog early to capture logs from bootstrap as well */
    openlog("campusguard", LOG_PID | LOG_NDELAY | LOG_NOWAIT, LOG_DAEMON);

    /* 1. Logger (stdout + syslog) */
    if (cg_logger_init(ctx->config_path) != 0) {
        syslog(LOG_ERR, "Unable to initialise logger.");
        goto fail;
    }

    /* 2. SQLite DB (Model) */
    if (cg_db_open(ctx->db_path, &ctx->db) != 0) {
        cg_log_fatal("Failed to open database: %s", ctx->db_path);
        goto fail;
    }

    /* 3. Event Bus */
    ctx->bus = cg_bus_new();
    if (!ctx->bus) {
        cg_log_fatal("Failed to create message bus.");
        goto fail;
    }

    /* 4. MVC Controller root */
    ctx->controller = cg_controller_new(ctx->bus, ctx->db);
    if (!ctx->controller) {
        cg_log_fatal("Failed to construct controller.");
        goto fail;
    }

    /* 5. Dashboard View (GTK/ncurses depending on environment) */
    if (cg_dashboard_init(ctx->bus) != 0) {
        cg_log_fatal("Unable to initialise dashboard.");
        goto fail;
    }

    /* 6. Cross-thread wakeup EventFD */
    if ((ctx->wake_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC)) == -1) {
        cg_log_errno(errno, "eventfd");
        goto fail;
    }
    cg_bus_set_wakeup_fd(ctx->bus, ctx->wake_fd);

    /* 7. Log-aggregation thread (demonstrative) */
    pthread_t tid;
    if (pthread_create(&tid, NULL, log_aggregator_thread, ctx) != 0) {
        cg_log_errno(errno, "pthread_create");
        goto fail;
    }
    pthread_detach(tid);

    /* 8. Signal handling */
    install_signal_handlers(ctx);

    rc = 0;

fail:
    if (rc != 0)
        shutdown_subsystems(ctx);

    return rc;
}

static void shutdown_subsystems(AppContext *ctx)
{
    if (!ctx) return;

    ctx->shutting_down = 1;

    /* Notify event loop to exit */
    uint64_t one = 1;
    if (ctx->wake_fd != -1)
        write(ctx->wake_fd, &one, sizeof(one));

    cg_dashboard_shutdown();

    if (ctx->controller)
        cg_controller_destroy(ctx->controller);

    if (ctx->bus)
        cg_bus_destroy(ctx->bus);

    if (ctx->db)
        cg_db_close(ctx->db);

    cg_logger_shutdown();

    if (ctx->wake_fd != -1)
        close(ctx->wake_fd);

    free(ctx->config_path);
    free(ctx->db_path);
}

/*---------------------------------------------------------------------------
 * Signal Handling
 *--------------------------------------------------------------------------*/
static void install_signal_handlers(AppContext *ctx)
{
    (void)ctx;
    struct sigaction sa = { 0 };
    sigemptyset(&sa.sa_mask);
    sa.sa_handler = signal_handler;
    sa.sa_flags   = SA_RESTART;

    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP,  &sa, NULL);
}

static void signal_handler(int sig)
{
    if (!g_ctx)
        return;

    switch (sig) {
    case SIGINT:
    case SIGTERM:
        g_ctx->shutting_down = 1;
        break;
    case SIGHUP:
        cg_logger_reload_config();
        break;
    default:
        break;
    }

    /* Wake the poll loop so it handles the new state quickly */
    uint64_t one = 1;
    if (g_ctx->wake_fd != -1)
        write(g_ctx->wake_fd, &one, sizeof(one));
}

/*---------------------------------------------------------------------------
 * Example Background Thread: Log Aggregator
 *
 * Simplified demonstration of the Observer pattern: the thread tails a
 * directory for new log files and publishes events to the message bus.
 * In production you might integrate inotify(7) or journald APIs instead.
 *--------------------------------------------------------------------------*/
static void *log_aggregator_thread(void *arg)
{
    AppContext *ctx = arg;
    const char  *log_root = "/var/log/campusguard";

    /* Ensure directory exists */
    struct stat st = { 0 };
    if (stat(log_root, &st) == -1) {
        if (mkdir(log_root, 0755) == -1 && errno != EEXIST) {
            cg_log_errno(errno, "mkdir(%s)", log_root);
            return NULL;
        }
    }

    /* Very naive polling implementation */
    while (!ctx->shutting_down) {
        DIR *dir = opendir(log_root);
        if (!dir) {
            cg_log_errno(errno, "opendir(%s)", log_root);
            sleep(1);
            continue;
        }

        struct dirent *ent;
        while ((ent = readdir(dir)) != NULL) {
            if (ent->d_type != DT_REG)
                continue;

            char path[PATH_MAX];
            snprintf(path, sizeof(path), "%s/%s", log_root, ent->d_name);

            /* Example: publish "LOG_NEW" event */
            CG_Event ev = {
                .type = CG_EVENT_LOG_NEW,
                .payload.str = strdup(path)
            };
            cg_bus_publish(ctx->bus, &ev);
            cg_log_debug("New log discovered: %s", path);
        }
        closedir(dir);

        sleep(5);
    }
    return NULL;
}

/*---------------------------------------------------------------------------
 * Event Loop
 *--------------------------------------------------------------------------*/
static int kick_event_loop(AppContext *ctx)
{
    struct pollfd fds[] = {
        { .fd = ctx->wake_fd, .events = POLLIN, .revents = 0 },
        { .fd = cg_bus_fd(ctx->bus), .events = POLLIN, .revents = 0 }
    };

    while (!ctx->shutting_down) {
        int rc = poll(fds, 2, POLL_TIMEOUT_MS);
        if (rc == -1) {
            if (errno == EINTR)
                continue;
            cg_log_errno(errno, "poll");
            break;
        }

        /* Wake-FD event: clear it */
        if (fds[0].revents & POLLIN) {
            uint64_t v;
            read(ctx->wake_fd, &v, sizeof(v));
        }

        /* Bus has messages */
        if (fds[1].revents & POLLIN) {
            CG_Event ev;
            while (cg_bus_pop(ctx->bus, &ev) == 0) {
                cg_controller_handle(ctx->controller, &ev);
                cg_event_destroy(&ev);
            }
        }

        /* View refresh tick (Observer pattern) */
        cg_dashboard_tick();
    }

    return EXIT_SUCCESS;
}