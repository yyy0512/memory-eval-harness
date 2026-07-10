```c
/**
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * ------------------------------------------------------
 * analytics_sink_service/tests/test_main.c
 *
 * Copyright (c) 2024.
 *
 * Unit-tests for the Analytics-Sink micro-service.  The service is
 * responsible for receiving validated Social-Pulse events, performing
 * last-mile enrichment (if any) and delivering them to long-term
 * analytical sinks (Data Lake, OLAP, Object-Storage, etc.).
 *
 * The tests are written with CMocka (https://cmocka.org) and can be
 * executed with `ctest` or directly via the generated test binary.
 *
 * Compile example:
 *   cc -DUNIT_TESTING `pkg-config --cflags cmocka` \
 *      -I../../include \
 *      -o test_main test_main.c \
 *      `pkg-config --libs cmocka`
 */

#define _POSIX_C_SOURCE 200809L    /* For strdup, clock_gettime */
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cmocka.h>

#include "analytics_sink_service.h" /* Production header */

/* ------------------------------------------------------------------ *
 * BASIC SANITY CHECKS                                                *
 * ------------------------------------------------------------------ */

/* A minimal, *representative* pulse event; mirrors production struct. */
static
social_pulse_t mk_dummy_pulse(uint64_t id, const char *source, const char *payload)
{
    social_pulse_t pulse = {
        .id           = id,
        .ts_ms        = 1700000000000ULL, /* Fixed timestamp for determinism */
        .is_validated = true
    };
    strncpy(pulse.source,  source,  sizeof(pulse.source)  - 1);
    strncpy(pulse.payload, payload, sizeof(pulse.payload) - 1);
    return pulse;
}

/* ------------------------------------------------------------------ *
 *               MOCKS  –  PRODUCTION SIDE-EFFECT BARRIERS            *
 * ------------------------------------------------------------------ */

/*
 * The analytics sink internally calls `sink_dispatch_event()` to push the
 * event to downstream sinks (S3, Hive, Iceberg, Kafka, …).  We wrap this
 * symbol so tests can validate that the correct events reach the sink
 * layer WITHOUT requiring the full pipeline to be online.
 *
 * The production code must declare it with non-static linkage:
 *     int sink_dispatch_event(const social_pulse_t *event);
 *
 * At link-time we interpose our version.  Each call is forwarded to
 * cmocka's `mock_type()` to allow fine-grained expectations.
 */
#ifdef UNIT_TESTING
int sink_dispatch_event(const social_pulse_t *event)
{
    check_expected_ptr(event);
    return mock_type(int);
}
#endif  /* UNIT_TESTING */

/*
 * I/O heavy flush to long-term storage is abstracted behind:
 *     int sink_flush_window(void);
 */
#ifdef UNIT_TESTING
int sink_flush_window(void)
{
    return mock_type(int);
}
#endif

/* ------------------------------------------------------------------ *
 *                          TEST CASES                                *
 * ------------------------------------------------------------------ */

/* ----------  Initialization  ---------- */
static void test_init_with_valid_config(void **state)
{
    (void) state;

    /* Expectation: Service should bootstrap successfully. */
    assert_int_equal(analytics_sink_service_init("tests/resources/valid-config.json"), 0);

    /* Double-init must be idempotent and return EALREADY. */
    assert_int_equal(analytics_sink_service_init("tests/resources/valid-config.json"), -EALREADY);
}

/* ----------  Event Processing Path  ---------- */
static void test_process_single_event_happy_path(void **state)
{
    (void) state;

    social_pulse_t pulse = mk_dummy_pulse(42, "instagram", "{\"like\":true}");

    /* Expect that the dispatch function is invoked exactly once with &pulse. */
    expect_any(sink_dispatch_event, event);
    will_return(sink_dispatch_event, 0);

    assert_int_equal(analytics_sink_service_process_event(&pulse), 0);
}

/* ----------  Validation Errors  ---------- */
static void test_process_event_invalid_schema(void **state)
{
    (void) state;

    /* Invalid because 'is_validated' is false. */
    social_pulse_t bad = mk_dummy_pulse(99, "reddit", "{\"bad\":true}");
    bad.is_validated = false;

    /* Service should reject silently with -EINVAL and MUST NOT call dispatch. */
    assert_int_equal(analytics_sink_service_process_event(&bad), -EINVAL);
}

/* ----------  Flush & Commit  ---------- */
static void test_flush_window_propagates_error(void **state)
{
    (void) state;

    /* Flush fails deep inside storage driver (simulated). */
    will_return(sink_flush_window, -EIO);
    assert_int_equal(analytics_sink_service_flush(), -EIO);

    /* On success path return 0. */
    will_return(sink_flush_window, 0);
    assert_int_equal(analytics_sink_service_flush(), 0);
}

/* ----------  Graceful Shutdown  ---------- */
static void test_shutdown_releases_resources(void **state)
{
    (void) state;

    /* Shutdown is void, but calling it twice must be safe. */
    analytics_sink_service_shutdown();
    analytics_sink_service_shutdown();
}

/* ----------  Signal Safety (optional)  ---------- */
static void test_sigint_triggers_shutdown(void **state)
{
    (void) state;

    /* In production, SIGINT handler flips an atomic and unblocks main loop.
     * We simulate the handler directly. */
    extern void analytics_sink_service_sig_handler(int);
    analytics_sink_service_sig_handler(SIGINT);

    /* Ensure that the shutdown flag is set */
    assert_true(analytics_sink_service_is_shutting_down());
}

/* ------------------------------------------------------------------ *
 *                             MAIN                                   *
 * ------------------------------------------------------------------ */
int main(void)
{
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_init_with_valid_config),
        cmocka_unit_test(test_process_single_event_happy_path),
        cmocka_unit_test(test_process_event_invalid_schema),
        cmocka_unit_test(test_flush_window_propagates_error),
        cmocka_unit_test(test_shutdown_releases_resources),
        cmocka_unit_test(test_sigint_triggers_shutdown),
    };

    /* Run all test cases and return aggregated status. */
    return cmocka_run_group_tests_name("Analytics-Sink-Service", tests, NULL, NULL);
}
```