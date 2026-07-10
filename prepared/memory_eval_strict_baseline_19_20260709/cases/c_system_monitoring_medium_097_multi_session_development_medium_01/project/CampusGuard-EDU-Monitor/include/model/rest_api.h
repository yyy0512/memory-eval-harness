/*
 * CampusGuard EDU Monitor
 * File: include/model/rest_api.h
 *
 * Description:
 *   Internal REST client used by the Model layer to expose / consume
 *   monitoring data via an HTTP-based interface.  Wrapper around libcurl
 *   that provides a thin and _thread-safe_ abstraction for performing
 *   JSON-centric REST requests (GET/POST/PUT/PATCH/DELETE) with bearer-token
 *   authentication, automatic retry, and error handling.
 *
 * Licensing:
 *   Copyright (c) 2024 University-XYZ
 *   SPDX-License-Identifier: MIT
 */

#ifndef CG_EDU_MONITOR_MODEL_REST_API_H
#define CG_EDU_MONITOR_MODEL_REST_API_H

#ifdef __cplusplus
extern "C" {
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/* System headers                                                            */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ────────────────────────────────────────────────────────────────────────── */
/* Third-party dependencies                                                  */
#include <curl/curl.h>     /* libcurl (HTTP) */
#include <cjson/cJSON.h>   /* cJSON (JSON parsing / serialization)          */

/* ────────────────────────────────────────────────────────────────────────── */
/* Compile-time configuration                                                */

/* Default REST base URL (may be overridden at runtime via rest_client_set_base()) */
#ifndef CG_REST_DEFAULT_BASE_URL
#define CG_REST_DEFAULT_BASE_URL "http://127.0.0.1:8080/api/v1"
#endif

/* Maximum size for internal libcurl error string buffers */
#ifndef CG_REST_ERROR_BUF
#define CG_REST_ERROR_BUF 256
#endif

/* How many times to retry an idempotent request on transient network errors */
#ifndef CG_REST_RETRY_COUNT
#define CG_REST_RETRY_COUNT 3
#endif

/* ────────────────────────────────────────────────────────────────────────── */
/* Enumerations                                                              */

/*!
 * \brief Supported HTTP methods.
 */
typedef enum
{
    HTTP_GET,
    HTTP_POST,
    HTTP_PUT,
    HTTP_PATCH,
    HTTP_DELETE,
    HTTP_HEAD,
    HTTP_OPTIONS
} http_method_t;

/*!
 * \brief Generic status codes returned by the REST wrapper.
 */
typedef enum
{
    REST_OK = 0,            /*!< success */
    REST_ERR_INIT = -1,     /*!< initialization failure                        */
    REST_ERR_BADARGS = -2,  /*!< invalid argument(s)                           */
    REST_ERR_ALLOC = -3,    /*!< allocation failure                            */
    REST_ERR_CURL = -4,     /*!< libcurl-level failure                         */
    REST_ERR_JSON = -5,     /*!< JSON encoding / decoding failure              */
    REST_ERR_TIMEOUT = -6,  /*!< request timed out                             */
    REST_ERR_HTTP = -7,     /*!< non-2xx HTTP status                           */
    REST_ERR_AUTH = -8      /*!< authentication / authorization failure        */
} rest_status_t;

/* ────────────────────────────────────────────────────────────────────────── */
/* Forward declarations                                                      */
struct rest_client;
struct rest_response;

/* ────────────────────────────────────────────────────────────────────────── */
/* Opaque structures                                                         */

/*!
 * \brief Opaque REST client context (thread-safe if one context per thread).
 */
typedef struct rest_client
{
    CURL           *curl;                            /*!< libcurl easy-handle         */
    char            error_buf[CG_REST_ERROR_BUF];    /*!< libcurl error buffer        */
    char           *base_url;                        /*!< base URL for endpoints      */
    char           *bearer_token;                    /*!< auth token (optional)       */
    struct curl_slist *default_headers;              /*!< default header list         */
    long            timeout_secs;                    /*!< per-request timeout (sec)   */
    uint8_t         retries;                         /*!< retry count for idempotents */
} rest_client_t;

/*!
 * \brief Container for REST response data.
 *
 * Rest responses are heap-allocated and MUST be released via
 * rest_response_free() to avoid leaks.
 */
typedef struct rest_response
{
    long                http_status;     /*!< HTTP status code (e.g. 200)        */
    char               *content_type;    /*!< value of Content-Type header        */
    uint8_t            *body;            /*!< payload bytes (NOT null-terminated) */
    size_t              body_size;       /*!< size of payload in bytes            */
    struct curl_slist  *headers;         /*!< raw response headers (libcurl list) */
} rest_response_t;

/* ────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                */

/*!
 * \brief Initialise a new REST client instance.
 *
 * \param base_url  Custom base URL (NULL => CG_REST_DEFAULT_BASE_URL)
 * \return          Pointer to initialised client or NULL on fatal error.
 */
rest_client_t *rest_client_init(const char *base_url);

/*!
 * \brief Release resources associated with a client instance.
 *
 *        The function is NULL-safe.
 */
void rest_client_cleanup(rest_client_t *client);

/*!
 * \brief Configure bearer token for Authorization: Bearer <token>.
 *
 *        Passing NULL disables authentication.
 *
 * \return REST_OK on success or REST_ERR_ALLOC.
 */
rest_status_t rest_client_set_auth(rest_client_t *client,
                                   const char    *bearer_token);

/*!
 * \brief Set per-request timeout (seconds). 0 => libcurl default.
 */
void rest_client_set_timeout(rest_client_t *client, long seconds);

/*!
 * \brief Build a fully-qualified URL by concatenating client->base_url and
 *        endpoint_path.  Caller must free() the returned string.
 *
 * \note  Intended mainly for advanced users; typical calls use
 *        rest_request_json() which handles URL building internally.
 *
 * \return Newly allocated URL string or NULL on failure.
 */
char *rest_client_build_url(const rest_client_t *client,
                            const char          *endpoint_path);

/*!
 * \brief Perform an HTTP request with a JSON payload (may be NULL).
 *
 * \param client          An initialised rest_client_t
 * \param method          HTTP verb to use
 * \param endpoint_path   Relative endpoint (e.g. "/metrics/latest")
 * \param json_payload    Const cJSON tree (ownership retained by caller)
 * \param out_response    On success *out_response will point to heap-alloc
 *                        rest_response_t which caller must free.
 *
 * \return                REST_OK on success; otherwise error code.
 */
rest_status_t rest_request_json(rest_client_t      *client,
                                http_method_t       method,
                                const char         *endpoint_path,
                                const cJSON        *json_payload,
                                rest_response_t   **out_response);

/*!
 * \brief Convenience function: GET an endpoint returning JSON.  Parses the
 *        payload into a cJSON tree.
 *
 * \param client          REST client
 * \param endpoint_path   Endpoint (e.g. "/health")
 * \param out_json        Parsed cJSON pointer (caller must cJSON_Delete()).
 *
 * \return                REST_OK or corresponding error.
 */
rest_status_t rest_get_json(rest_client_t  *client,
                            const char     *endpoint_path,
                            cJSON         **out_json);

/*!
 * \brief Free a rest_response_t object along with all nested allocations.
 */
void rest_response_free(rest_response_t *resp);

/* ────────────────────────────────────────────────────────────────────────── */
/* Utility helpers                                                           */

/*!
 * \brief Convert rest_status_t to human-readable string.
 */
const char *rest_status_str(rest_status_t status);

/*!
 * \brief Determine whether a given HTTP status represents success (2xx).
 */
static inline bool http_is_success(long code)
{
    return (code >= 200L && code < 300L);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Inline guard helpers                                                      */

#ifndef REST_API_INLINE_IMPL
#define REST_API_INLINE_IMPL 1

#include <stdlib.h>
#include <string.h>

/*
 * INTERNAL: Memory handling for rest_response_t payload accumulation via
 *           libcurl's write callback.
 */
static size_t _rest_write_cb(void *ptr, size_t size, size_t nmemb, void *userdata)
{
    size_t             total  = size * nmemb;
    rest_response_t   *resp   = (rest_response_t *)userdata;

    uint8_t *new_buf = realloc(resp->body, resp->body_size + total + 1);
    if (!new_buf)
        return 0; /* will trigger CURLE_WRITE_ERROR */

    resp->body = new_buf;
    memcpy(resp->body + resp->body_size, ptr, total);
    resp->body_size += total;
    resp->body[resp->body_size] = '\0'; /* Make it C-string compatible */

    return total;
}

/*
 * INTERNAL: Accumulate headers.
 */
static size_t _rest_header_cb(char *buffer, size_t size,
                              size_t nitems, void *userdata)
{
    size_t num_bytes = nitems * size;
    rest_response_t *resp = (rest_response_t *)userdata;

    /* libcurl guarantees buffer is null-terminated */
    char *header_line = strndup(buffer, num_bytes);
    if (!header_line)
        return 0;

    resp->headers = curl_slist_append(resp->headers, header_line);
    free(header_line);
    return num_bytes;
}

/*
 * Implementation of rest_client_init()
 */
rest_client_t *rest_client_init(const char *base_url)
{
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != 0)
        return NULL;

    rest_client_t *c = calloc(1, sizeof(*c));
    if (!c)
        return NULL;

    c->curl          = curl_easy_init();
    if (!c->curl)
    {
        free(c);
        return NULL;
    }

    c->timeout_secs  = 30;
    c->retries       = CG_REST_RETRY_COUNT;
    c->base_url      = strdup(base_url ? base_url
                                       : CG_REST_DEFAULT_BASE_URL);
    if (!c->base_url)
    {
        curl_easy_cleanup(c->curl);
        free(c);
        return NULL;
    }

    curl_easy_setopt(c->curl, CURLOPT_ERRORBUFFER, c->error_buf);
    curl_easy_setopt(c->curl, CURLOPT_WRITEFUNCTION, _rest_write_cb);
    curl_easy_setopt(c->curl, CURLOPT_HEADERFUNCTION, _rest_header_cb);

    return c;
}

/*
 * Implementation of rest_client_cleanup()
 */
void rest_client_cleanup(rest_client_t *client)
{
    if (!client)
        return;

    curl_easy_cleanup(client->curl);
    curl_slist_free_all(client->default_headers);

    free(client->base_url);
    free(client->bearer_token);
    free(client);
}

/*
 * Implementation of rest_client_set_auth()
 */
rest_status_t rest_client_set_auth(rest_client_t *client,
                                   const char    *bearer_token)
{
    if (!client)
        return REST_ERR_BADARGS;

    free(client->bearer_token);
    client->bearer_token = NULL;

    if (bearer_token)
    {
        client->bearer_token = strdup(bearer_token);
        if (!client->bearer_token)
            return REST_ERR_ALLOC;
    }
    return REST_OK;
}

/*
 * Implementation of rest_client_set_timeout()
 */
void rest_client_set_timeout(rest_client_t *client, long seconds)
{
    if (!client)
        return;
    client->timeout_secs = seconds;
}

/*
 * Implementation of rest_client_build_url()
 */
char *rest_client_build_url(const rest_client_t *client,
                            const char          *endpoint_path)
{
    if (!client || !endpoint_path)
        return NULL;

    /* ensure exactly one slash between base and path */
    const bool base_has_slash = client->base_url[strlen(client->base_url) - 1] == '/';
    const bool path_has_slash = endpoint_path[0] == '/';

    size_t len = strlen(client->base_url) + strlen(endpoint_path) + 2;
    char *url  = malloc(len);
    if (!url)
        return NULL;

    snprintf(url, len, "%s%s%s",
             client->base_url,
             (base_has_slash || path_has_slash) ? "" : "/",
             path_has_slash ? (base_has_slash ? endpoint_path + 1 : endpoint_path) : endpoint_path);

    return url;
}

/*
 * Helper: prepare headers list for this request.
 */
static struct curl_slist *_rest_build_headers(const rest_client_t *client)
{
    struct curl_slist *list = NULL;

    /* Content-Type for JSON */
    list = curl_slist_append(list, "Content-Type: application/json");

    if (client->bearer_token)
    {
        char auth_buf[256];
        snprintf(auth_buf, sizeof auth_buf, "Authorization: Bearer %s",
                 client->bearer_token);
        list = curl_slist_append(list, auth_buf);
    }

    /* Prepend default headers user might have configured */
    if (client->default_headers)
    {
        struct curl_slist *tmp;
        for (tmp = client->default_headers; tmp; tmp = tmp->next)
            list = curl_slist_append(list, tmp->data);
    }
    return list;
}

/*
 * Implementation of rest_request_json()
 */
rest_status_t rest_request_json(rest_client_t      *client,
                                http_method_t       method,
                                const char         *endpoint_path,
                                const cJSON        *json_payload,
                                rest_response_t   **out_response)
{
    if (!client || !endpoint_path || !out_response)
        return REST_ERR_BADARGS;

    char *url = rest_client_build_url(client, endpoint_path);
    if (!url)
        return REST_ERR_ALLOC;

    rest_response_t *resp = calloc(1, sizeof(*resp));
    if (!resp)
    {
        free(url);
        return REST_ERR_ALLOC;
    }

    /* Prepare libcurl */
    curl_easy_reset(client->curl);
    curl_easy_setopt(client->curl, CURLOPT_URL, url);
    curl_easy_setopt(client->curl, CURLOPT_WRITEDATA,  resp);
    curl_easy_setopt(client->curl, CURLOPT_HEADERDATA, resp);
    curl_easy_setopt(client->curl, CURLOPT_TIMEOUT,     client->timeout_secs);
    curl_easy_setopt(client->curl, CURLOPT_FOLLOWLOCATION, 1L);

    /* HTTP method specifics */
    switch (method)
    {
        case HTTP_GET:
            /* default is GET */
            break;
        case HTTP_HEAD:
            curl_easy_setopt(client->curl, CURLOPT_NOBODY, 1L);
            break;
        case HTTP_POST:
            curl_easy_setopt(client->curl, CURLOPT_POST, 1L);
            break;
        case HTTP_PUT:
            curl_easy_setopt(client->curl, CURLOPT_CUSTOMREQUEST, "PUT");
            break;
        case HTTP_PATCH:
            curl_easy_setopt(client->curl, CURLOPT_CUSTOMREQUEST, "PATCH");
            break;
        case HTTP_DELETE:
            curl_easy_setopt(client->curl, CURLOPT_CUSTOMREQUEST, "DELETE");
            break;
        default:
            free(url);
            rest_response_free(resp);
            return REST_ERR_BADARGS;
    }

    /* Payload (if any) */
    char *payload_str = NULL;
    if (json_payload)
    {
        payload_str = cJSON_PrintUnformatted((cJSON *)json_payload);
        if (!payload_str)
        {
            free(url);
            rest_response_free(resp);
            return REST_ERR_JSON;
        }
        curl_easy_setopt(client->curl, CURLOPT_POSTFIELDS, payload_str);
    }

    /* Headers */
    struct curl_slist *hdrs = _rest_build_headers(client);
    curl_easy_setopt(client->curl, CURLOPT_HTTPHEADER, hdrs);

    /* Retry logic */
    rest_status_t status     = REST_ERR_CURL;
    CURLcode      curl_code  = CURLE_OK;
    uint8_t       attempt    = 0;

    for (attempt = 0; attempt <= client->retries; ++attempt)
    {
        curl_code = curl_easy_perform(client->curl);
        if (curl_code == CURLE_OK)
            break;

        /* Only retry on transient network errors */
        if (curl_code != CURLE_COULDNT_CONNECT &&
            curl_code != CURLE_OPERATION_TIMEDOUT &&
            curl_code != CURLE_RECV_ERROR   &&
            curl_code != CURLE_SEND_ERROR)
            break; /* non-retryable */
    }

    if (curl_code != CURLE_OK)
    {
        status = (curl_code == CURLE_OPERATION_TIMEDOUT) ? REST_ERR_TIMEOUT
                                                         : REST_ERR_CURL;
        goto cleanup;
    }

    /* Get HTTP status */
    curl_easy_getinfo(client->curl, CURLINFO_RESPONSE_CODE,
                      &resp->http_status);

    /* Basic success / error mapping */
    if (!http_is_success(resp->http_status))
    {
        status = (resp->http_status == 401 || resp->http_status == 403)
                   ? REST_ERR_AUTH : REST_ERR_HTTP;
        goto cleanup;
    }

    /* Attempt to read Content-Type header */
    char *ctype = NULL;
    curl_easy_getinfo(client->curl, CURLINFO_CONTENT_TYPE, &ctype);
    if (ctype)
        resp->content_type = strdup(ctype);

    *out_response = resp;
    status        = REST_OK;

cleanup:
    curl_slist_free_all(hdrs);
    free(payload_str);
    free(url);

    if (status != REST_OK)
        rest_response_free(resp);

    return status;
}

/*
 * Implementation of rest_get_json()
 */
rest_status_t rest_get_json(rest_client_t  *client,
                            const char     *endpoint_path,
                            cJSON         **out_json)
{
    if (!client || !endpoint_path || !out_json)
        return REST_ERR_BADARGS;

    rest_response_t *resp = NULL;
    rest_status_t st = rest_request_json(client, HTTP_GET,
                                         endpoint_path, NULL, &resp);
    if (st != REST_OK)
        return st;

    /* Content-Type sanity check (optional) */
    if (resp->content_type &&
        strstr(resp->content_type, "application/json") == NULL)
    {
        rest_response_free(resp);
        return REST_ERR_JSON;
    }

    cJSON *json = cJSON_ParseWithLength((const char *)resp->body,
                                        resp->body_size);
    rest_response_free(resp);

    if (!json)
        return REST_ERR_JSON;

    *out_json = json;
    return REST_OK;
}

/*
 * Implementation of rest_response_free()
 */
void rest_response_free(rest_response_t *resp)
{
    if (!resp)
        return;

    free(resp->content_type);
    free(resp->body);
    curl_slist_free_all(resp->headers);
    free(resp);
}

/*
 * Implementation of rest_status_str()
 */
const char *rest_status_str(rest_status_t status)
{
    switch (status)
    {
        case REST_OK:          return "REST_OK";
        case REST_ERR_INIT:    return "REST_ERR_INIT";
        case REST_ERR_BADARGS: return "REST_ERR_BADARGS";
        case REST_ERR_ALLOC:   return "REST_ERR_ALLOC";
        case REST_ERR_CURL:    return "REST_ERR_CURL";
        case REST_ERR_JSON:    return "REST_ERR_JSON";
        case REST_ERR_TIMEOUT: return "REST_ERR_TIMEOUT";
        case REST_ERR_HTTP:    return "REST_ERR_HTTP";
        case REST_ERR_AUTH:    return "REST_ERR_AUTH";
        default:               return "REST_ERR_UNKNOWN";
    }
}

#endif /* REST_API_INLINE_IMPL */

/* ────────────────────────────────────────────────────────────────────────── */

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CG_EDU_MONITOR_MODEL_REST_API_H */