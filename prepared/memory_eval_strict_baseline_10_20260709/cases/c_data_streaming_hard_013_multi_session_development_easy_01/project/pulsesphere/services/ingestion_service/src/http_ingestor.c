```c
/**
 * PulseSphere – http_ingestor.c
 *
 * Real-time HTTP ingestion micro-service. Accepts JSON formatted “Pulse” events
 * over HTTP POST, validates the envelope, and then hands-off to the internal
 * event bus for fan-out to downstream micro-services.
 *
 * Build:
 *   cc -Wall -Wextra -pedantic -std=c11 \
 *      -o http_ingestor http_ingestor.c \
 *      -lmicrohttpd -lpthread -lcjson
 *
 * External deps:
 *   - libmicrohttpd  (HTTP server)
 *   - cJSON          (light-weight JSON parser)
 *
 * Author: PulseSphere Core Team
 * License: Apache-2.0
 */

#define _GNU_SOURCE
#include <microhttpd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
#include <pthread.h>
#include <errno.h>
#include <stdatomic.h>
#include <time.h>

#include <cjson/cJSON.h>

/* ---------------------------------------------------------------------------
 * Constants & Tunables
 * ------------------------------------------------------------------------- */
#define DEFAULT_PORT            8080
#define MAX_REQUEST_BODY_BYTES  (1024 * 64)   /* 64 KiB per payload */
#define MAX_URI_LEN             128
#define INGEST_ENDPOINT         "/ingest"
#define DAEMON_OPTIONS          (MHD_USE_SELECT_INTERNALLY | MHD_USE_SUSPEND_RESUME)

/* Thread-safe metrics ------------------------------------------------------ */
static atomic_uint_fast64_t g_ingest_ok      = 0;
static atomic_uint_fast64_t g_ingest_invalid = 0;
static atomic_uint_fast64_t g_ingest_error   = 0;

/* Exit flag, toggled by SIGINT/SIGTERM ------------------------------------ */
static volatile sig_atomic_t g_terminate = 0;

/* ---------------------------------------------------------------------------
 * Event bus interface (internal fan-out).  In production this would bridge
 * to ZeroMQ, Kafka, nanomsg, etc.  For this compilation unit we only expose
 * the public API and stub in a ring-buffer with a fixed length.
 * ------------------------------------------------------------------------- */
typedef struct
{
    char    *json;     /* owned, heap allocated */
    size_t   len;
} pulse_event_t;

#define BUS_QUEUE_LEN 8192

static pulse_event_t g_bus_queue[BUS_QUEUE_LEN];
static size_t        g_bus_head = 0;
static size_t        g_bus_tail = 0;
static pthread_mutex_t g_bus_mtx = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_bus_cv  = PTHREAD_COND_INITIALIZER;

/*
 * Publish an event into the bus queue.  Takes ownership of `evt->json`.
 * Returns 0 on success, -1 on queue full.
 */
static int
event_bus_publish(pulse_event_t *evt)
{
    int rc = 0;
    pthread_mutex_lock(&g_bus_mtx);

    size_t next = (g_bus_head + 1) % BUS_QUEUE_LEN;
    if (next == g_bus_tail)
    {
        rc = -1; /* queue full */
    }
    else
    {
        g_bus_queue[g_bus_head] = *evt; /* shallow move */
        g_bus_head = next;
        pthread_cond_signal(&g_bus_cv);
    }

    pthread_mutex_unlock(&g_bus_mtx);
    return rc;
}

/* Consumer thread – demonstrates fan-out stub. ---------------------------- */
static void *
bus_consumer_thread(void *arg)
{
    (void)arg;
    while (!g_terminate)
    {
        pthread_mutex_lock(&g_bus_mtx);
        while (g_bus_tail == g_bus_head && !g_terminate)
            pthread_cond_wait(&g_bus_cv, &g_bus_mtx);

        if (g_terminate)
        {
            pthread_mutex_unlock(&g_bus_mtx);
            break;
        }

        /* Pop */
        pulse_event_t evt = g_bus_queue[g_bus_tail];
        g_bus_tail = (g_bus_tail + 1) % BUS_QUEUE_LEN;
        pthread_mutex_unlock(&g_bus_mtx);

        /* Simulate downstream processing latency */
        fprintf(stderr, "Event dispatched downstream (%zu B)\n", evt.len);
        free(evt.json);
    }
    return NULL;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/* RFC-3339 UTC timestamp generation */
static void
utc_timestamp(char *dst, size_t len)
{
    time_t now = time(NULL);
    struct tm tm_utc;
    gmtime_r(&now, &tm_utc);
    strftime(dst, len, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}

/* JSON schema validation – lightweight, non-exhaustive. */
static int
validate_pulse_json(const cJSON *root, char *errbuf, size_t errlen)
{
    if (!cJSON_IsObject(root))
    {
        snprintf(errbuf, errlen, "Top-level JSON must be an object");
        return -1;
    }

    const cJSON *type = cJSON_GetObjectItem(root, "event_type");
    const cJSON *uid  = cJSON_GetObjectItem(root, "user_id");
    const cJSON *ts   = cJSON_GetObjectItem(root, "timestamp_ms");
    const cJSON *payload = cJSON_GetObjectItem(root, "payload");

    if (!cJSON_IsString(type) || (strlen(type->valuestring) == 0))
    {
        snprintf(errbuf, errlen, "Missing/invalid `event_type`");
        return -1;
    }
    if (!cJSON_IsString(uid) || (strlen(uid->valuestring) == 0))
    {
        snprintf(errbuf, errlen, "Missing/invalid `user_id`");
        return -1;
    }
    if (!cJSON_IsNumber(ts) || ts->valuedouble <= 0)
    {
        snprintf(errbuf, errlen, "Missing/invalid `timestamp_ms`");
        return -1;
    }
    if (!cJSON_IsObject(payload))
    {
        snprintf(errbuf, errlen, "Missing/invalid `payload` object");
        return -1;
    }
    return 0;
}

/* ---------------------------------------------------------------------------
 * HTTP request context per connection
 * ------------------------------------------------------------------------- */
typedef struct
{
    char   *body;
    size_t  size;
    size_t  capacity;
} http_client_ctx_t;

/* MHD callback – accumulate POST upload data ----------------------------- */
static int
iter_post_cb(void *coninfo_cls,
             enum MHD_ValueKind kind,
             const char *key,
             const char *filename,
             const char *content_type,
             const char *transfer_encoding,
             const char *data, uint64_t off, size_t size)
{
    (void)key; (void)filename; (void)content_type; (void)transfer_encoding;
    (void)off; (void)kind;

    http_client_ctx_t *ctx = coninfo_cls;
    if (!ctx || size == 0)
        return MHD_YES;

    if (ctx->size + size > MAX_REQUEST_BODY_BYTES)
        return MHD_NO; /* Exceeds policy */

    if (ctx->size + size > ctx->capacity)
    {
        size_t newcap = ctx->capacity * 2;
        while (newcap < ctx->size + size)
            newcap *= 2;
        char *tmp = realloc(ctx->body, newcap);
        if (!tmp)
            return MHD_NO;
        ctx->body = tmp;
        ctx->capacity = newcap;
    }
    memcpy(ctx->body + ctx->size, data, size);
    ctx->size += size;
    return MHD_YES;
}

/* Utility: create an HTTP response with plain-text payload ---------------- */
static struct MHD_Response *
make_plain_response(unsigned int codigo, const char *text)
{
    return MHD_create_response_from_buffer(strlen(text),
                                           (void *)text,
                                           MHD_RESPMEM_MUST_COPY);
}

/* Central handler --------------------------------------------------------- */
static int
handle_request(void *cls,
               struct MHD_Connection *connection,
               const char *url,
               const char *method,
               const char *version,
               const char *upload_data,
               size_t *upload_data_size,
               void **con_cls)
{
    (void)cls; (void)version;

    /* New connection: allocate per-client context */
    if (*con_cls == NULL)
    {
        http_client_ctx_t *ctx = calloc(1, sizeof(*ctx));
        if (!ctx)
            return MHD_NO;

        ctx->capacity = 4096;
        ctx->body = malloc(ctx->capacity);
        if (!ctx->body)
        {
            free(ctx);
            return MHD_NO;
        }
        *con_cls = ctx;
        return MHD_YES;
    }

    http_client_ctx_t *ctx = *con_cls;

    /* Only accept POST /ingest */
    if (strcmp(method, "POST") != 0 || strncmp(url, INGEST_ENDPOINT, MAX_URI_LEN) != 0)
    {
        struct MHD_Response *res = make_plain_response(MHD_HTTP_NOT_FOUND,
                                                      "Endpoint not found");
        int ret = MHD_queue_response(connection, MHD_HTTP_NOT_FOUND, res);
        MHD_destroy_response(res);
        return ret;
    }

    if (*upload_data_size != 0)
    {
        /* Called multiple times to stream POST body */
        int rc = iter_post_cb(ctx, MHD_POSTDATA_KIND, NULL, NULL, NULL, NULL,
                              upload_data, 0, *upload_data_size);
        if (rc == MHD_NO)
            return MHD_NO;
        *upload_data_size = 0; /* signal that we’ve consumed this chunk */
        return MHD_YES;
    }

    /* All data received: process */
    ctx->body[ctx->size] = '\0'; /* ensure null terminated */

    char errbuf[128] = {0};
    cJSON *root = cJSON_Parse(ctx->body);
    if (!root || validate_pulse_json(root, errbuf, sizeof(errbuf)) != 0)
    {
        cJSON_Delete(root);
        atomic_fetch_add(&g_ingest_invalid, 1);

        struct MHD_Response *res = make_plain_response(MHD_HTTP_BAD_REQUEST,
                                                       errbuf[0] ? errbuf
                                                                 : "Malformed JSON");
        int ret = MHD_queue_response(connection, MHD_HTTP_BAD_REQUEST, res);
        MHD_destroy_response(res);
        return ret;
    }

    /* Copy JSON to heap for bus ownership */
    pulse_event_t evt = {
        .json = strndup(ctx->body, ctx->size),
        .len  = ctx->size
    };

    if (event_bus_publish(&evt) != 0)
    {
        free(evt.json);
        atomic_fetch_add(&g_ingest_error, 1);

        struct MHD_Response *res = make_plain_response(MHD_HTTP_SERVICE_UNAVAILABLE,
                                                       "Back-pressure – try again later");
        int ret = MHD_queue_response(connection, MHD_HTTP_SERVICE_UNAVAILABLE, res);
        MHD_destroy_response(res);
        return ret;
    }

    atomic_fetch_add(&g_ingest_ok, 1);

    /* Respond 202 Accepted with timestamp */
    char ts[32]; utc_timestamp(ts, sizeof(ts));
    char ack[64];
    snprintf(ack, sizeof(ack), "Accepted @ %s\n", ts);

    struct MHD_Response *res = make_plain_response(MHD_HTTP_ACCEPTED, ack);
    int ret = MHD_queue_response(connection, MHD_HTTP_ACCEPTED, res);
    MHD_destroy_response(res);
    cJSON_Delete(root);
    return ret;
}

/* Cleanup callback when connection closed -------------------------------- */
static void
request_completed_cb(void *cls, struct MHD_Connection *connection,
                     void **con_cls, enum MHD_RequestTerminationCode toe)
{
    (void)cls; (void)connection; (void)toe;
    http_client_ctx_t *ctx = *con_cls;
    if (ctx)
    {
        free(ctx->body);
        free(ctx);
        *con_cls = NULL;
    }
}

/* ---------------------------------------------------------------------------
 * Signal handling
 * ------------------------------------------------------------------------- */
static void
signal_handler(int signo)
{
    (void)signo;
    g_terminate = 1;
}

/* ---------------------------------------------------------------------------
 * Metrics reporter thread (stdout)
 * ------------------------------------------------------------------------- */
static void *
metrics_thread(void *arg)
{
    (void)arg;
    while (!g_terminate)
    {
        uint64_t ok   = atomic_load(&g_ingest_ok);
        uint64_t inv  = atomic_load(&g_ingest_invalid);
        uint64_t err  = atomic_load(&g_ingest_error);

        fprintf(stdout,
                "[Metrics] OK=%" PRIu64 " INVALID=%" PRIu64 " ERROR=%" PRIu64 "\n",
                ok, inv, err);

        for (int i = 0; i < 5 && !g_terminate; ++i)
            sleep(1);
    }
    return NULL;
}

/* ---------------------------------------------------------------------------
 * main()
 * ------------------------------------------------------------------------- */
int
main(int argc, char *argv[])
{
    uint16_t port = DEFAULT_PORT;
    if (argc == 2)
    {
        long p = strtol(argv[1], NULL, 10);
        if (p <= 0 || p > 65535)
        {
            fprintf(stderr, "Invalid port: %s\n", argv[1]);
            return EXIT_FAILURE;
        }
        port = (uint16_t)p;
    }

    struct sigaction sa = { .sa_handler = signal_handler };
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    struct MHD_Daemon *daemon = MHD_start_daemon(
            DAEMON_OPTIONS,
            port,
            NULL, NULL, /* accept policy callback */
            &handle_request, NULL,
            MHD_OPTION_CONNECTION_MEMORY_LIMIT, MAX_REQUEST_BODY_BYTES,
            MHD_OPTION_NOTIFY_COMPLETED, request_completed_cb, NULL,
            MHD_OPTION_END);
    if (!daemon)
    {
        perror("MHD_start_daemon");
        return EXIT_FAILURE;
    }

    /* Spawn consumer & metrics threads */
    pthread_t th_consumer, th_metrics;
    pthread_create(&th_consumer, NULL, bus_consumer_thread, NULL);
    pthread_create(&th_metrics,  NULL, metrics_thread, NULL);

    fprintf(stdout, "HTTP Ingestor listening on port %u\n", port);

    /* Block until shutdown signal */
    while (!g_terminate)
        sleep(1);

    fprintf(stdout, "Shutting down …\n");

    MHD_stop_daemon(daemon);

    pthread_cond_broadcast(&g_bus_cv);
    pthread_join(th_consumer, NULL);
    pthread_join(th_metrics, NULL);

    /* Drain remaining queue */
    pthread_mutex_lock(&g_bus_mtx);
    while (g_bus_tail != g_bus_head)
    {
        pulse_event_t evt = g_bus_queue[g_bus_tail];
        g_bus_tail = (g_bus_tail + 1) % BUS_QUEUE_LEN;
        free(evt.json);
    }
    pthread_mutex_unlock(&g_bus_mtx);

    pthread_mutex_destroy(&g_bus_mtx);
    pthread_cond_destroy(&g_bus_cv);

    fprintf(stdout, "Bye.\n");
    return EXIT_SUCCESS;
}
```