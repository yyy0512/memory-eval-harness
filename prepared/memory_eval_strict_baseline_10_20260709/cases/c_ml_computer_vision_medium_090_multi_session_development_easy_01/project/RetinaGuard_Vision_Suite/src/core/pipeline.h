/*
 * RetinaGuard Vision Suite
 * ------------------------
 * Copyright (c) 2024
 *
 * File:    src/core/pipeline.h
 * Author:  RetinaGuard Engineering Team
 *
 * Description:
 *   Generic, extensible Pipeline Pattern implementation that stitches together
 *   discrete stages in the computer-vision workflow (image ingestion,
 *   preprocessing, feature extraction, model inference, evaluation, and
 *   visualization). The pipeline provides a uniform interface for configuring,
 *   executing, and monitoring stages, while broadcasting life-cycle events to
 *   in-process observers (e.g., the model-registry and real-time dashboard).
 *
 *   This header contains public data-structures and APIs.  Internal logic lives
 *   in src/core/pipeline.c.  All interfaces are thread-safe unless otherwise
 *   noted.
 *
 * License: MIT (RetinaGuard, see LICENSE.txt)
 */

#ifndef RETINAGUARD_PIPELINE_H
#define RETINAGUARD_PIPELINE_H

/* -------------------------------------------------------------------------- */
/* System includes                                                            */
/* -------------------------------------------------------------------------- */
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>    /* size_t */
#include <time.h>      /* struct timespec */

/* Optional POSIX threading support; define RG_ENABLE_MULTITHREAD=0 to disable */
#ifndef RG_ENABLE_MULTITHREAD
#define RG_ENABLE_MULTITHREAD 1
#endif

#if RG_ENABLE_MULTITHREAD
#  include <pthread.h>
#endif

/* -------------------------------------------------------------------------- */
/* Forward declarations of domain objects (defined elsewhere)                 */
/* -------------------------------------------------------------------------- */
struct rg_image;          /* retinal fundus image handle                      */
struct rg_heatmap;        /* feature heuristic heat-map                       */
struct rg_inference;      /* raw model output                                 */
struct rg_report;         /* risk-stratified evaluation report                */

/* -------------------------------------------------------------------------- */
/* Pipeline Event (Observer Pattern)                                          */
/* -------------------------------------------------------------------------- */

/* List of standard events emitted during execution. Applications may define
 * additional custom events; the pipeline will forward them transparently. */
typedef enum
{
    RG_EVT_PIPELINE_STARTED = 0,
    RG_EVT_PIPELINE_FINISHED,
    RG_EVT_STAGE_STARTED,
    RG_EVT_STAGE_COMPLETED,
    RG_EVT_STAGE_FAILED,
    RG_EVT_CUSTOM            /* marker for user-defined events                */
} rg_event_type_t;

/* Event payload (variant). The union allows for lightweight transport;
 * out-of-band data should be referenced via pointers.                       */
typedef struct
{
    rg_event_type_t  type;
    const char      *stage_name;      /* valid for stage-level events         */
    int              stage_index;     /* –1 when not applicable               */
    int              error_code;      /* populated when type == _FAILED       */

    union
    {
        const struct rg_report   *report;      /* evaluation report           */
        const struct rg_inference*inference;   /* inference output            */
        void                     *user;        /* user-supplied payload        */
    } data;
} rg_event_t;

/* Observer callback signature. MUST be non-blocking; heavy work should be
 * delegated to worker threads to avoid slowing down the pipeline.           */
typedef void (*rg_event_cb)(const rg_event_t *evt, void *user_ctx);

/* -------------------------------------------------------------------------- */
/* Pipeline Stage Interface                                                   */
/* -------------------------------------------------------------------------- */

/* Enumeration of built-in stage kinds (non-exhaustive). */
typedef enum
{
    RG_STAGE_INPUT = 0,          /* image acquisition / ingestion             */
    RG_STAGE_PREPROCESS,         /* normalization, illumination correction    */
    RG_STAGE_FEATURE_EXTRACT,    /* heuristic feature detectors               */
    RG_STAGE_MODEL_INFER,        /* DNN model serving                         */
    RG_STAGE_EVALUATE,           /* grading, risk stratification              */
    RG_STAGE_VISUALIZE,          /* overlays, heat-maps, UI rendering         */
    RG_STAGE_OUTPUT,             /* result persistence / EMR feedback         */
    RG_STAGE_CUSTOM              /* user-defined                              */
} rg_stage_kind_t;

/* Opaque per-stage runtime context. Implementations are responsible for
 * allocating and freeing it within the init() / destroy() hooks.            */
typedef void *rg_stage_ctx_t;

/* Error codes follow POSIX errno semantics where feasible.                  */
typedef int rg_error_t;

/* Function pointer types that define a stage’s behavior. All routines MUST
 * return 0 on success or a negative error code on failure.                  */
typedef rg_error_t (*rg_stage_init_fn)    (rg_stage_ctx_t *out_ctx,
                                           const void     *cfg,
                                           char          **err_msg);

typedef rg_error_t (*rg_stage_process_fn) (rg_stage_ctx_t  ctx,
                                           const void     *in_data,
                                           void          **out_data,
                                           char          **err_msg);

typedef void       (*rg_stage_destroy_fn) (rg_stage_ctx_t  ctx);

/* Descriptor that fully defines a pipeline stage. */
typedef struct
{
    const char            *name;           /* human-readable identifier       */
    rg_stage_kind_t        kind;           /* logical category               */
    const void            *cfg;            /* stage-specific configuration    */

    /* Callbacks */
    rg_stage_init_fn       init;
    rg_stage_process_fn    process;
    rg_stage_destroy_fn    destroy;
} rg_stage_desc_t;

/* -------------------------------------------------------------------------- */
/* Pipeline Options                                                           */
/* -------------------------------------------------------------------------- */
typedef struct
{
    size_t         max_stages;       /* 0 => unlimited                      */
    bool           abort_on_error;   /* stop early if a stage fails         */
    struct timespec watchdog_tmo;    /* 0 => disabled                       */

#if RG_ENABLE_MULTITHREAD
    size_t         worker_threads;   /* 0 => auto-select (CPU * 2)          */
#endif

    /* Logging hook; NULL => use default logger                              */
    void (*logger)(int level, const char *fmt, ...);
} rg_pipeline_opts_t;

/* -------------------------------------------------------------------------- */
/* Pipeline Handle (opaque to callers)                                        */
/* -------------------------------------------------------------------------- */
typedef struct rg_pipeline rg_pipeline_t;

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/* Create a new pipeline instance.                                            *
 * opts may be NULL for defaults.                                             *
 * Returns: pointer to pipeline on success, or NULL on allocation failure.    */
rg_pipeline_t *
rg_pipeline_create(const rg_pipeline_opts_t *opts);

/* Register (subscribe) an observer callback for pipeline events.             *
 * Returns 0 on success, -1 if the observer list is full or on allocation     *
 * failure.                                                                   */
rg_error_t
rg_pipeline_add_observer(rg_pipeline_t *pl,
                         rg_event_cb    cb,
                         void          *user_ctx);

/* Append a new stage to the pipeline.                                        *
 * The stage descriptor is copied internally; callers may free it afterwards. *
 * Returns 0 on success or negative errno-style value on failure.             */
rg_error_t
rg_pipeline_add_stage(rg_pipeline_t      *pl,
                      const rg_stage_desc_t *desc);

/* Execute the pipeline synchronously.                                        *
 * in_data is forwarded to the first stage; the output of the final stage is  *
 * written to *out_data (if non-NULL).                                        *
 * Returns 0 on success or the error code from the stage that failed.         */
rg_error_t
rg_pipeline_run(rg_pipeline_t  *pl,
                const void     *in_data,
                void          **out_data);

/* Cancel a running pipeline. Safe to call from another thread or from an     *
 * Observer callback.                                                         */
void
rg_pipeline_cancel(rg_pipeline_t *pl);

/* Destroy the pipeline and release all resources. The handle becomes invalid *
 * after this call.                                                           */
void
rg_pipeline_destroy(rg_pipeline_t *pl);

/* -------------------------------------------------------------------------- */
/* Inline helpers                                                             */
/* -------------------------------------------------------------------------- */
static inline bool
rg_pipeline_is_running(const rg_pipeline_t *pl);

/* Implementation lives in pipeline.c, but we provide a lightweight checker
 * for callers that only include the header.                                   */
#ifdef RG_PIPELINE_IMPLEMENTATION       /* set by pipeline.c */
#  include <stdatomic.h>
struct rg_pipeline
{
    /* public members are intentionally hidden */
    atomic_bool   is_running;
    atomic_bool   cancel_requested;
    size_t        stage_count;
    rg_stage_desc_t *stages;    /* dynamic array                     */
    rg_pipeline_opts_t opts;

#if RG_ENABLE_MULTITHREAD
    pthread_t    *workers;
    size_t        worker_count;
#endif

    /* observer list */
    struct observer_node
    {
        rg_event_cb  cb;
        void        *user_ctx;
        struct observer_node *next;
    } *observers;

    /* synchronization primitives (omit here for brevity) */
};
#endif /* RG_PIPELINE_IMPLEMENTATION */

/* Safe check without leaking internals. */
static inline bool
rg_pipeline_is_running(const rg_pipeline_t *pl)
{
#ifdef RG_PIPELINE_IMPLEMENTATION
    return pl ? atomic_load(&(pl->is_running)) : false;
#else
    /* Without internal access we conservatively return true; external users
     * should not rely on this value for critical logic. */
    (void)pl;
    return true;
#endif
}

#endif /* RETINAGUARD_PIPELINE_H */
