/*
 * websocket_ingestor.c
 *
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * Ingestion Service – WebSocket Ingestor
 *
 * This component establishes outbound WebSocket connections
 * to various social-network gateways, receives raw pulse
 * events, validates and enriches them, and publishes the
 * results onto the internal event fabric.
 *
 * Dependency list (pkg-config):
 *   libwebsockets  (WebSocket client implementation)
 *   cjson          (Lightweight JSON parser)
 *
 * Build example:
 *   cc -O2 -Wall -Wextra -pedantic -std=c11 \
 *      websocket_ingestor.c -o websocket_ingestor \
 *      `pkg-config --cflags --libs libwebsockets cjson` -lpthread
 */

#include <libwebsockets.h>
#include <cjson/cJSON.h>

#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/*---------------------------------------------------------------------------
 * Compile-time configuration
 *-------------------------------------------------------------------------*/
#define MAX_ENDPOINTS         8        /* Maximum concurrently dialed feeds */
#define DEFAULT_RECONNECT_MS  5000     /* Back-off when connection drops   */
#define PING_INTERVAL_SEC     30
#define RX_BUFFER_BYTES       1 << 16  /* 64 KB per connection             */
#define EVENT_BUS_TOPIC       "pulses.raw"

/*---------------------------------------------------------------------------
 * Data structures
 *-------------------------------------------------------------------------*/

/* Forward declarations */
struct ps_ws_endpoint;

/* A single WebSocket connection instance */
typedef struct ps_ws_peer {
    struct lws        *wsi;            /* lws connection instance       */
    struct ps_ws_endpoint *cfg;        /* pointer to static config      */
    bool               established;    /* true once handshake completes */
    uint64_t           rx_cnt;         /* received frames counter       */
} ps_ws_peer_t;

/* Immutable endpoint configuration */
typedef struct ps_ws_endpoint {
    char     url[256];                 /* wss://example.com/ws feed     */
    char     subprotocol[64];          /* e.g. "json" or ""             */
    bool     secure;                   /* SSL/TLS                       */
} ps_ws_endpoint_t;

/* Process-wide context */
typedef struct ps_ws_app_ctx {
    struct lws_context   *lws_ctx;
    ps_ws_endpoint_t      endpoints[MAX_ENDPOINTS];
    size_t                endpoint_cnt;
    pthread_t             event_loop_thread;
    volatile sig_atomic_t shutting_down;
} ps_ws_app_ctx_t;

/*---------------------------------------------------------------------------
 * Global state
 *-------------------------------------------------------------------------*/
static ps_ws_app_ctx_t G_CTX = {0};

/*---------------------------------------------------------------------------
 * Logging helpers
 *-------------------------------------------------------------------------*/
#define LOG_TS_BUFSZ 32
static void log_v(const char *lvl, const char *fmt, va_list ap)
{
    char ts[LOG_TS_BUFSZ];
    struct timespec tv;
    clock_gettime(CLOCK_REALTIME, &tv);
    strftime(ts, sizeof ts, "%F %T", localtime(&tv.tv_sec));

    fprintf(stderr, "[%s.%03ld] %s  ", ts, tv.tv_nsec / 1000000, lvl);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
}

static void log_err(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    log_v("ERROR", fmt, ap);
    va_end(ap);
}

static void log_inf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    log_v("INFO", fmt, ap);
    va_end(ap);
}

static void log_dbg(const char *fmt, ...)
{
#ifdef DEBUG
    va_list ap;
    va_start(ap, fmt);
    log_v("DEBUG", fmt, ap);
    va_end(ap);
#endif
}

/*---------------------------------------------------------------------------
 * Event-bus abstraction (placeholder)
 *-------------------------------------------------------------------------*/
static bool event_bus_publish(const char *topic, const void *payload,
                              size_t len)
{
    /* In production this would forward the event to NATS, Kafka, or NanoMSG.
     * For now we simply acknowledge the publish succeeds. */
    (void)topic;
    (void)payload;
    (void)len;
    return true;
}

/*---------------------------------------------------------------------------
 * Pulse validation / enrichment
 *-------------------------------------------------------------------------*/
static bool validate_pulse_event(const cJSON *json)
{
    /* Basic schema check: mandatory "id" and "type" fields */
    if(!cJSON_IsObject(json))
        return false;

    const cJSON *id   = cJSON_GetObjectItemCaseSensitive(json, "id");
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(json, "type");

    return cJSON_IsString(id) && id->valuestring &&
           cJSON_IsString(type) && type->valuestring;
}

static cJSON *enrich_pulse_event(cJSON *json)
{
    /* Example enrichment: attach processing timestamp and ingestion host */
    cJSON_AddStringToObject(json, "ingestor", "websocket_ingestor");
    cJSON_AddNumberToObject(json, "ingestion_ts",
                            (double)time(NULL));
    return json;
}

/*---------------------------------------------------------------------------
 * WebSocket callback
 *-------------------------------------------------------------------------*/
static int ws_callback(struct lws *wsi, enum lws_callback_reasons reason,
                       void *user, void *in, size_t len)
{
    ps_ws_peer_t *peer = (ps_ws_peer_t *)user;

    switch (reason) {

    case LWS_CALLBACK_CLIENT_ESTABLISHED:
        peer->established = true;
        log_inf("Feed connected: %s", peer->cfg->url);
        break;

    case LWS_CALLBACK_CLIENT_RECEIVE:
        peer->rx_cnt++;
        if(len > 0) {
            char *text = malloc(len + 1);
            if(!text) {
                log_err("OOM for %zu-byte frame", len);
                return -1; /* Close connection */
            }
            memcpy(text, in, len);
            text[len] = '\0';

            log_dbg("Received frame (%zu B): %s", len, text);

            cJSON *json = cJSON_Parse(text);
            free(text);

            if(!json) {
                log_err("JSON parse error");
                break;
            }

            if(!validate_pulse_event(json)) {
                log_err("Validation failed, discarding event");
                cJSON_Delete(json);
                break;
            }

            json = enrich_pulse_event(json);

            char *serialized = cJSON_PrintUnformatted(json);
            cJSON_Delete(json);

            if(!serialized) {
                log_err("Serialization failure");
                break;
            }

            bool ok = event_bus_publish(EVENT_BUS_TOPIC,
                                        serialized,
                                        strlen(serialized));
            if(!ok) {
                log_err("Event bus publish failed, dropping event");
            }
            free(serialized);
        }
        break;

    case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
        log_err("Connection error to %s: %s", peer->cfg->url,
                in ? (char *)in : "unknown");
        peer->established = false;
        break;

    case LWS_CALLBACK_CLIENT_CLOSED:
        log_inf("Connection closed (%s)", peer->cfg->url);
        peer->established = false;
        break;

    case LWS_CALLBACK_CLIENT_WRITEABLE:
        /* Could send pings or subscription messages here */
        break;

    case LWS_CALLBACK_TIMER:
        /* Request writeable for periodic ping */
        lws_callback_on_writable(wsi);
        break;

    default:
        break;
    }

    return 0;
}

/*---------------------------------------------------------------------------
 * lws protocol and context setup
 *-------------------------------------------------------------------------*/
static const struct lws_protocols PROTOCOLS[] = {
    {
        .name = "pulse-json",
        .callback = ws_callback,
        .per_session_data_size = sizeof(ps_ws_peer_t),
        .rx_buffer_size = RX_BUFFER_BYTES,
    },
    { NULL, NULL, 0, 0 } /* terminator */
};

static bool build_lws_context(ps_ws_app_ctx_t *ctx)
{
    struct lws_context_creation_info info;
    memset(&info, 0, sizeof info);

    info.port = CONTEXT_PORT_NO_LISTEN;   /* Client only */
    info.protocols = PROTOCOLS;
    info.gid = -1;
    info.uid = -1;
    info.options = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    info.user = ctx;

    ctx->lws_ctx = lws_create_context(&info);
    if (!ctx->lws_ctx) {
        log_err("lws_create_context failed");
        return false;
    }
    return true;
}

/*---------------------------------------------------------------------------
 * Endpoint configuration (from environment)
 *-------------------------------------------------------------------------*/
static void add_endpoint(ps_ws_app_ctx_t *ctx,
                         const char *url, const char *subproto)
{
    if(ctx->endpoint_cnt >= MAX_ENDPOINTS) {
        log_err("Maximum endpoints reached, ignoring %s", url);
        return;
    }
    ps_ws_endpoint_t *ep = &ctx->endpoints[ctx->endpoint_cnt++];
    snprintf(ep->url, sizeof ep->url, "%s", url);
    snprintf(ep->subprotocol, sizeof ep->subprotocol, "%s", subproto ? subproto : "");
    ep->secure = strncmp(url, "wss://", 6) == 0;
}

static void load_configuration(ps_ws_app_ctx_t *ctx)
{
    /* Example: PULSE_FEEDS="wss://stream.twitter.com/1.1/events wss://fb.example.com/pulses" */
    const char *feeds = getenv("PULSE_FEEDS");
    if(!feeds) {
        log_err("No feeds specified via PULSE_FEEDS environment variable");
        exit(EXIT_FAILURE);
    }

    char *dup = strdup(feeds);
    if(!dup) {
        log_err("OOM duplicating feed list");
        exit(EXIT_FAILURE);
    }

    char *tok, *save;
    for(tok = strtok_r(dup, " ", &save); tok; tok = strtok_r(NULL, " ", &save)) {
        add_endpoint(ctx, tok, "json");
    }

    free(dup);
}

/*---------------------------------------------------------------------------
 * Connection dialer
 *-------------------------------------------------------------------------*/
static bool dial_feed(ps_ws_app_ctx_t *ctx, const ps_ws_endpoint_t *ep)
{
    struct lws_client_connect_info ccinfo = {0};
    ccinfo.context = ctx->lws_ctx;
    ccinfo.address = NULL;
    ccinfo.port = 0;
    ccinfo.path = "/";
    ccinfo.host = lws_canonical_hostname(ctx->lws_ctx);
    ccinfo.origin = "pulsesphere-ingestor";
    ccinfo.protocol = ep->subprotocol[0] ? ep->subprotocol : NULL;
    ccinfo.ssl_connection = ep->secure ? LCCSCF_USE_SSL : 0;
    ccinfo.pwsi = NULL;
    ccinfo.userdata = NULL;
    ccinfo.uri = ep->url;

    if(!lws_client_connect_via_info(&ccinfo)) {
        log_err("Failed to connect to %s", ep->url);
        return false;
    }
    return true;
}

static void connect_all_feeds(ps_ws_app_ctx_t *ctx)
{
    for(size_t i = 0; i < ctx->endpoint_cnt; i++) {
        dial_feed(ctx, &ctx->endpoints[i]);
    }
}

/*---------------------------------------------------------------------------
 * Event loop thread
 *-------------------------------------------------------------------------*/
static void *event_loop_fn(void *arg)
{
    ps_ws_app_ctx_t *ctx = arg;

    connect_all_feeds(ctx);
    log_inf("Event loop started");

    while(!ctx->shutting_down) {
        lws_service(ctx->lws_ctx, 100);
    }

    log_inf("Event loop shutting down");
    return NULL;
}

/*---------------------------------------------------------------------------
 * Signal handling
 *-------------------------------------------------------------------------*/
static void handle_sig(int sig)
{
    (void)sig;
    G_CTX.shutting_down = 1;
}

/*---------------------------------------------------------------------------
 * Public API
 *-------------------------------------------------------------------------*/
static bool ws_ingestor_start(void)
{
    load_configuration(&G_CTX);

    if(!build_lws_context(&G_CTX))
        return false;

    if(pthread_create(&G_CTX.event_loop_thread, NULL,
                      event_loop_fn, &G_CTX) != 0) {
        log_err("Failed to spawn event loop thread");
        return false;
    }
    return true;
}

static void ws_ingestor_stop(void)
{
    G_CTX.shutting_down = 1;
    pthread_join(G_CTX.event_loop_thread, NULL);
    lws_context_destroy(G_CTX.lws_ctx);
}

/*---------------------------------------------------------------------------
 * Main (CLI entry point)
 *-------------------------------------------------------------------------*/
#ifndef SHARED_OBJECT
int main(int argc, char **argv)
{
    (void)argc; (void)argv;

    signal(SIGINT, handle_sig);
    signal(SIGTERM, handle_sig);

    log_inf("PulseSphere WebSocket Ingestor starting up");

    if(!ws_ingestor_start()) {
        log_err("Startup failed");
        return EXIT_FAILURE;
    }

    while(!G_CTX.shutting_down)
        pause();

    ws_ingestor_stop();
    log_inf("Shutdown complete");
    return EXIT_SUCCESS;
}
#endif
