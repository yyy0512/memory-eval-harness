/*
 * PulseSphere Dashboard Service - WebSocket Server
 *
 * File: websocket_server.c
 * Description:
 *   High-throughput WebSocket broadcast server that streams curated
 *   “social pulse” events to real-time moderator dashboards.
 *
 *   This module uses libwebsockets (LWS) for protocol handling and an
 *   internal lock-protected ring buffer to decouple the high-frequency
 *   producer thread(s) from WebSocket I/O, while guaranteeing in-order
 *   delivery and bounded memory growth.
 *
 *   Only the most recent RING_SIZE events are kept in memory; older
 *   events are discarded in a sliding-window fashion.  Each connection
 *   maintains its own read cursor so late-joining clients receive the
 *   latest available history without impacting others.
 *
 * Build:
 *   gcc -Wall -O2 -pthread websocket_server.c -o websocket_server \
 *       `pkg-config --cflags --libs libwebsockets`
 *
 * (c) 2024 PulseSphere Contributors
 */

#define _GNU_SOURCE
#include <libwebsockets.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* --------------------------------------------------------------------------
 * Tunables
 * -------------------------------------------------------------------------- */
#define DEFAULT_LISTEN_PORT    8080
#define MAX_PAYLOAD_LEN        4096      /* maximum JSON payload length       */
#define RING_SIZE              2048      /* number of messages kept in memory */

#ifndef ARRAY_SIZE
# define ARRAY_SIZE(x) (sizeof(x) / sizeof((x)[0]))
#endif

/* --------------------------------------------------------------------------
 * Logging helpers
 * -------------------------------------------------------------------------- */
#define LOG_ERR(fmt, ...)  fprintf(stderr, "[ERR]  " fmt "\n", ##__VA_ARGS__)
#define LOG_WARN(fmt, ...) fprintf(stderr, "[WARN] " fmt "\n", ##__VA_ARGS__)
#define LOG_INFO(fmt, ...) fprintf(stdout, "[INFO] " fmt "\n", ##__VA_ARGS__)

/* --------------------------------------------------------------------------
 * Ring buffer holding JSON messages
 * -------------------------------------------------------------------------- */
typedef struct {
    char            *msg[RING_SIZE];       /* pointers to heap-allocated JSON  */
    unsigned long    seq[RING_SIZE];       /* corresponding sequence numbers   */
    unsigned long    next_seq;             /* next sequence # to assign        */
    size_t           head;                 /* slot index for next insertion    */
    size_t           count;                /* number of valid elements         */
    pthread_mutex_t  lock;
} ring_buffer_t;

/* ---- ring helpers ------------------------------------------------------- */
static void
ring_init(ring_buffer_t *rb)
{
    memset(rb, 0, sizeof(*rb));
    pthread_mutex_init(&rb->lock, NULL);
}

static void
ring_cleanup(ring_buffer_t *rb)
{
    pthread_mutex_lock(&rb->lock);
    for (size_t i = 0; i < rb->count; i++) {
        size_t idx = (rb->head + RING_SIZE - rb->count + i) % RING_SIZE;
        free(rb->msg[idx]);
        rb->msg[idx] = NULL;
    }
    rb->count = 0;
    pthread_mutex_unlock(&rb->lock);
    pthread_mutex_destroy(&rb->lock);
}

/*
 * Insert a new message into the ring buffer.
 * If the ring is full, the oldest message will be dropped.
 *
 * Caller must ensure `json` is heap-allocated (dup'ed) or can pass a
 * stack string – this function duplicates it internally and retains
 * ownership.  Returns 0 on success, ‑1 on OOM.
 */
static int
ring_push(ring_buffer_t *rb, const char *json)
{
    int rc = 0;
    char *dup = strndup(json, MAX_PAYLOAD_LEN);
    if (!dup) {
        LOG_ERR("ring_push(): Out of memory duplicating payload");
        return -1;
    }

    pthread_mutex_lock(&rb->lock);

    /* Evict oldest if full */
    if (rb->count == RING_SIZE) {
        size_t oldest_idx = (rb->head + RING_SIZE - rb->count) % RING_SIZE;
        free(rb->msg[oldest_idx]);
        rb->msg[oldest_idx] = NULL;
        rb->seq[oldest_idx] = 0;
        rb->count--;
    }

    rb->msg[rb->head] = dup;
    rb->seq[rb->head] = rb->next_seq++;
    rb->head = (rb->head + 1) % RING_SIZE;
    rb->count++;

    pthread_mutex_unlock(&rb->lock);
    return rc;
}

/*
 * Retrieve a message by sequence number.
 * If the message is not available (too old or not yet produced),
 * returns false.
 *
 * The caller must NOT free the returned pointer.
 */
static bool
ring_get_by_seq(ring_buffer_t *rb,
                unsigned long seq,
                const char   **json_out,
                size_t        *len_out)
{
    bool found = false;

    pthread_mutex_lock(&rb->lock);

    if (rb->count == 0) {
        goto out;
    }

    unsigned long earliest_seq = rb->next_seq - rb->count;
    if (seq < earliest_seq || seq >= rb->next_seq) {
        /* Not in buffer */
        goto out;
    }

    size_t offset = seq - earliest_seq;
    size_t idx = (rb->head + RING_SIZE - rb->count + offset) % RING_SIZE;
    *json_out = rb->msg[idx];
    *len_out  = strlen(rb->msg[idx]);
    found = true;

out:
    pthread_mutex_unlock(&rb->lock);
    return found;
}

/* --------------------------------------------------------------------------
 * Per-session & per-vhost data structures for libwebsockets
 * -------------------------------------------------------------------------- */
struct pss_dashboard {
    unsigned long    seq;       /* next sequence number to transmit */
};

struct vhd_dashboard {
    struct lws_context     *context;
    const struct lws_protocols *protocol;
    ring_buffer_t           ring;
    pthread_mutex_t         lock;    /* protects refcount                      */
    int                     conn_count;
};

/* --------------------------------------------------------------------------
 * Broadcast helper wrappers
 * -------------------------------------------------------------------------- */
static void
broadcast_to_all(struct vhd_dashboard *vhd)
{
    /* Inform libwebsockets that all clients should become writeable */
    lws_callback_on_writable_all_protocol(vhd->context, vhd->protocol);
}

/* --------------------------------------------------------------------------
 * libwebsockets callback
 * -------------------------------------------------------------------------- */
static int
callback_dashboard(struct lws *wsi,
                   enum lws_callback_reasons reason,
                   void *user,
                   void *in,
                   size_t len)
{
    struct pss_dashboard *pss = (struct pss_dashboard *)user;
    struct vhd_dashboard *vhd =
        (struct vhd_dashboard *)lws_protocol_vh_priv_get(
            lws_get_vhost(wsi), lws_get_protocol(wsi));

    unsigned char   buf[LWS_PRE + MAX_PAYLOAD_LEN];
    const char     *msg;
    size_t          msg_len;
    int             n;

    switch (reason) {
    case LWS_CALLBACK_PROTOCOL_INIT:
        /* One instance per vhost */
        vhd = lws_protocol_vh_priv_zalloc(lws_get_vhost(wsi),
                                          lws_get_protocol(wsi),
                                          sizeof(struct vhd_dashboard));
        if (!vhd)
            return -1;
        vhd->context  = lws_get_context(wsi);
        vhd->protocol = lws_get_protocol(wsi);
        ring_init(&vhd->ring);
        pthread_mutex_init(&vhd->lock, NULL);
        LOG_INFO("Dashboard protocol init");
        break;

    case LWS_CALLBACK_PROTOCOL_DESTROY:
        if (vhd) {
            ring_cleanup(&vhd->ring);
            pthread_mutex_destroy(&vhd->lock);
            LOG_INFO("Dashboard protocol destroy");
        }
        break;

    case LWS_CALLBACK_ESTABLISHED:
        /* Initialize per-session state */
        pthread_mutex_lock(&vhd->lock);
        vhd->conn_count++;
        pthread_mutex_unlock(&vhd->lock);

        /* start reading from the earliest message still stored */
        pss->seq = vhd->ring.next_seq - vhd->ring.count;
        LOG_INFO("Client connected, total=%d", vhd->conn_count);
        break;

    case LWS_CALLBACK_CLOSED:
    case LWS_CALLBACK_SERVER_WRITEABLE + 1:  /* alias for LWS_CALLBACK_CLOSED_HTTP? */
        pthread_mutex_lock(&vhd->lock);
        if (vhd->conn_count > 0)
            vhd->conn_count--;
        pthread_mutex_unlock(&vhd->lock);
        LOG_INFO("Client disconnected, total=%d", vhd->conn_count);
        break;

    case LWS_CALLBACK_SERVER_WRITEABLE:
        /* Send as many queued messages as we can */
        while (ring_get_by_seq(&vhd->ring, pss->seq, &msg, &msg_len)) {
            if (msg_len > MAX_PAYLOAD_LEN) {
                LOG_WARN("Payload too large, truncating");
                msg_len = MAX_PAYLOAD_LEN;
            }

            memcpy(&buf[LWS_PRE], msg, msg_len);

            n = lws_write(wsi, &buf[LWS_PRE], msg_len, LWS_WRITE_TEXT);
            if (n < (int)msg_len) {
                LOG_WARN("lws_write() partial (%d/%zu)", n, msg_len);
                return -1;
            }
            pss->seq++;

            /*
             * If more data remains for this client, request another write
             * callback so we don’t starve others.
             */
            if (!ring_get_by_seq(&vhd->ring, pss->seq, &msg, &msg_len))
                break;

            lws_callback_on_writable(wsi);
        }
        break;

    default:
        break;
    }

    return 0;
}

/* --------------------------------------------------------------------------
 * Public server API
 * -------------------------------------------------------------------------- */
typedef struct {
    struct lws_context *context;
    pthread_t           service_thread;
    atomic_bool         running;
} websocket_server_t;

/* ---- service thread ----------------------------------------------------- */
static void *
service_loop(void *arg)
{
    websocket_server_t *srv = arg;

    while (atomic_load(&srv->running)) {
        lws_service(srv->context, 50 /* ms timeout */);
    }

    /* Drain remaining events */
    lws_context_destroy(srv->context);
    return NULL;
}

/* ---- initialization ----------------------------------------------------- */
static int
server_start(websocket_server_t *srv, int port)
{
    struct lws_context_creation_info info;

    memset(&info, 0, sizeof(info));
    info.port = port;
    info.protocols = (struct lws_protocols[]) {
        {
            .name = "pulse-dashboard",
            .callback = callback_dashboard,
            .per_session_data_size = sizeof(struct pss_dashboard),
            .rx_buffer_size = MAX_PAYLOAD_LEN,
        },
        { NULL, NULL, 0, 0 } /* terminator */
    };
    info.gid = -1;
    info.uid = -1;
    info.options = LWS_SERVER_OPTION_VALIDATE_UTF8;

    srv->context = lws_create_context(&info);
    if (!srv->context) {
        LOG_ERR("Failed to create lws context");
        return -1;
    }

    atomic_init(&srv->running, true);

    if (pthread_create(&srv->service_thread, NULL, service_loop, srv) != 0) {
        LOG_ERR("Failed to start service thread: %s", strerror(errno));
        lws_context_destroy(srv->context);
        return -1;
    }

    LOG_INFO("WebSocket server started on port %d", port);
    return 0;
}

/* ---- shutdown ----------------------------------------------------------- */
static void
server_stop(websocket_server_t *srv)
{
    if (!srv || !srv->context)
        return;

    atomic_store(&srv->running, false);
    pthread_join(srv->service_thread, NULL);
    /* lws_context_destroy() is done in service_loop() */
    LOG_INFO("WebSocket server stopped");
}

/* ---- broadcast interface ------------------------------------------------ */
static int
server_broadcast(websocket_server_t *srv, const char *json)
{
    if (!srv || !srv->context || !json)
        return -1;

    struct vhd_dashboard *vhd =
        (struct vhd_dashboard *)lws_protocol_vh_priv_get(
            lws_get_vhost_by_name(srv->context, "default"),
            lws_get_protocol(srv->context));

    if (!vhd) {
        LOG_WARN("Broadcast failed: protocol not initialized yet");
        return -1;
    }

    if (ring_push(&vhd->ring, json) != 0)
        return -1;

    broadcast_to_all(vhd);
    return 0;
}

/* --------------------------------------------------------------------------
 * Graceful termination (SIGINT/SIGTERM)
 * -------------------------------------------------------------------------- */
static websocket_server_t g_srv;

static void
signal_handler(int signum)
{
    (void)signum;
    atomic_store(&g_srv.running, false);
}

/* --------------------------------------------------------------------------
 * Stand-alone executable for local testing
 * -------------------------------------------------------------------------- */
#ifdef PULSESPHERE_WEBSOCKET_SERVER_STANDALONE
int main(int argc, char **argv)
{
    int port = (argc > 1) ? atoi(argv[1]) : DEFAULT_LISTEN_PORT;

    signal(SIGINT,  signal_handler);
    signal(SIGTERM, signal_handler);

    if (server_start(&g_srv, port) != 0)
        return EXIT_FAILURE;

    /* Simple stdin → broadcast loop */
    char line[MAX_PAYLOAD_LEN];
    while (atomic_load(&g_srv.running) && fgets(line, sizeof(line), stdin)) {
        size_t len = strlen(line);
        if (len > 0 && line[len - 1] == '\n')
            line[len - 1] = '\0';
        server_broadcast(&g_srv, line);
    }

    server_stop(&g_srv);
    return EXIT_SUCCESS;
}
#endif /* PULSESPHERE_WEBSOCKET_SERVER_STANDALONE */

/*
 *  End of websocket_server.c
 */
