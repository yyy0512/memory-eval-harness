/*
 * LambdaUtility Orchestrator
 * --------------------------
 * File:    src/lib/command/metrics_command.c
 * Author:  LambdaUtility Engineering Team
 *
 * Description:
 *   MetricsCommand implements the Command interface and is responsible
 *   for harvesting real-time host performance metrics (CPU, memory, and
 *   load average). The command serialises the snapshot into JSON and
 *   publishes it to the internal event-bus so that downstream observers
 *   (e.g. alerting, dashboards) can consume the data.
 *
 *   The implementation relies solely on POSIX-compliant facilities and
 *   /proc pseudo-file-system, keeping the binary dependency-free and
 *   friendly for stripped-down serverless runtimes (AWS Lambda’s
 *   provided.al2023, Google Cloud Functions’ distroless images, etc.).
 *
 * Conventions:
 *   • All public symbols are declared in metrics_command.h.
 *   • Error codes follow project-wide error.h definitions.
 *   • Static helpers are file-scoped.
 */

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <cjson/cJSON.h>

#include "command.h"
#include "event_bus.h"
#include "logger.h"
#include "metrics_command.h"

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

#define METRICS_TOPIC          "system.metrics"
#define CPU_SAMPLING_INTERVAL  100000UL  /* µs – 0.1 s              */
#define PROC_STAT_PATH         "/proc/stat"
#define PROC_MEMINFO_PATH      "/proc/meminfo"
#define PROC_LOADAVG_PATH      "/proc/loadavg"

#define SAFE_FCLOSE(fp) do { if ((fp) != NULL) fclose(fp); } while (0)

/* -------------------------------------------------------------------------- */
/*                                Structures                                  */
/* -------------------------------------------------------------------------- */

typedef struct
{
    Command        base;           /* Base class – must be first              */
    char          *correlation_id; /* Optional. Propagated from dispatcher.   */
} MetricsCommand;

/* Snapshot of /proc/stat */
typedef struct
{
    unsigned long long user;
    unsigned long long nice;
    unsigned long long system;
    unsigned long long idle;
    unsigned long long iowait;
    unsigned long long irq;
    unsigned long long softirq;
    unsigned long long steal;
    unsigned long long guest;
    unsigned long long guest_nice;
} cpu_times_t;

/* Memory snapshot derived from /proc/meminfo                           */
typedef struct
{
    unsigned long total_kb;
    unsigned long free_kb;
    unsigned long available_kb;
    unsigned long used_kb;
} mem_info_t;

/* -------------------------------------------------------------------------- */
/*                          Forward-declaration                               */
/* -------------------------------------------------------------------------- */

static int  metrics_execute(Command *cmd);
static void metrics_destroy(Command *cmd);

static int  collect_cpu_usage(double *pct_out);
static int  read_cpu_times(cpu_times_t *dest);
static int  collect_memory(mem_info_t *dest);
static int  collect_load_avg(double *l1, double *l5, double *l15);

/* -------------------------------------------------------------------------- */
/*                               V-table                                      */
/* -------------------------------------------------------------------------- */

static const command_vtable_t METRICS_VTABLE = {
    .execute = metrics_execute,
    .destroy = metrics_destroy
};

/* -------------------------------------------------------------------------- */
/*                       Public factory implementation                        */
/* -------------------------------------------------------------------------- */

Command *metrics_command_create(const char *correlation_id)
{
    MetricsCommand *self = calloc(1, sizeof(*self));
    if (!self)
    {
        LOG_ERROR("metrics_command: allocation failed (%s)", strerror(errno));
        return NULL;
    }

    self->base.vtable = &METRICS_VTABLE;

    if (correlation_id)
    {
        self->correlation_id = strdup(correlation_id);
        if (!self->correlation_id)
        {
            LOG_ERROR("metrics_command: correlation_id strdup failed (%s)",
                      strerror(errno));
            free(self);
            return NULL;
        }
    }
    return (Command *)self;
}

/* -------------------------------------------------------------------------- */
/*                            Command interface                               */
/* -------------------------------------------------------------------------- */

/*
 * Harvest metrics, encode JSON, and push into the event bus.
 * Return 0 on success, negative error code defined in error.h otherwise.
 */
static int metrics_execute(Command *cmd)
{
    if (!cmd)
        return ERR_INVALID_ARGUMENT;

    MetricsCommand *self = (MetricsCommand *)cmd;

    /* ------------------------------------------------------------------ */
    /* Gather metrics                                                     */
    /* ------------------------------------------------------------------ */
    double      cpu_pct      = 0.0;
    mem_info_t  mem_info     = {0};
    double      load1 = 0.0, load5 = 0.0, load15 = 0.0;

    int rc;
    if ((rc = collect_cpu_usage(&cpu_pct)) < 0)
        return rc;

    if ((rc = collect_memory(&mem_info)) < 0)
        return rc;

    if ((rc = collect_load_avg(&load1, &load5, &load15)) < 0)
        return rc;

    /* ------------------------------------------------------------------ */
    /* Build JSON payload                                                 */
    /* ------------------------------------------------------------------ */
    time_t now_epoch = time(NULL);
    if (now_epoch == (time_t)-1)
        now_epoch = 0;

    cJSON *root = cJSON_CreateObject();
    if (!root)
        return ERR_OOM;

    cJSON_AddNumberToObject(root, "timestamp", (double)now_epoch);
    cJSON_AddStringToObject(root,  "source", "metrics_command");

    if (self->correlation_id)
        cJSON_AddStringToObject(root, "correlation_id", self->correlation_id);

    cJSON *cpu = cJSON_AddObjectToObject(root, "cpu");
    cJSON_AddNumberToObject(cpu, "usage_pct", cpu_pct);

    cJSON *mem = cJSON_AddObjectToObject(root, "memory");
    cJSON_AddNumberToObject(mem, "total_kb",      (double)mem_info.total_kb);
    cJSON_AddNumberToObject(mem, "free_kb",       (double)mem_info.free_kb);
    cJSON_AddNumberToObject(mem, "available_kb",  (double)mem_info.available_kb);
    cJSON_AddNumberToObject(mem, "used_kb",       (double)mem_info.used_kb);

    cJSON *load = cJSON_AddObjectToObject(root, "load_avg");
    cJSON_AddNumberToObject(load, "1m",  load1);
    cJSON_AddNumberToObject(load, "5m",  load5);
    cJSON_AddNumberToObject(load, "15m", load15);

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (!payload)
        return ERR_OOM;

    /* ------------------------------------------------------------------ */
    /* Push event                                                         */
    /* ------------------------------------------------------------------ */
    event_t evt = {
        .topic   = METRICS_TOPIC,
        .payload = payload,
        .len     = strlen(payload)
    };

    rc = event_bus_publish(&evt);
    if (rc < 0)
        LOG_ERROR("metrics_command: failed to publish metrics (rc=%d)", rc);

    free(payload);
    return rc;
}

static void metrics_destroy(Command *cmd)
{
    if (!cmd)
        return;

    MetricsCommand *self = (MetricsCommand *)cmd;
    free(self->correlation_id);
    free(self);
}

/* -------------------------------------------------------------------------- */
/*                             Helper functions                               */
/* -------------------------------------------------------------------------- */

/*
 * Read CPU times from /proc/stat.
 */
static int read_cpu_times(cpu_times_t *dest)
{
    FILE *fp = fopen(PROC_STAT_PATH, "r");
    if (!fp)
    {
        LOG_ERROR("metrics_command: cannot open %s (%s)",
                  PROC_STAT_PATH, strerror(errno));
        return ERR_IO;
    }

    /* Format:
     * cpu  2255 34 2290 22625563 6290 127 456
     * We need at least first 10 fields; remaining may be zero.
     */
    cpu_times_t snap = {0};
    int fields = fscanf(fp,
                        "cpu  %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu",
                        &snap.user, &snap.nice, &snap.system, &snap.idle,
                        &snap.iowait, &snap.irq, &snap.softirq, &snap.steal,
                        &snap.guest, &snap.guest_nice);

    SAFE_FCLOSE(fp);

    if (fields < 4) /* user, nice, system, idle mandatory */
    {
        LOG_ERROR("metrics_command: failed to parse %s", PROC_STAT_PATH);
        return ERR_PARSE;
    }

    *dest = snap;
    return 0;
}

/*
 * Collect CPU utilisation as percentage over CPU_SAMPLING_INTERVAL.
 */
static int collect_cpu_usage(double *pct_out)
{
    if (!pct_out)
        return ERR_INVALID_ARGUMENT;

    cpu_times_t t1 = {0}, t2 = {0};

    int rc = read_cpu_times(&t1);
    if (rc < 0)
        return rc;

    usleep(CPU_SAMPLING_INTERVAL);

    rc = read_cpu_times(&t2);
    if (rc < 0)
        return rc;

    /* Summation */
    unsigned long long idle1 = t1.idle + t1.iowait;
    unsigned long long idle2 = t2.idle + t2.iowait;

    unsigned long long non_idle1 = t1.user + t1.nice + t1.system +
                                   t1.irq  + t1.softirq + t1.steal;

    unsigned long long non_idle2 = t2.user + t2.nice + t2.system +
                                   t2.irq  + t2.softirq + t2.steal;

    unsigned long long total1 = idle1 + non_idle1;
    unsigned long long total2 = idle2 + non_idle2;

    unsigned long long total_diff = total2 - total1;
    unsigned long long idle_diff  = idle2  - idle1;

    if (total_diff == 0)
    {
        *pct_out = 0.0;
        return 0;
    }

    *pct_out = (double)(total_diff - idle_diff) * 100.0 / (double)total_diff;
    return 0;
}

/*
 * Parse /proc/meminfo to extract memory statistics.
 */
static int collect_memory(mem_info_t *dest)
{
    if (!dest)
        return ERR_INVALID_ARGUMENT;

    FILE *fp = fopen(PROC_MEMINFO_PATH, "r");
    if (!fp)
    {
        LOG_ERROR("metrics_command: cannot open %s (%s)",
                  PROC_MEMINFO_PATH, strerror(errno));
        return ERR_IO;
    }

    char  key[64];
    unsigned long value;
    char  unit[32];

    mem_info_t result = {0};

    while (fscanf(fp, "%63s %lu %31s\n", key, &value, unit) == 3)
    {
        if (strcmp(key, "MemTotal:") == 0)
            result.total_kb = value;
        else if (strcmp(key, "MemFree:") == 0)
            result.free_kb = value;
        else if (strcmp(key, "MemAvailable:") == 0)
            result.available_kb = value;

        /* We stop when all desired keys have been captured */
        if (result.total_kb && result.free_kb && result.available_kb)
            break;
    }

    SAFE_FCLOSE(fp);

    if (!result.total_kb)
        return ERR_PARSE;

    result.used_kb = result.total_kb - result.free_kb;

    *dest = result;
    return 0;
}

/*
 * Read load averages from /proc/loadavg.
 */
static int collect_load_avg(double *l1, double *l5, double *l15)
{
    FILE *fp = fopen(PROC_LOADAVG_PATH, "r");
    if (!fp)
    {
        LOG_ERROR("metrics_command: cannot open %s (%s)",
                  PROC_LOADAVG_PATH, strerror(errno));
        return ERR_IO;
    }

    int rc = fscanf(fp, "%lf %lf %lf", l1, l5, l15);
    SAFE_FCLOSE(fp);

    if (rc != 3)
        return ERR_PARSE;

    return 0;
}

/* -------------------------------------------------------------------------- */
/*                              End of file                                   */
/* -------------------------------------------------------------------------- */
