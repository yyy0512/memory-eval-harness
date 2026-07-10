```c
/**
 * File:   pulsesphere/services/enrichment_service/tests/test_main.c
 * Author: PulseSphere QA Team
 *
 * Unit-test suite for the Enrichment Service using the Criterion testing
 * framework.  The tests cover normal operation, error conditions, and
 * multi-threaded stress scenarios.  To run:
 *
 *      $ meson test            # if the project uses Meson
 *      $ ninja -C build test   # or your build system’s equivalent
 *
 * Compile flags (example):
 *      cc -o test_main test_main.c -lcriterion -lpthread -lenrichment_service
 */

#include <criterion/criterion.h>
#include <criterion/redirect.h>

#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "enrichment_service.h"   /* Production header */

/*--------------------------------------------------------------------*/
/*                        Helper Utilities                            */
/*--------------------------------------------------------------------*/

/* Generates a pseudo-random UUIDv4 string (36 chars + NUL). */
static void
generate_uuid(char uuid[37])
{
    static const char tpl[] = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    const char *hex = "0123456789abcdef";
    uint8_t rnd;

    for (size_t i = 0; tpl[i]; ++i) {
        switch (tpl[i]) {
        case 'x':
            rnd = (uint8_t)(rand() & 0x0F);
            uuid[i] = hex[rnd];
            break;
        case 'y':
            rnd = (uint8_t)(rand() & 0x03);
            uuid[i] = hex[rnd | 0x08];
            break;
        default:
            uuid[i] = tpl[i];
        }
    }
    uuid[36] = '\0';
}

/* Creates a minimally valid “Pulse” event with a JSON payload. */
static ps_event_t
make_dummy_event(const char *platform)
{
    ps_event_t ev                  = { 0 };
    ev.ts_epoch_ms                 = (uint64_t)time(NULL) * 1000ULL;
    strncpy(ev.platform, platform, sizeof(ev.platform) - 1);
    generate_uuid(ev.id);

    /* Simplified JSON payload ─ normally this would be a BSON blob or
     * protocol buffer. */
    snprintf(ev.payload, sizeof(ev.payload),
             "{"
                 "\"user\":\"alice\","
                 "\"text\":\"Hello, world!\","
                 "\"action\":\"like\""
             "}");

    return ev;
}

/*--------------------------------------------------------------------*/
/*                           Test Fixtures                            */
/*--------------------------------------------------------------------*/

/* Path to a minimal configuration file (in CI it may live in /tmp). */
#define TEST_CONFIG_PATH  "test_resources/enrichment.conf"

static void
setup_enrichment_service(void)
{
    int rc = es_init(TEST_CONFIG_PATH);
    cr_assert_eq(rc, 0, "Failed to initialize enrichment service, rc=%d", rc);
}

static void
teardown_enrichment_service(void)
{
    es_shutdown();
}

/*--------------------------------------------------------------------*/
/*                             Test Cases                             */
/*--------------------------------------------------------------------*/

/* Basic life-cycle. */
TestSuite(es_lifecycle, .init = setup_enrichment_service,
                            .fini = teardown_enrichment_service);

Test(es_lifecycle, init_and_shutdown_are_idempotent)
{
    /* First init is done by fixture.  Call init again to verify that the
     * library behaves idempotently. */
    int rc = es_init(TEST_CONFIG_PATH);
    cr_assert_eq(rc, 0, "Second es_init() call not idempotent, rc=%d", rc);

    es_shutdown();          /* First shutdown (explicit) */
    es_shutdown();          /* Second shutdown should be a no-op */
}

/*--------------------------------------------------------------------*/

TestSuite(es_functional, .init = setup_enrichment_service,
                           .fini = teardown_enrichment_service);

/* Happy flow enrichment of a valid event. */
Test(es_functional, enriches_event_successfully)
{
    ps_event_t          ev  = make_dummy_event("instagram");
    ps_enriched_event_t out = { 0 };

    int rc = es_process_event(&ev, &out);

    cr_assert_eq(rc, 0, "Enrichment failed with rc=%d", rc);
    cr_assert_float_neq(out.lat, 0.0, 1e-6,
                        "Latitude not populated during enrichment");
    cr_assert_str_eq(out.language, "en",
                     "Language detection failed, expected 'en'");
    cr_assert_gt(out.toxicity, 0.0,
                 "Toxicity score not populated (>0 expected)");
    cr_assert_str_eq(out.base.id, ev.id,
                     "Event IDs differ after enrichment");
}

/* Malformed input event should yield a non-zero error code. */
Test(es_functional, detects_malformed_event)
{
    ps_event_t          bad = { 0 };            /* Zeroed: missing platform/id */
    ps_enriched_event_t out = { 0 };

    int rc = es_process_event(&bad, &out);

    cr_assert_neq(rc, 0, "Malformed event not detected (rc=%d)", rc);
}

/*--------------------------------------------------------------------*/

TestSuite(es_concurrency, .init = setup_enrichment_service,
                             .fini = teardown_enrichment_service);

#define THREAD_CT   32u
#define EVENTS_PER_THREAD  128u

typedef struct {
    unsigned int idx;
    unsigned int ok;
    unsigned int fail;
} thread_ctx_t;

static void *
worker_thread(void *arg)
{
    thread_ctx_t *ctx = arg;

    for (unsigned int i = 0; i < EVENTS_PER_THREAD; ++i) {
        ps_event_t          ev  = make_dummy_event("twitter");
        ps_enriched_event_t out = { 0 };

        if (es_process_event(&ev, &out) == 0 &&
            out.toxicity > 0.0) {
            ctx->ok++;
        } else {
            ctx->fail++;
        }
    }
    return NULL;
}

/* Stress the enrichment service with many concurrent calls. */
Test(es_concurrency, thread_safety_under_load)
{
    pthread_t     tids[THREAD_CT];
    thread_ctx_t  ctx[THREAD_CT] = { 0 };

    /* Spawn all threads. */
    for (unsigned int i = 0; i < THREAD_CT; ++i) {
        ctx[i].idx = i;
        int rc = pthread_create(&tids[i], NULL, worker_thread, &ctx[i]);
        cr_assert_eq(rc, 0, "pthread_create failed (rc=%d)", rc);
    }

    /* Wait for completion. */
    unsigned int total_ok   = 0;
    unsigned int total_fail = 0;

    for (unsigned int i = 0; i < THREAD_CT; ++i) {
        pthread_join(tids[i], NULL);
        total_ok   += ctx[i].ok;
        total_fail += ctx[i].fail;
    }

    cr_assert_eq(total_fail, 0,
                 "Some events failed during concurrent processing "
                 "(ok=%u, fail=%u)", total_ok, total_fail);
}

/*--------------------------------------------------------------------*/
/*                    Output / Logging Verification                   */
/*--------------------------------------------------------------------*/

/* Redirects stderr to capture log output emitted during an error. */
static void
redirect_stderr(void)
{
    cr_redirect_stderr();
}

/* Verify that the library writes a meaningful error message. */
Test(es_functional, logs_error_message_on_failure,
     .init = redirect_stderr)
{
    ps_event_t          bad = { 0 };
    ps_enriched_event_t out = { 0 };

    int rc = es_process_event(&bad, &out);
    cr_assert_neq(rc, 0);

    /* Flush I/O before reading buffer. */
    fflush(stderr);

    char *err = cr_asprintf(NULL, "%s", cr_get_redirected_stderr());
    cr_expect(err != NULL, "Failed to capture stderr");

    /* A rudimentary check for presence of the word “error”. */
    if (err) {
        cr_assert(
            strstr(err, "error") || strstr(err, "ERROR"),
            "Enrichment service did not log an error message:\n%s", err
        );
        free(err);
    }
}
```