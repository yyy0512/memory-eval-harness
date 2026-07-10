/*
 * LambdaUtility Orchestrator
 * File:    deploy_command.c
 * Author:  LambdaUtility Core Team
 *
 * Description:
 *   Concrete Command implementation that performs automated roll-outs of a
 *   Lambda artifact (zip) using AWS CLI under the hood.  The command can be
 *   chained with other commands (Chain-of-Responsibility) and emits detailed
 *   log/metric information during the process (Observer pattern).
 *
 *   A deployment “manifest” in YAML or JSON is supplied that describes:
 *      - target_function_name (string)
 *      - runtime              (string)
 *      - region               (string)
 *      - aliases              (list[string])
 *      - environment          (map[string]string)  (optional)
 *
 *   The manifest is validated and—if `LAMBDAUTIL_DRYRUN=1`—no AWS calls are
 *   executed, but the flow proceeds and is fully logged.
 *
 * Build flags:
 *      -std=c11
 *      -Wall -Wextra -pedantic
 *      -lcjson               (YAML handled as JSON for simplicity here)
 *
 * NOTE: Error handling is defensive; fatal conditions bubble up so the caller
 *       Lambda may return an invocation error, which alerts operations.
 */

#include "command.h"             /* Command interface */
#include "metric_collector.h"    /* Custom project header */
#include "lambda_context.h"      /* Context meta-data */
#include "logger.h"              /* Cross-cutting structured logger */
#include "string_utils.h"        /* Common string helpers */
#include "time_utils.h"
#include <cjson/cJSON.h>

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*------------- Internal Constants -----------------------------------------*/
#define MAX_CMD_LEN     1024
#define MANIFEST_BUF_SZ (64 * 1024)

/*------------- Forward Declarations ---------------------------------------*/
typedef struct DeployCommand DeployCommand;
static void deploy_execute(Command *super,
                           const LambdaEvent *event,
                           LambdaContext    *ctx);
static void deploy_destroy(Command *super);
static bool load_manifest(DeployCommand *self);
static bool validate_manifest(DeployCommand *self);
static bool perform_deployment(DeployCommand *self);
static bool update_aliases(DeployCommand *self);
static bool run_cli_command(DeployCommand *self, const char *fmt, ...);
static char *slurp_file(const char *path, size_t *out_size);

/*------------- Concrete Command -------------------------------------------*/
struct DeployCommand {
    Command  base;                 /* must be first member */
    Logger  *logger;
    char    *manifest_path;        /* heap-allocated */
    char    *artifact_path;        /* heap-allocated */
    cJSON   *manifest_json;
    bool     dry_run;
};

/*------------- Factory ----------------------------------------------------*/
Command *deploy_command_create(const char *manifest_path,
                               const char *artifact_path,
                               Logger     *logger)
{
    if (!manifest_path || !artifact_path || !logger) {
        return NULL;
    }

    DeployCommand *self = calloc(1, sizeof(*self));
    if (!self) {
        return NULL;
    }

    self->manifest_path = strdup(manifest_path);
    self->artifact_path = strdup(artifact_path);
    self->logger        = logger;
    self->dry_run       = getenv("LAMBDAUTIL_DRYRUN") != NULL;

    /* wire v-table */
    self->base.execute    = deploy_execute;
    self->base.destroy    = deploy_destroy;
    self->base.set_next   = command_set_next;  /* default helper in command.c */

    return (Command *)self;
}

/*------------- Public API -------------------------------------------------*/
static void deploy_execute(Command *super,
                           const LambdaEvent *event,
                           LambdaContext    *ctx)
{
    DeployCommand *self = (DeployCommand *)super;

    LOG_I(self->logger, "Starting deployment. manifest=\"%s\" artifact=\"%s\"%s",
          self->manifest_path,
          self->artifact_path,
          self->dry_run ? " (dry-run)" : "");

    bool ok = load_manifest(self) &&
              validate_manifest(self) &&
              perform_deployment(self) &&
              update_aliases(self);

    metric_inc("deploy.attempt_total", 1);
    metric_inc(ok ? "deploy.success_total" : "deploy.failure_total", 1);

    if (!ok) {
        LOG_E(self->logger, "Deployment failed for manifest %s",
              self->manifest_path);
    } else {
        LOG_I(self->logger, "Deployment succeeded for manifest %s",
              self->manifest_path);
    }

    /* continue chain */
    if (super->next) {
        super->next->execute(super->next, event, ctx);
    }
}

/*------------- Internal Helpers ------------------------------------------*/
static bool load_manifest(DeployCommand *self)
{
    size_t sz = 0;
    char *content = slurp_file(self->manifest_path, &sz);
    if (!content) {
        LOG_E(self->logger, "Unable to read manifest \"%s\": %s",
              self->manifest_path, strerror(errno));
        return false;
    }

    self->manifest_json = cJSON_ParseWithLength(content, (int)sz);
    free(content);

    if (!self->manifest_json) {
        LOG_E(self->logger, "Manifest \"%s\" is not valid JSON.",
              self->manifest_path);
        return false;
    }
    return true;
}

static bool validate_manifest(DeployCommand *self)
{
    const char *required_keys[] = {
        "target_function_name",
        "runtime",
        "region"
    };
    for (size_t i = 0; i < sizeof(required_keys)/sizeof(required_keys[0]); ++i) {
        if (!cJSON_GetObjectItemCaseSensitive(self->manifest_json,
                                              required_keys[i]))
        {
            LOG_E(self->logger, "Manifest missing required key: %s",
                  required_keys[i]);
            return false;
        }
    }
    /* Additional validation could be placed here (regex, sizes, etc.) */
    return true;
}

static bool perform_deployment(DeployCommand *self)
{
    const char *function =
        cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(self->manifest_json,
                                             "target_function_name"));
    const char *region =
        cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(self->manifest_json, "region"));

    if (!function || !region) {
        LOG_E(self->logger,
              "Invalid manifest: target_function_name or region missing.");
        return false;
    }

    LOG_D(self->logger, "Updating code for %s in %s", function, region);

    return run_cli_command(self,
        "aws lambda update-function-code "
        "--function-name %s "
        "--region %s "
        "--zip-file fileb://%s "
        "--publish",
        function, region, self->artifact_path);
}

static bool update_aliases(DeployCommand *self)
{
    cJSON *aliases = cJSON_GetObjectItemCaseSensitive(self->manifest_json,
                                                      "aliases");
    if (!cJSON_IsArray(aliases)) {
        /* not fatal; just no aliases to update */
        return true;
    }

    const char *function =
        cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(self->manifest_json,
                                             "target_function_name"));
    const char *region =
        cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(self->manifest_json, "region"));

    if (!function || !region) {
        LOG_E(self->logger,
              "update_aliases: missing required manifest fields.");
        return false;
    }

    cJSON *alias = NULL;
    cJSON_ArrayForEach(alias, aliases) {
        const char *alias_name = cJSON_GetStringValue(alias);
        if (!alias_name) continue;

        if (!run_cli_command(self,
            "aws lambda update-alias "
            "--function-name %s "
            "--name %s "
            "--region %s "
            "--function-version $(aws lambda list-versions-by-function "
                                 "--function-name %s "
                                 "--region %s --query 'Versions[-1].Version' "
                                 "--output text)",
            function, alias_name, region, function, region))
        {
            return false;
        }
        LOG_I(self->logger, "Alias %s updated for %s", alias_name, function);
    }
    return true;
}

/* varargs helper that consolidates dry-run + logging + popen */
#include <stdarg.h>
static bool run_cli_command(DeployCommand *self, const char *fmt, ...)
{
    char cmd_buf[MAX_CMD_LEN] = {0};

    va_list ap;
    va_start(ap, fmt);
    vsnprintf(cmd_buf, sizeof(cmd_buf), fmt, ap);
    va_end(ap);

    LOG_D(self->logger, "CLI command: %s", cmd_buf);

    if (self->dry_run) {
        LOG_I(self->logger, "Dry-run enabled, skipping execution.");
        return true;
    }

    /* using popen to capture stderr/stdout for logging */
    FILE *fp = popen(cmd_buf, "r");
    if (!fp) {
        LOG_E(self->logger, "popen failed: %s", strerror(errno));
        return false;
    }

    char line[256];
    while (fgets(line, sizeof line, fp)) {
        strchomp(line);
        LOG_D(self->logger, "aws-cli: %s", line);
    }

    int rc = pclose(fp);
    if (rc == -1) {
        LOG_E(self->logger, "pclose failed: %s", strerror(errno));
        return false;
    }

    /* AWS CLI returns non-zero on error. capture only exit status bits. */
    if (WEXITSTATUS(rc) != 0) {
        LOG_E(self->logger, "CLI exited with status %d", WEXITSTATUS(rc));
        return false;
    }
    return true;
}

static char *slurp_file(const char *path, size_t *out_size)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;

    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long sz = ftell(f);
    if (sz < 0 || sz > MANIFEST_BUF_SZ) {
        fclose(f);
        errno = EFBIG;
        return NULL;
    }
    rewind(f);

    char *buf = malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }

    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (n != (size_t)sz) {
        free(buf);
        errno = EIO;
        return NULL;
    }
    buf[sz] = '\0';
    if (out_size) *out_size = (size_t)sz;
    return buf;
}

/*------------- Destructor -------------------------------------------------*/
static void deploy_destroy(Command *super)
{
    if (!super) return;
    DeployCommand *self = (DeployCommand *)super;

    if (self->manifest_json) cJSON_Delete(self->manifest_json);
    free(self->manifest_path);
    free(self->artifact_path);
    free(self);
}
