/*
 * RetinaGuard Vision Suite - Core Inference Module
 * ------------------------------------------------
 *  This source file implements the inference layer that sits in the
 *  middle of the RetinaGuard pipeline. It is responsible for
 *   • Loading the most-recent model version published in the on-device
 *     model registry
 *   • Executing forward-passes on pre-processed fundus images
 *   • Broadcasting Observer Pattern notifications so that ancillary
 *     modules (e.g., dashboard, model monitor) can react in real-time
 *   • Persisting predictions and metadata for longitudinal tracking
 *
 *  The module has intentionally been kept free of any GPU/accelerator
 *  specific code paths—the low-level tensor runtime is abstracted away
 *  in model_runtime.h so that RetinaGuard ships as one portable binary.
 */

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "config.h"            /* Global application configuration     */
#include "event_bus.h"         /* Observer Pattern infrastructure      */
#include "feature_engineering.h"
#include "file_utils.h"
#include "image.h"             /* Normalised, pre-processed image type */
#include "inference.h"         /* Public API for this compilation unit */
#include "logger.h"            /* Centralised logging façade           */
#include "model_registry.h"    /* Registry <-→ model versioning layer  */
#include "model_runtime.h"     /* Thin wrapper around the inference RT */
#include "telemetry.h"         /* Prometheus-style metrics collection  */

/* -------------------------------------------------------------------------- */
/*                               Private defines                              */
/* -------------------------------------------------------------------------- */

#define RG_INFER_NAMESPACE             "inference"
#define RG_MODEL_DIR_FALLBACK          "./models"
#define RG_MODEL_VERSION_MAX_LEN       32
#define RG_EVENT_TOPIC_INFER_COMPLETE  "infer.complete"
#define RG_MAX_JSON_PAYLOAD            4096

/* -------------------------------------------------------------------------- */
/*                          Forward static declarations                       */
/* -------------------------------------------------------------------------- */

static void     broadcast_infer_event        (const InferenceContext *ctx,
                                              const InferenceResult  *res);
static int      reload_model_if_outdated     (InferenceContext       *ctx);
static uint64_t monotonic_ts_ms              (void);
static void     populate_result_metadata     (InferenceResult        *res,
                                              const char             *model_ver,
                                              uint64_t                ts_ms);
static size_t   serialize_result_as_json     (const InferenceResult  *res,
                                              char                   *out_buf,
                                              size_t                  buf_len);

/* -------------------------------------------------------------------------- */
/*                         Thread-local / global state                        */
/* -------------------------------------------------------------------------- */

/* A single process-wide inference context is shared across worker threads.
 * Synchronisation is handled through ctx->lock. */
static InferenceContext g_ctx = {
    .initialised = ATOMIC_VAR_INIT(false)
};

/* -------------------------------------------------------------------------- */
/*                               Public API                                   */
/* -------------------------------------------------------------------------- */

int
rg_infer_init(const char *preferred_model_dir, EventBus *bus)
{
    if (atomic_load(&g_ctx.initialised)) {
        RG_LOG_WARN(RG_INFER_NAMESPACE, "Inference context already initialised");
        return 0;
    }

    const char *model_dir = preferred_model_dir && *preferred_model_dir
                            ? preferred_model_dir
                            : RG_MODEL_DIR_FALLBACK;

    memset(&g_ctx, 0, sizeof(g_ctx));
    strlcpy(g_ctx.model_dir, model_dir, sizeof(g_ctx.model_dir));
    g_ctx.bus = bus;

    pthread_mutex_init(&g_ctx.lock, NULL);

    /* Initial model load */
    int rc = reload_model_if_outdated(&g_ctx);
    if (rc != 0) {
        RG_LOG_ERROR(RG_INFER_NAMESPACE, "Unable to load initial model (rc=%d)", rc);
        return rc;
    }

    atomic_store(&g_ctx.initialised, true);
    RG_LOG_INFO(RG_INFER_NAMESPACE, "Inference context initialised with model %s",
                g_ctx.model_version);

    return 0;
}

int
rg_infer_shutdown(void)
{
    if (!atomic_load(&g_ctx.initialised))
        return 0;

    pthread_mutex_lock(&g_ctx.lock);

    if (g_ctx.handle) {
        mr_release_handle(g_ctx.handle);
        g_ctx.handle = NULL;
    }

    pthread_mutex_unlock(&g_ctx.lock);
    pthread_mutex_destroy(&g_ctx.lock);
    atomic_store(&g_ctx.initialised, false);

    RG_LOG_INFO(RG_INFER_NAMESPACE, "Inference context shut down");
    return 0;
}

int
rg_run_inference(const RgImage *img, InferenceResult *out_res)
{
    if (!img || !out_res)
        return -EINVAL;

    if (!atomic_load(&g_ctx.initialised))
        return -EPERM;

    int rc = reload_model_if_outdated(&g_ctx);
    if (rc != 0)
        return rc;

    /* Execute model forward-pass */
    pthread_mutex_lock(&g_ctx.lock);

    uint64_t ts_start = monotonic_ts_ms();
    rc = mr_forward(g_ctx.handle, img, &out_res->raw_scores[0],
                    RG_NUM_CLASSES, &out_res->confidence);
    uint64_t ts_end   = monotonic_ts_ms();

    pthread_mutex_unlock(&g_ctx.lock);

    if (rc != 0) {
        RG_LOG_ERROR(RG_INFER_NAMESPACE, "Forward pass failed (rc=%d)", rc);
        return rc;
    }

    /* Domain-specific post-processing */
    fe_score_to_dr_grade(out_res->raw_scores, RG_NUM_CLASSES,
                         &out_res->dr_grade, &out_res->need_referral);

    populate_result_metadata(out_res, g_ctx.model_version, ts_end);
    broadcast_infer_event(&g_ctx, out_res);

    tel_record_latency_ms("inference_latency_ms", ts_end - ts_start);

    return 0;
}

/* -------------------------------------------------------------------------- */
/*                             Private helpers                                */
/* -------------------------------------------------------------------------- */

static int
reload_model_if_outdated(InferenceContext *ctx)
{
    ModelRegistryEntry latest = {0};

    int rc = rg_registry_get_latest(&latest);
    if (rc != 0) {
        RG_LOG_WARN(RG_INFER_NAMESPACE, "Model registry unavailable (rc=%d). "
                                         "Proceeding with currently loaded model", rc);
        return 0; /* Non-fatal, soft-fail */
    }

    if (strncmp(latest.version, ctx->model_version, RG_MODEL_VERSION_MAX_LEN) == 0)
        return 0; /* Already on latest */

    /* Load new model artifact */
    char artifact_path[RG_PATH_MAX] = {0};
    file_join_path(ctx->model_dir, latest.filename, artifact_path, sizeof(artifact_path));

    ModelHandle *new_handle = NULL;
    rc = mr_load_model(artifact_path, &new_handle);
    if (rc != 0) {
        RG_LOG_ERROR(RG_INFER_NAMESPACE, "Failed to load model %s (rc=%d)",
                     artifact_path, rc);
        return rc;
    }

    pthread_mutex_lock(&ctx->lock);

    /* Swap handles */
    ModelHandle *old_handle = ctx->handle;
    ctx->handle = new_handle;
    strlcpy(ctx->model_version, latest.version, sizeof(ctx->model_version));

    pthread_mutex_unlock(&ctx->lock);

    if (old_handle)
        mr_release_handle(old_handle);

    RG_LOG_INFO(RG_INFER_NAMESPACE, "Model upgraded to version %s", latest.version);
    return 0;
}

static void
broadcast_infer_event(const InferenceContext *ctx, const InferenceResult *res)
{
    char json[RG_MAX_JSON_PAYLOAD];
    size_t len = serialize_result_as_json(res, json, sizeof(json));

    if (len == 0) {
        RG_LOG_WARN(RG_INFER_NAMESPACE, "Failed to serialise inference result");
        return;
    }

    Event evt = {
        .topic = RG_EVENT_TOPIC_INFER_COMPLETE,
        .payload = json,
        .payload_len = len,
    };

    if (ctx->bus)
        eb_publish(ctx->bus, &evt);
}

static size_t
serialize_result_as_json(const InferenceResult *res, char *out_buf, size_t buf_len)
{
    /* Lightweight JSON serialisation without external deps.
     * NOTE: This is not fully JSON-safe but sufficient for internal usage. */
    int written = snprintf(out_buf, buf_len,
        "{"
        "\"ts\":%" PRIu64 ","
        "\"model\":\"%s\","
        "\"grade\":%d,"
        "\"confidence\":%.3f,"
        "\"need_referral\":%s"
        "}",
        res->timestamp_ms,
        res->model_version,
        res->dr_grade,
        res->confidence,
        res->need_referral ? "true" : "false"
    );

    if (written < 0 || (size_t)written >= buf_len)
        return 0;

    return (size_t)written;
}

static void
populate_result_metadata(InferenceResult *res,
                         const char      *model_ver,
                         uint64_t         ts_ms)
{
    memset(res->model_version, 0, sizeof(res->model_version));
    strlcpy(res->model_version, model_ver, sizeof(res->model_version));
    res->timestamp_ms = ts_ms;
}

static uint64_t
monotonic_ts_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ((uint64_t)ts.tv_sec * 1000ULL) + (ts.tv_nsec / 1000000ULL);
}

/* -------------------------------------------------------------------------- */
/*                               End of file                                  */
/* -------------------------------------------------------------------------- */
