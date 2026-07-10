/**
 * RetinaGuard Vision Suite
 * ---------------------------------
 * src/core/image_processing.c
 *
 * Core image-processing routines that power the RetinaGuard pipeline.
 * The public API (declared in image_processing.h) exposes composable
 * building blocks that upstream stages (quality control, feature
 * engineering, model inference) rely upon.
 *
 * NOTE:
 *  • This module purposefully avoids external dependencies beyond the C
 *    standard library to simplify certification and cross-compilation.
 *  • OpenCV/IPP optimised paths can be swapped in behind the same API
 *    via compile-time flags if desired (see image_processing_opt.c).
 *
 * Author : RetinaGuard Engineering
 * License: Proprietary – RetinaGuard Medical Devices
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <errno.h>

#include "image_processing.h"  /* Public interface */
#include "logger.h"            /* Centralised logging utility */
#include "metrics.h"           /* Quality-assessment records */

/* ────────────────────────────────────────────────────────── Macros ───── */

#ifndef RG_MIN
#define RG_MIN(a,b) (((a)<(b))?(a):(b))
#endif

#ifndef RG_MAX
#define RG_MAX(a,b) (((a)>(b))?(a):(b))
#endif

#define RG_SWAP(type, a, b) \
    do { type tmp = (a); (a) = (b); (b) = tmp; } while (0)

/* Convenience for robust error handling */
#define RETURN_ERROR(code, fmt, ...)               \
    do {                                           \
        rg_log_error(fmt, ##__VA_ARGS__);          \
        return (code);                             \
    } while (0)

/* ─────────────────────────────────────────────────── Static Helpers ─── */

/* Clamp an integer value into byte range [0, 255] */
static inline uint8_t clamp_to_u8(int value)
{
    if (value <   0) return 0;
    if (value > 255) return 255;
    return (uint8_t)value;
}

/* Safe malloc() wrapper that logs and propagates ENOMEM */
static void *rg_malloc(size_t nbytes)
{
    void *ptr = calloc(1, nbytes);
    if (ptr == NULL)
        rg_log_error("Out of memory while allocating %zu bytes", nbytes);
    return ptr;
}

/* Copy an image struct including pixel data */
static int duplicate_image(const RG_Image *src, RG_Image *dst)
{
    if (!src || !dst) return -EINVAL;

    size_t len = (size_t)src->width * src->height * src->channels;
    dst->width    = src->width;
    dst->height   = src->height;
    dst->channels = src->channels;

    dst->data = rg_malloc(len);
    if (!dst->data)
        return -ENOMEM;

    memcpy(dst->data, src->data, len);
    return 0;
}

/* Convert RGB image to grayscale (luminosity method) */
static int rgb_to_grayscale(const RG_Image *rgb, RG_Image *gray)
{
    if (!rgb || !gray) return -EINVAL;
    if (rgb->channels < 3)
        RETURN_ERROR(-EINVAL, "Expected 3-channel RGB input");

    gray->width    = rgb->width;
    gray->height   = rgb->height;
    gray->channels = 1;
    size_t len     = (size_t)gray->width * gray->height;

    gray->data = rg_malloc(len);
    if (!gray->data)
        return -ENOMEM;

    for (size_t i = 0, j = 0; i < len; ++i, j += rgb->channels)
    {
        uint8_t r = rgb->data[j + 0];
        uint8_t g = rgb->data[j + 1];
        uint8_t b = rgb->data[j + 2];
        /* ITU-R BT.601 luma transform */
        gray->data[i] = (uint8_t)(0.299f * r + 0.587f * g + 0.114f * b);
    }
    return 0;
}

/* Simple 3×3 Sobel magnitude – returns average magnitude */
static float sobel_average_magnitude(const RG_Image *gray)
{
    const int W = gray->width;
    const int H = gray->height;
    const uint8_t *p = gray->data;

    const int gx[3][3] = {
        {  1,  0, -1 },
        {  2,  0, -2 },
        {  1,  0, -1 }
    };
    const int gy[3][3] = {
        {  1,  2,  1 },
        {  0,  0,  0 },
        { -1, -2, -1 }
    };

    double accum = 0.0;
    size_t count = 0;

    for (int y = 1; y < H - 1; ++y)
    {
        for (int x = 1; x < W - 1; ++x)
        {
            int Gx = 0, Gy = 0;
            for (int ky = -1; ky <= 1; ++ky)
                for (int kx = -1; kx <= 1; ++kx)
                {
                    uint8_t pixel = p[(y + ky) * W + (x + kx)];
                    Gx += gx[ky + 1][kx + 1] * pixel;
                    Gy += gy[ky + 1][kx + 1] * pixel;
                }
            accum += sqrt((double)(Gx * Gx + Gy * Gy));
            ++count;
        }
    }

    return (float)(accum / (double)count);
}

/* Histogram equalisation with clipping (CLAHE-like but 1-pass) */
static int clahe_single_channel(uint8_t *channel, int width, int height,
                                int tile_sz, float clip_limit)
{
    if (!channel || tile_sz <= 0) return -EINVAL;

    /* Number of tiles per axis */
    const int tiles_x = (width  + tile_sz - 1) / tile_sz;
    const int tiles_y = (height + tile_sz - 1) / tile_sz;
    const size_t hist_sz = 256;

    /* Allocate histogram buffer for a single tile */
    uint32_t *hist = rg_malloc(hist_sz * sizeof(uint32_t));
    if (!hist) return -ENOMEM;

    for (int ty = 0; ty < tiles_y; ++ty)
    {
        for (int tx = 0; tx < tiles_x; ++tx)
        {
            memset(hist, 0, hist_sz * sizeof(uint32_t));

            /* Tile bounds */
            const int x0 = tx * tile_sz;
            const int y0 = ty * tile_sz;
            const int x1 = RG_MIN(x0 + tile_sz, width);
            const int y1 = RG_MIN(y0 + tile_sz, height);

            /* Build histogram */
            for (int y = y0; y < y1; ++y)
                for (int x = x0; x < x1; ++x)
                    hist[channel[y * width + x]]++;

            /* Clip histogram */
            uint32_t total_excess = 0;
            const uint32_t clip_thresh = (uint32_t)floorf(
                clip_limit * (float)((x1 - x0) * (y1 - y0)) / hist_sz);

            for (size_t i = 0; i < hist_sz; ++i)
            {
                if (hist[i] > clip_thresh)
                {
                    total_excess += hist[i] - clip_thresh;
                    hist[i] = clip_thresh;
                }
            }

            /* Redistribute excess uniformly */
            const uint32_t redist = total_excess / hist_sz;
            for (size_t i = 0; i < hist_sz; ++i)
                hist[i] += redist;

            /* Build CDF */
            uint32_t cdf = 0;
            uint8_t lut[256];
            const uint32_t pixels_in_tile = (x1 - x0) * (y1 - y0);
            for (size_t i = 0; i < hist_sz; ++i)
            {
                cdf += hist[i];
                lut[i] = (uint8_t)RG_MIN(
                    255, (int)roundf(255.0f * (float)cdf / pixels_in_tile));
            }

            /* Apply LUT */
            for (int y = y0; y < y1; ++y)
                for (int x = x0; x < x1; ++x)
                {
                    uint8_t *px = &channel[y * width + x];
                    *px = lut[*px];
                }
        }
    }

    free(hist);
    return 0;
}

/* Resize image using bilinear interpolation – supports RGB & grayscale */
static int resize_bilinear(const RG_Image *src,
                           RG_Image *dst,
                           int target_w,
                           int target_h)
{
    if (!src || !dst || target_w <= 0 || target_h <= 0)
        return -EINVAL;

    dst->width    = target_w;
    dst->height   = target_h;
    dst->channels = src->channels;
    size_t len    = (size_t)target_w * target_h * src->channels;

    dst->data = rg_malloc(len);
    if (!dst->data)
        return -ENOMEM;

    const float x_ratio = (float)(src->width  - 1) / target_w;
    const float y_ratio = (float)(src->height - 1) / target_h;

    for (int j = 0; j < target_h; ++j) {
        for (int i = 0; i < target_w; ++i) {
            const float gx = i * x_ratio;
            const float gy = j * y_ratio;
            const int x = (int)gx;
            const int y = (int)gy;
            const float dx = gx - x;
            const float dy = gy - y;

            for (int c = 0; c < src->channels; ++c)
            {
                /* 4 neighbouring pixels */
                uint8_t p00 = src->data[(y    * src->width + x    ) * src->channels + c];
                uint8_t p10 = src->data[(y    * src->width + (x+1)) * src->channels + c];
                uint8_t p01 = src->data[((y+1)* src->width + x    ) * src->channels + c];
                uint8_t p11 = src->data[((y+1)* src->width + (x+1)) * src->channels + c];

                float val = (1-dx)*(1-dy)*p00 + dx*(1-dy)*p10 +
                            (1-dx)*dy*p01   + dx*dy*p11;

                dst->data[(j * target_w + i) * src->channels + c] =
                    clamp_to_u8((int)roundf(val));
            }
        }
    }
    return 0;
}

/* ───────────────────────────────────────────── Public API Impl ─────── */

int rg_ip_preprocess(const RG_Image *input,
                     const RG_PreprocessConfig *cfg,
                     RG_Image *output,
                     RG_QualityMetrics *metrics)
{
    if (!input || !cfg || !output)
        RETURN_ERROR(-EINVAL, "Preprocess received NULL pointer");

    int rc;
    RG_Image work  = {0};   /* Work buffer */
    RG_Image stage = {0};   /* Intermediate */

    /* 1. Duplicate input for in-place operations */
    if ((rc = duplicate_image(input, &work)) < 0)
        goto fail;

    /* 2. Optional colour normalisation */
    if (cfg->enable_color_norm)
    {
        float mean_r = 0, mean_g = 0, mean_b = 0;
        const size_t px_n = (size_t)work.width * work.height;

        /* Compute per-channel means */
        for (size_t i = 0; i < px_n; ++i)
        {
            mean_r += work.data[i*3 + 0];
            mean_g += work.data[i*3 + 1];
            mean_b += work.data[i*3 + 2];
        }
        mean_r /= px_n; mean_g /= px_n; mean_b /= px_n;

        float gray_mean = (mean_r + mean_g + mean_b) / 3.f;
        float scale_r = gray_mean / mean_r;
        float scale_g = gray_mean / mean_g;
        float scale_b = gray_mean / mean_b;

        /* Apply scaling */
        for (size_t i = 0; i < px_n; ++i)
        {
            int r = (int)roundf(scale_r * work.data[i*3 + 0]);
            int g = (int)roundf(scale_g * work.data[i*3 + 1]);
            int b = (int)roundf(scale_b * work.data[i*3 + 2]);

            work.data[i*3 + 0] = clamp_to_u8(r);
            work.data[i*3 + 1] = clamp_to_u8(g);
            work.data[i*3 + 2] = clamp_to_u8(b);
        }
    }

    /* 3. Green-channel CLAHE (fundus images benefit from boosting vessels) */
    if (cfg->enable_clahe && work.channels >= 3)
    {
        uint8_t *green = &work.data[1]; /* offset of second channel */
        const size_t stride = 3;        /* bytes between greens */

        /* Copy green channel into contiguous buffer */
        RG_Image green_img = {
            .width    = work.width,
            .height   = work.height,
            .channels = 1,
            .data     = rg_malloc((size_t)work.width * work.height)
        };
        if (!green_img.data) { rc = -ENOMEM; goto fail; }

        for (int y = 0; y < work.height; ++y)
            for (int x = 0; x < work.width; ++x)
                green_img.data[y * work.width + x] =
                    green[(y * work.width + x) * stride];

        rc = clahe_single_channel(
            green_img.data,
            green_img.width,
            green_img.height,
            cfg->clahe_tile_size,
            cfg->clahe_clip_limit);

        if (rc < 0) { free(green_img.data); goto fail; }

        /* Write back to original image */
        for (int y = 0; y < work.height; ++y)
            for (int x = 0; x < work.width; ++x)
                green[(y * work.width + x) * stride] =
                    green_img.data[y * work.width + x];

        free(green_img.data);
    }

    /* 4. Resize to model input (if needed) – bilinear */
    if (work.width != cfg->target_width ||
        work.height != cfg->target_height)
    {
        if ((rc = resize_bilinear(&work, &stage,
                                  cfg->target_width,
                                  cfg->target_height)) < 0)
            goto fail;

        /* replace work with resized stage */
        free(work.data);
        work = stage;
        memset(&stage, 0, sizeof(stage));
    }

    /* 5. Compute quality metrics */
    if (metrics)
    {
        RG_Image gray = {0};
        if ((rc = rgb_to_grayscale(&work, &gray)) < 0)
            goto fail;

        metrics->avg_brightness = 0;
        metrics->avg_contrast   = 0;
        const size_t px_n = (size_t)gray.width * gray.height;

        /* brightness = mean intensity */
        for (size_t i = 0; i < px_n; ++i)
            metrics->avg_brightness += gray.data[i];
        metrics->avg_brightness /= px_n;

        /* contrast = std deviation */
        double var = 0.0;
        for (size_t i = 0; i < px_n; ++i)
        {
            float diff = gray.data[i] - metrics->avg_brightness;
            var += diff * diff;
        }
        var /= px_n;
        metrics->avg_contrast = (float)sqrt(var);

        /* sharpness (avg Sobel magnitude) */
        metrics->avg_sharpness = sobel_average_magnitude(&gray);

        metrics->is_blurry =
            (metrics->avg_sharpness < cfg->blur_threshold);

        free(gray.data);
    }

    /* 6. Hand ownership of final buffer to caller */
    *output = work;
    memset(&work, 0, sizeof(work)); /* prevent double free */
    return 0;

fail:
    free(work.data);
    free(stage.data);
    return rc;
}

int rg_ip_free(RG_Image *img)
{
    if (!img) return -EINVAL;
    free(img->data);
    memset(img, 0, sizeof(*img));
    return 0;
}

/* Simple debugging dump to PGM/PPM (development only) */
int rg_ip_dump_to_disk(const RG_Image *img, const char *path)
{
    if (!img || !path) return -EINVAL;

    FILE *fp = fopen(path, "wb");
    if (!fp) RETURN_ERROR(-errno,
        "Failed to write image to '%s' – %s", path, strerror(errno));

    if (img->channels == 1)
    {
        fprintf(fp, "P5\n%d %d\n255\n", img->width, img->height);
        fwrite(img->data, 1, (size_t)img->width * img->height, fp);
    }
    else if (img->channels == 3)
    {
        fprintf(fp, "P6\n%d %d\n255\n", img->width, img->height);
        fwrite(img->data, 1,
               (size_t)img->width * img->height * 3, fp);
    }
    else
    {
        fclose(fp);
        RETURN_ERROR(-EINVAL, "Unsupported channels: %d", img->channels);
    }

    fclose(fp);
    return 0;
}

/* ───────────────────────────────────────────────────── End of file ─── */
