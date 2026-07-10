#ifndef RETINAGUARD_IMAGE_PROCESSING_H
#define RETINAGUARD_IMAGE_PROCESSING_H
/*
 * RetinaGuard Vision Suite
 * =========================================================
 *  image_processing.h
 *
 *  Core, lightweight, header-only image-processing utility used by
 *  RetinaGuard’s computer-vision pipeline.  To keep the main binary
 *  self-contained, a subset of third-party functionality is embedded
 *  via single-file libraries (stb_image / stb_image_write).
 *
 *  Usage
 *  -----
 *      #define RG_IMAGE_PROCESSING_IMPLEMENTATION
 *      #include "image_processing.h"
 *
 *      // … now call any rg_image_* API.
 *
 *  Notes
 *  -----
 *  • Only 8-bit unsigned images are fully supported in the reference
 *    implementation.  16-bit containers are planned but disabled
 *    to reduce memory on resource-constrained devices.
 *  • All functions return 0 on success, negative error code otherwise.
 *  • Thread-safety: functions are re-entrant except where noted.
 *
 *  (c) 2023 RetinaGuard Medical Solutions – All Rights Reserved
 */

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---------- Public Compile-Time Options ---------------------------------- */
/* Bounds-checking when accessing image buffers; slight perf cost.       */
#ifndef RG_IP_SAFE_ACCESS
#define RG_IP_SAFE_ACCESS 1
#endif

/* Thread-local errno-style code                                           */
typedef enum RG_ErrorCode {
    RG_EOK              = 0,
    RG_EINVALID_ARG     = -1,
    RG_EALLOC           = -2,
    RG_EIO              = -3,
    RG_EUNSUPPORTED_FMT = -4,
    RG_EINTERNAL        = -127
} RG_ErrorCode;

/* ---------- Image Type --------------------------------------------------- */
typedef enum RG_ImageFormat {
    RG_FMT_GRAY8  = 1,
    RG_FMT_RGB24  = 3,
    RG_FMT_RGBA32 = 4
} RG_ImageFormat;

typedef struct RG_Image {
    uint32_t        width;
    uint32_t        height;
    RG_ImageFormat  fmt;    /* number of channels maps 1:1 to format enum */
    uint8_t        *data;   /* row-major, tightly packed                  */
} RG_Image;

/* ---------- API: Memory -------------------------------------------------- */
/* Create an empty, zero-initialised image buffer. */
int  rg_image_create(RG_Image *out,
                     uint32_t width,
                     uint32_t height,
                     RG_ImageFormat fmt);

/* Deep copy */
int  rg_image_clone(const RG_Image *src, RG_Image *dst);

/* Frees internal buffer and resets struct to zero. Safe for NULL. */
void rg_image_release(RG_Image *img);

/* ---------- API: Disk I/O ----------------------------------------------- */
/* Requires stb_image / stb_image_write – see implementation section.      */
int rg_image_read(const char *path, RG_Image *out);
int rg_image_write_png(const char *path, const RG_Image *img);

/* ---------- API: Processing --------------------------------------------- */
int rg_image_to_grayscale(const RG_Image *src, RG_Image *dst);

/* In-place histogram equalisation (simple global HE, 256 bins). */
int rg_image_equalise_hist(RG_Image *img);

/* Bilinear resize into *out (caller alloc OR auto-alloc when out->data NULL). */
int rg_image_resize_bilinear(const RG_Image *src,
                             RG_Image       *dst,
                             uint32_t        new_w,
                             uint32_t        new_h);

/* Returns a simple image quality score (0–100). Currently variance of Laplacian. */
int rg_image_quality_score(const RG_Image *img, double *score_out);

/* ---------- Utility ------------------------------------------------------ */
const char *rg_strerror(int code);



/* =========================================================================
 *                        Implementation Section
 * =========================================================================
 * Define RG_IMAGE_PROCESSING_IMPLEMENTATION exactly once in a translation
 * unit to emit the function bodies.
 */
#ifdef RG_IMAGE_PROCESSING_IMPLEMENTATION

/* ------------ Optional 3rd-party single-header libs -------------------- */
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION
#ifdef __GNUC__
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wimplicit-function-declaration"
#pragma GCC diagnostic ignored "-Wunused-function"
#endif
#include "stb_image.h"
#include "stb_image_write.h"
#ifdef __GNUC__
#pragma GCC diagnostic pop
#endif

/* ---------- Internal Helpers ------------------------------------------- */
static inline size_t _rg_safe_mul(size_t a, size_t b, int *err)
{
    if (a == 0 || b == 0) return 0;
    if (SIZE_MAX / a < b) { *err = 1; return 0; }
    return a * b;
}

static inline void *_rg_calloc(size_t nmemb, size_t size)
{
    if (nmemb == 0 || size == 0) return NULL;
    int of = 0;
    size_t bytes = _rg_safe_mul(nmemb, size, &of);
    if (of) return NULL;
    void *p = calloc(1, bytes);
    return p;
}

/* ---------- Error Strings ---------------------------------------------- */
const char *rg_strerror(int code)
{
    switch (code) {
        case RG_EOK:              return "success";
        case RG_EINVALID_ARG:     return "invalid argument";
        case RG_EALLOC:           return "memory allocation failed";
        case RG_EIO:              return "I/O error";
        case RG_EUNSUPPORTED_FMT: return "unsupported image format";
        case RG_EINTERNAL:        return "internal error";
        default:                  return "unknown";
    }
}

/* ---------- Memory ------------------------------------------------------ */
int rg_image_create(RG_Image *out,
                    uint32_t width,
                    uint32_t height,
                    RG_ImageFormat fmt)
{
    if (!out || width == 0 || height == 0 ||
        (fmt != RG_FMT_GRAY8 && fmt != RG_FMT_RGB24 && fmt != RG_FMT_RGBA32))
        return RG_EINVALID_ARG;

    memset(out, 0, sizeof(*out));
    int err = 0;
    size_t pix = _rg_safe_mul(width, height, &err);
    if (err) return RG_EALLOC;

    size_t bytes = _rg_safe_mul(pix, (size_t)fmt, &err);
    if (err) return RG_EALLOC;

    out->data = _rg_calloc(1, bytes);
    if (!out->data) return RG_EALLOC;

    out->width  = width;
    out->height = height;
    out->fmt    = fmt;
    return RG_EOK;
}

int rg_image_clone(const RG_Image *src, RG_Image *dst)
{
    if (!src || !dst || !src->data) return RG_EINVALID_ARG;
    int rc = rg_image_create(dst, src->width, src->height, src->fmt);
    if (rc) return rc;
    size_t bytes = (size_t)src->width * src->height * src->fmt;
    memcpy(dst->data, src->data, bytes);
    return RG_EOK;
}

void rg_image_release(RG_Image *img)
{
    if (!img) return;
    free(img->data);
    memset(img, 0, sizeof(*img));
}

/* ---------- Disk I/O ---------------------------------------------------- */
int rg_image_read(const char *path, RG_Image *out)
{
    if (!path || !out) return RG_EINVALID_ARG;

    int w, h, nch;
    uint8_t *pixels = stbi_load(path, &w, &h, &nch, 0);
    if (!pixels) return RG_EIO;

    RG_ImageFormat fmt;
    switch (nch) {
        case 1: fmt = RG_FMT_GRAY8;  break;
        case 3: fmt = RG_FMT_RGB24;  break;
        case 4: fmt = RG_FMT_RGBA32; break;
        default:
            stbi_image_free(pixels);
            return RG_EUNSUPPORTED_FMT;
    }

    out->width  = (uint32_t)w;
    out->height = (uint32_t)h;
    out->fmt    = fmt;
    out->data   = pixels;
    return RG_EOK;
}

int rg_image_write_png(const char *path, const RG_Image *img)
{
    if (!path || !img || !img->data) return RG_EINVALID_ARG;
    int stride = img->width * img->fmt;
    int ok = stbi_write_png(path,
                            (int)img->width,
                            (int)img->height,
                            (int)img->fmt,
                            img->data,
                            stride);
    return ok ? RG_EOK : RG_EIO;
}

/* ---------- Processing: Color / Grayscale ------------------------------ */
int rg_image_to_grayscale(const RG_Image *src, RG_Image *dst)
{
    if (!src || !dst || !src->data) return RG_EINVALID_ARG;
    if (src->fmt == RG_FMT_GRAY8) return rg_image_clone(src, dst);

    if (src->fmt != RG_FMT_RGB24 && src->fmt != RG_FMT_RGBA32)
        return RG_EUNSUPPORTED_FMT;

    int rc = rg_image_create(dst, src->width, src->height, RG_FMT_GRAY8);
    if (rc) return rc;

    const uint8_t *s = src->data;
    uint8_t *d = dst->data;
    size_t pixels = (size_t)src->width * src->height;

    for (size_t i = 0; i < pixels; ++i) {
        uint32_t r = s[0];
        uint32_t g = s[1];
        uint32_t b = s[2];
        uint8_t gray = (uint8_t)((0.299f*r + 0.587f*g + 0.114f*b) + 0.5f);
        *d++ = gray;
        s += src->fmt; /* skip 3 or 4 channels */
    }
    return RG_EOK;
}

/* ---------- Processing: Histogram Equalisation ------------------------- */
int rg_image_equalise_hist(RG_Image *img)
{
    if (!img || !img->data) return RG_EINVALID_ARG;
    if (img->fmt != RG_FMT_GRAY8) return RG_EUNSUPPORTED_FMT;

    const size_t NPIX = (size_t)img->width * img->height;
    uint32_t hist[256] = {0};

    /* build histogram */
    for (size_t i = 0; i < NPIX; ++i)
        hist[ img->data[i] ]++;

    /* cumulative */
    uint32_t cdf[256];
    uint32_t cum = 0;
    for (int i = 0; i < 256; ++i) {
        cum += hist[i];
        cdf[i] = cum;
    }

    if (cum == 0) return RG_EINTERNAL; /* all zero? */

    /* equalise                         */
    for (size_t i = 0; i < NPIX; ++i) {
        uint8_t p = img->data[i];
        uint8_t eq = (uint8_t)((cdf[p] - cdf[0]) * 255.0f / (cum - cdf[0]) + 0.5f);
        img->data[i] = eq;
    }
    return RG_EOK;
}

/* ---------- Processing: Resize (Bilinear) ------------------------------ */
static inline float _rg_lerp(float a, float b, float t) { return a + (b - a) * t; }

int rg_image_resize_bilinear(const RG_Image *src,
                             RG_Image *dst,
                             uint32_t new_w,
                             uint32_t new_h)
{
    if (!src || !dst || !src->data || new_w == 0 || new_h == 0)
        return RG_EINVALID_ARG;

    if (src->fmt != RG_FMT_RGB24 && src->fmt != RG_FMT_GRAY8)
        return RG_EUNSUPPORTED_FMT;

    /* allocate dest if not allocated or size mismatch */
    if (!dst->data || dst->width != new_w || dst->height != new_h || dst->fmt != src->fmt) {
        rg_image_release(dst);
        int rc = rg_image_create(dst, new_w, new_h, src->fmt);
        if (rc) return rc;
    }

    const uint32_t C = src->fmt;
    float x_ratio = (float)(src->width  - 1) / (float)(new_w  - 1);
    float y_ratio = (float)(src->height - 1) / (float)(new_h - 1);

    for (uint32_t j = 0; j < new_h; ++j) {
        float sy = y_ratio * j;
        uint32_t y0 = (uint32_t)sy;
        float y_lerp = sy - y0;
        const uint8_t *row0 = src->data + (size_t)y0 * src->width * C;
        const uint8_t *row1 = (y0 + 1 < src->height)
                              ? row0 + src->width * C
                              : row0; /* clamp */
        uint8_t *drow = dst->data + (size_t)j * new_w * C;

        for (uint32_t i = 0; i < new_w; ++i) {
            float sx = x_ratio * i;
            uint32_t x0 = (uint32_t)sx;
            float x_lerp = sx - x0;

            const uint8_t *p00 = row0 + x0 * C;
            const uint8_t *p10 = (x0 + 1 < src->width) ? p00 + C : p00;
            const uint8_t *p01 = row1 + x0 * C;
            const uint8_t *p11 = (x0 + 1 < src->width) ? p01 + C : p01;

            for (uint32_t c = 0; c < C; ++c) {
                float top    = _rg_lerp(p00[c], p10[c], x_lerp);
                float bottom = _rg_lerp(p01[c], p11[c], x_lerp);
                float val    = _rg_lerp(top, bottom, y_lerp);
                drow[i*C + c] = (uint8_t)(val + 0.5f);
            }
        }
    }
    return RG_EOK;
}

/* ---------- Processing: Quality Score ---------------------------------- */
static inline int _rg_laplacian_kernel(const RG_Image *g,
                                       uint32_t x, uint32_t y)
{
    /* 3×3 Laplacian:   0  1  0
                       1 -4  1
                       0  1  0  */
    int idx = (int)(y * g->width + x);
    int center = g->data[idx];

    int n = (y > 0)                ? g->data[idx - g->width]     : center;
    int s = (y < g->height - 1)    ? g->data[idx + g->width]     : center;
    int w = (x > 0)                ? g->data[idx - 1]            : center;
    int e = (x < g->width - 1)     ? g->data[idx + 1]            : center;

    return (n + s + w + e) - 4 * center;
}

int rg_image_quality_score(const RG_Image *img, double *score_out)
{
    if (!img || !score_out) return RG_EINVALID_ARG;

    RG_Image gray = {0};
    int rc = rg_image_to_grayscale(img, &gray);
    if (rc) return rc;

    /* Variance of Laplacian (focus measure) */
    double sum = 0.0, sumsq = 0.0;
    size_t N = (size_t)gray.width * gray.height;

    for (uint32_t y = 0; y < gray.height; ++y) {
        for (uint32_t x = 0; x < gray.width; ++x) {
            int lap = _rg_laplacian_kernel(&gray, x, y);
            sum   += lap;
            sumsq += lap * lap;
        }
    }

    double mean = sum / N;
    double var  = (sumsq / N) - (mean * mean);
    double score = var / (255.0 * 255.0) * 100.0; /* normalise */

    if (score < 0.0) score = 0.0;
    if (score > 100.0) score = 100.0;
    *score_out = score;

    rg_image_release(&gray);
    return RG_EOK;
}

#endif /* RG_IMAGE_PROCESSING_IMPLEMENTATION */
#endif /* RETINAGUARD_IMAGE_PROCESSING_H */
