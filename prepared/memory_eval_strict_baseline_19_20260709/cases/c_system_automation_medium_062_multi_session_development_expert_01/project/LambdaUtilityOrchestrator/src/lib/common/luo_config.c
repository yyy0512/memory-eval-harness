/*
 * LambdaUtility Orchestrator (system_automation)
 * File:    src/lib/common/luo_config.c
 * Author:  LambdaUtility Engineering Team
 *
 * Summary:
 *  Lightweight run-time configuration manager for serverless functions.
 *  Configuration values are gathered from (in order of precedence):
 *      1. Explicit overrides via luo_config_init(<override_path>)
 *      2. Environment variable “LUO_CONFIG_FILE”
 *      3. Default baked-in path “/var/task/config.json” (AWS Lambda)
 *
 *  Within a configuration file, settings are expressed as JSON.  The parser
 *  flattens nested JSON into a dot-separated key path, e.g.:
 *      {
 *          "alerting" : { "slack_webhook" : "…" }
 *      }
 *  becomes key “alerting.slack_webhook”.
 *
 *  Finally, any environment variables with the prefix “LUO_” override values
 *  discovered in the JSON.  This allows quick one-off tweaks without having
 *  to ship a new configuration artifact.
 *
 *  Thread Safety:
 *      A global, read-mostly hash-map is protected by a RW-lock.  Updates are
 *      rare (only at init), so the cost is negligible.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <pthread.h>

#include "luo_config.h"   /* Public interface               */
#include "luo_log.h"      /* Simple wrapper around syslog   */

/* --- Third-party dependencies ------------------------------------------- */
#include "cJSON.h"        /* https://github.com/DaveGamble/cJSON            */
#include "uthash.h"       /* https://troydhanson.github.io/uthash/          */

/* ------------------------------------------------------------------------ */

#define DEFAULT_CONFIG_FILE   "/var/task/config.json"
#define ENV_CONFIG_FILE       "LUO_CONFIG_FILE"
#define ENV_PREFIX            "LUO_"

/* --- Internal structures ------------------------------------------------- */

typedef struct luo_kv_s
{
    char *key;                 /* dotted path */
    char *value;               /* raw string  */
    UT_hash_handle hh;         /* uthash handle */
} luo_kv_t;

/* --- Module globals ------------------------------------------------------ */

static luo_kv_t     *g_cfg_table     = NULL;        /* hash of settings            */
static pthread_rwlock_t g_cfg_lock   = PTHREAD_RWLOCK_INITIALIZER;
static int          g_is_initialized = 0;

/* --- Helper prototypes --------------------------------------------------- */

static int   load_json_file(const char *file_path);
static void  flatten_json(cJSON *item, const char *prefix);
static void  load_env_overrides(void);
static void  insert_or_update(const char *key, const char *value);
static char *strdup_safe(const char *src);

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

int luo_config_init(const char *file_override)
{
    int rc = 0;

    if (pthread_rwlock_wrlock(&g_cfg_lock) != 0)
        return LUO_CFG_ERR_LOCK;

    if (g_is_initialized)
    {
        pthread_rwlock_unlock(&g_cfg_lock);
        return LUO_CFG_SUCCESS;   /* already init’d */
    }

    char cfg_path[PATH_MAX] = {0};

    if (file_override && *file_override)
    {
        strncpy(cfg_path, file_override, sizeof(cfg_path) - 1);
    }
    else
    {
        const char *env_path = getenv(ENV_CONFIG_FILE);
        if (env_path && *env_path)
            strncpy(cfg_path, env_path, sizeof(cfg_path) - 1);
        else
            strncpy(cfg_path, DEFAULT_CONFIG_FILE, sizeof(cfg_path) - 1);
    }

    rc = load_json_file(cfg_path);
    if (rc != LUO_CFG_SUCCESS)
    {
        luo_log_error("Failed to load config file '%s' (rc=%d)", cfg_path, rc);
        pthread_rwlock_unlock(&g_cfg_lock);
        return rc;
    }

    load_env_overrides();

    g_is_initialized = 1;
    pthread_rwlock_unlock(&g_cfg_lock);

    luo_log_info("Configuration initialised with %d entries", HASH_COUNT(g_cfg_table));
    return LUO_CFG_SUCCESS;
}

void luo_config_cleanup(void)
{
    if (pthread_rwlock_wrlock(&g_cfg_lock) != 0)
        return;

    luo_kv_t *cur, *tmp;
    HASH_ITER(hh, g_cfg_table, cur, tmp)
    {
        HASH_DEL(g_cfg_table, cur);
        free(cur->key);
        free(cur->value);
        free(cur);
    }

    g_is_initialized = 0;
    pthread_rwlock_unlock(&g_cfg_lock);
}

const char *luo_config_get(const char *key, const char *default_value)
{
    if (!key)
        return default_value;

    if (pthread_rwlock_rdlock(&g_cfg_lock) != 0)
        return default_value;

    luo_kv_t *entry = NULL;
    HASH_FIND_STR(g_cfg_table, key, entry);

    const char *ret = (entry) ? entry->value : default_value;

    pthread_rwlock_unlock(&g_cfg_lock);
    return ret;
}

int luo_config_get_int(const char *key, int default_value)
{
    const char *val = luo_config_get(key, NULL);
    if (!val)
        return default_value;

    char *endptr = NULL;
    long  v      = strtol(val, &endptr, 10);
    if (endptr == val || errno == ERANGE)
        return default_value;

    return (int)v;
}

double luo_config_get_double(const char *key, double default_value)
{
    const char *val = luo_config_get(key, NULL);
    if (!val)
        return default_value;

    char *endptr = NULL;
    double v     = strtod(val, &endptr);
    if (endptr == val || errno == ERANGE)
        return default_value;

    return v;
}

bool luo_config_get_bool(const char *key, bool default_value)
{
    const char *val = luo_config_get(key, NULL);
    if (!val)
        return default_value;

    if (strcasecmp(val, "true") == 0 || strcmp(val, "1") == 0 || strcasecmp(val, "yes") == 0)
        return true;
    if (strcasecmp(val, "false") == 0 || strcmp(val, "0") == 0 || strcasecmp(val, "no") == 0)
        return false;

    return default_value;
}

/* ------------------------------------------------------------------------ */
/* Internal utilities                                                       */
/* ------------------------------------------------------------------------ */

/*
 * load_json_file()
 *  Opens and parses a JSON file, then flattens its content into the hash map.
 */
static int load_json_file(const char *file_path)
{
    FILE *fp = fopen(file_path, "rb");
    if (!fp)
    {
        luo_log_warn("Configuration file '%s' not found: %s", file_path, strerror(errno));
        return LUO_CFG_ERR_NOTFOUND;
    }

    fseek(fp, 0L, SEEK_END);
    long fsz = ftell(fp);
    rewind(fp);

    if (fsz <= 0 || fsz > (10 * 1024 * 1024))  /* 10 MB sanity check */
    {
        fclose(fp);
        return LUO_CFG_ERR_INVALID;
    }

    char *buffer = (char *)malloc((size_t)fsz + 1);
    if (!buffer)
    {
        fclose(fp);
        return LUO_CFG_ERR_OOM;
    }

    size_t rd = fread(buffer, 1, (size_t)fsz, fp);
    fclose(fp);
    buffer[rd] = '\0';

    cJSON *json = cJSON_Parse(buffer);
    free(buffer);

    if (!json)
    {
        luo_log_error("JSON parse error before: %s", cJSON_GetErrorPtr());
        return LUO_CFG_ERR_INVALID;
    }

    flatten_json(json, NULL);
    cJSON_Delete(json);

    return LUO_CFG_SUCCESS;
}

/*
 * flatten_json()
 *  Recursive function that converts a JSON object into dot-notation keys.
 *  Example: { "a": { "b": 1 } } -> key "a.b" => "1"
 */
static void flatten_json(cJSON *item, const char *prefix)
{
    if (!item)
        return;

    if (cJSON_IsObject(item))
    {
        cJSON *child = item->child;
        while (child)
        {
            char path[256] = {0};
            if (prefix)
                snprintf(path, sizeof(path), "%s.%s", prefix, child->string);
            else
                snprintf(path, sizeof(path), "%s", child->string);

            flatten_json(child, path);
            child = child->next;
        }
    }
    else if (cJSON_IsArray(item))
    {
        /* Arrays are converted to comma-separated lists */
        cJSON *child = item->child;
        size_t  needed   = 0;
        size_t  capacity = 128;
        char   *list     = (char *)malloc(capacity);
        if (!list)
            return;
        list[0] = '\0';

        while (child)
        {
            const char *val = NULL;

            if (cJSON_IsString(child))
                val = child->valuestring;
            else
            {
                /* Recurse for nested arrays/objects (rare) */
                char tmpkey[256] = {0};
                snprintf(tmpkey, sizeof(tmpkey), "%s.tmp", prefix ? prefix : "");
                flatten_json(child, tmpkey);
                val = luo_config_get(tmpkey, "");
            }

            size_t len = val ? strlen(val) : 0;
            /* Ensure space for val + comma + null */
            if (needed + len + 2 > capacity)
            {
                capacity = (capacity + len + 2) * 2;
                list = (char *)realloc(list, capacity);
            }

            if (needed)
            {
                strcat(list, ",");
                needed += 1;
            }
            if (val)
            {
                strcat(list, val);
                needed += len;
            }

            child = child->next;
        }

        insert_or_update(prefix, list);
        free(list);
    }
    else if (cJSON_IsString(item))
    {
        insert_or_update(prefix, item->valuestring);
    }
    else if (cJSON_IsNumber(item))
    {
        char numbuf[64];
        if (item->valuedouble == (double)item->valueint)
            snprintf(numbuf, sizeof(numbuf), "%d", item->valueint);
        else
            snprintf(numbuf, sizeof(numbuf), "%f", item->valuedouble);

        insert_or_update(prefix, numbuf);
    }
    else if (cJSON_IsBool(item))
    {
        insert_or_update(prefix, cJSON_IsTrue(item) ? "true" : "false");
    }
    /* nulls are ignored */
}

/*
 * load_env_overrides()
 *  Walk through the environment, pick keys with "LUO_" prefix and inject
 *  them into the hash map (uppercase converted to lowercase, '_' -> '.').
 */
static void load_env_overrides(void)
{
    extern char **environ;
    char **envp = environ;

    while (*envp)
    {
        const char *entry = *envp;
        if (strncmp(entry, ENV_PREFIX, strlen(ENV_PREFIX)) == 0)
        {
            const char *eq = strchr(entry, '=');
            if (!eq)
            {
                ++envp;
                continue;
            }

            size_t keylen = (size_t)(eq - entry) - strlen(ENV_PREFIX);
            const char *value = eq + 1;

            char *key = (char *)malloc(keylen + 1);
            if (!key)
            {
                ++envp;
                continue;
            }

            /* Convert LUO_FOO_BAR -> foo.bar */
            for (size_t i = 0; i < keylen; ++i)
            {
                char c = entry[strlen(ENV_PREFIX) + i];
                if (c == '_')
                    key[i] = '.';
                else
                    key[i] = (char)tolower((unsigned char)c);
            }
            key[keylen] = '\0';

            insert_or_update(key, value);
            free(key);
        }
        ++envp;
    }
}

/*
 * insert_or_update()
 *  Adds a key/value to the hash table, replacing an existing entry if present.
 */
static void insert_or_update(const char *key, const char *value)
{
    if (!key || !value)
        return;

    luo_kv_t *entry = NULL;
    HASH_FIND_STR(g_cfg_table, key, entry);

    if (entry)
    {
        free(entry->value);
        entry->value = strdup_safe(value);
    }
    else
    {
        entry = (luo_kv_t *)calloc(1, sizeof(luo_kv_t));
        if (!entry)
            return;

        entry->key   = strdup_safe(key);
        entry->value = strdup_safe(value);
        HASH_ADD_KEYPTR(hh, g_cfg_table, entry->key, strlen(entry->key), entry);
    }
}

static char *strdup_safe(const char *src)
{
#ifdef _POSIX_C_SOURCE
    return strdup(src);
#else
    size_t len = strlen(src);
    char *dst  = (char *)malloc(len + 1);
    if (dst)
        memcpy(dst, src, len + 1);
    return dst;
#endif
}

/* ------------------------------------------------------------------------ */
/* Unit Test (compile-time optional)                                        */
/* ------------------------------------------------------------------------ */
#ifdef LUO_CONFIG_TEST

#include <assert.h>

static void run_tests(void)
{
    /* Synthetic JSON */
    const char *json_str = "{ \"alerting\": { \"threshold\": 5, \"enabled\": true }, \"hosts\": [\"a\",\"b\",\"c\"] }";
    const char *tmpfile  = "/tmp/luo_ut_config.json";
    FILE *fp = fopen(tmpfile, "w");
    assert(fp);
    fputs(json_str, fp);
    fclose(fp);

    assert(luo_config_init(tmpfile) == LUO_CFG_SUCCESS);

    assert(luo_config_get_int("alerting.threshold", -1) == 5);
    assert(luo_config_get_bool("alerting.enabled", false) == true);

    const char *list = luo_config_get("hosts", NULL);
    assert(strcmp(list, "a,b,c") == 0);

    luo_config_cleanup();
    remove(tmpfile);
}

int main(void)
{
    run_tests();
    printf("luo_config tests: SUCCESS\n");
    return 0;
}

#endif /* LUO_CONFIG_TEST */
