/**
 * PulseSphere – Real-Time Social Pulse Streaming Platform
 * -------------------------------------------------------
 * File:    validator.h
 * Project: Validation Service
 * License: Apache-2.0
 *
 * Public interface for the schema-on-read validation subsystem used by the
 * Validation-Service micro-service.  The validator is responsible for:
 *
 *   • Fast, light-weight conformance checks of incoming JSON pulses
 *   • Pluggable rule engine (Strategy Pattern) for business-logic validation
 *   • Emitting rich diagnostics for observability / tracing
 *   • Thread-safe operation with zero-copy read-only buffers
 *
 * The implementation leverages a two-tier approach:
 *
 *   1. Structural validation against a pre-compiled, immutable schema
 *   2. Optional custom rule predicates that can be registered at runtime
 *
 * NOTE:
 *  ‑ This header purposefully hides internal details by exposing only opaque
 *    handles.  This allows the ABI to remain stable across service releases.
 */

#ifndef PULSPHERE_VALIDATION_SERVICE_VALIDATOR_H
#define PULSPHERE_VALIDATION_SERVICE_VALIDATOR_H

/* ------------------------------------------------------------------------- */
/* System / STL                                                              */
/* ------------------------------------------------------------------------- */
#include <stddef.h>     /* size_t   */
#include <stdint.h>     /* uint32_t */
#include <stdbool.h>    /* bool     */

#ifdef __cplusplus
extern "C" {
#endif

/* ------------------------------------------------------------------------- */
/* Build Configuration                                                       */
/* ------------------------------------------------------------------------- */

/* Default maximum length (in bytes) for error/diagnostic strings. */
#ifndef PULSE_VALIDATOR_MAX_DIAG_LEN
#define PULSE_VALIDATOR_MAX_DIAG_LEN 512
#endif

/* API visibility for shared libraries. */
#if defined(_WIN32) && defined(PULSESHPERE_DLL_EXPORT)
#   define PS_VALIDATOR_API __declspec(dllexport)
#elif defined(_WIN32)
#   define PS_VALIDATOR_API __declspec(dllimport)
#else
#   define PS_VALIDATOR_API __attribute__((visibility("default")))
#endif

/* ------------------------------------------------------------------------- */
/* Forward Declarations                                                      */
/* ------------------------------------------------------------------------- */
typedef struct ps_validator      ps_validator_t;   /* Opaque context handle   */
typedef struct ps_validation_ctx ps_validation_ctx_t; /* Execution context   */

/* ------------------------------------------------------------------------- */
/* Enumerations                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Validation severity levels map 1-to-1 to the platform’s tracing system.
 */
typedef enum {
    PS_VAL_SEVERITY_INFO     = 0,
    PS_VAL_SEVERITY_WARNING  = 1,
    PS_VAL_SEVERITY_ERROR    = 2,
    PS_VAL_SEVERITY_CRITICAL = 3
} ps_val_severity_e;

/**
 * Error codes returned by the validator API.
 */
typedef enum {
    PS_VAL_OK                 = 0,  /* Success                         */
    PS_VAL_E_INVALID_SCHEMA   = 1,  /* Malformed or missing schema     */
    PS_VAL_E_SCHEMA_MISMATCH  = 2,  /* Event failed structural check   */
    PS_VAL_E_RULE_FAILURE     = 3,  /* Custom rule indicated failure   */
    PS_VAL_E_MEMORY           = 4,  /* Memory allocation issue         */
    PS_VAL_E_IO               = 5,  /* I/O error while loading schema  */
    PS_VAL_E_INTERNAL         = 6,  /* Unexpected internal failure     */
    PS_VAL_E_BAD_ARG          = 7,  /* Invalid argument passed in      */
    PS_VAL_E_UNINITIALIZED    = 8   /* Library not initialized         */
} ps_val_rc_e;

/* ------------------------------------------------------------------------- */
/* Type-Safe Callbacks                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Signature for custom validation rule functions.
 *
 * @param  ctx        Current validation context (opaque).
 * @param  user_data  Arbitrary user pointer supplied during registration.
 * @param  diag_buf   Buffer to populate with human readable diagnostics.
 * @param  diag_len   Size of diag_buf in bytes.
 *
 * @return true  – Validation rule PASSED
 *         false – Validation rule FAILED (populate diag_buf)
 */
typedef bool (*ps_val_rule_fn)(
        ps_validation_ctx_t *ctx,
        void                *user_data,
        char                *diag_buf,
        size_t               diag_len);

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Initialize global resources required by the validator subsystem.
 *
 * Thread-safe and idempotent; incrementally counts callers.
 *
 * @return PS_VAL_OK on success or an error code on failure.
 */
PS_VALIDATOR_API
ps_val_rc_e
ps_validator_global_init(void);

/**
 * Release global resources.  Should be paired with ps_validator_global_init().
 */
PS_VALIDATOR_API
void
ps_validator_global_shutdown(void);

/**
 * Create a new validator context by loading a pre-compiled schema artifact.
 *
 * @param  schema_path   Filesystem path or URI to a binary schema blob.
 * @param  flags         Reserved for future toggles (must be 0 for now).
 * @param  out_validator Receives allocated handle on success.
 *
 * @return PS_VAL_OK on success, or an error code on failure.
 *
 * The returned handle must be freed with ps_validator_destroy().
 */
PS_VALIDATOR_API
ps_val_rc_e
ps_validator_create(const char  *schema_path,
                    uint32_t     flags,
                    ps_validator_t **out_validator);

/**
 * Destroy a validator instance and free associated resources.
 *
 * Safe to call with NULL.
 */
PS_VALIDATOR_API
void
ps_validator_destroy(ps_validator_t *validator);

/**
 * Register a custom rule predicate at runtime.
 *
 * @param validator  Handle obtained via ps_validator_create().
 * @param rule_fn    User-provided predicate (cannot be NULL).
 * @param user_data  Opaque pointer passed back during rule execution.
 *
 * Rules are evaluated in FIFO order after structural validation succeeds.
 *
 * @return PS_VAL_OK on success or error code.
 */
PS_VALIDATOR_API
ps_val_rc_e
ps_validator_add_rule(ps_validator_t *validator,
                      ps_val_rule_fn   rule_fn,
                      void            *user_data);

/**
 * Validate an incoming JSON payload against the loaded schema and custom
 * rules.  The payload buffer *is not* modified and *need not* be NUL-terminated.
 *
 * @param validator   A valid handle.
 * @param json_buf    Pointer to UTF-8 JSON bytes.
 * @param json_len    Length of json_buf in bytes.
 * @param diag_buf    Optional buffer to receive diagnostics.
 * @param diag_len    Size of diag_buf; can be 0 if diag_buf is NULL.
 *
 * @return PS_VAL_OK if event is valid, or a specific error code.
 *
 * On failure, diag_buf will contain a concise description (if provided).
 */
PS_VALIDATOR_API
ps_val_rc_e
ps_validator_validate(ps_validator_t *validator,
                      const char     *json_buf,
                      size_t          json_len,
                      char           *diag_buf,
                      size_t          diag_len);

/* ------------------------------------------------------------------------- */
/* Validation Context Introspection Helpers                                  */
/* ------------------------------------------------------------------------- */

/**
 * Safe accessor utility for retrieving a JSON string field by name
 * from the current validation context.  The pointer is valid only for
 * the lifetime of the validation call.
 *
 * Returns NULL if field does not exist or is not a string.
 */
PS_VALIDATOR_API
const char *
ps_val_ctx_get_string(ps_validation_ctx_t *ctx, const char *field_name);

/**
 * Retrieve a 64-bit integer field from the context.  Returns true on success.
 */
PS_VALIDATOR_API
bool
ps_val_ctx_get_int64(ps_validation_ctx_t *ctx,
                     const char          *field_name,
                     int64_t             *out_value);

/**
 * Fetch a boolean field from the context.  Returns false if missing
 * or not a boolean value.
 */
PS_VALIDATOR_API
bool
ps_val_ctx_get_bool(ps_validation_ctx_t *ctx, const char *field_name);

/* ------------------------------------------------------------------------- */
/* Utility Helpers                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Convert an error code to a human-readable string literal.
 */
PS_VALIDATOR_API
const char *
ps_validator_strerror(ps_val_rc_e rc);

/* ------------------------------------------------------------------------- */

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* PULSPHERE_VALIDATION_SERVICE_VALIDATOR_H */
