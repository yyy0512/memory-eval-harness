/*
 * metric_agent.c
 *
 * CampusGuard EDU Monitor
 * -----------------------
 * System metric collection agent.  Periodically samples CPU, memory,
 * and network utilisation statistics from the local host and publishes
 * them on the internal event-bus so that dashboards, alert-rules, and
 * long-term archives can consume the data asynchronously.
 *
 * The agent is intended to run inside the Service-Mesh as a micro-
 * service.  It is therefore self-contained, starts its own worker
 * thread, performs robust error handling, and fails fast when resources
 * cannot be acquired.  The public interface is deliberately small so
 * that orchestrators can manage the agent just like any other task.
 *
 * Author: CampusGuard EDU Core Team
 * License: MIT
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h>
#include <time.h>
#include <sys/time.h>

#include "metric_agent.h"   /* Public header for this implementation   */
#include "event_bus.h"      /* Internal publish/subscribe message bus  */
#include "logger.h"         /* Structured, thread-safe logging utility */
#include "config.h"         /* Global configuration repository         */


/* ---------------------------------------------------------------------------
 * Internal constants
 * -------------------------------------------------------------------------*/
#define DEFAULT_SAMPLING_INTERVAL_MS   1000     /* 1 second                 */
#define NET_DEV_MAX_LINE               512
#define PROC_STAT_PATH                 "/proc/stat"
#define PROC_MEMINFO_PATH              "/proc/meminfo"
#define PROC_NET_DEV_PATH              "/proc/net/dev"

/* ---------------------------------------------------------------------------
 * Data structures
 * -------------------------------------------------------------------------*/

/* Private agent instance */
typedef struct
{
    pthread_t       thread;          /* Worker thread                               */
    bool            running;         /* Lifecycle flag                              */
    uint32_t        interval_ms;     /* Sampling interval in milliseconds           */

    /* Previous network counter snapshot for computing deltas */
    uint64_t        prev_rx_bytes;
    uint64_t        prev_tx_bytes;
} metric_agent_t;


/* ---------------------------------------------------------------------------
 * Static helpers / forward declarations
 * -------------------------------------------------------------------------*/
static void  *metric_worker(void *arg);

static int    read_cpu_usage(double *user_pct,
                             double *system_pct,
                             double *idle_pct);

static int    read_mem_usage(double *total_mb,
                             double *free_mb,
                             double *used_mb);

static int    read_net_usage(uint64_t *rx_bytes,
                             uint64_t *tx_bytes);

static uint64_t str_to_ull(const char *str);


/* ---------------------------------------------------------------------------
 * Public API implementation
 * -------------------------------------------------------------------------*/
metric_agent_handle_t metric_agent_create(const agent_cfg_t *cfg)
{
    metric_agent_t *agent = calloc(1, sizeof(metric_agent_t));
    if (!agent) {
        log_error("metric_agent: failed to allocate agent instance: %s",
                  strerror(errno));
        return NULL;
    }

    /* Use caller-supplied sampling interval where available */
    agent->interval_ms = (cfg && cfg->sampling_interval_ms)
                       ? cfg->sampling_interval_ms
                       : DEFAULT_SAMPLING_INTERVAL_MS;

    return (metric_agent_handle_t)agent;
}

int metric_agent_start(metric_agent_handle_t handle)
{
    metric_agent_t *agent = (metric_agent_t *)handle;
    if (!agent) {
        errno = EINVAL;
        return -1;
    }

    if (agent->running)
        return 0;   /* already running */

    agent->running = true;

    int rc = pthread_create(&agent->thread, NULL, metric_worker, agent);
    if (rc != 0) {
        agent->running = false;
        log_error("metric_agent: failed to spawn worker thread: %s",
                  strerror(rc));
        return -1;
    }

    log_info("metric_agent: started with interval=%u ms", agent->interval_ms);
    return 0;
}

int metric_agent_stop(metric_agent_handle_t handle)
{
    metric_agent_t *agent = (metric_agent_t *)handle;
    if (!agent) {
        errno = EINVAL;
        return -1;
    }

    if (!agent->running)
        return 0;   /* already stopped */

    agent->running = false;
    pthread_join(agent->thread, NULL);

    log_info("metric_agent: stopped");
    return 0;
}

void metric_agent_destroy(metric_agent_handle_t handle)
{
    metric_agent_t *agent = (metric_agent_t *)handle;
    if (!agent)
        return;

    /* Ensure worker thread is not active */
    if (agent->running)
        metric_agent_stop(handle);

    free(agent);
}


/* ---------------------------------------------------------------------------
 * Worker implementation
 * -------------------------------------------------------------------------*/
static void *metric_worker(void *arg)
{
    metric_agent_t *agent = (metric_agent_t *)arg;
    struct timespec sleep_spec = { 0 };

    while (agent->running) {
        cg_metric_sample_t sample = { 0 };
        int cpu_rc, mem_rc, net_rc;

        /* Timestamp */
        sample.timestamp_ms = (uint64_t) ( (uint64_t)time(NULL) * 1000 );

        /* --- CPU --- */
        cpu_rc = read_cpu_usage(&sample.cpu_user_pct,
                                &sample.cpu_system_pct,
                                &sample.cpu_idle_pct);

        /* --- Memory --- */
        mem_rc = read_mem_usage(&sample.mem_total_mb,
                                &sample.mem_free_mb,
                                &sample.mem_used_mb);

        /* --- Network --- */
        net_rc = read_net_usage(&sample.net_rx_bytes,
                                &sample.net_tx_bytes);

        /* Compute network deltas (bytes per sample period) */
        if (net_rc == 0) {
            if (agent->prev_rx_bytes != 0 || agent->prev_tx_bytes != 0) {
                sample.net_rx_delta = sample.net_rx_bytes - agent->prev_rx_bytes;
                sample.net_tx_delta = sample.net_tx_bytes - agent->prev_tx_bytes;
            }
            agent->prev_rx_bytes = sample.net_rx_bytes;
            agent->prev_tx_bytes = sample.net_tx_bytes;
        }

        /* Publish if all subsystems succeeded; else warn */
        if (cpu_rc == 0 && mem_rc == 0 && net_rc == 0) {
            event_bus_publish(EVENT_METRIC_SAMPLE,
                              &sample,
                              sizeof(sample));
        } else {
            log_warn("metric_agent: partial metric sample collected "
                     "(cpu=%d mem=%d net=%d)", cpu_rc, mem_rc, net_rc);
        }

        /* Sleep until next sampling tick */
        sleep_spec.tv_sec  = agent->interval_ms / 1000;
        sleep_spec.tv_nsec = (agent->interval_ms % 1000) * 1000000L;
        nanosleep(&sleep_spec, NULL);
    }

    return NULL;
}


/* ---------------------------------------------------------------------------
 * /proc parsing helpers
 * -------------------------------------------------------------------------*/

/* CPU utilisation --------------------------------------------------------- */

/*
 * The first line in /proc/stat:
 *
 *   cpu  4705 0 2253 106660 146 0 101 0 0 0
 *
 * Columns: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
 * We read the first four which are sufficient for aggregate utilisation.
 */
static int read_cpu_usage(double *user_pct,
                          double *system_pct,
                          double *idle_pct)
{
    FILE *fp = fopen(PROC_STAT_PATH, "r");
    if (!fp)
        return -1;

    char line[256];

    if (!fgets(line, sizeof(line), fp)) {
        fclose(fp);
        return -1;
    }
    fclose(fp);

    /* Parse */
    char label[5];
    uint64_t user = 0, nice = 0, system = 0, idle = 0;
    int ret = sscanf(line, "%4s %lu %lu %lu %lu",
                     label, &user, &nice, &system, &idle);

    if (ret != 5 || strcmp(label, "cpu") != 0)
        return -1;

    uint64_t total = user + nice + system + idle;
    if (total == 0)
        return -1;

    *user_pct   = (user   + nice ) * 100.0 / total;
    *system_pct = system * 100.0   / total;
    *idle_pct   = idle   * 100.0   / total;

    return 0;
}


/* Memory utilisation ------------------------------------------------------ */
static int read_mem_usage(double *total_mb,
                          double *free_mb,
                          double *used_mb)
{
    FILE *fp = fopen(PROC_MEMINFO_PATH, "r");
    if (!fp)
        return -1;

    char line[256];
    uint64_t mem_total_kb = 0,
             mem_free_kb  = 0,
             buffers_kb   = 0,
             cached_kb    = 0;

    while (fgets(line, sizeof(line), fp)) {
        if (sscanf(line, "MemTotal: %lu kB", &mem_total_kb) == 1) continue;
        if (sscanf(line, "MemFree:  %lu kB", &mem_free_kb)  == 1) continue;
        if (sscanf(line, "Buffers:  %lu kB", &buffers_kb)   == 1) continue;
        if (sscanf(line, "Cached:   %lu kB", &cached_kb)    == 1) continue;
    }
    fclose(fp);

    if (mem_total_kb == 0)
        return -1;

    uint64_t avail_free_kb = mem_free_kb + buffers_kb + cached_kb;
    uint64_t used_kb = mem_total_kb - avail_free_kb;

    *total_mb = mem_total_kb / 1024.0;
    *free_mb  = avail_free_kb / 1024.0;
    *used_mb  = used_kb / 1024.0;

    return 0;
}


/* Network utilisation ----------------------------------------------------- */
static int read_net_usage(uint64_t *rx_bytes,
                          uint64_t *tx_bytes)
{
    FILE *fp = fopen(PROC_NET_DEV_PATH, "r");
    if (!fp)
        return -1;

    char line[NET_DEV_MAX_LINE];
    int line_no = 0;
    uint64_t total_rx = 0, total_tx = 0;

    while (fgets(line, sizeof(line), fp)) {
        line_no++;

        /* Skip headers (first two lines) */
        if (line_no <= 2)
            continue;

        char iface[64];
        uint64_t iface_rx = 0, iface_tx = 0;

        /*
         * Example line:
         *   eth0:  213453  252  0 0 0 0 0 0  153432  351  0 0 0 0 0 0
         * We only need first (rx bytes) and ninth (tx bytes) columns.
         */
        int rc = sscanf(line,
                        " %63[^:]: %lu %*u %*u %*u %*u %*u %*u %*u %lu",
                        iface,
                        &iface_rx,
                        &iface_tx);

        if (rc != 3)
            continue;

        /* Ignore loopback */
        if (strcmp(iface, "lo") == 0)
            continue;

        total_rx += iface_rx;
        total_tx += iface_tx;
    }

    fclose(fp);

    *rx_bytes = total_rx;
    *tx_bytes = total_tx;

    return 0;
}


/* ---------------------------------------------------------------------------
 * Utility helpers
 * -------------------------------------------------------------------------*/
static uint64_t str_to_ull(const char *str)
{
    errno = 0;
    uint64_t v = strtoull(str, NULL, 10);
    if (errno != 0)
        return 0;
    return v;
}


/* ---------------------------------------------------------------------------
 * Fallback stubs (compile-time only)
 * -------------------------------------------------------------------------*/

/*
 * In unit-test or standalone builds, the real event-bus or logger may
 * not be linked.  Guard against linkage errors by providing weak
 * symbol stubs that are superseded when the full framework is linked.
 */
#ifndef HAVE_EVENT_BUS
__attribute__((weak))
int event_bus_publish(event_type_t type, const void *payload, size_t sz)
{
    (void)type; (void)payload; (void)sz;
    return 0;
}
#endif /* HAVE_EVENT_BUS */

#ifndef HAVE_LOGGER
__attribute__((weak))
void log_error(const char *fmt, ...)
{
    (void)fmt;
}

__attribute__((weak))
void log_warn(const char *fmt, ...)
{
    (void)fmt;
}

__attribute__((weak))
void log_info(const char *fmt, ...)
{
    (void)fmt;
}
#endif /* HAVE_LOGGER */


/* ---------------------------------------------------------------------------
 * End of file
 * -------------------------------------------------------------------------*/
