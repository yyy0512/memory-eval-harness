```c
/*
 * pulsesphere/services/enrichment_service/tests/test_enrichment_engine.c
 *
 * Unit- & integration-tests for the PulseSphere enrichment engine.
 *
 * The tests exercise the engine’s public contract:
 *   1. correct start-up / shut-down semantics
 *   2. happy-path enrichment of a well-formed social-pulse
 *   3. graceful failure on invalid configuration / corrupt events
 *   4. thread-safety guarantees under concurrent load
 *
 * The tests are written with CMocka because it is lightweight, permits
 * fine-grained expectations, and integrates nicely with most CI runners.
 *
 * Compile (example):
 *   gcc -I../../include -pthread \
 *       test_enrichment_engine.c  \
 *       -lcmocka -lenrichment_engine -o test_enrichment_engine
 *
 * Run:
 *   ./test_enrichment_engine
 */

#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <stdlib.h>

#include "enrichment_engine.h"   /* Public header we are testing */


#define VALID_CONFIG_PATH   "tests/resources/enrichment_valid.toml"
#define INVALID_CONFIG_PATH "tests/resources/__file_does_not_exist__.toml"
#define THREAD_COUNT        4
#define EVENTS_PER_THREAD   128


/*
 * Helpers ────────────────────────────────────────────────────────────
 */

/* Create a minimal mock social-pulse for testing */
static PulseEvent *
mock_event(const char *user_id,
           const char *text,
           double latitude,
           double longitude)
{
    PulseEvent *evt = pulse_event_create();
    assert_non_null(evt);

    pulse_event_set_user_id(evt, user_id);
    pulse_event_set_payload_text(evt, text);
    pulse_event_set_coordinate(evt, latitude, longitude);
    pulse_event_finalize(evt);           /* mark immutable */
    return evt;
}

/* Destroy event and swallow NULLs for convenience */
static void
destroy_event(PulseEvent *evt)
{
    if (evt)
        pulse_event_destroy(evt);
}

/* ASSERT helpers to avoid repetitive verbose checks */
static void
assert_enriched_basic(const EnrichedEvent *e)
{
    assert_non_null(e);
    assert_int_equal(enriched_event_validation_status(e), 0);
    assert_non_null(enriched_event_language(e));
    assert_true(enriched_event_sentiment_score(e) >= -1.0 &&
                enriched_event_sentiment_score(e) <=  1.0);
    assert_true(enriched_event_has_geotag(e));
}


/*
 * Test fixtures ──────────────────────────────────────────────────────
 */

typedef struct {
    EnrichmentEngine *engine;
} fixture_t;


/* one-shot setup for tests that need a live engine instance */
static int
fixture_setup(void **state)
{
    fixture_t *fx = calloc(1, sizeof *fx);
    if (!fx)
        return -1;

    int rc = enrichment_engine_init(&fx->engine, VALID_CONFIG_PATH);
    if (rc != 0) {
        free(fx);
        return -1;
    }

    *state = fx;
    return 0;
}

static int
fixture_teardown(void **state)
{
    fixture_t *fx = *state;
    if (!fx)
        return -1;

    enrichment_engine_shutdown(fx->engine);
    free(fx);
    return 0;
}


/*
 * Individual test cases ──────────────────────────────────────────────
 */

/* 1. engine starts with a valid configuration */
static void
test_engine_init_success(void **state)
{
    (void)state;    /* unused */

    EnrichmentEngine *eng = NULL;
    assert_int_equal(enrichment_engine_init(&eng, VALID_CONFIG_PATH), 0);
    assert_non_null(eng);
    enrichment_engine_shutdown(eng);
}

/* 2. engine fails on missing / unreadable configuration */
static void
test_engine_init_failure_missing_conf(void **state)
{
    (void)state;

    EnrichmentEngine *eng = NULL;
    assert_int_not_equal(enrichment_engine_init(&eng, INVALID_CONFIG_PATH), 0);
    assert_null(eng);
}

/* 3. happy-path enrichment of a well-formed pulse */
static void
test_engine_process_event_basic(void **state)
{
    fixture_t *fx = *state;

    PulseEvent    *src = mock_event("user-a", "Such a wonderful day!", 48.8584, 2.2945);
    EnrichedEvent *dst = NULL;

    assert_int_equal(enrichment_engine_process_event(fx->engine, src, &dst), 0);
    assert_enriched_basic(dst);

    /* cleanup */
    destroy_event(src);
    enriched_event_destroy(dst);
}

/* 4. engine propagates error when fed with a corrupt event */
static void
test_engine_process_event_invalid(void **state)
{
    fixture_t *fx = *state;

    /* construct an INCOMPLETE (deliberately invalid) event */
    PulseEvent *broken = pulse_event_create();     /* missing payload & coords */
    assert_non_null(broken);

    EnrichedEvent *dst = NULL;
    assert_int_not_equal(enrichment_engine_process_event(fx->engine, broken, &dst), 0);
    assert_null(dst);

    destroy_event(broken);
}


/*
 * 5. Concurrency & thread-safety test. We push thousands of events from
 *    multiple threads and assert that:
 *      a) no call fails
 *      b) every thread gets a valid enrichment
 *      c) the engine does not leak (rudimentary check: counter matches)
 */

typedef struct {
    fixture_t      *fx;
    atomic_size_t  *success_ctr;
} thread_ctx_t;

static void *
producer_thread(void *arg)
{
    thread_ctx_t *ctx = arg;

    for (unsigned i = 0; i < EVENTS_PER_THREAD; ++i) {
        char uid[32];
        snprintf(uid, sizeof uid, "u-%03u", i);

        PulseEvent    *src = mock_event(uid, "Threaded test payload", 35.0, 139.0);
        EnrichedEvent *dst = NULL;

        int rc = enrichment_engine_process_event(ctx->fx->engine, src, &dst);
        if (rc == 0) {
            /* quick sanity on result */
            if (dst && enriched_event_validation_status(dst) == 0)
                atomic_fetch_add(ctx->success_ctr, 1);
        }

        destroy_event(src);
        enriched_event_destroy(dst);
    }

    return NULL;
}

static void
test_engine_thread_safety(void **state)
{
    fixture_t *fx = *state;

    pthread_t      tid[THREAD_COUNT] = {0};
    thread_ctx_t   ctx               = { .fx = fx };
    atomic_size_t  success_ctr       = 0;
    ctx.success_ctr                  = &success_ctr;

    for (size_t i = 0; i < THREAD_COUNT; ++i)
        assert_int_equal(pthread_create(&tid[i], NULL, producer_thread, &ctx), 0);

    for (size_t i = 0; i < THREAD_COUNT; ++i)
        assert_int_equal(pthread_join(tid[i], NULL), 0);

    /* Every event processed in every thread should succeed. */
    const size_t expected = THREAD_COUNT * EVENTS_PER_THREAD;
    assert_int_equal(atomic_load(&success_ctr), expected);
}


/*
 * Main test-runner ───────────────────────────────────────────────────
 */

int
main(void)
{
    const struct CMUnitTest suite[] = {
        cmocka_unit_test(test_engine_init_success),
        cmocka_unit_test(test_engine_init_failure_missing_conf),

        cmocka_unit_test_setup_teardown(
            test_engine_process_event_basic,
            fixture_setup,
            fixture_teardown),

        cmocka_unit_test_setup_teardown(
            test_engine_process_event_invalid,
            fixture_setup,
            fixture_teardown),

        cmocka_unit_test_setup_teardown(
            test_engine_thread_safety,
            fixture_setup,
            fixture_teardown),
    };

    /* CMocka has built-in XML reporting (for CI systems) via env-var:
     *   CMOCKA_XML_FILE=report.xml ./test_binary
     */
    return cmocka_run_group_tests(suite, NULL, NULL);
}
```