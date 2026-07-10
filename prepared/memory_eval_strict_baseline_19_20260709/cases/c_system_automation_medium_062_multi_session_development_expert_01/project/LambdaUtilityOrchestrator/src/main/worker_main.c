/**
 * LambdaUtility Orchestrator : worker_main.c
 *
 * The worker is the single entry-point executed by a serverless runtime (e.g.,
 * AWS Lambda’s custom-runtime, Google Cloud Functions “gcf-framework”, Azure
 * Functions custom-handler, or a bare-metal CronRunner).  The runtime passes
 * an event—usually JSON—via STDIN; the worker parses the event, constructs a
 * Command object, forwards it through a Chain-of-Responsibility pipeline,
 * and finally notifies subscribing observers (Slack, email, SMS, …).
 *
 * While the full orchestration suite spans multiple compilation units, this
 * file is intentionally self-contained so it can be built and unit-tested in
 * isolation.  Stub implementations for Slack/E-mail publishers and metrics
 * collection are provided and can be replaced at link-time with production
 * variants.
 *
 * Build example (static linking with cJSON):
 *     cc -std=c11 -Wall -Wextra -O2 worker_main.c -lcjson -lpthread -o worker
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <stdbool.h>
#include <stdarg.h>
#include <signal.h>

#include <pthread.h>       /* Observers could be threaded */
#include <unistd.h>        /* read() / write(), POSIX */
// External dependency (https://github.com/DaveGamble/cJSON)
#include <cjson/cJSON.h>

/*-------------  Configuration Constants  ----------------------------------*/

#define MAX_EVENT_SIZE        (32 * 1024)     /* 32 KiB — AWS default limit   */
#define MAX_CHANNEL_NAME      32
#define MAX_MESSAGE_SIZE      1024
#define VERSION_TAG           "1.4.2"

/*-------------  Logger -----------------------------------------------------*/

typedef enum {
    LOG_DEBUG,
    LOG_INFO,
    LOG_WARN,
    LOG_ERROR,
    LOG_FATAL
} log_level_t;

static const char *level_to_string(log_level_t lvl)
{
    switch (lvl) {
        case LOG_DEBUG: return "DEBUG";
        case LOG_INFO:  return "INFO ";
        case LOG_WARN:  return "WARN ";
        case LOG_ERROR: return "ERROR";
        case LOG_FATAL: return "FATAL";
        default:        return "UNKWN";
    }
}

static void logger(log_level_t lvl, const char *fmt, ...)
{
    static FILE *log_sink = NULL;
    if (!log_sink) {
        /* Default to stderr; could be /tmp/debug.log inside Lambda */
        log_sink = stderr;
    }

    time_t  now   = time(NULL);
    char    ts[20];  /* YYYY-mm-dd HH:MM:SS */
    strftime(ts, sizeof ts, "%F %T", localtime(&now));

    fprintf(log_sink, "[%s] %s: ", ts, level_to_string(lvl));

    va_list ap;
    va_start(ap, fmt);
    vfprintf(log_sink, fmt, ap);
    va_end(ap);

    fputc('\n', log_sink);

    if (lvl == LOG_FATAL) {
        fflush(log_sink);
        abort(); /* Immediate termination to satisfy serverless watchdog */
    }
}

#define LOGD(...) logger(LOG_DEBUG, __VA_ARGS__)
#define LOGI(...) logger(LOG_INFO , __VA_ARGS__)
#define LOGW(...) logger(LOG_WARN , __VA_ARGS__)
#define LOGE(...) logger(LOG_ERROR, __VA_ARGS__)
#define LOGF(...) logger(LOG_FATAL, __VA_ARGS__)

/*-------------  Domain Types ----------------------------------------------*/

typedef struct {
    char  *raw_json;   /* owns the buffer */
    cJSON *root;       /* parsed representation */
} event_t;

/*-------------------------------------------------------------------------*/
/*                         COMMAND PATTERN                                 */
/*-------------------------------------------------------------------------*/

typedef enum {
    CMD_ALERTING,
    CMD_CONFIG_PUSH,
    CMD_BACKUP_VOLUME,
    CMD_ROLL_DEPLOY,
    CMD_METRICS_HARVEST,
    CMD_UNKNOWN
} command_kind_t;

typedef struct command_s command_t;
typedef int (*command_exec_fn)(command_t *);

struct command_s {
    command_kind_t   kind;
    cJSON           *payload;        /* Sub-tree of the event JSON */
    command_exec_fn  execute;        /* Implementation */
    void            *ctx;            /* User-provided data */
};

/* Forward declarations for concrete commands */
static int cmd_alerting_handler(command_t *);
static int cmd_backup_handler(command_t *);
static int cmd_deploy_handler(command_t *);
static int cmd_config_handler(command_t *);
static int cmd_metrics_handler(command_t *);

/* Factory: Map event.type to Command object */
static command_t *command_factory(const event_t *ev)
{
    cJSON *type = cJSON_GetObjectItemCaseSensitive(ev->root, "type");
    if (!cJSON_IsString(type) || !type->valuestring) {
        LOGE("Missing / invalid 'type' attribute");
        return NULL;
    }

    command_t *cmd = calloc(1, sizeof *cmd);
    if (!cmd) {
        LOGE("calloc: %s", strerror(errno));
        return NULL;
    }

    cmd->payload = cJSON_GetObjectItemCaseSensitive(ev->root, "payload");
    /* Note: Payload may be NULL for some commands */

    if (strcmp(type->valuestring, "ALERT") == 0) {
        cmd->kind    = CMD_ALERTING;
        cmd->execute = cmd_alerting_handler;
    } else if (strcmp(type->valuestring, "BACKUP") == 0) {
        cmd->kind    = CMD_BACKUP_VOLUME;
        cmd->execute = cmd_backup_handler;
    } else if (strcmp(type->valuestring, "DEPLOY") == 0) {
        cmd->kind    = CMD_ROLL_DEPLOY;
        cmd->execute = cmd_deploy_handler;
    } else if (strcmp(type->valuestring, "CONFIG_PUSH") == 0) {
        cmd->kind    = CMD_CONFIG_PUSH;
        cmd->execute = cmd_config_handler;
    } else if (strcmp(type->valuestring, "METRICS") == 0) {
        cmd->kind    = CMD_METRICS_HARVEST;
        cmd->execute = cmd_metrics_handler;
    } else {
        cmd->kind    = CMD_UNKNOWN;
        cmd->execute = NULL;
    }

    return cmd;
}

/*-------------------------------------------------------------------------*/
/*                     CHAIN OF RESPONSIBILITY                             */
/*-------------------------------------------------------------------------*/

typedef struct chain_node_s chain_node_t;
typedef int (*chain_handler_fn)(command_t *, void *);

struct chain_node_s {
    chain_handler_fn  fn;      /* Returns 0 on success, non-zero to stop chain */
    void             *ctx;
    chain_node_t     *next;
};

static int chain_process(chain_node_t *head, command_t *cmd)
{
    for (chain_node_t *node = head; node; node = node->next) {
        int rc = node->fn(cmd, node->ctx);
        if (rc != 0) {
            LOGW("Chain handler aborted with rc=%d", rc);
            return rc;
        }
    }
    return 0;
}

/*-------------------------------------------------------------------------*/
/*                          OBSERVER PATTERN                               */
/*-------------------------------------------------------------------------*/

typedef struct observer_s observer_t;
typedef void (*notify_fn)(const char *channel, const char *message, void *);

struct observer_s {
    char             channel[MAX_CHANNEL_NAME];
    notify_fn        notify;
    void            *ctx;
    observer_t      *next;
};

/* Registers and notifies observers.  Single-writer / multi-reader safe. */
static observer_t *observer_head = NULL;
static pthread_rwlock_t obs_lock = PTHREAD_RWLOCK_INITIALIZER;

static bool observer_register(const char *channel, notify_fn fn, void *ctx)
{
    observer_t *obs = calloc(1, sizeof *obs);
    if (!obs) {
        LOGE("calloc: %s", strerror(errno));
        return false;
    }
    strncpy(obs->channel, channel, sizeof(obs->channel) - 1);
    obs->notify = fn;
    obs->ctx    = ctx;

    pthread_rwlock_wrlock(&obs_lock);
    obs->next   = observer_head;
    observer_head = obs;
    pthread_rwlock_unlock(&obs_lock);

    return true;
}

static void observer_notify(const char *channel, const char *msg)
{
    pthread_rwlock_rdlock(&obs_lock);
    for (observer_t *it = observer_head; it; it = it->next) {
        if (strcmp(it->channel, channel) == 0 || strcmp(it->channel, "*") == 0) {
            it->notify(channel, msg, it->ctx);
        }
    }
    pthread_rwlock_unlock(&obs_lock);
}

/*---------   Stub observer implementations (replace in production) -------*/

static void slack_notify(const char *channel, const char *msg, void *ctx)
{
    (void)ctx;
    LOGI("[Slack:%s] %s", channel, msg);
}

static void email_notify(const char *channel, const char *msg, void *ctx)
{
    const char *recipient = (const char *)ctx;
    LOGI("[Email->%s][%s] %s", recipient, channel, msg);
}

/*-------------------------------------------------------------------------*/
/*                    Concrete Command Implementations                     */
/*-------------------------------------------------------------------------*/

static int cmd_alerting_handler(command_t *cmd)
{
    const char *sev   = "INFO";
    const char *title = "Unspecified";
    cJSON *severity   = cJSON_GetObjectItemCaseSensitive(cmd->payload, "severity");
    cJSON *heading    = cJSON_GetObjectItemCaseSensitive(cmd->payload, "title");

    if (cJSON_IsString(severity)) sev = severity->valuestring;
    if (cJSON_IsString(heading))  title = heading->valuestring;

    char message[MAX_MESSAGE_SIZE];
    snprintf(message, sizeof message, "ALERT[%s]: %s", sev, title);

    observer_notify("alerts", message);

    return 0;
}

static int cmd_backup_handler(command_t *cmd)
{
    const char *volume_id = "unknown";
    cJSON *vol = cJSON_GetObjectItemCaseSensitive(cmd->payload, "volume_id");
    if (cJSON_IsString(vol)) volume_id = vol->valuestring;

    LOGI("Snapshotting volume '%s' …", volume_id);
    /* Simulated long-running task */
    sleep(2);
    observer_notify("ops", "Backup completed successfully");
    return 0;
}

static int cmd_deploy_handler(command_t *cmd)
{
    const char *artifact = "latest";
    cJSON *art = cJSON_GetObjectItemCaseSensitive(cmd->payload, "artifact");
    if (cJSON_IsString(art)) artifact = art->valuestring;

    LOGI("Rolling out artifact '%s' …", artifact);
    sleep(1);
    observer_notify("deploy", "Deployment finished");
    return 0;
}

static int cmd_config_handler(command_t *cmd)
{
    const char *service = "generic";
    cJSON *svc = cJSON_GetObjectItemCaseSensitive(cmd->payload, "service");
    if (cJSON_IsString(svc)) service = svc->valuestring;

    LOGI("Pushing new configuration to '%s' …", service);
    observer_notify("ops", "Configuration updated");
    return 0;
}

static int cmd_metrics_handler(command_t *cmd)
{
    (void)cmd;
    LOGI("Harvesting performance metrics …");
    observer_notify("metrics", "Metrics collected");
    return 0;
}

/*-------------------------------------------------------------------------*/
/*                     Chain Handlers (Sample)                             */
/*-------------------------------------------------------------------------*/

/* Handler 1: Enforce execution window (e.g., do not deploy during night)   */
static int hdl_time_guard(command_t *cmd, void *ctx)
{
    (void)ctx;
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);

    /* Business hours between 06:00 and 22:00 */
    if (cmd->kind == CMD_ROLL_DEPLOY &&
        (tm.tm_hour < 6 || tm.tm_hour >= 22)) {
        LOGW("Deployment attempted outside business hours; rejecting");
        observer_notify("deploy", "Deployment rejected: outside window");
        return -1;          /* Abort chain */
    }
    return 0;
}

/* Handler 2: Generic executor (dispatch to command implementation)         */
static int hdl_execute(command_t *cmd, void *ctx)
{
    (void)ctx;
    if (!cmd->execute) {
        LOGE("No executor for command kind=%d", cmd->kind);
        return -1;
    }
    return cmd->execute(cmd);
}

/* Handler 3: Audit log                                                    */
static int hdl_audit_log(command_t *cmd, void *ctx)
{
    (void)ctx;
    LOGI("Audit trail: command kind=%d executed", cmd->kind);
    return 0;
}

/*-------------------------------------------------------------------------*/
/*                       Event Reading & Parsing                           */
/*-------------------------------------------------------------------------*/

static bool read_event_from_stdin(char **buf_out, size_t *len_out)
{
    char *buf = malloc(MAX_EVENT_SIZE + 1);
    if (!buf) {
        LOGE("malloc: %s", strerror(errno));
        return false;
    }

    size_t bytes = fread(buf, 1, MAX_EVENT_SIZE, stdin);
    if (ferror(stdin)) {
        LOGE("fread: %s", strerror(errno));
        free(buf);
        return false;
    }
    buf[bytes] = '\0';

    *buf_out  = buf;
    *len_out  = bytes;
    return true;
}

static bool parse_event(event_t *ev, char *raw)
{
    ev->raw_json = raw;
    ev->root     = cJSON_ParseWithLength(raw, strlen(raw));
    if (!ev->root) {
        LOGE("cJSON_Parse error: %s", cJSON_GetErrorPtr());
        return false;
    }
    return true;
}

static void destroy_event(event_t *ev)
{
    if (!ev) return;
    if (ev->root)     cJSON_Delete(ev->root);
    if (ev->raw_json) free(ev->raw_json);
}

/*-------------------------------------------------------------------------*/
/*                              MAIN                                       */
/*-------------------------------------------------------------------------*/

static volatile sig_atomic_t interrupted = 0;

static void on_sigint(int sig)
{
    (void)sig;
    interrupted = 1;
}

int main(void)
{
    /* Handle graceful termination */
    struct sigaction sa = { .sa_handler = on_sigint };
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    LOGI("LambdaUtility Worker v%s starting.", VERSION_TAG);

    /* Register default observers */
    observer_register("alerts",  slack_notify, NULL);
    observer_register("ops",     slack_notify, NULL);
    observer_register("deploy",  slack_notify, NULL);
    observer_register("metrics", slack_notify, NULL);
    observer_register("alerts",  email_notify, (void *)"oncall@example.com");

    /* Read incoming event */
    char    *raw_event = NULL;
    size_t   raw_len   = 0;
    if (!read_event_from_stdin(&raw_event, &raw_len)) {
        LOGF("Failed to read event from STDIN");
    }

    event_t ev = {0};
    if (!parse_event(&ev, raw_event)) {
        destroy_event(&ev);
        return EXIT_FAILURE;
    }

    command_t *cmd = command_factory(&ev);
    if (!cmd) {
        destroy_event(&ev);
        return EXIT_FAILURE;
    }

    /* Build processing chain */
    chain_node_t exec  = { .fn = hdl_execute };
    chain_node_t audit = { .fn = hdl_audit_log, .next = NULL };
    chain_node_t tgw   = { .fn = hdl_time_guard, .next = &exec };

    exec.next  = &audit;

    /* Dispatch */
    int rc = chain_process(&tgw, cmd);
    if (rc == 0) {
        LOGI("Command processed successfully.");
    } else {
        LOGE("Command processing failed with rc=%d", rc);
    }

    /* Cleanup */
    free(cmd);
    destroy_event(&ev);

    /* Observers flush, if needed */
    observer_notify("*", "EOF");

    LOGI("Worker exiting with code=%d", rc);
    return (rc == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}

/*---------------------------------- EOF -----------------------------------*/
