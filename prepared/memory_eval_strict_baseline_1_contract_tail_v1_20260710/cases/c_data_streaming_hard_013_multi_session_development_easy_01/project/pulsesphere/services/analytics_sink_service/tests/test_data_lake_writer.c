/*
 * PulseSphere : Analytics Sink Service
 * ------------------------------------
 * Unit-tests for the Data-Lake writer component.
 *
 * The Data-Lake writer (dl_writer) is responsible for persisting curated,
 * enrichment-complete “pulse events” into the cold-storage lake (e.g. S3,
 * HDFS, lakeFS).  It batches events in-memory, flushes on either a size or
 * time threshold, and implements an exponential back-off retry strategy on
 * transient I/O failures.
 *
 * These tests exercise the public interface while mocking the underlying
 * storage connector so that no real network or disk traffic occurs.
 *
 * Build (example):
 *   gcc -std=c11 -Wall -Wextra -Werror -pthread \
 *       -I../../include \
 *       test_data_lake_writer.c \
 *       -lcmocka -o test_data_lake_writer
 */

#include <stdarg.h>
#include <stddef.h>
#include <setjmp.h>
#include <cmocka.h>

#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include <stdlib.h>

/* -------------------------------------------------------------------------
 * Project headers (public API under test)
 * ------------------------------------------------------------------------- */
#include "analytics_sink/data_lake_writer.h"   /* dl_writer_… symbols          */
#include "core/pulse_event.h"                  /* pulse_event_t               */
#include "core/error_codes.h"                  /* PS_ERR_…                    */

/* -------------------------------------------------------------------------
 * Mocks for the storage connector
 * -------------------------------------------------------------------------
 * dl_writer internally uses the storage connector’s C API:
 *
 *   int sl_conn_open   (sl_conn_t **conn, const char *uri);
 *   int sl_conn_write  (sl_conn_t  *conn, const void *buf, size_t len);
 *   int sl_conn_flush  (sl_conn_t  *conn);
 *   int sl_conn_close  (sl_conn_t **conn);
 *
 * This test-file provides link-time replacements for those symbols which
 * delegate to cmocka’s mock() to allow behaviour injection from each test.
 * ------------------------------------------------------------------------- */

typedef struct sl_conn { int dummy; } sl_conn_t;

/* clang-format off */
int sl_conn_open(sl_conn_t **conn, const char *uri)
{
    check_expected_ptr(uri);
    /* emulate allocation so writer sees non-NULL handle */
    *conn = (sl_conn_t *)mock_ptr_type(sl_conn_t *);
    return mock_type(int);
}

int sl_conn_write(sl_conn_t *conn, const void *buf, size_t len)
{
    check_expected_ptr(conn);
    check_expected(buf);      /* Value is opaque, only address validated      */
    check_expected(len);

    return mock_type(int);
}

int sl_conn_flush(sl_conn_t *conn)
{
    check_expected_ptr(conn);
    return mock_type(int);
}

int sl_conn_close(sl_conn_t **conn)
{
    check_expected_ptr(*conn); /* Verify handle passed is the same            */
    /* Simulate deallocation */
    *conn = NULL;
    return mock_type(int);
}
/* clang-format on */

/* -------------------------------------------------------------------------
 * Test fixtures
 * ------------------------------------------------------------------------- */

/* A canonical, syntactically valid pulse event used by several tests. */
static const pulse_event_t kValidPulse = {
    .ts_epoch_ms  = 1667853990123,
    .user_id      = "user_42",
    .network      = "chirper",
    .type         = "reaction",
    .payload_json = "{\"emoji\":\"🚀\"}"
};

static const dl_writer_config_t kDefaultCfg = {
    .endpoint_uri       = "s3://lake/pulses/",
    .max_buffered_events= 256,
    .flush_interval_ms  = 250,
    .max_retry          = 3
};

/* -------------------------------------------------------------------------
 * Helper utilities
 * ------------------------------------------------------------------------- */

/* Allocate a fake storage connector handle to return from sl_conn_open(). */
static sl_conn_t *allocate_fake_handle(void)
{
    sl_conn_t *handle = (sl_conn_t *)malloc(sizeof(sl_conn_t));
    assert_non_null(handle);
    return handle;
}

/* -------------------------------------------------------------------------
 * Individual unit tests
 * ------------------------------------------------------------------------- */

/* Happy-path initialisation: open succeeds, writer instance is returned. */
static void test_writer_initialisation_success(void **state)
{
    (void)state;

    /* Configure expected interaction with connector open. */
    expect_string(sl_conn_open, uri, kDefaultCfg.endpoint_uri);
    will_return(sl_conn_open, allocate_fake_handle());
    will_return(sl_conn_open, 0);

    dl_writer_t *writer = NULL;
    assert_int_equal(dl_writer_create(&kDefaultCfg, &writer), 0);
    assert_non_null(writer);

    /* Close expectations */
    expect_value(sl_conn_close, conn, writer); /* internal handle == writer   */
    will_return(sl_conn_close, 0);

    dl_writer_destroy(&writer);
    assert_null(writer);
}

/* When connector open fails writer_create must fail gracefully. */
static void test_writer_initialisation_failure(void **state)
{
    (void)state;

    expect_string(sl_conn_open, uri, kDefaultCfg.endpoint_uri);
    will_return(sl_conn_open, (sl_conn_t *)NULL);
    will_return(sl_conn_open, PS_ERR_CONNECT);

    dl_writer_t *writer = NULL;
    assert_int_equal(dl_writer_create(&kDefaultCfg, &writer),
                     PS_ERR_CONNECT);
    assert_null(writer);
}

/* Verify a single event write triggers storage write with correct length. */
static void test_writer_single_write_success(void **state)
{
    (void)state;

    /* open() sequence */
    expect_string(sl_conn_open, uri, kDefaultCfg.endpoint_uri);
    will_return(sl_conn_open, allocate_fake_handle());
    will_return(sl_conn_open, 0);

    dl_writer_t *writer = NULL;
    assert_int_equal(dl_writer_create(&kDefaultCfg, &writer), 0);

    /* write() expectations */
    expect_any(sl_conn_write, conn);
    expect_any(sl_conn_write, buf);
    expect_value(sl_conn_write, len, strlen(kValidPulse.payload_json));
    will_return(sl_conn_write, 0);

    assert_int_equal(dl_writer_write(writer, &kValidPulse), 0);

    /* flush() expected (due to explicit call) */
    expect_any(sl_conn_flush, conn);
    will_return(sl_conn_flush, 0);
    assert_int_equal(dl_writer_flush(writer), 0);

    /* destroy() */
    expect_value(sl_conn_close, conn, writer);
    will_return(sl_conn_close, 0);
    dl_writer_destroy(&writer);
}

/* Inject a connector write failure followed by a successful retry.  The
 * writer must retry transparently and ultimately return success to caller. */
static void test_writer_retry_on_transient_failure(void **state)
{
    (void)state;

    /* open() */
    expect_string(sl_conn_open, uri, kDefaultCfg.endpoint_uri);
    will_return(sl_conn_open, allocate_fake_handle());
    will_return(sl_conn_open, 0);

    dl_writer_t *writer = NULL;
    assert_int_equal(dl_writer_create(&kDefaultCfg, &writer), 0);

    /* First write attempt fails */
    expect_any(sl_conn_write, conn);
    expect_any(sl_conn_write, buf);
    expect_any(sl_conn_write, len);
    will_return(sl_conn_write, PS_ERR_IO);

    /* Second (retry) succeeds */
    expect_any(sl_conn_write, conn);
    expect_any(sl_conn_write, buf);
    expect_any(sl_conn_write, len);
    will_return(sl_conn_write, 0);

    assert_int_equal(dl_writer_write(writer, &kValidPulse), 0);

    /* Tear-down */
    expect_any(sl_conn_flush, conn);
    will_return(sl_conn_flush, 0);

    expect_value(sl_conn_close, conn, writer);
    will_return(sl_conn_close, 0);
    dl_writer_destroy(&writer);
}

/* -------------------------------------------------------------------------
 * Concurrency test : multiple threads call dl_writer_write concurrently.
 * We ensure dl_writer remains thread-safe and no writes fail.
 * ------------------------------------------------------------------------- */

#define THREAD_COUNT    8
#define ITERATIONS      4096

typedef struct thread_args
{
    dl_writer_t  *writer;
    _Atomic int  failures;
} thread_args_t;

static void *writer_thread_fn(void *arg)
{
    thread_args_t *ctx = (thread_args_t *)arg;

    for (int i = 0; i < ITERATIONS; ++i)
        if (dl_writer_write(ctx->writer, &kValidPulse) != 0)
            atomic_fetch_add(&ctx->failures, 1);

    return NULL;
}

static void test_writer_thread_safety(void **state)
{
    (void)state;

    /* Expectations for open() */
    expect_string(sl_conn_open, uri, kDefaultCfg.endpoint_uri);
    will_return(sl_conn_open, allocate_fake_handle());
    will_return(sl_conn_open, 0);

    dl_writer_t *writer = NULL;
    assert_int_equal(dl_writer_create(&kDefaultCfg, &writer), 0);

    /*
     * The internal batching algorithm should perform at most THREAD_COUNT *
     * ITERATIONS writes; we loosen expectations by allowing any number of
     * actual connector writes.  Override sl_conn_write mock to always succeed.
     */
    will_return_always(sl_conn_write, 0);
    /* Accept any parameters */
    expect_any_count(sl_conn_write, conn, 0);
    expect_any_count(sl_conn_write, buf, 0);
    expect_any_count(sl_conn_write, len, 0);

    /* Similarly, flush() may be called arbitrarily. */
    will_return_always(sl_conn_flush, 0);
    expect_any_count(sl_conn_flush, conn, 0);

    pthread_t    tids[THREAD_COUNT];
    thread_args_t ctx = { .writer = writer, .failures = 0 };

    for (int i = 0; i < THREAD_COUNT; ++i)
        assert_int_equal(pthread_create(&tids[i], NULL,
                                        writer_thread_fn, &ctx), 0);

    for (int i = 0; i < THREAD_COUNT; ++i)
        pthread_join(tids[i], NULL);

    /* No failures expected. */
    assert_int_equal(atomic_load(&ctx.failures), 0);

    /* Final flush by caller */
    assert_int_equal(dl_writer_flush(writer), 0);

    /* destroy() */
    expect_value(sl_conn_close, conn, writer);
    will_return(sl_conn_close, 0);
    dl_writer_destroy(&writer);
}

/* -------------------------------------------------------------------------
 * Test runner
 * ------------------------------------------------------------------------- */

int main(void)
{
    const struct CMUnitTest tests[] = {
        cmocka_unit_test(test_writer_initialisation_success),
        cmocka_unit_test(test_writer_initialisation_failure),
        cmocka_unit_test(test_writer_single_write_success),
        cmocka_unit_test(test_writer_retry_on_transient_failure),
        cmocka_unit_test(test_writer_thread_safety),
    };

    return cmocka_run_group_tests(tests, NULL, NULL);
}