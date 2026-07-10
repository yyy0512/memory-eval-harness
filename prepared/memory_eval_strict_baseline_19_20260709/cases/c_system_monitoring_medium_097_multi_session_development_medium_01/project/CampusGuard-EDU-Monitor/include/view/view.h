/**
 * ============================================================================
 *  CampusGuard EDU Monitor
 *  File........: include/view/view.h
 *  Author......: CampusGuard Dev Team
 *  License.....: MIT  (see LICENSE file for details)
 *  Description.: Public interface for the View layer.  The View is responsible
 *                for visualising real-time metrics, historical log data and
 *                security alerts across both GUI (GTK) and TUI (ncurses)
 *                back-ends.  It exposes a back-end-agnostic API so that
 *                Controllers can remain ignorant of the concrete presentation
 *                technology being used.
 *
 *  NOTE:        This header purposefully hides implementation details.  All
 *               concrete types are opaque to the consumer; ownership is
 *               managed via the View API.
 * ============================================================================
 */

#ifndef CAMPUS_GUARD_EDU_MONITOR_INCLUDE_VIEW_VIEW_H
#define CAMPUS_GUARD_EDU_MONITOR_INCLUDE_VIEW_VIEW_H

/* ---- Standard Library ---- */
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>     /* size_t */
#include <time.h>       /* time_t */

/* ---- Visibility / DLL Export ------------------------------------------------
 *  CG_API is used to decorate public symbols so the shared library can be
 *  consumed on Windows, Linux and macOS without requiring additional DEF
 *  files or linker flags.
 * -------------------------------------------------------------------------- */
#if defined _WIN32 || defined __CYGWIN__
#  ifdef CG_BUILD_SHARED
#    ifdef __GNUC__
#      define CG_API __attribute__ ((dllexport))
#    else
#      define CG_API __declspec(dllexport)
#    endif
#  else
#    ifdef __GNUC__
#      define CG_API __attribute__ ((dllimport))
#    else
#      define CG_API __declspec(dllimport)
#    endif
#  endif
#  define CG_LOCAL
#else
#  if __GNUC__ >= 4
#    define CG_API   __attribute__ ((visibility ("default")))
#    define CG_LOCAL __attribute__ ((visibility ("hidden")))
#  else
#    define CG_API
#    define CG_LOCAL
#  endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ──────────────────────────────────────────────────────────────────────────
 * Forward declarations (decouple View from Model/Controller internals)
 * ────────────────────────────────────────────────────────────────────────── */
struct cg_metric_snapshot;  /* see model/metric.h                         */
struct cg_alert;            /* see model/alert.h                          */
struct cg_log_entry;        /* see model/log.h                            */
struct cg_command_req;      /* see controller/cmd_dispatcher.h            */

/* ============================================================================
 *  Enumerations
 * ========================================================================= */

/**
 * cg_view_backend_t
 * -----------------
 * Lists all officially supported presentation back-ends.  Additional back-ends
 * (e.g. web-sockets, OpenGL) can be plugged in by implementing the cg_view_ops
 * interface and registering via cg_view_register_backend().
 */
typedef enum cg_view_backend_e
{
    CG_VIEW_BACKEND_AUTO = 0,  /* View will autodetect the best available   */
    CG_VIEW_BACKEND_GTK,       /* GTK 3/4 GUI                               */
    CG_VIEW_BACKEND_NCURSES,   /* Terminal UI                               */
    CG_VIEW_BACKEND_HEADLESS   /* For unit-testing / CI (no visible output) */
} cg_view_backend_t;

/**
 * cg_view_event_t
 * ---------------
 * Discrete user-driven events captured by the View and relayed to Controllers.
 */
typedef enum cg_view_event_e
{
    CG_VIEW_EV_NONE = 0,
    CG_VIEW_EV_QUIT_APP,              /* User requested application exit       */
    CG_VIEW_EV_OPEN_LOG_VIEWER,       /* Request to open historical logs       */
    CG_VIEW_EV_START_SEC_SCAN,        /* Trigger a security scan               */
    CG_VIEW_EV_INITIATE_BACKUP,       /* Start backup/recovery drill           */
    CG_VIEW_EV_CUSTOM                 /* Vendor/extension specific             */
} cg_view_event_t;

/* ============================================================================
 *  Opaque Handles
 * ========================================================================= */

/* Incomplete type representing a View instance.  Lifetime is managed through
 * cg_view_create() and cg_view_destroy(). */
typedef struct cg_view cg_view_t;

/* ============================================================================
 *  Callback Types
 * ========================================================================= */

/**
 * cg_view_event_cb
 * ----------------
 * Callback invoked by the View to forward a user-initiated action up to the
 * Controller layer (Observer pattern).
 *
 * Parameters
 *   ctx        – user-supplied pointer, set during cg_view_set_event_cb()
 *   v          – View instance that generated the event
 *   event      – type of event
 *   payload    – optional, event-specific payload (e.g. struct cg_command_req*)
 *
 * Returns
 *   true  if the event was consumed successfully.
 *   false if the event should propagate to the default handler.
 */
typedef bool (*cg_view_event_cb)(void *ctx,
                                 cg_view_t *v,
                                 cg_view_event_t event,
                                 void *payload /* nullable */);

/* ============================================================================
 *  Public API
 * ========================================================================= */

/**
 * cg_view_create
 * --------------
 * Factory for creating a View instance with the desired back-end.  If
 * CG_VIEW_BACKEND_AUTO is specified, the library will attempt to initialise a
 * GUI first, then fall back to ncurses, and finally to headless.
 *
 * Parameters
 *   backend    – preferred back-end (or AUTO)
 *   opts       – reserved for future use (must be NULL for now)
 *
 * Returns
 *   Pointer to a cg_view_t on success, otherwise NULL (check errno for cause).
 */
CG_API cg_view_t *
cg_view_create(cg_view_backend_t backend, const void *opts);

/**
 * cg_view_destroy
 * ---------------
 * Immediately releases all resources held by the View.  Safe to call with NULL.
 */
CG_API void
cg_view_destroy(cg_view_t *v);

/**
 * cg_view_set_event_cb
 * --------------------
 * Registers a callback for user events.  Passing NULL unregisters the current
 * callback.
 */
CG_API void
cg_view_set_event_cb(cg_view_t *v,
                     cg_view_event_cb cb,
                     void *user_ctx /* may be NULL */);

/**
 * cg_view_main_loop
 * -----------------
 * Blocks and runs the View’s event loop until cg_view_exit_main_loop() is
 * invoked (typically from the Controller when a CG_VIEW_EV_QUIT_APP is
 * processed).
 *
 * Returns
 *   0 on clean shutdown; non-zero if a fatal error occurred.
 */
CG_API int
cg_view_main_loop(cg_view_t *v);

/**
 * cg_view_exit_main_loop
 * ----------------------
 * Requests that the currently executing main loop be exited.  Thread-safe.
 */
CG_API void
cg_view_exit_main_loop(cg_view_t *v);

/**
 * cg_view_render_metrics
 * ----------------------
 * Renders a fresh snapshot of system metrics onto the dashboard.  The View
 * takes a *copy* of the relevant fields, so the caller retains ownership of
 * the snapshot pointer.
 *
 * Performance Note:
 *   Designed to be called from a high-throughput Observer; therefore, the View
 *   implementation must be lock-free or employ double-buffering strategies
 *   internally to prevent UI starvation.
 */
CG_API int
cg_view_render_metrics(cg_view_t *v,
                       const struct cg_metric_snapshot *snapshot,
                       time_t                       when);

/**
 * cg_view_render_alert
 * --------------------
 * Displays a security alert pop-up / toast in the UI.
 */
CG_API int
cg_view_render_alert(cg_view_t *v,
                     const struct cg_alert *alert,
                     time_t                 when);

/**
 * cg_view_append_log
 * ------------------
 * Streams a single log entry to whatever log panel is currently active (if
 * visible).  Useful for real-time tail-style updates.
 */
CG_API int
cg_view_append_log(cg_view_t *v,
                   const struct cg_log_entry *entry);

/* ============================================================================
 *  Extension API
 * ========================================================================= */

/**
 * cg_view_register_backend
 * ------------------------
 * Allows third-party modules to plug additional rendering back-ends at run-time
 * (e.g. WebSockets, Vulkan).  The supplied operations struct must remain valid
 * for the life-time of the process.
 *
 * Returns
 *   0 on success, -1 on error (errno set to EEXIST or EINVAL).
 */
struct cg_view_ops;
CG_API int
cg_view_register_backend(const char                    *name,
                         const struct cg_view_ops      *ops,
                         size_t                         ops_sz);

/* ============================================================================
 *  Introspection
 * ========================================================================= */

/**
 * cg_view_backend_name
 * --------------------
 * Returns a human-readable name for the active back-end, e.g. "GTK", "ncurses".
 * The returned string is owned by the library; do NOT free.
 */
CG_API const char *
cg_view_backend_name(const cg_view_t *v);

/**
 * cg_view_backend_is_gui
 * ----------------------
 * Convenience function indicating whether the back-end supports rich GUI
 * interactions (as opposed to headless / CLI / TUI).
 */
static inline bool
cg_view_backend_is_gui(const cg_view_t *v)
{
    return v && (cg_view_backend_name(v)[0] == 'G'); /* crude but fast */
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* CAMPUS_GUARD_EDU_MONITOR_INCLUDE_VIEW_VIEW_H */
