#ifndef LUO_CONFIG_H
#define LUO_CONFIG_H
/*
 * LambdaUtility Orchestrator – Common Configuration Header
 *
 * This header exposes a small, dependency-free runtime configuration
 * system that pulls its values from process environment variables.
 *
 * It is intentionally header-only so that any Lambda “function” may
 * adopt it without linking against an additional compilation unit.
 *
 * Public Functions
 *  ├─ luo_config_load()       – allocate and populate configuration
 *  ├─ luo_config_validate()   – basic consistency checks
 *  ├─ luo_config_free()       – release resources
 *  └─ luo_log_level_to_str()  – helper for human-readable log level
 *
 * Copyright (c) 2024,
 * LambdaUtility Orchestrator Project – All rights reserved.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <inttypes.h>

#ifdef __cplusplus
extern "C" {
#endif

/*---------------------------------------------------------------------------*/
/* Versioning                                                                */
/*---------------------------------------------------------------------------*/
#define LUO_CONFIG_VERSION      "1.0.0"
#define LUO_CONFIG_SCHEMA_REV   1

/*---------------------------------------------------------------------------*/
/* Build-time feature flags – may be overridden via compiler -D              */
/*---------------------------------------------------------------------------*/
#ifndef LUO_FEATURE_ALERTING
#   define LUO_FEATURE_ALERTING               1
#endif
#ifndef LUO_FEATURE_CONFIGURATION_MANAGEMENT
#   define LUO_FEATURE_CONFIGURATION_MANAGEMENT  1
#endif
#ifndef LUO_FEATURE_BACKUP_RECOVERY
#   define LUO_FEATURE_BACKUP_RECOVERY        1
#endif
#ifndef LUO_FEATURE_DEPLOYMENT_AUTOMATION
#   define LUO_FEATURE_DEPLOYMENT_AUTOMATION  1
#endif
#ifndef LUO_FEATURE_PERFORMANCE_METRICS
#   define LUO_FEATURE_PERFORMANCE_METRICS    1
#endif

/*---------------------------------------------------------------------------*/
/* Defaults                                                                  */
/*---------------------------------------------------------------------------*/
#define LUO_DEFAULT_AWS_REGION            "us-east-1"
#define LUO_DEFAULT_TIMEOUT_MS            (30 * 1000)      /* 30 seconds   */
#define LUO_DEFAULT_LOG_LEVEL             LUO_LOG_INFO
#define LUO_DEFAULT_METRIC_INTERVAL_SEC   60               /* 1 minute     */

/*---------------------------------------------------------------------------*/
/* Logging                                                                   */
/*---------------------------------------------------------------------------*/
typedef enum {
    LUO_LOG_TRACE = 0,
    LUO_LOG_DEBUG,
    LUO_LOG_INFO,
    LUO_LOG_WARN,
    LUO_LOG_ERROR,
    LUO_LOG_FATAL,
    LUO_LOG_SILENT                       /* nothing gets printed            */
} luo_log_level_e;

static inline const char *luo_log_level_to_str(luo_log_level_e lvl)
{
    switch (lvl) {
        case LUO_LOG_TRACE:  return "TRACE";
        case LUO_LOG_DEBUG:  return "DEBUG";
        case LUO_LOG_INFO:   return "INFO";
        case LUO_LOG_WARN:   return "WARN";
        case LUO_LOG_ERROR:  return "ERROR";
        case LUO_LOG_FATAL:  return "FATAL";
        case LUO_LOG_SILENT: return "SILENT";
        default:             return "UNKNOWN";
    }
}

/*---------------------------------------------------------------------------*/
/* In-memory configuration structure                                         */
/*---------------------------------------------------------------------------*/
typedef struct luo_config_s {
    /* meta information */
    const char       *version;           /* code/config version string         */
    uint32_t          schema_rev;        /* schema revision for migrations     */

    /* general runtime */
    luo_log_level_e   log_level;         /* min severity to emit               */
    uint32_t          timeout_ms;        /* enforced lambda timeout            */

    /* metric subsystem */
    bool              enable_metrics;    /* toggle        */
    uint32_t          metric_interval;   /* seconds       */

    /* infrastructure & integration endpoints */
    char             *aws_region;        /* AWS_REGION                        */
    char             *slack_webhook;     /* LUO_SLACK_WEBHOOK                 */
    char             *smtp_relay;        /* LUO_SMTP_RELAY                    */

    /*  future-proof padding or extensions                                   */
} luo_config_t;

/*---------------------------------------------------------------------------*/
/* Helper – safe strdup (ANSI-C compilers do not guarantee strdup)           */
/*---------------------------------------------------------------------------*/
static inline char *luo_strdup(const char *src)
{
    if (!src) return NULL;
    size_t len = strlen(src) + 1;
    char *dst  = (char *)malloc(len);
    if (dst) memcpy(dst, src, len);
    return dst;
}

/*---------------------------------------------------------------------------*/
/* Internal parsers                                                          */
/*---------------------------------------------------------------------------*/
static inline long luo__parse_long(const char *env,
                                   long  defval,
                                   long  lo,
                                   long  hi)
{
    const char *raw = getenv(env);
    if (!raw || !*raw) return defval;

    errno = 0;
    char *endp  = NULL;
    long  value = strtol(raw, &endp, 10);

    if (errno || endp == raw || value < lo || value > hi)
        return defval;

    return value;
}

static inline bool luo__parse_bool(const char *env, bool defval)
{
    const char *raw = getenv(env);
    if (!raw || !*raw) return defval;

    if (!strcasecmp(raw, "1")   || !strcasecmp(raw, "true")  ||
        !strcasecmp(raw, "yes") || !strcasecmp(raw, "on"))
        return true;

    if (!strcasecmp(raw, "0")   || !strcasecmp(raw, "false") ||
        !strcasecmp(raw, "no")  || !strcasecmp(raw, "off"))
        return false;

    return defval;
}

static inline long luo__parse_duration_ms(const char *str, long def_ms)
{
    if (!str || !*str) return def_ms;

    char *endp;
    errno = 0;
    long  base = strtol(str, &endp, 10);
    if (errno || endp == str) return def_ms;

    long mult = 1; /* default milliseconds */
    switch (*endp) {
        case 'd': case 'D': mult = 24L * 60L * 60L * 1000L; break;
        case 'h': case 'H': mult =      60L * 60L * 1000L; break;
        case 'm': case 'M': mult =           60L * 1000L; break;
        case 's': case 'S': mult =                1000L; break;
        case '\0':          mult =                   1L; break;
        default:            return def_ms; /* unknown suffix             */
    }

    if (base > (LONG_MAX / mult))
        return def_ms;               /* overflow guard                 */

    return base * mult;
}

/*---------------------------------------------------------------------------*/
/* Public API                                                                */
/*---------------------------------------------------------------------------*/
static inline luo_config_t *luo_config_load(void)
{
    luo_config_t *cfg = (luo_config_t *)calloc(1, sizeof *cfg);
    if (!cfg) return NULL;

    cfg->version     = LUO_CONFIG_VERSION;
    cfg->schema_rev  = LUO_CONFIG_SCHEMA_REV;

    cfg->log_level   = (luo_log_level_e)
                       luo__parse_long("LUO_LOG_LEVEL",
                                       LUO_DEFAULT_LOG_LEVEL,
                                       LUO_LOG_TRACE, LUO_LOG_SILENT);

    cfg->timeout_ms  = (uint32_t)luo__parse_duration_ms(getenv("LUO_TIMEOUT"),
                                                        LUO_DEFAULT_TIMEOUT_MS);

    cfg->enable_metrics = luo__parse_bool("LUO_ENABLE_METRICS", true);
    cfg->metric_interval = (uint32_t)luo__parse_long("LUO_METRIC_INTERVAL_SEC",
                                                     LUO_DEFAULT_METRIC_INTERVAL_SEC,
                                                     5, 3600);

    const char *reg = getenv("AWS_REGION");
    cfg->aws_region     = luo_strdup(reg && *reg ? reg : LUO_DEFAULT_AWS_REGION);

    const char *slack = getenv("LUO_SLACK_WEBHOOK");
    cfg->slack_webhook = slack ? luo_strdup(slack) : NULL;

    const char *smtp  = getenv("LUO_SMTP_RELAY");
    cfg->smtp_relay   = smtp ? luo_strdup(smtp) : NULL;

    return cfg;
}

static inline int luo_config_validate(const luo_config_t *cfg)
{
    if (!cfg) {
        fprintf(stderr, "[luo_config] config ptr is NULL\n");
        return -1;
    }

    if (!cfg->aws_region) {
        fprintf(stderr, "[luo_config] AWS region missing\n");
        return -1;
    }

    if (cfg->enable_metrics && cfg->metric_interval == 0) {
        fprintf(stderr, "[luo_config] metric interval must be > 0\n");
        return -1;
    }

    return 0;
}

static inline void luo_config_free(luo_config_t *cfg)
{
    if (!cfg) return;

    free(cfg->aws_region);
    free(cfg->slack_webhook);
    free(cfg->smtp_relay);
    free(cfg);
}

/*---------------------------------------------------------------------------*/
/* Compile-time sanity check                                                 */
/*---------------------------------------------------------------------------*/
_Static_assert(sizeof(luo_config_t) < 512,
               "luo_config_t grew unexpectedly – keep it lightweight");

/*---------------------------------------------------------------------------*/
/* Example (commented out)
 *
 *  int main(void)
 *  {
 *      luo_config_t *cfg = luo_config_load();
 *      if (!cfg || luo_config_validate(cfg)) {
 *          fprintf(stderr, "Failed to bootstrap configuration\n");
 *          exit(EXIT_FAILURE);
 *      }
 *
 *      printf("Service running in region %s, level=%s\n",
 *             cfg->aws_region, luo_log_level_to_str(cfg->log_level));
 *
 *      luo_config_free(cfg);
 *      return 0;
 *  }
 */
/*---------------------------------------------------------------------------*/

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* LUO_CONFIG_H */