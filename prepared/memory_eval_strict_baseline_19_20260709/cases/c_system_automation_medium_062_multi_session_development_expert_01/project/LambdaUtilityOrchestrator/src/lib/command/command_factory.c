/*
 * LambdaUtility Orchestrator
 * File: src/lib/command/command_factory.c
 *
 * Copyright (c) 2024 LambdaUtility
 *
 * Implementation of the Command Factory—a dynamic registry that maps command
 * identifiers to builder callbacks.  Each concrete command implementation
 * registers itself through the public API
 *
 *      int command_factory_register(const char *name,
 *                                   command_builder_fn builder);
 *
 * so that at runtime the dispatcher can create the proper Command object via
 *
 *      Command *cmd = command_factory_create("backup.snapshot",
 *                                            "{ ... json payload ... }",
 *                                            &error_string);
 *
 * The registry is protected by a pthread read-write lock to allow highly
 * concurrent read access while serialising rare write operations (command
 * registration typically happens during process start-up via constructor
 * attributes).
 *
 * The factory is intentionally kept small and dependency-free—parsing,
 * validation, and execution logic live in each concrete command.  Only the
 * opaque Command type (defined in command.h) is surfaced to callers.
 */

#include "command_factory.h"  /* public header for this module              */
#include "command.h"          /* opaque Command interface                   */

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>


/* --------------------------------------------------------------------------
 * Internal helpers & definitions
 * -------------------------------------------------------------------------- */

/* Logger macro: kept simple to avoid dragging in a full logging framework.
 * Production builds can redirect this to syslog or a structured logger.
 */
#ifndef CMD_Factory_LOG
#define CMD_Factory_LOG(level, fmt, ...) \
    fprintf(stderr, "[command_factory:%s] " fmt "\n", level, ##__VA_ARGS__)
#endif /* CMD_Factory_LOG */

/* Registry entry linking a canonical command name to its builder function */
struct registry_entry
{
    char                 *name;     /* canonical identifier, e.g. "cfg.push"     */
    command_builder_fn    builder;  /* callback that returns a fully-formed cmd  */
    struct registry_entry *next;    /* singly-linked list                        */
};

/* Head of the registry list; guarded by rwlock */
static struct registry_entry *g_registry_head = NULL;

/* Reader/writer lock – allows multiple concurrent look-ups */
static pthread_rwlock_t g_registry_lock = PTHREAD_RWLOCK_INITIALIZER;


/* Duplicate a NUL-terminated string, die if OOM (factory must stay up) */
static char *
xstrdup(const char *s)
{
    char *dup = strdup(s);
    if (!dup) {
        CMD_Factory_LOG("fatal", "Out of memory duplicating string");
        abort();
    }
    return dup;
}


/* --------------------------------------------------------------------------
 * Public API implementation
 * -------------------------------------------------------------------------- */

/*
 * command_factory_register
 *
 * Register a new command builder for the given canonical name.  Returns 0 on
 * success, -1 on error (sets errno to EEXIST if a duplicate is detected).
 * The function is thread-safe.
 */
int
command_factory_register(const char *command_name, command_builder_fn builder)
{
    if (!command_name || !*command_name || !builder) {
        errno = EINVAL;
        return -1;
    }

    /* Acquire write lock – registration is infrequent */
    pthread_rwlock_wrlock(&g_registry_lock);

    /* Check for duplicates first */
    struct registry_entry *iter = g_registry_head;
    while (iter) {
        if (strcmp(iter->name, command_name) == 0) {
            pthread_rwlock_unlock(&g_registry_lock);
            errno = EEXIST;
            return -1;
        }
        iter = iter->next;
    }

    /* Allocate and insert at head (O(1)) */
    struct registry_entry *entry = calloc(1, sizeof(*entry));
    if (!entry) {
        pthread_rwlock_unlock(&g_registry_lock);
        errno = ENOMEM;
        return -1;
    }
    entry->name    = xstrdup(command_name);
    entry->builder = builder;
    entry->next    = g_registry_head;
    g_registry_head = entry;

    pthread_rwlock_unlock(&g_registry_lock);
    CMD_Factory_LOG("info", "Registered command '%s'", command_name);
    return 0;
}


/*
 * command_factory_create
 *
 * Look up the builder for the provided command name and invoke it with the
 * supplied payload.  If an error string pointer is provided, it will be filled
 * with a heap-allocated, human-readable message that the caller must free().
 *
 * Returns a new Command instance on success or NULL on failure.
 */
Command *
command_factory_create(const char *command_name,
                       const char *payload,
                       char      **error_out)
{
    if (error_out)
        *error_out = NULL;

    if (!command_name || !*command_name) {
        errno = EINVAL;
        return NULL;
    }

    /* Acquire read lock – allows concurrent creations */
    pthread_rwlock_rdlock(&g_registry_lock);

    struct registry_entry *iter = g_registry_head;
    while (iter && strcmp(iter->name, command_name) != 0)
        iter = iter->next;

    if (!iter) {
        pthread_rwlock_unlock(&g_registry_lock);
        errno = ENOENT;
        if (error_out)
            *error_out = xstrdup("Command not registered");
        return NULL;
    }

    command_builder_fn builder = iter->builder;

    /* Drop the lock before invoking user code (builder may register others) */
    pthread_rwlock_unlock(&g_registry_lock);

    char *builder_err = NULL;
    Command *cmd      = builder(payload, &builder_err);

    if (!cmd) {
        /* Builder already sets errno; just propagate human message */
        if (builder_err && error_out) {
            *error_out = builder_err;
        } else if (builder_err) {
            /* Caller discards errors – prevent leak */
            free(builder_err);
        }
        return NULL;
    }

    /* Success */
    if (builder_err)  /* Builder returned cmd but also warning message */
    {
        CMD_Factory_LOG("warn",
                        "Command '%s' built with warning: %s",
                        command_name,
                        builder_err);
        free(builder_err);
    }
    return cmd;
}


/*
 * command_factory_teardown
 *
 * Release all registry resources.  Should be called from the main shutdown
 * path or, in the case of serverless, just before the runtime exits.
 */
void
command_factory_teardown(void)
{
    pthread_rwlock_wrlock(&g_registry_lock);

    struct registry_entry *iter = g_registry_head;
    while (iter) {
        struct registry_entry *next = iter->next;
        free(iter->name);
        free(iter);
        iter = next;
    }
    g_registry_head = NULL;

    pthread_rwlock_unlock(&g_registry_lock);
}


/* --------------------------------------------------------------------------
 * Convenience functions for automatic self-registration
 * -------------------------------------------------------------------------- */

/*
 * Helper macro for command implementations:
 *
 *     static Command *my_builder(const char *payload, char **err) { ... }
 *     REGISTER_COMMAND("my.command", my_builder);
 *
 * must be used in .c files that implement the concrete command.  The macro
 * expands to a constructor attribute that registers the builder before main()
 * is reached.  This keeps registration declarative and avoids hard-coding all
 * command names in a single place.
 */
#ifdef __GNUC__
#define REGISTER_COMMAND(name_str, builder_fn)                                \
    static void __register_##builder_fn(void) __attribute__((constructor));   \
    static void __register_##builder_fn(void)                                 \
    {                                                                         \
        if (command_factory_register(name_str, builder_fn) != 0) {           \
            /* Can't do much here – just log; program may still continue  */   \
            CMD_Factory_LOG("error",                                          \
                            "Failed to register command '%s': %s",            \
                            name_str,                                         \
                            strerror(errno));                                 \
        }                                                                     \
    }
#else
/* Fallback – require explicit call when constructor attribute unavailable */
#warning "Constructor attribute not supported; automatic registration disabled."
#define REGISTER_COMMAND(name_str, builder_fn)
#endif /* __GNUC__ */


/* --------------------------------------------------------------------------
 * Optionally expose the helper macro via header
 * -------------------------------------------------------------------------- */

#ifndef COMMAND_FACTORY_EXPOSE_REGISTER_MACRO
#define COMMAND_FACTORY_EXPOSE_REGISTER_MACRO
#endif /* COMMAND_FACTORY_EXPOSE_REGISTER_MACRO */


/* --------------------------------------------------------------------------
 * End of file
 * -------------------------------------------------------------------------- */
