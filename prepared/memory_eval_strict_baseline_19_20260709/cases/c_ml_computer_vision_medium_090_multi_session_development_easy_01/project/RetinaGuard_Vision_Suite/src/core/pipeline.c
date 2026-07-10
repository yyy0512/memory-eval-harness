/**
 * RetinaGuard Vision Suite
 * File: src/core/pipeline.c
 *
 * Central orchestration for the RetinaGuard computer-vision pipeline.
 * Implements a classic “Pipeline Pattern” with Observer hooks that broadcast
 * stage-level events to the in-process model registry and monitoring dashboard.
 *
 * The module purposefully remains ignorant of concrete stage implementations;
 * each stage exposes a simple, opaque ABI (init → run → cleanup).  This keeps
 * the pipeline flexible while allowing individual stages to evolve
 * independently (e.g. swapping out OpenCV for Halide in preprocessing without
 * touching orchestration code).
 *
 * NOTE:
 *   All dependent headers are expected to be present elsewhere in the codebase.
 *   Their symbols are forward-declared here only when strictly necessary to
 *   allow this file to compile in isolation for demonstration purposes.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <pthread.h>

#include "config.h"          /* Global configuration structs               */
#include "logging.h"         /* RG_LOG_DEBUG / RG_LOG_INFO / RG_LOG_ERROR   */
#include "observer.h"        /* observer_notify_pipeline_event(...)         */
#include "model_registry.h"  /* registry_report_stage_metrics(...)          */
#include "core/pipeline.h"   /* Public header for this translation unit     */

/* ============================================================================
 * Forward declarations for types that belong to other modules.               */
/* ========================================================================== */

typedef struct rg_image_s      rg_image_t;      /* Raw or pre-processed image   */
typedef struct rg_feature_s    rg_feature_t;    /* Engineered feature container */
typedef struct rg_prediction_s rg_prediction_t; /* Struct holding model output  */

/**
 * Opaque payload that flows through the pipeline.  Individual stages may fill
 * or consume any of the pointers below.
 */
typedef struct rg_payload_s
{
    rg_image_t     *image;       /* Original or processed image              */
    rg_feature_t   *features;    /* Feature map (e.g., heat-maps)            */
    rg_prediction_t*prediction;  /* Model inference output                   */
    void           *user_ctx;    /* Free-form pointer for advanced use cases */
} rg_payload_t;


/* ============================================================================
 * Pipeline event enumeration & helpers                                        */
/* ========================================================================== */

typedef enum
{
    PIPELINE_EVT_STAGE_BEGIN = 0,
    PIPELINE_EVT_STAGE_END,
    PIPELINE_EVT_STAGE_ERROR,
    PIPELINE_EVT_END_OF_PIPELINE
} pipeline_event_t;

/* Helper that wraps observer notifications and adds defensive logging. */
static void
dispatch_event(const char *stage_name,
               pipeline_event_t evt,
               const rg_payload_t *payload,
               int status_code)
{
    if (!stage_name) stage_name = "UNKNOWN";

    /* Log locally first */
    switch (evt)
    {
        case PIPELINE_EVT_STAGE_BEGIN:
            RG_LOG_DEBUG("[PIPELINE] Stage '%s' started.", stage_name);
            break;
        case PIPELINE_EVT_STAGE_END:
            RG_LOG_DEBUG("[PIPELINE] Stage '%s' finished (status=%d).",
                         stage_name, status_code);
            break;
        case PIPELINE_EVT_STAGE_ERROR:
            RG_LOG_ERROR("[PIPELINE] Stage '%s' ERROR (status=%d).",
                         stage_name, status_code);
            break;
        default:
            break;
    }

    /* Broadcasting is best-effort; keep pipeline robust if observers crash. */
    int rc = observer_notify_pipeline_event(stage_name, evt, payload, status_code);
    if (rc != 0)
    {
        RG_LOG_ERROR("[PIPELINE] Observer notification failed for stage '%s' "
                     "(rc=%d). Continuing...", stage_name, rc);
    }
}


/* ============================================================================
 * Stage ABI & registration                                                    */
/* ========================================================================== */

/**
 * Return codes for stage callbacks.
 *  0  → success
 * <0  → unrecoverable failure (pipeline aborts)
 * >0  → recoverable / handled within the stage (pipeline continues)
 */
typedef int (*stage_init_fn)(void **stage_ctx, const rg_config_t *cfg);
typedef int (*stage_run_fn)(void *stage_ctx, rg_payload_t *payload);
typedef void(*stage_cleanup_fn)(void *stage_ctx);

/* Single stage definition */
typedef struct pipeline_stage_s
{
    const char        *name;
    stage_init_fn      init;
    stage_run_fn       run;
    stage_cleanup_fn   cleanup;
    void              *stage_ctx; /* Opaque pointer returned by ->init()    */
} pipeline_stage_t;


/* ============================================================================
 * Core pipeline object                                                        */
/* ========================================================================== */

struct pipeline_s
{
    pipeline_stage_t **stages;         /* Dynamic array of stage pointers    */
    size_t             stage_cnt;      /* Number of registered stages        */
    size_t             stage_cap;      /* Allocated capacity                 */

    pthread_mutex_t    mutex;          /* Guards modifications to 'stages'   */
    rg_config_t       *cfg;            /* Deep copy of initialization config */
};

#define INITIAL_STAGE_CAP    8


/* ============================================================================
 * Internal helpers                                                            */
/* ========================================================================== */

/* Expand the dynamic stage array when capacity is reached. */
static int
reserve_stage_slot(pipeline_t *pl)
{
    if (pl->stage_cnt < pl->stage_cap)
        return 0;

    size_t new_cap = pl->stage_cap * 2;
    if (new_cap == 0) new_cap = INITIAL_STAGE_CAP;

    pipeline_stage_t **tmp =
        realloc(pl->stages, new_cap * sizeof(*pl->stages));
    if (!tmp)
    {
        RG_LOG_ERROR("[PIPELINE] Memory allocation failed while expanding "
                     "stage list: %s", strerror(errno));
        return -ENOMEM;
    }

    pl->stages    = tmp;
    pl->stage_cap = new_cap;
    return 0;
}

/* Perform full cleanup of a stage and free its holder struct. */
static void
destroy_stage(pipeline_stage_t *stage)
{
    if (!stage) return;
    if (stage->cleanup && stage->stage_ctx)
    {
        stage->cleanup(stage->stage_ctx);
    }
    free(stage);
}


/* ============================================================================
 * Public API                                                                  */
/* ========================================================================== */

pipeline_t *
pipeline_create(const rg_config_t *cfg)
{
    pipeline_t *pl = calloc(1, sizeof(*pl));
    if (!pl) return NULL;

    pl->stage_cap = INITIAL_STAGE_CAP;
    pl->stages    = calloc(pl->stage_cap, sizeof(*pl->stages));
    if (!pl->stages)
    {
        free(pl);
        return NULL;
    }

    pthread_mutex_init(&pl->mutex, NULL);

    /* Deep copy configuration for internal use */
    if (cfg)
    {
        pl->cfg = malloc(sizeof(*cfg));
        if (!pl->cfg)
        {
            RG_LOG_ERROR("[PIPELINE] Unable to copy configuration: %s",
                         strerror(errno));
            pipeline_destroy(pl);
            return NULL;
        }
        memcpy(pl->cfg, cfg, sizeof(*cfg));
    }

    RG_LOG_INFO("[PIPELINE] Created new pipeline instance.");
    return pl;
}


void
pipeline_destroy(pipeline_t *pl)
{
    if (!pl) return;

    for (size_t i = 0; i < pl->stage_cnt; ++i)
        destroy_stage(pl->stages[i]);

    free(pl->stages);
    free(pl->cfg);

    pthread_mutex_destroy(&pl->mutex);
    free(pl);
    RG_LOG_INFO("[PIPELINE] Pipeline destroyed.");
}


/**
 * Register a new stage with the pipeline.
 * The function takes ownership of the `stage_def` pointer, regardless of
 * success, to prevent memory leaks from callers that allocate on heap.
 */
int
pipeline_register_stage(pipeline_t *pl, pipeline_stage_t *stage_def)
{
    if (!pl || !stage_def || !stage_def->run)
        return -EINVAL;

    pthread_mutex_lock(&pl->mutex);

    int rc = reserve_stage_slot(pl);
    if (rc != 0)
    {
        pthread_mutex_unlock(&pl->mutex);
        destroy_stage(stage_def);
        return rc;
    }

    /* Initialize stage if callback provided. */
    if (stage_def->init)
    {
        rc = stage_def->init(&stage_def->stage_ctx, pl->cfg);
        if (rc != 0)
        {
            pthread_mutex_unlock(&pl->mutex);
            RG_LOG_ERROR("[PIPELINE] Stage '%s' failed to initialize. rc=%d",
                         stage_def->name ? stage_def->name : "UNKNOWN", rc);
            destroy_stage(stage_def);
            return rc;
        }
    }

    pl->stages[pl->stage_cnt++] = stage_def;
    pthread_mutex_unlock(&pl->mutex);

    RG_LOG_INFO("[PIPELINE] Registered stage '%s'.",
                stage_def->name ? stage_def->name : "UNKNOWN");
    return 0;
}


/**
 * Execute all registered stages sequentially.  If any stage returns a negative
 * value, the pipeline aborts immediately and returns that error code.  Positive
 * return codes are logged but do not stop execution.
 */
int
pipeline_run(pipeline_t *pl, rg_payload_t *payload)
{
    if (!pl || !payload)
        return -EINVAL;

    int rc = 0;

    for (size_t idx = 0; idx < pl->stage_cnt; ++idx)
    {
        pipeline_stage_t *stage = pl->stages[idx];
        if (!stage) continue;

        dispatch_event(stage->name, PIPELINE_EVT_STAGE_BEGIN, payload, 0);

        struct timespec t0, t1;
        clock_gettime(CLOCK_MONOTONIC, &t0);

        rc = stage->run(stage->stage_ctx, payload);

        clock_gettime(CLOCK_MONOTONIC, &t1);
        double elapsed_ms = (t1.tv_sec - t0.tv_sec) * 1000.0 +
                            (t1.tv_nsec - t0.tv_nsec) / 1e6;

        if (rc < 0)
        {
            dispatch_event(stage->name, PIPELINE_EVT_STAGE_ERROR, payload, rc);
            registry_report_stage_metrics(stage->name, elapsed_ms, rc);
            RG_LOG_ERROR("[PIPELINE] Aborting due to fatal error in stage "
                         "'%s' (rc=%d).", stage->name, rc);
            return rc;
        }

        dispatch_event(stage->name, PIPELINE_EVT_STAGE_END, payload, rc);
        registry_report_stage_metrics(stage->name, elapsed_ms, rc);
    }

    dispatch_event("pipeline", PIPELINE_EVT_END_OF_PIPELINE, payload, rc);
    return rc;
}


/* ============================================================================
 * Convenience wrappers for simple pipelines                                   */
/* ========================================================================== */

/**
 * Create, register standard CV stages, execute once, and tear down.  This
 * helper is used by the command-line interface when the user only needs a
 * quick single-shot inference without standing up the full runtime.
 */
int
pipeline_run_single_shot(const rg_config_t *cfg,
                         rg_payload_t      *payload,
                         const pipeline_stage_factory_t *factories,
                         size_t             factory_cnt)
{
    if (!payload || !factories || factory_cnt == 0)
        return -EINVAL;

    int rc = 0;
    pipeline_t *pl = pipeline_create(cfg);
    if (!pl)
    {
        RG_LOG_ERROR("[PIPELINE] Unable to allocate pipeline object.");
        return -ENOMEM;
    }

    /* Build pipeline from provided factory table. */
    for (size_t i = 0; i < factory_cnt; ++i)
    {
        pipeline_stage_t *stage = factories[i]();
        rc = pipeline_register_stage(pl, stage);
        if (rc != 0) goto cleanup;
    }

    rc = pipeline_run(pl, payload);

cleanup:
    pipeline_destroy(pl);
    return rc;
}


/* ============================================================================
 * Threaded execution (optional for future expansion)                          */
/* ========================================================================== */

/**
 * The pipeline is currently executed synchronously.  If a future requirement
 * demands non-blocking behaviour (e.g., UI responsiveness) we can offload the
 * run() method to a worker thread by uncommenting and polishing the code below.
 */
/*
struct async_runner_args
{
    pipeline_t   *pl;
    rg_payload_t *payload;
    int           result;
};

static void *
async_runner_thread(void *arg)
{
    struct async_runner_args *args = arg;
    args->result = pipeline_run(args->pl, args->payload);
    return NULL;
}

int
pipeline_run_async(pipeline_t *pl,
                   rg_payload_t *payload,
                   pthread_t *tid_out)
{
    struct async_runner_args *args = calloc(1, sizeof(*args));
    if (!args) return -ENOMEM;

    args->pl      = pl;
    args->payload = payload;

    pthread_t tid;
    int rc = pthread_create(&tid, NULL, async_runner_thread, args);
    if (rc == 0 && tid_out) *tid_out = tid;
    return rc;
}
*/

/* ============================================================================
 * End of file                                                                 */
/* ========================================================================== */
