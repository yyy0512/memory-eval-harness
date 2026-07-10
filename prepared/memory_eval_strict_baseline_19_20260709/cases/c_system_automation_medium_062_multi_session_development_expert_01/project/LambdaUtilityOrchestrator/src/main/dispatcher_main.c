```c
/**
 *  LambdaUtility Orchestrator
 *  File: dispatcher_main.c
 *
 *  Entrypoint for the “event-dispatcher” Lambda function.  The dispatcher
 *  receives the raw JSON event payload from the Lambda runtime (on STDIN
 *  when executed locally, or via the Runtime API in production), converts it
 *  into domain objects, maps each event to a concrete Command, pushes the
 *  Command through a Chain-of-Responsibility pipeline, and finally fans‐out
 *  status notifications to all registered Observers (Slack, e-mail, etc.).
 *
 *  This module purposefully has zero automation-specific logic; those live
 *  in dedicated Command objects elsewhere in the tree.  Its single job is
 *  orchestration.
 *
 *  Build dependencies:
 *      - cJSON (BSD licensed, https://github.com/DaveGamble/cJSON)
 *
 *  Compile example:
 *      cc -std=c11 -Wall -Wextra -pedantic -lcjson -o dispatcher_main \
 *          dispatcher_main.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#include <errno.h>

#include <cjson/cJSON.h>     /* 3rd-party, lightweight JSON parser */

/* ------------------------------------------------------------------------- */
/*  Domain types                                                             */
/* ------------------------------------------------------------------------- */

#define MAX_ID_LEN         64
#define MAX_TYPE_LEN       48
#define MAX_PAYLOAD_LEN  2048
#define MAX_ERR_STR_LEN   256

typedef struct
{
    char id[MAX_ID_LEN];
    char type[MAX_TYPE_LEN];         /* e.g. "backup_recovery"            */
    char payload[MAX_PAYLOAD_LEN];
} luo_event_t;

/* ------------------------------------------------------------------------- */
/*  Command Pattern                                                          */
/* ------------------------------------------------------------------------- */

typedef struct luo_command_s luo_command_t;

typedef int (*luo_command_exec_fn)(const luo_event_t *event,
                                   char                errbuf[MAX_ERR_STR_LEN]);

struct luo_command_s
{
    const char           *name;      /* logical name / key                */
    luo_command_exec_fn   execute;   /* implementation                    */
};

/* Forward declarations for built-in commands */
static int cmd_config_push  (const luo_event_t *, char errbuf[MAX_ERR_STR_LEN]);
static int cmd_backup_volume(const luo_event_t *, char errbuf[MAX_ERR_STR_LEN]);

static const luo_command_t g_command_registry[] =
{
    { "configuration_management", cmd_config_push   },
    { "backup_recovery",           cmd_backup_volume},
    { NULL,                        NULL             }   /* sentinel       */
};

/* ------------------------------------------------------------------------- */
/*  Observer Pattern                                                         */
/* ------------------------------------------------------------------------- */

typedef void (*luo_observer_fn)(const luo_event_t  *event,
                                const luo_command_t*cmd,
                                int                 status,
                                const char          *errstr);

static void obs_slack_notifier (const luo_event_t *, const luo_command_t*,
                                int, const char *);
static void obs_email_notifier (const luo_event_t *, const luo_command_t*,
                                int, const char *);
static void obs_log_audit_trail(const luo_event_t *, const luo_command_t*,
                                int, const char *);

static luo_observer_fn g_observers[] =
{
    obs_log_audit_trail,
    obs_slack_notifier,
    obs_email_notifier,
    NULL
};

/* ------------------------------------------------------------------------- */
/*  Chain-of-Responsibility                                                  */
/* ------------------------------------------------------------------------- */

typedef struct luo_dispatch_ctx_s
{
    const luo_event_t    *event;
    const luo_command_t  *command;
    int                   status;    /* 0 = OK, non-zero = failure        */
    char                  errbuf[MAX_ERR_STR_LEN];
} luo_dispatch_ctx_t;

typedef int (*luo_handler_fn)(luo_dispatch_ctx_t *);

typedef struct handler_node_s
{
    const char            *name;
    luo_handler_fn         fn;
    struct handler_node_s *next;
} handler_node_t;

/* Individual handlers */
static int hdl_validate_event(luo_dispatch_ctx_t *);
static int hdl_resolve_command(luo_dispatch_ctx_t *);
static int hdl_execute_command(luo_dispatch_ctx_t *);
static int hdl_metrics_sample(luo_dispatch_ctx_t *);

/* Static chain definition */
static handler_node_t g_handler_chain[] =
{
    { "validate_event",  hdl_validate_event,  &g_handler_chain[1] },
    { "resolve_command", hdl_resolve_command, &g_handler_chain[2] },
    { "execute_command", hdl_execute_command, &g_handler_chain[3] },
    { "metrics_sample",  hdl_metrics_sample,  NULL                }
};

/* ------------------------------------------------------------------------- */
/*  Utilities                                                                */
/* ------------------------------------------------------------------------- */

/* Read entire STDIN into malloc()’d buffer */
static char *slurp_stdin(size_t *out_len)
{
    const size_t  chunk = 1024;
    size_t        cap = chunk;
    size_t        len = 0;

    char *buf = malloc(cap);
    if (!buf) return NULL;

    int c;
    while ((c = getchar()) != EOF)
    {
        buf[len++] = (char)c;
        if (len == cap)
        {
            cap += chunk;
            char *tmp = realloc(buf, cap);
            if (!tmp)
            {
                free(buf);
                return NULL;
            }
            buf = tmp;
        }
    }
    buf[len] = '\0';
    if (out_len) *out_len = len;
    return buf;
}

/* Convert ISO-8601 timestamp */
static void iso_timestamp(char out[32])
{
    time_t     now = time(NULL);
    struct tm  tm;
    gmtime_r(&now, &tm);
    strftime(out, 32, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/* Simple signal handler to allow graceful shutdown */
static volatile sig_atomic_t g_sigint = 0;
static void sig_handler(int signo)
{
    (void)signo;
    g_sigint = 1;
}

/* ------------------------------------------------------------------------- */
/*  JSON ↔︎ event conversions                                                */
/* ------------------------------------------------------------------------- */

static int json_to_event(const char *json, luo_event_t *out_event,
                         char errbuf[MAX_ERR_STR_LEN])
{
    cJSON *root = cJSON_Parse(json);
    if (!root)
    {
        snprintf(errbuf, MAX_ERR_STR_LEN, "JSON parse error");
        return -1;
    }

    const cJSON *id  = cJSON_GetObjectItemCaseSensitive(root, "id");
    const cJSON *typ = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *pld = cJSON_GetObjectItemCaseSensitive(root, "payload");

    if (!cJSON_IsString(id) || !cJSON_IsString(typ) || !cJSON_IsString(pld))
    {
        snprintf(errbuf, MAX_ERR_STR_LEN, "Missing/invalid fields in event");
        cJSON_Delete(root);
        return -1;
    }

    strncpy(out_event->id,      id->valuestring,  MAX_ID_LEN    - 1);
    strncpy(out_event->type,    typ->valuestring, MAX_TYPE_LEN  - 1);
    strncpy(out_event->payload, pld->valuestring, MAX_PAYLOAD_LEN - 1);

    cJSON_Delete(root);
    return 0;
}

/* ------------------------------------------------------------------------- */
/*  Command implementations                                                  */
/* ------------------------------------------------------------------------- */

static int cmd_config_push(const luo_event_t *event, char errbuf[MAX_ERR_STR_LEN])
{
    printf("[config_push] Pushing new configuration… (event %s)\n", event->id);

    /* TODO: call out to etcd/consul, validate config, push to servers */
    (void)event; /* placeholder to avoid warning when TODO is removed */

    /* Simulate success */
    return 0;
}

static int cmd_backup_volume(const luo_event_t *event, char errbuf[MAX_ERR_STR_LEN])
{
    printf("[backup_volume] Taking snapshot… (event %s)\n", event->id);

    /* TODO: Snapshot EBS volume, verify integrity, rotate retention */

    /* Simulate random failure to show error propagation */
    if (time(NULL) % 2)
    {
        snprintf(errbuf, MAX_ERR_STR_LEN, "Snapshot timeout exceeded");
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------------- */
/*  Handlers                                                                 */
/* ------------------------------------------------------------------------- */

static int hdl_validate_event(luo_dispatch_ctx_t *ctx)
{
    if (!ctx || !ctx->event)
    {
        snprintf(ctx->errbuf, MAX_ERR_STR_LEN, "Null event in context");
        return -1;
    }

    if (ctx->event->id[0] == '\0' || ctx->event->type[0] == '\0')
    {
        snprintf(ctx->errbuf, MAX_ERR_STR_LEN, "Event validation failed");
        return -1;
    }
    return 0;
}

static const luo_command_t *lookup_command(const char *type)
{
    for (size_t i = 0; g_command_registry[i].name; ++i)
        if (strcmp(type, g_command_registry[i].name) == 0)
            return &g_command_registry[i];
    return NULL;
}

static int hdl_resolve_command(luo_dispatch_ctx_t *ctx)
{
    ctx->command = lookup_command(ctx->event->type);
    if (!ctx->command)
    {
        snprintf(ctx->errbuf, MAX_ERR_STR_LEN, "No command mapped for type '%s'",
                 ctx->event->type);
        return -1;
    }
    return 0;
}

static int hdl_execute_command(luo_dispatch_ctx_t *ctx)
{
    if (!ctx->command || !ctx->command->execute)
    {
        snprintf(ctx->errbuf, MAX_ERR_STR_LEN, "Invalid command binding");
        return -1;
    }

    int rc = ctx->command->execute(ctx->event, ctx->errbuf);
    ctx->status = rc;
    return rc;
}

static int hdl_metrics_sample(luo_dispatch_ctx_t *ctx)
{
    /* collect basic latency & success metrics */
    char ts[32]; iso_timestamp(ts);
    printf("[metrics] timestamp=%s, event=%s, status=%d\n",
           ts, ctx->event->id, ctx->status);
    return 0;   /* never fail the chain */
}

/* ------------------------------------------------------------------------- */
/*  Observer implementations                                                 */
/* ------------------------------------------------------------------------- */

static void obs_log_audit_trail(const luo_event_t *ev, const luo_command_t *cmd,
                                int status, const char *errstr)
{
    char ts[32]; iso_timestamp(ts);
    printf("[audit] ts=%s, id=%s, type=%s, cmd=%s, rc=%d%s%s\n",
           ts, ev->id, ev->type, cmd ? cmd->name : "-", status,
           errstr && *errstr ? ", err=" : "",
           errstr && *errstr ? errstr : "");
}

static void obs_slack_notifier(const luo_event_t *ev, const luo_command_t *cmd,
                               int status, const char *errstr)
{
    /* In prod we’d POST to Slack Webhook; here we just log */
    printf("[slack] %s: command *%s* %s for event %s%s%s\n",
           status == 0 ? "✅ SUCCESS" : "❌ FAILED",
           cmd ? cmd->name : "(none)",
           status == 0 ? "completed" : "failed",
           ev->id,
           errstr && *errstr ? " – " : "",
           errstr && *errstr ? errstr : "");
}

static void obs_email_notifier(const luo_event_t *ev, const luo_command_t *cmd,
                               int status, const char *errstr)
{
    if (status == 0) return; /* only e-mail on failure */
    printf("[email] Alert: command %s failed for event %s – %s\n",
           cmd ? cmd->name : "(none)", ev->id, errstr ? errstr : "(n/a)");
}

/* ------------------------------------------------------------------------- */
/*  Dispatcher                                                               */
/* ------------------------------------------------------------------------- */

static void notify_observers(const luo_dispatch_ctx_t *ctx)
{
    for (size_t i = 0; g_observers[i]; ++i)
        g_observers[i](ctx->event, ctx->command, ctx->status, ctx->errbuf);
}

static int run_chain(luo_dispatch_ctx_t *ctx)
{
    handler_node_t *node = &g_handler_chain[0];
    while (node)
    {
        int rc = node->fn(ctx);
        if (rc != 0)
        {
            fprintf(stderr, "[chain] Handler '%s' aborted with rc=%d (%s)\n",
                    node->name, rc, ctx->errbuf);
            return rc;
        }
        node = node->next;
        if (g_sigint)
        {
            snprintf(ctx->errbuf, MAX_ERR_STR_LEN, "Interrupted by SIGINT");
            return -1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------------- */
/*  Main                                                                     */
/* ------------------------------------------------------------------------- */

int main(void)
{
    /* Handle ^C locally to gracefully stop long-running executions */
    struct sigaction sa = { .sa_handler = sig_handler };
    sigaction(SIGINT, &sa, NULL);

    /* 1. Read raw JSON event */
    size_t    json_len = 0;
    char     *json_raw = slurp_stdin(&json_len);
    if (!json_raw)
    {
        fprintf(stderr, "Unable to read event from STDIN: %s\n",
                strerror(errno));
        return EXIT_FAILURE;
    }
    if (json_len == 0)
    {
        fprintf(stderr, "Empty event received; aborting.\n");
        free(json_raw);
        return EXIT_FAILURE;
    }

    /* 2. Parse → domain event */
    luo_event_t event = {0};
    char        errbuf[MAX_ERR_STR_LEN] = {0};

    if (json_to_event(json_raw, &event, errbuf) != 0)
    {
        fprintf(stderr, "Invalid event: %s\n", errbuf);
        free(json_raw);
        return EXIT_FAILURE;
    }
    free(json_raw);

    /* 3. Dispatch through handler chain */
    luo_dispatch_ctx_t ctx =
    {
        .event   = &event,
        .command = NULL,
        .status  = 0
    };

    int rc = run_chain(&ctx);

    /* 4. Fan-out observers regardless of success/failure */
    notify_observers(&ctx);

    /* 5. Return Lambda-compatible exit code */
    return rc == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
```