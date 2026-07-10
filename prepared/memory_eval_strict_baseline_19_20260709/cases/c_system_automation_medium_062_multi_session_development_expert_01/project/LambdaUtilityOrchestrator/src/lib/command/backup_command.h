/*
 * backup_command.h
 *
 * Part of: LambdaUtility Orchestrator (system_automation)
 * Copyright: © 2023-2024 LambdaUtility
 *
 * Description:
 *   Concrete “BackupCommand” implementation that fits into the generic
 *   Command/Chain-of-Responsibility pipeline used throughout the project.
 *   The command supports a variety of backup strategies (filesystem, DB
 *   dump, block-device snapshot, object-store sync) and encapsulates all
 *   runtime state required to execute a single, stateless backup job.
 *
 *   Although this is a header, it contains the full implementation using
 *   ‘static inline’ functions so that the command can be consumed without
 *   the need for an accompanying .c translation unit.  Because the Lambda
 *   runtime spins up short-lived, single-purpose processes, the risk of
 *   code-bloat due to multiple includes across compilation units is low
 *   and outweighed by the ergonomics of distribution as a single file.
 *
 * Usage pattern:
 *   backup_command_cfg_t cfg = { .kind  = BACKUP_KIND_FILESYSTEM,
 *                                .source= "/var/www",
 *                                .dest  = "s3://backup-bucket/daily",
 *                                .timeout_sec = 900,
 *                                .retention = { .keep_last_successful = 3 },
 *                                .enable_compression = true,
 *                                .enable_encryption  = false };
 *
 *   backup_command_t *bkp = backup_command_new(&cfg);
 *   command_t        *cmd = backup_command_as_command(bkp);
 *   int rc = cmd->execute(cmd, trigger_event, &err);
 *   cmd->destroy(cmd);
 */

#pragma once

/* ──────────────────────────────────────────────────────────────────────────
 *  Public Includes
 * ────────────────────────────────────────────────────────────────────────── */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

/* Project-internal headers (forward-declared here to keep this file
 * self-contained in case the full project is not available during isolated
 * compilation or static analysis). */
#ifndef COMMAND_INTERFACE_H
#define COMMAND_INTERFACE_H
typedef struct command command_t;

/* Generic command signature compatible with the orchestrator’s pipeline. */
typedef int  (*command_execute_fn)(command_t *self,
                                   const void *event_ctx /* opaque */,
                                   char      **err_msg);

typedef void (*command_destroy_fn)(command_t *self);

struct command
{
    command_execute_fn execute;
    command_destroy_fn destroy;
    /* Concrete commands may extend this struct.  Base members MUST be first. */
};
#endif /* COMMAND_INTERFACE_H */

/* Optional runtime logger abstraction.  If the full project is
 * unavailable, fall back to a noop logger so that this header remains
 * buildable in isolation. */
#ifndef LUO_LOGGER_H
#define LUO_LOGGER_H
#include <stdarg.h>
static inline void luo_log_info (const char *fmt, ...)  { (void)fmt; }
static inline void luo_log_warn (const char *fmt, ...)  { (void)fmt; }
static inline void luo_log_error(const char *fmt, ...)  { (void)fmt; }
#endif /* LUO_LOGGER_H */

/* ──────────────────────────────────────────────────────────────────────────
 *  Error handling helpers
 * ────────────────────────────────────────────────────────────────────────── */
#define BACKUP_SUCCESS            (0)
#define BACKUP_ERR_INVALID_ARGS  (-1)
#define BACKUP_ERR_NOMEM         (-2)
#define BACKUP_ERR_EXEC          (-3)
#define BACKUP_ERR_TIMEOUT       (-4)

/* Converts errno to message and stores it in *err_msg (caller must free). */
static inline void backup_set_syserr(char **err_msg, const char *context)
{
    if (!err_msg) return;
    const char *sys = strerror(errno);
    size_t len = strlen(context) + 3 + strlen(sys) + 1;
    char *msg = (char *)malloc(len);
    if (!msg) return;
    snprintf(msg, len, "%s: %s", context, sys);
    *err_msg = msg;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Public Enums / Structs
 * ────────────────────────────────────────────────────────────────────────── */
typedef enum
{
    BACKUP_KIND_UNKNOWN = 0,
    BACKUP_KIND_FILESYSTEM,
    BACKUP_KIND_DATABASE,
    BACKUP_KIND_BLOCK_SNAPSHOT,
    BACKUP_KIND_OBJECT_STORE_SYNC,
} backup_kind_t;

static inline const char *backup_kind_to_string(backup_kind_t k)
{
    switch (k)
    {
        case BACKUP_KIND_FILESYSTEM:       return "filesystem";
        case BACKUP_KIND_DATABASE:         return "database";
        case BACKUP_KIND_BLOCK_SNAPSHOT:   return "block-snapshot";
        case BACKUP_KIND_OBJECT_STORE_SYNC:return "object-store";
        default:                           return "unknown";
    }
}

typedef struct
{
    uint32_t keep_last_successful;  /* Always retain N most recent successes. */
    uint32_t keep_daily;            /* Retain one per day  for N days.       */
    uint32_t keep_weekly;           /* Retain one per week for N weeks.      */
    uint32_t keep_monthly;          /* Retain one per month for N months.    */
} backup_retention_policy_t;

typedef struct
{
    backup_kind_t            kind;
    const char              *source;             /* e.g. “/var/www”, “db://prod” */
    const char              *dest;               /* e.g. “s3://bucket/path”      */
    uint32_t                 timeout_sec;        /* Hard cutoff – 0 == no limit  */
    backup_retention_policy_t retention;
    bool                     enable_compression;
    bool                     enable_encryption;  /* TODO: integrate KMS/GPG      */
} backup_command_cfg_t;

/* Forward declaration for callers that do not need full details. */
typedef struct backup_command backup_command_t;

/* ──────────────────────────────────────────────────────────────────────────
 *  Public API
 * ────────────────────────────────────────────────────────────────────────── */

/* Factory – returns a fully initialised command or NULL on error. */
static inline backup_command_t *
backup_command_new(const backup_command_cfg_t *cfg);

/* Returns a pointer that can be inserted directly into any command chain. */
static inline command_t *
backup_command_as_command(backup_command_t *self);

/* Direct accessor to the immutable configuration. */
static inline const backup_command_cfg_t *
backup_command_get_cfg(const backup_command_t *self);

/* Destroy and free all resources associated with the command. */
static inline void
backup_command_destroy(backup_command_t *self);

/* Convenience wrapper that bypasses the vtable (unit-test helper). */
static inline int
backup_command_execute(backup_command_t *self,
                       const void       *event_ctx,
                       char            **err_msg);

/* ──────────────────────────────────────────────────────────────────────────
 *  Implementation (opaque to users; only visible because we’re header-only)
 * ────────────────────────────────────────────────────────────────────────── */

/* Concrete struct extends the ‘command’ base interface. */
struct backup_command
{
    command_t               base;   /* MUST be first – enables up-cast */
    backup_command_cfg_t    cfg;    /* Deep-copied at creation.        */
};

/* Forward declarations for internal helpers. */
static int backup_do_filesystem  (const backup_command_t *, char **);
static int backup_do_database    (const backup_command_t *, char **);
static int backup_do_snapshot    (const backup_command_t *, char **);
static int backup_do_object_sync (const backup_command_t *, char **);

/* Vtable implementations – declared static so they are TU-local. */
static int
backup_command_execute_internal(command_t *cmd,
                                const void *event_ctx,
                                char **err_msg)
{
    (void)event_ctx; /* Currently unused; kept for future trigger metadata */

    if (!cmd) return BACKUP_ERR_INVALID_ARGS;
    backup_command_t *self = (backup_command_t *)cmd;

    int rc;
    switch (self->cfg.kind)
    {
        case BACKUP_KIND_FILESYSTEM:        rc = backup_do_filesystem (self, err_msg); break;
        case BACKUP_KIND_DATABASE:          rc = backup_do_database   (self, err_msg); break;
        case BACKUP_KIND_BLOCK_SNAPSHOT:    rc = backup_do_snapshot   (self, err_msg); break;
        case BACKUP_KIND_OBJECT_STORE_SYNC: rc = backup_do_object_sync(self, err_msg); break;
        default:
            if (err_msg) *err_msg = strdup("Unsupported backup kind");
            rc = BACKUP_ERR_INVALID_ARGS;
    }
    return rc;
}

static void
backup_command_destroy_internal(command_t *cmd)
{
    if (!cmd) return;
    backup_command_t *self = (backup_command_t *)cmd;
    /* No deep allocations inside cfg that we own – nothing special to free. */
    free(self);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Public inline definitions
 * ────────────────────────────────────────────────────────────────────────── */
static inline backup_command_t *
backup_command_new(const backup_command_cfg_t *cfg)
{
    if (!cfg || !cfg->source || !cfg->dest)
    {
        luo_log_error("[backup_command] invalid configuration");
        return NULL;
    }

    backup_command_t *self = (backup_command_t *)calloc(1, sizeof(*self));
    if (!self)
    {
        luo_log_error("[backup_command] OOM allocating command");
        return NULL;
    }

    /* Copy user-supplied config verbatim – pointers remain owned by caller. */
    memcpy(&self->cfg, cfg, sizeof(*cfg));

    /* Hook up vtable. */
    self->base.execute = backup_command_execute_internal;
    self->base.destroy = backup_command_destroy_internal;

    return self;
}

static inline command_t *
backup_command_as_command(backup_command_t *self)
{
    return self ? &self->base : NULL;
}

static inline const backup_command_cfg_t *
backup_command_get_cfg(const backup_command_t *self)
{
    return self ? &self->cfg : NULL;
}

static inline void
backup_command_destroy(backup_command_t *self)
{
    if (!self) return;
    self->base.destroy(&self->base);
}

static inline int
backup_command_execute(backup_command_t *self,
                       const void       *event_ctx,
                       char            **err_msg)
{
    return self ? self->base.execute(&self->base, event_ctx, err_msg)
                : BACKUP_ERR_INVALID_ARGS;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Internal helper implementations (very simplified reference versions)
 *  In production these would leverage async I/O, streaming compression,
 *  progress callbacks, and configurable transport layers.
 * ────────────────────────────────────────────────────────────────────────── */

static int
backup_spawn_process(const char *cmd, char **err_msg)
{
    luo_log_info("[backup_command] Executing: %s", cmd);
    int rc = system(cmd);
    if (rc == -1)
    {
        backup_set_syserr(err_msg, "system()");
        return BACKUP_ERR_EXEC;
    }
    else if (rc != 0)
    {
        if (err_msg)
        {
            size_t len = 64 + strlen(cmd);
            char *msg = (char *)malloc(len);
            if (msg) snprintf(msg, len, "Process exited with status %d: %s", rc, cmd);
            *err_msg = msg;
        }
        return BACKUP_ERR_EXEC;
    }
    return BACKUP_SUCCESS;
}

static int
backup_do_filesystem(const backup_command_t *self, char **err_msg)
{
    char cmd[4096];
    const char *compression_flag = self->cfg.enable_compression ? "z" : "";
    /* Example: tar -c[ z ]f /dest/backup.tar.gz /source */
    snprintf(cmd, sizeof(cmd),
             "tar -c%sf \"%s/backup_$(date +%%Y%%m%%dT%%H%%M%%S).tar%s\" -C \"%s\" .",
             compression_flag,
             self->cfg.dest,
             self->cfg.enable_compression ? ".gz" : "",
             self->cfg.source);

    return backup_spawn_process(cmd, err_msg);
}

static int
backup_do_database(const backup_command_t *self, char **err_msg)
{
    /* Very naive reference implementation.  Real code would discover DB
     * credentials via IAM/kms, stream directly to S3, etc. */
    char cmd[4096];
    snprintf(cmd, sizeof(cmd),
             "pg_dump \"%s\" | gzip > \"%s/db_$(date +%%Y%%m%%dT%%H%%M%%S).sql.gz\"",
             self->cfg.source, self->cfg.dest);

    return backup_spawn_process(cmd, err_msg);
}

static int
backup_do_snapshot(const backup_command_t *self, char **err_msg)
{
    /* Placeholder for block-device snapshot (e.g., EBS in AWS). */
    (void)self;
    if (err_msg) *err_msg = strdup("Snapshot backups not yet implemented");
    return BACKUP_ERR_EXEC;
}

static int
backup_do_object_sync(const backup_command_t *self, char **err_msg)
{
    /* Simple rsync-to-object-store via ‘aws s3 sync’. */
    char cmd[4096];
    snprintf(cmd, sizeof(cmd),
             "aws s3 sync \"%s\" \"%s\" --storage-class STANDARD_IA",
             self->cfg.source, self->cfg.dest);

    return backup_spawn_process(cmd, err_msg);
}
