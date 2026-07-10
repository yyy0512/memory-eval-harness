/*
 * LambdaUtility Orchestrator
 * File: src/lib/command/config_command.h
 *
 * Description:
 *   Public interface for configuration-management commands used by the
 *   LambdaUtility Orchestrator.  Commands implement a classic Command pattern
 *   and can be linked together (Chain-of-Responsibility) to build complex,
 *   serverless automation pipelines (e.g., download → validate → apply →
 *   audit/notify).
 *
 *   Each command implementation is expected to be stateless and thread-safe,
 *   making it suitable for short-lived, fan-out Lambda invocations.
 *
 * Copyright:
 *   (c) 2024 LambdaUtility Authors — MIT License
 */

#ifndef LUO_CONFIG_COMMAND_H
#define LUO_CONFIG_COMMAND_H

#ifdef __cplusplus
extern "C" {
#endif

/* ───────────────────────────── Dependencies ──────────────────────────────── */
#include <stddef.h>   /* size_t   */
#include <stdint.h>   /* uint*_t  */
#include <stdbool.h>  /* bool     */

/* ────────────────────────────── Constants ────────────────────────────────── */

/* Maximum length for the human-readable lambda/function name. */
#define LUO_FUNC_NAME_MAX      64U

/* ────────────────────────────── Error Codes ─────────────────────────────── */

typedef enum
{
    LUO_CFG_OK                    = 0,   /* Success.                                  */
    LUO_CFG_EINVAL                = -1,  /* Invalid argument.                          */
    LUO_CFG_EEXEC                 = -2,  /* Command execute() returned failure.        */
    LUO_CFG_EVALIDATION           = -3,  /* Validation failed.                         */
    LUO_CFG_EAPPLY                = -4,  /* Apply failed.                              */
    LUO_CFG_EROLLBACK             = -5,  /* Roll-back failed.                          */
    LUO_CFG_ENOIMPL               = -6,  /* Command not implemented.                   */
    LUO_CFG_ECHAIN                = -7,  /* Chain link error (e.g., NULL next).        */
    LUO_CFG_EUNKNOWN              = -128/* Unknown/unspecified error.                 */
} luo_cfg_status_t;

/* ────────────────────────────── Type System ─────────────────────────────── */

/*
 * Individual command types recognised by the orchestration layer.
 * Concrete implementations live in source modules (e.g. config_apply.c).
 */
typedef enum
{
    LUO_CFG_CMD_LOAD_REMOTE = 1,  /* Fetch configuration from remote store.      */
    LUO_CFG_CMD_VALIDATE,         /* Validate syntax & semantic integrity.       */
    LUO_CFG_CMD_APPLY,            /* Apply configuration to target.              */
    LUO_CFG_CMD_ROLLBACK,         /* Restore last-known-good revision.           */
    LUO_CFG_CMD_AUDIT,            /* Persist audit trail & emit notifications.   */
    LUO_CFG_CMD_SENTINEL          /* Must be last. Used for bounds checking.     */
} luo_cfg_cmd_type_t;

/*
 * Execution context shared across the command pipeline.
 * All members are POD to guarantee ABI portability between dynamically
 * loaded Lambda extensions.
 */
typedef struct
{
    char        lambda_name[LUO_FUNC_NAME_MAX]; /* Invoked Lambda/function name.     */
    const char *source_uri;   /* e.g., "s3://bucket/key" or "https://..."          */
    const char *target_path;  /* Local filesystem path for deployment/apply.       */
    uint64_t    timestamp_ms; /* Unix epoch (ms) at orchestrator ingress.          */
    uint32_t    revision;     /* Configuration revision number.                    */
    void       *user_data;    /* Free-for-use pointer shared between commands.     */
} luo_cfg_context_t;

/* Forward declaration for self-referential struct. */
typedef struct luo_cfg_command luo_cfg_command_t;

/* Callback signatures adopted by concrete command implementations. */
typedef luo_cfg_status_t (*luo_cfg_exec_fn)(luo_cfg_command_t *self,
                                            luo_cfg_context_t *ctx);

/* ───────────────────────────── Command Object ───────────────────────────── */

struct luo_cfg_command
{
    luo_cfg_cmd_type_t  type;     /* Identifies the concrete behaviour.          */
    luo_cfg_exec_fn     execute;  /* Mandatory behaviour entry-point.            */
    luo_cfg_command_t  *next;     /* Optional next command (chain).              */
    void               *impl;     /* Implementation-specific opaque pointer.     */
};

/* ─────────────────────── Public Construction API ────────────────────────── */

/*
 * Allocates an empty command shell with the given type.  The caller is
 * responsible for setting `.execute` (and optionally `.impl`) *before* adding
 * the command to a chain or executing it.  Returns NULL on allocation failure.
 */
luo_cfg_command_t *
luo_cfg_command_create(luo_cfg_cmd_type_t type);

/*
 * Releases all resources held by `cmd`.  Note: does *not* recursively free
 * `.next` to avoid accidental chain teardown by unaware callers.
 */
void
luo_cfg_command_destroy(luo_cfg_command_t *cmd);

/* ──────────────────────── Chain Manipulation API ────────────────────────── */

/* Sets `next` as the successor of `current` in the chain. */
luo_cfg_status_t
luo_cfg_command_set_next(luo_cfg_command_t *current,
                         luo_cfg_command_t *next);

/* Retrieves the successor of `current` or NULL if none is set. */
luo_cfg_command_t *
luo_cfg_command_get_next(luo_cfg_command_t *current);

/* ─────────────────────────── Execution Utilities ────────────────────────── */

/*
 * Walks the chain starting at `command`, calling execute() on each node until
 * (a) the chain ends, or (b) a non-zero (failure) status is returned.
 *
 * Returns the first non-OK status encountered or LUO_CFG_OK on success.
 */
luo_cfg_status_t
luo_cfg_command_run(luo_cfg_command_t *command,
                    luo_cfg_context_t *ctx);

/*
 * Human-readable representation of `type` (for logging/metrics).
 * Returns "UNKNOWN" when out of range.
 */
const char *
luo_cfg_cmd_type_str(luo_cfg_cmd_type_t type);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* LUO_CONFIG_COMMAND_H */
