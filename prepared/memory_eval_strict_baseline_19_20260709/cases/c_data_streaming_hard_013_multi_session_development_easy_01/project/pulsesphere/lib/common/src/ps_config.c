/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * File     : pulsesphere/lib/common/src/ps_config.c
 * Purpose  : Centralised, thread-safe configuration loader / accessor
 * Author   : PulseSphere Core Team
 *
 * Synopsis :
 *      #include "ps_config.h"
 *
 *      if (ps_config_init("/etc/pulsesphere/pulsesphere.conf", /* allow_missing = */ 0) != 0) {
 *          fprintf(stderr, "fatal: unable to load configuration\n");
 *          exit(EXIT_FAILURE);
 *      }
 *
 *      const char *host = ps_config_get_str("stream.broker.host", "localhost");
 *      long         pt = ps_config_get_int("stream.broker.port", 9092);
 *
 *      ...
 *      ps_config_destroy();
 *
 * Description:
 *      The configuration subsystem implements a hierarchical lookup strategy:
 *
 *        1. Runtime overrides              (ps_config_set_* APIs)     – highest priority
 *        2. Environment variables          (PS_<KEY>)                – medium priority
 *        3. Configuration file values                                    – low priority
 *        4. Compile-time / call-site defaults                            – lowest priority
 *
 *      Keys are case-insensitive and may contain dots.  Environment variable
 *      adaptation performs the following rewrite:
 *
 *          stream.broker.port  ->  PS_STREAM_BROKER_PORT
 *
 *      The file format is an INI-like `key = value` syntax with optional
 *      [section] headers.  Lines starting with ‘#’ or ‘;’ are ignored.
 *
 *      Thread-safety:
 *          All getters / setters are thread-safe and lock internally.  Callers
 *          should avoid holding the lock longer than necessary.
 *
 *      Dependencies:
 *          • POSIX pthreads
 *          • uthash (https://troydhanson.github.io/uthash/)
 *
 *      Build flags (example):
 *          gcc -Wall -pedantic -pthread -I./external/uthash -c ps_config.c
 */

#include <ctype.h>
#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "uthash.h"     /* Header-only hash-table (not provided here)     */
#include "ps_config.h"  /* Public interface for this source file          */

#define PS_ENV_PREFIX "PS_"          /* Prefix used for env-var overrides  */
#define PS_MAX_LINE   4096           /* Maximum length of a single conf line */

/*----------------------------- Internal types ----------------------------*/
typedef struct ps_conf_kv {
    char          *key;     /* Lower-case normalised key */
    char          *val;     /* Original (trimmed) value  */
    UT_hash_handle hh;
} ps_conf_kv_t;

typedef struct {
    ps_conf_kv_t  *file_map;   /* Values loaded from configuration file      */
    ps_conf_kv_t  *override;   /* Runtime overrides (set via API)            */
    pthread_mutex_t lock;      /* Global lock guarding both hash maps        */
    char           *cfg_path;  /* Path used for initial (and reload) loading */
    time_t          mtime;     /* Last modification time of cfg file         */
    bool            initialised;
} ps_conf_ctx_t;

/*--------------------------- Static declarations -------------------------*/
static ps_conf_ctx_t g_ctx = {
    .file_map     = NULL,
    .override     = NULL,
    .lock         = PTHREAD_MUTEX_INITIALIZER,
    .cfg_path     = NULL,
    .mtime        = 0,
    .initialised  = false,
};

/*------------------------- Utility helper functions ----------------------*/

/* Trim leading / trailing whitespace in-place */
static char *trim_ws(char *s)
{
    if (!s) return s;
    /* leading */
    while (isspace((unsigned char)*s)) s++;

    /* trailing */
    char *end = s + strlen(s);
    while (end > s && isspace((unsigned char)*(end - 1))) --end;
    *end = '\0';
    return s;
}

/* Convert key to canonical (lower-case) representation */
static char *key_canonical(const char *src)
{
    size_t len = strlen(src);
    char  *dst = malloc(len + 1);
    if (!dst) return NULL;

    for (size_t i = 0; i < len; ++i) {
        dst[i] = (char)tolower((unsigned char)src[i]);
    }
    dst[len] = '\0';
    return dst;
}

/* Insert or update entry in specified hash map */
static int map_put(ps_conf_kv_t **map, const char *key, const char *val)
{
    ps_conf_kv_t *entry = NULL;
    char *canon = key_canonical(key);
    if (!canon) return -1;

    HASH_FIND_STR(*map, canon, entry);
    if (entry) {
        free(entry->val);
        entry->val = strdup(val);
        free(canon);
        if (!entry->val) return -1;
    } else {
        entry = calloc(1, sizeof(*entry));
        if (!entry) { free(canon); return -1; }

        entry->key = canon;
        entry->val = strdup(val);
        if (!entry->val) { free(entry->key); free(entry); return -1; }
        HASH_ADD_KEYPTR(hh, *map, entry->key, strlen(entry->key), entry);
    }
    return 0;
}

/* Lookup key in map (case-insensitive) */
static const char *map_get(ps_conf_kv_t *map, const char *key)
{
    char *canon = key_canonical(key);
    if (!canon) return NULL;

    ps_conf_kv_t *entry = NULL;
    HASH_FIND_STR(map, canon, entry);
    free(canon);
    return entry ? entry->val : NULL;
}

/* Clear / free map */
static void map_free(ps_conf_kv_t **map)
{
    ps_conf_kv_t *cur, *tmp;
    HASH_ITER(hh, *map, cur, tmp) {
        HASH_DEL(*map, cur);
        free(cur->key);
        free(cur->val);
        free(cur);
    }
    *map = NULL;
}

/* Translate internal key -> environment variable name */
static void key_to_env(const char *key, char *buf, size_t bufsz)
{
    /* Example:
     *   stream.broker.port -> PS_STREAM_BROKER_PORT
     */
    size_t len = 0;
    len += snprintf(buf + len, bufsz - len, PS_ENV_PREFIX);

    for (const char *p = key; *p && len < bufsz - 1; ++p) {
        char c = (char)toupper((unsigned char)*p);
        if (c == '.') c = '_';
        buf[len++] = c;
    }
    buf[len] = '\0';
}

/* Load configuration file into g_ctx.file_map */
static int load_file_locked(const char *path, ps_conf_kv_t **out_map, time_t *out_mtime)
{
    FILE *fp = fopen(path, "r");
    if (!fp) return (errno == ENOENT) ? PS_CFG_ERR_NOFILE : PS_CFG_ERR_IO;

    struct stat st;
    if (fstat(fileno(fp), &st) != 0) {
        fclose(fp);
        return PS_CFG_ERR_IO;
    }

    ps_conf_kv_t *tmp_map = NULL;
    char  line[PS_MAX_LINE + 1];
    char  cur_section[128] = {0};

    while (fgets(line, sizeof(line), fp)) {
        char *stripped = trim_ws(line);

        /* Skip empty / comment lines */
        if (*stripped == '\0' || *stripped == '#' || *stripped == ';')
            continue;

        /* Section header */
        if (*stripped == '[') {
            char *end = strchr(stripped, ']');
            if (!end) continue; /* malformed */
            *end = '\0';
            strncpy(cur_section, trim_ws(stripped + 1), sizeof(cur_section) - 1);
            cur_section[sizeof(cur_section) - 1] = '\0';
            continue;
        }

        /* Key=value pair */
        char *eq = strchr(stripped, '=');
        if (!eq) continue; /* malformed */
        *eq = '\0';
        char *k = trim_ws(stripped);
        char *v = trim_ws(eq + 1);

        char full_key[256];
        if (*cur_section) {
            snprintf(full_key, sizeof(full_key), "%s.%s", cur_section, k);
        } else {
            snprintf(full_key, sizeof(full_key), "%s", k);
        }

        if (map_put(&tmp_map, full_key, v) != 0) {
            map_free(&tmp_map);
            fclose(fp);
            return PS_CFG_ERR_OOM;
        }
    }

    fclose(fp);

    /* Replace old map with new */
    map_free(out_map);
    *out_map  = tmp_map;
    *out_mtime = st.st_mtime;
    return PS_CFG_OK;
}

/*--------------------------- Public API functions ------------------------*/
int ps_config_init(const char *cfg_path, int allow_missing)
{
    if (!cfg_path) return PS_CFG_ERR_INVAL;

    pthread_mutex_lock(&g_ctx.lock);

    if (g_ctx.initialised) {
        pthread_mutex_unlock(&g_ctx.lock);
        return PS_CFG_ERR_AGAIN;
    }

    g_ctx.cfg_path = strdup(cfg_path);
    if (!g_ctx.cfg_path) {
        pthread_mutex_unlock(&g_ctx.lock);
        return PS_CFG_ERR_OOM;
    }

    int rc = load_file_locked(cfg_path, &g_ctx.file_map, &g_ctx.mtime);
    if (rc != PS_CFG_OK) {
        if (rc == PS_CFG_ERR_NOFILE && allow_missing) {
            rc = PS_CFG_OK;   /* treat as empty configuration */
        } else {
            free(g_ctx.cfg_path);
            g_ctx.cfg_path = NULL;
            pthread_mutex_unlock(&g_ctx.lock);
            return rc;
        }
    }

    g_ctx.initialised = true;
    pthread_mutex_unlock(&g_ctx.lock);
    return PS_CFG_OK;
}

void ps_config_destroy(void)
{
    pthread_mutex_lock(&g_ctx.lock);

    if (!g_ctx.initialised) {
        pthread_mutex_unlock(&g_ctx.lock);
        return;
    }

    map_free(&g_ctx.file_map);
    map_free(&g_ctx.override);
    free(g_ctx.cfg_path);
    g_ctx.cfg_path = NULL;
    g_ctx.initialised = false;

    pthread_mutex_unlock(&g_ctx.lock);
}

int ps_config_reload(void)
{
    pthread_mutex_lock(&g_ctx.lock);
    if (!g_ctx.initialised) {
        pthread_mutex_unlock(&g_ctx.lock);
        return PS_CFG_ERR_NOINIT;
    }

    struct stat st;
    if (stat(g_ctx.cfg_path, &st) != 0) {
        pthread_mutex_unlock(&g_ctx.lock);
        return (errno == ENOENT) ? PS_CFG_ERR_NOFILE : PS_CFG_ERR_IO;
    }

    if (st.st_mtime <= g_ctx.mtime) {
        pthread_mutex_unlock(&g_ctx.lock);
        return PS_CFG_OK;   /* nothing to do */
    }

    /* Reload */
    int rc = load_file_locked(g_ctx.cfg_path, &g_ctx.file_map, &g_ctx.mtime);
    pthread_mutex_unlock(&g_ctx.lock);
    return rc;
}

int ps_config_set_str(const char *key, const char *val)
{
    if (!key || !val) return PS_CFG_ERR_INVAL;
    pthread_mutex_lock(&g_ctx.lock);
    if (!g_ctx.initialised) {
        pthread_mutex_unlock(&g_ctx.lock);
        return PS_CFG_ERR_NOINIT;
    }

    int rc = map_put(&g_ctx.override, key, val) == 0 ? PS_CFG_OK : PS_CFG_ERR_OOM;
    pthread_mutex_unlock(&g_ctx.lock);
    return rc;
}

const char *ps_config_get_str(const char *key, const char *fallback)
{
    static __thread char  env_var[256];
    const char           *ret = NULL;

    pthread_mutex_lock(&g_ctx.lock);
    if (!g_ctx.initialised) {
        pthread_mutex_unlock(&g_ctx.lock);
        return fallback;
    }

    /* 1) Runtime override */
    ret = map_get(g_ctx.override, key);
    if (ret) { pthread_mutex_unlock(&g_ctx.lock); return ret; }

    pthread_mutex_unlock(&g_ctx.lock);  /* Release lock before getenv */

    /* 2) Environment variable */
    key_to_env(key, env_var, sizeof(env_var));
    ret = getenv(env_var);
    if (ret) return ret;

    pthread_mutex_lock(&g_ctx.lock);
    /* 3) Configuration file */
    ret = map_get(g_ctx.file_map, key);
    pthread_mutex_unlock(&g_ctx.lock);
    if (ret) return ret;

    /* 4) Fallback */
    return fallback;
}

long ps_config_get_int(const char *key, long fallback)
{
    const char *s = ps_config_get_str(key, NULL);
    if (!s) return fallback;

    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s || *end != '\0') return fallback;
    return v;
}

double ps_config_get_double(const char *key, double fallback)
{
    const char *s = ps_config_get_str(key, NULL);
    if (!s) return fallback;

    char *end = NULL;
    double v = strtod(s, &end);
    if (end == s || *end != '\0') return fallback;
    return v;
}

bool ps_config_get_bool(const char *key, bool fallback)
{
    const char *s = ps_config_get_str(key, NULL);
    if (!s) return fallback;

    if (strcasecmp(s, "true") == 0 || strcasecmp(s, "yes") == 0 ||
        strcasecmp(s, "1") == 0 || strcasecmp(s, "on") == 0)
        return true;
    if (strcasecmp(s, "false") == 0 || strcasecmp(s, "no") == 0 ||
        strcasecmp(s, "0") == 0 || strcasecmp(s, "off") == 0)
        return false;
    return fallback;
}

/* Convenience setters for other primitive types */
int ps_config_set_int(const char *key, long val)
{
    char buf[32];
    snprintf(buf, sizeof(buf), "%ld", val);
    return ps_config_set_str(key, buf);
}

int ps_config_set_double(const char *key, double val)
{
    char buf[64];
    snprintf(buf, sizeof(buf), "%.10g", val);
    return ps_config_set_str(key, buf);
}

int ps_config_set_bool(const char *key, bool val)
{
    return ps_config_set_str(key, val ? "true" : "false");
}

/*----------------------- Debug / diagnostic utilities --------------------*/
#ifdef PS_CONFIG_DEBUG
void ps_config_dump(FILE *out)
{
    if (!out) out = stdout;

    pthread_mutex_lock(&g_ctx.lock);
    fprintf(out, "=== PulseSphere configuration dump ===\n");

    fprintf(out, "[Overrides]\n");
    for (ps_conf_kv_t *e = g_ctx.override; e; e = e->hh.next) {
        fprintf(out, "%s = %s\n", e->key, e->val);
    }

    fprintf(out, "\n[File: %s]\n", g_ctx.cfg_path ? g_ctx.cfg_path : "(null)");
    for (ps_conf_kv_t *e = g_ctx.file_map; e; e = e->hh.next) {
        fprintf(out, "%s = %s\n", e->key, e->val);
    }
    fprintf(out, "======================================\n");
    pthread_mutex_unlock(&g_ctx.lock);
}
#endif /* PS_CONFIG_DEBUG */
