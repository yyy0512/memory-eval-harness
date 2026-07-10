#ifndef LU_COMMAND_H
#define LU_COMMAND_H
/*
 * LambdaUtility Orchestrator
 * File: command.h
 *
 * Public Command interface used by the Command and Chain-of-Responsibility
 * layers.  All concrete automation actions (alert, deploy, backup, etc.)
 * must derive from this interface by embedding lu_command_t as their first
 * struct member and populating an instance-specific virtual-table.
 *
 * The API is designed to be thread-safe, re-entrant, and allocation-agnostic
 * to allow seamless execution inside short-lived serverless runtimes.
 *
 * Copyright (c) 2024  LambdaUtility
 */

#include <stddef.h>     /* size_t   */
#include <stdint.h>     /* uint64_t */
#include <stdbool.h>    /* bool     */

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 *  API visibility & attributes
 * -------------------------------------------------------------------------- */
#if defined(_WIN32) || defined(_WIN64)
#  ifdef LU_EXPORTS
#    define LU_API __declspec(dllexport)
#  else
#    define LU_API __declspec(dllimport)
#  endif
#else
#  define LU_API __attribute__((visibility("default")))
#endif

#define LU_NODISCARD __attribute__((warn_unused_result))

/* --------------------------------------------------------------------------
 *  Error / status codes returned by commands.
 *  Positive  values are non-fatal, negative values are fatal errors.
 * -------------------------------------------------------------------------- */
typedef enum {
    LU_CMD_OK                   =  0,
    LU_CMD_PARTIAL              =  1,    /* Executed but with ignorable warnings */
    LU_CMD_RETRY_LATER          =  2,    /* Transient failure – re-queue allowed */

    LU_CMD_ERR_GENERIC          = -1,
    LU_CMD_ERR_INVALID_ARG      = -2,
    LU_CMD_ERR_OOM              = -3,
    LU_CMD_ERR_TIMEOUT          = -4,
    LU_CMD_ERR_NOT_IMPLEMENTED  = -5,
    LU_CMD_ERR_IO               = -6,
    LU_CMD_ERR_SERIALIZATION    = -7
} lu_cmd_status_t;

/* --------------------------------------------------------------------------
 *  High-level category used for metrics, tracing, and RBAC.
 * -------------------------------------------------------------------------- */
typedef enum {
    LU_CMD_CATEGORY_ALERTING        = 0,
    LU_CMD_CATEGORY_CONFIG_MGMT     = 1,
    LU_CMD_CATEGORY_BACKUP          = 2,
    LU_CMD_CATEGORY_DEPLOYMENT      = 3,
    LU_CMD_CATEGORY_METRICS         = 4,
    LU_CMD_CATEGORY_CUSTOM          = 1000
} lu_cmd_category_t;

/* --------------------------------------------------------------------------
 *  Opaque forward declarations
 * -------------------------------------------------------------------------- */
typedef struct lu_context  lu_context_t;   /* Execution context – logger, KV-cache, etc. */
typedef struct lu_command  lu_command_t;   /* Generic command object                    */

/* --------------------------------------------------------------------------
 *  Metadata baked into every command instance for observability.
 * -------------------------------------------------------------------------- */
typedef struct {
    char                id[36];            /* UUID v4 – null-terminated string         */
    char                correlation_id[36];
    lu_cmd_category_t   category;
    uint64_t            created_epoch_ms;  /* Unix epoch (ms)                          */
    uint32_t            flags;             /* Implementation-defined bit-flags         */
} lu_cmd_meta_t;

/* --------------------------------------------------------------------------
 *  Virtual table – “methods” every concrete command may implement.
 *  All functions must be idempotent unless explicitly documented otherwise.
 * -------------------------------------------------------------------------- */
typedef struct lu_command_vtbl {
    /* Validate & pre-compute resources.  May allocate memory. */
    LU_NODISCARD lu_cmd_status_t (*prepare)(
        lu_command_t      *self,
        lu_context_t      *ctx,
        const char        *payload_json); /* UTF-8 JSON payload (may be NULL) */

    /* Main execution routine – must be side-effect free on failure. */
    LU_NODISCARD lu_cmd_status_t (*execute)(
        lu_command_t      *self,
        lu_context_t      *ctx);

    /* Optional rollback hook – invoked only if execute() failed. */
    LU_NODISCARD lu_cmd_status_t (*rollback)(
        lu_command_t      *self,
        lu_context_t      *ctx);

    /* Serialize successful result to JSON for downstream consumers. */
    LU_NODISCARD lu_cmd_status_t (*serialize_result)(
        lu_command_t      *self,
        char             **out_json);      /* Allocated with malloc(); caller frees. */

    /* Destructor – frees all resources, including the command itself. */
    void (*destroy)(lu_command_t *self);
} lu_command_vtbl_t;

/* --------------------------------------------------------------------------
 *  Base command object – MUST be first member in derived structs.
 * -------------------------------------------------------------------------- */
struct lu_command {
    lu_cmd_meta_t              meta;
    lu_context_t              *ctx;   /* Populated automatically during prepare() */
    const lu_command_vtbl_t   *vptr;  /* Virtual table – never NULL after create  */
    /* Concrete implementation extends beyond this point (flexible array). */
};

/* --------------------------------------------------------------------------
 *  Helper wrapper functions – operate like virtual methods in OOP.
 * -------------------------------------------------------------------------- */
static inline lu_cmd_status_t
lu_command_prepare(lu_command_t *cmd, lu_context_t *ctx, const char *payload_json)
{
    if (!cmd || !cmd->vptr || !cmd->vptr->prepare) return LU_CMD_ERR_INVALID_ARG;
    return cmd->vptr->prepare(cmd, ctx, payload_json);
}

static inline lu_cmd_status_t
lu_command_execute(lu_command_t *cmd, lu_context_t *ctx)
{
    if (!cmd || !cmd->vptr || !cmd->vptr->execute) return LU_CMD_ERR_INVALID_ARG;
    return cmd->vptr->execute(cmd, ctx);
}

static inline lu_cmd_status_t
lu_command_rollback(lu_command_t *cmd, lu_context_t *ctx)
{
    if (!cmd || !cmd->vptr || !cmd->vptr->rollback) return LU_CMD_ERR_INVALID_ARG;
    return cmd->vptr->rollback(cmd, ctx);
}

static inline lu_cmd_status_t
lu_command_serialize_result(lu_command_t *cmd, char **out_json)
{
    if (!cmd || !cmd->vptr || !cmd->vptr->serialize_result) return LU_CMD_ERR_INVALID_ARG;
    return cmd->vptr->serialize_result(cmd, out_json);
}

static inline void
lu_command_destroy(lu_command_t *cmd)
{
    if (cmd && cmd->vptr && cmd->vptr->destroy)
        cmd->vptr->destroy(cmd);
}

/* --------------------------------------------------------------------------
 *  Factory utility – allocates a command object with `impl_size` bytes
 *  of additional storage for the concrete implementation.  The caller
 *  receives an initialized lu_command_t pointer ready for vtbl population.
 *
 *  impl_size must be ≥ sizeof(concrete_struct) ‑ sizeof(lu_command_t).
 * -------------------------------------------------------------------------- */
LU_API lu_command_t *
lu_command_create(size_t                impl_size,
                  const lu_command_vtbl_t *vptr,
                  lu_cmd_category_t      category) LU_NODISCARD;

/* --------------------------------------------------------------------------
 *  Miscellaneous helpers shared across the project.
 * -------------------------------------------------------------------------- */

/* Generate RFC-4122 v4 UUID – out buffer must be at least 36 + 1 bytes. */
LU_API int  lu_generate_uuid(char out[36]) LU_NODISCARD;

/* Millisecond-precision clock for telemetry. */
LU_API uint64_t lu_epoch_ms(void) LU_NODISCARD;

#ifdef __cplusplus
} /* extern "C" */
#endif
#endif /* LU_COMMAND_H */
