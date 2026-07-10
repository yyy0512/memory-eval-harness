/*
 * LambdaUtility Orchestrator
 * ==========================
 * File: src/lib/common/aws_client.h
 *
 * Copyright (c) 2024 DevOps
 *
 * A thin, opinionated wrapper around the AWS CRT C-SDK that hides the
 * initialization / shutdown boiler-plate and offers a synchronous, errno-style
 * interface to a subset of AWS services frequently used by the Orchestrator:
 *  - Amazon Simple Storage Service (S3)
 *  - AWS Systems Manager Parameter Store (SSM)
 *  - Amazon Simple Notification Service (SNS)
 *  - Amazon CloudWatch Metrics & Logs
 *
 * The wrapper purposefully targets short-lived Lambda invocations and assumes
 * single-threaded usage.  Functions are re-entrant but not thread-safe unless
 * explicitly documented otherwise.
 *
 * Build Dependencies
 * ------------------
 *  - AWS Common Runtime (CRT) SDK
 *      * aws-c-common
 *      * aws-c-io
 *      * aws-c-http
 *      * aws-c-auth
 *      * aws-c-cal
 *      * aws-c-s3
 *
 *  - C11 compliant compiler
 *
 * Public API
 * ----------
 *  int  aws_client_global_init(const char *region);
 *  void aws_client_global_cleanup(void);
 *
 *  int  aws_client_s3_put_object(const char *bucket,
 *                                const char *key,
 *                                const uint8_t *data,
 *                                size_t len,
 *                                const char *content_type);
 *
 *  int  aws_client_ssm_get_parameter(const char *name,
 *                                    bool with_decryption,
 *                                    char *buf,
 *                                    size_t *inout_len);
 *
 *  int  aws_client_sns_publish(const char *topic_arn,
 *                              const char *subject,
 *                              const char *message);
 *
 *  int  aws_client_cw_put_metric(const char *ns,
 *                                const char *metric_name,
 *                                double value,
 *                                const char *unit,
 *                                const char *dim_name,
 *                                const char *dim_value);
 *
 *  int  aws_client_last_error(void);
 *
 * All functions return 0 on success or -1 on failure with errno and the
 * underlying AWS error code retrievable through aws_client_last_error().
 */

#ifndef LUO_COMMON_AWS_CLIENT_H
#define LUO_COMMON_AWS_CLIENT_H

/*---------------------------------------------------------------------*/
/*                              Includes                               */
/*---------------------------------------------------------------------*/
#include <aws/common/common.h>
#include <aws/io/event_loop.h>
#include <aws/io/host_resolver.h>
#include <aws/io/channel_bootstrap.h>
#include <aws/auth/credentials.h>
#include <aws/http/connection.h>
#include <aws/s3/s3_client.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*---------------------------------------------------------------------*/
/*                         Macro / Const. helpers                      */
/*---------------------------------------------------------------------*/

/* Maximum length for small, temporary string buffers.                 */
#define AWS_CLIENT_SMALL_BUF   256U

/* Receive buffer size when downloading small parameters from SSM.     */
#define AWS_CLIENT_SSM_BUF_SZ  4096U

/*---------------------------------------------------------------------*/
/*                           Public  Types                             */
/*---------------------------------------------------------------------*/

/* Opaque handle that owns the AWS CRT runtime.  */
typedef struct aws_client_context {
    struct aws_allocator           *alloc;          /* Memory allocator */
    struct aws_event_loop_group    *el_group;       /* IO event loop    */
    struct aws_host_resolver       *resolver;       /* DNS resolver     */
    struct aws_client_bootstrap    *bootstrap;      /* Channel bootstrap*/
    struct aws_credentials_provider *creds;         /* Cred provider    */
    struct aws_byte_cursor          region;         /* Region cursor    */
} aws_client_context_t;

/*---------------------------------------------------------------------*/
/*                           Public  API                               */
/*---------------------------------------------------------------------*/

/**
 * Initialise the global AWS CRT environment and default networking stack.
 *
 * @param region  The AWS region (e.g., "us-east-1") to use for all
 *                subsequent requests.  The string is copied internally.
 *
 * @return 0 on success, -1 on failure with errno set.
 */
int
aws_client_global_init(const char *region);

/**
 * Releases all resources allocated by aws_client_global_init().
 *
 * The call is idempotent; multiple invocations have no side-effects after the
 * first successful cleanup.
 */
void
aws_client_global_cleanup(void);

/**
 * Upload an object to Amazon S3 synchronously.
 *
 * @param bucket        Target bucket name (without s3:// prefix).
 * @param key           Key inside the bucket.
 * @param data          Pointer to the object bytes.  May be NULL if len == 0.
 * @param len           Length of the object in bytes.
 * @param content_type  A MIME type, e.g., "application/json".  May be NULL.
 *
 * @return 0 on success, -1 on failure.
 */
int
aws_client_s3_put_object(const char *bucket,
                         const char *key,
                         const uint8_t *data,
                         size_t len,
                         const char *content_type);

/**
 * Fetch a Parameter Store value into the caller-supplied buffer.
 *
 * @param name             Fully-qualified parameter name (e.g., "/app/db/pw").
 * @param with_decryption  When true, secure-string parameters are decrypted.
 * @param buf              Destination buffer to receive the UTF-8 value.
 * @param inout_len        Supply the buffer length; returns required length.
 *
 * @return 0 on success, -1 on error (including insufficient buffer space).
 *         In case of -1 and errno == ENOBUFS, the required length is
 *         returned in *inout_len so the caller can retry.
 */
int
aws_client_ssm_get_parameter(const char *name,
                             bool with_decryption,
                             char *buf,
                             size_t *inout_len);

/**
 * Publish a message to an SNS topic.
 *
 * @param topic_arn  Target topic ARN.
 * @param subject    Optional subject line (may be NULL).
 * @param message    Message payload (UTF-8).
 *
 * @return 0 on success, -1 otherwise.
 */
int
aws_client_sns_publish(const char *topic_arn,
                       const char *subject,
                       const char *message);

/**
 * Send a single custom metric to CloudWatch.
 *
 * @param ns           Metric namespace (e.g., "LambdaUtility/Deployments").
 * @param metric_name  Dimension-less metric name.
 * @param value        Metric value (double).
 * @param unit         Unit of measure as defined by AWS docs (e.g., "Count").
 * @param dim_name     Dimension name (nullable -> no dimensions).
 * @param dim_value    Dimension value (must accompany dim_name).
 *
 * @return 0 on success, -1 on failure.
 */
int
aws_client_cw_put_metric(const char *ns,
                         const char *metric_name,
                         double value,
                         const char *unit,
                         const char *dim_name,
                         const char *dim_value);

/**
 * Retrieve the last error emitted by the AWS CRT libraries.  If no error has
 * occurred since the last successful API call, zero is returned.
 */
int
aws_client_last_error(void);

/*---------------------------------------------------------------------*/
/*                         Internal  Helpers                           */
/*---------------------------------------------------------------------*/
#ifdef AWS_CLIENT_IMPLEMENTATION
/* NOTE:
 *   Implementation section.  Defining AWS_CLIENT_IMPLEMENTATION in *exactly
 *   one* translation unit will emit the function bodies below, turning this
 *   header into a single-translation-unit library (a.k.a. header-only).  This
 *   avoids the need for a separate `.c` compilation unit in deeply embedded
 *   Lambda builds where reducing file count simplifies build systems.
 *
 *   Other translation units should include this header *without* defining
 *   AWS_CLIENT_IMPLEMENTATION.
 */
#include <aws/common/byte_buf.h>
#include <aws/http/request_response.h>
#include <aws/http/proxy.h>
#include <aws/http/status_code.h>
#include <aws/s3/s3_client.h>
#include <aws/s3/s3.h>
#include <aws/http/connection_manager.h>
#include <errno.h>
#include <string.h>

static aws_client_context_t g_ctx = {0};
static int                   g_last_error = 0;

/* Forward declarations for static helpers */
static int  _aws_client_bootstrap(const char *region);
static void _aws_client_set_error(int aws_err);

/*---------------------------------------------------------------------*/
/*                              Public API                             */
/*---------------------------------------------------------------------*/
int
aws_client_global_init(const char *region)
{
    if (g_ctx.bootstrap) {
        /* Already initialised */
        return 0;
    }

    if (!region) {
        errno = EINVAL;
        return -1;
    }

    if (_aws_client_bootstrap(region) != 0) {
        /* errno set by helper */
        return -1;
    }

    return 0;
}

void
aws_client_global_cleanup(void)
{
    if (!g_ctx.bootstrap) {
        return;
    }

    aws_credentials_provider_release(g_ctx.creds);
    aws_client_bootstrap_release(g_ctx.bootstrap);
    aws_host_resolver_release(g_ctx.resolver);
    aws_event_loop_group_release(g_ctx.el_group);

    g_ctx = (aws_client_context_t){0};
}

static void
_aws_client_set_error(int aws_err)
{
    g_last_error = aws_err;
    errno        = EIO;
}

int
aws_client_last_error(void)
{
    return g_last_error;
}

/*---------------------------------------------------------------------*/
/*                       Service-specific helpers                      */
/*---------------------------------------------------------------------*/
static int
_aws_client_bootstrap(const char *region_str)
{
    int ret = 0;

    g_ctx.alloc = aws_default_allocator();

    /* Create event loop group (single-threaded for Lambda) */
    struct aws_event_loop_group_default_options elg_opts = {
        .allocator = g_ctx.alloc,
        .max_threads = 1,
    };

    g_ctx.el_group = aws_event_loop_group_new_default(&elg_opts);
    if (!g_ctx.el_group) {
        _aws_client_set_error(aws_last_error());
        return -1;
    }

    /* DNS */
    struct aws_host_resolver_default_options resolver_opts = {
        .allocator = g_ctx.alloc,
        .el_group  = g_ctx.el_group,
        .max_entries = 8,
    };

    g_ctx.resolver = aws_host_resolver_new_default(g_ctx.alloc, &resolver_opts);
    if (!g_ctx.resolver) {
        _aws_client_set_error(aws_last_error());
        ret = -1;
        goto fail_elg;
    }

    /* Bootstrap */
    struct aws_client_bootstrap_options bs_opts = {
        .event_loop_group = g_ctx.el_group,
        .host_resolver    = g_ctx.resolver,
        .allocator        = g_ctx.alloc,
    };

    g_ctx.bootstrap = aws_client_bootstrap_new(g_ctx.alloc, &bs_opts);
    if (!g_ctx.bootstrap) {
        _aws_client_set_error(aws_last_error());
        ret = -1;
        goto fail_resolver;
    }

    /* Credentials */
    struct aws_credentials_provider_chain_default_options cp_opts = {
        .bootstrap = g_ctx.bootstrap,
        .allocator = g_ctx.alloc,
    };

    g_ctx.creds = aws_credentials_provider_new_chain_default(&cp_opts);
    if (!g_ctx.creds) {
        _aws_client_set_error(aws_last_error());
        ret = -1;
        goto fail_bootstrap;
    }

    /* Save region */
    struct aws_byte_cursor region_cur = aws_byte_cursor_from_c_str(region_str);
    if (aws_byte_buf_init_copy_from_cursor(&g_ctx.region, g_ctx.alloc, region_cur) != AWS_OP_SUCCESS) {
        _aws_client_set_error(aws_last_error());
        ret = -1;
        goto fail_creds;
    }

    return 0;

/* error handling */
fail_creds:
    aws_credentials_provider_release(g_ctx.creds);
fail_bootstrap:
    aws_client_bootstrap_release(g_ctx.bootstrap);
fail_resolver:
    aws_host_resolver_release(g_ctx.resolver);
fail_elg:
    aws_event_loop_group_release(g_ctx.el_group);
    g_ctx = (aws_client_context_t){0};
    return ret;
}

/*---------------------------------------------------------------------*/
/*                            S3  Helpers                              */
/*---------------------------------------------------------------------*/
int
aws_client_s3_put_object(const char *bucket,
                         const char *key,
                         const uint8_t *data,
                         size_t len,
                         const char *content_type)
{
    if (!bucket || !key) {
        errno = EINVAL;
        return -1;
    }

    /* Build a single-shot S3 client for the call               */
    struct aws_s3_client_config s3_cfg = {
        .allocator       = g_ctx.alloc,
        .client_bootstrap = g_ctx.bootstrap,
        .region          = aws_byte_cursor_from_array(g_ctx.region.buffer, g_ctx.region.len),
        .credentials_provider = g_ctx.creds,
        .part_size       = len,          /* one part upload      */
        .max_connections = 1,
    };

    struct aws_s3_client *s3_client = aws_s3_client_new(g_ctx.alloc, &s3_cfg);
    if (!s3_client) {
        _aws_client_set_error(aws_last_error());
        return -1;
    }

    /* Prepare put request */
    struct aws_byte_cursor bucket_cur = aws_byte_cursor_from_c_str(bucket);
    struct aws_byte_cursor key_cur    = aws_byte_cursor_from_c_str(key);
    struct aws_byte_cursor data_cur   = aws_byte_cursor_from_array(data, len);
    struct aws_byte_cursor ct_cur     = content_type ? aws_byte_cursor_from_c_str(content_type)
                                                    : aws_byte_cursor_from_c_str("application/octet-stream");

    struct aws_s3_put_object_info put_info = {
        .bucket = bucket_cur,
        .key    = key_cur,
        .body   = data_cur,
        .content_type = ct_cur,
    };

    int ret = 0;
    struct aws_s3_put_object_result put_result;

    if (aws_s3_client_put_object(s3_client, &put_info, &put_result) != AWS_OP_SUCCESS) {
        _aws_client_set_error(aws_last_error());
        ret = -1;
    }

    aws_s3_client_release(s3_client);
    return ret;
}

/*---------------------------------------------------------------------*/
/*                       SSM Parameter Store                           */
/*---------------------------------------------------------------------*/

int
aws_client_ssm_get_parameter(const char *name,
                             bool with_decryption,
                             char *buf,
                             size_t *inout_len)
{
    /* The CRT SDK currently lacks a dedicated SSM helper.  We therefore
     * issue a SigV4-signed HTTPS request manually.  To keep this example
     * concise, we omit the raw HTTP implementation and bail out with ENOSYS.
     */
    (void)name;
    (void)with_decryption;
    (void)buf;
    (void)inout_len;

    errno = ENOSYS;
    return -1;
}

/*---------------------------------------------------------------------*/
/*                         Amazon SNS Publish                          */
/*---------------------------------------------------------------------*/
int
aws_client_sns_publish(const char *topic_arn,
                       const char *subject,
                       const char *message)
{
    /* Similar to SSM, a convenience wrapper is not (yet) part of the CRT
     * stack; implementers should use aws_signing_sign_request() + HTTP API.
     * Stubbed for now.
     */
    (void)topic_arn;
    (void)subject;
    (void)message;

    errno = ENOSYS;
    return -1;
}

/*---------------------------------------------------------------------*/
/*                       CloudWatch PutMetric                          */
/*---------------------------------------------------------------------*/
int
aws_client_cw_put_metric(const char *ns,
                         const char *metric_name,
                         double value,
                         const char *unit,
                         const char *dim_name,
                         const char *dim_value)
{
    (void)ns;
    (void)metric_name;
    (void)value;
    (void)unit;
    (void)dim_name;
    (void)dim_value;

    errno = ENOSYS;
    return -1;
}

#endif /* AWS_CLIENT_IMPLEMENTATION */

/*---------------------------------------------------------------------*/
#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* LUO_COMMON_AWS_CLIENT_H */
