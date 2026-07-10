/**
 * PulseSphere Validation Service - Main Entry Point
 *
 * This micro-service consumes newline-delimited JSON “pulse” events from
 * stdin (or a named FIFO), performs schema validation, and streams the
 * curated events to stdout.  A configurable worker pool is used to keep up
 * with high-throughput input rates.  Metrics are reported to syslog on
 * shutdown.
 *
 * Build:
 *      cc -std=c11 -Wall -Wextra -pedantic -O2 -pthread \
 *          -o validation_service main.c -lcjson
 *
 * Runtime:
 *      ./validation_service -c /etc/pulsesphere/validation.conf < pulses.ndjson
 */

#define _GNU_SOURCE                     /* getline, asprintf */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <string.h>
#include <syslog.h>
#include <sys/stat.h>
#include <unistd.h>

#include "cjson/cJSON.h"               /* External dependency: https://github.com/DaveGamble/cJSON */

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

#define DEFAULT_CONCURRENCY     4
#define DEFAULT_QUEUE_CAPACITY  4096
#define DEFAULT_INPUT_FIFO      "-"     /* “-”  = stdin */

typedef struct {
    unsigned            concurrency;
    size_t              queue_capacity;
    char                input_path[PATH_MAX];
} ps_config_t;

/* Simple .conf reader: KEY=VALUE (#comment )                                  */
static int
config_load(const char *path, ps_config_t *cfg)
{
    FILE *fp = fopen(path, "r");
    if (!fp) {
        syslog(LOG_ERR, "Failed to open config '%s': %s", path, strerror(errno));
        return -1;
    }

    char *line = NULL;
    size_t n = 0;
    while (getline(&line, &n, fp) != -1) {
        char *p = line;
        while (*p == ' ' || *p == '\t') ++p;      /* trim leading spaces */
        if (*p == '#' || *p == '\n' || *p == '\0')
            continue;                             /* skip comments & blanks */

        char *eq = strchr(p, '=');
        if (!eq)
            continue;                             /* malformed, ignore */
        *eq = '\0';

        char *key = p;
        char *val = eq + 1;
        key[strcspn(key, " \t\n")] = '\0';        /* trim trailing */
        val[strcspn(val, " \t\r\n")] = '\0';

        if (strcasecmp(key, "concurrency") == 0)
            cfg->concurrency = (unsigned)strtoul(val, NULL, 10);
        else if (strcasecmp(key, "queue_capacity") == 0)
            cfg->queue_capacity = (size_t)strtoull(val, NULL, 10);
        else if (strcasecmp(key, "input_path") == 0)
            strncpy(cfg->input_path, val, sizeof(cfg->input_path) - 1);
    }
    free(line);
    fclose(fp);
    return 0;
}

/* -------------------------------------------------------------------------- */
/* Lock-Free(ish) Bounded Queue (MPSC)                                         */
/* -------------------------------------------------------------------------- */

/*
 * For simplicity & portability we implement a classic circular buffer guarded
 * by mutex/cond.  Producer: reader thread.  Consumers: worker threads.
 */

typedef struct {
    char               **data;
    size_t               capacity;

    size_t               head;
    size_t               tail;
    size_t               count;

    pthread_mutex_t      mtx;
    pthread_cond_t       not_empty;
    pthread_cond_t       not_full;

    bool                 shutting_down;
} ps_queue_t;

static int
queue_init(ps_queue_t *q, size_t capacity)
{
    q->data = calloc(capacity, sizeof(char*));
    if (!q->data)
        return -1;
    q->capacity = capacity;
    q->head = q->tail = q->count = 0;
    q->shutting_down = false;
    pthread_mutex_init(&q->mtx, NULL);
    pthread_cond_init(&q->not_empty, NULL);
    pthread_cond_init(&q->not_full, NULL);
    return 0;
}

static void
queue_destroy(ps_queue_t *q)
{
    pthread_mutex_destroy(&q->mtx);
    pthread_cond_destroy(&q->not_empty);
    pthread_cond_destroy(&q->not_full);
    for (size_t i = 0; i < q->capacity; ++i)
        free(q->data[i]);
    free(q->data);
}

/* Ownership of 'item' memory is transferred to queue */
static int
queue_push(ps_queue_t *q, char *item)
{
    int rc = 0;
    pthread_mutex_lock(&q->mtx);
    while (q->count == q->capacity && !q->shutting_down)
        pthread_cond_wait(&q->not_full, &q->mtx);

    if (q->shutting_down) {
        rc = -1;
        goto out;
    }

    q->data[q->tail] = item;
    q->tail = (q->tail + 1) % q->capacity;
    q->count++;
    pthread_cond_signal(&q->not_empty);
out:
    pthread_mutex_unlock(&q->mtx);
    return rc;
}

/* Returns NULL if shutting down and queue empty.  Caller must free item.      */
static char *
queue_pop(ps_queue_t *q)
{
    char *item = NULL;
    pthread_mutex_lock(&q->mtx);
    while (q->count == 0 && !q->shutting_down)
        pthread_cond_wait(&q->not_empty, &q->mtx);

    if (q->count) {
        item = q->data[q->head];
        q->head = (q->head + 1) % q->capacity;
        q->count--;
        pthread_cond_signal(&q->not_full);
    }
    pthread_mutex_unlock(&q->mtx);
    return item;
}

static void
queue_signal_shutdown(ps_queue_t *q)
{
    pthread_mutex_lock(&q->mtx);
    q->shutting_down = true;
    pthread_cond_broadcast(&q->not_empty);
    pthread_cond_broadcast(&q->not_full);
    pthread_mutex_unlock(&q->mtx);
}

/* -------------------------------------------------------------------------- */
/* Event Validation                                                            */
/* -------------------------------------------------------------------------- */

static const char *VALID_TYPES[] = {
    "LIKE", "COMMENT", "SHARE", "FOLLOW", "REACTION",
};
static const size_t VALID_TYPES_LEN = sizeof(VALID_TYPES) / sizeof(VALID_TYPES[0]);

static bool
is_valid_type(const char *type)
{
    for (size_t i = 0; i < VALID_TYPES_LEN; ++i)
        if (strcmp(type, VALID_TYPES[i]) == 0)
            return true;
    return false;
}

/**
 * Validate a single event.
 *
 * @param json_str    Null-terminated JSON blob.
 * @param err_buf     Buffer to receive error description.
 * @param err_len     Length of err_buf.
 * @return 0 if valid, -1 otherwise.
 */
static int
validate_event(const char *json_str, char *err_buf, size_t err_len)
{
    int rc = -1;
    cJSON *root = cJSON_Parse(json_str);
    if (!root) {
        snprintf(err_buf, err_len, "Invalid JSON");
        return -1;
    }

    /* Required fields ------------------------------------------------------ */
    cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "id");
    cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    cJSON *timestamp = cJSON_GetObjectItemCaseSensitive(root, "timestamp");
    cJSON *payload = cJSON_GetObjectItemCaseSensitive(root, "payload");

    if (!cJSON_IsString(id) || id->valuestring[0] == '\0') {
        snprintf(err_buf, err_len, "Missing/invalid 'id'");
        goto cleanup;
    }
    if (!cJSON_IsString(type) || !is_valid_type(type->valuestring)) {
        snprintf(err_buf, err_len, "Missing/invalid 'type'");
        goto cleanup;
    }
    if (!cJSON_IsNumber(timestamp) || timestamp->valuedouble <= 0) {
        snprintf(err_buf, err_len, "Missing/invalid 'timestamp'");
        goto cleanup;
    }
    if (!cJSON_IsObject(payload)) {
        snprintf(err_buf, err_len, "Missing/invalid 'payload'");
        goto cleanup;
    }

    /* Additional checks may be plugged in using Strategy Pattern here ...    */

    rc = 0;                        /* Success */
cleanup:
    cJSON_Delete(root);
    return rc;
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

typedef struct {
    atomic_ulong   total_received;
    atomic_ulong   total_valid;
    atomic_ulong   total_invalid;
} ps_metrics_t;

static ps_metrics_t metrics = {
    .total_received = 0,
    .total_valid    = 0,
    .total_invalid  = 0,
};

/* -------------------------------------------------------------------------- */
/* Worker Thread                                                               */
/* -------------------------------------------------------------------------- */

typedef struct {
    unsigned        id;
    ps_queue_t     *queue;
} worker_arg_t;

static void *
worker_thread(void *arg)
{
    worker_arg_t *w = arg;
    char errbuf[128];

    for (;;) {
        char *json_line = queue_pop(w->queue);
        if (!json_line)
            break;                          /* queue shutting down */

        atomic_fetch_add_explicit(&metrics.total_received, 1, memory_order_relaxed);

        if (validate_event(json_line, errbuf, sizeof(errbuf)) == 0) {
            /* Re-emit to stdout */
            fputs(json_line, stdout);
            fputc('\n', stdout);
            fflush(stdout);
            atomic_fetch_add_explicit(&metrics.total_valid, 1, memory_order_relaxed);
        } else {
            syslog(LOG_WARNING, "Worker %u: validation failed: %s | line='%.*s'",
                   w->id, errbuf, 120, json_line);
            atomic_fetch_add_explicit(&metrics.total_invalid, 1, memory_order_relaxed);
        }
        free(json_line);
    }
    return NULL;
}

/* -------------------------------------------------------------------------- */
/* Reader Thread                                                               */
/* -------------------------------------------------------------------------- */

typedef struct {
    ps_queue_t     *queue;
    int             fd;
} reader_arg_t;

static void *
reader_thread(void *arg)
{
    reader_arg_t *r = arg;
    FILE *stream = (r->fd == STDIN_FILENO) ? stdin : fdopen(r->fd, "r");
    if (!stream) {
        syslog(LOG_ERR, "Reader: fdopen failed: %s", strerror(errno));
        queue_signal_shutdown(r->queue);
        return NULL;
    }

    char *line = NULL;
    size_t n = 0;
    while (getline(&line, &n, stream) != -1) {
        /* Strip trailing newline */
        size_t len = strlen(line);
        if (len && (line[len-1] == '\n' || line[len-1] == '\r'))
            line[--len] = '\0';

        char *dup = strdup(line);
        if (!dup) {
            syslog(LOG_CRIT, "Reader: strdup failed: %s", strerror(errno));
            continue;
        }

        if (queue_push(r->queue, dup) != 0) {
            free(dup);  /* likely shutting down */
            break;
        }
    }
    free(line);
    queue_signal_shutdown(r->queue);
    if (stream != stdin)
        fclose(stream);
    return NULL;
}

/* -------------------------------------------------------------------------- */
/* Signal Handling                                                             */
/* -------------------------------------------------------------------------- */

static ps_queue_t *global_queue = NULL;

static void
signal_handler(int sig)
{
    (void)sig;
    if (global_queue)
        queue_signal_shutdown(global_queue);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

static void
print_usage(const char *prog)
{
    fprintf(stderr,
        "Usage: %s [-c CONFIG]\n"
        "Options:\n"
        "  -c CONFIG   Path to configuration file (default: /etc/pulsesphere/validation.conf)\n",
        prog);
}

int
main(int argc, char **argv)
{
    const char *config_path = "/etc/pulsesphere/validation.conf";

    int opt;
    while ((opt = getopt(argc, argv, "c:h")) != -1) {
        switch (opt) {
        case 'c':
            config_path = optarg;
            break;
        case 'h':
        default:
            print_usage(argv[0]);
            return EXIT_FAILURE;
        }
    }

    /* Open syslog early */
    openlog("pulse_validation_service", LOG_PID | LOG_CONS, LOG_DAEMON);

    /* Load configuration ---------------------------------------------------- */
    ps_config_t cfg = {
        .concurrency = DEFAULT_CONCURRENCY,
        .queue_capacity = DEFAULT_QUEUE_CAPACITY,
    };
    strncpy(cfg.input_path, DEFAULT_INPUT_FIFO, sizeof(cfg.input_path) - 1);

    if (access(config_path, R_OK) == 0 && config_load(config_path, &cfg) != 0)
        return EXIT_FAILURE;

    syslog(LOG_INFO, "Starting Validation Service: %u workers, queue=%zu, input='%s'",
           cfg.concurrency, cfg.queue_capacity, cfg.input_path);

    /* Create queue ---------------------------------------------------------- */
    ps_queue_t queue;
    if (queue_init(&queue, cfg.queue_capacity) != 0) {
        syslog(LOG_CRIT, "Failed to initialize queue");
        return EXIT_FAILURE;
    }
    global_queue = &queue;

    /* Signals --------------------------------------------------------------- */
    struct sigaction sa = { .sa_handler = signal_handler };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);

    /* Reader thread --------------------------------------------------------- */
    int fd = STDIN_FILENO;
    if (strcmp(cfg.input_path, "-") != 0) {
        fd = open(cfg.input_path, O_RDONLY | O_NONBLOCK);
        if (fd == -1) {
            syslog(LOG_CRIT, "Unable to open input '%s': %s", cfg.input_path, strerror(errno));
            queue_destroy(&queue);
            return EXIT_FAILURE;
        }
    }

    pthread_t reader_tid;
    reader_arg_t rarg = { .queue = &queue, .fd = fd };
    pthread_create(&reader_tid, NULL, reader_thread, &rarg);

    /* Worker threads -------------------------------------------------------- */
    pthread_t *workers = calloc(cfg.concurrency, sizeof(pthread_t));
    worker_arg_t *wargs = calloc(cfg.concurrency, sizeof(worker_arg_t));
    if (!workers || !wargs) {
        syslog(LOG_CRIT, "Allocation failure");
        queue_signal_shutdown(&queue);
        pthread_join(reader_tid, NULL);
        queue_destroy(&queue);
        return EXIT_FAILURE;
    }

    for (unsigned i = 0; i < cfg.concurrency; ++i) {
        wargs[i].id = i;
        wargs[i].queue = &queue;
        pthread_create(&workers[i], NULL, worker_thread, &wargs[i]);
    }

    /* Wait for threads ------------------------------------------------------ */
    pthread_join(reader_tid, NULL);
    for (unsigned i = 0; i < cfg.concurrency; ++i)
        pthread_join(workers[i], NULL);

    /* Report metrics -------------------------------------------------------- */
    unsigned long total   = atomic_load(&metrics.total_received);
    unsigned long valid   = atomic_load(&metrics.total_valid);
    unsigned long invalid = atomic_load(&metrics.total_invalid);

    syslog(LOG_INFO, "Validation Service stopped.  "
                     "Total=%lu Valid=%lu Invalid=%lu",
                     total, valid, invalid);

    /* Cleanup --------------------------------------------------------------- */
    queue_destroy(&queue);
    free(workers);
    free(wargs);
    closelog();
    return EXIT_SUCCESS;
}