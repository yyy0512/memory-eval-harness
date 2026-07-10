/*
 *  LambdaUtility Orchestrator
 *  --------------------------
 *  command_factory.h
 *
 *  Copyright (c) 2024 LambdaUtility.
 *
 *  Distributed under the MIT license.  See LICENSE for details.
 *
 *  Description:
 *      Public interface for the Command Factory subsystem.  The factory’s job
 *      is to translate arbitrary event triggers (e.g., SNS topics, RESTful
 *      endpoints, or cron expressions) into concrete Command objects that
 *      implement the “command” contract defined in command.h.  This allows the
 *      higher-level dispatcher to remain agnostic of the underlying automation
 *      logic while still supporting runtime extensibility.
 *
 *      The factory is thread-safe: registration and look-ups are protected by
 *      an internal reader–writer lock so that new Command types can be added
 *      at runtime without blocking concurrent invocations.
 */

#ifndef LUO_COMMAND_FACTORY_H
#define LUO_COMMAND_FACTORY_H

/* ────────────── Includes ─────────────────────────────────────────────────── */
#include <stdbool.h>            /* bool                                     */
#include <stddef.h>             /* size_t                                   */
#include <stdint.h>             /* uint32_t, etc.                           */

#include <jansson.h>            /* JSON parsing for event payloads          */

#include "command.h"            /* Base Command interface                   */

#ifdef __cplusplus
extern "C" {
#endif

/* ────────────── Public Constants ────────────────────────────────────────── */

/* Error codes returned by the factory API.  These are intentionally kept
 * distinct from errno to avoid cross-contamination with libc calls. */
typedef enum
{
    CMD_FACTORY_OK           = 0,   /* Success                                 */
    CMD_FACTORY_ENOMEM       = 1,   /* Memory allocation failure               */
    CMD_FACTORY_EINVAL       = 2,   /* Invalid argument                        */
    CMD_FACTORY_ENOTFOUND    = 3,   /* No matching creator registered          */
    CMD_FACTORY_EEXISTS      = 4,   /* Creator for trigger already registered  */
    CMD_FACTORY_EINIT        = 5,   /* Factory not initialized                 */
    CMD_FACTORY_EUNKNOWN     = 6    /* Catch-all                               */
} cmd_factory_err_t;


/* ────────────── Opaque Types ─────────────────────────────────────────────── */

/* Forward declaration of the internal factory state. */
typedef struct cmd_factory_s cmd_factory_t;

/*
 * Signature for user-provided creator callbacks.  The function receives the
 * original JSON payload (ownership not transferred; treat as read-only) and
 * must return a heap-allocated Command instance or NULL on failure.
 *
 * All returned Command objects *must* adhere to the contract described in
 * command.h: execute(), destroy(), and optional serialize()/deserialize().
 */
typedef command_t *(*command_creator_fn)(const json_t *payload);


/* ────────────── API ─────────────────────────────────────────────────────── */

/*
 * cmd_factory_init
 * -----------------------------------------------------------------------------
 *  Initialize the Command Factory subsystem.  Must be called exactly once
 *  during process start-up before any create/lookup operations are attempted.
 *
 * Returns:
 *  true  — Initialization succeeded.
 *  false — Initialization failed (check logs for specifics).
 */
bool
cmd_factory_init(void);


/*
 * cmd_factory_cleanup
 * -----------------------------------------------------------------------------
 *  Shut down the Command Factory subsystem, releasing all resources and
 *  deregistering every custom command creator.  Calling this while any Command
 *  instances produced by the factory are still alive results in undefined
 *  behavior.
 */
void
cmd_factory_cleanup(void);


/*
 * cmd_factory_register
 * -----------------------------------------------------------------------------
 *  Register a new command creator for the supplied trigger string.  A trigger
 *  is an arbitrary, case-sensitive identifier that originates from the
 *  dispatcher layer (e.g., "config.push.nginx", "backup.snapshot.rds").
 *
 *  The creator callback MUST be thread-safe and reentrant because the factory
 *  can invoke it concurrently from multiple Lambda invocations.
 *
 * Params:
 *  trigger   — Non-NULL, non-empty C-string identifying the command.
 *  creator   — Non-NULL pointer to a creator function.
 *
 * Returns:
 *  CMD_FACTORY_OK         — Registration successful.
 *  CMD_FACTORY_EEXISTS    — Trigger already registered; old creator untouched.
 *  CMD_FACTORY_EINVAL     — Invalid arguments.
 *  CMD_FACTORY_EINIT      — Factory not initialized.
 *  CMD_FACTORY_ENOMEM     — Internal allocation failure.
 */
cmd_factory_err_t
cmd_factory_register(const char           *trigger,
                     command_creator_fn    creator);


/*
 * cmd_factory_unregister
 * -----------------------------------------------------------------------------
 *  Remove a previously registered trigger.  If the trigger was never
 *  registered, this is treated as a no-op (returns CMD_FACTORY_ENOTFOUND).
 *
 * Params:
 *  trigger — Identifier passed to cmd_factory_register earlier.
 *
 * Returns:
 *  CMD_FACTORY_OK       — Unregistration successful.
 *  CMD_FACTORY_ENOTFOUND— Trigger not present.
 *  CMD_FACTORY_EINIT    — Factory not initialized.
 */
cmd_factory_err_t
cmd_factory_unregister(const char *trigger);


/*
 * cmd_factory_create
 * -----------------------------------------------------------------------------
 *  Produce a concrete Command instance for the given trigger.  Ownership of
 *  the returned object is transferred to the caller, who is responsible for
 *  invoking destroy() when finished.
 *
 * Params:
 *  trigger       — Non-NULL trigger used during registration.
 *  event_payload — Optional JSON payload; may be NULL if not needed.
 *  err_code_out  — Optional pointer to receive error code.  On success,
 *                  *err_code_out is set to CMD_FACTORY_OK.  On failure,
 *                  *err_code_out is set accordingly, and NULL is returned.
 *
 * Returns:
 *  Pointer to a heap-allocated Command object on success; NULL on failure.
 */
command_t *
cmd_factory_create(const char  *trigger,
                   const json_t *event_payload,
                   cmd_factory_err_t *err_code_out);


/* ────────────── Helper Macro for Static Registration ───────────────────────
 *
 *  LUO_REGISTER_COMMAND(trigger, fn)
 *  ---------------------------------
 *  Convenience macro that leverages the constructor attribute (GCC/Clang) to
 *  automatically register a command creator at shared-object/library load time.
 *  This enables plug-in style extensibility where merely linking the new
 *  command into the final binary causes it to become discoverable by the
 *  factory, without any manual init code.
 *
 *  Usage example:
 *
 *      static command_t *my_creator(const json_t *payload) { ... }
 *      LUO_REGISTER_COMMAND("my.trigger", my_creator);
 *
 *  NOTE: On platforms that do not support constructor attributes, you must
 *  call cmd_factory_register() manually from your module’s init routine.
 */
#if defined(__GNUC__) || defined(__clang__)
#define LUO_REGISTER_COMMAND(_trigger, _fn)                           \
    static void __cmd_reg_##_fn(void) __attribute__((constructor));   \
    static void __cmd_reg_##_fn(void)                                 \
    {                                                                 \
        cmd_factory_err_t __err = cmd_factory_register((_trigger), (_fn)); \
        (void)__err; /* swallow error; logging is done internally */  \
    }
#else
#   define LUO_REGISTER_COMMAND(_trigger, _fn) /* constructor not supported */
#endif


#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* LUO_COMMAND_FACTORY_H */
