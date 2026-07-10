```c
/**
 * geo_tag_strategy.c
 *
 * PulseSphere – Geo-Tagging Enrichment Plug-In
 *
 * This file implements a Strategy plug-in that enriches Pulse events with
 * geographical meta-data using the MaxMind GeoIP2 City database.  The code
 * follows the PulseSphere enrichment plug-in ABI:
 *
 *      1. geo_tag_strategy_register() returns the plug-in descriptor
 *      2. init()    – called once per process during plug-in bootstrap
 *      3. process() – called for every event routed to this strategy
 *      4. shutdown()– called once during plug-in teardown
 *
 * Thread-safety:
 *      – All public strategy functions MUST be thread safe.  MaxMind’s API
 *        is inherently thread-safe as long as the MMDB_s handle is never
 *        mutated after successful open().  We therefore open the DB once
 *        during init() and expose it read-only thereafter.  Runtime metrics
 *        are maintained using C11 atomics.
 *
 * Build:
 *      gcc -std=c11 -Wall -Werror -O2 \
 *          -I/usr/include -fPIC -shared geo_tag_strategy.c -lmaxminddb \
 *          -o libpulse_geotag.so
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdatomic.h>
#include <pthread.h>

#include <maxminddb.h>              /* libmaxminddb ‑ GeoIP2 reader */

#include "pulse_log.h"              /* PulseSphere – logging façade      */
#include "pulse_event.h"            /* PulseSphere – event definition     */
#include "enrichment_strategy.h"    /* PulseSphere – strategy plug-in ABI */

/* ------------------------------------------------------------------------- */
/* Plug-in-wide State                                                        */
/* ------------------------------------------------------------------------- */

#define STRATEGY_NAME        "geo_tag"
#define DEFAULT_DB_PATH      "/usr/share/GeoIP/GeoLite2-City.mmdb"

static MMDB_s              g_mmdb               = {0};   /* read-only handle */
static atomic_uint_fast64_t g_events_processed   = 0;
static atomic_uint_fast64_t g_events_enriched    = 0;
static atomic_uint_fast64_t g_events_failed      = 0;
static pthread_once_t       g_metrics_once       = PTHREAD_ONCE_INIT;

/* ------------------------------------------------------------------------- */
/* Forward declarations                                                      */
/* ------------------------------------------------------------------------- */

static int  geo_tag_init    (const strategy_config_t *cfg);
static int  geo_tag_process (pulse_event_t *event);
static void geo_tag_shutdown(void);

/* ------------------------------------------------------------------------- */
/* Utility helpers                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Initialise the runtime usage counters.  This is deferred until after the
 * first successful geo_tag_init() call, because libc constructors run prior
 * to the PulseSphere logging facilities being available.
 */
static void
init_metrics(void)
{
    atomic_store(&g_events_processed, 0);
    atomic_store(&g_events_enriched,  0);
    atomic_store(&g_events_failed,    0);
}

/**
 * Fetch a string field safely from a MaxMindDB lookup result.
 *
 * @param node   The MMDB_entry_data_list_s node whose value to extract.
 * @param dst    Destination buffer.
 * @param dst_sz Size of the destination buffer.
 *
 * @retval 0  Success
 * @retval -1 Failure – node was NULL or not a UTF-8 string.
 */
static int
mmdb_copy_string(const MMDB_entry_data_list_s *node,
                 char                         *dst,
                 size_t                        dst_sz)
{
    if (!node || !node->entry_data.is_present ||
        node->entry_data.type != MMDB_DATA_TYPE_UTF8_STRING || !dst) {
        return -1;
    }

    size_t len = node->entry_data.data_size;
    if (len >= dst_sz)           /* ensure NULL-termination */
        len = dst_sz - 1;

    memcpy(dst, node->entry_data.utf8_string, len);
    dst[len] = '\0';
    return 0;
}

/**
 * Convenience wrapper around MMDB_get_value() that navigates a given path and
 * returns a pointer to the final node.
 */
static const MMDB_entry_data_list_s *
mmdb_lookup_path(const MMDB_entry_s *entry, const char *const *path)
{
    MMDB_entry_data_list_s *list = NULL;
    int status = MMDB_get_entry_data_list(entry, &list);
    if (status != MMDB_SUCCESS || !list)
        return NULL;

    const MMDB_entry_data_list_s *cur = list;
    const char *const *p              = path;

    while (*p && cur) {
        /* Iterate until we find the matching key */
        if (cur->entry_data.type == MMDB_DATA_TYPE_MAP &&
            cur->entry_data.data_size > 0) {

            /* Next node is the map size; skip it */
            size_t map_size = cur->entry_data.data_size;
            cur = cur->next; /* first (key,value) pair in the map */

            for (size_t i = 0; i < map_size && cur; ++i) {
                /* cur is key */
                if (cur->entry_data.type == MMDB_DATA_TYPE_UTF8_STRING &&
                    strncmp((const char *)cur->entry_data.utf8_string,
                            *p,
                            cur->entry_data.data_size) == 0) {

                    /* Skip to value */
                    cur = cur->next;
                    break;
                }

                /* Not the key we want – skip value then continue */
                cur = cur->next;             /* skip value */
                if (cur)
                    cur = cur->next;         /* move to next key */
            }
        } else {
            /* Unexpected structure */
            cur = NULL;
        }

        ++p;   /* advance path element */
    }

    return cur;    /* may be NULL   */
}

/* ------------------------------------------------------------------------- */
/* Strategy Entry Points                                                     */
/* ------------------------------------------------------------------------- */

/**
 * geo_tag_init()
 *
 * Strategy initialisation entry point.  Opens the GeoIP2 database and performs
 * a self-test lookup to ensure the DB is not corrupt.
 *
 * @param cfg  JSON configuration blob (caller-owned, may be NULL)
 *
 * @retval 0  Success
 * @retval -1 Failure – error logged via pulse_log_error()
 */
static int
geo_tag_init(const strategy_config_t *cfg)
{
    (void)cfg;  /* Currently unused – future: allow overriding DB path, etc */

    pthread_once(&g_metrics_once, init_metrics);

    const char *db_path = getenv("GEOTAG_DB_PATH");
    if (!db_path || db_path[0] == '\0')
        db_path = DEFAULT_DB_PATH;

    int status = MMDB_open(db_path, MMDB_MODE_MMAP, &g_mmdb);
    if (status != MMDB_SUCCESS) {
        pulse_log_error("[geo_tag] Failed to open GeoIP DB '%s': %s",
                        db_path,
                        MMDB_strerror(status));
        return -1;
    }

    /* Sanity self-test – look up localhost (should not be found) */
    int gai_error, mmdb_error;
    MMDB_lookup_result_s result =
        MMDB_lookup_string(&g_mmdb, "127.0.0.1", &gai_error, &mmdb_error);

    if (gai_error != 0 || mmdb_error != MMDB_SUCCESS) {
        pulse_log_error("[geo_tag] GeoIP DB self-test failed: gai=%d mmdb=%s",
                        gai_error,
                        MMDB_strerror(mmdb_error));
        MMDB_close(&g_mmdb);
        return -1;
    }

    pulse_log_info("[geo_tag] Geo-Tag strategy initialised using DB '%s'",
                   db_path);
    return 0;
}

/**
 * geo_tag_process()
 *
 * Event enrichment entry point.  Uses client-supplied IP address to derive
 * country-code, region, and city names.  Results are written back to the
 * mutable ‘geo’ section of the event.  On any failure the function returns
 * non-zero and the caller may decide whether to drop or pass-through the
 * event.
 *
 * @note The function MUST be fast – it is on the hot path.
 *
 * @param ev  Pointer to a mutable event instance (non-NULL)
 *
 * @retval 0  Success – event enriched
 * @retval 1  No enrichment performed (incomplete data)
 * @retval -1 Hard failure (DB not open, lookup errors)
 */
static int
geo_tag_process(pulse_event_t *ev)
{
    if (unlikely(!ev)) {
        pulse_log_error("[geo_tag] NULL event received");
        return -1;
    }

    atomic_fetch_add_explicit(&g_events_processed, 1, memory_order_relaxed);

    const char *ip_addr = pulse_event_get_ip(ev);   /* opaque accessor */
    if (!ip_addr || ip_addr[0] == '\0')
        goto not_enriched; /* Incomplete data */

    int gai_error  = 0;
    int mmdb_error = 0;

    MMDB_lookup_result_s result =
        MMDB_lookup_string(&g_mmdb, ip_addr, &gai_error, &mmdb_error);

    if (gai_error != 0) {
        pulse_log_warn("[geo_tag] getaddrinfo() failed for '%s': %s",
                       ip_addr,
                       gai_strerror(gai_error));
        goto not_enriched;
    }

    if (mmdb_error != MMDB_SUCCESS) {
        pulse_log_error("[geo_tag] MMDB lookup error for '%s': %s",
                        ip_addr,
                        MMDB_strerror(mmdb_error));
        atomic_fetch_add_explicit(&g_events_failed, 1, memory_order_relaxed);
        return -1;
    }

    if (!result.found_entry)
        goto not_enriched;

    /* ---------------------------------------------------------------------
     * Extract the fields we care about using MMDB_get_value() convenience
     * function.  For readability we manually navigate the tree.
     * ------------------------------------------------------------------ */

    MMDB_entry_s entry = result.entry;
    const char *const path_country_iso[] =
        {"country", "iso_code", NULL};
    const char *const path_subdivision[] =
        {"subdivisions", "0", "names", "en", NULL};
    const char *const path_city_name[] =
        {"city", "names", "en", NULL};

    const MMDB_entry_data_list_s *node;

    char country[3] = {0};
    char region[64] = {0};
    char city[128]  = {0};

    /* Country ISO */
    node = mmdb_lookup_path(&entry, path_country_iso);
    mmdb_copy_string(node, country, sizeof(country));

    /* Region name */
    node = mmdb_lookup_path(&entry, path_subdivision);
    mmdb_copy_string(node, region, sizeof(region));

    /* City name */
    node = mmdb_lookup_path(&entry, path_city_name);
    mmdb_copy_string(node, city, sizeof(city));

    /* Only enrich if at least country was found */
    if (country[0] == '\0')
        goto not_enriched;

    pulse_event_set_geo(ev, country, region, city);
    atomic_fetch_add_explicit(&g_events_enriched, 1, memory_order_relaxed);
    return 0;

not_enriched:
    /* Passthrough event – nothing to enrich */
    return 1;
}

/**
 * geo_tag_shutdown()
 *
 * Finalises the plug-in and reports aggregated metrics.
 */
static void
geo_tag_shutdown(void)
{
    uint64_t processed = atomic_load_explicit(&g_events_processed,
                                              memory_order_relaxed);
    uint64_t enriched  = atomic_load_explicit(&g_events_enriched,
                                              memory_order_relaxed);
    uint64_t failed    = atomic_load_explicit(&g_events_failed,
                                              memory_order_relaxed);

    MMDB_close(&g_mmdb);

    pulse_log_info("[geo_tag] Shutdown complete – processed=%" PRIu64
                   " enriched=%" PRIu64 " failed=%" PRIu64,
                   processed, enriched, failed);
}

/* ------------------------------------------------------------------------- */
/* Registration                                                               */
/* ------------------------------------------------------------------------- */

/* Strategy descriptor exported to the PulseSphere plug-in loader */
static enrichment_strategy_t strategy_desc = {
    .name      = STRATEGY_NAME,
    .init      = geo_tag_init,
    .process   = geo_tag_process,
    .shutdown  = geo_tag_shutdown
};

/**
 * geo_tag_strategy_register()
 *
 * Mandatory symbol looked up by the dynamic plug-in loader.  Returns a pointer
 * to the strategy descriptor defined above.
 */
enrichment_strategy_t *
geo_tag_strategy_register(void)
{
    return &strategy_desc;
}
```
