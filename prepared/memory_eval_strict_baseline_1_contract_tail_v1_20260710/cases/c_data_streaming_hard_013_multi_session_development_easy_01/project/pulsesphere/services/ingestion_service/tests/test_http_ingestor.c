```c
/**
 * test_http_ingestor.c
 *
 * Functional & unit-tests for the HTTP ingestor component of PulseSphere’s
 * ingestion_service.  Tests spin up a miniature in-process HTTP server that
 * delivers deterministic payloads to the production ingestor implementation.
 *
 * Build (example):
 *   gcc -Wall -Wextra -pedantic -Og -pthread \
 *       -I../../include \
 *       test_http_ingestor.c -lcmocka -o test_http_ingestor
 *
 * The production libraries (libpulsesphere_ingestion, libpulsesphere_common…)
 * must be discoverable by the linker/run-time loader.
 */

#define _POSIX_C_SOURCE 200809L   /* for pthreads, clock_gettime, etc. */

#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>

#include "pulsesphere/common/event.h"
#include "pulsesphere/ingestion/http_ingestor.h"

/* -------------------------------------------------------------------------
 *  Minimal, single-threaded HTTP stub server
 * ------------------------------------------------------------------------- */

typedef struct http_test_server {
    int              listen_fd;
    int              port;              /* assigned port (host-order)        */
    const char      *payload;           /* JSON body                         */
    size_t           payload_len;
    int              status_code;       /* e.g. 200                          */
    pthread_t        thread;
    volatile int     stop_requested;
} http_test_server_t;

/* Utility: write() wrapper that keeps writing until all data is sent. */
static int send_all(int fd, const void *buf, size_t len) {
    const char *p = buf;
    while (len) {
        ssize_t rc = send(fd, p, len, 0);
        if (rc < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p   += rc;
        len -= (size_t)rc;
    }
    return 0;
}

static void *http_server_thread(void *arg) {
    http_test_server_t *srv = arg;

    struct sockaddr_in sa = {0};
    socklen_t           sa_len = sizeof(sa);

    srv->listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    assert_non_null(srv->listen_fd >= 0 ? (void *)1 : NULL);

    sa.sin_family      = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* 127.0.0.1 */
    sa.sin_port        = 0;                      /* dynamic port */

    assert_int_equal(bind(srv->listen_fd, (struct sockaddr *)&sa, sa_len), 0);
    assert_int_equal(listen(srv->listen_fd, 4), 0);

    /* Find assigned port so the client can connect. */
    assert_int_equal(getsockname(srv->listen_fd, (struct sockaddr *)&sa, &sa_len), 0);
    srv->port = ntohs(sa.sin_port);

    /* notify caller that server is ready */
    pthread_mutex_t   ready_mtx = PTHREAD_MUTEX_INITIALIZER;
    pthread_cond_t    ready_cv  = PTHREAD_COND_INITIALIZER;
    pthread_mutex_lock(&ready_mtx);
    pthread_cond_signal(&ready_cv);
    pthread_mutex_unlock(&ready_mtx);

    while (!srv->stop_requested) {
        int cli_fd = accept(srv->listen_fd, NULL, NULL);
        if (cli_fd < 0) {
            if (errno == EINTR) continue;
            break;
        }

        /* Read until blank line (request headers end) – we do not parse them. */
        char buf[1024];
        size_t matched = 0;
        const char *needle = "\r\n\r\n";
        while (matched < 4) {
            ssize_t rc = recv(cli_fd, buf, sizeof(buf), 0);
            if (rc <= 0) break;
            for (ssize_t i = 0; i < rc && matched < 4; ++i) {
                matched = (buf[i] == needle[matched]) ? matched + 1
                                                      : (buf[i] == '\r' ? 1 : 0);
            }
        }

        char header[256];
        int header_len = snprintf(header, sizeof header,
                                  "HTTP/1.1 %d %s\r\n"
                                  "Content-Type: application/json\r\n"
                                  "Content-Length: %zu\r\n"
                                  "Connection: close\r\n"
                                  "\r\n",
                                  srv->status_code,
                                  srv->status_code == 200 ? "OK" : "Bad Request",
                                  srv->payload_len);

        if (send_all(cli_fd, header, (size_t)header_len) < 0 ||
            send_all(cli_fd, srv->payload, srv->payload_len) < 0)
            ; /* ignore send errors in test server */

        close(cli_fd);
        break; /* Single-shot server – shut down after 1 request. */
    }

    close(srv->listen_fd);
    return NULL;
}

static void http_test_server_start(http_test_server_t *srv,
                                   const char         *payload,
                                   int                 status_code)
{
    memset(srv, 0, sizeof *srv);
    srv->payload      = payload;
    srv->payload_len  = strlen(payload);
    srv->status_code  = status_code;
    srv->stop_requested = 0;

    assert_int_equal(pthread_create(&srv->thread, NULL,
                                    http_server_thread, srv), 0);

    /* Wait until server thread sets port (simple spin-wait) */
    while (srv->port == 0) {
        sched_yield();
    }
}

static void http_test_server_stop(http_test_server_t *srv) {
    if (!srv) return;
    srv->stop_requested = 1;
    /* Connect once to break accept() if needed. */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        struct sockaddr_in sa = {
            .sin_family = AF_INET,
            .sin_port   = htons((uint16_t)srv->port),
            .sin_addr   = {.s_addr = htonl(INADDR_LOOPBACK)}
        };
        connect(fd, (struct sockaddr *)&sa, sizeof sa);
        close(fd);
    }

    pthread_join(srv->thread, NULL);
}

/* -------------------------------------------------------------------------
 *  Helpers
 * ------------------------------------------------------------------------- */

typedef struct {
    size_t expected;
    size_t seen;
} callback_ctx_t;

static void test_event_callback(const pulse_event_t *event, void *user_data) {
    (void)event;
    callback_ctx_t *ctx = user_data;
    ctx->seen++;
}

/* Convenience: build URL string */
static void make_url(char *buf, size_t cap, int port) {
    snprintf(buf, cap, "http://127.0.0.1:%d/", port);
}

/* Generate ND-JSON payload with N trivial events.  Caller frees. */
static char *generate_json_events(size_t n, size_t *out_len) {
    size_t cap = n * 64 + 1;
    char  *buf = malloc(cap);
    assert_non_null(buf);
    size_t off = 0;
    for (size_t i = 0; i < n; ++i) {
        int len = snprintf(buf + off, cap - off,
                           "{\"id\":%" PRIu64 ",\"type\":\"like\"}\n",
                           (uint64_t)i);
        off += (size_t)len;
    }
    if (out_len) *out_len = off;
    return buf;
}

/* -------------------------------------------------------------------------
 *  Test cases
 * ------------------------------------------------------------------------- */

static void test_http_ingestor_happy_path(void **state) {
    (void)state;
    const char *payload =
        "{\"id\":1,\"type\":\"like\"}\n"
        "{\"id\":2,\"type\":\"comment\"}\n"
        "{\"id\":3,\"type\":\"share\"}\n";

    http_test_server_t srv;
    http_test_server_start(&srv, payload, 200);

    char url[128];
    make_url(url, sizeof url, srv.port);

    callback_ctx_t ctx = {.expected = 3, .seen = 0};

    http_ingestor_t *ing = http_ingestor_create(url,
                                                /*batch_size=*/10,
                                                test_event_callback,
                                                &ctx);
    assert_non_null(ing);

    assert_int_equal(http_ingestor_start(ing), 0);

    /* Wait for ingest (busy wait for test simplicity) */
    for (int i = 0; i < 100 && ctx.seen < ctx.expected; ++i)
        usleep(20 * 1000); /* 20ms */

    assert_int_equal(ctx.seen, ctx.expected);

    assert_int_equal(http_ingestor_stop(ing), 0);
    http_ingestor_destroy(ing);
    http_test_server_stop(&srv);
}

static void test_http_ingestor_malformed_payload(void **state) {
    (void)state;
    const char *payload = "INVALID_JSON_BLOB";

    http_test_server_t srv;
    http_test_server_start(&srv, payload, 200);

    char url[128];
    make_url(url, sizeof url, srv.port);

    callback_ctx_t ctx = {0};

    http_ingestor_t *ing = http_ingestor_create(url, 8,
                                                test_event_callback, &ctx);
    assert_non_null(ing);

    /* Ingestor should detect malformed payload and return error. */
    assert_true(http_ingestor_start(ing) != 0);

    http_ingestor_destroy(ing);
    http_test_server_stop(&srv);
}

static void test_http_ingestor_connection_refused(void **state) {
    (void)state;
    const char *url = "http://127.0.0.1:59999/"; /* assume unused port */

    http_ingestor_t *ing = http_ingestor_create(url, 4,
                                                test_event_callback, NULL);
    assert_non_null(ing);

    assert_true(http_ingestor_start(ing) != 0);

    http_ingestor_destroy(ing);
}

static void test_http_ingestor_large_batch(void **state) {
    (void)state;
    const size_t N = 1000;
    size_t       payload_len;
    char        *payload = generate_json_events(N, &payload_len);

    http_test_server_t srv;
    http_test_server_start(&srv, payload, 200);

    char url[128];
    make_url(url, sizeof url, srv.port);

    callback_ctx_t ctx = {.expected = N, .seen = 0};

    http_ingestor_t *ing = http_ingestor_create(url, 256,
                                                test_event_callback, &ctx);
    assert_non_null(ing);

    assert_int_equal(http_ingestor_start(ing), 0);

    /* Wait up to ~3s */
    for (int i = 0; i < 300 && ctx.seen < ctx.expected; ++i)
        usleep(10 * 1000);

    assert_int_equal(ctx.seen, ctx.expected);

    http_ingestor_stop(ing);
    http_ingestor_destroy(ing);
    http_test_server_stop(&srv);
    free(payload);
}

/* -------------------------------------------------------------------------
 *  main()
 * ------------------------------------------------------------------------- */

int main(void) {
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_http_ingestor_happy_path),
        cmocka_unit_test(test_http_ingestor_malformed_payload),
        cmocka_unit_test(test_http_ingestor_connection_refused),
        cmocka_unit_test(test_http_ingestor_large_batch),
    };
    /* Ignore SIGPIPE so broken socket writes don’t terminate the test. */
    signal(SIGPIPE, SIG_IGN);
    return cmocka_run_group_tests(tests, NULL, NULL);
}
```