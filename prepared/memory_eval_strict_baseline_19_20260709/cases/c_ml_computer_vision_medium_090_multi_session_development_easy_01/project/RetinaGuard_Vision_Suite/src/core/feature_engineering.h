```c
/****************************************************************************************
 *  RetinaGuard Vision Suite                                                             *
 *  File:    src/core/feature_engineering.h                                              *
 *  Author:  RetinaGuard Engineering Team                                                *
 *                                                                                      *
 *  Description:                                                                        *
 *      Public interface of the Feature-Engineering module responsible for extracting   *
 *      domain-specific biomarkers (micro-aneurysms, exudates, vessel tortuosity, etc.) *
 *      from retinal fundus photographs. The module is designed around an Observer      *
 *      Pattern to broadcast feature-extraction events to monitoring dashboards and the *
 *      in-process Model Registry, while also exposing a C-friendly API that can be     *
 *      consumed by the Pipeline orchestrator.                                          *
 *                                                                                      *
 *  License:                                                                             *
 *      SPDX-License-Identifier: MIT                                                    *
 ****************************************************************************************/

#ifndef RETINAGUARD_VISION_SUITE_FEATURE_ENGINEERING_H
#define RETINAGUARD_VISION_SUITE_FEATURE_ENGINEERING_H

#ifdef __cplusplus
extern "C" {
#endif

/*––––––––––––––––––––––––– System / Standard Library Includes –––––––––––––––––––––––*/
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/*––––––––––––––––––––––––– Forward Declarations –––––––––––––––––––––––––––––––––––––*/
typedef struct RG_Image RG_Image;      /* Opaque fundus image structure defined elsewhere */

/*––––––––––––––––––––––––– Error Handling –––––––––––––––––––––––––––––––––––––––––––*/
/**
 * @brief Enumeration of error / result codes returned by Feature Engineering API.
 */
typedef enum
{
    RG_FE_OK = 0,                 /* No error                              */
    RG_FE_INVALID_ARGUMENT,       /* Function argument is invalid          */
    RG_FE_ALLOCATION_FAILURE,     /* malloc / calloc / realloc failed      */
    RG_FE_IO_FAILURE,             /* I/O operation failed (disk, etc.)     */
    RG_FE_UNSUPPORTED_FORMAT,     /* Unsupported or malformed input        */
    RG_FE_INTERNAL_ERROR          /* Unexpected failure                    */
} RG_FEResult;


/*––––––––––––––––––––––––– Feature Definitions –––––––––––––––––––––––––––––––––––––*/
/**
 * @brief Bit-mask enumerating the available engineered features.
 *
 * Multiple features can be requested at once by OR-ing the desired bits together.
 */
typedef enum
{
    RG_FE_MICRO_ANEURYSM_COUNT =   1u << 0,
    RG_FE_EXUDATE_AREA        =   1u << 1,
    RG_FE_VESSEL_TORTUOSITY   =   1u << 2,
    RG_FE_OPTIC_DISC_DISTANCE =   1u << 3,
    RG_FE_BACKGROUND_INTENSITY=   1u << 4,
    RG_FE_IMAGE_QUALITY_SCORE =   1u << 5,
    RG_FE_ALL                 = 0xFFFFFFFFu
} RG_FeatureMask;


/**
 * @brief Container holding a concrete feature vector.
 *
 * Missing values are encoded as NaN and flagged as absent in `present`.
 */
typedef struct
{
    RG_FeatureMask present;          /* Bit-mask describing populated fields */

    float micro_aneurysm_count;      /* Number of micro-aneurysms detected per image  */
    float exudate_area;              /* % coverage of exudates                        */
    float vessel_tortuosity;         /* Mean tortuosity factor                        */
    float optic_disc_distance;       /* Normalized disc-macula distance               */
    float background_intensity;      /* Mean background grayscale level               */
    float image_quality_score;       /* 0–1 quality metric                            */
} RG_FeatureVector;


/*––––––––––––––––––––––––– Configuration –––––––––––––––––––––––––––––––––––––––––––*/
/**
 * @brief Runtime configuration of the feature-engineering stage.
 *
 * All thresholds and hyper-parameters can be tuned at inference-time to
 * accommodate hardware variations (camera optics, lighting, etc.).
 * Passing NULL to extraction functions will auto-populate defaults.
 */
typedef struct
{
    RG_FeatureMask enabled_features;   /* Features to compute                        */

    /* General pre-processing ---------------------------------------------------- */
    float  gaussian_sigma;             /* σ for Gaussian blur                        */
    uint8_t green_channel_only;        /* Use green channel exclusively (1 = yes)    */

    /* Micro-aneurysm detection -------------------------------------------------- */
    float  ma_threshold;               /* Intensity threshold for candidate pixels   */
    size_t ma_min_area;                /* Minimum blob area (px^2)                   */

    /* Exudate detection --------------------------------------------------------- */
    float  exudate_threshold;          /* Threshold for bright lesion segmentation   */
    size_t exudate_min_area;           /* Minimum connected area (px^2)              */

    /* Vessel tortuosity --------------------------------------------------------- */
    float  vessel_segment_threshold;   /* Binarization threshold for vessels         */

    /* Reserved for future expansion -------------------------------------------- */
    void  *reserved0;
    void  *reserved1;
} RG_FEConfig;


/*––––––––––––––––––––––––– Observer Pattern Support ––––––––––––––––––––––––––––––––*/
/**
 * @brief Callback signature invoked once features have been extracted.
 *
 * @param image   Pointer to original image (ownership retained by caller).
 * @param vector  Pointer to computed feature vector (read-only).
 * @param user_data User supplied context pointer.
 */
typedef void (*RG_FE_ObserverCb)(const RG_Image           *image,
                                 const RG_FeatureVector   *vector,
                                 void                     *user_data);

/* Opaque handle used for deregistering observers */
typedef struct RG_FE_ObserverHandle RG_FE_ObserverHandle;


/*––––––––––––––––––––––––– Public API ––––––––––––––––––––––––––––––––––––––––––––––*/
/**
 * @brief Initialize global state of the Feature Engineering module.
 *
 * Safe to call multiple times; subsequent calls are ignored.
 */
RG_FEResult rg_fe_init(void);

/**
 * @brief Shutdown and clean up global state.
 *
 * All observers are automatically deregistered.
 */
void rg_fe_shutdown(void);

/**
 * @brief Register an observer for feature-extraction events.
 *
 * @param cb        User callback to invoke.
 * @param user_data Arbitrary context pointer forwarded to callback.
 *
 * @return Handle that can later be passed to rg_fe_remove_observer(), or NULL on error.
 */
RG_FE_ObserverHandle *rg_fe_add_observer(RG_FE_ObserverCb cb, void *user_data);

/**
 * @brief Remove a previously registered observer.
 */
void rg_fe_remove_observer(RG_FE_ObserverHandle *handle);

/**
 * @brief Core API: Extract features from a single image.
 *
 * Memory for the resulting feature vector is allocated internally using malloc()
 * and must be released with rg_fe_free_feature_vector().
 *
 * @param image       Input RG_Image.
 * @param config      Optional configuration; pass NULL for defaults.
 * @param out_vector  Output pointer; populated on success.
 *
 * @return RG_FE_OK on success, error code otherwise.
 */
RG_FEResult rg_fe_extract_features(const RG_Image     *image,
                                   const RG_FEConfig  *config,
                                   RG_FeatureVector  **out_vector);

/**
 * @brief Convenience wrapper returning a feature vector by value.
 *
 * Intended for quick evaluations; internally allocates and frees memory.
 */
static inline RG_FeatureVector rg_fe_extract_features_simple(const RG_Image *image)
{
    RG_FeatureVector *tmp = NULL;
    RG_FeatureVector  out = {0};

    if (rg_fe_extract_features(image, NULL, &tmp) == RG_FE_OK && tmp)
        out = *tmp;

    rg_fe_free_feature_vector(tmp);
    return out;
}

/**
 * @brief Release memory of a feature vector obtained from extract_features().
 */
void rg_fe_free_feature_vector(RG_FeatureVector *vector);

/**
 * @brief Serialize a feature vector to a JSON document.
 *
 * @param vector       Input feature vector.
 * @param json_buffer  *json_buffer receives malloc()’d, NULL-terminated string.
 *
 * Caller must free() *json_buffer. On failure, *json_buffer is set to NULL.
 */
RG_FEResult rg_fe_feature_vector_to_json(const RG_FeatureVector *vector,
                                         char                  **json_buffer);

/**
 * @brief Deserialize a feature vector from a JSON document.
 *
 * Memory for the returned vector is allocated with malloc().
 */
RG_FEResult rg_fe_feature_vector_from_json(const char *json_buffer,
                                           RG_FeatureVector **out_vector);

/**
 * @brief Populate a configuration struct with default parameters.
 */
void rg_fe_config_set_default(RG_FEConfig *cfg);


/*––––––––––––––––––––––––– Utility Inline Helpers –––––––––––––––––––––––––––––––––*/
/**
 * @brief Test if a given feature is present in the vector.
 */
static inline bool rg_fe_feature_present(const RG_FeatureVector *vec,
                                         RG_FeatureMask          feature)
{
    return (vec && ((vec->present & feature) == feature));
}

/**
 * @brief Convert a result code to human-readable description.
 */
const char *rg_fe_strerror(RG_FEResult code);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* RETINAGUARD_VISION_SUITE_FEATURE_ENGINEERING_H */
```