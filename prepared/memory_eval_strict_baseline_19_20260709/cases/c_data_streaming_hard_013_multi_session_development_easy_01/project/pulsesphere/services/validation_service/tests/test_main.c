/*
 * PulseSphere: Validation Service — Unit & Integration Tests
 *
 * File:    pulsesphere/services/validation_service/tests/test_main.c
 * Author:  PulseSphere Core Team
 *
 * Overview
 * --------
 * This file contains test-cases for the validation service that performs
 * schema-on-read checks on incoming “social pulse” events.  The tests are
 * built on top of the ‘Check’ unit-testing framework and exercise both
 * functional- and concurrency-level correctness of the public API defined in
 * validation.h.
 *
 * Compile (example)
 * -----------------
 * gcc -Wall -Wextra -pedantic -pthread \
 *     -I../../../include \
 *     test_main.c \
 *     -lcheck -lpthread -lrt -lm \
 *     -o validation_tests
 *
 * Running
 * -------
 * ./validation_tests
 */

#include <check.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

#include "validation.h"   /* Production header under test */

/* ------------------------------------------------------------------------- */
/* Helper Fixtures                                                           */
/* ------------------------------------------------------------------------- */

/* A well-formed pulse that must pass validation. */
static const char *VALID_PULSE =
    "{"
    "\"event_id\":\"6fa459ea-ee8a-3ca4-894e-db77e160355e\","
    "\"user_id\":\"user_42\","
    "\"type\":\"like\","
    "\"timestamp\": 1690492345,"
    "\"payload\":{"
        "\"source\":\"web\","
        "\"post_id\":\"post_9001\""
    "}"
    "}";

/* Pulse with missing mandatory field “type”. */
static const char *INVALID_PULSE_MISSING_FIELD =
    "{"
    "\"event_id\":\"1c6b1477-7030-4d83-bf0b-ecf9fc7876ad\","
    "\"user_id\":\"user_007\","
    "\"timestamp\": 1690492345,"
    "\"payload\":{}"
    "}";

/* Deliberately malformed (truncated) JSON. */
static const char *MALFORMED_JSON =
    "{ \"event_id\": \"abc\", \"user_id\": \"xyz\" ";

/* Generate an artificially large (≈64 KiB) JSON document for boundary test. */
static char *generate_large_json(void)
{
    static char buf[65536];
    size_t header_len = snprintf(buf, sizeof(buf),
                                 "{ \"event_id\":\"%s\",\"user_id\":\"%s\","
                                 "\"type\":\"comment\",\"timestamp\":%d,"
                                 "\"payload\":{ \"text\":\"",
                                 "deadbeef-feed-face-cafe-badd00d0123",
                                 "big_user",
                                 1690492345);

    /* Fill payload with repeating ‘A’s until size-1, leave room for closing. */
    memset(buf + header_len, 'A', sizeof(buf) - header_len - 3);
    strcpy(buf + sizeof(buf) - 3, "\"} }");   /* closing quotes/braces */

    return buf;
}

/* ------------------------------------------------------------------------- */
/* Functional Tests                                                          */
/* ------------------------------------------------------------------------- */

START_TEST(test_valid_pulse_should_pass)
{
    validation_result_t result;
    int rc = pulse_validate(VALID_PULSE, &result);

    ck_assert_msg(rc == 0, "pulse_validate() returned error code %d", rc);
    ck_assert_msg(result.valid == true, "Expected pulse to be valid");
    ck_assert_msg(result.error_msg[0] == '\0',
                  "Expected no error message, got: %s", result.error_msg);
}
END_TEST


START_TEST(test_missing_mandatory_field_should_fail)
{
    validation_result_t result;
    int rc = pulse_validate(INVALID_PULSE_MISSING_FIELD, &result);

    ck_assert_msg(rc != 0, "pulse_validate() on invalid pulse unexpectedly succeeded");
    ck_assert_msg(result.valid == false, "Result.valid should be false");
    ck_assert_msg(strstr(result.error_msg, "type") != NULL,
                  "Error message should mention the missing field 'type': %s",
                  result.error_msg);
}
END_TEST


START_TEST(test_malformed_json_should_fail_fast)
{
    validation_result_t result;
    int rc = pulse_validate(MALFORMED_JSON, &result);

    ck_assert_int_ne(rc, 0);
    ck_assert(!result.valid);
    ck_assert(strstr(result.error_msg, "JSON") != NULL);
}
END_TEST


START_TEST(test_oversized_payload_is_rejected)
{
    char *large_json = generate_large_json();

    validation_result_t result;
    int rc = pulse_validate(large_json, &result);

    ck_assert_int_ne(rc, 0);
    ck_assert(!result.valid);
    ck_assert(strstr(result.error_msg, "size") != NULL);
}
END_TEST


/* ------------------------------------------------------------------------- */
/* Concurrency & Thread-Safety Tests                                         */
/* ------------------------------------------------------------------------- */

#define THREAD_COUNT    4
#define VALIDATIONS_PER_THREAD  1000

typedef struct {
    const char      *json;
    size_t           iterations;
    size_t           failures;
} thread_args_t;

static void *validation_thread(void *arg)
{
    thread_args_t *args = (thread_args_t *)arg;
    validation_result_t res;

    for (size_t i = 0; i < args->iterations; ++i) {
        if (pulse_validate(args->json, &res) != 0 || !res.valid) {
            args->failures++;
        }
    }
    return NULL;
}

START_TEST(test_pulse_validate_is_thread_safe)
{
    pthread_t threads[THREAD_COUNT];
    thread_args_t targs[THREAD_COUNT];

    /* Spawn worker threads */
    for (int i = 0; i < THREAD_COUNT; ++i) {
        targs[i].json       = VALID_PULSE;
        targs[i].iterations = VALIDATIONS_PER_THREAD;
        targs[i].failures   = 0;

        int rc = pthread_create(&threads[i], NULL, validation_thread, &targs[i]);
        ck_assert_msg(rc == 0, "pthread_create() failed: %s", strerror(rc));
    }

    /* Wait for all threads to finish */
    for (int i = 0; i < THREAD_COUNT; ++i) {
        int rc = pthread_join(threads[i], NULL);
        ck_assert_msg(rc == 0, "pthread_join() failed: %s", strerror(rc));
    }

    /* Ensure no failures were reported by any thread */
    for (int i = 0; i < THREAD_COUNT; ++i) {
        ck_assert_msg(targs[i].failures == 0,
                      "Thread %d encountered %zu validation failures",
                      i, targs[i].failures);
    }
}
END_TEST


/* ------------------------------------------------------------------------- */
/* Test Suite Boilerplate                                                    */
/* ------------------------------------------------------------------------- */

static Suite *validation_suite(void)
{
    Suite *s = suite_create("ValidationService");

    /* Functional group */
    TCase *tc_functional = tcase_create("Functional");
    tcase_add_test(tc_functional, test_valid_pulse_should_pass);
    tcase_add_test(tc_functional, test_missing_mandatory_field_should_fail);
    tcase_add_test(tc_functional, test_malformed_json_should_fail_fast);
    tcase_add_test(tc_functional, test_oversized_payload_is_rejected);
    suite_add_tcase(s, tc_functional);

    /* Concurrency group (runs slower, so allow longer timeout) */
    TCase *tc_concurrency = tcase_create("Concurrency");
    tcase_set_timeout(tc_concurrency, 20.0);   /* seconds */
    tcase_add_test(tc_concurrency, test_pulse_validate_is_thread_safe);
    suite_add_tcase(s, tc_concurrency);

    return s;
}

int main(void)
{
    int number_failed;
    Suite *s       = validation_suite();
    SRunner *sr    = srunner_create(s);

    /* XML output can be enabled via environment variable for CI integration */
    const char *xml_path = getenv("CK_XML_LOG_FILE");
    if (xml_path && *xml_path) {
        srunner_set_xml(sr, xml_path);
    }

    srunner_run_all(sr, CK_ENV);    /* Verbosity controlled by CHECK environment */
    number_failed = srunner_ntests_failed(sr);
    srunner_free(sr);

    return (number_failed == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}