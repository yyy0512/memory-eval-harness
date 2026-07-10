/*
 * aws_client.c
 *
 * LambdaUtility Orchestrator – Common AWS client helpers
 *
 * This module provides a thin, synchronous façade around the (asynchronous)
 * AWS SDK for C.  Each helper function blocks the calling thread until the
 * underlying operation completes or a timeout/alarm is raised.  While AWS
 * Lambda invokes are single-threaded by default, the event-loop group that
 * powers the AWS CRT operates on background threads created by the runtime,
 * so blocking the main thread is acceptable and vastly simplifies the
 * call-sites sprinkled throughout the utility functions.
 *
 * Author:  LambdaUtility Engineering <eng@lambdautility.dev>
 * License: MIT
 */

#include "aws_client.h"

#include <aws/auth/credentials.h>
#include <aws/common/condition_variable.h>
#include <aws/common/device_random.h>
#include <aws/common/string.h>
#include <aws/common/thread.h>
#include <aws/http/connection_manager.h>
#include <aws/io/host_resolver.h>
#include <aws/io/logging.h>
#include <aws/io/socket.h>
#include <aws/s3/s3_client.h>
#include <aws/ssm/ssm_client.h>
#include <aws/cw/cw_client.h>

#include <errno.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---------------------------------------------------------------------------*/
/*  Internal constants                                                         */
/* ---------------------------------------------------------------------------*/

#define AWS_CLIENT_DEFAULT_REGION          "us-east-1"
#define AWS_CLIENT_SDK_INIT_TIMEOUT_SEC    10
#define AWS_CLIENT_SDK_SHUTDOWN_TIMEOUT_SEC 5
#define AWS_CLIENT_OP_TIMEOUT_SEC          30
#define AWS_CLIENT_MAX_BUF_SIZE            (16 * 1024 * 1024) /* 16 MiB */

/* ---------------------------------------------------------------------------*/
/*  Forward declarations                                                       */
/* ---------------------------------------------------------------------------*/

static int  aws_client_bootstrap_init(struct aws_client *client);
static void aws_client_bootstrap_cleanup(struct aws_client *client);

/* ---------------------------------------------------------------------------*/
/*  Public API                                                                 */
/* ---------------------------------------------------------------------------*/

struct aws_client *aws_client_new(void)
{
    struct aws_client *client = AWS_CALLOC(1, sizeof(*client));
    if (!client) {
        return NULL;
    }

    client->allocator = aws_default_allocator();
    aws_mutex_init(&client->lock);
    aws_ref_count_init(&client->refcnt, client, (aws_simple_completion_callback *)aws_client_release);

    /* Initialize CRT logging at INFO unless caller overrode */
    if (!getenv("AWS_CRT_LOG_LEVEL")) {
        aws_logger_set_standard_output(aws_default_allocator(), AWS_LL_INFO);
    }

    if (aws_client_bootstrap_init(client) != AWS_OP_SUCCESS) {
        aws_client_release(client);
        return NULL;
    }

    return client;
}

void aws_client_acquire(struct aws_client *client)
{
    if (!client) { return; }
    aws_ref_count_acquire(&client->refcnt);
}

void aws_client_release(void *user_data)
{
    struct aws_client *client = user_data;
    if (!client) { return; }

    if (aws_ref_count_release(&client->refcnt) == 1) {
        /* Last reference — shut everything down in reverse order */
        aws_client_bootstrap_cleanup(client);

        aws_mutex_clean_up(&client->lock);
        AWS_FREE(client);
    }
}

/* ---------------------------------------------------------------------------*/
/*  SSM PARAMETER STORE HELPER                                                 */
/* ---------------------------------------------------------------------------*/

int aws_client_ssm_get_parameter(struct aws_client       *client,
                                 const char              *param_name,
                                 struct aws_byte_buf     *out_value,
                                 bool                     with_decryption)
{
    if (!client || !param_name || !out_value) {
        return AWS_OP_ERR;
    }

    int ret_code              = AWS_OP_SUCCESS;
    struct aws_allocator *alc = client->allocator;

    /* Create SSM client */
    struct aws_ssm_client_config ssm_cfg = {
        .bootstrap            = &client->bootstrap,
        .tls_ctx              = NULL,
        .region               = aws_byte_cursor_from_c_str(client->region->bytes),
        .credentials_provider = client->cred_provider,
        .allocator            = alc,
    };

    struct aws_ssm_client *ssm = aws_ssm_client_new(alc, &ssm_cfg);
    if (!ssm) {
        AWS_LOGF_ERROR(AWS_LC_GENERAL, "Unable to create SSM client: %s",
                       aws_error_str(aws_last_error()));
        return AWS_OP_ERR;
    }

    /* Synchronisation object */
    struct {
        struct aws_mutex           lock;
        struct aws_condition_variable cvar;
        bool                       finished;
        int                        result;
    } sync = {0};

    aws_mutex_init(&sync.lock);
    aws_condition_variable_init(&sync.cvar);

    /* Build request */
    struct aws_ssm_get_parameter_input input;
    AWS_ZERO_STRUCT(input);

    input.name             = aws_byte_cursor_from_c_str(param_name);
    input.with_decryption  = with_decryption;

    /* Callback */
    void on_ssm_complete(struct aws_ssm_client *SSM_AWS_ATTRIBUTE_UNUSED,
                         int                   error_code,
                         const struct aws_ssm_get_parameter_output *output,
                         void                 *user_data)
    {
        (void)SSM_AWS_ATTRIBUTE_UNUSED;
        struct { struct aws_mutex *lock; struct aws_condition_variable *cvar; bool *finished; int *result; } *state = user_data;

        if (error_code == AWS_ERROR_SUCCESS && output && output->parameter.value.len > 0) {
            /* Copy parameter value into caller-supplied buffer */
            if (aws_byte_buf_init_copy_from_cursor(out_value, alc, output->parameter.value)) {
                error_code = aws_last_error();
            }
        } else {
            error_code = (error_code == AWS_ERROR_SUCCESS) ? AWS_OP_ERR : error_code;
        }

        aws_mutex_lock(state->lock);
        *state->finished = true;
        *state->result   = error_code;
        aws_mutex_unlock(state->lock);
        aws_condition_variable_notify_all(state->cvar);
    }

    if (aws_ssm_client_get_parameter_async(ssm, &input,
                                           on_ssm_complete,
                                           &sync /* user_data */)) {
        ret_code = AWS_OP_ERR;
        goto CLEANUP;
    }

    /* Wait until done or timeout */
    aws_mutex_lock(&sync.lock);
    while (!sync.finished) {
        struct aws_timeval tv;
        tv.tv_sec  = AWS_CLIENT_OP_TIMEOUT_SEC;
        tv.tv_usec = 0;
        int err = aws_condition_variable_wait_pred(
            &sync.cvar,
            &sync.lock,
            aws_relative_time_invalid,
            aws_condition_variable_pred_true,
            &sync.finished);

        if (err) {
            ret_code = err;
            break;
        }
    }
    if (sync.result != AWS_ERROR_SUCCESS) {
        ret_code = sync.result;
    }
    aws_mutex_unlock(&sync.lock);

CLEANUP:
    aws_ssm_client_release(ssm);
    aws_condition_variable_clean_up(&sync.cvar);
    aws_mutex_clean_up(&sync.lock);
    return ret_code;
}

/* ---------------------------------------------------------------------------*/
/*  S3 OBJECT HELPERS                                                          */
/* ---------------------------------------------------------------------------*/

static int s3_wait_for_finish(struct aws_mutex *lock,
                              struct aws_condition_variable *cvar,
                              bool *finished)
{
    aws_mutex_lock(lock);
    while (!*finished) {
        int err = aws_condition_variable_wait(lock, cvar);
        if (err) {
            aws_mutex_unlock(lock);
            return err;
        }
    }
    aws_mutex_unlock(lock);
    return AWS_ERROR_SUCCESS;
}

int aws_client_s3_get_object(struct aws_client   *client,
                             const char          *bucket,
                             const char          *key,
                             struct aws_byte_buf *out_body)
{
    if (!client || !bucket || !key || !out_body) {
        return AWS_OP_ERR;
    }

    struct aws_allocator *alc = client->allocator;
    int rc = AWS_OP_SUCCESS;

    struct aws_s3_client_config s3_cfg = {
        .bootstrap            = &client->bootstrap,
        .tls_ctx              = NULL,
        .signing_config       = NULL, /* default */
        .part_size            = 8 * 1024 * 1024,
        .throughput_target_gbps = 10.0,
        .region               = aws_byte_cursor_from_c_str(client->region->bytes),
        .allocator            = alc,
        .credentials_provider = client->cred_provider,
        .dns_host             = aws_byte_cursor_from_c_str("s3.amazonaws.com"),
    };

    struct aws_s3_client *s3 = aws_s3_client_new(alc, &s3_cfg);
    if (!s3) {
        return aws_last_error();
    }

    struct aws_byte_buf buffer;
    if (aws_byte_buf_init(&buffer, alc, AWS_CLIENT_MAX_BUF_SIZE)) {
        aws_s3_client_release(s3);
        return aws_last_error();
    }

    /* Synchronisation for async completion */
    struct {
        struct aws_mutex            lock;
        struct aws_condition_variable cvar;
        bool                        done;
        int                         result;
    } sync = {0};

    aws_mutex_init(&sync.lock);
    aws_condition_variable_init(&sync.cvar);

    /* Callback that streams each chunk */
    void on_body(void *user_data,
                 const struct aws_byte_cursor *chunk)
    {
        struct aws_byte_buf *dst = user_data;
        aws_byte_buf_append_dynamic(dst, chunk);
    }

    /* Completion callback */
    void on_finished(struct aws_s3_request *req, int error_code, void *userdata)
    {
        (void)req;
        struct { struct aws_mutex *lock; struct aws_condition_variable *cvar; bool *done; int *result; } *state = userdata;
        aws_mutex_lock(state->lock);
        *state->done   = true;
        *state->result = error_code;
        aws_mutex_unlock(state->lock);
        aws_condition_variable_notify_one(state->cvar);
    }

    /* Create request */
    struct aws_s3_get_object_request_options opts = {
        .bucket         = aws_byte_cursor_from_c_str(bucket),
        .key            = aws_byte_cursor_from_c_str(key),
        .range_start    = 0,
        .range_end      = 0,
        .part_size      = 8 * 1024 * 1024,
        .callback       = on_body,
        .callback_userdata = &buffer,
        .finished_fn    = on_finished,
        .finished_userdata = &sync,
    };

    struct aws_s3_request *request = aws_s3_client_make_get_object_request(s3, &opts);
    if (!request) {
        rc = aws_last_error();
        goto DONE;
    }

    if (aws_s3_client_queue_request(s3, request)) {
        rc = aws_last_error();
        goto DONE;
    }

    rc = s3_wait_for_finish(&sync.lock, &sync.cvar, &sync.done);
    if (rc == AWS_ERROR_SUCCESS && sync.result != AWS_ERROR_SUCCESS) {
        rc = sync.result;
    }

DONE:
    if (rc == AWS_ERROR_SUCCESS) {
        *out_body = buffer; /* transfer ownership */
    } else {
        aws_byte_buf_clean_up(&buffer);
    }

    aws_s3_client_release(s3);
    aws_condition_variable_clean_up(&sync.cvar);
    aws_mutex_clean_up(&sync.lock);

    return rc;
}

int aws_client_s3_put_object(struct aws_client       *client,
                             const char              *bucket,
                             const char              *key,
                             const struct aws_byte_buf *body)
{
    if (!client || !bucket || !key || !body) {
        return AWS_OP_ERR;
    }

    struct aws_allocator *alc = client->allocator;
    int rc = AWS_OP_SUCCESS;

    struct aws_s3_client_config s3_cfg = {
        .bootstrap            = &client->bootstrap,
        .tls_ctx              = NULL,
        .signing_config       = NULL,
        .part_size            = 8 * 1024 * 1024,
        .throughput_target_gbps = 10.0,
        .region               = aws_byte_cursor_from_c_str(client->region->bytes),
        .allocator            = alc,
        .credentials_provider = client->cred_provider,
        .dns_host             = aws_byte_cursor_from_c_str("s3.amazonaws.com"),
    };

    struct aws_s3_client *s3 = aws_s3_client_new(alc, &s3_cfg);
    if (!s3) {
        return aws_last_error();
    }

    /* Synchronisation object */
    struct {
        struct aws_mutex            lock;
        struct aws_condition_variable cvar;
        bool                        done;
        int                         result;
    } sync = {0};

    aws_mutex_init(&sync.lock);
    aws_condition_variable_init(&sync.cvar);

    /* Body stream callbacks */
    struct aws_input_stream *input_stream =
        aws_input_stream_new_from_cursor(alc, &(struct aws_byte_cursor){ .ptr = body->buffer, .len = body->len });

    /* Completion callback */
    void on_finished(struct aws_s3_request *req, int error_code, void *userdata)
    {
        (void)req;
        struct { struct aws_mutex *lock; struct aws_condition_variable *cvar; bool *done; int *result; } *state = userdata;
        aws_mutex_lock(state->lock);
        *state->done   = true;
        *state->result = error_code;
        aws_mutex_unlock(state->lock);
        aws_condition_variable_notify_one(state->cvar);
    }

    struct aws_s3_put_object_request_options opts = {
        .bucket              = aws_byte_cursor_from_c_str(bucket),
        .key                 = aws_byte_cursor_from_c_str(key),
        .body                = input_stream,
        .content_length      = body->len,
        .finished_fn         = on_finished,
        .finished_userdata   = &sync,
    };

    struct aws_s3_request *request = aws_s3_client_make_put_object_request(s3, &opts);
    if (!request) {
        rc = aws_last_error();
        goto CLEANUP_STREAM;
    }

    if (aws_s3_client_queue_request(s3, request)) {
        rc = aws_last_error();
        goto CLEANUP_STREAM;
    }

    rc = s3_wait_for_finish(&sync.lock, &sync.cvar, &sync.done);
    if (rc == AWS_ERROR_SUCCESS && sync.result != AWS_ERROR_SUCCESS) {
        rc = sync.result;
    }

CLEANUP_STREAM:
    aws_input_stream_destroy(input_stream);
    aws_s3_client_release(s3);
    aws_condition_variable_clean_up(&sync.cvar);
    aws_mutex_clean_up(&sync.lock);
    return rc;
}

/* ---------------------------------------------------------------------------*/
/*  CLOUDWATCH METRICS                                                         */
/* ---------------------------------------------------------------------------*/

int aws_client_cw_put_metric(struct aws_client *client,
                             const char        *namespace,
                             const char        *metric_name,
                             double             value,
                             const char        *unit)
{
    if (!client || !namespace || !metric_name || !unit) {
        return AWS_OP_ERR;
    }

    struct aws_allocator *alc = client->allocator;
    int rc = AWS_ERROR_SUCCESS;

    struct aws_cw_client_config cw_cfg = {
        .bootstrap            = &client->bootstrap,
        .region               = aws_byte_cursor_from_c_str(client->region->bytes),
        .credentials_provider = client->cred_provider,
        .allocator            = alc,
    };

    struct aws_cw_client *cw = aws_cw_client_new(alc, &cw_cfg);
    if (!cw) {
        return aws_last_error();
    }

    struct aws_cw_put_metric_data_input input;
    AWS_ZERO_STRUCT(input);
    input.namespace = aws_byte_cursor_from_c_str(namespace);

    struct aws_cw_metric_datum datum;
    AWS_ZERO_STRUCT(datum);

    datum.metric_name = aws_byte_cursor_from_c_str(metric_name);
    datum.value       = value;
    datum.unit        = aws_byte_cursor_from_c_str(unit);

    input.metric_data = &datum;
    input.metric_data_count = 1;

    /* Sync object */
    struct {
        struct aws_mutex               lock;
        struct aws_condition_variable  cvar;
        bool                           done;
        int                            result;
    } sync = {0};

    aws_mutex_init(&sync.lock);
    aws_condition_variable_init(&sync.cvar);

    void on_finish(struct aws_cw_client *CW_AWS_ATTRIBUTE_UNUSED,
                   int                   error_code,
                   const struct aws_cw_put_metric_data_output *AWS_ATTRIBUTE_UNUSED,
                   void                 *userdata)
    {
        (void)CW_AWS_ATTRIBUTE_UNUSED;
        (void)AWS_ATTRIBUTE_UNUSED;
        struct { struct aws_mutex *lock; struct aws_condition_variable *cvar; bool *done; int *result; } *state = userdata;
        aws_mutex_lock(state->lock);
        *state->done   = true;
        *state->result = error_code;
        aws_mutex_unlock(state->lock);
        aws_condition_variable_notify_one(state->cvar);
    }

    if (aws_cw_client_put_metric_data_async(cw, &input, on_finish, &sync)) {
        rc = aws_last_error();
        goto CLEANUP;
    }

    rc = s3_wait_for_finish(&sync.lock, &sync.cvar, &sync.done);
    if (rc == AWS_ERROR_SUCCESS && sync.result != AWS_ERROR_SUCCESS) {
        rc = sync.result;
    }

CLEANUP:
    aws_cw_client_release(cw);
    aws_condition_variable_clean_up(&sync.cvar);
    aws_mutex_clean_up(&sync.lock);

    return rc;
}

/* ---------------------------------------------------------------------------*/
/*  Internal helpers                                                           */
/* ---------------------------------------------------------------------------*/

static int aws_client_bootstrap_init(struct aws_client *client)
{
    struct aws_allocator *alc = client->allocator;

    /* determine region */
    const char *env_region = getenv("AWS_REGION");
    const char *region_str = env_region ? env_region : AWS_CLIENT_DEFAULT_REGION;

    client->region = aws_string_new_from_c_str(alc, region_str);
    if (!client->region) {
        return aws_last_error();
    }

    /* one global IO subsystem per process */
    struct aws_io_library_init_options io_options = { .allocator = alc };
    if (aws_io_library_init(&io_options)) {
        return aws_last_error();
    }

    aws_event_loop_group_default_init(&client->el_group, 0, alc);

    if (aws_host_resolver_init_default(&client->host_resolver,
                                       alc,
                                       64,
                                       &client->el_group)) {
        return aws_last_error();
    }

    if (aws_client_bootstrap_init_default(&client->bootstrap,
                                          alc,
                                          &client->el_group,
                                          &client->host_resolver,
                                          NULL /* ALPN */,
                                          NULL /* proxy_options */)) {
        return aws_last_error();
    }

    /* Default credential provider chain – Lambda will inject */
    client->cred_provider = aws_credentials_provider_new_default(alc);
    if (!client->cred_provider) {
        return aws_last_error();
    }

    return AWS_ERROR_SUCCESS;
}

static void aws_client_bootstrap_cleanup(struct aws_client *client)
{
    if (!client) { return; }

    if (client->cred_provider) {
        aws_credentials_provider_release(client->cred_provider);
    }

    aws_client_bootstrap_clean_up(&client->bootstrap);
    aws_host_resolver_clean_up(&client->host_resolver);
    aws_event_loop_group_default_clean_up(&client->el_group);
    aws_string_destroy(client->region);

    aws_io_library_clean_up();
}

/* ---------------------------------------------------------------------------*/
/*  End of file                                                                */
/* ---------------------------------------------------------------------------*/