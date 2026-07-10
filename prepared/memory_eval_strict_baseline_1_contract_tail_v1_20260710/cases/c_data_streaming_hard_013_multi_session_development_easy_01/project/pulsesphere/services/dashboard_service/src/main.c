/*
 * PulseSphere – Dashboard Service
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  Description:
 *      The Dashboard Service subscribes to the unified PulseSphere event
 *      fabric, aggregates live “social pulse” statistics, and exposes the
 *      current snapshot via an HTTP endpoint for Web dashboards and alerting
 *      systems.  The service is intentionally self-contained and free of any
 *      heavy-weight frameworks; all concurrency, IO, and memory-safety
 *      concerns are handled explicitly in C to guarantee deterministic
 *      latency and predictable resource usage.
 *
 *  Build:
 *      gcc -Wall -Wextra -O2 -o dashboard_service main.c \
 *          -lzmq -lmicrohttpd -lcjson -lpthread
 *
 *  Runtime configuration (via environment variables):
 *      PULSES_BUS_ENDPOINT   –  ØMQ publisher endpoint (default: tcp://localhost:5556)
 *      PULSES_HTTP_PORT      –  HTTP port to expose metrics (default: 8080)
 *      PULSES_LOG_VERBOSITY  –  0=ERROR,1=WARN,2=INFO,3=DEBUG (default: 2)
 *
 *  Endpoints:
 *      GET /metrics      –  Returns a JSON snapshot of aggregated counters
 *
 *  Dependencies:
 *      • ZeroMQ           (≥ 4.1)        –  Event stream subscription
 *      • libmicrohttpd    (≥ 0.9)        –  Minimal embedded HTTP server
 *      • cJSON           (https://github.com/DaveGamble/cJSON)
 *      • POSIX Threads
 * ──────────────────────────────────────────────────────────────────────────
 */

#define _POSIX_C_SOURCE 200809L

#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <pthread.h>
#include <sys/time.h>

/* External libraries */
#include <zmq.h>
#include <microhttpd.h>
#include <cjson/cJSON.h>

/* ────────────────────────── Compile-time Constants ───────────────────── */

#define DEFAULT_BUS_ENDPOINT   "tcp://localhost:5556"
#define DEFAULT_HTTP_PORT      8080U
#define MAX_EVENT_SIZE         (16 * 1024)        /* bytes */
#define METRICS_JSON_CAP       512                /* pre-allocation hint */
#define HTTP_CONNECTION_LIMIT  64                 /* concurrent connections */
#define HTTP_REQUEST_TIMEOUT   2000               /* msec */

#ifndef DASH_VERBOSITY
#define DASH_VERBOSITY 2         /* INFO by default */
#endif

/* ───────────────────────────── Logging Macros ────────────────────────── */

enum { LVL_ERR = 0, LVL_WARN, LVL_INFO, LVL_DBG };

static int g_log_level = DASH_VERBOSITY;

#define LOG(_lvl, fmt, ...)                                                     \
    do {                                                                        \
        if ((_lvl) <= g_log_level) {                                            \
            const char *lvlstr[] = {"ERROR", "WARN ", "INFO ", "DEBUG"};        \
            struct timeval _tv; gettimeofday(&_tv, NULL);                       \
            struct tm _tm; localtime_r(&_tv.tv_sec, &_tm);                      \
            char timestr[32];                                                   \
            strftime(timestr, sizeof(timestr), "%Y-%m-%d %H:%M:%S", &_tm);      \
            fprintf((_lvl) <= LVL_WARN ? stderr : stdout,                       \
                    "[%s.%03ld] %-5s | " fmt "\n", timestr,                     \
                    _tv.tv_usec / 1000L, lvlstr[_lvl], ##__VA_ARGS__);          \
        }                                                                       \
    } while (0)

/* ──────────────────────── Aggregated Metrics Model ───────────────────── */

typedef struct {
    uint64_t likes;
    uint64_t comments;
    uint64_t shares;
    uint64_t follows;
    uint64_t reactions;
    time_t   up_since;          /* UNIX epoch of service start */
} dashboard_metrics_t;

/* Live global metrics (modified by the consumer thread, read by HTTP).      *
 * We store them in an atomic struct protected by a pthread mutex to deliver *
 * consistency of multi-field reads (JSON snapshot) while avoiding the cost  *
 * of locking for each counter increment.                                    */
static dashboard_metrics_t          g_metrics = {0};
static pthread_mutex_t              g_metrics_lock = PTHREAD_MUTEX_INITIALIZER;

/* ──────────────────────────── Service State ───────────────────────────── */

static _Atomic bool g_running = ATOMIC_VAR_INIT(true);

/* ─────────────────────── Graceful Shutdown Handler ────────────────────── */

static void on_signal(int sig)
{
    (void)sig;
    if (atomic_exchange_explicit(&g_running, false, memory_order_seq_cst) == true) {
        LOG(LVL_INFO, "Caught termination signal – shutting down…");
    }
}

/* ───────────────────────────── JSON Helpers ───────────────────────────── */

static bool parse_and_accumulate(const char *json_buf, size_t len)
{
    bool success = false;

    cJSON *root = cJSON_ParseWithLength(json_buf, (int)len);
    if (!root) {
        LOG(LVL_WARN, "Invalid JSON received from stream – discarded");
        return false;
    }

    /* Expected schema:
     * {
     *     "type":   "LIKE" | "COMMENT" | … ,
     *     "ts":     16812345678,
     *     "user":   { … }
     * }
     */
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (cJSON_IsString(type) && type->valuestring) {
        pthread_mutex_lock(&g_metrics_lock);
        if (strcmp(type->valuestring, "LIKE") == 0)
            ++g_metrics.likes;
        else if (strcmp(type->valuestring, "COMMENT") == 0)
            ++g_metrics.comments;
        else if (strcmp(type->valuestring, "SHARE") == 0)
            ++g_metrics.shares;
        else if (strcmp(type->valuestring, "FOLLOW") == 0)
            ++g_metrics.follows;
        else
            ++g_metrics.reactions;     /* default bucket */
        pthread_mutex_unlock(&g_metrics_lock);
        success = true;
    } else {
        LOG(LVL_WARN, "JSON message missing mandatory \"type\" field");
    }

    cJSON_Delete(root);
    return success;
}

/* ─────────────────────── Event Consumer Thread ────────────────────────── */

typedef struct {
    char endpoint[256];
} consumer_cfg_t;

static void *consumer_thread(void *arg)
{
    consumer_cfg_t *cfg = (consumer_cfg_t *)arg;

    void *ctx = zmq_ctx_new();
    if (!ctx) {
        LOG(LVL_ERR, "ZeroMQ context creation failed: %s", zmq_strerror(errno));
        return NULL;
    }

    void *sub = zmq_socket(ctx, ZMQ_SUB);
    if (!sub) {
        LOG(LVL_ERR, "ZeroMQ socket creation failed: %s", zmq_strerror(errno));
        zmq_ctx_term(ctx);
        return NULL;
    }

    /* Subscribe to the entire topic space – filtering can be added later */
    if (zmq_setsockopt(sub, ZMQ_SUBSCRIBE, "", 0) != 0) {
        LOG(LVL_ERR, "ZeroMQ setsockopt failed: %s", zmq_strerror(errno));
        zmq_close(sub);
        zmq_ctx_term(ctx);
        return NULL;
    }

    if (zmq_connect(sub, cfg->endpoint) != 0) {
        LOG(LVL_ERR, "ZeroMQ connect(%s) failed: %s", cfg->endpoint, zmq_strerror(errno));
        zmq_close(sub);
        zmq_ctx_term(ctx);
        return NULL;
    }

    LOG(LVL_INFO, "Consumer thread connected to %s", cfg->endpoint);

    char  buf[MAX_EVENT_SIZE];
    while (atomic_load_explicit(&g_running, memory_order_relaxed)) {
        int rc = zmq_recv(sub, buf, sizeof(buf) - 1, ZMQ_DONTWAIT);
        if (rc < 0) {
            if (errno == EAGAIN) {
                /* No message – yield CPU briefly */
                struct timespec ts = {0, 2000000}; /* 2 ms */
                nanosleep(&ts, NULL);
                continue;
            } else {
                LOG(LVL_ERR, "ZeroMQ recv failed: %s", zmq_strerror(errno));
                break;
            }
        }

        buf[rc] = '\0';
        parse_and_accumulate(buf, (size_t)rc);
    }

    zmq_close(sub);
    zmq_ctx_term(ctx);
    LOG(LVL_INFO, "Consumer thread terminated");
    return NULL;
}

/* ─────────────────────────── HTTP Server Glue ─────────────────────────── */

static int http_handler(void *cls,
                        struct MHD_Connection *conn,
                        const char *url,
                        const char *method,
                        const char *version,
                        const char *upload_data,
                        size_t *upload_data_size,
                        void **con_cls)
{
    (void)cls; (void)version; (void)upload_data; (void)upload_data_size; (void)con_cls;

    if (strcmp(method, "GET") != 0) {
        return MHD_NO;
    }

    if (strcmp(url, "/metrics") != 0) {
        /* Only /metrics supported */
        const char *not_found = "404 – Not Found\n";
        struct MHD_Response *resp = MHD_create_response_from_buffer(strlen(not_found),
                                                                    (void*)not_found,
                                                                    MHD_RESPMEM_PERSISTENT);
        int ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* Snapshot metrics under lock */
    dashboard_metrics_t snapshot;
    pthread_mutex_lock(&g_metrics_lock);
    snapshot = g_metrics;
    pthread_mutex_unlock(&g_metrics_lock);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "likes",     (double)snapshot.likes);
    cJSON_AddNumberToObject(root, "comments",  (double)snapshot.comments);
    cJSON_AddNumberToObject(root, "shares",    (double)snapshot.shares);
    cJSON_AddNumberToObject(root, "follows",   (double)snapshot.follows);
    cJSON_AddNumberToObject(root, "reactions", (double)snapshot.reactions);
    cJSON_AddNumberToObject(root, "uptime_s",  (double)(time(NULL) - snapshot.up_since));

    char *json_str = cJSON_PrintBuffered(root, METRICS_JSON_CAP, false);
    cJSON_Delete(root);

    struct MHD_Response *resp = MHD_create_response_from_buffer(strlen(json_str),
                                                                json_str,
                                                                MHD_RESPMEM_MUST_FREE);
    MHD_add_response_header(resp, "Content-Type", "application/json");
    int ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    return ret;
}

/* ────────────────────────────── main() ────────────────────────────────── */

static void init_metrics(void)
{
    pthread_mutex_lock(&g_metrics_lock);
    memset(&g_metrics, 0, sizeof(g_metrics));
    g_metrics.up_since = time(NULL);
    pthread_mutex_unlock(&g_metrics_lock);
}

static uint16_t env_port_or_default(const char *env_var, uint16_t dfl)
{
    const char *v = getenv(env_var);
    if (!v || *v == '\0') return dfl;
    char *end = NULL;
    long p = strtol(v, &end, 10);
    if (end == v || p <= 0 || p > 65535) {
        LOG(LVL_WARN, "Invalid port in %s – using default %u", env_var, dfl);
        return dfl;
    }
    return (uint16_t)p;
}

static void update_log_level_from_env(void)
{
    const char *v = getenv("PULSES_LOG_VERBOSITY");
    if (!v) return;
    int lvl = atoi(v);
    if (lvl >= LVL_ERR && lvl <= LVL_DBG) g_log_level = lvl;
}

int main(int argc, char **argv)
{
    (void)argc; (void)argv;

    update_log_level_from_env();

    /* Resolve runtime configuration */
    const char *bus_endpoint = getenv("PULSES_BUS_ENDPOINT");
    if (!bus_endpoint) bus_endpoint = DEFAULT_BUS_ENDPOINT;
    uint16_t http_port = env_port_or_default("PULSES_HTTP_PORT", DEFAULT_HTTP_PORT);

    LOG(LVL_INFO, "Starting PulseSphere Dashboard Service");
    LOG(LVL_INFO, "Stream endpoint: %s  |  HTTP port: %u", bus_endpoint, http_port);

    /* Prepare signal handlers for a graceful shutdown */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_signal;
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    init_metrics();

    /* Launch consumer thread */
    pthread_t consumer_tid;
    consumer_cfg_t cfg = {0};
    snprintf(cfg.endpoint, sizeof(cfg.endpoint), "%s", bus_endpoint);
    if (pthread_create(&consumer_tid, NULL, consumer_thread, &cfg) != 0) {
        LOG(LVL_ERR, "Failed to create consumer thread");
        return EXIT_FAILURE;
    }

    /* Start HTTP server */
    struct MHD_Daemon *httpd = MHD_start_daemon(MHD_USE_AUTO_INTERNAL_THREAD,
                                                http_port,
                                                NULL, NULL,           /* Accept policy    */
                                                &http_handler, NULL,  /* Default handler  */
                                                MHD_OPTION_CONNECTION_TIMEOUT, HTTP_REQUEST_TIMEOUT,
                                                MHD_OPTION_PER_IP_CONNECTION_LIMIT, HTTP_CONNECTION_LIMIT,
                                                MHD_OPTION_END);
    if (!httpd) {
        LOG(LVL_ERR, "Failed to start HTTP server");
        atomic_store(&g_running, false);
        pthread_join(consumer_tid, NULL);
        return EXIT_FAILURE;
    }
    LOG(LVL_INFO, "HTTP server listening on :%u", http_port);

    /* Main thread idles until a termination signal is received */
    while (atomic_load_explicit(&g_running, memory_order_relaxed)) {
        struct timespec ts = {0, 500000000}; /* 500 ms */
        nanosleep(&ts, NULL);
    }

    /* Teardown */
    MHD_stop_daemon(httpd);
    pthread_join(consumer_tid, NULL);
    pthread_mutex_destroy(&g_metrics_lock);

    LOG(LVL_INFO, "Dashboard Service stopped – goodbye!");
    return EXIT_SUCCESS;
}