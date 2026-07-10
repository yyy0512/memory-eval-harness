```c
/***************************************************************************
 *  PulseSphere – Real-Time Social Pulse Streaming Platform                *
 *  Ingestion Service – Entry point                                        *
 *                                                                         *
 *  File:    pulsesphere/services/ingestion_service/src/main.c             *
 *  License: MIT (see LICENSE file)                                        *
 *                                                                         *
 *  Description:                                                           *
 *  --------------------------------------------------------------------   *
 *  Listens for TCP streams containing newline-delimited JSON events       *
 *  representing “social pulses”. Validates, timestamps, and forwards      *
 *  events to the internal event fabric.                                   *
 *                                                                         *
 *  Design highlights                                                      *
 *  --------------------------------------------------------------------   *
 *    • Event driven, multi-threaded (listener + worker pool)              *
 *    • Back-pressure aware bounded queue                                  *
 *    • Graceful shutdown on SIGINT/SIGTERM                                *
 *    • Minimal external dependencies (POSIX + stdlib)                     *
 ***************************************************************************/

#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* --------------------------------------------------------------------- */
/*                             Configuration                             */
/* --------------------------------------------------------------------- */

#define ING_DEFAULT_PORT      7070
#define ING_DEFAULT_WORKERS   4
#define ING_QUEUE_CAPACITY    16384   /* power of 2 for cheaper modulo   */
#define MAX_EVENT_SIZE        2048    /* bytes per JSON line             */

/* --------------------------------------------------------------------- */
/*                               Logging                                 */
/* --------------------------------------------------------------------- */

static pthread_mutex_t log_mu = PTHREAD_MUTEX_INITIALIZER;

#define LOG_LEVEL_INFO    1
#define LOG_LEVEL_WARN    2
#define LOG_LEVEL_ERR     3

static int LOG_LEVEL = LOG_LEVEL_INFO;

#define LOG(level, fmt, ...)                                                \
    do {                                                                    \
        if (level >= LOG_LEVEL) {                                           \
            pthread_mutex_lock(&log_mu);                                    \
            const char *lbl = (level == LOG_LEVEL_ERR)  ? "ERR" :           \
                               (level == LOG_LEVEL_WARN) ? "WRN" : "INF";   \
            struct timeval tv; gettimeofday(&tv, NULL);                     \
            struct tm tm; localtime_r(&tv.tv_sec, &tm);                     \
            fprintf(stderr, "%02d:%02d:%02d.%03ld [%s] " fmt "\n",          \
                    tm.tm_hour, tm.tm_min, tm.tm_sec, tv.tv_usec/1000,      \
                    lbl, ##__VA_ARGS__);                                    \
            fflush(stderr);                                                 \
            pthread_mutex_unlock(&log_mu);                                  \
        }                                                                   \
    } while (0)

/* --------------------------------------------------------------------- */
/*                             Data Model                                */
/* --------------------------------------------------------------------- */

typedef struct {
    char     payload[MAX_EVENT_SIZE];
    uint64_t recv_ts_unix_ms;   /* epoch-ms when received  */
} pulse_event_t;

/* --------------------------------------------------------------------- */
/*                          Bounded MPMC Queue                           */
/* --------------------------------------------------------------------- */

typedef struct {
    pulse_event_t          ring[ING_QUEUE_CAPACITY];
    atomic_uint_fast64_t   head;           /* next item to be written    */
    atomic_uint_fast64_t   tail;           /* next item to be read       */
    pthread_mutex_t        mu;             /* used for cond wait         */
    pthread_cond_t         cv_nonempty;
    pthread_cond_t         cv_nonfull;
} pulse_queue_t;

static void q_init(pulse_queue_t *q)
{
    atomic_init(&q->head, 0);
    atomic_init(&q->tail, 0);
    pthread_mutex_init(&q->mu, NULL);
    pthread_cond_init(&q->cv_nonempty, NULL);
    pthread_cond_init(&q->cv_nonfull, NULL);
}

static void q_destroy(pulse_queue_t *q)
{
    pthread_mutex_destroy(&q->mu);
    pthread_cond_destroy(&q->cv_nonempty);
    pthread_cond_destroy(&q->cv_nonfull);
}

static bool q_is_full(const pulse_queue_t *q)
{
    return (atomic_load_explicit(&q->head, memory_order_acquire) -
            atomic_load_explicit(&q->tail, memory_order_acquire)) >= ING_QUEUE_CAPACITY;
}

static bool q_is_empty(const pulse_queue_t *q)
{
    return atomic_load_explicit(&q->head, memory_order_acquire) ==
           atomic_load_explicit(&q->tail, memory_order_acquire);
}

/* Block if full */
static void q_push(pulse_queue_t *q, const pulse_event_t *ev, atomic_bool *running)
{
    pthread_mutex_lock(&q->mu);
    while (q_is_full(q) && atomic_load(running)) {
        pthread_cond_wait(&q->cv_nonfull, &q->mu);
    }

    if (!atomic_load(running)) { /* service shutting down */
        pthread_mutex_unlock(&q->mu);
        return;
    }

    uint64_t pos = atomic_load_explicit(&q->head, memory_order_relaxed);
    q->ring[pos & (ING_QUEUE_CAPACITY - 1)] = *ev;
    atomic_fetch_add_explicit(&q->head, 1, memory_order_release);

    pthread_cond_signal(&q->cv_nonempty);
    pthread_mutex_unlock(&q->mu);
}

/* Block if empty */
static bool q_pop(pulse_queue_t *q, pulse_event_t *ev, atomic_bool *running)
{
    pthread_mutex_lock(&q->mu);
    while (q_is_empty(q) && atomic_load(running)) {
        pthread_cond_wait(&q->cv_nonempty, &q->mu);
    }

    if (q_is_empty(q) && !atomic_load(running)) {
        pthread_mutex_unlock(&q->mu);
        return false;  /* graceful drain finished */
    }

    uint64_t pos = atomic_load_explicit(&q->tail, memory_order_relaxed);
    *ev = q->ring[pos & (ING_QUEUE_CAPACITY - 1)];
    atomic_fetch_add_explicit(&q->tail, 1, memory_order_release);

    pthread_cond_signal(&q->cv_nonfull);
    pthread_mutex_unlock(&q->mu);
    return true;
}

/* --------------------------------------------------------------------- */
/*                       Runtime / Global State                           */
/* --------------------------------------------------------------------- */
typedef struct {
    uint16_t         port;
    unsigned         n_workers;
} ing_cfg_t;

typedef struct {
    ing_cfg_t        cfg;
    int              listen_fd;
    atomic_bool      running;
    pulse_queue_t    queue;
    pthread_t       *workers;
} ing_ctx_t;

static ing_ctx_t g_ctx;

/* --------------------------------------------------------------------- */
/*                   Simple JSON “Validation” Stub                       */
/*  For production, integrate a proper streaming JSON validator.         */
/* --------------------------------------------------------------------- */
static bool json_validate_quick(const char *json_line)
{
    /* Cheap well-formedness heuristic – matches braces and quotes count */
    int  brace = 0;
    bool in_str = false;

    for (const char *p = json_line; *p; ++p) {
        if (*p == '"' && (p == json_line || *(p-1) != '\\'))
            in_str = !in_str;
        else if (!in_str) {
            if (*p == '{') brace++;
            else if (*p == '}') brace--;
        }
    }
    return brace == 0 && !in_str;
}

/* --------------------------------------------------------------------- */
/*                          Event Publisher                              */
/* --------------------------------------------------------------------- */
/* In a real build this would be an adapter to Kafka, NATS, Pulsar, etc. */

static void publish_to_fabric(const pulse_event_t *ev)
{
    /* For demonstration, we just print to stdout (could be replaced) */
    fwrite(ev->payload, 1, strnlen(ev->payload, MAX_EVENT_SIZE), stdout);
    fputs("\n", stdout);
    fflush(stdout);
}

/* --------------------------------------------------------------------- */
/*                          Worker Thread                                */
/* --------------------------------------------------------------------- */

static void *worker_thread(void *arg)
{
    ing_ctx_t *ctx = (ing_ctx_t *)arg;
    pulse_event_t ev;

    while (q_pop(&ctx->queue, &ev, &ctx->running)) {
        /* 1. Validate JSON */
        if (!json_validate_quick(ev.payload)) {
            LOG(LOG_LEVEL_WARN, "Dropping invalid JSON: %.*s",
                    80, ev.payload);
            continue;
        }

        /* 2. (Optional) Transform / enrich here */

        /* 3. Forward to event fabric */
        publish_to_fabric(&ev);
    }
    return NULL;
}

/* --------------------------------------------------------------------- */
/*                    Socket Utility & Listener Thread                   */
/* --------------------------------------------------------------------- */

static int make_socket_nonblock(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags == -1) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static int create_listener(uint16_t port)
{
    int fd = socket(AF_INET6, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }

    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in6 addr = {0};
    addr.sin6_family = AF_INET6;
    addr.sin6_addr   = in6addr_any;
    addr.sin6_port   = htons(port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(fd);
        return -1;
    }

    if (listen(fd, 256) < 0) {
        perror("listen");
        close(fd);
        return -1;
    }

    if (make_socket_nonblock(fd) < 0) {
        perror("nonblock");
        close(fd);
        return -1;
    }

    return fd;
}

static void *listener_thread(void *arg)
{
    ing_ctx_t *ctx = (ing_ctx_t *)arg;

    while (atomic_load(&ctx->running)) {
        struct sockaddr_storage cli_addr;
        socklen_t               cli_len = sizeof(cli_addr);

        int cli_fd = accept(ctx->listen_fd,
                            (struct sockaddr *)&cli_addr, &cli_len);
        if (cli_fd < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                /* no pending connections */
                usleep(25 * 1000); /* 25ms */
                continue;
            }
            if (errno == EINTR) continue;
            perror("accept");
            break;
        }

        LOG(LOG_LEVEL_INFO, "Accepted connection fd=%d", cli_fd);

        /* Handle connection in current thread for simplicity (could spawn) */
        char buffer[MAX_EVENT_SIZE];
        ssize_t n;
        size_t  len = 0;

        while (atomic_load(&ctx->running) &&
               (n = read(cli_fd, buffer + len, sizeof(buffer) - len - 1)) > 0) {

            len += (size_t)n;
            buffer[len] = '\0';

            char *start = buffer;
            char *newline;
            while ((newline = strchr(start, '\n')) != NULL) {

                size_t line_len = (size_t)(newline - start);
                if (line_len >= MAX_EVENT_SIZE) {
                    LOG(LOG_LEVEL_WARN, "Discarding over-sized line (%zu bytes)", line_len);
                } else {
                    pulse_event_t ev;
                    memcpy(ev.payload, start, line_len);
                    ev.payload[line_len] = '\0';

                    struct timespec ts;
                    clock_gettime(CLOCK_REALTIME, &ts);
                    ev.recv_ts_unix_ms = (uint64_t)ts.tv_sec * 1000ULL +
                                         (uint64_t)ts.tv_nsec / 1000000ULL;

                    q_push(&ctx->queue, &ev, &ctx->running);
                }
                start = newline + 1;
            }

            if (start != buffer) {
                /* Move remaining data to beginning */
                len = strlen(start);
                memmove(buffer, start, len);
            }
        }

        close(cli_fd);
        LOG(LOG_LEVEL_INFO, "Connection fd=%d closed", cli_fd);
    }
    return NULL;
}

/* --------------------------------------------------------------------- */
/*                        Graceful Shutdown                              */
/* --------------------------------------------------------------------- */

static void on_signal(int signo)
{
    (void) signo;
    atomic_store(&g_ctx.running, false);
    shutdown(g_ctx.listen_fd, SHUT_RDWR); /* unblock accept */
    close(g_ctx.listen_fd);
    pthread_cond_broadcast(&g_ctx.queue.cv_nonempty);
    pthread_cond_broadcast(&g_ctx.queue.cv_nonfull);
    LOG(LOG_LEVEL_INFO, "Shutdown signal received");
}

/* --------------------------------------------------------------------- */
/*                             Main                                      */
/* --------------------------------------------------------------------- */

static void usage(const char *prog)
{
    printf("Usage: %s [-p port] [-w workers] [-v]\n", prog);
    puts("Options:");
    puts("  -p, --port     Port to listen on (default 7070)");
    puts("  -w, --workers  Number of worker threads (default 4)");
    puts("  -v, --verbose  Increase log verbosity");
}

int main(int argc, char *argv[])
{
    memset(&g_ctx, 0, sizeof(g_ctx));
    g_ctx.cfg.port     = ING_DEFAULT_PORT;
    g_ctx.cfg.n_workers = ING_DEFAULT_WORKERS;

    static const struct option long_opts[] = {
        {"port",    required_argument, 0, 'p'},
        {"workers", required_argument, 0, 'w'},
        {"verbose", no_argument,       0, 'v'},
        {"help",    no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };

    int opt, idx;
    while ((opt = getopt_long(argc, argv, "p:w:vh", long_opts, &idx)) != -1) {
        switch (opt) {
            case 'p': g_ctx.cfg.port     = (uint16_t)atoi(optarg); break;
            case 'w': g_ctx.cfg.n_workers = (unsigned)atoi(optarg); break;
            case 'v': LOG_LEVEL = LOG_LEVEL_INFO; break;
            case 'h':
            default: usage(argv[0]); return EXIT_SUCCESS;
        }
    }

    LOG(LOG_LEVEL_INFO, "Starting Ingestion Service on port %d with %u workers",
            g_ctx.cfg.port, g_ctx.cfg.n_workers);

    /* set up signal handlers */
    struct sigaction sa = { .sa_handler = on_signal };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT,  &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    q_init(&g_ctx.queue);
    atomic_store(&g_ctx.running, true);

    /* open listening socket */
    g_ctx.listen_fd = create_listener(g_ctx.cfg.port);
    if (g_ctx.listen_fd < 0) {
        fprintf(stderr, "Failed to create listener on port %d\n", g_ctx.cfg.port);
        return EXIT_FAILURE;
    }

    /* spawn listener thread */
    pthread_t listener_tid;
    if (pthread_create(&listener_tid, NULL, listener_thread, &g_ctx) != 0) {
        perror("pthread_create listener");
        close(g_ctx.listen_fd);
        return EXIT_FAILURE;
    }

    /* spawn worker pool */
    g_ctx.workers = calloc(g_ctx.cfg.n_workers, sizeof(pthread_t));
    if (!g_ctx.workers) {
        perror("calloc");
        atomic_store(&g_ctx.running, false);
        pthread_join(listener_tid, NULL);
        close(g_ctx.listen_fd);
        return EXIT_FAILURE;
    }

    for (unsigned i = 0; i < g_ctx.cfg.n_workers; ++i) {
        if (pthread_create(&g_ctx.workers[i], NULL, worker_thread, &g_ctx) != 0) {
            perror("pthread_create worker");
            atomic_store(&g_ctx.running, false);
            /* join previously started threads */
            for (unsigned j = 0; j < i; ++j) pthread_join(g_ctx.workers[j], NULL);
            pthread_join(listener_tid, NULL);
            free(g_ctx.workers);
            close(g_ctx.listen_fd);
            return EXIT_FAILURE;
        }
    }

    /* wait for listener to exit */
    pthread_join(listener_tid, NULL);

    /* notify workers to finish */
    pthread_mutex_lock(&g_ctx.queue.mu);
    pthread_cond_broadcast(&g_ctx.queue.cv_nonempty);
    pthread_mutex_unlock(&g_ctx.queue.mu);

    for (unsigned i = 0; i < g_ctx.cfg.n_workers; ++i)
        pthread_join(g_ctx.workers[i], NULL);

    free(g_ctx.workers);
    q_destroy(&g_ctx.queue);

    LOG(LOG_LEVEL_INFO, "Ingestion Service terminated gracefully");
    return EXIT_SUCCESS;
}
```