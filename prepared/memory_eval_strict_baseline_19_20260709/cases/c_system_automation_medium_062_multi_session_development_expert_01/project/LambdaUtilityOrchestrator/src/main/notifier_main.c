/**
 * File: notifier_main.c
 * Project: LambdaUtility Orchestrator (system_automation)
 *
 * Description:
 *  Stand-alone “notifier” Lambda responsible for consuming an incoming event
 *  (supplied as JSON on STDIN by the custom AWS Lambda runtime) and fanning-out
 *  the payload to one or more downstream channels (Slack, e-mail, SMS, etc.)
 *  using an Observer pipeline.  The Lambda is fully stateless—configuration is
 *  provided exclusively via environment variables—which makes the binary
 *  suitable for re-use across multiple stages (dev/qa/prod) without rebuilds.
 *
 *  Architectural patterns applied:
 *      • Observer Pattern – Each concrete notifier registers itself with the
 *        dispatcher and is invoked in order of registration.
 *      • Command Pattern – The incoming event is converted into a domain
 *        command (struct Notification) that decouples producers from
 *        consumers.
 *
 *  Build (example):
 *      cc -O2 -Wall -Wextra -Werror -lcurl -lcjson -o notifier_main notifier_main.c
 *
 *  Runtime expectations:
 *      • Event arrives on STDIN as JSON:
 *          {
 *            "title"    : "Disk usage alert",
 *            "body"     : "/var is 94% full on host prod-web-13",
 *            "severity" : "CRITICAL",
 *            "channels" : ["slack", "email"]          // optional filter
 *          }
 *
 *      • Environment variables:
 *          SLACK_WEBHOOK_URL   – Incoming Webhook URL
 *          EMAIL_RELAY_HOST    – Hostname:port of SMTP server
 *          EMAIL_FROM          – Sender e-mail
 *          EMAIL_TO            – Comma-separated recipients
 *          TWILIO_ACCOUNT_SID  – Twilio SID (if SMS desired)
 *          TWILIO_AUTH_TOKEN   – Twilio token
 *          TWILIO_FROM_NUMBER  – From phone number
 *          TWILIO_TO_NUMBER    – To phone number
 *
 *  NOTE:
 *      – To keep the example self-contained, only Slack is fully implemented.
 *        The other observers are provided as skeletons illustrating extension
 *        points.
 *      – Robust error handling is included; any failure causes a non-zero exit
 *        status so that the Lambda runtime marks the invocation as failed.
 */

#define _POSIX_C_SOURCE 200809L /* for getline(3) */

#include <assert.h>
#include <curl/curl.h>
#include <cjson/cJSON.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

/* Simplified logger – logs to stderr with ISO-8601 timestamps. */
static void log_msg(const char *level, const char *fmt, ...)
{
    time_t     now      = time(NULL);
    struct tm  tm_now;
    char       ts[32];

    gmtime_r(&now, &tm_now);
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", &tm_now);

    fprintf(stderr, "[%s] %s ", ts, level);

    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);

    fputc('\n', stderr);
}

/* Secure getenv wrapper that logs when value is missing. */
static const char *must_getenv(const char *key, int optional)
{
    const char *val = getenv(key);
    if (!val || !*val) {
        if (optional) return NULL;
        log_msg("ERROR", "Required environment variable '%s' is not set.", key);
        exit(EXIT_FAILURE);
    }
    return val;
}

/* -------------------------------------------------------------------------- */
/* Domain model                                                               */
/* -------------------------------------------------------------------------- */

typedef struct Notification {
    char *title;
    char *body;
    char *severity;
    /* Dynamically allocated NULL-terminated list of channel filters, or NULL. */
    char **channels;
} Notification;

/* Forward declarations of concrete notifier handlers */
static int slack_notify (const Notification *note, void *ctx);
static int email_notify (const Notification *note, void *ctx);
static int sms_notify   (const Notification *note, void *ctx);

/* Observer Pattern – generic callback */
typedef int (*notify_fn)(const Notification *, void *ctx);

typedef struct Observer {
    notify_fn          fn;
    void              *ctx;    /* channel-specific state (e.g., auth token) */
    const char        *name;   /* friendly name for logging                */
    struct Observer   *next;
} Observer;

static Observer *observer_head = NULL;

/* Registers an observer; returns 0 on success, -1 on error */
static int observer_register(notify_fn fn, void *ctx, const char *name)
{
    Observer *node = calloc(1, sizeof *node);
    if (!node) {
        log_msg("ERROR", "calloc: %s", strerror(errno));
        return -1;
    }
    node->fn   = fn;
    node->ctx  = ctx;
    node->name = name;
    node->next = observer_head;
    observer_head = node;
    return 0;
}

/* Dispatches the notification to all observers, short-circuiting on error. */
static int observer_dispatch(const Notification *note)
{
    for (Observer *ob = observer_head; ob; ob = ob->next) {
        if (note->channels) {
            /* If channels filter is present, skip observers not listed. */
            int match = 0;
            for (char **c = note->channels; *c; ++c) {
                if (strcasecmp(*c, ob->name) == 0) {
                    match = 1; break;
                }
            }
            if (!match) continue;
        }

        log_msg("INFO", "Dispatching to observer '%s'...", ob->name);
        if (ob->fn(note, ob->ctx) != 0) {
            log_msg("ERROR", "Observer '%s' failed. Aborting pipeline.", ob->name);
            return -1;
        }
    }
    return 0;
}

/* -------------------------------------------------------------------------- */
/* Slack notifier                                                             */
/* -------------------------------------------------------------------------- */

typedef struct {
    CURL       *curl;
    char       *webhook_url;
} SlackCtx;

static int slack_notify(const Notification *note, void *ctx_)
{
    SlackCtx *ctx = ctx_;
    assert(ctx && ctx->curl && ctx->webhook_url);

    /* Build JSON payload expected by Slack Incoming Webhook */
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "text", note->body ? note->body : "");
    cJSON_AddStringToObject(root, "username", "LambdaUtility Bot");

    /* Attachments with title & severity color */
    cJSON *attachments = cJSON_AddArrayToObject(root, "attachments");
    cJSON *attach      = cJSON_CreateObject();
    cJSON_AddItemToArray(attachments, attach);
    cJSON_AddStringToObject(attach, "title", note->title ? note->title : "Notification");

    const char *color = "#36a64f"; /* default – green */
    if (note->severity) {
        if      (strcasecmp(note->severity, "CRITICAL") == 0) color = "#d00000";
        else if (strcasecmp(note->severity, "WARNING")  == 0) color = "#e6b800";
    }
    cJSON_AddStringToObject(attach, "color", color);

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) {
        log_msg("ERROR", "Failed to serialize Slack payload.");
        return -1;
    }

    curl_easy_reset(ctx->curl);
    curl_easy_setopt(ctx->curl, CURLOPT_URL, ctx->webhook_url);
    curl_easy_setopt(ctx->curl, CURLOPT_POST, 1L);
    curl_easy_setopt(ctx->curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(ctx->curl, CURLOPT_POSTFIELDSIZE, (long)strlen(payload));
    curl_easy_setopt(ctx->curl, CURLOPT_WRITEFUNCTION, NULL);  /* ignore body */
    curl_easy_setopt(ctx->curl, CURLOPT_TIMEOUT, 10L);

    struct curl_slist *hdrs = NULL;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    curl_easy_setopt(ctx->curl, CURLOPT_HTTPHEADER, hdrs);

    CURLcode res = curl_easy_perform(ctx->curl);
    curl_slist_free_all(hdrs);
    free(payload);

    if (res != CURLE_OK) {
        log_msg("ERROR", "Slack notification failed: %s", curl_easy_strerror(res));
        return -1;
    }
    return 0;
}

/* -------------------------------------------------------------------------- */
/* E-mail notifier (skeleton)                                                 */
/* -------------------------------------------------------------------------- */

typedef struct {
    const char *relay_host;
    const char *from;
    const char *to;
} EmailCtx;

static int email_notify(const Notification *note, void *ctx_)
{
    (void)ctx_;
    /* TODO: Implement SMTP send via libcurl or libesmtp. */
    log_msg("WARN", "E-mail notifier is not yet implemented – dropping message '%s'.",
            note->title ? note->title : "(no-title)");
    return 0; /* Swallow to allow other observers to proceed. */
}

/* -------------------------------------------------------------------------- */
/* SMS notifier (skeleton)                                                    */
/* -------------------------------------------------------------------------- */

typedef struct {
    const char *sid;
    const char *token;
    const char *from;
    const char *to;
} SmsCtx;

static int sms_notify(const Notification *note, void *ctx_)
{
    (void)note; (void)ctx_;
    /* TODO: Implement Twilio REST API call. */
    log_msg("WARN", "SMS notifier is not yet implemented.");
    return 0;
}

/* -------------------------------------------------------------------------- */
/* JSON event parsing                                                         */
/* -------------------------------------------------------------------------- */

/* Allocates and returns Notification*, caller must free with free_notification */
static Notification *parse_event_json(const char *buf)
{
    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        log_msg("ERROR", "Invalid JSON event: %s", cJSON_GetErrorPtr());
        return NULL;
    }

    Notification *note = calloc(1, sizeof *note);
    if (!note) {
        log_msg("ERROR", "calloc: %s", strerror(errno));
        cJSON_Delete(root);
        return NULL;
    }

    cJSON *title    = cJSON_GetObjectItemCaseSensitive(root, "title");
    cJSON *body     = cJSON_GetObjectItemCaseSensitive(root, "body");
    cJSON *severity = cJSON_GetObjectItemCaseSensitive(root, "severity");
    cJSON *channels = cJSON_GetObjectItemCaseSensitive(root, "channels");

    if (cJSON_IsString(title) && title->valuestring)
        note->title = strdup(title->valuestring);
    if (cJSON_IsString(body) && body->valuestring)
        note->body  = strdup(body->valuestring);
    if (cJSON_IsString(severity) && severity->valuestring)
        note->severity = strdup(severity->valuestring);

    if (cJSON_IsArray(channels)) {
        int len = cJSON_GetArraySize(channels);
        note->channels = calloc(len + 1, sizeof(char*)); /* NULL-terminated */
        if (!note->channels) {
            log_msg("ERROR", "calloc: %s", strerror(errno));
            cJSON_Delete(root);
            free(note);
            return NULL;
        }
        for (int i = 0; i < len; ++i) {
            cJSON *ch = cJSON_GetArrayItem(channels, i);
            if (cJSON_IsString(ch) && ch->valuestring)
                note->channels[i] = strdup(ch->valuestring);
        }
    }

    cJSON_Delete(root);
    return note;
}

static void free_notification(Notification *note)
{
    if (!note) return;
    free(note->title);
    free(note->body);
    free(note->severity);

    if (note->channels) {
        for (char **c = note->channels; *c; ++c) free(*c);
        free(note->channels);
    }
    free(note);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                      */
/* -------------------------------------------------------------------------- */

int main(void)
{
    /* 1. Read entire JSON event from STDIN. */
    char  *buf   = NULL;
    size_t n     = 0;
    size_t total = 0;

    for (;;) {
        ssize_t r = getline(&buf, &n, stdin); /* reads until newline or EOF */
        if (r == -1) break;
        total += (size_t)r;
    }
    if (ferror(stdin)) {
        log_msg("ERROR", "Failed to read STDIN: %s", strerror(errno));
        free(buf);
        return EXIT_FAILURE;
    }
    if (total == 0) {
        log_msg("ERROR", "No data received on STDIN.");
        free(buf);
        return EXIT_FAILURE;
    }

    /* 2. Parse event JSON into domain command. */
    Notification *note = parse_event_json(buf);
    free(buf);  /* no longer needed */
    if (!note) return EXIT_FAILURE;

    /* 3. Initialize libcurl global state once per process life-time. */
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != 0) {
        log_msg("ERROR", "curl_global_init failed.");
        free_notification(note);
        return EXIT_FAILURE;
    }

    /* 4. Register observers based on environment & compile time. */
    const char *slack_url = must_getenv("SLACK_WEBHOOK_URL", 1);
    if (slack_url) {
        SlackCtx *sctx = calloc(1, sizeof *sctx);
        sctx->curl        = curl_easy_init();
        sctx->webhook_url = strdup(slack_url);
        observer_register(slack_notify, sctx, "slack");
    }

    const char *smtp_host = must_getenv("EMAIL_RELAY_HOST", 1);
    if (smtp_host) {
        EmailCtx *ectx  = calloc(1, sizeof *ectx);
        ectx->relay_host = smtp_host;
        ectx->from       = must_getenv("EMAIL_FROM", 1);
        ectx->to         = must_getenv("EMAIL_TO",   1);
        observer_register(email_notify, ectx, "email");
    }

    const char *twilio_sid = must_getenv("TWILIO_ACCOUNT_SID", 1);
    if (twilio_sid) {
        SmsCtx *sc = calloc(1, sizeof *sc);
        sc->sid   = twilio_sid;
        sc->token = must_getenv("TWILIO_AUTH_TOKEN", 1);
        sc->from  = must_getenv("TWILIO_FROM_NUMBER", 1);
        sc->to    = must_getenv("TWILIO_TO_NUMBER",   1);
        observer_register(sms_notify, sc, "sms");
    }

    if (!observer_head) {
        log_msg("WARN", "No observers registered – nothing to do.");
        free_notification(note);
        curl_global_cleanup();
        return EXIT_SUCCESS;
    }

    /* 5. Fan-out the notification. */
    int rc = observer_dispatch(note);

    /* 6. Cleanup. */
    for (Observer *ob = observer_head; ob;) {
        Observer *next = ob->next;
        if (ob->ctx) {
            if (ob->fn == slack_notify) {
                SlackCtx *sctx = ob->ctx;
                if (sctx->curl) curl_easy_cleanup(sctx->curl);
                free(sctx->webhook_url);
                free(sctx);
            } else {
                free(ob->ctx);
            }
        }
        free(ob);
        ob = next;
    }
    free_notification(note);
    curl_global_cleanup();

    if (rc != 0) {
        log_msg("ERROR", "One or more observers reported failure.");
        return EXIT_FAILURE;
    }
    log_msg("INFO", "Notification pipeline completed successfully.");
    return EXIT_SUCCESS;
}