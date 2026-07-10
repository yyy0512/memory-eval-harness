/*
 * PulseSphere: Analytics Sink Service
 *
 * File: pulsesphere/services/analytics_sink_service/src/main.c
 *
 * Description:
 * ---------------------------------------------------------------------------
 * This micro-service subscribes to the unified social-pulse event fabric and
 * forwards validated, enriched events to an analytical sink (data-lake, OLAP
 * database, parquet files, …).  The actual sink is provided as a runtime
 * plug-in (.so) that follows a tiny Strategy-Pattern interface, allowing
 * different storage back-ends to be swapped without recompilation.
 *
 * Major components inside this file:
 *  - Minimal logging abstraction
 *  - Process-wide configuration loader (env vars or defaults)
 *  - POSIX signal handling (graceful shutdown)
 *  - Dynamic plug-in loader (dlopen / dlsym)
 *  - Optional Kafka consumer (librdkafka) or stub generator (for local tests)
 *  - Main batching / forwarding loop with error handling
 *
 * Build:
 *  $ cc -std=c11 -DUSE_RDKAFKA -o analytics_sink_service main.c -lrdkafka -ldl -lpthread
 *
 * Without Kafka, omit -DUSE_RDKAFKA and -lrdkafka; a deterministic stub
 * generator will be compiled instead.
 *
 * ---------------------------------------------------------------------------
 */

#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <dlfcn.h>

#ifdef USE_RDKAFKA
#include <librdkafka/rdkafka.h>
#endif

/* ------------------------------------------------------------------------- */
/*                              Logging utility                              */
/* ------------------------------------------------------------------------- */

typedef enum
{
    LOG_DEBUG = 0,
    LOG_INFO,
    LOG_WARN,
    LOG_ERROR
} log_level_t;

static const char *level_to_string(log_level_t lvl)
{
    switch (lvl)
    {
    case LOG_DEBUG: return "DEBUG";
    case LOG_INFO:  return "INFO ";
    case LOG_WARN:  return "WARN ";
    case LOG_ERROR: return "ERROR";
    default:        return "UNKWN";
    }
}

static log_level_t GLOBAL_LOG_LEVEL = LOG_INFO;

static void log_set_level_from_env(void)
{
    const char *lvl = getenv("ANALYTICS_SINK_LOG_LEVEL");
    if (!lvl) return;

    if (strcasecmp(lvl, "DEBUG") == 0)
        GLOBAL_LOG_LEVEL = LOG_DEBUG;
    else if (strcasecmp(lvl, "INFO") == 0)
        GLOBAL_LOG_LEVEL = LOG_INFO;
    else if (strcasecmp(lvl, "WARN") == 0)
        GLOBAL_LOG_LEVEL = LOG_WARN;
    else if (strcasecmp(lvl, "ERROR") == 0)
        GLOBAL_LOG_LEVEL = LOG_ERROR;
}

static void log_msg(log_level_t lvl, const char *fmt, ...)
{
    if (lvl < GLOBAL_LOG_LEVEL) return;

    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm;
    gmtime_r(&tv.tv_sec, &tm);

    char timebuf[32];
    strftime(timebuf, sizeof timebuf, "%Y-%m-%dT%H:%M:%S", &tm);

    fprintf(stderr, "%s.%03ld [%5s] [tid:%lu] ",
            timebuf,
            tv.tv_usec / 1000,
            level_to_string(lvl),
            (unsigned long)pthread_self());

    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);

    fputc('\n', stderr);
    fflush(stderr);
}

#define LOGD(...) log_msg(LOG_DEBUG, __VA_ARGS__)
#define LOGI(...) log_msg(LOG_INFO,  __VA_ARGS__)
#define LOGW(...) log_msg(LOG_WARN,  __VA_ARGS__)
#define LOGE(...) log_msg(LOG_ERROR, __VA_ARGS__)

/* ------------------------------------------------------------------------- */
/*                              Configuration                                */
/* ------------------------------------------------------------------------- */
typedef struct
{
    char   bootstrap_servers[256];
    char   topic[128];
    char   group_id[128];

    char   sink_plugin_path[PATH_MAX];
    char   sink_plugin_config[PATH_MAX];

    size_t batch_size;
    int    poll_timeout_ms;
} service_config_t;

static void trim_trailing_slash(char *s)
{
    size_t len = strlen(s);
    if (len > 0 && s[len - 1] == '/')
        s[len - 1] = '\0';
}

static void conf_load(service_config_t *cfg)
{
    /* Defaults */
    snprintf(cfg->bootstrap_servers, sizeof cfg->bootstrap_servers, "localhost:9092");
    snprintf(cfg->topic, sizeof cfg->topic, "pulsesphere.social.events");
    snprintf(cfg->group_id, sizeof cfg->group_id, "analytics_sink");

    snprintf(cfg->sink_plugin_path, sizeof cfg->sink_plugin_path, "./libpulse_sink_fs.so");
    cfg->sink_plugin_config[0] = '\0';

    cfg->batch_size      = 500;
    cfg->poll_timeout_ms = 100;

    /* Overrides via env-vars */
    const char *v;
    if ((v = getenv("ANALYTICS_SINK_KAFKA_BOOTSTRAP")))     strncpy(cfg->bootstrap_servers, v, sizeof cfg->bootstrap_servers - 1);
    if ((v = getenv("ANALYTICS_SINK_KAFKA_TOPIC")))         strncpy(cfg->topic, v, sizeof cfg->topic - 1);
    if ((v = getenv("ANALYTICS_SINK_KAFKA_GROUP")))         strncpy(cfg->group_id, v, sizeof cfg->group_id - 1);
    if ((v = getenv("ANALYTICS_SINK_PLUGIN")))              strncpy(cfg->sink_plugin_path, v, sizeof cfg->sink_plugin_path - 1);
    if ((v = getenv("ANALYTICS_SINK_PLUGIN_CONFIG")))       strncpy(cfg->sink_plugin_config, v, sizeof cfg->sink_plugin_config - 1);
    if ((v = getenv("ANALYTICS_SINK_BATCH_SIZE")))          cfg->batch_size      = strtoul(v, NULL, 10);
    if ((v = getenv("ANALYTICS_SINK_POLL_TIMEOUT_MS")))     cfg->poll_timeout_ms = atoi(v);

    trim_trailing_slash(cfg->sink_plugin_path);

    LOGI("Configuration loaded: bootstrap=%s topic=%s group=%s plugin=%s batch=%zu poll=%dms",
         cfg->bootstrap_servers,
         cfg->topic,
         cfg->group_id,
         cfg->sink_plugin_path,
         cfg->batch_size,
         cfg->poll_timeout_ms);
}

/* ------------------------------------------------------------------------- */
/*                               Plug-in API                                 */
/* ------------------------------------------------------------------------- */

typedef struct
{
    int  (*init)(const char *json_cfg);                       /* Returns 0 on success */
    int  (*consume_events)(const char **events, size_t n);    /* Returns <0 on fatal */
    int  (*flush)(void);                                      /* Optional, may be NULL */
    void (*shutdown)(void);                                   /* Must not be NULL */
} sink_plugin_v1_t;

typedef sink_plugin_v1_t *(*plugin_entrypoint_t)(void);

static sink_plugin_v1_t *load_plugin(const char *path, void **dl_handle_out)
{
    *dl_handle_out = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!*dl_handle_out)
    {
        LOGE("dlopen failed for '%s': %s", path, dlerror());
        return NULL;
    }

    dlerror(); /* Clear existing */
    plugin_entrypoint_t sym = (plugin_entrypoint_t)dlsym(*dl_handle_out, "get_sink_plugin_v1");
    const char *err = dlerror();
    if (err)
    {
        LOGE("dlsym(get_sink_plugin_v1) failed: %s", err);
        dlclose(*dl_handle_out);
        *dl_handle_out = NULL;
        return NULL;
    }

    sink_plugin_v1_t *plugin = sym();
    if (!plugin || !plugin->init || !plugin->consume_events || !plugin->shutdown)
    {
        LOGE("Plugin does not expose mandatory API symbols");
        dlclose(*dl_handle_out);
        *dl_handle_out = NULL;
        return NULL;
    }

    return plugin;
}

/* ------------------------------------------------------------------------- */
/*                          Kafka / Event Consumer                           */
/* ------------------------------------------------------------------------- */

#ifdef USE_RDKAFKA

typedef struct
{
    rd_kafka_t        *rk;
    rd_kafka_topic_t  *rkt;
    rd_kafka_conf_t   *conf;
} kafka_ctx_t;

static int kafka_init(const service_config_t *cfg, kafka_ctx_t *kctx)
{
    char errstr[512];

    kctx->conf = rd_kafka_conf_new();
    rd_kafka_conf_set(kctx->conf, "bootstrap.servers", cfg->bootstrap_servers, errstr, sizeof errstr);
    rd_kafka_conf_set(kctx->conf, "group.id", cfg->group_id, errstr, sizeof errstr);
    rd_kafka_conf_set(kctx->conf, "enable.auto.commit", "true", errstr, sizeof errstr);

    kctx->rk = rd_kafka_new(RD_KAFKA_CONSUMER, kctx->conf, errstr, sizeof errstr);
    if (!kctx->rk)
    {
        LOGE("Failed to create Kafka consumer: %s", errstr);
        return -1;
    }

    rd_kafka_poll_set_consumer(kctx->rk);

    rd_kafka_topic_partition_list_t *topics = rd_kafka_topic_partition_list_new(1);
    rd_kafka_topic_partition_list_add(topics, cfg->topic, -1);

    if (rd_kafka_subscribe(kctx->rk, topics))
    {
        LOGE("Kafka subscribe failed: %s", rd_kafka_err2str(rd_kafka_last_error()));
        rd_kafka_topic_partition_list_destroy(topics);
        return -1;
    }
    rd_kafka_topic_partition_list_destroy(topics);

    LOGI("Connected to Kafka cluster, subscribed to %s", cfg->topic);
    return 0;
}

static void kafka_close(kafka_ctx_t *kctx)
{
    if (!kctx->rk) return;

    rd_kafka_consumer_close(kctx->rk);
    rd_kafka_destroy(kctx->rk);
}

static ssize_t kafka_poll_events(kafka_ctx_t *kctx,
                                 char      **buffer,
                                 size_t      max_events,
                                 int         timeout_ms)
{
    size_t n = 0;
    while (n < max_events)
    {
        rd_kafka_message_t *msg = rd_kafka_consumer_poll(kctx->rk, timeout_ms);
        if (!msg)
            break; /* Timeout */

        if (msg->err)
        {
            LOGW("Kafka error (%s): %s",
                 rd_kafka_name(kctx->rk),
                 rd_kafka_message_errstr(msg));
            rd_kafka_message_destroy(msg);
            continue;
        }

        buffer[n] = malloc(msg->len + 1);
        if (!buffer[n])
        {
            LOGE("Out of memory for event buffer");
            rd_kafka_message_destroy(msg);
            break;
        }
        memcpy(buffer[n], msg->payload, msg->len);
        buffer[n][msg->len] = '\0';

        rd_kafka_message_destroy(msg);
        ++n;

        /* For subsequent iterations use zero timeout */
        timeout_ms = 0;
    }

    return (ssize_t)n;
}

#else  /* USE_RDKAFKA not defined -> stub event generator */

typedef struct
{
    uint64_t counter;
} kafka_ctx_t;

static int kafka_init(const service_config_t *cfg, kafka_ctx_t *ctx)
{
    (void)cfg;
    ctx->counter = 0;
    LOGW("Compiled without Kafka support. Using pseudo-event generator.");
    return 0;
}

static void kafka_close(kafka_ctx_t *ctx)
{
    (void)ctx;
}

static ssize_t kafka_poll_events(kafka_ctx_t *ctx,
                                 char      **buffer,
                                 size_t      max_events,
                                 int         timeout_ms)
{
    (void)timeout_ms;
    size_t n;
    for (n = 0; n < max_events; ++n)
    {
        char tmp[128];
        int  len = snprintf(tmp, sizeof tmp,
                            "{\"event_id\":%" PRIu64 ",\"type\":\"like\",\"user\":\"user%" PRIu64 "\"}",
                            ctx->counter,
                            ctx->counter % 1000);
        buffer[n] = malloc(len + 1);
        if (!buffer[n]) break;
        memcpy(buffer[n], tmp, len + 1);
        ctx->counter++;
    }
    usleep(50 * 1000); /* simulate network delay */
    return (ssize_t)n;
}

#endif /* USE_RDKAFKA */

/* ------------------------------------------------------------------------- */
/*                          Graceful shutdown                                */
/* ------------------------------------------------------------------------- */

static volatile sig_atomic_t SHUTDOWN_REQ = 0;

static void handle_signal(int sig)
{
    (void)sig;
    SHUTDOWN_REQ = 1;
}

static void install_signals(void)
{
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = handle_signal;
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
}

/* ------------------------------------------------------------------------- */
/*                                Utilities                                  */
/* ------------------------------------------------------------------------- */

static void free_events(char **events, size_t n)
{
    for (size_t i = 0; i < n; ++i)
        free(events[i]);
}

/* ------------------------------------------------------------------------- */
/*                                 main()                                    */
/* ------------------------------------------------------------------------- */

int main(void)
{
    log_set_level_from_env();
    install_signals();

    service_config_t cfg;
    conf_load(&cfg);

    /* Load plug-in */
    void *dl_handle = NULL;
    sink_plugin_v1_t *plugin = load_plugin(cfg.sink_plugin_path, &dl_handle);
    if (!plugin) exit(EXIT_FAILURE);

    if (plugin->init(cfg.sink_plugin_config) != 0)
    {
        LOGE("Plugin initialization failed");
        dlclose(dl_handle);
        exit(EXIT_FAILURE);
    }
    LOGI("Plug-in '%s' ready", cfg.sink_plugin_path);

    /* Initialize consumer */
    kafka_ctx_t consumer;
    if (kafka_init(&cfg, &consumer) != 0)
    {
        plugin->shutdown();
        dlclose(dl_handle);
        exit(EXIT_FAILURE);
    }

    /* Allocate batch buffer */
    char **events = malloc(sizeof(char *) * cfg.batch_size);
    if (!events)
    {
        LOGE("Unable to allocate batch buffer");
        kafka_close(&consumer);
        plugin->shutdown();
        dlclose(dl_handle);
        exit(EXIT_FAILURE);
    }

    /* Main loop */
    while (!SHUTDOWN_REQ)
    {
        ssize_t n = kafka_poll_events(&consumer,
                                      events,
                                      cfg.batch_size,
                                      cfg.poll_timeout_ms);

        if (n < 0)
        {
            LOGE("Fatal error while polling events");
            break;
        }

        if (n == 0) continue; /* idle */

        int rc = plugin->consume_events((const char **)events, (size_t)n);
        free_events(events, (size_t)n);

        if (rc < 0)
        {
            LOGE("Plug-in signaled fatal error (%d). Terminating.", rc);
            break;
        }
    }

    LOGI("Shutting down ...");

    /* Flush outstanding events */
    if (plugin->flush)
    {
        int rc = plugin->flush();
        if (rc != 0)
            LOGW("Plug-in flush returned %d", rc);
    }

    kafka_close(&consumer);
    plugin->shutdown();
    dlclose(dl_handle);

    free(events);

    LOGI("Bye!");
    return 0;
}

/* ------------------------------------------------------------------------- */
/* End of file                                                               */
/* ------------------------------------------------------------------------- */
