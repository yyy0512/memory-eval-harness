```c
/**
 * @file inference.h
 * @author
 * @brief Core inference public interface for RetinaGuard Vision Suite.
 *
 * This header exposes the run-time API used by the higher-level pipeline
 * controller, monitoring dashboard, and model-registry modules.  The API
 * wraps model loading, execution, and result broadcasting behind a
 * thread-safe façade that follows the Observer Pattern.  All model
 * implementations are loaded through a dynamically selected backend
 * (e.g., ONNX-Runtime, TFLite, or a proprietary accelerator) and abstracted
 * away from callers via opaque handles.
 *
 * NOTE:
 *   • All functions return 0 on success and a negative errno-compatible value
 *     on failure.  
 *   • The entire module is re-entrant and safe for concurrent invocation from
 *     multiple threads, provided that each thread works with its own
 *     RGInferenceHandle.
 */

#ifndef RETINAGUARD_VISION_SUITE_CORE_INFERENCE_H_
#define RETINAGUARD_VISION_SUITE_CORE_INFERENCE_H_

#ifdef __cplusplus
extern "C" {
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/* Standard Library                                                         */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* ────────────────────────────────────────────────────────────────────────── */
/* Compile-time versioning information                                      */
#define RG_INFERENCE_VERSION_MAJOR  1
#define RG_INFERENCE_VERSION_MINOR  2
#define RG_INFERENCE_VERSION_PATCH  0

/* Stringified version for logging/UX */
#define RG_INFERENCE_VERSION_STR    "1.2.0"

/* ────────────────────────────────────────────────────────────────────────── */
/* Diagnostic tracing                                                       */
/* Define RG_TRACE_ENABLE at compile time to emit verbose traces            */
#ifdef RG_TRACE_ENABLE
#  define RG_TRACE(fmt, ...) fprintf(stderr, "[RG:TRACE] " fmt "\n", ##__VA_ARGS__)
#else
#  define RG_TRACE(fmt, ...) (void)0
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/* Enumerations                                                             */

/**
 * @brief High-level diabetic-retinopathy (DR) grade categories aligned with
 *        International Clinical Diabetic Retinopathy (ICDR) scale.
 */
typedef enum {
    RG_DR_GRADE_NO_DR       = 0,
    RG_DR_GRADE_MILD        = 1,
    RG_DR_GRADE_MODERATE    = 2,
    RG_DR_GRADE_SEVERE      = 3,
    RG_DR_GRADE_PROLIFERATIVE = 4,
    RG_DR_GRADE_UNDETERMINED = 255 /* Fallback for inconclusive results */
} RGDrGrade;

/**
 * @brief Inference backend enumeration.  Additional backends can be added
 *        without breaking ABI compatibility as long as they are appended.
 */
typedef enum {
    RG_BACKEND_ONNX_RUNTIME = 0,
    RG_BACKEND_TFLITE       = 1,
    RG_BACKEND_ACCELERATOR  = 2  /* Hardware-specific (e.g., NPU) */
} RGBackend;

/**
 * @brief Result of an inference request.
 */
typedef enum {
    RG_INFERENCE_OK              = 0,
    RG_INFERENCE_ERR_GENERIC     = -1,
    RG_INFERENCE_ERR_NOT_READY   = -2,
    RG_INFERENCE_ERR_INVALID_ARG = -3,
    RG_INFERENCE_ERR_BACKEND     = -4,
    RG_INFERENCE_ERR_IO          = -5,
    RG_INFERENCE_ERR_OOM         = -6,
} RGInferenceStatus;

/* ────────────────────────────────────────────────────────────────────────── */
/* Data Structures                                                          */

/**
 * @brief Configuration used at initialization time.
 */
typedef struct {
    RGBackend backend;          /* Preferred runtime backend */
    const char *model_path;     /* Absolute/relative path to model file */
    float dr_grade_thresholds[5]; /* Per-class confidence thresholds */
    bool enable_heatmap;        /* Generate class-activation maps */
    uint32_t num_threads;       /* Worker threads for CPU backends */
} RGInferenceConfig;

/**
 * @brief Opaque handle representing an initialized model instance.
 *        Treat as a pointer-sized token.
 */
typedef struct RGInferenceHandleImpl *RGInferenceHandle;

/**
 * @brief Structure holding inference outputs.
 */
typedef struct {
    RGDrGrade grade;          /* Predicted DR grade  */
    float     confidence;     /* Softmax probability for predicted grade */
    uint32_t  microaneurysm_count;
    uint32_t  hemorrhage_count;
    /* Optional heatmap pointer (RGBA 8-bit) with dimensions H×W;
       NULL unless enable_heatmap=true in config. */
    uint8_t  *heatmap_rgba;
    uint16_t  heatmap_width;
    uint16_t  heatmap_height;

    /* Timestamp for longitudinal tracking (Unix epoch milliseconds) */
    uint64_t  captured_ts_ms;
} RGInferenceResult;

/* ────────────────────────────────────────────────────────────────────────── */
/* Observer Pattern                                                         */

/**
 * @brief Prototype for inference event callbacks.
 *
 * @param handle     The inference handle that emitted the event.
 * @param result     Pointer to result data.  Ownership remains with callee
 *                   and is valid only for the duration of the callback.
 * @param user_ctx   Caller-provided context pointer passed during registration.
 */
typedef void (*RGInferenceObserver)(RGInferenceHandle      handle,
                                    const RGInferenceResult *result,
                                    void                   *user_ctx);

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                               */

/**
 * @brief Initialize a new inference session.
 *
 * Multiple sessions may coexist; each maintains its own model state and
 * workspace memory.  The function is thread-safe.
 *
 * @param cfg         Pointer to configuration.  Must remain valid until
 *                    initialization completes.
 * @param out_handle  Receives the session handle on success.
 *
 * @return 0 on success, <0 on failure (see RGInferenceStatus).
 */
int rg_inference_init(const RGInferenceConfig *cfg,
                      RGInferenceHandle       *out_handle);

/**
 * @brief Perform inference on a single fundus image already loaded into memory.
 *
 * @param handle      Session handle obtained via rg_inference_init().
 * @param image_bgr   Pointer to BGR(A) bytes.  The specific format (e.g.,
 *                    BGR888, BGRA8888) is configured at build time.
 * @param width       Image width in pixels.
 * @param height      Image height in pixels.
 * @param stride      Number of bytes between successive rows.
 * @param result_out  Caller-allocated result struct to populate.
 *
 * @return 0 on success, <0 on failure.
 */
int rg_inference_run(RGInferenceHandle  handle,
                     const uint8_t     *image_bgr,
                     uint16_t           width,
                     uint16_t           height,
                     uint32_t           stride,
                     RGInferenceResult *result_out);

/**
 * @brief Register an observer to receive asynchronous inference events.
 *
 * Observers are invoked in the calling thread’s context immediately after a
 * successful inference run, before rg_inference_run returns.
 *
 * @param handle     Session handle.
 * @param cb         Callback function pointer.
 * @param user_ctx   Caller-provided context to pass back during callbacks.
 *
 * @return 0 on success, <0 on failure.
 */
int rg_inference_register_observer(RGInferenceHandle    handle,
                                   RGInferenceObserver  cb,
                                   void                *user_ctx);

/**
 * @brief Remove a previously registered observer.
 *
 * Safe to call multiple times; unknown observers are silently ignored.
 *
 * @param handle     Session handle.
 * @param cb         Callback function.
 * @param user_ctx   Context pointer (must match the one supplied during
 *                   registration for the same callback).
 *
 * @return 0 on success, <0 on failure.
 */
int rg_inference_unregister_observer(RGInferenceHandle    handle,
                                     RGInferenceObserver  cb,
                                     void                *user_ctx);

/**
 * @brief Gracefully shut down a session and release all associated resources.
 *
 * Pending observers are automatically unregistered.  After shut-down, the
 * handle becomes invalid and must not be reused (set it to NULL for safety).
 *
 * @param handle  Handle returned by rg_inference_init().
 *
 * @return 0 on success, <0 on failure.
 */
int rg_inference_shutdown(RGInferenceHandle handle);

/* ────────────────────────────────────────────────────────────────────────── */
/* Utility helpers                                                          */

/**
 * @brief Obtain a human-readable string for an RGInferenceStatus code.
 *
 * @param status  Status code
 * @return Pointer to static string; do not free.
 */
const char *rg_inference_status_str(int status);

/**
 * @brief Convenience inline to compare version at compile time.
 */
static inline bool rg_inference_version_at_least(int major,
                                                 int minor,
                                                 int patch)
{
    return (RG_INFERENCE_VERSION_MAJOR >  major) ||
           (RG_INFERENCE_VERSION_MAJOR == major &&
            (RG_INFERENCE_VERSION_MINOR >  minor ||
            (RG_INFERENCE_VERSION_MINOR == minor &&
             RG_INFERENCE_VERSION_PATCH >= patch)));
}

/* ────────────────────────────────────────────────────────────────────────── */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* RETINAGUARD_VISION_SUITE_CORE_INFERENCE_H_ */
```