/*
 * ============================================================================
 *  PulseSphere: Real-Time Social Pulse Streaming Platform
 *  --------------------------------------------------------------------------
 *  File:    pulsesphere_defaults.h
 *  Brief:   Centralised, compile-time defaults for critical PulseSphere
 *           subsystems.  All tunables are overridable via environment
 *           variables or CLI flags, but MUST have a safe, production-grade
 *           fallback value defined here.
 *
 *  Copyright (c) 2024, PulseSphere Contributors
 *  SPDX-License-Identifier: MIT
 * ============================================================================
 */

#ifndef PULSESPHERE_CONFIG_DEFAULTS_H
#define PULSESPHERE_CONFIG_DEFAULTS_H
#pragma once

/* ---------------------------------------------------------------------------
 *  Standard Library
 * -------------------------------------------------------------------------*/
#include <inttypes.h>  /* uint*_t printf helpers                    */
#include <limits.h>    /* PATH_MAX, UINT_MAX                        */
#include <stdbool.h>   /* bool type                                 */
#include <stdint.h>    /* uint*_t types                             */
#include <stdlib.h>    /* getenv, strtoul, strtoull                 */
#include <string.h>    /* strlen                                    */
#include <errno.h>     /* errno, ERANGE                             */

/* ---------------------------------------------------------------------------
 *  C++ Compatibility
 * -------------------------------------------------------------------------*/
#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------------------
 *  Macro Helpers
 * -------------------------------------------------------------------------*/
#define PULSPHERE_KB(x)   ((x) * 1024UL)
#define PULSPHERE_MB(x)   ((x) * 1024UL * 1024UL)

#define PULSPHERE_STR_HELPER(x) #x
#define PULSPHERE_STR(x)        PULSPHERE_STR_HELPER(x)

/* ---------------------------------------------------------------------------
 *  Compile-time Metadata
 * -------------------------------------------------------------------------*/
#define PULSPHERE_VERSION_MAJOR   1
#define PULSPHERE_VERSION_MINOR   0
#define PULSPHERE_VERSION_PATCH   0

#define PULSPHERE_VERSION_STRING \
        PULSPHERE_STR(PULSPHERE_VERSION_MAJOR) "." \
        PULSPHERE_STR(PULSPHERE_VERSION_MINOR) "." \
        PULSPHERE_STR(PULSPHERE_VERSION_PATCH)

/* ---------------------------------------------------------------------------
 *  Enumerations
 * -------------------------------------------------------------------------*/
typedef enum {
    PULSPHERE_LOG_FATAL = 0,
    PULSPHERE_LOG_ERROR,
    PULSPHERE_LOG_WARN,
    PULSPHERE_LOG_INFO,
    PULSPHERE_LOG_DEBUG,
    PULSPHERE_LOG_TRACE,
    PULSPHERE_LOG_LEVEL_MAX
} pulsesphere_log_level_t;

/* ---------------------------------------------------------------------------
 *  Default Configuration Values
 * -------------------------------------------------------------------------*/
#define PULSPHERE_DEFAULT_INGEST_HOST            "0.0.0.0"
#define PULSPHERE_DEFAULT_INGEST_PORT            5800U        /* TCP */
#define PULSPHERE_DEFAULT_MAX_BATCH_SIZE         5000U        /* events */
#define PULSPHERE_DEFAULT_RING_BUFFER_SIZE       PULSPHERE_MB(8) /* bytes */

#define PULSPHERE_DEFAULT_WINDOW_INTERVAL_MS     5000U        /* 5  sec */
#define PULSPHERE_DEFAULT_HEARTBEAT_INTERVAL_MS  2500U        /* 2.5 sec */
#define PULSPHERE_DEFAULT_METRICS_FLUSH_MS       10000U       /* 10 sec */

#define PULSPHERE_DEFAULT_MAX_RECONNECT_ATTEMPTS 8U
#define PULSPHERE_DEFAULT_BACKOFF_BASE_MS        125U         /* exponential */

#define PULSPHERE_DEFAULT_PLUGIN_DIR             "/opt/pulsesphere/plugins"
#define PULSPHERE_DEFAULT_TLS_ENABLED            true
#define PULSPHERE_DEFAULT_TLS_CERT_PATH          "/etc/pulsesphere/cert.pem"
#define PULSPHERE_DEFAULT_TLS_KEY_PATH           "/etc/pulsesphere/key.pem"

#define PULSPHERE_DEFAULT_LOG_LEVEL              PULSPHERE_LOG_INFO

/* ---------------------------------------------------------------------------
 *  Environment variable names (override hooks)
 * -------------------------------------------------------------------------*/
#define ENV_INGEST_HOST             "PS_INGEST_HOST"
#define ENV_INGEST_PORT             "PS_INGEST_PORT"
#define ENV_MAX_BATCH_SIZE          "PS_MAX_BATCH_SIZE"
#define ENV_RING_BUFFER_SIZE        "PS_RING_BUFFER_SIZE"
#define ENV_WINDOW_INTERVAL_MS      "PS_WINDOW_INTERVAL_MS"
#define ENV_HEARTBEAT_INTERVAL_MS   "PS_HEARTBEAT_INTERVAL_MS"
#define ENV_METRICS_FLUSH_MS        "PS_METRICS_FLUSH_MS"
#define ENV_MAX_RECONNECT_ATTEMPTS  "PS_MAX_RECONNECT_ATTEMPTS"
#define ENV_BACKOFF_BASE_MS         "PS_BACKOFF_BASE_MS"
#define ENV_PLUGIN_DIR              "PS_PLUGIN_DIR"
#define ENV_TLS_ENABLED             "PS_TLS_ENABLED"
#define ENV_TLS_CERT_PATH           "PS_TLS_CERT_PATH"
#define ENV_TLS_KEY_PATH            "PS_TLS_KEY_PATH"
#define ENV_LOG_LEVEL               "PS_LOG_LEVEL"

/* ---------------------------------------------------------------------------
 *  Parsing Helpers
 * -------------------------------------------------------------------------*/

/*
 *  parse_env_ulong:
 *  ---------------------------------------------------------
 *  Reads an environment variable and attempts to convert it
 *  to an unsigned long.  On failure (unset, invalid, overflow),
 *  returns default_val.
 */
static inline unsigned long
parse_env_ulong(const char *env_key, unsigned long default_val, unsigned long min, unsigned long max)
{
    const char *envval = getenv(env_key);
    if (!envval || *envval == '\0')
        return default_val;

    errno = 0;
    char *endptr = NULL;
    unsigned long tmp = strtoul(envval, &endptr, 10);

    if (errno == ERANGE || endptr == envval || *endptr != '\0')
        return default_val;

    if (tmp < min || tmp > max)
        return default_val;

    return tmp;
}

/*
 *  parse_env_bool:
 *  ---------------------------------------------------------
 *  Accepts 1/0, true/false, yes/no (case-insensitive).
 */
static inline bool
parse_env_bool(const char *env_key, bool default_val)
{
    const char *envval = getenv(env_key);
    if (!envval)
        return default_val;

    if (strcasecmp(envval, "1") == 0 ||
        strcasecmp(envval, "true") == 0 ||
        strcasecmp(envval, "yes") == 0)
        return true;

    if (strcasecmp(envval, "0") == 0 ||
        strcasecmp(envval, "false") == 0 ||
        strcasecmp(envval, "no") == 0)
        return false;

    return default_val;
}

/*
 *  parse_env_string:
 *  ---------------------------------------------------------
 *  Returns pointer to environment string if non-empty, else
 *  returns default_val.
 */
static inline const char *
parse_env_string(const char *env_key, const char *default_val)
{
    const char *envval = getenv(env_key);
    if (!envval || *envval == '\0')
        return default_val;
    return envval;
}

/*
 *  parse_env_log_level:
 *  ---------------------------------------------------------
 *  Converts string/numeric log level to pulsesphere_log_level_t.
 */
static inline pulsesphere_log_level_t
parse_env_log_level(const char *env_key, pulsesphere_log_level_t default_val)
{
    const char *envval = getenv(env_key);
    if (!envval)
        return default_val;

    if (strlen(envval) == 1 && *envval >= '0' && *envval <= '9') {
        unsigned long lvl = parse_env_ulong(env_key, (unsigned long)default_val,
                                            0UL, (unsigned long)PULSPHERE_LOG_LEVEL_MAX - 1UL);
        return (pulsesphere_log_level_t)lvl;
    }

    /* string values */
    if (strcasecmp(envval, "fatal") == 0)   return PULSPHERE_LOG_FATAL;
    if (strcasecmp(envval, "error") == 0)   return PULSPHERE_LOG_ERROR;
    if (strcasecmp(envval, "warn")  == 0)   return PULSPHERE_LOG_WARN;
    if (strcasecmp(envval, "info")  == 0)   return PULSPHERE_LOG_INFO;
    if (strcasecmp(envval, "debug") == 0)   return PULSPHERE_LOG_DEBUG;
    if (strcasecmp(envval, "trace") == 0)   return PULSPHERE_LOG_TRACE;

    return default_val;
}

/* ---------------------------------------------------------------------------
 *  Runtime-resolved Defaults
 *  --------------------------------------------------------------------------
 *  These inline helper functions combine compile-time fallbacks with runtime
 *  overrides via environment variables.
 * -------------------------------------------------------------------------*/
static inline const char *ps_default_ingest_host(void)
{
    return parse_env_string(ENV_INGEST_HOST, PULSPHERE_DEFAULT_INGEST_HOST);
}

static inline uint16_t ps_default_ingest_port(void)
{
    unsigned long port = parse_env_ulong(
        ENV_INGEST_PORT,
        PULSPHERE_DEFAULT_INGEST_PORT,
        1UL, 65535UL);
    return (uint16_t)port;
}

static inline uint32_t ps_default_max_batch_size(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_MAX_BATCH_SIZE,
        PULSPHERE_DEFAULT_MAX_BATCH_SIZE,
        1UL, 100000UL);
}

static inline size_t ps_default_ring_buffer_size(void)
{
    return (size_t)parse_env_ulong(
        ENV_RING_BUFFER_SIZE,
        PULSPHERE_DEFAULT_RING_BUFFER_SIZE,
        PULSPHERE_KB(64), PULSPHERE_MB(512));
}

static inline uint32_t ps_default_window_interval_ms(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_WINDOW_INTERVAL_MS,
        PULSPHERE_DEFAULT_WINDOW_INTERVAL_MS,
        100UL, 60000UL);
}

static inline uint32_t ps_default_heartbeat_interval_ms(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_HEARTBEAT_INTERVAL_MS,
        PULSPHERE_DEFAULT_HEARTBEAT_INTERVAL_MS,
        100UL, 60000UL);
}

static inline uint32_t ps_default_metrics_flush_ms(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_METRICS_FLUSH_MS,
        PULSPHERE_DEFAULT_METRICS_FLUSH_MS,
        500UL, 600000UL);
}

static inline uint32_t ps_default_max_reconnect_attempts(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_MAX_RECONNECT_ATTEMPTS,
        PULSPHERE_DEFAULT_MAX_RECONNECT_ATTEMPTS,
        0UL, 64UL);
}

static inline uint32_t ps_default_backoff_base_ms(void)
{
    return (uint32_t)parse_env_ulong(
        ENV_BACKOFF_BASE_MS,
        PULSPHERE_DEFAULT_BACKOFF_BASE_MS,
        1UL, 10000UL);
}

static inline const char *ps_default_plugin_dir(void)
{
    return parse_env_string(ENV_PLUGIN_DIR, PULSPHERE_DEFAULT_PLUGIN_DIR);
}

static inline bool ps_default_tls_enabled(void)
{
    return parse_env_bool(ENV_TLS_ENABLED, PULSPHERE_DEFAULT_TLS_ENABLED);
}

static inline const char *ps_default_tls_cert_path(void)
{
    return parse_env_string(ENV_TLS_CERT_PATH, PULSPHERE_DEFAULT_TLS_CERT_PATH);
}

static inline const char *ps_default_tls_key_path(void)
{
    return parse_env_string(ENV_TLS_KEY_PATH, PULSPHERE_DEFAULT_TLS_KEY_PATH);
}

static inline pulsesphere_log_level_t ps_default_log_level(void)
{
    return parse_env_log_level(ENV_LOG_LEVEL, PULSPHERE_DEFAULT_LOG_LEVEL);
}

/* ---------------------------------------------------------------------------
 *  Compile-time Sanity Checks
 * -------------------------------------------------------------------------*/
_Static_assert(PULSPHERE_DEFAULT_INGEST_PORT <= 65535,
               "Default ingest port must be a valid TCP port");

/* ---------------------------------------------------------------------------
 *  End of Header
 * -------------------------------------------------------------------------*/
#ifdef __cplusplus
}
#endif

#endif /* PULSESPHERE_CONFIG_DEFAULTS_H */
