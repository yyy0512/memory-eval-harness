#ifndef PS_KAFKA_CLIENT_H_
#define PS_KAFKA_CLIENT_H_

/*
 * ps_kafka_client.h
 *
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * High-level C wrapper around librdkafka that provides:
 *   • Thin, opinionated abstraction for producers/consumers
 *   • Thread-safe, non-blocking publish/subscribe API
 *   • Centralised error handling & metrics hooks
 *
 * This header is intentionally self-contained: all functions
 * are implemented as `static inline` so that users only need
 * to link against librdkafka.  Include this header in as many
 * translation units as you wish – each will only contain
 * inline code and no multiple-definition conflicts will arise.
 *
 * Build requirements:
 *   gcc ... -lrdkafka -lpthread
 */

#ifdef __cplusplus
extern "C" {
#endif

/* ========= Standard & 3rd-party headers ================================ */
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>
#include <librdkafka/rdkafka.h>

/* ========= Public Versioning Macro ==================================== */
#define PS_KAFKA_CLIENT_VERSION "1.1.0"

/* ========= Error / Status Codes ======================================= */
typedef enum {
    PS_KAFKA_OK             = 0,
    PS_KAFKA_ERR            = -1,
    PS_KAFKA_TIMEOUT        = -2,
    PS_KAFKA_QUEUE_FULL     = -3,
    PS_KAFKA_CONF_ERR       = -4,
    PS_KAFKA_INVALID_ARG    = -5,
} ps_kafka_code_t;


/* ========= Forward Declarations ======================================= */
struct ps_kafka_client_s;
typedef struct ps_kafka_client_s ps_kafka_client_t;

/* ========= Callback Typedefs ========================================== */

/* Delivery-report callback for async producer */
typedef void (*ps_kafka_delivery_cb)(
        ps_kafka_client_t* client,
        const rd_kafka_message_t* rkmsg,
        void* opaque);

/* Generic error callback */
typedef void (*ps_kafka_error_cb)(
        ps_kafka_client_t* client,
        int err,
        const char* reason,
        void* opaque);

/* Rebalance callback (consumer only) */
typedef void (*ps_kafka_rebalance_cb)(
        ps_kafka_client_t* client,
        rd_kafka_resp_err_t err,
        rd_kafka_topic_partition_list_t* partitions,
        void* opaque);

/* ========= Configuration Object ======================================= */
typedef struct {
    /* Broker list in host1:port1,host2:port2 format */
    const char*         bootstrap_servers;

    /* Mandatory for consumer */
    const char*         group_id;

    /* Optional unique client identifier */
    const char*         client_id;

    /* High-level features ------------------------------------------------*/
    bool                enable_idempotence;     /* Producer */
    bool                enable_auto_commit;     /* Consumer */

    /* Timeouts (ms) ------------------------------------------------------*/
    int                 message_timeout_ms;     /* Producer */
    int                 session_timeout_ms;     /* Consumer */

    /* Application callbacks ---------------------------------------------*/
    ps_kafka_delivery_cb    delivery_cb;        /* Producer */
    ps_kafka_error_cb       error_cb;           /* Both */
    ps_kafka_rebalance_cb   rebalance_cb;       /* Consumer */

    /* Opaque pointer forwarded to callbacks */
    void*               opaque;

} ps_kafka_conf_t;

/* ========= Client-side Metrics Snapshot =============================== */
typedef struct {
    uint64_t messages_produced;
    uint64_t messages_acked;
    uint64_t messages_failed;

    uint64_t messages_consumed;
    uint64_t bytes_consumed;

    double   consumer_lag;      /* Derived from high-watermark */
} ps_kafka_metrics_t;

/* ========= Public API ================================================== */

/*
 * ps_kafka_client_new_producer()
 * -------------------------------------------------
 * Allocates and initialises a producer instance.
 * Returns NULL on failure; reason is logged via perror().
 */
static inline ps_kafka_client_t*
ps_kafka_client_new_producer(const ps_kafka_conf_t* user_conf);

/*
 * ps_kafka_client_new_consumer()
 * -------------------------------------------------
 * Allocates and initialises a consumer instance and
 * immediately subscribes to the provided topic list.
 */
static inline ps_kafka_client_t*
ps_kafka_client_new_consumer(const ps_kafka_conf_t* user_conf,
                             const char* const* topics,
                             size_t topic_count);

/*
 * Non-blocking publish.  Takes ownership of the payload buffer
 * if `copy` is set to false, otherwise copies the data.
 */
static inline ps_kafka_code_t
ps_kafka_produce(ps_kafka_client_t* client,
                 const char* topic,
                 const void* payload,
                 size_t len,
                 bool copy,
                 int32_t partition /* use RD_KAFKA_PARTITION_UA */);

/*
 * Poll internal event queue (delivery reports, errors).
 * Should be called regularly from the producer/consumer loop.
 */
static inline int
ps_kafka_poll(ps_kafka_client_t* client, int timeout_ms);

/*
 * Blocking consume with timeout (ms); returns NULL on timeout.
 * Caller must free the returned rd_kafka_message_t via
 * rd_kafka_message_destroy().
 */
static inline rd_kafka_message_t*
ps_kafka_consume(ps_kafka_client_t* client, int timeout_ms);

/*
 * Acknowledge successful processing of message (manual commits).
 */
static inline ps_kafka_code_t
ps_kafka_commit(ps_kafka_client_t* client,
                const rd_kafka_message_t* rkmsg,
                bool async);

/*
 * Flush outbound queue and destroy the client.  Blocks until
 * outstanding messages are delivered or timeout_ms expires.
 */
static inline void
ps_kafka_client_destroy(ps_kafka_client_t* client, int timeout_ms);

/*
 * Retrieve best-effort metrics/reset counters.
 */
static inline ps_kafka_metrics_t
ps_kafka_metrics_snapshot(ps_kafka_client_t* client, bool reset);


/* =========================================================================
 * ===================== Implementation Section ============================
 * =========================================================================
 */

struct ps_kafka_client_s {
    rd_kafka_t*             rk;
    ps_kafka_conf_t         cfg;
    ps_kafka_metrics_t      metrics;
    bool                    is_producer;
};

/* ------------------- Utility: string duplication ----------------------- */
static inline char* _ps_strdup(const char* s)
{
    if (!s) return NULL;
    size_t len = strlen(s) + 1;
    char* dup = (char*)malloc(len);
    if (dup) memcpy(dup, s, len);
    return dup;
}

/* ------------------- Utility: safe memset on struct -------------------- */
static inline void _ps_zero(void* ptr, size_t sz)
{
    memset(ptr, 0, sz);
}

/* ------------------- Helper: populate rd_kafka_conf -------------------- */
static inline rd_kafka_conf_t*
_ps_build_rk_conf(const ps_kafka_conf_t* user_conf,
                  bool is_producer,
                  char* errstr,
                  size_t errlen)
{
    rd_kafka_conf_t* conf = rd_kafka_conf_new();

    if (rd_kafka_conf_set(conf, "bootstrap.servers",
                          user_conf->bootstrap_servers ?: "",
                          errstr, errlen) != RD_KAFKA_CONF_OK)
        goto error;

    if (user_conf->client_id &&
        rd_kafka_conf_set(conf, "client.id",
                          user_conf->client_id, errstr, errlen) != RD_KAFKA_CONF_OK)
        goto error;

    if (!is_producer) {
        if (rd_kafka_conf_set(conf, "group.id",
                              user_conf->group_id ?: "",
                              errstr, errlen) != RD_KAFKA_CONF_OK)
            goto error;

        /* Consumer-specific tuning */
        char buf[32];
        snprintf(buf, sizeof(buf), "%d",
                 user_conf->enable_auto_commit ? 1 : 0);
        rd_kafka_conf_set(conf, "enable.auto.commit", buf, NULL, 0);

        snprintf(buf, sizeof(buf), "%d",
                 user_conf->session_timeout_ms ? user_conf->session_timeout_ms : 10000);
        rd_kafka_conf_set(conf, "session.timeout.ms", buf, NULL, 0);
    } else {
        /* Producer-specific tuning */
        char buf[32];

        snprintf(buf, sizeof(buf), "%d",
                 user_conf->enable_idempotence ? 1 : 0);
        rd_kafka_conf_set(conf, "enable.idempotence", buf, NULL, 0);

        if (user_conf->message_timeout_ms) {
            snprintf(buf, sizeof(buf), "%d", user_conf->message_timeout_ms);
            rd_kafka_conf_set(conf, "message.timeout.ms", buf, NULL, 0);
        }
    }

    /* Register librdkafka callbacks ------------------------------------ */
#define SET_CB(cb_field, set_fn)                       \
    if (user_conf->cb_field)                           \
        rd_kafka_conf_##set_fn(conf, user_conf->cb_field)

    SET_CB(error_cb, set_error_cb);
    if (is_producer)
        SET_CB(delivery_cb, set_dr_msg_cb);
    else
        SET_CB(rebalance_cb, set_rebalance_cb);

#undef SET_CB

    /* Opaque pointer for callbacks */
    rd_kafka_conf_set_opaque(conf, (void*)user_conf->opaque);

    return conf;
error:
    rd_kafka_conf_destroy(conf);
    return NULL;
}

/* ------------------- Client Creation (Producer) ------------------------ */
static inline ps_kafka_client_t*
ps_kafka_client_new_producer(const ps_kafka_conf_t* user_conf)
{
    if (!user_conf || !user_conf->bootstrap_servers)
        return NULL;

    ps_kafka_client_t* c = (ps_kafka_client_t*)calloc(1, sizeof(*c));
    if (!c) return NULL;

    _ps_zero(&c->metrics, sizeof(c->metrics));
    memcpy(&c->cfg, user_conf, sizeof(*user_conf));
    c->is_producer = true;

    char errstr[512];
    rd_kafka_conf_t* conf = _ps_build_rk_conf(user_conf, true,
                                              errstr, sizeof(errstr));
    if (!conf) {
        fprintf(stderr, "ps_kafka: config error: %s\n", errstr);
        free(c);
        return NULL;
    }

    c->rk = rd_kafka_new(RD_KAFKA_PRODUCER, conf,
                         errstr, sizeof(errstr));
    if (!c->rk) {
        fprintf(stderr, "ps_kafka: producer init failed: %s\n", errstr);
        rd_kafka_conf_destroy(conf); /* already destroyed by new on fail? */
        free(c);
        return NULL;
    }

    return c;
}

/* ------------------- Client Creation (Consumer) ------------------------ */
static inline ps_kafka_client_t*
ps_kafka_client_new_consumer(const ps_kafka_conf_t* user_conf,
                             const char* const* topics,
                             size_t topic_count)
{
    if (!user_conf || !user_conf->bootstrap_servers ||
        !user_conf->group_id || !topics || topic_count == 0)
        return NULL;

    ps_kafka_client_t* c = (ps_kafka_client_t*)calloc(1, sizeof(*c));
    if (!c) return NULL;

    _ps_zero(&c->metrics, sizeof(c->metrics));
    memcpy(&c->cfg, user_conf, sizeof(*user_conf));
    c->is_producer = false;

    char errstr[512];
    rd_kafka_conf_t* conf = _ps_build_rk_conf(user_conf, false,
                                              errstr, sizeof(errstr));
    if (!conf) {
        fprintf(stderr, "ps_kafka: config error: %s\n", errstr);
        free(c);
        return NULL;
    }

    c->rk = rd_kafka_new(RD_KAFKA_CONSUMER, conf,
                         errstr, sizeof(errstr));
    if (!c->rk) {
        fprintf(stderr, "ps_kafka: consumer init failed: %s\n", errstr);
        rd_kafka_conf_destroy(conf);
        free(c);
        return NULL;
    }

    /* Tell librdkafka to manage offsets */
    rd_kafka_poll_set_consumer(c->rk);

    /* Build topic subscription list */
    rd_kafka_topic_partition_list_t* subscription =
        rd_kafka_topic_partition_list_new((int)topic_count);

    for (size_t i = 0; i < topic_count; ++i)
        rd_kafka_topic_partition_list_add(subscription, topics[i],
                                          RD_KAFKA_PARTITION_UA);

    rd_kafka_resp_err_t suberr = rd_kafka_subscribe(c->rk, subscription);
    rd_kafka_topic_partition_list_destroy(subscription);

    if (suberr) {
        fprintf(stderr, "ps_kafka: subscribe failed: %s\n",
                rd_kafka_err2str(suberr));
        rd_kafka_destroy(c->rk);
        free(c);
        return NULL;
    }

    return c;
}

/* ------------------- Produce API --------------------------------------- */
static inline ps_kafka_code_t
ps_kafka_produce(ps_kafka_client_t* client,
                 const char* topic,
                 const void* payload,
                 size_t len,
                 bool copy,
                 int32_t partition)
{
    if (!client || !client->is_producer || !topic)
        return PS_KAFKA_INVALID_ARG;

    rd_kafka_resp_err_t err;
    rd_kafka_topic_t* rkt = rd_kafka_topic_new(client->rk, topic, NULL);
    if (!rkt) {
        fprintf(stderr, "ps_kafka: topic creation failed: %s\n",
                rd_kafka_err2str(rd_kafka_last_error()));
        return PS_KAFKA_ERR;
    }

    err = rd_kafka_produce(rkt,
                           partition,
                           copy ? RD_KAFKA_MSG_F_COPY : 0,
                           (void*)payload,
                           len,
                           NULL, 0,
                           NULL);

    if (!err) {
        client->metrics.messages_produced++;
        rd_kafka_topic_destroy(rkt);
        return PS_KAFKA_OK;
    }

    /* Error handling */
    if (err == RD_KAFKA_RESP_ERR__QUEUE_FULL) {
        rd_kafka_poll(client->rk, 0);  /* Make space */
        rd_kafka_topic_destroy(rkt);
        return PS_KAFKA_QUEUE_FULL;
    } else {
        client->metrics.messages_failed++;
        fprintf(stderr, "ps_kafka: produce failure: %s\n",
                rd_kafka_err2str(err));
        rd_kafka_topic_destroy(rkt);
        return PS_KAFKA_ERR;
    }
}

/* ------------------- Polling ------------------------------------------- */
static inline int
ps_kafka_poll(ps_kafka_client_t* client, int timeout_ms)
{
    if (!client) return 0;
    return rd_kafka_poll(client->rk, timeout_ms);
}

/* ------------------- Consume API --------------------------------------- */
static inline rd_kafka_message_t*
ps_kafka_consume(ps_kafka_client_t* client, int timeout_ms)
{
    if (!client || client->is_producer)
        return NULL;

    rd_kafka_message_t* msg = rd_kafka_consumer_poll(client->rk,
                                                     timeout_ms);
    if (!msg)
        return NULL;

    if (msg->err) {
        /* Application may decide to handle end-of-partition, etc. */
        if (msg->err != RD_KAFKA_RESP_ERR__PARTITION_EOF)
            fprintf(stderr, "ps_kafka: consume error: %s\n",
                    rd_kafka_message_errstr(msg));
    } else {
        client->metrics.messages_consumed++;
        client->metrics.bytes_consumed += msg->len;
    }

    return msg;
}

/* ------------------- Commit Offsets ------------------------------------ */
static inline ps_kafka_code_t
ps_kafka_commit(ps_kafka_client_t* client,
                const rd_kafka_message_t* rkmsg,
                bool async)
{
    if (!client || client->is_producer || !rkmsg)
        return PS_KAFKA_INVALID_ARG;

    rd_kafka_resp_err_t err =
        rd_kafka_commit_message(client->rk, rkmsg,
                                async ? RD_KAFKA_COMMIT_ASYNC :
                                        RD_KAFKA_COMMIT_SYNC);
    if (err) {
        fprintf(stderr, "ps_kafka: commit failed: %s\n",
                rd_kafka_err2str(err));
        return PS_KAFKA_ERR;
    }
    return PS_KAFKA_OK;
}

/* ------------------- Metrics Snapshot ---------------------------------- */
static inline ps_kafka_metrics_t
ps_kafka_metrics_snapshot(ps_kafka_client_t* client, bool reset)
{
    ps_kafka_metrics_t snap;
    if (!client) {
        _ps_zero(&snap, sizeof(snap));
        return snap;
    }

    snap = client->metrics;
    if (reset)
        _ps_zero(&client->metrics, sizeof(client->metrics));

    /* Retrieve consumer lag via watermark if possible */
    if (!client->is_producer) {
        rd_kafka_message_t* msg = rd_kafka_consumer_poll(client->rk, 0);
        if (!msg)
            ; /* keep previous lag */
        else {
            if (!msg->err) {
                int64_t hi, lo;
                if (!rd_kafka_get_watermark_offsets(client->rk,
                        rd_kafka_topic_name(msg->rkt),
                        msg->partition, &lo, &hi))
                    snap.consumer_lag = (double)(hi - msg->offset - 1);
            }
            rd_kafka_message_destroy(msg);
        }
    }

    return snap;
}

/* ------------------- Destruction --------------------------------------- */
static inline void
ps_kafka_client_destroy(ps_kafka_client_t* client, int timeout_ms)
{
    if (!client) return;

    if (client->is_producer) {
        /* Wait for outstanding messages */
        rd_kafka_flush(client->rk, timeout_ms);
    } else {
        rd_kafka_consumer_close(client->rk);
    }

    rd_kafka_destroy(client->rk);
    free(client);
}

/* ========================================================================= */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PS_KAFKA_CLIENT_H_ */
