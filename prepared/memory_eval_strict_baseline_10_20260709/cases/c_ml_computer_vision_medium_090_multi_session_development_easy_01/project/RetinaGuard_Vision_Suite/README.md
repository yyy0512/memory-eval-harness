```markdown
# RetinaGuard Vision Suite

RetinaGuard Vision Suite is a **monolithic, on-device C application** that performs fully-automated diabetic-retinopathy (DR) analysis on retinal fundus photographs captured in primary-care and rural clinics.  
The suite ingests images directly from DICOM-compatible cameras, executes a highly-optimized computer-vision pipeline, and writes structured results (ICD-10 codes, DR stage, longitudinal trend metrics) back to the clinic’s EMR—**without any external network dependency**.

> ⚠️  RetinaGuard is certified as *Class II* medical device software in several jurisdictions.  
> Building from source requires that you follow the steps below **verbatim** to preserve the validated tool-chain and guarantee bit-for-bit reproducibility.

---

## Table of Contents
1. Features
2. Architecture Overview
3. Build & Install
4. Quick-Start
5. Runtime Configuration
6. Pipeline Stages
7. Observer & Registry Interfaces
8. MLOps Workflows
9. Testing Strategy
10. Safety & Regulatory Considerations
11. Contributing
12. License

---

## 1. Features
| Category            | Highlights                                                                                                    |
|---------------------|----------------------------------------------------------------------------------------------------------------|
| Feature Engineering | Micro-aneurysm heat-maps, exudate masks, optic-disc localization, vessel segmentation                          |
| Model Inference     | Ensemble of quantized CNNs (DR-Net v2, Lesion-Net, Vessel-Seg) running via XNNPACK                              |
| Visualization       | Overlays delivered as PNG+JSON, interactive CLI explorer, on-device Web dashboard                              |
| Model Monitoring    | Drift detection (ψ-statistic), per-class AUC tracking, clinician feedback loop                                 |
| Versioning          | Immutable model registry, semantic version tags, SBOM generation                                              |
| MLOps               | On-device scheduled retraining, hyper-parameter sweeps (Δ-grid)                                               |
| EMR Integration     | HL7 ORU^R01 + FHIR DiagnosticReport emitters, end-to-end acknowledgement tracking                             |

---

## 2. Architecture Overview
RetinaGuard follows a **Pipeline Pattern** consisting of six in-process stages:

```text
┌────────────────┐  ┌──────────────────┐  ┌────────────────┐
│ Image Ingest   │→│ Pre-Processing    │→│ Feature Extract │
└────────────────┘  └──────────────────┘  └────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌────────────────┐  ┌──────────────────┐  ┌────────────────┐
│ Model Infer    │→│ Evaluation & QC   │→│ Visualization   │
└────────────────┘  └──────────────────┘  └────────────────┘
```

Each stage emits `rg_event_t` notifications that travel through an **Observer Hub**:

```
              ┌─────────────────────────┐
              │   Observer Hub (pub)    │
              └─────────────┬───────────┘
                            │
          ┌─────────────────┴─────────────────┐
          │                                   │
┌───────────────────┐             ┌──────────────────┐
│ Model Registry    │             │ Monitoring Dash  │
└───────────────────┘             └──────────────────┘
```

---

## 3. Build & Install

### 3.1 Prerequisites
* C11-compliant compiler (GCC 12+, Clang 15+)
* `cmake` ≥ 3.24
* OpenCV 4.7 (built with `-DWITH_OPENCL=ON -DWITH_TBB=ON`)
* ONNX-Runtime 1.15 (build option `--build_shared_lib=ON`)
* libpng, zlib
* SQLite 3.38 (for on-device DB)
* POSIX-threads

### 3.2 Build Steps

```bash
# 1. Clone recursively (model zoo submodule included)
$ git clone --recurse-submodules https://github.com/retinaguard/rg-suite.git
$ cd rg-suite

# 2. Export medically-certified tool-chain
$ export CC=/opt/med/gcc-12/bin/gcc
$ export CFLAGS='-O3 -march=native -fno-omit-frame-pointer -D_FORTIFY_SOURCE=2'

# 3. Configure
$ cmake -B build -DCMAKE_BUILD_TYPE=Release

# 4. Compile + run static analyzers (Clang-Tidy, Cppcheck)
$ cmake --build build --target all checks

# 5. Install into /opt/retinaguard
$ sudo cmake --install build
```

The resulting executable `rg_suite` is placed in `/opt/retinaguard/bin` and **cryptographically signed** to preserve chain-of-custody.

---

## 4. Quick-Start

```bash
# Run a single JPEG through the pipeline, visualize, and push to EMR
$ rg_suite \
    --input   samples/fundus_00042.jpg \
    --patient 987654 \
    --visit   2023-09-15 \
    --emr     tcp://10.0.0.42:5017 \
    --viz     out/00042_overlay.png
```

CLI output:

```
[ingest] 2560x2048 RGB image loaded in 11 ms
[pre]    Lens-shade corrected, contrast normalized
[feat]   Vessels segmented (41 ms), disc localized (3 ms)
[infer]  DR-Net v2 predicts  R3 : 0.846  (threshold 0.7) ✅
[eval]   QC PASSED (sharpness 0.91, illumination 0.80)
[viz]    Overlay written to out/00042_overlay.png
[emr]    HL7 ORU^R01 ACK received in 12 ms
```

---

## 5. Runtime Configuration
Runtime parameters are read **first** from `/etc/retinaguard/rg.conf`, then overridden by environment variables and, finally, by CLI flags.

```ini
; /etc/retinaguard/rg.conf
[PATHS]
model_dir   = /opt/retinaguard/models
db_path     = /var/lib/retinaguard/rg.db

[MLOPS]
schedule    = 0 3 * * 0        ; retrain Sundays at 03:00
grid_size   = 24
retain_snap = 8

[ALERTS]
progression_threshold = 0.15   ; ΔDR stage to alert clinician
email_relay           = smtp://mail.local:25
```

---

## 6. Pipeline Stages

| Stage            | Key Algorithms / Modules         | Config Flags        |
|------------------|----------------------------------|---------------------|
| Pre-Processing   | CLAHE, homomorphic filtering     | `--clahe-limit`     |
| Feature Extract  | VesselNet-Seg, U-Net disc detect | `--disc-thr`        |
| Model Infer      | DR-Net (5-class), Lesion-Net     | `--batch-size`      |
| Evaluation & QC  | Sharpness, illumination metrics  | `--qc-thr-sharp`    |
| Visualization    | Alpha-blended lesion heat-maps   | `--viz-palette`     |

---

## 7. Observer & Registry Interfaces

**Header:** `include/rg_observer.h`

```c
/*!
 * @brief   Event type emitted by pipeline stages.
 */
typedef enum {
    RG_EVT_PREPROC_DONE,
    RG_EVT_FEATURES_READY,
    RG_EVT_INFERENCE_DONE,
    RG_EVT_QC_FAILED,
    RG_EVT_PERSISTED
} rg_evt_type_t;

/*!
 * @brief   Payload for all Observer events.
 */
typedef struct {
    rg_evt_type_t type;
    uint64_t      timestamp_us;
    const char   *patient_id;
    const char   *image_id;
    union {
        struct { float sharpness, illumination; } qc;
        struct { int dr_grade; float prob[5];   } infer;
    } data;
} rg_event_t;

/*!
 * @note Listeners are registered at runtime via rg_observer_subscribe().
 */
typedef void (*rg_listener_fn)(const rg_event_t *evt, void *user);

/*!
 * Register an event listener.
 */
int rg_observer_subscribe(rg_listener_fn cb, void *user);

/*!
 * Internally called by stages to broadcast events.
 */
int rg_observer_publish(const rg_event_t *evt);
```

The **Model Registry** (`src/registry/rg_registry.c`) subscribes to `RG_EVT_INFERENCE_DONE`, writes an immutable record to `rg.db`, and bumps semantic version if drift criteria are met.

---

## 8. MLOps Workflows

On-device *cron-like* scheduler (`rg_cron.c`) triggers the retraining pipeline:

1. Extract latest N cases per DR stage from SQLite.
2. Spawn a sandboxed child process (`seccomp` profile) to run `rg_train`.
3. Perform Δ-grid hyper-parameter sweep across learning-rate, β-regularization.
4. Measure AUC on hold-out clinic data; retain model if **AUC↑ ≥ 0.02**.
5. Register new model in registry → propagate event → live inference hot-swap.

All artifacts (model weights, SBOM, unit-test logs) are hashed with SHA-256 and stored under `/var/lib/retinaguard/registry/{semver}/`.

---

## 9. Testing Strategy

* **Unit Tests**: `ctest --output-on-failure` (92% line coverage, target ≥ 90%).
* **Static Analysis**: Clang-Tidy (MISRAC++ subset), Cppcheck.
* **Fuzzing**: `libFuzzer` corpora for JPEG decoder & heat-map renderer.
* **Hardware-in-loop (HIL)**: Simulate camera feed via GStreamer on CI.
* **Regression Datasets**: 12 k images with ground-truth from Moorfields Eye Hospital.

Test summary reports land in `build/reports/` and fail the CI if any **SEV-HIGH** bug is introduced.

---

## 10. Safety & Regulatory Considerations

RetinaGuard adheres to:

* IEC 62304:2015 – Medical Device Software Lifecycle
* ISO 14971:2019 – Risk Management
* HIPAA §164.312(e) – Transmission Security (emr module uses TLS 1.3)
* GDPR Art. 32 – Data Security (all PHI encrypted at rest using AES-256-GCM)

A full **Software Safety Classification** (Class B) is available in `docs/safety_analysis/`.

---

## 11. Contributing

1. Fork the repo and create feature branches (`feat/short-description`).
2. Run `./scripts/pre-commit.sh` (format, lint, unit tests).
3. Sign commits (`-S`) to comply with DCO.
4. Submit a pull request; at least one senior reviewer and one clinical reviewer are required.

See `CONTRIBUTING.md` for coding style (LLVM), commit message schema (`<type>: <scope>: <subject>`), and review SLAs.

---

## 12. License

```
Copyright (c) 2023-2024 RetinaGuard

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

For third-party dependencies (OpenCV, ONNX-Runtime, etc.), refer to `THIRD_PARTY_NOTICES.txt`.

---

_Secure Vision for Every Clinic._  
**RetinaGuard Vision Suite** – Because blindness is preventable.

```