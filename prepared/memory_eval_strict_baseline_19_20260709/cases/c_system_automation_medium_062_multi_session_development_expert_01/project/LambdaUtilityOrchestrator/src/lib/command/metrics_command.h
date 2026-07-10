/*
 * LambdaUtility Orchestrator
 * File: src/lib/command/metrics_command.h
 *
 * Description:
 *   Concrete Command implementation responsible for harvesting host-level
 *   performance metrics (CPU, memory, disk I/O, and network statistics) and
 *   forwarding them to the configured metrics back-end.  The command complies
 *   with the generic Command interface used throughout the Orchestrator and is
 *   designed to be safely invoked from a short-lived, stateless AWS Lambda
 *   execution context.
 *
 *   Because the project links multiple commands together via the
 *   Chain-of-Responsibility pattern, a MetricsCommand object accepts an
 *   optional next command pointer and delegates control after successful
 *   completion, thereby allowing metrics collection to become one stage inside
 *   a larger automation flow (e.g., “collect metrics → archive logs → notify
 *   observers”).
 *
 *   NOTE:  This header is intentionally self-contained (header-only) since the
 *   Lambda build system collapses all object files into a single translation
 *   unit.  All non-trivial symbols are declared static inline to avoid multiple
 *   definition errors while remaining testable.
 */

#ifndef LUO_METRICS_COMMAND_H
#define LUO_METRICS_COMMAND_H

/* ---------------------------------------------------------------------------
 *  Dependencies
 * ------------------------------------------------------------------------- */
#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <curl/curl.h>          /* libcurl is available in the Lambda runtime */

#include "command.h"            /* Generic Command interface               */
#include "logger.h"             /* Project-wide structured logger           */

/* ---------------------------------------------------------------------------
 *  Public Data Structures
 * ------------------------------------------------------------------------- */

/*
 * metrics_bitmask_t
 *
 *   Bit-mask flags describing which metric families this command should
 *   harvest.  Any combination of bits may be set.
 */
typedef enum
{
    METRIC_CPU_USAGE        = 1u << 0,
    METRIC_MEM_USAGE        = 1u << 1,
    METRIC_DISK_IO          = 1u << 2,
    METRIC_NET_IO           = 1u << 3,
    METRIC_ALL              = 0xFFFFu
} metrics_bitmask_t;


/*
 * MetricsConfig
 *
 *   Configuration parameters consumed by MetricsCommand at construction time.
 */
typedef struct
{
    const char        *collector_endpoint;   /* e.g. https://metrics.acme.io  */
    uint32_t           scrape_interval_sec;  /* Interval advertised to server */
    metrics_bitmask_t  enabled_metrics;      /* Mask of metrics to gather     */
    uint32_t           post_timeout_ms;      /* curl timeout (network)        */
} MetricsConfig;


/*
 * MetricsCommand
 *
 *   Concrete command instance embedding the common Command interface.
 */
typedef struct MetricsCommand
{
    Command             base;       /* Must be first for “inheritance”       */
    MetricsConfig       cfg;        /* Immutable copy of configuration       */
    struct Command     *next;       /* Optional next command in chain        */
} MetricsCommand;


/* ---------------------------------------------------------------------------
 *  Forward Declarations (internal)
 * ------------------------------------------------------------------------- */
static void metrics_command_execute(Command *self, const void *payload);
static void metrics_command_destroy(Command *self);

static int  gather_cpu_usage(char *buf, size_t buf_sz);
static int  gather_mem_usage(char *buf, size_t buf_sz);
static int  gather_disk_io(char *buf, size_t buf_sz);
static int  gather_net_io(char *buf, size_t buf_sz);

static int  post_metrics_json(const MetricsConfig *cfg,
                              const char          *json_body);


/* ---------------------------------------------------------------------------
 *  Public API
 * ------------------------------------------------------------------------- */

/*
 * metrics_command_new
 *
 *   Allocates and initializes a new MetricsCommand instance.  The caller owns
 *   the returned pointer and must eventually invoke ->destroy() when the
 *   command is no longer required.
 *
 *   Returns: Pointer to Command interface on success, NULL on failure (errno
 *            will be set appropriately).
 */
static inline Command *
metrics_command_new(const MetricsConfig *user_cfg,
                    struct Command      *next /* nullable */ )
{
    if (!user_cfg || !user_cfg->collector_endpoint)
    {
        errno = EINVAL;
        return NULL;
    }

    MetricsCommand *cmd = calloc(1, sizeof(*cmd));
    if (!cmd)
        return NULL;

    /* Copy configuration defensively */
    cmd->cfg = *user_cfg;

    /* Duplicate endpoint string so we control lifetime */
    cmd->cfg.collector_endpoint = strdup(user_cfg->collector_endpoint);
    if (!cmd->cfg.collector_endpoint)
    {
        free(cmd);
        return NULL;
    }

    /* Populate Command vtable */
    cmd->base.execute = metrics_command_execute;
    cmd->base.destroy = metrics_command_destroy;
    cmd->base.context = cmd;               /* Back-pointer for convenience    */

    cmd->next         = next;

    return &cmd->base;
}


/* ---------------------------------------------------------------------------
 *  Implementation Details
 * ------------------------------------------------------------------------- */

/*
 * metrics_command_execute
 *
 *   Harvest metrics configured in `cfg`, serialize them into a single JSON
 *   document, and push the payload to the remote collector over HTTPS.
 *
 *   The ‘payload’ argument is currently unused but included for compatibility
 *   with the generic Command signature (some callers may supply additional
 *   runtime context in the future).
 */
static void
metrics_command_execute(Command *self, const void *payload /* UNUSED */ )
{
    (void)payload;

    assert(self && "MetricsCommand->execute called with NULL self");

    MetricsCommand *mc = self->context;
    const MetricsConfig *cfg = &mc->cfg;

    char            metric_buf[1024]  = {0};  /* temporary scratch            */
    char            json_payload[4096] = {0};
    size_t          offset             = 0;
    int             rc;

    /* Build JSON body manually (dependence on cJSON removed for minimal size) */
    offset += snprintf(json_payload + offset, sizeof(json_payload) - offset,
                       "{ \"timestamp\": %" PRIu64,
                       (uint64_t)time(NULL));

    /* CPU usage ----------------------------------------------------------- */
    if (cfg->enabled_metrics & METRIC_CPU_USAGE)
    {
        rc = gather_cpu_usage(metric_buf, sizeof(metric_buf));
        if (rc == 0)
        {
            offset += snprintf(json_payload + offset,
                               sizeof(json_payload) - offset,
                               ", \"cpu_usage\": %s", metric_buf);
        }
    }

    /* Memory usage -------------------------------------------------------- */
    if (cfg->enabled_metrics & METRIC_MEM_USAGE)
    {
        rc = gather_mem_usage(metric_buf, sizeof(metric_buf));
        if (rc == 0)
        {
            offset += snprintf(json_payload + offset,
                               sizeof(json_payload) - offset,
                               ", \"mem_usage\": %s", metric_buf);
        }
    }

    /* Disk I/O ------------------------------------------------------------ */
    if (cfg->enabled_metrics & METRIC_DISK_IO)
    {
        rc = gather_disk_io(metric_buf, sizeof(metric_buf));
        if (rc == 0)
        {
            offset += snprintf(json_payload + offset,
                               sizeof(json_payload) - offset,
                               ", \"disk_io\": %s", metric_buf);
        }
    }

    /* Network I/O --------------------------------------------------------- */
    if (cfg->enabled_metrics & METRIC_NET_IO)
    {
        rc = gather_net_io(metric_buf, sizeof(metric_buf));
        if (rc == 0)
        {
            offset += snprintf(json_payload + offset,
                               sizeof(json_payload) - offset,
                               ", \"net_io\": %s", metric_buf);
        }
    }

    /* Close JSON                                                          */
    snprintf(json_payload + offset,
             sizeof(json_payload) - offset,
             " }");

    /* Emit debug log (redacted endpoint for brevity)                       */
    logger_debug("[metrics_command] Posting metrics to %s (payload=%zuB)",
                 cfg->collector_endpoint, strlen(json_payload));

    /* POST metrics -------------------------------------------------------- */
    rc = post_metrics_json(cfg, json_payload);
    if (rc != 0)
    {
        logger_error("[metrics_command] Failed to POST metrics (rc=%d, errno=%d)",
                     rc, errno);
    }

    /* Chain-of-Responsibility: hand off to next command if present         */
    if (mc->next && mc->next->execute)
        mc->next->execute(mc->next, NULL);
}


/*
 * metrics_command_destroy
 *
 *   Releases resources owned by the command (heap allocations, etc.).
 */
static void
metrics_command_destroy(Command *self)
{
    if (!self)
        return;

    MetricsCommand *mc = self->context;

    if (mc->cfg.collector_endpoint)
        free((void *)mc->cfg.collector_endpoint);

    /* Recursively destroy the next command */
    if (mc->next && mc->next->destroy)
        mc->next->destroy(mc->next);

    free(mc);
}


/* ---------------------------------------------------------------------------
 *  Metric Gathering Helpers
 * ------------------------------------------------------------------------- */

/* Simplistic helpers that scrape /proc files.  Production deployments may
 * choose to compile alternative OS-specific implementations via #ifdef.      */

static int
gather_cpu_usage(char *buf, size_t buf_sz)
{
#if defined(__linux__)
    /*
     * /proc/stat:  The first line aggregates CPU usage since boot:
     *   cpu  3357 0 4313 1362393 0 0 0 ...
     * Columns: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
     *
     * We interpret CPU utilization over a short interval; for a Lambda that
     * spins up fresh, we cannot hold historical state, so we approximate by
     * reporting the instantaneous busy percentage over the last 100ms.
     */
    FILE *fp = fopen("/proc/stat", "r");
    if (!fp)
        return -1;

    char line[256];
    if (!fgets(line, sizeof(line), fp))
    {
        fclose(fp);
        return -1;
    }
    fclose(fp);

    unsigned long long user, nice, system, idle, iowait, irq, softirq, steal;
    if (sscanf(line, "cpu  %llu %llu %llu %llu %llu %llu %llu %llu",
               &user, &nice, &system, &idle, &iowait, &irq,
               &softirq, &steal) != 8)
        return -1;

    unsigned long long busy = user + nice + system + irq + softirq + steal;
    unsigned long long total = busy + idle + iowait;

    /* Basic percentage w/ integer math */
    double percent = (total == 0) ? 0.0 : ((double)busy / (double)total) * 100.0;
    snprintf(buf, buf_sz, "%.2f", percent);

    return 0;
#else
    (void)buf; (void)buf_sz;
    return -1;
#endif
}


static int
gather_mem_usage(char *buf, size_t buf_sz)
{
#if defined(__linux__)
    FILE *fp = fopen("/proc/meminfo", "r");
    if (!fp)
        return -1;

    unsigned long mem_total_kb = 0, mem_free_kb = 0, buffers_kb = 0, cached_kb = 0;
    char key[64];
    unsigned long value;
    char unit[32];

    while (fscanf(fp, "%63s %lu %31s\n", key, &value, unit) == 3)
    {
        if (strcmp(key, "MemTotal:") == 0)
            mem_total_kb = value;
        else if (strcmp(key, "MemFree:") == 0)
            mem_free_kb = value;
        else if (strcmp(key, "Buffers:") == 0)
            buffers_kb = value;
        else if (strcmp(key, "Cached:") == 0)
            cached_kb = value;
    }
    fclose(fp);

    if (mem_total_kb == 0)
        return -1;

    unsigned long used_kb = mem_total_kb - mem_free_kb - buffers_kb - cached_kb;
    double percent = ((double)used_kb / (double)mem_total_kb) * 100.0;

    snprintf(buf, buf_sz, "{\"total_kb\":%lu,\"used_kb\":%lu,\"used_pct\":%.2f}",
             mem_total_kb, used_kb, percent);
    return 0;
#else
    (void)buf; (void)buf_sz;
    return -1;
#endif
}


static int
gather_disk_io(char *buf, size_t buf_sz)
{
#if defined(__linux__)
    /* Read /proc/diskstats and aggregate read/write sectors over all devices */
    FILE *fp = fopen("/proc/diskstats", "r");
    if (!fp)
        return -1;

    unsigned long long read_sectors = 0, write_sectors = 0;
    char line[256];

    while (fgets(line, sizeof(line), fp))
    {
        unsigned int major, minor;
        char dev[32];
        unsigned long long reads, rd_merges, rd_sectors, rd_ticks;
        unsigned long long writes, wr_merges, wr_sectors, wr_ticks;

        int matched = sscanf(line,
                             "%u %u %31s %llu %llu %llu %llu %llu %llu %llu %llu",
                             &major, &minor, dev,
                             &reads, &rd_merges, &rd_sectors, &rd_ticks,
                             &writes, &wr_merges, &wr_sectors, &wr_ticks);
        if (matched >= 11)
        {
            read_sectors  += rd_sectors;
            write_sectors += wr_sectors;
        }
    }
    fclose(fp);

    snprintf(buf, buf_sz,
             "{\"read_sectors\":%llu,\"write_sectors\":%llu}",
             read_sectors, write_sectors);
    return 0;
#else
    (void)buf; (void)buf_sz;
    return -1;
#endif
}


static int
gather_net_io(char *buf, size_t buf_sz)
{
#if defined(__linux__)
    FILE *fp = fopen("/proc/net/dev", "r");
    if (!fp)
        return -1;

    char line[512];
    unsigned long long rx_bytes = 0, tx_bytes = 0;

    /* Skip the first two header lines */
    fgets(line, sizeof(line), fp);
    fgets(line, sizeof(line), fp);

    while (fgets(line, sizeof(line), fp))
    {
        char iface[32];
        unsigned long long r_bytes, r_packets, r_errs, r_drop, r_fifo,
                           r_frame, r_compressed, r_multicast;
        unsigned long long t_bytes, t_packets, t_errs, t_drop, t_fifo,
                           t_colls, t_carrier, t_compressed;

        int matched = sscanf(line,
                             " %31[^:]: %llu %llu %llu %llu %llu %llu %llu %llu "
                             "%llu %llu %llu %llu %llu %llu %llu %llu",
                             iface,
                             &r_bytes,&r_packets,&r_errs,&r_drop,&r_fifo,
                             &r_frame,&r_compressed,&r_multicast,
                             &t_bytes,&t_packets,&t_errs,&t_drop,&t_fifo,
                             &t_colls,&t_carrier,&t_compressed);
        if (matched >= 17)
        {
            /* Ignore loopback */
            if (strcmp(iface, "lo") != 0)
            {
                rx_bytes += r_bytes;
                tx_bytes += t_bytes;
            }
        }
    }
    fclose(fp);

    snprintf(buf, buf_sz,
             "{\"rx_bytes\":%llu,\"tx_bytes\":%llu}",
             rx_bytes, tx_bytes);
    return 0;
#else
    (void)buf; (void)buf_sz;
    return -1;
#endif
}


/* ---------------------------------------------------------------------------
 *  Network Posting Helper
 * ------------------------------------------------------------------------- */

static int
post_metrics_json(const MetricsConfig *cfg, const char *json_body)
{
    assert(cfg && json_body);

    CURL *curl = curl_easy_init();
    if (!curl)
    {
        errno = ENOMEM;
        return -1;
    }

    struct curl_slist *headers = NULL;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    CURLcode res;
    int rc = 0;

    curl_easy_setopt(curl, CURLOPT_URL, cfg->collector_endpoint);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(json_body));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, (long)cfg->post_timeout_ms);

    res = curl_easy_perform(curl);
    if (res != CURLE_OK)
    {
        logger_error("[metrics_command] curl_easy_perform() failed: %s",
                     curl_easy_strerror(res));
        rc = -1;
    }
    else
    {
        long status_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status_code);
        if (status_code >= 400)
        {
            logger_warn("[metrics_command] Collector responded HTTP %ld",
                        status_code);
            rc = -1;
        }
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return rc;
}

#endif /* LUO_METRICS_COMMAND_H */
