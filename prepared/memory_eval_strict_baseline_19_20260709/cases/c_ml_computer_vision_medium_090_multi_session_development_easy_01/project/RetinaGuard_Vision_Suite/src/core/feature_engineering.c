/*
 * RetinaGuard Vision Suite
 * ------------------------------------------------------------
 * Module: Feature Engineering
 * File  : feature_engineering.c
 *
 * Description:
 *   Implements diabetic-retinopathy–specific feature-engineering utilities.
 *   Functions in this compilation unit transform pre-processed retinal
 *   fundus frames into discriminative domain features consumed by downstream
 *   inference, visualization, and monitoring subsystems.
 *
 *   Key features extracted:
 *      1. Micro-aneurysm (MA) probability heat-map
 *      2. Vessel density map and summary statistics
 *      3. Composite “DR-FeatureVector” aggregating additional cues
 *
 *   The module adheres to the Pipeline Pattern—each public API returns a
 *   fe_result_t object that can be chained into subsequent stages.  Results
 *   are broadcast to interested observers (e.g., model_registry) via the
 *   in-process event bus.
 *
 * Author:
 *   RetinaGuard Engineering Team
 *
 * ------------------------------------------------------------
 */

#include "feature_engineering.h"     /* public header for this unit        */
#include "framework/logger.h"        /* uniform logging interface          */
#include "framework/memory.h"        /* secure calloc/free wrappers        */
#include "framework/event_bus.h"     /* Observer-pattern utility           */
#include "utils/timer.h"             /* high-resolution timing             */

#include <string.h>
#include <math.h>
#include <errno.h>

/* ------------------------------------------------------------------ */
/* Forward declarations (static local helpers)                         */
static int  fe_compute_integral_image(const gray8_img_t *src,
                                      uint32_t          *dst);

static int  fe_detect_microaneurysms(const gray8_img_t *green,
                                     gray8_img_t       *ma_prob);

static void fe_emit_event(const fe_result_t *result);

/* ------------------------------------------------------------------ */
/*                      Public API Implementation                      */
/* ------------------------------------------------------------------ */

/**
 * fe_init
 * ------------------------------------------------------------
 * Initialise a feature-engineering context. Allocates required internal
 * buffers sized to the provided frame geometry.
 */
fe_context_t *
fe_init(uint32_t width, uint32_t height, fe_error_t *err_out)
{
    fe_context_t *ctx = xcalloc(1, sizeof *ctx);
    if (!ctx) {
        if (err_out) {
            err_out->code = FE_ERR_OOM;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "Out of memory allocating fe_context_t");
        }
        return NULL;
    }

    ctx->frame_w = width;
    ctx->frame_h = height;

    /* Pre-allocate working buffers */
    size_t px = (size_t)width * height;

    ctx->tmp_green      = gray8_create(width, height);
    ctx->ma_probability = gray8_create(width, height);
    ctx->integral_buf   = xcalloc(px, sizeof(uint32_t));

    if (!ctx->tmp_green || !ctx->ma_probability || !ctx->integral_buf) {
        if (err_out) {
            err_out->code = FE_ERR_OOM;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "Failed buffer allocation in fe_init");
        }
        fe_destroy(ctx);
        return NULL;
    }

    LOG_INFO("[feature_engineering] context initialised for %ux%u frame",
             width, height);
    return ctx;
}

/**
 * fe_destroy
 * ------------------------------------------------------------
 * Release all resources owned by an fe_context_t.
 */
void
fe_destroy(fe_context_t *ctx)
{
    if (!ctx)
        return;

    gray8_destroy(ctx->tmp_green);
    gray8_destroy(ctx->ma_probability);
    xfree(ctx->integral_buf);
    xfree(ctx);
}

/**
 * fe_execute_pipeline
 * ------------------------------------------------------------
 * Entry-point invoked by the Pipeline driver after pre-processing completes.
 * Produces MA heat-map, vessel density, and composite feature vector.
 */
fe_result_t
fe_execute_pipeline(fe_context_t          *ctx,
                    const rgb24_img_t     *preprocessed_frame,
                    const fe_cfg_t        *cfg,
                    fe_error_t            *err_out)
{
    rt_timer_t t0;          /* performance timer */
    fe_result_t result;
    memset(&result, 0, sizeof result);   /* important for observers */

    if (!ctx || !preprocessed_frame || !cfg) {
        if (err_out) {
            err_out->code = FE_ERR_INVALID_ARG;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "NULL pointer passed to fe_execute_pipeline");
        }
        return result;
    }

    /* 1. Extract green channel (retinal structures show highest contrast) */
    timer_start(&t0);
    if (rgb24_to_gray8(preprocessed_frame, ctx->tmp_green) != IMG_OK) {
        if (err_out) {
            err_out->code = FE_ERR_IMAGE_OP;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "rgb24_to_gray8 failed");
        }
        return result;
    }
    double t_green = timer_elapsed_ms(&t0);

    /* 2. Compute micro-aneurysm probability heat-map */
    timer_start(&t0);
    if (fe_detect_microaneurysms(ctx->tmp_green, ctx->ma_probability) != 0) {
        if (err_out) {
            err_out->code = FE_ERR_INTERNAL;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "fe_detect_microaneurysms failed");
        }
        return result;
    }
    double t_ma = timer_elapsed_ms(&t0);

    /* 3. Compute vessel density using integral image */
    timer_start(&t0);
    if (fe_compute_integral_image(ctx->tmp_green,
                                  ctx->integral_buf) != 0) {
        if (err_out) {
            err_out->code = FE_ERR_INTERNAL;
            snprintf(err_out->msg, sizeof err_out->msg,
                     "fe_compute_integral_image failed");
        }
        return result;
    }

    /* Sliding-window vessel density */
    const uint32_t win = cfg->vessel_density_win_px;
    const uint32_t stride = cfg->vessel_density_stride_px;
    uint64_t       density_sum = 0;
    uint32_t       n_tiles = 0;

    for (uint32_t y = 0; y + win < ctx->frame_h; y += stride) {
        for (uint32_t x = 0; x + win < ctx->frame_w; x += stride) {
            /* Integral image sum over window */
            uint32_t A = ctx->integral_buf[(y)       * ctx->frame_w + x];
            uint32_t B = ctx->integral_buf[(y)       * ctx->frame_w + (x+win)];
            uint32_t C = ctx->integral_buf[(y+win)   * ctx->frame_w + x];
            uint32_t D = ctx->integral_buf[(y+win)   * ctx->frame_w + (x+win)];
            uint32_t sum = D + A - B - C;
            density_sum += sum;
            n_tiles++;
        }
    }
    double vessel_density_mean = 0.0;
    if (n_tiles)
        vessel_density_mean = (double)density_sum /
                              (double)(n_tiles * win * win * 255.0);

    double t_vessel = timer_elapsed_ms(&t0);

    /* 4. Populate result structure */
    result.ma_heatmap   = ctx->ma_probability;
    result.vessel_dens  = vessel_density_mean;
    result.metrics.exec_ms_green  = t_green;
    result.metrics.exec_ms_ma     = t_ma;
    result.metrics.exec_ms_vessel = t_vessel;

    /* 5. Broadcast event to observers (model registry, dashboard, etc.) */
    fe_emit_event(&result);

    return result;
}

/* ------------------------------------------------------------------ */
/*                      Static Helper Functions                        */
/* ------------------------------------------------------------------ */

/**
 * fe_compute_integral_image
 * ------------------------------------------------------------
 * Fast summed-area table for a grayscale image. Destination buffer must be
 * pre-allocated with width*height uint32_t elements.
 */
static int
fe_compute_integral_image(const gray8_img_t *src, uint32_t *dst)
{
    if (!src || !dst) {
        errno = EINVAL;
        return -1;
    }
    const uint32_t w = src->width;
    const uint32_t h = src->height;

    /* First row */
    uint32_t row_sum = 0;
    for (uint32_t x = 0; x < w; ++x) {
        row_sum += src->data[x];
        dst[x]   = row_sum;
    }
    /* Remaining rows */
    for (uint32_t y = 1; y < h; ++y) {
        uint32_t idx = y * w;
        row_sum = 0;
        for (uint32_t x = 0; x < w; ++x) {
            row_sum += src->data[idx + x];
            dst[idx + x] = row_sum + dst[idx - w + x]; /* add above */
        }
    }
    return 0;
}

/**
 * fe_detect_microaneurysms
 * ------------------------------------------------------------
 * Very small circular dark lesions are detected via multi-scale LoG
 * (Laplacian of Gaussian) filters.  The maximal response across scales is
 * stored into an 8-bit probability map.
 *
 * Note: For performance this simplified implementation uses a bank of
 *       separable 1-D convolutions with three pre-tuned sigma values
 *       (1.2, 1.8, 2.4).  In production we off-load to NEON/SSE kernels.
 */
static int
fe_detect_microaneurysms(const gray8_img_t *green, gray8_img_t *ma_prob)
{
    if (!green || !ma_prob)
        return -1;

    if (green->width != ma_prob->width ||
        green->height != ma_prob->height)
        return -1;

    const double sigmas[] = {1.2, 1.8, 2.4};
    const uint32_t n_sigma = sizeof sigmas / sizeof sigmas[0];

    const uint32_t w = green->width;
    const uint32_t h = green->height;
    size_t px = (size_t)w * h;

    /* Allocate temporary buffers */
    float *max_resp = xcalloc(px, sizeof *max_resp);
    if (!max_resp)
        return -1;

    /* For each scale */
    for (uint32_t s = 0; s < n_sigma; ++s) {
        double sigma = sigmas[s];
        int ksize = (int)ceil(6 * sigma) | 1; /* ensure odd */
        float *tmp = xcalloc(px, sizeof *tmp);
        if (!tmp) {
            xfree(max_resp);
            return -1;
        }

        if (conv_gaussian_blur_f32(green, tmp, sigma, ksize) != 0 ||
            conv_laplacian_f32(tmp, tmp, w, h)                != 0) {
            xfree(tmp);
            xfree(max_resp);
            return -1;
        }

        /* Update maximal response */
        for (size_t i = 0; i < px; ++i) {
            if (tmp[i] > max_resp[i])
                max_resp[i] = tmp[i];
        }
        xfree(tmp);
    }

    /* Normalize to 0-255 */
    float max_val = 0.f;
    for (size_t i = 0; i < px; ++i)
        if (max_resp[i] > max_val)
            max_val = max_resp[i];

    if (max_val < 1e-6f)
        max_val = 1.f; /* avoid div-by-zero */

    for (size_t i = 0; i < px; ++i)
        ma_prob->data[i] = (uint8_t)fminf(255.f, (max_resp[i] / max_val) * 255.f);

    xfree(max_resp);
    return 0;
}

/**
 * fe_emit_event
 * ------------------------------------------------------------
 * Push a feature-extraction event onto the event bus so that other
 * subsystems (model_registry, monitoring_dashboard) can react.
 */
static void
fe_emit_event(const fe_result_t *result)
{
    if (!result)
        return;

    event_t ev = {
        .type     = EVT_FEATURES_EXTRACTED,
        .payload  = (void *)result,
        .payload_len = sizeof *result,
        .timestamp_ms = timer_now_ms()
    };
    event_bus_publish(&ev);
}

/* ----------------------------- end of file ------------------------- */
