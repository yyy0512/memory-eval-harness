<!--
  CampusGuard-EDU-Monitor : docs/api/main_page.md
  This file is generated documentation for the public C-API exposed by
  CampusGuard EDU Monitor.  It is meant to be consumed both as a GitHub
  rendered Markdown page and as Doxygen mainpage documentation.
-->

# CampusGuard EDU Monitor – Public C API

Welcome to the CampusGuard EDU Monitor SDK!  
This document is the canonical entry-point for integrators, researchers, and
students who want to embed CampusGuard into their own tooling or contribute
new capabilities to the platform.

*Project Goals*

1. Illustrate production-grade monitoring architecture (_Observer_,
   _Chain-of-Responsibility_, _Event-Driven_).
2. Provide a **safe sandbox** for experimenting with DevSecOps practices.
3. Offer a clean, well-documented C API for programmatic access.

---

## Quick-start

Prerequisites:

```bash
sudo apt install build-essential cmake pkg-config libsqlite3-dev libjansson-dev
git clone https://github.com/campusguard/edu-monitor
cd edu-monitor
mkdir build && cd build
cmake .. && make
sudo make install   # Installs headers to /usr/local/include/cgedu
```

Your first “hello metric”:

```c
#include <cgedu/cgedu.h>

static void cpu_cb(const cgedu_metric_t *m, void *user) {
    printf("CPU @ %ld: %.2f%%\n", m->timestamp, m->value.f64);
}

int main(void) {
    cgedu_ctx_t *ctx = NULL;
    if (cgedu_init(&ctx, NULL) != CGEDU_OK) {
        fprintf(stderr, "Failed to init CampusGuard context\n");
        return 1;
    }

    cgedu_sub_t *sub = NULL;
    cgedu_subscribe(ctx, "system.cpu.util", cpu_cb, NULL, &sub);

    /* Run the main loop for 5 seconds */
    cgedu_run(ctx, 5000);

    cgedu_unsubscribe(ctx, sub);
    cgedu_shutdown(ctx);
    return 0;
}
```

Compile it:

```bash
gcc -Wall -Wextra -pedantic hello_metric.c -lcgedu -lpthread -o hello_metric
```

---

## Core Concepts

| Concept                | Description                                                                                 |
|------------------------|---------------------------------------------------------------------------------------------|
| Observer               | Sensors emit `cgedu_metric_t` events; observers register callbacks using `cgedu_subscribe`. |
| Event Bus              | A high-performance `epoll`/`kqueue` loop dispatches metrics and control messages.           |
| Chain-of-Responsibility| User requests traverse a validation chain (`auth → quota → scheduler → executor`).          |
| Service Mesh           | Lightweight micro-agents communicate over gRPC-like IPC for lab VMs emulation.             |
| Models                 | Persisted in SQLite; exposed via an embedded HTTP/REST server at `http://:7777/api/v1`.     |

---

## Error Handling

All public functions return `cgedu_rc_t` enumeration values.  
A return code **≠ `CGEDU_OK`** indicates failure.

```c
cgedu_rc_t rc = cgedu_backup_start(ctx, CGEDU_BACKUP_FULL, "/mnt/offsite/");
if (rc != CGEDU_OK) {
    fprintf(stderr, "backup failed: %s\n", cgedu_strerror(rc));
}
```

---

## Thread-safety Matrix

| API Category      | Thread-safe | Notes                                          |
|-------------------|-------------|------------------------------------------------|
| Metric streaming  | Yes         | Callback executed on internal I/O thread.      |
| Configuration     | No          | Call only from main thread before `run()`.     |
| SQLite model ops  | Yes         | Guarded by serialized connection pool.         |
| Scanner interface | Yes         | Heavyweight; spawns its own thread-pool.       |

---

## Public Headers

```
include/cgedu/
 ├── cgedu.h               // Facade header, includes all others
 ├── bus.h                 // Internal but documented: event bus
 ├── models.h              // CRUD access to log/scan/backup data
 ├── scanner.h             // Security scanner orchestration
 └── backup.h              // Backup & recovery interface
```

---

## Mini-reference

### Context

```c
cgedu_rc_t cgedu_init     (cgedu_ctx_t **out, const cgedu_opts_t *opts);
void       cgedu_shutdown (cgedu_ctx_t *ctx);
void       cgedu_run      (cgedu_ctx_t *ctx, uint32_t millis);
```

### Metric Subscription

```c
cgedu_rc_t cgedu_subscribe   (cgedu_ctx_t       *ctx,
                              const char        *metric_pattern,
                              cgedu_metric_cb_t  cb,
                              void              *user,
                              cgedu_sub_t      **out_sub);

void       cgedu_unsubscribe (cgedu_ctx_t *ctx, cgedu_sub_t *sub);
```

### Backup / Recovery

```c
typedef enum {
    CGEDU_BACKUP_FULL,
    CGEDU_BACKUP_INCREMENTAL
} cgedu_backup_mode_t;

cgedu_rc_t cgedu_backup_start   (cgedu_ctx_t *ctx,
                                 cgedu_backup_mode_t mode,
                                 const char *target_dir);

cgedu_rc_t cgedu_backup_restore (cgedu_ctx_t *ctx,
                                 const char *snapshot_id,
                                 const char *dest_dir);
```

### Security Scanner

```c
typedef enum {
    CGEDU_SCAN_HOST,
    CGEDU_SCAN_CONTAINER,
    CGEDU_SCAN_SOURCE
} cgedu_scan_type_t;

cgedu_rc_t cgedu_scan_enqueue  (cgedu_ctx_t *ctx,
                                cgedu_scan_type_t type,
                                const char *target,
                                cgedu_job_id_t *jid_out);

cgedu_rc_t cgedu_scan_status   (cgedu_ctx_t *ctx,
                                cgedu_job_id_t jid,
                                cgedu_scan_status_t *out);
```

---

## Advanced Example – Asynchronous Scanner Workflow

```c
#include <cgedu/cgedu.h>

static void scan_done_cb(cgedu_job_id_t jid, cgedu_rc_t rc, void *u) {
    printf("[scan job=%u] completed with %s\n", jid, cgedu_strerror(rc));
}

int main(void)
{
    cgedu_ctx_t *ctx;
    if (cgedu_init(&ctx, NULL) != CGEDU_OK)
        return 1;

    /* Subscribe for finished-job events */
    cgedu_bus_on(ctx, CGEDU_EVT_JOB_DONE, scan_done_cb, NULL);

    cgedu_job_id_t job;
    cgedu_scan_enqueue(ctx, CGEDU_SCAN_HOST, "192.168.3.42", &job);
    printf("Queued scan job %u\n", job);

    /* Run indefinitely; Ctrl-C to exit */
    cgedu_run(ctx, 0);

    cgedu_shutdown(ctx);
    return 0;
}
```

---

## Building Against the Library

Add the following to your `CMakeLists.txt`:

```cmake
find_package(cgedu REQUIRED)        # Config file installed by `make install`
target_link_libraries(myapp PUBLIC cgedu::cgedu)
target_compile_features(myapp PUBLIC c_std_11)  # Modern C11 API
```

Or when using `pkg-config`:

```bash
gcc $(pkg-config --cflags cgedu) myapp.c \
    $(pkg-config --libs cgedu) -o myapp
```

---

## Contribution Guidelines

1. **Fork** the repository, create a feature branch (`feat/<topic>`).
2. Follow the existing coding style (`clang-format` target provided).
3. Document new public symbols in header *and* update this file.
4. All code must pass `ctest` and `cppcheck` in CI.

For an in-depth architectural tour, refer to `docs/design/architecture.md`.

---

© 2024 CampusGuard EDU Monitor – Licensed under the MIT License.