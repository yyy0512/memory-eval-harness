/*
 * PulseSphere: Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * ps_event.c – common event representation, reference counting,
 *              validation and (de)serialization helpers.
 *
 * This implementation purposefully avoids external runtime
 * allocations inside critical sections, keeps the data-model
 * immutable after creation and uses a thread-safe reference
 * counter so that events can be passed across pipeline stages
 * without expensive copies.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <inttypes.h>
#include <errno.h>
#include <ctype.h>
#include <stdatomic.h>

#include <jansson.h>          /* JSON (de)serialization */

#include "ps_event.h"         /* Public interface */

/* -------------------------------------------------------------------------
 * Forward declarations
 * ------------------------------------------------------------------------- */
static void   ps_event_generate_uuid(char out[PS_EVENT_ID_STR_LEN]);
static int    ps_event_validate_internal(const ps_event_t *ev, char **err);

/* -------------------------------------------------------------------------
 * String tables
 * ------------------------------------------------------------------------- */
static const char * const PS_EVENT_TYPE_STR[] = {
    [PS_EVENT_LIKE]    = "LIKE",
    [PS_EVENT_COMMENT] = "COMMENT",
    [PS_EVENT_SHARE]   = "SHARE",
    [PS_EVENT_FOLLOW]  = "FOLLOW",
    [PS_EVENT_REACTION]= "REACTION",
    [PS_EVENT_UNKNOWN] = "UNKNOWN"
};

const char *ps_event_type_to_str(ps_event_type_t type)
{
    if (type < 0 || type >= PS_EVENT_UNKNOWN) {
        return PS_EVENT_TYPE_STR[PS_EVENT_UNKNOWN];
    }
    return PS_EVENT_TYPE_STR[type];
}

ps_event_type_t ps_event_type_from_str(const char *s)
{
    if (!s) return PS_EVENT_UNKNOWN;
    for (size_t i = 0; i < PS_EVENT_UNKNOWN; ++i) {
        if (strcasecmp(s, PS_EVENT_TYPE_STR[i]) == 0) {
            return (ps_event_type_t)i;
        }
    }
    return PS_EVENT_UNKNOWN;
}

/* -------------------------------------------------------------------------
 * Creation & Lifetime
 * ------------------------------------------------------------------------- */
ps_event_t *ps_event_create(ps_event_type_t type,
                            const char     *origin,
                            const char     *payload_utf8)
{
    if (!origin || !payload_utf8) {
        errno = EINVAL;
        return NULL;
    }

    ps_event_t *ev = calloc(1, sizeof(*ev));
    if (!ev) {
        return NULL; /* errno set by calloc */
    }

    ps_event_generate_uuid(ev->id);
    ev->type  = type;
    ev->ts_epoch_ms = (int64_t) ( (long long)time(NULL) * 1000LL );
    ev->origin  = strdup(origin);
    ev->payload = strdup(payload_utf8);
    if (!ev->origin || !ev->payload) {
        free(ev->origin);
        free(ev->payload);
        free(ev);
        return NULL; /* ENOMEM */
    }
    atomic_init(&ev->ref_cnt, 1);
    return ev;
}

ps_event_t *ps_event_retain(ps_event_t *ev)
{
    if (ev) {
        atomic_fetch_add_explicit(&ev->ref_cnt, 1, memory_order_relaxed);
    }
    return ev;
}

void ps_event_release(ps_event_t *ev)
{
    if (!ev) return;

    if (atomic_fetch_sub_explicit(&ev->ref_cnt, 1, memory_order_acq_rel) == 1) {
        /* Last reference: free resources */
        free(ev->origin);
        free(ev->payload);
        free(ev);
    }
}

/* -------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */
int ps_event_validate(const ps_event_t *ev, char **err_out)
{
    return ps_event_validate_internal(ev, err_out);
}

static int ps_event_validate_internal(const ps_event_t *ev, char **err)
{
    if (!ev) {
        if (err) *err = strdup("event pointer is NULL");
        return -1;
    }
    if (ps_event_type_to_str(ev->type) == PS_EVENT_TYPE_STR[PS_EVENT_UNKNOWN]) {
        if (err) asprintf(err, "invalid event type: %d", ev->type);
        return -1;
    }
    if (strlen(ev->id) != PS_EVENT_ID_STR_LEN - 1) {
        if (err) *err = strdup("invalid UUID length");
        return -1;
    }
    if (!ev->origin || *ev->origin == '\0') {
        if (err) *err = strdup("origin is empty");
        return -1;
    }
    if (!ev->payload || *ev->payload == '\0') {
        if (err) *err = strdup("payload is empty");
        return -1;
    }
    return 0;
}

/* -------------------------------------------------------------------------
 * Serialization helpers
 * ------------------------------------------------------------------------- */
char *ps_event_to_json(const ps_event_t *ev)
{
    if (!ev) {
        errno = EINVAL;
        return NULL;
    }

    json_t *root = json_object();
    if (!root) return NULL;

    json_object_set_new(root, "id",        json_string(ev->id));
    json_object_set_new(root, "type",      json_string(ps_event_type_to_str(ev->type)));
    json_object_set_new(root, "ts_epoch",  json_integer(ev->ts_epoch_ms));
    json_object_set_new(root, "origin",    json_string(ev->origin));

    /* Payload is already a JSON document.  Parse and embed. */
    json_error_t jerr;
    json_t *payload_json = json_loads(ev->payload, 0, &jerr);
    if (!payload_json) {
        /* Store as raw string if parsing failed */
        json_object_set_new(root, "payload_raw", json_string(ev->payload));
    } else {
        json_object_set_new(root, "payload", payload_json);
    }

    /* Dump compact JSON */
    char *dump = json_dumps(root, JSON_COMPACT);
    json_decref(root);
    return dump; /* caller should free() */
}

ps_event_t *ps_event_from_json(const char *json_str, char **err_out)
{
    json_error_t jerr;
    json_t *root = json_loads(json_str, 0, &jerr);
    if (!root) {
        if (err_out) asprintf(err_out, "JSON parse error: line %d: %s",
                              jerr.line, jerr.text);
        return NULL;
    }

    const char *id      = json_string_value(json_object_get(root, "id"));
    const char *type_s  = json_string_value(json_object_get(root, "type"));
    const char *origin  = json_string_value(json_object_get(root, "origin"));
    json_t     *payload = json_object_get(root, "payload");

    if (!id || !type_s || !origin || !payload) {
        if (err_out) *err_out = strdup("missing required fields");
        json_decref(root);
        return NULL;
    }

    char *payload_compact = json_dumps(payload, JSON_COMPACT);
    if (!payload_compact) {
        if (err_out) *err_out = strdup("failed to serialize payload");
        json_decref(root);
        return NULL;
    }

    ps_event_t *ev = ps_event_create(ps_event_type_from_str(type_s),
                                     origin,
                                     payload_compact);

    free(payload_compact);
    json_decref(root);

    if (!ev) {
        if (err_out) *err_out = strdup("allocation failure");
        return NULL;
    }

    /* Overwrite generated ID with one from JSON (must fit). */
    if (strlen(id) == PS_EVENT_ID_STR_LEN - 1) {
        memcpy(ev->id, id, PS_EVENT_ID_STR_LEN - 1);
        ev->id[PS_EVENT_ID_STR_LEN - 1] = '\0';
    }

    return ev;
}

/* -------------------------------------------------------------------------
 * Utility
 * ------------------------------------------------------------------------- */
static void ps_event_generate_uuid(char out[PS_EVENT_ID_STR_LEN])
{
    /* Poor-man's UUIDv4 (random). For cryptographic quality you
     * should hook this into a real UUID generator (e.g., libuuid). */
    static const char *hex = "0123456789abcdef";
    uint8_t bytes[16];
    FILE *urnd = fopen("/dev/urandom", "rb");
    if (urnd && fread(bytes, 1, sizeof(bytes), urnd) == sizeof(bytes)) {
        fclose(urnd);
    } else {
        if (urnd) fclose(urnd);
        /* Fallback to PRNG */
        srand((unsigned)time(NULL) ^ (uintptr_t)&bytes);
        for (size_t i = 0; i < sizeof(bytes); ++i)
            bytes[i] = rand() & 0xFF;
    }

    /* UUID format: 8-4-4-4-12 */
    snprintf(out, PS_EVENT_ID_STR_LEN,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             bytes[0], bytes[1], bytes[2], bytes[3],
             bytes[4], bytes[5],
             bytes[6], bytes[7],
             bytes[8], bytes[9],
             bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
}

/* -------------------------------------------------------------------------
 * Debug helpers
 * ------------------------------------------------------------------------- */
void ps_event_dump(const ps_event_t *ev, FILE *out)
{
    if (!ev) {
        fprintf(out ?: stderr, "ps_event: (null)\n");
        return;
    }
    char *json = ps_event_to_json(ev);
    if (!json) {
        fprintf(out ?: stderr, "ps_event: (failed to serialize)\n");
        return;
    }
    fprintf(out ?: stdout, "%s\n", json);
    free(json);
}