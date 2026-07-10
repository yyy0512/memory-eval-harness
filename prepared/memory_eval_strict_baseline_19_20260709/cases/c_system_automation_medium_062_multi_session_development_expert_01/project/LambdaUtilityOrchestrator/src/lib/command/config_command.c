/**
 * LambdaUtility Orchestrator
 * File: src/lib/command/config_command.c
 *
 * Implements the “configuration-management” command.  The command receives a
 * JSON payload describing a configuration artifact to deploy and a target
 * endpoint (e.g., an API Gateway fronting a fleet-wide configuration service).
 *
 * High-level flow
 *  1. Validate and normalize payload
 *  2. Read the artefact from disk (or pre-signed URL)
 *  3. Compute a SHA-256 checksum for idempotency
 *  4. Push the artefact to the target using libcurl  (HTTP PUT)
 *  5. Publish a result on the internal event-bus so that observers (e.g. Slack /
 *     PagerDuty notifiers) can react.
 *
 * The command plugs into the project’s Command/Chain-of-Responsibility
 * infrastructure via the generic `Command` interface (execute / destroy).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <ctype.h>
#include <openssl/sha.h>
#include <curl/curl.h>
#include <jansson.h>
#include <sys/stat.h>
#include <unistd.h>

#include "command.h"          /* Generic Command interface   */
#include "logger.h"           /* Project-wide logging macros */
#include "event_bus.h"        /* Observer notification       */
#include "error_codes.h"      /* Centralized errno wrapper   */
#include "safe_io.h"          /* fs helpers – fread_full()   */

#define MODULE "ConfigCommand"

/* -------------------------------------------------------------------------- */
/* Local data types                                                           */
/* -------------------------------------------------------------------------- */

typedef struct
{
    Command      base;          /* Must be first – “inheritance” in C      */
    char        *artifact_path; /* Path to the configuration file          */
    char        *target_url;    /* REST endpoint to push the config to     */
    char        *content_type;  /* MIME type (e.g. text/plain, app/yaml)   */
} ConfigCommand;

/* -------------------------------------------------------------------------- */
/* Utility helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * compute_sha256
 * --------------------------------------------------------------------------
 * Reads an input buffer and produces a hex-encoded SHA-256 string.  The caller
 * owns the returned pointer and must free() it.
 */
static char *compute_sha256(const unsigned char *data, size_t len)
{
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256_CTX    sha_ctx;

    if (SHA256_Init(&sha_ctx) != 1 ||
        SHA256_Update(&sha_ctx, data, len) != 1 ||
        SHA256_Final(hash, &sha_ctx) != 1)
    {
        LOG_ERROR(MODULE, "SHA256 calculation failed");
        return NULL;
    }

    /* Hex-encode */
    char *hex = calloc(SHA256_DIGEST_LENGTH * 2 + 1, 1);
    if (!hex)
    {
        LOG_OOM();
        return NULL;
    }

    for (size_t i = 0; i < SHA256_DIGEST_LENGTH; ++i)
        sprintf(hex + (i * 2), "%02x", hash[i]);

    return hex;
}

/* -------------------------------------------------------------------------- */
/* cURL helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * in_memory_read_cb
 * --------------------------------------------------------------------------
 * cURL “read” callback invoked when it needs more bytes to upload.
 */
static size_t in_memory_read_cb(void *ptr, size_t size, size_t nmemb, void *userp)
{
    size_t max = size * nmemb;
    struct
    {
        const unsigned char *buf;
        size_t               len;
        size_t               cursor;
    } *ctx = userp;

    size_t remaining = ctx->len - ctx->cursor;
    size_t to_copy   = remaining > max ? max : remaining;

    if (to_copy)
    {
        memcpy(ptr, ctx->buf + ctx->cursor, to_copy);
        ctx->cursor += to_copy;
    }

    return to_copy;
}

/* -------------------------------------------------------------------------- */
/* Forward declarations (Command interface)                                   */
/* -------------------------------------------------------------------------- */

static int  cfg_cmd_execute(Command *self, const void *payload);
static void cfg_cmd_destroy(Command *self);

/* -------------------------------------------------------------------------- */
/* Public factory                                                             */
/* -------------------------------------------------------------------------- */

Command *config_command_create(void)
{
    ConfigCommand *cmd = calloc(1, sizeof(ConfigCommand));
    if (!cmd)
    {
        LOG_OOM();
        return NULL;
    }

    cmd->base.execute = cfg_cmd_execute;
    cmd->base.destroy = cfg_cmd_destroy;
    return (Command *)cmd;
}

/* -------------------------------------------------------------------------- */
/* Internal implementation                                                    */
/* -------------------------------------------------------------------------- */

/* Validate & hydrate ConfigCommand from JSON payload */
static int hydrate_from_json(ConfigCommand *cmd, const char *json_str)
{
    json_error_t jerr;
    json_t      *root = json_loads(json_str, 0, &jerr);
    if (!root)
    {
        LOG_ERROR(MODULE, "JSON parse error on line %d: %s", jerr.line, jerr.text);
        return ERR_INVALID_INPUT;
    }

    const char *artifact   = NULL;
    const char *target_url = NULL;
    const char *type       = NULL;

    if (json_unpack(root,
                    "{s:s, s:s, s?s}",
                    "artifact_path", &artifact,
                    "target_url",    &target_url,
                    "content_type",  &type) != 0)
    {
        LOG_ERROR(MODULE, "Payload missing required fields");
        json_decref(root);
        return ERR_INVALID_INPUT;
    }

    cmd->artifact_path = strdup(artifact);
    cmd->target_url    = strdup(target_url);
    cmd->content_type  = type ? strdup(type) : strdup("application/octet-stream");

    json_decref(root);

    if (!cmd->artifact_path || !cmd->target_url || !cmd->content_type)
    {
        LOG_OOM();
        return ERR_OOM;
    }
    return ERR_OK;
}

/* -------------------------------------------------------------------------- */

static int push_config(ConfigCommand *cmd,
                       const unsigned char *buf,
                       size_t                len,
                       const char           *hash_hex)
{
    CURL *curl = curl_easy_init();
    if (!curl)
    {
        LOG_ERROR(MODULE, "Failed to init cURL");
        return ERR_EXTERNAL_LIB;
    }

    struct curl_slist *hdrs = NULL;
    char sha_header[128];
    snprintf(sha_header, sizeof(sha_header), "X-Content-SHA256: %s", hash_hex);

    hdrs = curl_slist_append(hdrs, sha_header);

    /* Content-Type */
    char type_header[128];
    snprintf(type_header, sizeof(type_header), "Content-Type: %s", cmd->content_type);
    hdrs = curl_slist_append(hdrs, type_header);

    curl_easy_setopt(curl, CURLOPT_URL,             cmd->target_url);
    curl_easy_setopt(curl, CURLOPT_UPLOAD,          1L);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,      hdrs);
    curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE,(curl_off_t)len);

    /* Read callback context */
    struct
    {
        const unsigned char *buf;
        size_t               len;
        size_t               cursor;
    } ctx = { .buf = buf, .len = len, .cursor = 0 };

    curl_easy_setopt(curl, CURLOPT_READFUNCTION,    in_memory_read_cb);
    curl_easy_setopt(curl, CURLOPT_READDATA,        &ctx);
    curl_easy_setopt(curl, CURLOPT_USERAGENT,       "LambdaUtility/1.0");

    /* HTTPS best practices */
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER,  1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST,  2L);

    CURLcode rc = curl_easy_perform(curl);

    long http_status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);

    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);

    if (rc != CURLE_OK)
    {
        LOG_ERROR(MODULE, "Upload failed: %s", curl_easy_strerror(rc));
        return ERR_NETWORK;
    }

    if (http_status >= 200 && http_status < 300)
    {
        LOG_INFO(MODULE, "Config (%s) pushed successfully. HTTP %ld",
                 cmd->artifact_path, http_status);
        return ERR_OK;
    }

    LOG_ERROR(MODULE, "Upload failed; HTTP %ld", http_status);
    return ERR_REMOTE_REJECT;
}

/* -------------------------------------------------------------------------- */

static int cfg_cmd_execute(Command *self, const void *payload)
{
    if (!self || !payload) return ERR_INVALID_INPUT;

    ConfigCommand *cmd = (ConfigCommand *)self;

    /* -------- 1. Hydrate from JSON --------------------------------------- */
    if (hydrate_from_json(cmd, (const char *)payload) != ERR_OK)
        return ERR_INVALID_INPUT;

    /* -------- 2. Read artifact ------------------------------------------- */
    size_t  len = 0;
    unsigned char *buf = fread_full(cmd->artifact_path, &len);  /* safe_io.h */
    if (!buf) return ERR_IO;

    /* -------- 3. SHA-256 -------------------------------------------------- */
    char *hash_hex = compute_sha256(buf, len);
    if (!hash_hex) { free(buf); return ERR_INTERNAL; }

    /* -------- 4. Upload --------------------------------------------------- */
    int rc = push_config(cmd, buf, len, hash_hex);

    /* -------- 5. Publish result ------------------------------------------ */
    json_t *evt = json_pack("{s:s, s:s, s:I}",
                            "artifact",  cmd->artifact_path,
                            "checksum",  hash_hex,
                            "status",    rc);
    if (evt)
    {
        char *dump = json_dumps(evt, JSON_COMPACT);
        if (dump)
        {
            event_bus_publish("config.deploy.result", dump, strlen(dump)); /* async fire-and-forget */
            free(dump);
        }
        json_decref(evt);
    }

    /* Clean-up */
    free(hash_hex);
    free(buf);

    return rc;
}

/* -------------------------------------------------------------------------- */

static void cfg_cmd_destroy(Command *self)
{
    if (!self) return;

    ConfigCommand *cmd = (ConfigCommand *)self;
    free(cmd->artifact_path);
    free(cmd->target_url);
    free(cmd->content_type);
    free(cmd);
}

/* -------------------------------------------------------------------------- */
/* End of file                                                                */
/* -------------------------------------------------------------------------- */
