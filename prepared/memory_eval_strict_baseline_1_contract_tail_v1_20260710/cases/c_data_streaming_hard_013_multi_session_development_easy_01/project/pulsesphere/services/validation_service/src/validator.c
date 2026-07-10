/****************************************************************************************
 * PulseSphere Validation Service - validator.c
 * --------------------------------------------------------------------------
 * Production-quality validator responsible for schema-on-read validation of
 * incoming “pulse” events (JSON encoded) before they are admitted into the
 * internal event fabric.
 *
 *  Key features
 *  -------------
 *  • Rule-based validator (Strategy pattern) – pluggable validation rules
 *  • Thread-safe API – designed for high-throughput, multi-producer scenarios
 *  • Fast duplicate detection cache to drop replayed events
 *  • Exhaustive error reporting with bounded log noise (rate-limited)
 *
 *  NOTE: This compilation unit purposefully keeps all implementation details
 *  private.  The corresponding public API is declared in `validator.h`.
 *
 ****************************************************************************************/

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <pthread.h>

/* Third-party light-weight JSON parser (compile with -lcjson) */
#include <cjson/cJSON.h>

/* PulseSphere internal headers */
#include "validator.h"     /* Public interface for this component           */
#include "ps_clock.h"      /* Monotonic / wall-clock utilities              */
#include "ps_metrics.h"    /* Metrics counters (increment, gauge, etc.)     */

/* -----------------------------------------------------------------------------
 * Local logging helpers (fallback to stderr when higher-level logger absent)
 * -------------------------------------------------------------------------- */
#ifndef PS_LOG_ERROR
#define PS_LOG_ERROR(fmt, ...) \
        fprintf(stderr, "[%s:%d] ERROR: " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__)
#endif

#ifndef PS_LOG_WARN
#define PS_LOG_WARN(fmt, ...)  \
        fprintf(stderr, "[%s:%d] WARN : " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__)
#endif

#ifndef PS_LOG_INFO
#define PS_LOG_INFO(fmt, ...)  \
        fprintf(stderr, "[%s:%d] INFO : " fmt "\n", __FILE__, __LINE__, ##__VA_ARGS__)
#endif

/* =============================================================================
 *                              CONSTANTS / MACROS
 * ========================================================================== */

/* How far in the future/out-of-date an event timestamp may drift (seconds)   */
#define CLOCK_SKEW_FWD_SEC      20
#define CLOCK_SKEW_BACK_SEC    900    /* 15 minutes                            */

/* Duplicate detection cache parameters                                       */
#define DUP_CACHE_SIZE        4096    /* Must be power-of-two for fast mask    */
#define DUP_CACHE_MASK  (DUP_CACHE_SIZE - 1)

/* Rate-limit invalid events log after N hits per time window                 */
#define ERR_RATE_LIMIT          64    /* Burst allowance                       */
#define ERR_TIME_WINDOW_SEC     10

/* =============================================================================
 *                              DATA STRUCTURES
 * ========================================================================== */

/* Prototype for a single validation rule strategy                            */
typedef bool (*validator_rule_fn)(const cJSON    *evt,
                                  char           *err_buf,
                                  size_t          err_cap);

/* Internal wrapper storing rule meta-data                                    */
typedef struct {
    validator_rule_fn fn;
    char              name[32];
} rule_entry_t;

/* Duplicate detection circular cache (lock-protected)                        */
typedef struct {
    uint64_t ids[DUP_CACHE_SIZE];
    uint32_t cursor;
} dup_cache_t;

/* Validator context – singleton instanced via validator_init()               */
typedef struct {
    rule_entry_t *rules;
    size_t        rule_cnt;
    size_t        rule_cap;

    dup_cache_t   dup_cache;

    /* Statistics */
    uint64_t      total_seen;
    uint64_t      total_valid;
    uint64_t      total_invalid;

    /* Log rate-limiting */
    uint64_t      err_window_hits;
    time_t        err_window_start;

    pthread_rwlock_t rwlock;   /* protects rule vector                        */
    pthread_mutex_t  dup_mtx;  /* protects duplicate cache                    */
} validator_ctx_t;

/* =============================================================================
 *                           FORWARD DECLARATIONS
 * ========================================================================== */

static bool rule_required_fields(const cJSON *evt,
                                 char *err_buf, size_t err_cap);

static bool rule_timestamp_freshness(const cJSON *evt,
                                     char *err_buf, size_t err_cap);

static bool rule_not_duplicate(const cJSON *evt,
                               char *err_buf, size_t err_cap);

static uint64_t hash64_fnv1a(const char *data, size_t len);

/* =============================================================================
 *                               STATIC STATE
 * ========================================================================== */

static validator_ctx_t g_ctx = {
    .rules      = NULL,
    .rule_cnt   = 0,
    .rule_cap   = 0,
    .dup_cache  = { .cursor = 0 },
    .total_seen = 0,
    .total_valid   = 0,
    .total_invalid = 0,
    .err_window_hits  = 0,
    .err_window_start = 0,
    .rwlock = PTHREAD_RWLOCK_INITIALIZER,
    .dup_mtx = PTHREAD_MUTEX_INITIALIZER
};

/* =============================================================================
 *                         INTERNAL UTILITY IMPLEMENTATION
 * ========================================================================== */

/* FNV-1a 64-bit hash for fast, non-cryptographic fingerprinting               */
static uint64_t hash64_fnv1a(const char *data, size_t len)
{
    const uint64_t FNV_PRIME = 1099511628211ULL;
    uint64_t hash = 14695981039346656037ULL;   /* offset basis */

    for (size_t i = 0; i < len; ++i) {
        hash ^= (uint8_t)data[i];
        hash *= FNV_PRIME;
    }
    return hash;
}

/* ---------------------------------------------------------------------------
 * duplicate_cache_insert()
 *  Return true if id is new (i.e., not contained in cache); false otherwise.
 * -------------------------------------------------------------------------- */
static bool duplicate_cache_insert(dup_cache_t *cache, uint64_t id)
{
    pthread_mutex_lock(&g_ctx.dup_mtx);

    uint32_t slot = (uint32_t)id & DUP_CACHE_MASK;
    bool is_dup = (cache->ids[slot] == id);

    cache->ids[slot] = id;

    pthread_mutex_unlock(&g_ctx.dup_mtx);
    return !is_dup;
}

/* ---------------------------------------------------------------------------
 * should_log_error()
 *  Basic token-bucket style rate limiting to avoid log spam under attack.
 * -------------------------------------------------------------------------- */
static bool should_log_error(void)
{
    time_t now = time(NULL);

    if ((now - g_ctx.err_window_start) > ERR_TIME_WINDOW_SEC) {
        g_ctx.err_window_start = now;
        g_ctx.err_window_hits  = 0;
        return true;
    }

    if (g_ctx.err_window_hits++ < ERR_RATE_LIMIT) {
        return true;
    }
    return false;
}

/* =============================================================================
 *                         BUILT-IN VALIDATION RULES
 * ========================================================================== */

/* ---------------------------------------------------------------------------
 * rule_required_fields()
 *  Ensures presence of mandatory top-level fields and their types.
 * -------------------------------------------------------------------------- */
static bool rule_required_fields(const cJSON *evt,
                                 char *err_buf, size_t err_cap)
{
    static const char *mandatory[] = {"id", "ts", "source", "type", NULL};

    for (size_t i = 0; mandatory[i]; ++i) {
        const cJSON *field = cJSON_GetObjectItemCaseSensitive(evt, mandatory[i]);
        if (!field) {
            snprintf(err_buf, err_cap, "Missing required field: '%s'", mandatory[i]);
            return false;
        }
        /* Quick type checks (id: string, ts: number, others string) */
        if (strcmp(mandatory[i], "id") == 0 && !cJSON_IsString(field)) {
            snprintf(err_buf, err_cap, "Field 'id' must be string");
            return false;
        }
        if (strcmp(mandatory[i], "ts") == 0 && !cJSON_IsNumber(field)) {
            snprintf(err_buf, err_cap, "Field 'ts' must be number (epoch ms)");
            return false;
        }
        if ((strcmp(mandatory[i], "source") == 0 ||
             strcmp(mandatory[i], "type")   == 0) && !cJSON_IsString(field)) {
            snprintf(err_buf, err_cap, "Field '%s' must be string", mandatory[i]);
            return false;
        }
    }
    return true;
}

/* ---------------------------------------------------------------------------
 * rule_timestamp_freshness()
 *  Reject events with timestamps too far in the past/future to curb abuse.
 * -------------------------------------------------------------------------- */
static bool rule_timestamp_freshness(const cJSON *evt,
                                     char *err_buf, size_t err_cap)
{
    const cJSON *ts = cJSON_GetObjectItemCaseSensitive(evt, "ts");
    if (!ts || !cJSON_IsNumber(ts)) {
        snprintf(err_buf, err_cap, "Missing/invalid 'ts' for freshness check");
        return false;
    }

    time_t now_sec = ps_clock_wall_seconds();      /* current wall clock in sec */
    time_t evt_sec = (time_t)(ts->valuedouble / 1000.0);

    if (evt_sec > (now_sec + CLOCK_SKEW_FWD_SEC)) {
        snprintf(err_buf, err_cap, "Timestamp is %.0f sec in the future",
                 difftime(evt_sec, now_sec));
        return false;
    }
    if (evt_sec < (now_sec - CLOCK_SKEW_BACK_SEC)) {
        snprintf(err_buf, err_cap, "Timestamp too old (%.0f sec)", difftime(now_sec, evt_sec));
        return false;
    }
    return true;
}

/* ---------------------------------------------------------------------------
 * rule_not_duplicate()
 *  Benign protection: discard obvious replayed events using weak hash cache.
 * -------------------------------------------------------------------------- */
static bool rule_not_duplicate(const cJSON *evt,
                               char *err_buf, size_t err_cap)
{
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(evt, "id");
    if (!id || !cJSON_IsString(id)) {
        snprintf(err_buf, err_cap, "Missing/invalid 'id' for duplicate check");
        return false;
    }

    uint64_t hash = hash64_fnv1a(id->valuestring, strlen(id->valuestring));
    bool unique = duplicate_cache_insert(&g_ctx.dup_cache, hash);

    if (!unique) {
        snprintf(err_buf, err_cap, "Duplicate event id detected");
        return false;
    }
    return true;
}

/* =============================================================================
 *                           PUBLIC API IMPLEMENTATION
 * ========================================================================== */

int validator_init(void)
{
    pthread_rwlock_wrlock(&g_ctx.rwlock);

    /* Reserve room for built-in rules + potential user extensions            */
    g_ctx.rule_cap = 8;
    g_ctx.rules = calloc(g_ctx.rule_cap, sizeof(rule_entry_t));
    if (!g_ctx.rules) {
        pthread_rwlock_unlock(&g_ctx.rwlock);
        PS_LOG_ERROR("validator_init(): calloc failed (%s)", strerror(errno));
        return -1;
    }

    /* Register built-in rules (order matters)                                */
    validator_register_rule(rule_required_fields,    "required_fields");
    validator_register_rule(rule_timestamp_freshness,"timestamp_freshness");
    validator_register_rule(rule_not_duplicate,      "no_duplicate");

    pthread_rwlock_unlock(&g_ctx.rwlock);

    PS_LOG_INFO("Validator initialized with %zu built-in rules", g_ctx.rule_cnt);
    return 0;
}

void validator_shutdown(void)
{
    pthread_rwlock_wrlock(&g_ctx.rwlock);

    free(g_ctx.rules);
    g_ctx.rules     = NULL;
    g_ctx.rule_cnt  = 0;
    g_ctx.rule_cap  = 0;

    pthread_rwlock_unlock(&g_ctx.rwlock);

    PS_LOG_INFO("Validator shut down");
}

int validator_register_rule(validator_rule_fn fn, const char *name)
{
    if (!fn || !name) {
        errno = EINVAL;
        return -1;
    }

    pthread_rwlock_wrlock(&g_ctx.rwlock);

    /* Grow vector if necessary */
    if (g_ctx.rule_cnt == g_ctx.rule_cap) {
        size_t new_cap = g_ctx.rule_cap * 2;
        rule_entry_t *tmp = realloc(g_ctx.rules, new_cap * sizeof(rule_entry_t));
        if (!tmp) {
            pthread_rwlock_unlock(&g_ctx.rwlock);
            PS_LOG_ERROR("validator_register_rule(): realloc failed (%s)", strerror(errno));
            return -1;
        }
        g_ctx.rules    = tmp;
        g_ctx.rule_cap = new_cap;
    }

    /* Store rule */
    g_ctx.rules[g_ctx.rule_cnt].fn = fn;
    snprintf(g_ctx.rules[g_ctx.rule_cnt].name,
             sizeof(g_ctx.rules[g_ctx.rule_cnt].name), "%s", name);
    g_ctx.rule_cnt++;

    pthread_rwlock_unlock(&g_ctx.rwlock);

    PS_LOG_INFO("Registered validation rule: %s", name);
    return 0;
}

/* ---------------------------------------------------------------------------
 * validator_validate()
 *  Validates JSON string `json` using installed rule set.
 *
 *  Returns:
 *      0 : valid
 *     >0 : invalid (errno preserved)
 *     <0 : internal error
 * -------------------------------------------------------------------------- */
int validator_validate(const char *json,
                       char       *err_buf,
                       size_t      err_cap)
{
    if (!json) {
        errno = EINVAL;
        return -1;
    }
    if (err_buf && err_cap)
        *err_buf = '\0';

    /* Parse JSON */
    cJSON *evt = cJSON_Parse(json);
    if (!evt) {
        if (err_buf && err_cap) {
            snprintf(err_buf, err_cap, "Malformed JSON payload");
        }
        PS_METRIC_COUNTER_INC("validator.malformed_json", 1);
        return 1;
    }

    /* Run through rule chain */
    pthread_rwlock_rdlock(&g_ctx.rwlock);

    bool ok = true;
    for (size_t i = 0; i < g_ctx.rule_cnt; ++i) {
        if (!g_ctx.rules[i].fn(evt, err_buf, err_cap)) {
            ok = false;
            if (should_log_error()) {
                PS_LOG_WARN("Validation failed [%s]: %s",
                            g_ctx.rules[i].name,
                            err_buf && *err_buf ? err_buf : "no reason");
            }
            PS_METRIC_COUNTER_INC("validator.rule_fail", 1);
            break;
        }
    }

    pthread_rwlock_unlock(&g_ctx.rwlock);

    /* House-keeping statistics */
    g_ctx.total_seen++;
    if (ok) {
        g_ctx.total_valid++;
    } else {
        g_ctx.total_invalid++;
    }

    cJSON_Delete(evt);
    return ok ? 0 : 1;
}

void validator_dump_stats(FILE *out)
{
    if (!out) out = stdout;

    fprintf(out,
            "Validator stats: seen=%" PRIu64 ", valid=%" PRIu64 ", invalid=%" PRIu64 "\n",
            g_ctx.total_seen, g_ctx.total_valid, g_ctx.total_invalid);
}

/* =============================================================================
 *                            END OF FILE
 * ========================================================================== */
