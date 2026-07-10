/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ======================================================
 * File:    pulsesphere/services/enrichment_service/plugins/language_detect/include/language_detect_strategy.h
 * Author:  PulseSphere Core Team
 *
 * Description:
 *   Public plugin interface (Strategy Pattern) for language-detection
 *   modules used by the enrichment_service.  Individual strategies
 *   (fastText, CLD2, CLD3, CompactLanguageDetector, rule-based, etc.)
 *   are compiled as shared objects that implement the contract declared
 *   in this header and can be hot-swapped at runtime without requiring
 *   service downtime.
 *
 * Copyright:
 *   Copyright (c) 2023-2024 PulseSphere Contributors.
 *   Licensed under the Apache License, Version 2.0.
 */

#ifndef PULSESPHERE_LANGUAGE_DETECT_STRATEGY_H
#define PULSESPHERE_LANGUAGE_DETECT_STRATEGY_H

#ifdef __cplusplus
extern "C" {
#endif

/*===============================[  Includes ]================================*/

#include <stddef.h>   /* size_t                      */
#include <stdbool.h>  /* bool                        */
#include <stdint.h>   /* integer types               */

/*==============================[  Constants ]================================*/

/* Maximum length for BCP-47 language tags (e.g. "zh-Hans-CN" = 11 chars)   */
#ifndef PULSESPHERE_LANG_TAG_MAX
#define PULSESPHERE_LANG_TAG_MAX  16U
#endif

/* Error string buffer default size                                          */
#ifndef PULSESPHERE_STRATEGY_ERRBUF_SZ
#define PULSESPHERE_STRATEGY_ERRBUF_SZ 256U
#endif

/*==============================[  Typedefs ]=================================*/

/*
 * Opaque state pointer that allows each strategy to keep its internal
 * context (models, caches, feature extractors) private.
 */
typedef void* ps_lang_state_t;

/*
 * LanguageDetectStrategy
 * ------------------------------------------------------------------------
 * Function table that every language-detection plugin must implement.
 *
 * IMPORTANT:
 *   All functions must be thread-safe unless noted otherwise because an
 *   enrichment worker pool will call them concurrently for different
 *   streams of text.
 */
typedef struct language_detect_strategy {

    /*
     * Return a human-readable name for this strategy.
     * The string must be a NULL-terminated static literal or reside in
     * read-only memory for the lifetime of the process.
     */
    const char* (*get_name)(void);

    /*
     * Return the semantic version of this strategy (SemVer).
     * Used for metrics, debugging and A/B testing.
     *
     * Example: "1.2.0"
     */
    const char* (*get_version)(void);

    /*
     * Initialize the strategy.
     *
     * Parameters:
     *   state_out  - [out] pointer that will receive the strategy state.
     *   cfg_json   - [in]  JSON configuration blob (UTF-8, may be NULL).
     *   errbuf     - [out] caller-provided buffer for error details.
     *   errbuf_len - [in]  length of errbuf in bytes.
     *
     * Returns: true on success, false on error (details in errbuf).
     *
     * Thread-Safety:
     *   Will be called exactly once during the plugin registration
     *   phase, hence may allocate global resources.
     */
    bool (*init)(ps_lang_state_t   *state_out,
                 const char        *cfg_json,
                 char              *errbuf,
                 size_t             errbuf_len);

    /*
     * Detect the most probable language for the provided UTF-8 text.
     *
     * Parameters:
     *   state         - [in]  state pointer from init().
     *   text          - [in]  UTF-8 buffer (need not be NULL-terminated).
     *   text_len      - [in]  length of text in bytes.
     *   lang_tag_buf  - [out] buffer to write BCP-47 language tag.
     *   lang_buf_len  - [in]  size of lang_tag_buf.
     *   confidence    - [out] confidence value 0.0–1.0 (optional, may be NULL).
     *
     * Returns: true on success, false on error (caller should drop event).
     *
     * The implementation MUST ensure lang_tag_buf is NULL-terminated on
     * success. On failure, the content of lang_tag_buf is unspecified.
     */
    bool (*detect)(ps_lang_state_t  state,
                   const char      *text,
                   size_t           text_len,
                   char            *lang_tag_buf,
                   size_t           lang_buf_len,
                   double          *confidence);

    /*
     * Optional flush function for streaming models that accumulate
     * partial state (e.g. incremental n-gram counts).
     * May be NULL if not needed.
     */
    void (*flush)(ps_lang_state_t state);

    /*
     * Shutdown and free all resources associated with `state`.
     * Will be called exactly once during plugin unload.
     */
    void (*destroy)(ps_lang_state_t state);

} language_detect_strategy_t;


/*==============================[  Plugin API ]==============================*/

/*
 * Signature that every shared-object must expose.  The enrichment_service
 * resolves this symbol via dlsym() and uses it to obtain the strategy
 * vtable.
 *
 * Example (inside plugin .c):
 *
 *   const language_detect_strategy_t* pulsesphere_create_language_strategy(void)
 *   {
 *       static language_detect_strategy_t strat = {
 *           .get_name    = my_get_name,
 *           .get_version = my_get_version,
 *           .init        = my_init,
 *           .detect      = my_detect,
 *           .flush       = NULL,
 *           .destroy     = my_destroy
 *       };
 *       return &strat;
 *   }
 */
typedef const language_detect_strategy_t*
        (*ps_strategy_factory_f)(void);

#ifdef _WIN32
  #define PS_STRATEGY_EXPORT  __declspec(dllexport)
#else
  #define PS_STRATEGY_EXPORT  __attribute__((visibility("default")))
#endif

/*
 * The well-known exported symbol name that factories must provide.
 */
#define PS_STRATEGY_FACTORY_SYM "pulsesphere_create_language_strategy"

/*===========================[  Core Service API ]===========================*/
/*
 * NOTE:
 *   The functions below are implemented by the enrichment_service core.
 *   Plugin authors do NOT implement these.  They can, however, call
 *   ps_log_*() for logging if they include "ps_logging.h".
 */

typedef struct ps_strategy_handle ps_strategy_handle_t;

/*
 * Register a compiled-in or dynamically loaded strategy with the core.
 *
 * Parameters:
 *   strategy - strategy vtable provided by plugin.
 *
 * Returns:
 *   Opaque handle that can later be used to unregister, or NULL on error.
 */
ps_strategy_handle_t*
ps_register_language_strategy(const language_detect_strategy_t *strategy);

/*
 * Unregister a strategy.  All in-flight events will finish processing
 * before the strategy is actually unloaded.
 *
 * Returns: true on success, false if handle is invalid or busy.
 */
bool
ps_unregister_language_strategy(ps_strategy_handle_t *handle);

/*
 * Set default strategy by human-readable name.  If the strategy is not
 * yet loaded, attempt dynamic loading from plugin directory.
 *
 * Returns: true on success, false otherwise.
 */
bool
ps_set_default_language_strategy(const char *strategy_name);

/*
 * Detect language using the current default strategy.
 * This is a convenience wrapper around the active strategy’s detect().
 */
static inline bool
ps_detect_language(const char *text,
                   size_t      len,
                   char       *lang_tag_buf,
                   size_t      lang_buf_len,
                   double     *confidence)
{
    extern bool ps_core_detect_language(const char*, size_t,
                                        char*, size_t, double*);
    return ps_core_detect_language(text, len, lang_tag_buf,
                                   lang_buf_len, confidence);
}

/*============================[  Error Helpers ]=============================*/

/*
 * Helper to format an error into caller-provided buffer while guaranteeing
 * NULL-termination.
 */
static inline void
ps_strategy_set_error(char *errbuf, size_t errlen, const char *msg)
{
    if (errbuf == NULL || errlen == 0) { return; }
    /* Copy up to errlen-1 characters and always terminate. */
    size_t i;
    for (i = 0; i + 1 < errlen && msg[i] != '\0'; ++i) {
        errbuf[i] = msg[i];
    }
    errbuf[i] = '\0';
}

/*===============================[  C++ Guard ]==============================*/
#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* PULSESPHERE_LANGUAGE_DETECT_STRATEGY_H */
