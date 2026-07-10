```c
/*
 * CampusGuard EDU Monitor – API Integration Test Suite
 *
 * File: docs/design/03_API_Specification.md          (generated C test source)
 * Build: gcc -Wall -Wextra -pedantic -lcurl -lcjson \
 *        -o api_spec_tests api_spec_tests.c
 *
 * Purpose
 * -------
 * Exercises the public REST layer exposed by the CampusGuard
 * backend, ensuring that the implementation matches the design-time
 * API specification documented in 03_API_Specification.md.
 *
 * The tests rely on:
 *   • libcurl  (HTTP client)
 *   • cJSON    (JSON parser)
 *
 * The server must be running locally (or reachable) before the tests
 * are executed.  Override the default target with:
 *
 *   $ CAMPUSGUARD_BASE_URL=http://guard-host:8080 ./api_spec_tests
 *
 * Exit status is zero when all tests pass; non-zero otherwise, making
 * the program suitable for CI pipelines.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <curl/curl.h>
#include <time.h>
#include <errno.h>
#include "cJSON.h"

/* -------------------------------------------------------------------------
 * Test framework – very small footprint, no external deps.
 * ------------------------------------------------------------------------- */
#define TEST_ASSERT(cond, msg)                                     \
    do {                                                           \
        if (!(cond)) {                                             \
            fprintf(stderr, "[FAIL] %s:%d: %s\n",                  \
                    __FILE__, __LINE__, (msg));                    \
            return 1;                                              \
        }                                                          \
    } while (0)

#define TEST_CASE(name) static int name(void)
#define REGISTER_TEST(fn) do {                                     \
        total++;                                                   \
        int rc = fn();                                             \
        if (rc == 0) passed++;                                     \
        else failures++;                                           \
    } while (0)

/* -------------------------------------------------------------------------
 * libcurl helpers
 * ------------------------------------------------------------------------- */
typedef struct {
    char  *data;
    size_t size;
} MemoryBuffer;

static size_t curl_write_cb(void *ptr, size_t size, size_t nmemb, void *userdata)
{
    const size_t total = size * nmemb;
    MemoryBuffer *buf = (MemoryBuffer *)userdata;

    char *new_ptr = realloc(buf->data, buf->size + total + 1);
    if (new_ptr == NULL) {
        /* Out-of-memory fatal – propagate */
        return 0;
    }

    buf->data = new_ptr;
    memcpy(buf->data + buf->size, ptr, total);
    buf->size += total;
    buf->data[buf->size] = '\0';
    return total;
}

/* Perform GET request and parse body as JSON. */
static int http_get_json(const char *url, cJSON **out_json, long *http_code)
{
    CURL *curl = curl_easy_init();
    if (!curl) {
        fprintf(stderr, "curl_easy_init() failed\n");
        return -1;
    }

    MemoryBuffer buf = {.data = NULL, .size = 0};

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        fprintf(stderr, "curl_easy_perform(): %s\n",
                curl_easy_strerror(res));
        curl_easy_cleanup(curl);
        free(buf.data);
        return -1;
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, http_code);
    curl_easy_cleanup(curl);

    *out_json = cJSON_Parse(buf.data);
    free(buf.data);

    if (*out_json == NULL) {
        fprintf(stderr, "Failed to parse JSON from %s\n", url);
        return -1;
    }

    return 0;
}

/* Perform POST request with JSON payload and parse response body as JSON. */
static int http_post_json(const char *url,
                          const char *payload,
                          cJSON     **out_json,
                          long       *http_code)
{
    CURL *curl = curl_easy_init();
    if (!curl) {
        fprintf(stderr, "curl_easy_init() failed\n");
        return -1;
    }

    MemoryBuffer buf = {.data = NULL, .size = 0};
    struct curl_slist *hdrs = NULL;

    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(payload));
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        fprintf(stderr, "curl_easy_perform(): %s\n",
                curl_easy_strerror(res));
        curl_slist_free_all(hdrs);
        curl_easy_cleanup(curl);
        free(buf.data);
        return -1;
    }

    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, http_code);

    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);

    *out_json = cJSON_Parse(buf.data);
    free(buf.data);

    if (*out_json == NULL) {
        fprintf(stderr, "Failed to parse JSON from %s\n", url);
        return -1;
    }

    return 0;
}

/* -------------------------------------------------------------------------
 * Convenience helpers
 * ------------------------------------------------------------------------- */
static const char *base_url(void)
{
    const char *env = getenv("CAMPUSGUARD_BASE_URL");
    return env ? env : "http://localhost:8080";
}

static char *url_join(const char *suffix)
{
    const char *base = base_url();
    size_t len = strlen(base) + strlen(suffix) + 2;
    char *full = malloc(len);
    if (full == NULL) {
        return NULL;
    }
    snprintf(full, len, "%s%s%s",
             base,
             (suffix[0] == '/' && base[strlen(base) - 1] == '/') ? "" :
             (suffix[0] != '/' && base[strlen(base) - 1] != '/') ? "/" : "",
             suffix);
    return full;
}

/* -------------------------------------------------------------------------
 * Test cases
 * ------------------------------------------------------------------------- */

/*
 * /api/v1/health  -----------------------------------------------
 * Expect: 200 OK
 * Body: { "status":"ok", "uptime": <number> }
 */
TEST_CASE(test_health_endpoint)
{
    char *url = url_join("/api/v1/health");
    TEST_ASSERT(url != NULL, "url_join failed");

    cJSON *json = NULL;
    long http_code = 0;
    int rc = http_get_json(url, &json, &http_code);
    free(url);

    TEST_ASSERT(rc == 0, "HTTP GET failed");
    TEST_ASSERT(http_code == 200, "HTTP code != 200");

    cJSON *status = cJSON_GetObjectItemCaseSensitive(json, "status");
    TEST_ASSERT(cJSON_IsString(status), "Missing or invalid 'status'");
    TEST_ASSERT(strcmp(status->valuestring, "ok") == 0, "'status' != 'ok'");

    cJSON *uptime = cJSON_GetObjectItemCaseSensitive(json, "uptime");
    TEST_ASSERT(cJSON_IsNumber(uptime), "Missing or invalid 'uptime'");
    TEST_ASSERT(uptime->valuedouble >= 0.0, "'uptime' negative");

    cJSON_Delete(json);
    return 0;
}

/*
 * /api/v1/logs/query  -------------------------------------------
 * Request: { "level":"ERROR", "limit":3 }
 * Expect: 200 OK
 * Body: { "entries":[ ... ], "count":<=3 }
 */
TEST_CASE(test_log_query_endpoint)
{
    char *url = url_join("/api/v1/logs/query");
    TEST_ASSERT(url != NULL, "url_join failed");

    const char *payload = "{ \"level\":\"ERROR\", \"limit\":3 }";
    cJSON *json = NULL;
    long http_code = 0;
    int rc = http_post_json(url, payload, &json, &http_code);
    free(url);

    TEST_ASSERT(rc == 0, "HTTP POST failed");
    TEST_ASSERT(http_code == 200, "HTTP code != 200");

    cJSON *entries = cJSON_GetObjectItemCaseSensitive(json, "entries");
    cJSON *count   = cJSON_GetObjectItemCaseSensitive(json, "count");

    TEST_ASSERT(cJSON_IsArray(entries), "'entries' not array");
    TEST_ASSERT(cJSON_IsNumber(count), "'count' not number");
    TEST_ASSERT((int)cJSON_GetArraySize(entries) <= 3,
                "'entries' exceeds requested limit");
    TEST_ASSERT(count->valueint == cJSON_GetArraySize(entries),
                "'count' mismatch");

    /* Extra: each entry must expose required fields */
    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, entries) {
        cJSON *ts = cJSON_GetObjectItemCaseSensitive(entry, "timestamp");
        cJSON *lvl = cJSON_GetObjectItemCaseSensitive(entry, "level");
        cJSON *msg = cJSON_GetObjectItemCaseSensitive(entry, "message");
        TEST_ASSERT(cJSON_IsString(ts), "entry.timestamp not string");
        TEST_ASSERT(cJSON_IsString(lvl), "entry.level not string");
        TEST_ASSERT(cJSON_IsString(msg), "entry.message not string");
    }

    cJSON_Delete(json);
    return 0;
}

/*
 * /api/v1/backup/trigger  ---------------------------------------
 * Request: { "target":"db", "retention_days":7 }
 * Expect: 202 Accepted
 * Body: { "job_id":"<uuid>", "queued_at":<iso-8601> }
 */
TEST_CASE(test_backup_trigger_endpoint)
{
    char *url = url_join("/api/v1/backup/trigger");
    TEST_ASSERT(url != NULL, "url_join failed");

    const char *payload = "{ \"target\":\"db\", \"retention_days\":7 }";
    cJSON *json = NULL;
    long http_code = 0;
    int rc = http_post_json(url, payload, &json, &http_code);
    free(url);

    TEST_ASSERT(rc == 0, "HTTP POST failed");
    TEST_ASSERT(http_code == 202, "HTTP code != 202");

    cJSON *job_id    = cJSON_GetObjectItemCaseSensitive(json, "job_id");
    cJSON *queued_at = cJSON_GetObjectItemCaseSensitive(json, "queued_at");

    TEST_ASSERT(cJSON_IsString(job_id), "job_id not string");
    TEST_ASSERT(strlen(job_id->valuestring) >= 32,
                "job_id length suspicious");

    TEST_ASSERT(cJSON_IsString(queued_at), "queued_at not string");
    /* Basic ISO-8601 check: must contain 'T' separator */
    TEST_ASSERT(strchr(queued_at->valuestring, 'T') != NULL,
                "queued_at not ISO-8601");

    cJSON_Delete(json);
    return 0;
}

/* -------------------------------------------------------------------------
 * Main driver
 * ------------------------------------------------------------------------- */
int main(void)
{
    int total = 0, passed = 0, failures = 0;

    if (curl_global_init(CURL_GLOBAL_DEFAULT) != 0) {
        fprintf(stderr, "curl_global_init() failed\n");
        return EXIT_FAILURE;
    }

    REGISTER_TEST(test_health_endpoint);
    REGISTER_TEST(test_log_query_endpoint);
    REGISTER_TEST(test_backup_trigger_endpoint);

    curl_global_cleanup();

    printf("\n--------------------\n");
    printf("Tests:   %d\n", total);
    printf("Passed:  %d\n", passed);
    printf("Failed:  %d\n", failures);
    printf("--------------------\n");

    return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
```