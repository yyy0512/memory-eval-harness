/*============================================================================
 * File:    backup_command.c
 * Project: LambdaUtility Orchestrator (system_automation)
 *
 * Description:
 *   Implementation of the BackupCommand – a concrete Command that performs
 *   on-demand or scheduled backups (e.g., EBS volume snapshots, S3 object
 *   versioning, database dumps) in a serverless context.  The command is
 *   intentionally generic: it parses the invocation payload, determines the
 *   backup target, orchestrates the provider-specific backup, emits audit
 *   records, and reports success/failure to the Observer pipeline.
 *
 * Architecture:
 *   ┌──────────┐     ┌───────────────┐     ┌───────────────────┐
 *   │ Trigger  │──►─▶│ EventBridge   │──►─▶│ BackupCommand     │──►─▶Observers
 *   └──────────┘     └───────────────┘     └───────────────────┘
 *
 *   The command follows the Command pattern and is injected into the
 *   Chain-of-Responsibility at runtime.  All external communication is done
 *   through thin wrapper interfaces so the core code remains cloud-agnostic
 *   and unit-testable without real cloud credentials.
 *===========================================================================*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>

#include "command.h"                /* Abstract Command interface            */
#include "backup_command.h"         /* Public interface for this component   */
#include "logger.h"                 /* Project-wide structured logger        */
#include "provider/backup_provider.h"/* Cloud-provider abstraction layer      */
#include "utils/json.h"             /* Lightweight JSON (de)serialization    */
#include "utils/str.h"              /* String helpers                        */
#include "observer/event_bus.h"     /* Fan-out notifications                 */

/* ---------------------------------------------------------------------------
 * Internal constants
 * -------------------------------------------------------------------------*/
#define ISO_TS_LEN       32          /* YYYY-MM-DDThh:mm:ssZ                 */
#define ERR_MSG_LEN     256

/* ---------------------------------------------------------------------------
 * Private helpers
 * -------------------------------------------------------------------------*/

/* Return current UTC timestamp in ISO-8601 format (thread-safe). */
static void
iso_timestamp_now(char buffer[ISO_TS_LEN])
{
    time_t     now = time(NULL);
    struct tm  tm_utc;

    gmtime_r(&now, &tm_utc);
    strftime(buffer, ISO_TS_LEN, "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
}

/*
 * Convert a provider status code into an application-level result string.
 */
static const char *
provider_status_to_str(ProviderStatus s)
{
    switch (s) {
        case PROVIDER_SUCCESS:           return "SUCCESS";
        case PROVIDER_TRANSIENT_ERROR:   return "RETRYABLE_ERROR";
        case PROVIDER_FATAL_ERROR:       return "FATAL_ERROR";
        default:                         return "UNKNOWN_STATUS";
    }
}

/*
 * Publish an audit event (best-effort; failures are only logged).
 */
static void
publish_audit_event(const BackupCommand *self,
                    const char          *state,
                    const char          *details)
{
    char iso_ts[ISO_TS_LEN] = {0};

    iso_timestamp_now(iso_ts);

    JsonDoc *event = json_create_object();
    json_object_add_string(event, "timestamp",  iso_ts);
    json_object_add_string(event, "command",    "BackupCommand");
    json_object_add_string(event, "resourceId", self->resource_id);
    json_object_add_string(event, "backupType", self->backup_type);
    json_object_add_string(event, "state",      state);
    json_object_add_string(event, "details",    details ? details : "");

    char *payload = json_serialize(event);

    if (event_bus_publish(EVENT_TOPIC_AUDIT, payload) != 0) {
        log_warn("[BackupCommand] Failed to publish audit event: %s",
                 event_bus_strerror(errno));
    }

    free(payload);
    json_destroy(event);
}

/* ---------------------------------------------------------------------------
 * BackupCommand implementation
 * -------------------------------------------------------------------------*/

/*
 * Forward declaration of the execute and destroy methods so we can populate
 * the vtable below.
 */
static int  backup_command_execute(Command *cmd, const CommandCtx *ctx);
static void backup_command_destroy(Command *cmd);

/* Virtual function table (single-instance, const). */
static const CommandVTable backup_command_vtable = {
    .execute = backup_command_execute,
    .destroy = backup_command_destroy,
};

/* Public factory */
Command *
backup_command_new(const BackupCommandInit *init)
{
    if (!init || str_is_empty(init->resource_id) || str_is_empty(init->backup_type)) {
        errno = EINVAL;
        return NULL;
    }

    BackupCommand *self = calloc(1, sizeof(BackupCommand));
    if (!self) {
        return NULL; /* errno set by calloc */
    }

    /* Populate base interface first. */
    self->base.vt = &backup_command_vtable;

    /* Copy-on-write to ensure safety if the caller's buffer goes away. */
    self->resource_id   = strdup(init->resource_id);
    self->backup_type   = strdup(init->backup_type);
    self->target_bucket = init->target_bucket ? strdup(init->target_bucket) : NULL;
    self->retention     = init->retention_days;
    self->tags          = init->tags ? strdup(init->tags) : NULL;

    if (!self->resource_id || !self->backup_type ||
        (init->target_bucket && !self->target_bucket) ||
        (init->tags && !self->tags))
    {
        backup_command_destroy((Command *)self);
        errno = ENOMEM;
        return NULL;
    }

    return (Command *)self;
}

/*
 * Orchestrate the backup via the provider abstraction.
 */
static int
backup_command_execute(Command *cmd, const CommandCtx *ctx)
{
    BackupCommand   *self = (BackupCommand *)cmd;
    char             errbuf[ERR_MSG_LEN] = {0};

    log_info("[BackupCommand] Starting backup; resource=%s, type=%s, bucket=%s",
             self->resource_id, self->backup_type,
             self->target_bucket ? self->target_bucket : "<default>");

    publish_audit_event(self, "STARTED", "");

    ProviderBackupRequest req = {
        .resource_id   = self->resource_id,
        .backup_type   = self->backup_type,
        .target_bucket = self->target_bucket,
        .retention_days= self->retention,
        .tags          = self->tags,
        .timeout_ms    = ctx ? ctx->timeout_ms : PROVIDER_DEFAULT_TIMEOUT_MS,
    };

    ProviderStatus status = provider_perform_backup(&req, errbuf, sizeof(errbuf));

    if (status == PROVIDER_SUCCESS) {
        log_info("[BackupCommand] Backup completed successfully; resource=%s",
                 self->resource_id);
        publish_audit_event(self, "SUCCEEDED", "");
        return 0;
    }

    /* Non-zero => failure.  Decide if we should bubble up or retry. */
    log_error("[BackupCommand] Backup failed (%s); resource=%s; error=%s",
              provider_status_to_str(status), self->resource_id, errbuf);

    publish_audit_event(self, "FAILED", errbuf);

    if (status == PROVIDER_TRANSIENT_ERROR) {
        /* Hint upstream scheduler that this can be retried. */
        return EAGAIN;
    }

    /* Fatal – do not retry automatically. */
    return EIO;
}

/* Destructor */
static void
backup_command_destroy(Command *cmd)
{
    if (!cmd) return;

    BackupCommand *self = (BackupCommand *)cmd;

    free(self->resource_id);
    free(self->backup_type);
    free(self->target_bucket);
    free(self->tags);

    /* Scrub memory of sensitive data before releasing. */
    memset(self, 0, sizeof(*self));
    free(self);
}

/* ---------------------------------------------------------------------------
 * Unit-test hooks (compile with -DTEST_BACKUP_COMMAND to build)
 * -------------------------------------------------------------------------*/
#ifdef TEST_BACKUP_COMMAND
#include <assert.h>

static void
run_self_test(void)
{
    BackupCommandInit init = {
        .resource_id    = "vol-01234567",
        .backup_type    = "snapshot",
        .target_bucket  = "my-org-backups",
        .retention_days = 30,
        .tags           = "env=prod,owner=ops",
    };

    Command *cmd = backup_command_new(&init);
    assert(cmd);

    CommandCtx ctx = { .timeout_ms = 10 * 1000 };

    /* provider_perform_backup() is mocked in unit tests. */
    int rc = cmd->vt->execute(cmd, &ctx);
    assert(rc == 0);

    cmd->vt->destroy(cmd);
}

int
main(void)
{
    run_self_test();
    puts("BackupCommand self-test passed.");
    return EXIT_SUCCESS;
}
#endif /* TEST_BACKUP_COMMAND */
