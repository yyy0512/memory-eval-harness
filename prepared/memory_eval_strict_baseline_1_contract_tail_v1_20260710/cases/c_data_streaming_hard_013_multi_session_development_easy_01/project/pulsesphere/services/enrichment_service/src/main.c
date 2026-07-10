```c
/**
 * PulseSphere – Enrichment Service
 * --------------------------------
 * The enrichment service subscribes to the internal event fabric,
 * performs parallel enrichment on incoming pulse events, and republishes
 * the augmented events downstream.
 *
 * NOTE:
 *  • External systems (message broker, dynamic plugins, etc.) are
 *    represented by thin shims/stubs so that this file stays
 *    self-contained and can compile in isolation.
 *  • Replace the stubs with real implementations when integrating
 *    inside the full PulseSphere source tree.
 */

#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <signal.h>
#include <pthread.h>
#include <dlfcn.h>
#include <unistd.h>

/* --------------------------------------------------------------------------
 * Compile-time Tunables
 * -------------------------------------------------------------------------- */
#ifndef PS_MAX_EVENT_PAYLOAD
#define PS_MAX_EVENT_PAYLOAD  512
#endif

#ifndef PS_MAX_ID_SIZE
#define PS_MAX_ID_SIZE        128
#endif

#ifndef PS_DEFAULT_WORKERS
#define PS_DEFAULT_WORKERS    4
#endif

#ifndef PS_BROKER_POLL_TIMEOUT_MS
#define PS_BROKER_POLL_TIMEOUT_MS  100
#endif

/* --------------------------------------------------------------------------
 * Simple Logging Facility
 * -------------------------------------------------------------------------- */
#define LOG_TIME_BUFSZ 32

static inline const char *log_timestamp(char *buf, size_t len)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);
    strftime(buf, len, "%Y-%m-%d %H:%M:%S", &tm);
    return buf;
}

#define LOG_LVL_PREFIX(lvl) ((lvl) == LOG_LVL_ERROR ? "ERROR" : \
                             (lvl) == LOG_LVL_WARN  ? "WARN " : \
                             (lvl) == LOG_LVL_INFO  ? "INFO " : "DEBUG")

enum {
    LOG_LVL_ERROR = 0,
    LOG_LVL_WARN,
    LOG_LVL_INFO,
    LOG_LVL_DEBUG
};

#ifndef PS_LOG_LEVEL
#define PS_LOG_LEVEL LOG_LVL_INFO
#endif

#define LOG(lvl, fmt, ...)                                                   \
    do {                                                                     \
        if ((lvl) <= PS_LOG_LEVEL) {                                         \
            char _buf[LOG_TIME_BUFSZ];                                       \
            fprintf((lvl)<=LOG_LVL_WARN ? stderr : stdout,                   \
                "[%s] [%s] " fmt "\n", log_timestamp(_buf, sizeof(_buf)),    \
                LOG_LVL_PREFIX(lvl), ##__VA_ARGS__);                         \
        }                                                                    \
    } while (0)

/* --------------------------------------------------------------------------
 * Data Structures
 * -------------------------------------------------------------------------- */
typedef struct {
    char     id[PS_MAX_ID_SIZE];
    char     user_id[PS_MAX_ID_SIZE];
    char     payload[PS_MAX_EVENT_PAYLOAD];
    uint64_t ts_epoch_ms;
} pulse_event_t;

/* --------------------------------------------------------------------------
 * Configuration
 * -------------------------------------------------------------------------- */
typedef struct {
    unsigned int worker_count;
    char         plugin_path[PATH_MAX];
    char         broker_endpoint[256];
} svc_config_t;

static void
config_load_from_env(svc_config_t *cfg)
{
    const char *env;
    /* Worker threads */
    env = getenv("PS_ENRICH_WORKERS");
    cfg->worker_count = env ? (unsigned)strtoul(env, NULL, 10)
                            : PS_DEFAULT_WORKERS;

    /* Plugin path */
    env = getenv("PS_ENRICH_PLUGIN");
    if (env && *env) {
        strncpy(cfg->plugin_path, env, sizeof(cfg->plugin_path)-1);
    } else {
        strncpy(cfg->plugin_path, "./libdefault_enrichment.so",
                sizeof(cfg->plugin_path)-1);
    }

    /* Broker endpoint */
    env = getenv("PS_BROKER_ENDPOINT");
    if (env && *env) {
        strncpy(cfg->broker_endpoint, env, sizeof(cfg->broker_endpoint)-1);
    } else {
        strncpy(cfg->broker_endpoint, "127.0.0.1:7000",
                sizeof(cfg->broker_endpoint)-1);
    }
}

/* --------------------------------------------------------------------------
 * Enrichment Plugin ABI
 * -------------------------------------------------------------------------- */
typedef int (*enrich_fn_t)(pulse_event_t *event, char *errbuf, size_t errlen);

typedef struct {
    void        *dl_handle;
    enrich_fn_t  enrich;
    char         path[PATH_MAX];
} enrichment_plugin_t;

static bool
plugin_load(enrichment_plugin_t *out, const char *path)
{
    if (!path) return false;

    void *dl = dlopen(path, RTLD_NOW);
    if (!dl) {
        LOG(LOG_LVL_ERROR, "Unable to load plugin '%s': %s", path, dlerror());
        return false;
    }

    enrich_fn_t fn = (enrich_fn_t)dlsym(dl, "enrich");
    if (!fn) {
        LOG(LOG_LVL_ERROR, "Plugin '%s' missing 'enrich' symbol", path);
        dlclose(dl);
        return false;
    }

    out->dl_handle = dl;
    out->enrich    = fn;
    strncpy(out->path, path, sizeof(out->path)-1);

    LOG(LOG_LVL_INFO, "Loaded enrichment plugin: %s", path);
    return true;
}

static void
plugin_unload(enrichment_plugin_t *plg)
{
    if (plg && plg->dl_handle) {
        dlclose(plg->dl_handle);
        plg->dl_handle = NULL;
        plg->enrich    = NULL;
    }
}

/* --------------------------------------------------------------------------
 * Message Broker Stub
 * --------------------------------------------------------------------------
 * Replace with actual broker client (Kafka, NATS, etc.)
 * -------------------------------------------------------------------------- */
typedef struct {
    char endpoint[256];
} broker_conn_t;

static broker_conn_t *
broker_connect(const char *endpoint)
{
    broker_conn_t *conn = calloc(1, sizeof(*conn));
    if (!conn) return NULL;
    strncpy(conn->endpoint, endpoint, sizeof(conn->endpoint)-1);
    LOG(LOG_LVL_INFO, "Connected to broker at %s", conn->endpoint);
    return conn;
}

static void
broker_disconnect(broker_conn_t *c)
{
    if (c) {
        LOG(LOG_LVL_INFO, "Disconnected broker (%s)", c->endpoint);
        free(c);
    }
}

/* Polls for a single event.
 * Returns true when an event was delivered, false on timeout/no data.
 */
static bool
broker_poll(broker_conn_t *c, pulse_event_t *out_evt, int timeout_ms)
{
    (void)c; /* unused in stub */

    /* Simulate no data half the time */
    if (rand() % 2) {
        struct timespec ts = { 0, timeout_ms * 1000 * 1000 };
        nanosleep(&ts, NULL);
        return false;
    }

    /* Generate pseudo-random event */
    snprintf(out_evt->id, sizeof(out_evt->id), "evt-%u", rand());
    snprintf(out_evt->user_id, sizeof(out_evt->user_id), "usr-%u", rand());
    snprintf(out_evt->payload, sizeof(out_evt->payload),
             "{\"like\":%d}", rand() % 2);
    out_evt->ts_epoch_ms = (uint64_t)time(NULL) * 1000ULL;
    return true;
}

static bool
broker_publish(broker_conn_t *c, const pulse_event_t *evt)
{
    (void)c; (void)evt; /* stub */
    LOG(LOG_LVL_DEBUG, "Published event %s", evt->id);
    return true;
}

/* --------------------------------------------------------------------------
 * Graceful Shutdown Handling
 * -------------------------------------------------------------------------- */
static volatile sig_atomic_t g_keep_running = 1;

static void
sig_handler(int sig)
{
    (void)sig;
    g_keep_running = 0;
}

/* --------------------------------------------------------------------------
 * Worker Context
 * -------------------------------------------------------------------------- */
typedef struct {
    unsigned            id;
    broker_conn_t      *broker;
    enrichment_plugin_t plugin;
    _Atomic uint64_t    processed;
} worker_ctx_t;

static void *
worker_thread(void *arg)
{
    worker_ctx_t *ctx = arg;
    pulse_event_t evt;

    char errbuf[128];

    while (g_keep_running) {
        bool got = broker_poll(ctx->broker, &evt, PS_BROKER_POLL_TIMEOUT_MS);
        if (!got) continue;

        int rc = ctx->plugin.enrich(&evt, errbuf, sizeof(errbuf));
        if (rc != 0) {
            LOG(LOG_LVL_WARN, "Worker %u: enrichment failed for event %s: %s",
                ctx->id, evt.id, errbuf);
            continue; /* Skip publishing */
        }

        if (!broker_publish(ctx->broker, &evt)) {
            LOG(LOG_LVL_ERROR, "Worker %u: failed to publish event %s",
                ctx->id, evt.id);
        } else {
            atomic_fetch_add_explicit(&ctx->processed, 1, memory_order_relaxed);
        }
    }

    LOG(LOG_LVL_INFO, "Worker %u exiting (processed=%lu)",
        ctx->id, (unsigned long)atomic_load(&ctx->processed));
    return NULL;
}

/* --------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------- */
int
main(int argc, char **argv)
{
    (void)argc; (void)argv;

    /* Seed RNG for stub generator */
    srand((unsigned)time(NULL));

    /* ------------------------------------------------------------------ */
    /* Install signal handlers                                            */
    struct sigaction sa = { .sa_handler = sig_handler };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    /* ------------------------------------------------------------------ */
    /* Load configuration                                                 */
    svc_config_t cfg = {0};
    config_load_from_env(&cfg);

    LOG(LOG_LVL_INFO, "Starting enrichment service "
                      "(workers=%u, plugin=%s, broker=%s)",
                      cfg.worker_count, cfg.plugin_path, cfg.broker_endpoint);

    /* ------------------------------------------------------------------ */
    /* Global resources                                                   */
    enrichment_plugin_t plugin;
    if (!plugin_load(&plugin, cfg.plugin_path)) {
        return EXIT_FAILURE;
    }

    broker_conn_t *broker = broker_connect(cfg.broker_endpoint);
    if (!broker) {
        plugin_unload(&plugin);
        return EXIT_FAILURE;
    }

    /* ------------------------------------------------------------------ */
    /* Spawn worker pool                                                  */
    pthread_t *threads = calloc(cfg.worker_count, sizeof(*threads));
    worker_ctx_t *wctx  = calloc(cfg.worker_count, sizeof(*wctx));
    if (!threads || !wctx) {
        LOG(LOG_LVL_ERROR, "Out of memory initializing workers");
        broker_disconnect(broker);
        plugin_unload(&plugin);
        free(threads);
        free(wctx);
        return EXIT_FAILURE;
    }

    for (unsigned i = 0; i < cfg.worker_count; ++i) {
        wctx[i].id      = i;
        wctx[i].broker  = broker;         /* Shared connection (stub)     */
        wctx[i].plugin  = plugin;         /* Shallow copy (dl_handle etc.)*/
        wctx[i].processed = 0;

        int rc = pthread_create(&threads[i], NULL, worker_thread, &wctx[i]);
        if (rc != 0) {
            LOG(LOG_LVL_ERROR, "Unable to create worker thread %u: %s",
                               i, strerror(rc));
            g_keep_running = 0;
            cfg.worker_count = i; /* join only those created so far */
            break;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Metrics loop                                                       */
    while (g_keep_running) {
        uint64_t total = 0;
        for (unsigned i = 0; i < cfg.worker_count; ++i)
            total += atomic_load_explicit(&wctx[i].processed, memory_order_relaxed);

        LOG(LOG_LVL_INFO, "Processed events: %lu", (unsigned long)total);
        sleep(5);
    }

    /* ------------------------------------------------------------------ */
    /* Shutdown sequence                                                  */
    LOG(LOG_LVL_INFO, "Shutting down enrichment service ...");

    for (unsigned i = 0; i < cfg.worker_count; ++i)
        pthread_join(threads[i], NULL);

    broker_disconnect(broker);
    plugin_unload(&plugin);
    free(threads);
    free(wctx);

    LOG(LOG_LVL_INFO, "Enrichment service stopped.");
    return EXIT_SUCCESS;
}
```