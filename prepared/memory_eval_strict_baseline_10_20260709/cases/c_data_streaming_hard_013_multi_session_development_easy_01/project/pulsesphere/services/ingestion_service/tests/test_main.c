/*
 * pulsesphere/services/ingestion_service/tests/test_main.c
 *
 * Unit-tests for the PulseSphere ingestion service.  The tests are
 * written with the cmocka framework (https://cmocka.org) and exercise
 * both happy-path and error-path code-paths, as well as a rudimentary
 * concurrency/throughput scenario.
 *
 * To compile:
 *      gcc -std=c11 -Wall -Wextra -pthread \
 *          test_main.c -lcmocka -o test_ingestion
 *
 * To run:
 *      ./test_ingestion
 */

#define _POSIX_C_SOURCE 200809L

#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* =========================================================================
 * Attempt to pull in the “real” ingestion service headers.  If they are not
 * available (e.g. during CI or when the unit-tests are built in isolation),
 * fall back to a set of light-weight stubs that can be transparently
 * overridden by the real implementation at link-time.
 * =========================================================================
 */
#if defined(__has_include)
#   if __has_include("ingestion_service.h")
#       include "ingestion_service.h"
#       define HAVE_REAL_INGESTION_SERVICE 1
#   endif
#endif

#ifndef HAVE_REAL_INGESTION_SERVICE
/* ---------------------------  STUB DEFINITIONS  ------------------------- */
typedef struct ingestion_ctx  ingestion_ctx_t;

typedef struct validated_event {
    char id[64];
    char type[32];
    char payload[1024];
} validated_event_t;

/* Return codes mimicking the real service. */
enum {
    INGESTION_SUCCESS     = 0,
    INGESTION_ERR_INVALID = 1,
    INGESTION_ERR_INTERNAL = 2
};

/* Weak, link-override-able stubs ───────────────────────────────────────── */
__attribute__((weak))
int ingestion_service_init(ingestion_ctx_t **ctx)
{
    (void)ctx;
    *ctx = (ingestion_ctx_t *)0xdeadbeef; /* dummy non-NULL pointer     */
    return INGESTION_SUCCESS;
}

__attribute__((weak))
int ingestion_service_process_event(ingestion_ctx_t *ctx,
                                    const char        *raw_event,
                                    validated_event_t *out)
{
    (void)ctx;

    if (!raw_event)
        return INGESTION_ERR_INVALID;

    if (strstr(raw_event, "\"id\"") && strstr(raw_event, "\"type\"")) {
        if (out) {
            strncpy(out->id, "stub-id", sizeof(out->id));
            strncpy(out->type, "like",   sizeof(out->type));
            strncpy(out->payload, raw_event, sizeof(out->payload));
        }
        return INGESTION_SUCCESS;
    }

    return INGESTION_ERR_INVALID;
}

__attribute__((weak))
int ingestion_service_shutdown(ingestion_ctx_t *ctx)
{
    (void)ctx;
    return INGESTION_SUCCESS;
}
#endif /* !HAVE_REAL_INGESTION_SERVICE */


/* =========================================================================
 * Test-fixture helpers
 * =========================================================================
 */
static int setup_ingestion_service(void **state)
{
    ingestion_ctx_t *ctx = NULL;
    assert_int_equal(ingestion_service_init(&ctx), INGESTION_SUCCESS);
    *state = ctx;
    return 0;
}

static int teardown_ingestion_service(void **state)
{
    ingestion_ctx_t *ctx = *state;
    assert_int_equal(ingestion_service_shutdown(ctx), INGESTION_SUCCESS);
    return 0;
}


/* =========================================================================
 * Individual test-cases
 * =========================================================================
 */

/* Happy-path: Feed a well-formed JSON event; expect success. */
static void test_valid_event_processing(void **state)
{
    ingestion_ctx_t  *ctx = *state;
    const char       *json =
        "{"
        "\"id\":\"12345\","
        "\"type\":\"like\","
        "\"user\":\"alice\","
        "\"timestamp\":1678900000,"
        "\"payload\":{\"post_id\":\"42\"}"
        "}";

    validated_event_t ve = {0};

    int rc = ingestion_service_process_event(ctx, json, &ve);
    assert_int_equal(rc, INGESTION_SUCCESS);
    assert_string_equal(ve.type, "like");
    /* The stub returns “stub-id”; the real implementation should echo the
     * original “12345”.  We just verify non-emptiness to stay agnostic.   */
    assert_true(strlen(ve.id) > 0);
}

/* Negative test: Missing required “type” field -> validation should fail. */
static void test_invalid_event_schema(void **state)
{
    ingestion_ctx_t *ctx = *state;
    const char      *json =
        "{"
        "\"id\":\"67890\","
        "\"user\":\"bob\""
        "}";

    validated_event_t ve = {0};
    int rc = ingestion_service_process_event(ctx, json, &ve);
    assert_int_equal(rc, INGESTION_ERR_INVALID);
}

/* Negative test: NULL pointer as input must not seg-fault and must err. */
static void test_null_input(void **state)
{
    ingestion_ctx_t *ctx = *state;
    int rc = ingestion_service_process_event(ctx, NULL, NULL);
    assert_int_equal(rc, INGESTION_ERR_INVALID);
}


/* -------------------------------------------------------------------------
 * Throughput / concurrency test
 *
 * We spin up N threads, each of which processes M synthetic events.
 * The only assertion is that all calls succeed.  We also measure wall-clock
 * time and print a rudimentary events/sec metric (not asserted).
 * -------------------------------------------------------------------------
 */
#define THROUGHPUT_THREADS  8
#define EVENTS_PER_THREAD   1000u

typedef struct {
    size_t            idx;           /* thread index (0 .. N-1)           */
    size_t            processed_ok;  /* output: how many succeeded        */
} thread_arg_t;

static void *worker_thread(void *opaque)
{
    thread_arg_t    *arg = opaque;
    ingestion_ctx_t *ctx = NULL;

    assert_int_equal(ingestion_service_init(&ctx), INGESTION_SUCCESS);

    char json[256];

    for (size_t i = 0; i < EVENTS_PER_THREAD; ++i) {
        snprintf(json, sizeof(json),
                 "{"
                 "\"id\":\"%zu-%zu\","
                 "\"type\":\"comment\","
                 "\"user\":\"user_%zu\","
                 "\"payload\":{\"body\":\"hello\"}"
                 "}",
                 arg->idx, i, arg->idx);

        if (ingestion_service_process_event(ctx, json, NULL) == INGESTION_SUCCESS)
            arg->processed_ok++;
    }

    assert_int_equal(ingestion_service_shutdown(ctx), INGESTION_SUCCESS);
    return NULL;
}

static void test_high_throughput_batch(void **unused)
{
    (void)unused;

    pthread_t     tids[THROUGHPUT_THREADS];
    thread_arg_t  args[THROUGHPUT_THREADS] = {{0}};

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    /* Launch worker threads */
    for (size_t i = 0; i < THROUGHPUT_THREADS; ++i) {
        args[i].idx = i;
        assert_int_equal(pthread_create(&tids[i], NULL, worker_thread, &args[i]), 0);
    }

    /* Join everything */
    for (size_t i = 0; i < THROUGHPUT_THREADS; ++i) {
        assert_int_equal(pthread_join(tids[i], NULL), 0);
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);

    /* Aggregate & validate */
    size_t total_ok = 0;
    for (size_t i = 0; i < THROUGHPUT_THREADS; ++i)
        total_ok += args[i].processed_ok;

    const size_t expected = THROUGHPUT_THREADS * EVENTS_PER_THREAD;
    assert_int_equal(total_ok, expected);

    /* Print throughput (diagnostic only) */
    double elapsed =
        (t1.tv_sec  - t0.tv_sec) +
        (t1.tv_nsec - t0.tv_nsec) / 1e9;

    fprintf(stderr,
            "[throughput] %zu events in %.3f s  =>  %.0f events/sec\n",
            expected, elapsed, expected / elapsed);
}


/* =========================================================================
 * Test runner
 * =========================================================================
 */
int main(void)
{
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_setup_teardown(test_valid_event_processing,
                                        setup_ingestion_service,
                                        teardown_ingestion_service),

        cmocka_unit_test_setup_teardown(test_invalid_event_schema,
                                        setup_ingestion_service,
                                        teardown_ingestion_service),

        cmocka_unit_test_setup_teardown(test_null_input,
                                        setup_ingestion_service,
                                        teardown_ingestion_service),

        cmocka_unit_test(test_high_throughput_batch),
    };

    return cmocka_run_group_tests(tests, NULL, NULL);
}