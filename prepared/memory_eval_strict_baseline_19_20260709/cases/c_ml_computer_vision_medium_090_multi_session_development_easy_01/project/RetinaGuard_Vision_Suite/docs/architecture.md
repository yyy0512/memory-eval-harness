```md
# RetinaGuard Vision Suite  
Architecture Overview
=====================

RetinaGuard Vision Suite (RGVS) is a **monolithic, single-binary C application**
that executes the entire computer-vision workflow for diabetic-retinopathy
screening **on-device**. Despite its monolithic delivery model, the codebase is
structured around well-known design patterns (Pipeline & Observer) to preserve
maintainability, enable safe extension, and satisfy IEC 62304/ISO 14971 medical
software guidelines.

```
┌────────────────────────────────────────────────────────────────────────┐
│ RetinaGuard Vision Suite (Single ELF / .EXE)                          │
│                                                                        │
│  ┌──────────┐   ┌───────────────┐   ┌─────────────┐   ┌────────────┐  │
│  │ Ingest & │   │   Pre-Proc    │   │  Model-        │   │  Results    │  │
│  │  QC      │─▶ │   Pipeline    │─▶ │  Serving   │─▶ │  Observer   │  │
│  └──────────┘   └───────────────┘   └─────────────┘   └────────────┘  │
│        │                │                 │                │          │
│        ▼                ▼                 ▼                ▼          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Internal Model Registry                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│        ▲                ▲                 ▲                ▲          │
│        │                │                 │                │          │
│  ┌──────────┐   ┌───────────────┐   ┌─────────────┐   ┌────────────┐  │
│  │  Local   │   │ Hyper-Param   │   │  Auto-       │   │  EMR Sync  │  │
│  │ Database │◀──│   Tuning      │◀──│  Retraining  │◀──│  & Alerts  │  │
│  └──────────┘   └───────────────┘   └─────────────┘   └────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

*Figure 1 – Macro-level module graph.*

---

## 1. High-Level Module Responsibilities

| Module                | Primary Responsibilities                                                             | Key Patterns                    |
|-----------------------|--------------------------------------------------------------------------------------|---------------------------------|
| `rg_ingest`           | Image acquisition, DICOM/JPEG parsing, QC heuristics                                 | Pipeline Stage                  |
| `rg_preproc`          | Contrast-limited adaptive hist-eq (CLAHE), optic-disc masking, data augmentation     | Pipeline Stage                  |
| `rg_model`            | Loads ONNX/TFLite models, executes inference, produces heat-maps                     | Pipeline Stage + Strategy       |
| `rg_observer`         | Event bus, publishes model-inference events to UI, model registry, logging subsystem | Observer Pattern                |
| `rg_registry`         | Stores model metadata, performance metrics, version graph                            | Singleton + Repository          |
| `rg_mlops`            | Hyper-parameter tuning via Latin Hypercube Search, scheduled retraining, rollback    | Pipeline + Command Scheduler    |
| `rg_emr`              | HL7/FHIR message construction, secure transfer, clinician alert escalation           | Adapter + Observer              |
| `rg_ui`               | Immediate-mode GUI (Dear ImGui), heat-map overlay, trend visualization               | MVC                              |

---

## 2. Pipeline Pattern (In-Process)

Each stage implements the same interface so they can be hot-swapped during
offline A/B experimentation while preserving binary compatibility.

```c
/* pipeline_stage.h
 * Common interface for all pipeline stages.
 */
#ifndef RG_PIPELINE_STAGE_H
#define RG_PIPELINE_STAGE_H

#include <stddef.h>
#include <stdint.h>

typedef struct rg_frame_s {
    uint8_t  *data;        /* Raw pixel buffer (RGB888)           */
    size_t    len;         /* Byte length of data[]               */
    uint32_t  width;       /* Image width                         */
    uint32_t  height;      /* Image height                        */
    uint64_t  timestamp;   /* Epoch microseconds                  */
    char      src_id[64];  /* Source device identifier            */
} rg_frame_t;

typedef struct rg_context_s rg_context_t; /* Forward ‑ global runtime ctx */

/* Return codes aligned with IEC 62304 severity mapping */
typedef enum {
    RG_OK = 0,
    RG_ERR_MEMORY,
    RG_ERR_IO,
    RG_ERR_MODEL,
    RG_ERR_PRECONDITION,
    RG_ERR_POSTCONDITION,
    RG_ERR_UNKNOWN
} rg_status_e;

/* Opaque stage handle for dynamic dispatch */
typedef struct rg_stage_s rg_stage_t;

/* Function pointer table */
typedef struct rg_stage_vtbl_s {
    const char *name;
    rg_status_e (*init)(rg_stage_t *self, rg_context_t *ctx);
    rg_status_e (*execute)(rg_stage_t *self, rg_frame_t *in, rg_frame_t *out);
    void        (*destroy)(rg_stage_t *self);
} rg_stage_vtbl_t;

/* Concrete stage type */
struct rg_stage_s {
    const rg_stage_vtbl_t *vtbl;
    void                  *priv; /* Implementation-specific payload */
};

#endif /* RG_PIPELINE_STAGE_H */
```

### Example: Image Quality-Control Stage

```c
/* qc_stage.c */
#include "pipeline_stage.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct {
    float    blur_threshold;
    uint32_t min_resolution_px;
} qc_priv_t;

static rg_status_e qc_init(rg_stage_t *self, rg_context_t *ctx)
{
    (void)ctx;
    qc_priv_t *p = calloc(1, sizeof(*p));
    if (!p) return RG_ERR_MEMORY;

    /* Tunable parameters loaded from ctx */
    p->blur_threshold   = 100.0f;
    p->min_resolution_px = 1024*768;
    self->priv = p;
    return RG_OK;
}

static float estimate_blur_laplacian(const rg_frame_t *f);

static rg_status_e qc_execute(rg_stage_t *self,
                              rg_frame_t *in,
                              rg_frame_t *out)
{
    qc_priv_t *p = self->priv;

    if (in->width * in->height < p->min_resolution_px)
        return RG_ERR_PRECONDITION;

    if (estimate_blur_laplacian(in) < p->blur_threshold)
        return RG_ERR_PRECONDITION;

    *out = *in; /* Shallow copy – pipeline uses frame-arena pooling */
    return RG_OK;
}

static void qc_destroy(rg_stage_t *self)
{
    free(self->priv);
}

/* Virtual table instance (singleton) */
static const rg_stage_vtbl_t QC_VTBL = {
    .name     = "Quality-Control Stage",
    .init     = qc_init,
    .execute  = qc_execute,
    .destroy  = qc_destroy
};

/* Factory exposed to the rest of RGVS */
rg_stage_t *rg_qc_stage_create(void)
{
    static rg_stage_t inst;
    inst.vtbl = &QC_VTBL;
    return &inst;
}
```

---

## 3. Observer Pattern: Event Bus

A lightweight, lock-free ring buffer is employed to fan-out events without
blocking the real-time inference thread.

```c
/* rg_event.h */
#ifndef RG_EVENT_H
#define RG_EVENT_H
#include <stdint.h>

#define RG_EVENT_PAYLOAD_MAX 256
#define RG_EVENT_RING_SIZE   1024  /* Power-of-two for mask optimization */

typedef enum {
    RG_EVT_INFERENCE_DONE,
    RG_EVT_RETRAIN_COMPLETE,
    RG_EVT_MODEL_ROLLED_BACK,
    RG_EVT_EMR_SYNC_FAILED,
    RG_EVT_FATAL_ERROR
} rg_evt_type_e;

typedef struct {
    rg_evt_type_e type;
    uint64_t      ts_epoch_us;
    char          payload[RG_EVENT_PAYLOAD_MAX];
} rg_event_t;

/* API */
int  rg_evt_publish(const rg_event_t *evt); /* Non-blocking, lock-free  */
int  rg_evt_subscribe(void (*cb)(const rg_event_t *evt, void *user),
                      void *user);
#endif /* RG_EVENT_H */
```

Error isolation is achieved by having the callback executed in the
subscriber’s context; the publisher never waits on consumer code.

---

## 4. MLOps Scheduler

Retraining & hyper-parameter searches are scheduled via a cron-like DSL parsed
at boot time (e.g., `"0 2 * * SUN"` = Every Sunday 02:00). During the
maintenance window the pipeline is paused, historical images are sampled, and
model artifacts are regenerated.

```c
/* mlops_scheduler.h */
void rg_mlops_init_scheduler(void);
void rg_mlops_tick(uint64_t now_us); /* called from main loop */
```

The scheduler communicates status via the event bus (`RG_EVT_RETRAIN_COMPLETE`,
`RG_EVT_MODEL_ROLLED_BACK`) enabling the UI and EMR modules to react.

---

## 5. Concurrency Model

• One **real-time thread** runs the pipeline from ingest to visualization  
• One **I/O thread** handles EMR communication & disk persistence  
• One **MLOps thread** performs long-running tuning tasks  
• A **GUI thread** renders ImGui widgets at 60 FPS  

Thread safety is enforced through **immutable frame objects** and
lock-free queues (`spsc_ring.h`) to minimise latency.

---

## 6. Error Handling & Logging

All public functions return an `rg_status_e` mapped to syslog severity
levels. A uniform error handler converts these into human-readable messages,
audit-log entries, and where applicable, HL7/FHIR `Alert` resources.

```c
/* rg_error.c */
#include "rg_error.h"
#include "rg_event.h"

void rg_handle_error(rg_status_e rc, const char *ctx)
{
    if (rc == RG_OK) return;

    syslog(LOG_ERR, "[%s] %s", ctx, rg_status_to_str(rc));

    rg_event_t evt = {
        .type = (rc == RG_ERR_FATAL) ? RG_EVT_FATAL_ERROR
                                     : RG_EVT_EMR_SYNC_FAILED,
        .ts_epoch_us = rg_now_us()
    };
    snprintf(evt.payload, sizeof(evt.payload), "%s:%d", ctx, rc);
    rg_evt_publish(&evt);

    if (rc == RG_ERR_FATAL)
        abort(); /* Fail-fast in IEC 62304 Class C modules */
}
```

---

## 7. Directory Layout (Monorepo)

```
RetinaGuard_Vision_Suite/
├── CMakeLists.txt
├── src/
│   ├── main.c
│   ├── rg_ingest/
│   ├── rg_preproc/
│   ├── rg_model/
│   ├── rg_observer/
│   ├── rg_registry/
│   ├── rg_mlops/
│   ├── rg_emr/
│   └── rg_ui/
├── include/
│   ├── pipeline_stage.h
│   └── rg_event.h
├── third_party/
│   ├── onnxruntime/
│   └── dear_imgui/
└── docs/
    └── architecture.md   ← (this file)
```

---

## 8. Build System & Toolchain

• CMake ≥ 3.20 with `-std=c17 -Wall -Wextra -pedantic -fstack-protector-all`  
• Static analysis via **clang-tidy** (`clang-analysis.yml` pipeline)  
• Unit tests executed by **CTest**; coverage checked with **gcov** ≥ 9  

Continuous Integration runs on a local GitLab instance inside the clinic,
ensuring no PHI leaves the premises.

---

## 9. Extensibility Guidelines

1. New pipeline stages must implement `rg_stage_vtbl_t` and be registered in
   `pipeline_registry.c`.
2. Cross-cutting concerns (telemetry, audit logging) should utilise the
   Observer bus—avoid direct coupling.
3. Any new ML models must supply an ONNX graph, a JSON-schema metadata file,
   and pass the model-registry’s validation hook (`rg_registry_validate()`).

---

## 10. Regulatory Considerations

RGVS aligns with:
• IEC 62304 (Software Life-Cycle)  
• ISO 14971 (Risk Management)  
• DICOM & HL7/FHIR interoperability profiles  

The monolithic design simplifies **SOUP** (Software Of Unknown Provenance)
tracking, enabling single-unit certification.

---

**© RetinaGuard Inc. 2024 — All rights reserved.**
```