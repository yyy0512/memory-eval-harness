/*
 * RetinaGuard Vision Suite
 * File: RetinaGuard_Vision_Suite/src/mlops/model_registry.c
 *
 * Description:
 *   The Model Registry is responsible for:
 *     • Persisting model versions and associated performance metadata
 *     • Selecting the currently-active (“production”) model for inference
 *     • Recording live inference outcomes to enable continuous monitoring
 *     • Promoting / demoting models based on evaluation criteria
 *
 *   The module is designed for use inside the monolithic on-device
 *   deployment.  It exposes a small C API to the rest of the pipeline,
 *   while hiding its internal data structures and persistence format.
 *
 *   Thread-safety is achieved with a pthread mutex because inference,
 *   retraining, and monitoring tasks can run on different threads.
 *
 *   Persistence format:
 *     A simple line-oriented, ‘|’ delimited file stored on the local
 *     filesystem (no external JSON lib required).  Example line:
 *
 *       dr_detector_v1|1|2024-04-21T21:52:07Z|0.9448|0.9033|1728|1|/models/dr_detector_v1.bin|0.9362
 *
 *   Fields:
 *     0  – model id
 *     1  – semantic version (integer)
 *     2  – ISO-8601 creation timestamp
 *     3  – AUC on validation set
 *     4  – F1-score on validation set
 *     5  – samples_evaluated during validation
 *     6  – active flag (0 / 1)
 *     7  – path to on-disk model artifact
 *     8  – live_accuracy (online metric updated after every inference)
 *
 * Copyright:
 *   (c) 2024 RetinaGuard Medical Systems
 *   Licensed for internal clinical use only.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <pthread.h>
#include <stdbool.h>

#include "model_registry.h"  /* Public header for this module          */
#include "rg_logging.h"       /* Project-wide logging abstraction       */

/* -------------------------------------------------------------------------- */
/*                               Local Constants                              */
/* -------------------------------------------------------------------------- */

#define REGISTRY_DELIM           '|'
#define TIMESTAMP_LEN            32
#define MAX_LINE_LEN             1024
#define DEFAULT_REGISTRY_CAP     8U
#define REGISTRY_GROWTH_FACTOR   2U

/* -------------------------------------------------------------------------- */
/*                          Internal Data Structures                          */
/* -------------------------------------------------------------------------- */

/* Metadata persisted across sessions */
typedef struct
{
    char   id[64];
    int    version;
    char   created_at[TIMESTAMP_LEN];
    double auc;
    double f1;
    unsigned long samples_eval;
    bool   active;
    char   file_path[256];
    double live_accuracy;   /* Running online accuracy (EWMA) */
} rg_model_meta_t;

/* Registry container with dynamic storage */
typedef struct
{
    rg_model_meta_t *models;
    size_t           count;
    size_t           capacity;
    char             persistence_path[256];
    pthread_mutex_t  mtx;
} rg_model_registry_t;


/* -------------------------------------------------------------------------- */
/*                          Forward-Private Declarations                      */
/* -------------------------------------------------------------------------- */

static int  rg_registry_load  (rg_model_registry_t *reg);
static int  rg_registry_save  (const rg_model_registry_t *reg);
static void rg_registry_grow  (rg_model_registry_t *reg);
static int  rg_parse_line     (const char *line, rg_model_meta_t *out);
static void rg_format_line    (const rg_model_meta_t *m, char *buf, size_t len);
static void rg_now_iso8601    (char *dst, size_t len);

/* -------------------------------------------------------------------------- */
/*                           Module-Global Instance                           */
/* -------------------------------------------------------------------------- */

static rg_model_registry_t g_registry = {
    .models          = NULL,
    .count           = 0,
    .capacity        = 0,
    .persistence_path= {0},
    .mtx             = PTHREAD_MUTEX_INITIALIZER
};

/* -------------------------------------------------------------------------- */
/*                            Public API Implementation                       */
/* -------------------------------------------------------------------------- */

int rg_model_registry_init(const char *persistence_path)
{
    if (!persistence_path) {
        RG_LOG_ERROR("ModelRegistry: persistence_path is NULL");
        return RG_ERR_INVALID_ARG;
    }

    pthread_mutex_lock(&g_registry.mtx);

    strncpy(g_registry.persistence_path,
            persistence_path,
            sizeof(g_registry.persistence_path) - 1);

    /* Allocate initial storage if necessary */
    if (g_registry.capacity == 0) {
        g_registry.capacity = DEFAULT_REGISTRY_CAP;
        g_registry.models   = calloc(g_registry.capacity,
                                     sizeof(rg_model_meta_t));
        if (!g_registry.models) {
            pthread_mutex_unlock(&g_registry.mtx);
            RG_LOG_ERROR("ModelRegistry: calloc failed (%s)", strerror(errno));
            return RG_ERR_NO_MEMORY;
        }
    }

    int rc = rg_registry_load(&g_registry);
    if (rc == RG_SUCCESS)
        RG_LOG_INFO("ModelRegistry: initialized with %zu model(s)",
                    g_registry.count);
    else
        RG_LOG_WARN("ModelRegistry: load failed, starting empty (rc=%d)", rc);

    pthread_mutex_unlock(&g_registry.mtx);
    return RG_SUCCESS;
}


int rg_model_registry_shutdown(void)
{
    pthread_mutex_lock(&g_registry.mtx);
    int rc = rg_registry_save(&g_registry);
    free(g_registry.models);
    g_registry.models   = NULL;
    g_registry.count    = 0;
    g_registry.capacity = 0;
    pthread_mutex_unlock(&g_registry.mtx);

    if (rc != RG_SUCCESS) {
        RG_LOG_ERROR("ModelRegistry: failed to save on shutdown (rc=%d)", rc);
    }
    return rc;
}


int rg_model_registry_register(const char          *id,
                               const char          *artifact_path,
                               const rg_eval_res_t *eval_metrics)
{
    if (!id || !artifact_path || !eval_metrics) {
        RG_LOG_ERROR("ModelRegistry: invalid args to register()");
        return RG_ERR_INVALID_ARG;
    }

    pthread_mutex_lock(&g_registry.mtx);

    /* Determine next version number for this model id */
    int next_version = 1;
    for (size_t i = 0; i < g_registry.count; ++i) {
        if (strcmp(g_registry.models[i].id, id) == 0) {
            if (g_registry.models[i].version >= next_version)
                next_version = g_registry.models[i].version + 1;
        }
    }

    if (g_registry.count == g_registry.capacity)
        rg_registry_grow(&g_registry);

    rg_model_meta_t *dst = &g_registry.models[g_registry.count];
    memset(dst, 0, sizeof(*dst));

    strncpy(dst->id, id, sizeof(dst->id) - 1);
    dst->version        = next_version;
    dst->auc            = eval_metrics->auc;
    dst->f1             = eval_metrics->f1;
    dst->samples_eval   = eval_metrics->samples_eval;
    dst->active         = false;
    dst->live_accuracy  = 0.0;
    strncpy(dst->file_path, artifact_path, sizeof(dst->file_path) - 1);
    rg_now_iso8601(dst->created_at, sizeof(dst->created_at));

    g_registry.count++;

    /* Persist immediately to avoid data loss */
    int rc = rg_registry_save(&g_registry);
    pthread_mutex_unlock(&g_registry.mtx);

    if (rc == RG_SUCCESS)
        RG_LOG_INFO("ModelRegistry: registered new model '%s' v%d",
                    id, next_version);
    else
        RG_LOG_ERROR("ModelRegistry: failed to persist new model (rc=%d)", rc);

    return rc;
}


const rg_model_meta_t *rg_model_registry_active(void)
{
    const rg_model_meta_t *active = NULL;
    pthread_mutex_lock(&g_registry.mtx);
    for (size_t i = 0; i < g_registry.count; ++i) {
        if (g_registry.models[i].active) {
            active = &g_registry.models[i];
            break;
        }
    }
    pthread_mutex_unlock(&g_registry.mtx);
    return active;
}


int rg_model_registry_promote(const char *id, int version)
{
    if (!id || version <= 0)
        return RG_ERR_INVALID_ARG;

    pthread_mutex_lock(&g_registry.mtx);

    bool found = false;
    for (size_t i = 0; i < g_registry.count; ++i) {
        bool is_target =
            (strcmp(g_registry.models[i].id, id) == 0) &&
            (g_registry.models[i].version == version);

        /* Activate target, deactivate others with same id */
        if (is_target) {
            g_registry.models[i].active = true;
            found = true;
        } else if (strcmp(g_registry.models[i].id, id) == 0) {
            g_registry.models[i].active = false;
        }
    }

    int rc;
    if (!found) {
        rc = RG_ERR_NOT_FOUND;
        RG_LOG_WARN("ModelRegistry: promote failed, model '%s' v%d not found",
                    id, version);
    } else {
        rc = rg_registry_save(&g_registry);
        if (rc == RG_SUCCESS)
            RG_LOG_INFO("ModelRegistry: promoted '%s' v%d to production",
                        id, version);
        else
            RG_LOG_ERROR("ModelRegistry: persistence error on promote (rc=%d)",
                         rc);
    }
    pthread_mutex_unlock(&g_registry.mtx);
    return rc;
}


void rg_model_registry_record_inference(const char *id,
                                        int         version,
                                        bool        correct)
{
    if (!id || version <= 0)
        return;

    pthread_mutex_lock(&g_registry.mtx);
    for (size_t i = 0; i < g_registry.count; ++i) {
        if (strcmp(g_registry.models[i].id, id) == 0 &&
            g_registry.models[i].version == version) {

            /* Exponential weighted moving average for stability */
            const double alpha = 0.05;
            double prev = g_registry.models[i].live_accuracy;
            double curr = correct ? 1.0 : 0.0;
            if (prev == 0.0) {       /* first sample */
                g_registry.models[i].live_accuracy = curr;
            } else {
                g_registry.models[i].live_accuracy =
                    (alpha * curr) + ((1.0 - alpha) * prev);
            }
            break;
        }
    }
    pthread_mutex_unlock(&g_registry.mtx);
}


/* -------------------------------------------------------------------------- */
/*                       Persistence & Helper Implementations                 */
/* -------------------------------------------------------------------------- */

static int rg_registry_load(rg_model_registry_t *reg)
{
    FILE *fp = fopen(reg->persistence_path, "r");
    if (!fp) {
        if (errno == ENOENT) {
            RG_LOG_INFO("ModelRegistry: %s does not exist, creating fresh",
                        reg->persistence_path);
            return RG_SUCCESS;  /* First boot, not an error */
        }
        RG_LOG_ERROR("ModelRegistry: failed to open %s (%s)",
                     reg->persistence_path, strerror(errno));
        return RG_ERR_IO;
    }

    char line[MAX_LINE_LEN];

    while (fgets(line, sizeof(line), fp)) {
        if (reg->count == reg->capacity)
            rg_registry_grow(reg);

        rg_model_meta_t meta;
        if (rg_parse_line(line, &meta) == 0) {
            reg->models[reg->count++] = meta;
        } else {
            RG_LOG_WARN("ModelRegistry: skipping malformed line: %s", line);
        }
    }
    fclose(fp);
    return RG_SUCCESS;
}


static int rg_registry_save(const rg_model_registry_t *reg)
{
    FILE *fp = fopen(reg->persistence_path, "w");
    if (!fp) {
        RG_LOG_ERROR("ModelRegistry: fopen '%s' failed (%s)",
                     reg->persistence_path, strerror(errno));
        return RG_ERR_IO;
    }

    char buf[MAX_LINE_LEN];

    for (size_t i = 0; i < reg->count; ++i) {
        rg_format_line(&reg->models[i], buf, sizeof(buf));
        fputs(buf, fp);
        fputc('\n', fp);
    }

    if (fflush(fp) != 0) {
        RG_LOG_ERROR("ModelRegistry: fflush failed (%s)", strerror(errno));
        fclose(fp);
        return RG_ERR_IO;
    }
    fclose(fp);
    return RG_SUCCESS;
}


static void rg_registry_grow(rg_model_registry_t *reg)
{
    size_t new_cap = reg->capacity * REGISTRY_GROWTH_FACTOR;
    rg_model_meta_t *tmp = realloc(reg->models,
                                   new_cap * sizeof(rg_model_meta_t));
    if (!tmp) {
        RG_LOG_FATAL("ModelRegistry: out of memory during realloc");
        exit(EXIT_FAILURE);
    }
    reg->models   = tmp;
    reg->capacity = new_cap;
    RG_LOG_DEBUG("ModelRegistry: grew storage to %zu", new_cap);
}


static int rg_parse_line(const char *line, rg_model_meta_t *out)
{
    /* strtok destroys input, copy into buffer */
    char buf[MAX_LINE_LEN];
    strncpy(buf, line, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *token;
    char *saveptr;
    int   field = 0;

    token = strtok_r(buf, "|", &saveptr);
    while (token) {
        switch (field) {
        case 0: strncpy(out->id, token, sizeof(out->id) - 1); break;
        case 1: out->version = atoi(token); break;
        case 2: strncpy(out->created_at, token,
                        sizeof(out->created_at) - 1); break;
        case 3: out->auc = atof(token); break;
        case 4: out->f1  = atof(token); break;
        case 5: out->samples_eval = strtoul(token, NULL, 10); break;
        case 6: out->active = (atoi(token) != 0); break;
        case 7: strncpy(out->file_path, token,
                        sizeof(out->file_path) - 1); break;
        case 8: out->live_accuracy = atof(token); break;
        default: break;
        }
        token = strtok_r(NULL, "|", &saveptr);
        field++;
    }

    return (field >= 8) ? 0 : -1;
}


static void rg_format_line(const rg_model_meta_t *m, char *buf, size_t len)
{
    snprintf(buf, len,
             "%s|%d|%s|%.4f|%.4f|%lu|%d|%s|%.4f",
             m->id,
             m->version,
             m->created_at,
             m->auc,
             m->f1,
             m->samples_eval,
             m->active ? 1 : 0,
             m->file_path,
             m->live_accuracy);
}


static void rg_now_iso8601(char *dst, size_t len)
{
    time_t     t  = time(NULL);
    struct tm  tm;
    gmtime_r(&t, &tm);
    strftime(dst, len, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/* -------------------------------------------------------------------------- */
/*                               End of File                                  */
/* -------------------------------------------------------------------------- */
