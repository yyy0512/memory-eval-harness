/*
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * Kafka client wrapper for the Event Fabric
 *
 * This module provides a thin, opinionated wrapper around the excellent
 * librdkafka library.  It hides the noisy details of configuration, error
 * handling, and metrics tracking while exposing a small, easy-to-use API for
 * producing and consuming PulseSphere events.
 *
 * Author: PulseSphere Core Team
 * License: MIT
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <time.h>
#include <pthread.h>
#include <errno.h>
#include <signal.h>

#include <librdkafka/rdkafka.h>

#include "ps_kafka_client.h"   /* Public header associated with this source */
#include "ps_log.h"            /* Internal structured logging utilities      */

/* ------------------------------------------------------------------------- */
/* Constants & Helper Macros                                                 */
/* ------------------------------------------------------------------------- */
#define PS_KAFKA_CLIENT_NAME      "PulseSphere/1.0"
#define PS_RD_KAFKA_API_VERSION   rd_kafka_version()

#define CHECK_ABORT(cond, msg)                         \
    do {                                               \
        if (cond) {                                    \
            ps_log_error("%s: %s", (msg), strerror(errno)); \
            abort();                                   \
        }                                              \
    } while (0)

#define SAFE_FREE(ptr)     \
    do {                   \
        if (ptr) free(ptr);\
        ptr = NULL;        \
    } while (0)

/* ------------------------------------------------------------------------- */
/* Data Structures                                                           */
/* ------------------------------------------------------------------------- */

/* Internal opaque client structure */
struct ps_kafka_client_s {
    rd_kafka_t         *rk;                /* librdkafka client handle        */
    rd_kafka_conf_t    *rk_conf;           /* Config object                   */
    rd_kafka_topic_t   *rk_topic;          /* Cached topic handle (producer)  */
    rd_kafka_topic_conf_t *topic_conf;     /* Topic-level configuration       */
    char               *brokers;
    char               *topic_name;
    char               *group_id;          /* Non-NULL for consumer           */
    ps_kafka_mode_t     mode;
    int                 partition;         /* Used only for producer          */

    /* Metrics */
    atomic_ulong        msgs_inflight;
    atomic_ulong        msgs_sent;
    atomic_ulong        msgs_failed;

    /* Thread safety */
    pthread_mutex_t     lock;
};

/* ------------------------------------------------------------------------- */
/* Internal Forward Declarations                                             */
/* ------------------------------------------------------------------------- */
static void _dr_msg_cb(rd_kafka_t *rk,
                       const rd_kafka_message_t *rkmessage,
                       void *opaque);

static void _error_cb(rd_kafka_t *rk, int err,
                      const char *reason, void *opaque);

static int  _stats_cb(rd_kafka_t *rk, char *json,
                      size_t json_len, void *opaque);

static void _rebalance_cb(rd_kafka_t *rk,
                          rd_kafka_resp_err_t err,
                          rd_kafka_topic_partition_list_t *partitions,
                          void *opaque);

/* ------------------------------------------------------------------------- */
/* Utility Functions                                                         */
/* ------------------------------------------------------------------------- */

static char * _safe_strdup(const char *src)
{
    if (!src) return NULL;
    size_t len = strlen(src) + 1;
    char *dst = calloc(1, len);
    if (!dst) return NULL;
    memcpy(dst, src, len);
    return dst;
}

/* Convert librdkafka errors to string (makes static analyzers happy) */
static inline const char * _rd_err2str(rd_kafka_resp_err_t err)
{
    return rd_kafka_err2str(err);
}

/* ------------------------------------------------------------------------- */
/* Public API Implementation                                                 */
/* ------------------------------------------------------------------------- */

ps_kafka_client_t *
ps_kafka_client_new(const ps_kafka_conf_t *conf, ps_kafka_mode_t mode)
{
    if (!conf || !conf->brokers || !conf->topic) {
        ps_log_error("ps_kafka_client_new: invalid configuration");
        return NULL;
    }

    ps_kafka_client_t *client = calloc(1, sizeof(*client));
    if (!client) {
        ps_log_error("ps_kafka_client_new: out of memory");
        return NULL;
    }

    client->mode       = mode;
    client->brokers    = _safe_strdup(conf->brokers);
    client->topic_name = _safe_strdup(conf->topic);
    client->partition  = conf->partition;
    client->group_id   = (mode == PS_KAFKA_CONSUMER)
                         ? _safe_strdup(conf->group_id)
                         : NULL;

    /* Initialize mutex */
    pthread_mutex_init(&client->lock, NULL);

    /* Create global configuration */
    client->rk_conf = rd_kafka_conf_new();

    /* Set generic configurations */
    rd_kafka_conf_set(client->rk_conf, "bootstrap.servers", client->brokers, NULL, 0);
    rd_kafka_conf_set(client->rk_conf, "client.id", PS_KAFKA_CLIENT_NAME, NULL, 0);
    rd_kafka_conf_set(client->rk_conf, "message.max.bytes", "10485760", NULL, 0); /* 10MB */

    /* Register callbacks */
    rd_kafka_conf_set_dr_msg_cb(client->rk_conf, _dr_msg_cb);
    rd_kafka_conf_set_error_cb(client->rk_conf, _error_cb);
    rd_kafka_conf_set_stats_cb(client->rk_conf, _stats_cb);

    if (mode == PS_KAFKA_CONSUMER) {
        if (!client->group_id) {
            ps_log_error("ps_kafka_client_new: consumer requires group_id");
            ps_kafka_client_destroy(client);
            return NULL;
        }
        rd_kafka_conf_set(client->rk_conf, "group.id", client->group_id, NULL, 0);
        rd_kafka_conf_set(client->rk_conf, "enable.auto.commit", "false", NULL, 0);
        rd_kafka_conf_set(client->rk_conf, "auto.offset.reset", "earliest", NULL, 0);
        rd_kafka_conf_set_rebalance_cb(client->rk_conf, _rebalance_cb);
    }

    /* Create handle */
    char errstr[512];
    client->rk = rd_kafka_new((mode == PS_KAFKA_PRODUCER) ?
                               RD_KAFKA_PRODUCER : RD_KAFKA_CONSUMER,
                               client->rk_conf, errstr, sizeof(errstr));
    if (!client->rk) {
        ps_log_error("Failed to create rdkafka handle: %s", errstr);
        ps_kafka_client_destroy(client);
        return NULL;
    }

    /* topic-level configuration (producer only) */
    if (mode == PS_KAFKA_PRODUCER) {
        client->topic_conf = rd_kafka_topic_conf_new();
        rd_kafka_topic_conf_set(client->topic_conf,
                                "request.required.acks", "all",
                                NULL, 0);

        client->rk_topic = rd_kafka_topic_new(client->rk,
                                              client->topic_name,
                                              client->topic_conf);
        if (!client->rk_topic) {
            ps_log_error("Failed to create topic handle: %s",
                         rd_kafka_err2str(rd_kafka_last_error()));
            ps_kafka_client_destroy(client);
            return NULL;
        }
    } else {
        /* Consumer: subscribe to topic */
        rd_kafka_topic_partition_list_t *sub =
            rd_kafka_topic_partition_list_new(1);
        rd_kafka_topic_partition_list_add(sub,
                                          client->topic_name,
                                          RD_KAFKA_PARTITION_UA);
        rd_kafka_resp_err_t err =
            rd_kafka_subscribe(client->rk, sub);
        rd_kafka_topic_partition_list_destroy(sub);
        if (err) {
            ps_log_error("Failed to subscribe to %s: %s",
                         client->topic_name,
                         _rd_err2str(err));
            ps_kafka_client_destroy(client);
            return NULL;
        }
    }

    ps_log_info("Kafka client initialized (%s) — brokers=%s topic=%s",
                (mode == PS_KAFKA_PRODUCER) ? "producer" : "consumer",
                client->brokers, client->topic_name);
    return client;
}

int
ps_kafka_produce(ps_kafka_client_t *client,
                 const void *payload, size_t len,
                 const char *key, size_t key_len,
                 int flush_timeout_ms)
{
    if (!client || client->mode != PS_KAFKA_PRODUCER)
        return -EINVAL;

    if (!payload || len == 0)
        return -EINVAL;

    rd_kafka_resp_err_t err;
    int partition = (client->partition >= 0)
                    ? client->partition
                    : RD_KAFKA_PARTITION_UA;

    /* librdkafka makes its own copy, we can pass the pointer directly */
    err = rd_kafka_produce(
              client->rk_topic,
              partition,
              RD_KAFKA_MSG_F_COPY,
              (void *)payload, len,
              key, key_len,
              client /* opaque */);

    if (err) {
        ps_log_error("Produce failed: %s", _rd_err2str(err));
        atomic_fetch_add_explicit(&client->msgs_failed, 1, memory_order_relaxed);
        return -EIO;
    }

    atomic_fetch_add_explicit(&client->msgs_inflight, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&client->msgs_sent, 1, memory_order_relaxed);

    /* Poll to serve delivery reports */
    rd_kafka_poll(client->rk, 0);

    if (flush_timeout_ms > 0) {
        rd_kafka_flush(client->rk, flush_timeout_ms);
    }
    return 0;
}

int
ps_kafka_consume_poll(ps_kafka_client_t *client,
                      ps_kafka_msg_t *out,
                      int timeout_ms)
{
    if (!client || client->mode != PS_KAFKA_CONSUMER || !out)
        return -EINVAL;

    rd_kafka_message_t *rkmsg =
        rd_kafka_consumer_poll(client->rk, timeout_ms);

    if (!rkmsg)
        return 0; /* timeout */

    if (rkmsg->err) {
        if (rkmsg->err == RD_KAFKA_RESP_ERR__PARTITION_EOF) {
            /* Not an error, just end of partition */
            rd_kafka_message_destroy(rkmsg);
            return 0;
        }
        ps_log_error("Consume error: %s", _rd_err2str(rkmsg->err));
        rd_kafka_message_destroy(rkmsg);
        return -EIO;
    }

    /* Populate out structure (shallow copy) */
    out->payload  = rkmsg->payload;
    out->len      = rkmsg->len;
    out->key      = rkmsg->key;
    out->key_len  = rkmsg->key_len;
    out->partition= rkmsg->partition;
    out->offset   = rkmsg->offset;
    out->timestamp= rkmsg->timestamp;
    out->_priv    = rkmsg; /* stash to acknowledge later */

    return 1; /* one message available */
}

int
ps_kafka_consume_commit(ps_kafka_client_t *client,
                        const ps_kafka_msg_t *msg)
{
    if (!client || client->mode != PS_KAFKA_CONSUMER || !msg || !msg->_priv)
        return -EINVAL;

    rd_kafka_message_t *rkmsg = (rd_kafka_message_t *)msg->_priv;

    rd_kafka_resp_err_t err =
        rd_kafka_commit_message(client->rk, rkmsg, 0);
    rd_kafka_message_destroy(rkmsg);

    if (err) {
        ps_log_warn("Commit failed: %s", _rd_err2str(err));
        return -EIO;
    }
    return 0;
}

void
ps_kafka_client_destroy(ps_kafka_client_t *client)
{
    if (!client)
        return;

    if (client->mode == PS_KAFKA_PRODUCER && client->rk) {
        /* Block until all outstanding messages are delivered */
        ps_log_info("Flushing producer. in-flight=%lu",
                    atomic_load(&client->msgs_inflight));
        rd_kafka_flush(client->rk, 10 * 1000 /* 10s */);
    }

    if (client->rk_topic)
        rd_kafka_topic_destroy(client->rk_topic);

    if (client->rk) {
        if (client->mode == PS_KAFKA_CONSUMER) {
            rd_kafka_consumer_close(client->rk);
        }
        rd_kafka_destroy(client->rk);
    }

    SAFE_FREE(client->brokers);
    SAFE_FREE(client->topic_name);
    SAFE_FREE(client->group_id);

    pthread_mutex_destroy(&client->lock);
    SAFE_FREE(client);
}

/* ------------------------------------------------------------------------- */
/* Callback Implementations                                                  */
/* ------------------------------------------------------------------------- */

static void
_dr_msg_cb(rd_kafka_t *rk, const rd_kafka_message_t *rkmessage, void *opaque)
{
    (void)rk;

    ps_kafka_client_t *client = (ps_kafka_client_t *)opaque;
    atomic_fetch_sub_explicit(&client->msgs_inflight, 1, memory_order_relaxed);

    if (rkmessage->err) {
        ps_log_error("Delivery failed: %s",
                     _rd_err2str(rkmessage->err));
        atomic_fetch_add_explicit(&client->msgs_failed, 1, memory_order_relaxed);
    } else {
        ps_log_debug("Delivered message to %s [%d] at offset %ld",
                     rd_kafka_topic_name(rkmessage->rkt),
                     rkmessage->partition,
                     rkmessage->offset);
    }
}

static void
_error_cb(rd_kafka_t *rk, int err, const char *reason, void *opaque)
{
    (void)rk;
    (void)opaque;

    if (err == RD_KAFKA_RESP_ERR__ALL_BROKERS_DOWN) {
        ps_log_error("All brokers are down: %s", reason);
    } else {
        ps_log_warn("Kafka error (%d): %s", err, reason);
    }
}

static int
_stats_cb(rd_kafka_t *rk, char *json, size_t json_len, void *opaque)
{
    (void)rk;
    ps_kafka_client_t *client = (ps_kafka_client_t *)opaque;

    ps_log_debug("Kafka stats: %.*s", (int)json_len, json);

    /* You might publish these stats into the PulseSphere metrics bus */
    (void)client;
    return 0;
}

static void
_rebalance_cb(rd_kafka_t *rk,
              rd_kafka_resp_err_t err,
              rd_kafka_topic_partition_list_t *partitions,
              void *opaque)
{
    ps_kafka_client_t *client = (ps_kafka_client_t *)opaque;

    switch (err) {
    case RD_KAFKA_RESP_ERR__ASSIGN_PARTITIONS:
        ps_log_info("Assigned %d partitions", partitions->cnt);
        rd_kafka_assign(rk, partitions);
        break;

    case RD_KAFKA_RESP_ERR__REVOKE_PARTITIONS:
        ps_log_info("Revoked %d partitions", partitions->cnt);
        rd_kafka_assign(rk, NULL);
        break;

    default:
        ps_log_warn("Rebalance error: %s", _rd_err2str(err));
        rd_kafka_assign(rk, NULL);
        break;
    }

    (void)client;
}

/* ------------------------------------------------------------------------- */
/* Debug / Diagnostics                                                       */
/* ------------------------------------------------------------------------- */

void
ps_kafka_client_dump_metrics(const ps_kafka_client_t *client, FILE *out)
{
    if (!client) return;
    fprintf(out ? out : stderr,
            "[kafka] sent=%lu inflight=%lu failed=%lu\n",
            atomic_load(&client->msgs_sent),
            atomic_load(&client->msgs_inflight),
            atomic_load(&client->msgs_failed));
}

/* ------------------------------------------------------------------------- */
/* Signal Handling Helpers (optional)                                        */
/* ------------------------------------------------------------------------- */
static volatile sig_atomic_t _run = 1;

static void _sigterm(int sig)
{
    (void)sig;
    _run = 0;
}

void ps_kafka_install_signal_handlers(void)
{
    struct sigaction sa = {0};
    sa.sa_handler = _sigterm;
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
}

int ps_kafka_should_run(void)
{
    return _run;
}