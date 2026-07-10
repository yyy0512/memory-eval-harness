/*
 * PulseSphere Enrichment Service – Strategy Loader
 *
 * The Strategy Loader is responsible for discovering, loading, and managing
 * enrichment strategy plug-ins that are implemented as shared libraries.
 *
 * Each plug-in exports a symbol:
 *
 *      const struct ps_enrichment_strategy *ps_get_enrichment_strategy(void);
 *
 * The returned structure defines callbacks used by the enrichment runtime.
 *
 * Copyright (c) 2024 PulseSphere
 * SPDX-License-Identifier: MIT
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include <pthread.h>
#include <dirent.h>
#include <sys/stat.h>

#ifdef _WIN32
#   include <windows.h>
#   define PS_LIB_HANDLE                HMODULE
#   define ps_dl_open(path)             LoadLibraryA(path)
#   define ps_dl_close(handle)          FreeLibrary((HMODULE)(handle))
#   define ps_dl_sym(handle, symbol)    GetProcAddress((HMODULE)(handle), (symbol))
#   define PS_LIB_EXT                   ".dll"
#else
#   include <dlfcn.h>
#   define PS_LIB_HANDLE                void *
#   define ps_dl_open(path)             dlopen((path), RTLD_LOCAL | RTLD_LAZY)
#   define ps_dl_close(handle)          dlclose((handle))
#   define ps_dl_sym(handle, symbol)    dlsym((handle), (symbol))
#   if defined(__APPLE__)
#       define PS_LIB_EXT               ".dylib"
#   else
#       define PS_LIB_EXT               ".so"
#   endif
#endif

/* =========================================================================
 * PulseSphere Common Types
 * =========================================================================
 */

/* Forward declaration to avoid pulling the full event header here */
struct ps_event;

/*
 * Enrichment strategy interface that must be implemented by plug-ins.
 */
struct ps_enrichment_strategy {
    /* Human-readable identifier (should be unique) */
    const char *name;

    /*
     * initialize:
     *   Called once when strategy is attached. |config_json| may be NULL.
     *   Implementation may allocate state and store it in |*state|.
     * Return 0 on success, non-zero on failure.
     */
    int (*initialize)(void **state, const char *config_json);

    /*
     * process_event:
     *   Consumes an input event and produces (optionally) a new enriched event.
     *   Ownership of |*out_event| is transferred to caller. Implementations
     *   must be thread-safe or protect their internal state.
     * Return 0 on success, non-zero on failure.
     */
    int (*process_event)(void *state,
                         const struct ps_event *in_event,
                         struct ps_event **out_event);

    /*
     * shutdown:
     *   Called when plug-in is detached. Implementation must release |state|.
     */
    void (*shutdown)(void *state);
};

/*
 * Signature of exported lookup function.
 */
typedef const struct ps_enrichment_strategy *
        (*ps_get_enrichment_strategy_fn)(void);

/* =========================================================================
 * Strategy Loader Data Structures
 * =========================================================================
 */

typedef struct ps_strategy_module {
    char                *path;      /* Absolute or relative path to library */
    PS_LIB_HANDLE        handle;    /* Platform specific handle */
    const struct ps_enrichment_strategy *iface; /* Strategy interface         */
} ps_strategy_module_t;

typedef struct ps_strategy_loader {
    ps_strategy_module_t *modules;  /* Dynamic array of loaded modules */
    size_t                count;    /* Number of loaded modules         */
    size_t                capacity; /* Allocated capacity               */
    pthread_mutex_t       lock;     /* Thread-safety mutex              */
    char                  last_error[256];
} ps_strategy_loader_t;

/* =========================================================================
 * Internal Helper Utilities
 * =========================================================================
 */

static void
set_error(ps_strategy_loader_t *ldr, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(ldr->last_error, sizeof(ldr->last_error), fmt, ap);
    va_end(ap);
}

static int
reserve_capacity(ps_strategy_loader_t *ldr, size_t needed)
{
    if (needed <= ldr->capacity)
        return 0;

    size_t new_cap = ldr->capacity == 0 ? 4 : ldr->capacity * 2;
    while (new_cap < needed)
        new_cap *= 2;

    ps_strategy_module_t *tmp =
        realloc(ldr->modules, new_cap * sizeof(*ldr->modules));
    if (!tmp)
        return -1;

    ldr->modules  = tmp;
    ldr->capacity = new_cap;
    return 0;
}

static int
has_shared_lib_extension(const char *filename)
{
    size_t len = strlen(filename);
    size_t ext_len = strlen(PS_LIB_EXT);

    if (len < ext_len)
        return 0;

    return strcmp(filename + (len - ext_len), PS_LIB_EXT) == 0;
}

static char *
join_path(const char *dir, const char *file)
{
    size_t len_dir  = strlen(dir);
    size_t len_file = strlen(file);
    int needs_sep   = (len_dir > 0 && dir[len_dir - 1] != '/');

    size_t total = len_dir + needs_sep + len_file + 1;
    char *res = malloc(total);
    if (!res)
        return NULL;

    strcpy(res, dir);
    if (needs_sep)
        strcat(res, "/");
    strcat(res, file);
    return res;
}

static int
load_single_library(ps_strategy_loader_t *ldr, const char *fullpath)
{
    PS_LIB_HANDLE handle = ps_dl_open(fullpath);
    if (!handle) {
#ifdef _WIN32
        DWORD err = GetLastError();
        set_error(ldr, "LoadLibrary failed (%lu) for %s", err, fullpath);
#else
        set_error(ldr, "dlopen failed: %s for %s", dlerror(), fullpath);
#endif
        return -1;
    }

    ps_get_enrichment_strategy_fn getter =
        (ps_get_enrichment_strategy_fn)ps_dl_sym(handle,
                                                 "ps_get_enrichment_strategy");
    if (!getter) {
        set_error(ldr,
                  "Library %s does not export ps_get_enrichment_strategy",
                  fullpath);
        ps_dl_close(handle);
        return -1;
    }

    const struct ps_enrichment_strategy *iface = getter();
    if (!iface || !iface->name || !iface->process_event) {
        set_error(ldr,
                  "Library %s returned invalid strategy interface", fullpath);
        ps_dl_close(handle);
        return -1;
    }

    /* Prevent duplicates (same name) */
    for (size_t i = 0; i < ldr->count; ++i) {
        if (strcmp(ldr->modules[i].iface->name, iface->name) == 0) {
            set_error(ldr, "Duplicate strategy name '%s' in %s",
                      iface->name, fullpath);
            ps_dl_close(handle);
            return -1;
        }
    }

    if (reserve_capacity(ldr, ldr->count + 1) != 0) {
        set_error(ldr, "Out of memory");
        ps_dl_close(handle);
        return -1;
    }

    ps_strategy_module_t *slot = &ldr->modules[ldr->count++];
    slot->path   = strdup(fullpath);
    slot->handle = handle;
    slot->iface  = iface;

    return 0;
}

static int
scan_directory(ps_strategy_loader_t *ldr, const char *dirpath)
{
    DIR *dir = opendir(dirpath);
    if (!dir) {
        set_error(ldr, "opendir('%s') failed: %s", dirpath, strerror(errno));
        return -1;
    }

    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
        if (ent->d_type != DT_REG && ent->d_type != DT_LNK &&
            ent->d_type != DT_UNKNOWN)
            continue;

        if (!has_shared_lib_extension(ent->d_name))
            continue;

        char *full = join_path(dirpath, ent->d_name);
        if (!full) {
            closedir(dir);
            set_error(ldr, "Out of memory");
            return -1;
        }

        if (load_single_library(ldr, full) != 0) {
            /* Non-fatal: log error but continue scanning others */
            fprintf(stderr, "[strategy_loader] %s\n", ldr->last_error);
        }

        free(full);
    }

    closedir(dir);
    return 0;
}

/* =========================================================================
 * Public API
 * =========================================================================
 */

/*
 * ps_strategy_loader_init:
 *   Initialize an empty loader. Must be called before other functions.
 */
int
ps_strategy_loader_init(ps_strategy_loader_t *ldr)
{
    if (!ldr)
        return -1;

    memset(ldr, 0, sizeof(*ldr));

    if (pthread_mutex_init(&ldr->lock, NULL) != 0)
        return -1;

    return 0;
}

/*
 * ps_strategy_loader_load_path:
 *   Load all shared libraries located in |directory|.
 *   Returns 0 on success (even if some libraries failed), negative on fatal.
 */
int
ps_strategy_loader_load_path(ps_strategy_loader_t *ldr,
                             const char *directory)
{
    if (!ldr || !directory)
        return -1;

    pthread_mutex_lock(&ldr->lock);
    int rc = scan_directory(ldr, directory);
    pthread_mutex_unlock(&ldr->lock);
    return rc;
}

/*
 * ps_strategy_loader_get:
 *   Retrieve strategy interface by name. Ownership remains with loader.
 *   Returns NULL if not found.
 */
const struct ps_enrichment_strategy *
ps_strategy_loader_get(ps_strategy_loader_t *ldr, const char *name)
{
    if (!ldr || !name)
        return NULL;

    const struct ps_enrichment_strategy *ret = NULL;

    pthread_mutex_lock(&ldr->lock);
    for (size_t i = 0; i < ldr->count; ++i) {
        if (strcmp(ldr->modules[i].iface->name, name) == 0) {
            ret = ldr->modules[i].iface;
            break;
        }
    }
    pthread_mutex_unlock(&ldr->lock);

    return ret;
}

/*
 * ps_strategy_loader_unload:
 *   Unload all loaded libraries and destroy loader.
 */
void
ps_strategy_loader_unload(ps_strategy_loader_t *ldr)
{
    if (!ldr)
        return;

    pthread_mutex_lock(&ldr->lock);

    for (size_t i = 0; i < ldr->count; ++i) {
        /* Notify strategy if it requires cleanup at detach time.
         * We do NOT have state instances here (created per runtime pipeline),
         * so we only call shutdown if plugin provided a global teardown. */
        if (ldr->modules[i].iface && ldr->modules[i].iface->shutdown)
            ldr->modules[i].iface->shutdown(NULL);

        if (ldr->modules[i].handle)
            ps_dl_close(ldr->modules[i].handle);

        free(ldr->modules[i].path);
    }

    free(ldr->modules);
    ldr->modules  = NULL;
    ldr->count    = 0;
    ldr->capacity = 0;

    pthread_mutex_unlock(&ldr->lock);
    pthread_mutex_destroy(&ldr->lock);
}

/*
 * ps_strategy_loader_last_error:
 *   Retrieve last human-readable error message.
 */
const char *
ps_strategy_loader_last_error(ps_strategy_loader_t *ldr)
{
    return ldr ? ldr->last_error : "loader is NULL";
}

/* =========================================================================
 * Example Usage (for illustration; remove in production)
 * =========================================================================
 *
 * int main(void)
 * {
 *     ps_strategy_loader_t loader;
 *     if (ps_strategy_loader_init(&loader) != 0) {
 *         fprintf(stderr, "Failed to init loader\n");
 *         return EXIT_FAILURE;
 *     }
 *
 *     ps_strategy_loader_load_path(&loader, "./plugins");
 *
 *     const struct ps_enrichment_strategy *geo =
 *         ps_strategy_loader_get(&loader, "geo-tagger");
 *     if (geo) {
 *         printf("Found strategy: %s\n", geo->name);
 *     }
 *
 *     ps_strategy_loader_unload(&loader);
 *     return EXIT_SUCCESS;
 * }
 *
 * =========================================================================
 */
