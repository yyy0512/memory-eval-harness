```c
/**
 * PulseSphere – Validation Service
 *
 * Unit-tests for the event–validator component.
 *
 * File: pulsesphere/services/validation_service/tests/test_validator.c
 *
 * These tests exercise the public interface exposed by the validator:
 *     – ps_validator_init()
 *     – ps_validator_cleanup()
 *     – ps_validate_event()
 *
 * The tests are written with the CMocka framework.  They can be compiled and
 * executed via CTest or directly with `cmake --build . && ctest`.
 */

#define _GNU_SOURCE  /* strdup() */
#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "validator.h"   /* Production header under test */

/* ------------------------------------------------------------------------- */
/*                    Helpers & Common Test Utilities                        */
/* ------------------------------------------------------------------------- */

/* Directory that contains JSON-schema assets used by the validator.
 * During CI, the working dir is the repository root; for IDE runs the
 * environment variable PULSE_SCHEMA_DIR can be set to override. */
static const char *schema_dir(void)
{
    const char *override = getenv("PULSE_SCHEMA_DIR");
    return override ? override : "schema";
}

/* Generate a simple ISO-8601 timestamp in UTC. */
static void timestamp_now(char ts[32])
{
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    strftime(ts, 32, "%Y-%m-%dT%H:%M:%SZ", &tm);
}

/* Factory that returns a well-formed baseline event.  The caller must free
 * the returned ps_event instance via ps_event_destroy(). */
static struct ps_event *make_happy_path_event(void)
{
    struct ps_event *ev = calloc(1, sizeof *ev);
    assert_non_null(ev);

    ev->id     = strdup("evt_12345");
    ev->source = strdup("twitter");
    ev->type   = strdup("like");

    const char *json =
        "{ \"user\":    \"alice\","
        "  \"post_id\": \"post_999\","
        "  \"metadata\": { \"client\": \"ios\" } }";

    ev->payload_json = strdup(json);
    ev->payload_len  = strlen(json);

    timestamp_now(ev->iso_timestamp);

    return ev;
}

/* Destruct an event produced by make_happy_path_event(). */
static void free_event(struct ps_event *ev)
{
    if (!ev) return;
    free(ev->id);
    free(ev->source);
    free(ev->type);
    free(ev->payload_json);
    free(ev);
}

/* Convenience macro that calls the validator and checks for success. */
#define VALIDATE_OK(ev)                                            \
    do {                                                           \
        char *err = NULL;                                          \
        assert_int_equal(ps_validate_event(ev, &err), 0);          \
        assert_null(err);                                          \
    } while (0)

/* Convenience for expecting a failure. */
#define VALIDATE_FAIL(ev, expected_ec)                             \
    do {                                                           \
        char *err = NULL;                                          \
        assert_int_equal(ps_validate_event(ev, &err), expected_ec);\
        assert_non_null(err);                                      \
        free(err);                                                 \
    } while (0)

/* ------------------------------------------------------------------------- */
/*                               Test Cases                                  */
/* ------------------------------------------------------------------------- */

static int test_group_setup(void **state)
{
    (void)state;
    return ps_validator_init(schema_dir());
}

static int test_group_teardown(void **state)
{
    (void)state;
    ps_validator_cleanup();
    return 0;
}

/* --- Positive / happy path ------------------------------------------------ */
static void test_validate_happy_path(void **state)
{
    (void)state;
    struct ps_event *ev = make_happy_path_event();

    VALIDATE_OK(ev);
    free_event(ev);
}

/* --- Negative scenarios --------------------------------------------------- */
static void test_reject_missing_type(void **state)
{
    (void)state;
    struct ps_event *ev = make_happy_path_event();
    free(ev->type);
    ev->type = NULL;

    VALIDATE_FAIL(ev, -PS_E_SCHEMA);

    free_event(ev);
}

static void test_reject_malformed_json(void **state)
{
    (void)state;
    struct ps_event *ev = make_happy_path_event();
    free(ev->payload_json);
    ev->payload_json = strdup("{ this is not valid json ... ");
    ev->payload_len  = strlen(ev->payload_json);

    VALIDATE_FAIL(ev, -PS_E_BAD_JSON);

    free_event(ev);
}

static void test_reject_futuristic_timestamp(void **state)
{
    (void)state;
    struct ps_event *ev = make_happy_path_event();
    /* Add 10 years */
    time_t future = time(NULL) + (time_t)(3600 * 24 * 365 * 10);
    struct tm tm;
    gmtime_r(&future, &tm);
    strftime(ev->iso_timestamp, sizeof ev->iso_timestamp,
             "%Y-%m-%dT%H:%M:%SZ", &tm);

    VALIDATE_FAIL(ev, -PS_E_RANGE);

    free_event(ev);
}

/* --- Stress / concurrency ------------------------------------------------- */

/* Structure passed to worker threads. */
struct stress_ctx
{
    uint32_t iterations;
    int      rc;          /* first error code, 0 on success           */
};

/* Worker that validates the same event many times to surface race issues. */
static void *stress_worker(void *arg)
{
    struct stress_ctx *ctx = arg;
    for (uint32_t i = 0; i < ctx->iterations; ++i) {
        struct ps_event *ev = make_happy_path_event();
        char *err = NULL;
        int ret = ps_validate_event(ev, &err);
        free_event(ev);
        free(err);
        if (ret != 0) {
            ctx->rc = ret;
            return NULL;
        }
    }
    return NULL;
}

static void test_validate_thread_safety(void **state)
{
    (void)state;
    enum { THREADS = 8, LOOPS = 1000 };

    pthread_t tids[THREADS];
    struct stress_ctx ctxs[THREADS] = {0};

    for (int i = 0; i < THREADS; ++i) {
        ctxs[i].iterations = LOOPS;
        assert_int_equal(pthread_create(&tids[i], NULL,
                                        stress_worker, &ctxs[i]), 0);
    }

    for (int i = 0; i < THREADS; ++i)
        assert_int_equal(pthread_join(tids[i], NULL), 0);

    for (int i = 0; i < THREADS; ++i)
        assert_int_equal(ctxs[i].rc, 0);
}

/* ------------------------------------------------------------------------- */
/*                                 Runner                                    */
/* ------------------------------------------------------------------------- */

int main(void)
{
    const struct CMUnitTest tests[] = {
        cmocka_unit_test_setup_teardown(
            test_validate_happy_path,
            NULL, NULL),

        cmocka_unit_test_setup_teardown(
            test_reject_missing_type,
            NULL, NULL),

        cmocka_unit_test_setup_teardown(
            test_reject_malformed_json,
            NULL, NULL),

        cmocka_unit_test_setup_teardown(
            test_reject_futuristic_timestamp,
            NULL, NULL),

        cmocka_unit_test_setup_teardown(
            test_validate_thread_safety,
            NULL, NULL),
    };

    /* Group-level setup / teardown: init the validator once. */
    return cmocka_run_group_tests(tests,
                                  test_group_setup,
                                  test_group_teardown);
}
```