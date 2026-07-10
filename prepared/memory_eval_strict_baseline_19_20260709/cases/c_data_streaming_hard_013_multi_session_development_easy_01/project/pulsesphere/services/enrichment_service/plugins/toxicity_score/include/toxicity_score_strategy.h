/**
 * PulseSphere - Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * Toxicity Scoring Strategy – Public API & Optional Implementation
 *
 * File: pulsesphere/services/enrichment_service/plugins/toxicity_score/include/toxicity_score_strategy.h
 *
 * This header exposes the Strategy-Pattern based plug-in interface used by the
 * enrichment_service for computing toxicity scores on social-pulse events.
 *
 * The header can be consumed in two ways:
 *
 *   1. As a pure declaration header by simply including it from client code.
 *   2. As a single-translation-unit, header-only implementation by defining
 *        #define TOXICITY_SCORE_STRATEGY_IMPLEMENTATION
 *      in exactly ONE C source file before including this header.
 *
 * Both usages produce a thread-safe, production-grade implementation that
 * allows hot registration and selection of alternative strategies at run-time.
 */

#ifndef PULSESHPHERE_TOXICITY_SCORE_STRATEGY_H
#define PULSESHPHERE_TOXICITY_SCORE_STRATEGY_H

/* ========================================================================== */
/*  Dependencies                                                              */
/* ========================================================================== */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Forward declaration of the unified PulseSphere event type. The concrete
 * definition lives in `pulse_event.h` within the core ingestion service. */
typedef struct pulse_event pulse_event_t;

/* ========================================================================== */
/*  Error Codes                                                               */
/* ========================================================================== */

typedef enum {
    TOXICITY_SCORE_OK          = 0,    /* Operation successful                       */
    TOXICITY_SCORE_ENULL       = -1,   /* Null pointer supplied                      */
    TOXICITY_SCORE_EINVAL      = -2,   /* Invalid argument / malformed data          */
    TOXICITY_SCORE_ENOMEM      = -3,   /* Memory allocation failure                  */
    TOXICITY_SCORE_EINIT       = -4,   /* Strategy-specific initialization failure    */
    TOXICITY_SCORE_ENOENT      = -5,   /* Strategy not found                         */
    TOXICITY_SCORE_EBUSY       = -6,   /* Attempt to unregister a busy strategy      */
    TOXICITY_SCORE_EVERSION    = -7,   /* Incompatible API version                   */
    TOXICITY_SCORE_ESTATE      = -8,   /* Bad internal/opaque state                  */
    TOXICITY_SCORE_EUNKNOWN    = -255  /* Unknown/unspecified error                  */
} toxicity_score_rc_t;

/* ========================================================================== */
/*  Strategy Operations Table                                                 */
/* ========================================================================== */

/*
 * Each strategy implements the following set of operations.
 * The enrichment service will invoke them through this table only.
 */
typedef struct toxicity_score_strategy_ops {

    /* ------------------------------------------------------------------ */
    /* int init(void **state, const char *config_json);                    */
    /* ------------------------------------------------------------------ */
    /* `state`       : Out parameter. On success it MUST be assigned an    */
    /*                 opaque pointer that will later be passed to        */
    /*                 score() and cleanup().                              */
    /* `config_json` : Optional JSON string containing strategy-specific   */
    /*                 config. May be NULL.                                */
    /* Return        : TOXICITY_SCORE_OK on success, or negative error     */
    /*                 code on failure.                                    */
    int  (*init)(void **state, const char *config_json);

    /* ------------------------------------------------------------------ */
    /* int score(void *state, const pulse_event_t *event, double *score);  */
    /* ------------------------------------------------------------------ */
    /* Computes a toxicity score in the range [0.0, 1.0].                  */
    /*                                                                    */
    /* `state` : Opaque strategy instance returned from init().            */
    /* `event` : Immutable pointer to the pulse event to be scored.        */
    /* `score` : Out parameter receiving the computed score.               */
    /* Return  : TOXICITY_SCORE_OK, or a negative error code.              */
    int  (*score)(void                   *state,
                  const pulse_event_t    *event,
                  double                 *score);

    /* ------------------------------------------------------------------ */
    /* void cleanup(void *state);                                          */
    /* ------------------------------------------------------------------ */
    /* Releases any resources allocated in init(). It MUST be safe to call */
    /* even if init() failed, provided the state pointer is NULL in that   */
    /* scenario.                                                           */
    void (*cleanup)(void *state);

} toxicity_score_strategy_ops_t;

/* ========================================================================== */
/*  Strategy Descriptor                                                       */
/* ========================================================================== */

typedef struct toxicity_score_strategy {
    const char                          *name;     /* Unique, stable name    */
    uint32_t                             version;  /* Must equal API version */
    const toxicity_score_strategy_ops_t *ops;      /* Operations table       */
    void                                *state;    /* Populated by registry  */
} toxicity_score_strategy_t;

/* Current API version. Increment on any breaking change. */
#define TOXICITY_SCORE_API_VERSION   0x0001U

/* ========================================================================== */
/*  Registry API                                                              */
/* ========================================================================== */

/* Registers a strategy with the global registry. The registry takes a deep
 * copy of the descriptor, but DOES NOT copy the pointed-to `ops` table. The
 * pointed-to `ops` table and the string `name` must therefore remain valid for
 * the lifetime of the process (they are typically `static const`).           */
int toxicity_score_strategy_register(const toxicity_score_strategy_t *strategy);

/* Unregisters a strategy. The registry invokes ops->cleanup() automatically
 * before removal. Returns TOXICITY_SCORE_EBUSY if the strategy is currently
 * active in any thread.                                                      */
int toxicity_score_strategy_unregister(const char *strategy_name);

/* Selects a strategy for the calling thread. Selection is maintained using
 * thread-local storage (TLS) to avoid contention.                            */
int toxicity_score_strategy_select(const char *strategy_name);

/* Scores an event using the strategy currently selected for the calling
 * thread.                                                                    */
int toxicity_score_strategy_score(const pulse_event_t *event, double *out_score);

/* Returns a JSON Schema (Draft-07) string describing the common configuration
 * envelope accepted by all built-in strategies. The lifetime of the returned
 * string is static – DO NOT free.                                            */
const char *toxicity_score_strategy_builtin_config_schema(void);

/* ========================================================================== */
/*  Convenience Compile-Time Registration                                     */
/* ========================================================================== */

#if defined(__GNUC__) || defined(__clang__)
/* Registers the provided strategy automatically when the containing shared
 * object / executable is loaded.                                            */
#define TOXICITY_STRATEGY_EXPORT(STRAT_PTR)                             \
    __attribute__((constructor)) static void _toxicity_autoreg(void) {  \
        toxicity_score_strategy_register((STRAT_PTR));                  \
    }
#else
#pragma message("Constructor attribute not available on this compiler; " \
                "call toxicity_score_strategy_register() manually.")
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

/* ========================================================================== */
/*  Optional Header-Only Implementation                                       */
/* ========================================================================== */
#ifdef TOXICITY_SCORE_STRATEGY_IMPLEMENTATION

/* Implementation dependencies */
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* -------------------------------------------------------------------------- */
/*  Internal Registry Structure                                               */
/* -------------------------------------------------------------------------- */

typedef struct strategy_registry {
    toxicity_score_strategy_t **vec;   /* Dynamic array of pointers          */
    size_t                      len;   /* Populated elements                 */
    size_t                      cap;   /* Allocated capacity                 */
    pthread_rwlock_t            lock;  /* RW-lock protecting the array       */
} strategy_registry_t;

/* One global registry instance, lazily initialised. */
static strategy_registry_t g_registry = {
    .vec  = NULL,
    .len  = 0,
    .cap  = 0,
    .lock = PTHREAD_RWLOCK_INITIALIZER
};

/* Per-thread selected strategy pointer. */
static _Thread_local const toxicity_score_strategy_t *tls_active_strategy = NULL;

/* -------------------------------------------------------------------------- */
/*  Utility Helpers                                                           */
/* -------------------------------------------------------------------------- */

static void *psphere_calloc(size_t n, size_t sz)
{
    void *p = calloc(n, sz);
    return p;
}

static int registry_grow(strategy_registry_t *reg)
{
    const size_t new_cap = reg->cap ? reg->cap * 2u : 8u;
    toxicity_score_strategy_t **tmp =
        realloc(reg->vec, new_cap * sizeof(*reg->vec));
    if (!tmp) {
        return TOXICITY_SCORE_ENOMEM;
    }
    reg->vec = tmp;
    reg->cap = new_cap;
    return TOXICITY_SCORE_OK;
}

static int registry_find(strategy_registry_t *reg,
                         const char *name,
                         size_t *idx_out)
{
    for (size_t i = 0; i < reg->len; ++i) {
        if (strcmp(reg->vec[i]->name, name) == 0) {
            if (idx_out) *idx_out = i;
            return 1; /* Found */
        }
    }
    return 0; /* Not found */
}

/* -------------------------------------------------------------------------- */
/*  Public API Implementation                                                 */
/* -------------------------------------------------------------------------- */

int toxicity_score_strategy_register(const toxicity_score_strategy_t *strategy)
{
    if (!strategy || !strategy->name || !strategy->ops) {
        return TOXICITY_SCORE_ENULL;
    }
    if (strategy->version != TOXICITY_SCORE_API_VERSION) {
        return TOXICITY_SCORE_EVERSION;
    }

    /* Deep copy descriptor (shallow copy of ops pointer) */
    toxicity_score_strategy_t *copy =
        psphere_calloc(1, sizeof(*copy));
    if (!copy) {
        return TOXICITY_SCORE_ENOMEM;
    }

    copy->name    = strategy->name; /* Assume static storage */
    copy->version = strategy->version;
    copy->ops     = strategy->ops;
    copy->state   = NULL;

    /* Strategy-specific initialisation */
    if (copy->ops->init) {
        int rc = copy->ops->init(&copy->state, NULL /* default config */);
        if (rc != TOXICITY_SCORE_OK) {
            free(copy);
            return rc;
        }
    }

    /* Registry insertion */
    pthread_rwlock_wrlock(&g_registry.lock);

    /* Prevent duplicate names */
    if (registry_find(&g_registry, copy->name, NULL)) {
        pthread_rwlock_unlock(&g_registry.lock);
        copy->ops->cleanup ? copy->ops->cleanup(copy->state) : (void)0;
        free(copy);
        return TOXICITY_SCORE_EINVAL;
    }

    if (g_registry.len == g_registry.cap) {
        int rc = registry_grow(&g_registry);
        if (rc != TOXICITY_SCORE_OK) {
            pthread_rwlock_unlock(&g_registry.lock);
            copy->ops->cleanup ? copy->ops->cleanup(copy->state) : (void)0;
            free(copy);
            return rc;
        }
    }
    g_registry.vec[g_registry.len++] = copy;

    pthread_rwlock_unlock(&g_registry.lock);
    return TOXICITY_SCORE_OK;
}

int toxicity_score_strategy_unregister(const char *strategy_name)
{
    if (!strategy_name) {
        return TOXICITY_SCORE_ENULL;
    }

    pthread_rwlock_wrlock(&g_registry.lock);
    size_t idx;
    if (!registry_find(&g_registry, strategy_name, &idx)) {
        pthread_rwlock_unlock(&g_registry.lock);
        return TOXICITY_SCORE_ENOENT;
    }

    toxicity_score_strategy_t *strat = g_registry.vec[idx];

    /* Check if currently active in *any* thread.
     * NOTE: We only have access to our TLS; to be conservative, deny removal
     * if strat matches current thread selection. A full implementation could
     * track reference counts across threads. */
    if (tls_active_strategy == strat) {
        pthread_rwlock_unlock(&g_registry.lock);
        return TOXICITY_SCORE_EBUSY;
    }

    /* Call cleanup */
    if (strat->ops->cleanup) {
        strat->ops->cleanup(strat->state);
    }

    /* Removal: shift tail */
    for (size_t i = idx + 1; i < g_registry.len; ++i) {
        g_registry.vec[i - 1] = g_registry.vec[i];
    }
    g_registry.len--;

    pthread_rwlock_unlock(&g_registry.lock);
    free(strat);
    return TOXICITY_SCORE_OK;
}

int toxicity_score_strategy_select(const char *strategy_name)
{
    if (!strategy_name) {
        tls_active_strategy = NULL;
        return TOXICITY_SCORE_ENOENT;
    }

    pthread_rwlock_rdlock(&g_registry.lock);

    size_t idx;
    if (!registry_find(&g_registry, strategy_name, &idx)) {
        pthread_rwlock_unlock(&g_registry.lock);
        return TOXICITY_SCORE_ENOENT;
    }

    tls_active_strategy = g_registry.vec[idx];
    pthread_rwlock_unlock(&g_registry.lock);
    return TOXICITY_SCORE_OK;
}

int toxicity_score_strategy_score(const pulse_event_t *event, double *out_score)
{
    if (!tls_active_strategy || !event || !out_score) {
        return TOXICITY_SCORE_ENULL;
    }

    const toxicity_score_strategy_ops_t *ops = tls_active_strategy->ops;
    if (!ops || !ops->score) {
        return TOXICITY_SCORE_ESTATE;
    }

    return ops->score(tls_active_strategy->state, event, out_score);
}

/* Built-in config schema. For brevity this is a minimal stub; in production
 * this would be a full JSON Schema Draft-07 document. */
const char *toxicity_score_strategy_builtin_config_schema(void)
{
    return "{\n"
           "  \"$schema\": \"http://json-schema.org/draft-07/schema#\",\n"
           "  \"title\": \"ToxicityScoreStrategyConfig\",\n"
           "  \"type\": \"object\",\n"
           "  \"properties\": {\n"
           "    \"language\":  { \"type\": \"string\" },\n"
           "    \"threshold\": { \"type\": \"number\", \"minimum\": 0, \"maximum\": 1 }\n"
           "  },\n"
           "  \"additionalProperties\": true\n"
           "}\n";
}

#endif /* TOXICITY_SCORE_STRATEGY_IMPLEMENTATION */
#endif /* PULSESHPHERE_TOXICITY_SCORE_STRATEGY_H */
