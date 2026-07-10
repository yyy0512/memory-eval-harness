/*
 * RetinaGuard Vision Suite
 * File: src/mlops/model_registry.h
 *
 * Description:
 *   Header-only, thread-safe model registry used by the MLOps subsystem to
 *   manage on-device model versions, metadata and event broadcasting.
 *
 *   IMPORTANT:  Include this header exactly once with
 *       #define MODEL_REGISTRY_IMPLEMENTATION
 *   in a single translation unit (.c file) to generate the function
 *   definitions.  In every other compilation unit simply include
 *   model_registry.h without defining the macro to gain access to the API.
 *
 *   The registry follows the Observer Pattern to decouple pipeline stages
 *   from model-management logic.  Subscribers receive asynchronous callbacks
 *   whenever a model is registered, activated or updated.
 *
 *   Author: RetinaGuard Engineering
 *   License: MIT — see project root for full license text.
 */

#ifndef RETINAGUARD_MODEL_REGISTRY_H
#define RETINAGUARD_MODEL_REGISTRY_H

/*=============================================================
 *  Public  Includes
 *=============================================================*/
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <time.h>

/*=============================================================
 *  Export/Visibility Macros
 *=============================================================*/
#if defined _WIN32 || defined __CYGWIN__
  #ifdef RG_MODEL_DLL
    #ifdef RG_MODEL_BUILD
      #define RG_MODEL_API __declspec(dllexport)
    #else
      #define RG_MODEL_API __declspec(dllimport)
    #endif
  #else
    #define RG_MODEL_API
  #endif
#else
  #define RG_MODEL_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/*=============================================================
 *  Error Codes
 *=============================================================*/
typedef enum {
    RG_MODEL_OK            =  0,
    RG_MODEL_ERR_INVALID   = -1,  /* Invalid argument          */
    RG_MODEL_ERR_NOMEM     = -2,  /* Memory allocation failure */
    RG_MODEL_ERR_EXISTS    = -3,  /* Resource already exists   */
    RG_MODEL_ERR_NOTFOUND  = -4,  /* Resource not found        */
    RG_MODEL_ERR_INTERNAL  = -5   /* Other internal failure    */
} rg_model_error_t;

/*=============================================================
 *  Event Types
 *=============================================================*/
typedef enum {
    RG_MODEL_EVENT_REGISTERED,
    RG_MODEL_EVENT_ACTIVATED,
    RG_MODEL_EVENT_DEACTIVATED,
    RG_MODEL_EVENT_UPDATED
} rg_model_event_t;

/*=============================================================
 *  Model Entry
 *=============================================================*/
#define RG_MODEL_NAME_MAX      64
#define RG_MODEL_VERSION_MAX   16  /* "major.minor.patch" */
#define RG_MODEL_PATH_MAX     256
#define RG_MODEL_CHECKSUM_MAX  64

typedef struct rg_model_entry {
    char     model_name[RG_MODEL_NAME_MAX];
    char     version[RG_MODEL_VERSION_MAX];
    char     file_path[RG_MODEL_PATH_MAX];
    char     checksum[RG_MODEL_CHECKSUM_MAX];
    time_t   registered_at;      /* UNIX epoch                 */
    uint64_t usage_count;        /* Number of inference calls  */
    bool     is_active;          /* Deployment flag            */
} rg_model_entry_t;

/*=============================================================
 *  Callback Interface
 *=============================================================*/
typedef void (*rg_model_event_cb)(
        const rg_model_entry_t *entry,
        rg_model_event_t        event,
        void                   *user_ctx);

/*=============================================================
 *  Public API
 *=============================================================*/

/* One-time init/shutdown */
RG_MODEL_API int  rg_model_registry_init   (void);
RG_MODEL_API int  rg_model_registry_shutdown(void);

/* CRUD operations */
RG_MODEL_API int  rg_model_register(
        const char *model_name,
        int         major,
        int         minor,
        int         patch,
        const char *file_path,
        const char *checksum);

RG_MODEL_API int  rg_model_activate(
        const char *model_name,
        int         major,
        int         minor,
        int         patch);

RG_MODEL_API int  rg_model_get_active(
        const char        *model_name,
        rg_model_entry_t  *out_entry); /* output parameter */

/* Stats & housekeeping */
RG_MODEL_API int  rg_model_increment_usage(
        const char *model_name,
        int         major,
        int         minor,
        int         patch);

/* Observer management */
RG_MODEL_API int  rg_model_subscribe  (rg_model_event_cb cb, void *user_ctx);
RG_MODEL_API int  rg_model_unsubscribe(rg_model_event_cb cb, void *user_ctx);

/*=============================================================
 *  Helper Macros (non-API)
 *=============================================================*/
#ifndef RG_MODEL_SAFE_SNPRINTF
  #define RG_MODEL_SAFE_SNPRINTF(buf, fmt, ...) \
     do { snprintf((buf), sizeof(buf), (fmt), __VA_ARGS__); (buf)[sizeof(buf)-1] = '\0'; } while(0)
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

/*=========================================================================*/
/*=====================  IMPLEMENTATION SECTION  ==========================*/
/*=========================================================================*/
#ifdef MODEL_REGISTRY_IMPLEMENTATION

/*-----------------------------------------------------------*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

/*-----------------------------------------------------------*/
typedef struct rg_model_node {
    rg_model_entry_t    entry;
    struct rg_model_node *next;
} rg_model_node_t;

typedef struct rg_sub_node {
    rg_model_event_cb    cb;
    void                *user_ctx;
    struct rg_sub_node  *next;
} rg_sub_node_t;

typedef struct {
    pthread_mutex_t  lock;
    bool             initialized;
    rg_model_node_t *models;
    rg_sub_node_t   *subs;
} rg_registry_t;

static rg_registry_t g_registry = {
    .lock        = PTHREAD_MUTEX_INITIALIZER,
    .initialized = false,
    .models      = NULL,
    .subs        = NULL
};

/*-----------------------------------------------------------*/
static void
rg_notify_subscribers(const rg_model_entry_t *entry, rg_model_event_t event)
{
    rg_sub_node_t *iter = g_registry.subs;
    while (iter) {
        if (iter->cb) {
            iter->cb(entry, event, iter->user_ctx);
        }
        iter = iter->next;
    }
}

/*-----------------------------------------------------------*/
static rg_model_node_t *
rg_find_model_node(const char *name, const char *version)
{
    for (rg_model_node_t *it = g_registry.models; it; it = it->next) {
        if (strncmp(it->entry.model_name, name, RG_MODEL_NAME_MAX) == 0 &&
            strncmp(it->entry.version,    version, RG_MODEL_VERSION_MAX) == 0) {
            return it;
        }
    }
    return NULL;
}

/*-----------------------------------------------------------*/
static void
rg_format_version(char *dst, size_t dst_sz, int major, int minor, int patch)
{
    snprintf(dst, dst_sz, "%d.%d.%d", major, minor, patch);
    dst[dst_sz-1] = '\0';
}

/*=============================================================
 *  Public API Implementation
 *=============================================================*/
int
rg_model_registry_init(void)
{
    int err = pthread_mutex_lock(&g_registry.lock);
    if (err != 0) return RG_MODEL_ERR_INTERNAL;

    if (g_registry.initialized) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_OK;
    }

    g_registry.models      = NULL;
    g_registry.subs        = NULL;
    g_registry.initialized = true;

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_registry_shutdown(void)
{
    int err = pthread_mutex_lock(&g_registry.lock);
    if (err != 0) return RG_MODEL_ERR_INTERNAL;

    if (!g_registry.initialized) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_INVALID;
    }

    /* Free model list */
    rg_model_node_t *mcur = g_registry.models;
    while (mcur) {
        rg_model_node_t *tmp = mcur->next;
        free(mcur);
        mcur = tmp;
    }
    g_registry.models = NULL;

    /* Free subscriber list */
    rg_sub_node_t *scur = g_registry.subs;
    while (scur) {
        rg_sub_node_t *tmp = scur->next;
        free(scur);
        scur = tmp;
    }
    g_registry.subs = NULL;

    g_registry.initialized = false;

    pthread_mutex_unlock(&g_registry.lock);
    pthread_mutex_destroy(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_register(const char *model_name,
                  int         major,
                  int         minor,
                  int         patch,
                  const char *file_path,
                  const char *checksum)
{
    if (!model_name || !file_path || !checksum) return RG_MODEL_ERR_INVALID;

    char version[RG_MODEL_VERSION_MAX];
    rg_format_version(version, sizeof(version), major, minor, patch);

    pthread_mutex_lock(&g_registry.lock);

    if (rg_find_model_node(model_name, version)) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_EXISTS;
    }

    rg_model_node_t *node = (rg_model_node_t*)calloc(1, sizeof(*node));
    if (!node) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_NOMEM;
    }

    RG_MODEL_SAFE_SNPRINTF(node->entry.model_name, "%s", model_name);
    RG_MODEL_SAFE_SNPRINTF(node->entry.version,    "%s", version);
    RG_MODEL_SAFE_SNPRINTF(node->entry.file_path,  "%s", file_path);
    RG_MODEL_SAFE_SNPRINTF(node->entry.checksum,   "%s", checksum);
    node->entry.registered_at = time(NULL);
    node->entry.usage_count   = 0;
    node->entry.is_active     = false;
    node->next                = g_registry.models;

    g_registry.models = node;

    rg_notify_subscribers(&node->entry, RG_MODEL_EVENT_REGISTERED);

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_activate(const char *model_name,
                  int         major,
                  int         minor,
                  int         patch)
{
    if (!model_name) return RG_MODEL_ERR_INVALID;

    char version[RG_MODEL_VERSION_MAX];
    rg_format_version(version, sizeof(version), major, minor, patch);

    pthread_mutex_lock(&g_registry.lock);

    /* Deactivate current active versions for the model */
    for (rg_model_node_t *it = g_registry.models; it; it = it->next) {
        if (strncmp(it->entry.model_name, model_name, RG_MODEL_NAME_MAX) == 0 &&
            it->entry.is_active) {
            it->entry.is_active = false;
            rg_notify_subscribers(&it->entry, RG_MODEL_EVENT_DEACTIVATED);
        }
    }

    /* Activate requested version */
    rg_model_node_t *target = rg_find_model_node(model_name, version);
    if (!target) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_NOTFOUND;
    }

    target->entry.is_active = true;
    rg_notify_subscribers(&target->entry, RG_MODEL_EVENT_ACTIVATED);

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_get_active(const char        *model_name,
                    rg_model_entry_t  *out_entry)
{
    if (!model_name || !out_entry) return RG_MODEL_ERR_INVALID;

    pthread_mutex_lock(&g_registry.lock);

    for (rg_model_node_t *it = g_registry.models; it; it = it->next) {
        if (strncmp(it->entry.model_name, model_name, RG_MODEL_NAME_MAX) == 0 &&
            it->entry.is_active) {
            *out_entry = it->entry;
            pthread_mutex_unlock(&g_registry.lock);
            return RG_MODEL_OK;
        }
    }

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_ERR_NOTFOUND;
}

/*-----------------------------------------------------------*/
int
rg_model_increment_usage(const char *model_name,
                         int         major,
                         int         minor,
                         int         patch)
{
    if (!model_name) return RG_MODEL_ERR_INVALID;

    char version[RG_MODEL_VERSION_MAX];
    rg_format_version(version, sizeof(version), major, minor, patch);

    pthread_mutex_lock(&g_registry.lock);

    rg_model_node_t *node = rg_find_model_node(model_name, version);
    if (!node) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_NOTFOUND;
    }

    node->entry.usage_count++;

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_subscribe(rg_model_event_cb cb, void *user_ctx)
{
    if (!cb) return RG_MODEL_ERR_INVALID;

    pthread_mutex_lock(&g_registry.lock);

    /* Check duplicate */
    for (rg_sub_node_t *it = g_registry.subs; it; it = it->next) {
        if (it->cb == cb && it->user_ctx == user_ctx) {
            pthread_mutex_unlock(&g_registry.lock);
            return RG_MODEL_ERR_EXISTS;
        }
    }

    rg_sub_node_t *node = (rg_sub_node_t*)calloc(1, sizeof(*node));
    if (!node) {
        pthread_mutex_unlock(&g_registry.lock);
        return RG_MODEL_ERR_NOMEM;
    }

    node->cb       = cb;
    node->user_ctx = user_ctx;
    node->next     = g_registry.subs;
    g_registry.subs = node;

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_OK;
}

/*-----------------------------------------------------------*/
int
rg_model_unsubscribe(rg_model_event_cb cb, void *user_ctx)
{
    if (!cb) return RG_MODEL_ERR_INVALID;

    pthread_mutex_lock(&g_registry.lock);

    rg_sub_node_t **indirect = &g_registry.subs;
    while (*indirect) {
        if ((*indirect)->cb == cb && (*indirect)->user_ctx == user_ctx) {
            rg_sub_node_t *victim = *indirect;
            *indirect = victim->next;
            free(victim);
            pthread_mutex_unlock(&g_registry.lock);
            return RG_MODEL_OK;
        }
        indirect = &(*indirect)->next;
    }

    pthread_mutex_unlock(&g_registry.lock);
    return RG_MODEL_ERR_NOTFOUND;
}

#endif /* MODEL_REGISTRY_IMPLEMENTATION */
#endif /* RETINAGUARD_MODEL_REGISTRY_H */
