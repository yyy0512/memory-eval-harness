```markdown
<!--
============================ CampusGuard EDU Monitor ============================
File: docs/guides/02_Student_Guide.md
Description: A hands-on guide for students who will build, extend, and operate
             CampusGuard EDU Monitor in CS lab environments.  The guide
             explains the system architecture, demonstrates how to write a
             monitoring plugin in C, and outlines recommended workflows.
============================================================================== -->
# CampusGuard EDU Monitor — Student Guide

Welcome to **CampusGuard EDU Monitor**, a C-based, production-grade monitoring
suite crafted for university computer–science curricula.  
This guide will help you:

* Bootstrap the project on your workstation or a lab VM.
* Understand how MVC, Observer, and Chain-of-Responsibility patterns are wired
  together in a real codebase you can navigate.
* Write your **own** monitoring plugin in C.
* Interact with the GTK/ncurses dashboard, leverage the REST layer, and
  practice DevSecOps skills such as backup/recovery drills.

> 💡  **Prerequisites**  
>  ‑ Linux or macOS, GCC ≥ 11, Make ≥ 4, SQLite ≥ 3.35, GTK 3 **or** ncurses.  
>  ‑ Basic familiarity with C, git, and shell scripting.

---

## 1. Cloning & Building

```console
$ git clone https://github.com/university/campusguard-edu-monitor.git
$ cd campusguard-edu-monitor
$ ./bootstrap.sh        # installs third-party deps into ./vendor
$ make                  # builds all targets (lib, agents, dashboard)
$ sudo make install     # optional: deploys binaries to /usr/local
```

If you merely want to **experiment**, run:

```console
$ make run              # spawns all agents and the GTK dashboard
```

---

## 2. Architectural High-Level Map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  CampusGuard EDU Monitor — Model • View • Controller                         │
├──────────────────┬──────────────────┬────────────────────────────────────────┤
│  View            │  Controller      │  Model                                 │
│  (GTK/ncurses)   │  (Chain of Resp) │  (SQLite, JSON, Binary Snapshots)      │
│                  │                  │                                        │
│ Emits UI events  │ Authorises +     │ Persists metrics, alerts, logs,        │
│ via Observer     │ dispatches onto  │ scan results. Provides REST, data      │
│ pattern.         │ event bus.       │ science hooks.                         │
└──────────────────┴──────────────────┴────────────────────────────────────────┘
           ▲                           ▲
           │                           │
  Student Plugins           Micro-agents (Service Mesh)
```

* **Observer Pattern:** Dashboards subscribe to metric events and update views
  in real-time.
* **Chain-of-Responsibility:** Each student-issued request (e.g., *Initiate Scan*)
  flows through a linked list of C handlers that may veto, transform, or queue
  work on the **Event Bus**.
* **Service Mesh:** Agents simulate distributed micro-services inside a lab
  cluster (Docker or nested VMs). They publish heartbeat, logs, and scan
  results back to the core.

---

## 3. Quick-Start: Your First Monitoring Plugin

All monitors live under `src/monitors/`.  Here’s a minimal yet functional
example that measures disk-usage percentage and emits an alert when above
threshold.

### 3.1 Header: `disk_monitor.h`

```c
#ifndef CG_MONITOR_DISK_H
#define CG_MONITOR_DISK_H

#include "core/observer.h"

#define DISK_MONITOR_NS "edu.disk"
#define DISK_ALERT_EVT  "disk-alert"

typedef struct {
    cg_subject_t   base;         /* must be first — required by Observer */
    const char    *mount_point;  /* e.g., "/data" */
    double         warn_pct;     /* 0-100 — threshold */
} disk_monitor_t;

/* Factory */
disk_monitor_t *disk_monitor_new(const char *mount_point, double warn_pct);

/* Runtime */
void disk_monitor_poll(disk_monitor_t *self);

#endif /* CG_MONITOR_DISK_H */
```

### 3.2 Implementation: `disk_monitor.c`

```c
#include <stdio.h>
#include <sys/statvfs.h>
#include "disk_monitor.h"
#include "core/logger.h"
#include "models/alert.h"

/* Forward decl for internal helper */
static void calculate_usage(const disk_monitor_t *self, double *pct_out);

/* Allocate + initialize */
disk_monitor_t *disk_monitor_new(const char *mount_point, double warn_pct)
{
    disk_monitor_t *mon = calloc(1, sizeof *mon);
    if (!mon) {
        cg_log_error("disk", "OOM creating disk monitor");
        return NULL;
    }
    cg_subject_init(&mon->base, DISK_MONITOR_NS);
    mon->mount_point = strdup(mount_point ?: "/");
    mon->warn_pct    = warn_pct ?: 85.0;
    return mon;
}

/* Poll once per configured cadence (configured in monitor-daemon.conf) */
void disk_monitor_poll(disk_monitor_t *self)
{
    double pct = 0.0;
    calculate_usage(self, &pct);
    cg_log_debug("disk", "%s usage = %.1f%%", self->mount_point, pct);

    /* Always notify metrics observers */
    cg_subject_notify(
        &self->base,
        CG_EVT_METRIC,
        "{ \"mount\":\"%s\", \"pct\":%.1f }",
        self->mount_point, pct
    );

    if (pct >= self->warn_pct) {
        cg_alert_t alert = {
            .severity = CG_ALERT_WARN,
            .msg      = "Disk usage high",
            .payload  = pct
        };
        cg_model_alert_save(&alert);  /* persist to SQLite */

        cg_subject_notify(
            &self->base,
            DISK_ALERT_EVT,
            "{ \"mount\":\"%s\", \"pct\":%.1f }",
            self->mount_point, pct
        );
    }
}

/* Helper: wrap statvfs and compute percentage */
static void calculate_usage(const disk_monitor_t *self, double *pct_out)
{
    struct statvfs stat = {0};
    if (statvfs(self->mount_point, &stat) != 0) {
        cg_log_error("disk", "statvfs failed for %s", self->mount_point);
        *pct_out = 0.0;
        return;
    }
    double used  = (double)(stat.f_blocks - stat.f_bfree);
    double total = (double)stat.f_blocks;
    *pct_out     = total > 0 ? (used / total) * 100.0 : 0.0;
}
```

### 3.3 Registering Your Plugin

Update `src/agents/monitor_daemon.c`:

```c
#include "monitors/disk_monitor.h"

static void register_builtin_monitors(void)
{
    /* existing monitors... */
    disk_monitor_t *disk = disk_monitor_new("/data", 90.0);
    cg_monitor_registry_add((cg_subject_t *)disk);
}
```

Re-compile:

```console
$ make && make run
```

Open the dashboard and fill up `/data` on your VM; you’ll see a flashing alert!

---

## 4. Using the GTK Dashboard

Key bindings (GTK):

* `Ctrl + H` — Toggle historical log view  
* `Ctrl + S` — Start security scan  
* `Ctrl + B` — Initiate backup snapshot  
* `Ctrl + Q` — Quit  

Key bindings (ncurses):

* `h` = history, `s` = scan, `b` = backup, `q` = quit

The **right sidebar** renders alerts in color based on severity
(Info → green, Warning → yellow, Critical → red).

---

## 5. Chain-of-Responsibility Handlers

Requests from the dashboard (e.g., *Run Backup*) traverse a linked list of
handlers in `src/controllers/handlers/`.  Each handler follows the interface:

```c
typedef enum {
    CG_HANDLED,      /* request consumed; stop processing */
    CG_PASS,         /* pass to next handler */
    CG_ERROR         /* error; abort chain */
} cg_handler_result_t;

typedef cg_handler_result_t (*cg_handler_fn)(cg_request_t *req, void *ctx);
```

Adding a permission gate:

```c
#include "authz/roles.h"

static cg_handler_result_t perm_gate(cg_request_t *req, void *ctx)
{
    if (!cg_role_has(req->user, ROLE_BACKUP)) {
        cg_log_warn("auth", "User %s lacks ROLE_BACKUP", req->user->uid);
        return CG_ERROR;
    }
    return CG_PASS;
}

/* During controller init */
cg_chain_add_handler(bus_chain, perm_gate, NULL, /*priority=*/10);
```

---

## 6. Interacting via REST (curl example)

```console
# Get latest disk alerts
$ curl http://localhost:8080/api/v1/alerts?kind=disk | jq

# Trigger a DR (disas­ter recovery) simulation
$ curl -X POST http://localhost:8080/api/v1/drills \
       -H 'Authorization: Bearer STUDENT_TOKEN' \
       -d '{ "scenario": "storage-node-failure" }'
```

Behind the scenes, REST requests are forwarded onto the same **Event Bus**
consumed by micro-agents, providing a unified control plane.

---

## 7. Backup & Restore Walk-Through

1. Dashboard → `Ctrl + B` **or**  
   `curl -X POST /api/v1/backups`
2. `backup_agent` creates a snapshot (`.cgbak`) in
   `/var/lib/campusguard/backups/YYYY-MM-DD/`.
3. Verify snapshot integrity:

```console
$ cg_backup verify /var/lib/campusguard/backups/2023-10-20/snapshot.cgbak
```

4. Restore into a **new** SQLite file (never overwrite in-place):

```console
$ cg_backup restore snapshot.cgbak /tmp/restore.db
$ cg_backup diff   /var/lib/campusguard/state.db /tmp/restore.db
```

---

## 8. Contributing Guidelines

1. Follow the project’s **clang-format** profile: `make fmt`.
2. Each new module **must** include unit tests (`tests/`) built via CMocka.
3. Avoid synchronous sleeps; favor the **event loop** (`core/loop.h`).
4. Document *public* functions with Doxygen‐style comments.

---

## 9. Troubleshooting

| Symptom                               | Likely Cause                     | Fix                         |
|---------------------------------------|----------------------------------|-----------------------------|
| `make` fails: missing `gtk/gtk.h`     | GTK dev headers not installed    | `sudo apt install libgtk-3-dev` |
| Dashboard window freezes              | Infinite loop in plugin          | Inspect plugin; use `cg_log_debug()` and gdb |
| `ERROR: bus timeout`                  | Agent not responding             | Check `agentd` logs; network/firewall |

---

## 10. Glossary

* **Subject/Observer** — Pattern for broadcasting events to many listeners.
* **Chain-of-Responsibility (CoR)** — Pattern for passing a request through a
  chain of handlers until one acts on it.
* **Event Bus** — In-process queue + epoll loop that agents/controllers use to
  decouple producers from consumers.
* **Snapshot (`.cgbak`)** — Compressed archive of the SQLite DB plus manifest.

---

## 11. Next Steps

* Implement a **CPU temperature** plugin using `libsensors`.
* Write an **AI-powered anomaly detector** that subscribers to metrics and
  triggers alerts on deviations.
* Contribute enhancements or docs via Pull Requests—every student commit is
  reviewed by teaching assistants for credit!

> **Happy monitoring, and may your logs be ever informative!**

---
© 2024 University CS Department.  Licensed under the Apache License 2.0.
```