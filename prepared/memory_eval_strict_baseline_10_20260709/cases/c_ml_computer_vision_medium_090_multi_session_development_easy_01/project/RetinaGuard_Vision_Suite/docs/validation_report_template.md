```markdown
<!--
###############################################################################
# RetinaGuard Vision Suite                                                     #
# Validation Report Template                                                   #
# --------------------------------------------------------------------------- #
# This Markdown template is used to generate the formal *Model Validation     #
# Report* required for each RetinaGuard Vision Suite release and/or automated #
# retraining cycle.                                                            #
#                                                                              #
# NOTE: All {{PLACEHOLDER}} tokens MUST be programmatically substituted by    #
#       the build-system target `make validation-report`.                      #
###############################################################################
-->

# RetinaGuard Vision Suite — Model Validation Report  
**Model Family:** Diabetic Retinopathy Detection  
**Document ID:** {{REPORT_ID}}  
**Model Version:** {{MODEL_VERSION}}  
**Code Commit:** {{GIT_SHA}}  
**Build ID:** {{BUILD_ID}}  
**Generated On:** {{DATETIME_RFC3339}}  

Prepared by **{{ENGINEER_NAME}}**

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [System Configuration](#system-configuration)
3. [Dataset Description](#dataset-description)
4. [Methodology](#methodology)
5. [Performance Metrics](#performance-metrics)
6. [Error Analysis](#error-analysis)
7. [Compliance & Safety Checks](#compliance--safety-checks)
8. [Regression Against Prior Model](#regression-against-prior-model)
9. [Observer Events Audit](#observer-events-audit)
10. [Reproducibility Commands](#reproducibility-commands)
11. [Sign-Off](#sign-off)

---

## Executive Summary
| Item | Value |
|------|-------|
| **Overall AUROC** | {{METRIC.AUROC}} |
| **Operating Threshold** | {{OPERATING_THRESHOLD}} |
| **Sensitivity @ Threshold** | {{METRIC.SENSITIVITY}} |
| **Specificity @ Threshold** | {{METRIC.SPECIFICITY}} |
| **PPV / NPV** | {{METRIC.PPV}} / {{METRIC.NPV}} |
| **Calibration Error (ECE)** | {{METRIC.ECE}} |
| **Recommendation** | {{SUMMARY.RECOMMENDATION}} |

> {{SUMMARY.NARRATIVE}}

---

## System Configuration
| Component            | Specification                          |
|----------------------|----------------------------------------|
| **CPU**              | {{SYS.CPU_MODEL}} × {{SYS.CPU_COUNT}} |
| **GPU**              | {{SYS.GPU_MODEL}} (Driver {{SYS.GPU_DRIVER}}) |
| **RAM**              | {{SYS.RAM_GB}} GB |
| **Operating System** | {{SYS.OS_VERSION}} |
| **Compiler**         | {{SYS.COMPILER}} (Flags: `{{SYS.CFLAGS}}`) |
| **Build Mode**       | {{SYS.BUILD_MODE}} (`Debug` / `Release`) |
| **Link Time**        | {{SYS.BUILD_TIME}} sec |

```c
/* Auto-generated snippet: Validate exact runtime configuration */
#include <retinaguard/version.h>
#include <retinaguard/system.h>

int main(void)
{
    rg_system_info_t info;
    if (rg_get_system_info(&info) != 0) {
        fprintf(stderr, "System inspection failed\n");
        return EXIT_FAILURE;
    }
    rg_print_system_info(&info, stdout);
    return EXIT_SUCCESS;
}
```

---

## Dataset Description
| Attribute                       | Value |
|---------------------------------|-------|
| **Dataset Name**                | {{DATASET.NAME}} |
| **Collection Period**           | {{DATASET.PERIOD}} |
| **Total Images**                | {{DATASET.SIZE_TOTAL}} |
| **Unique Patients**             | {{DATASET.PATIENT_COUNT}} |
| **Acquisition Devices**         | {{DATASET.DEVICES}} |
| **Demographic Breakdown**       | {{DATASET.DEMOGRAPHICS}} |
| **DR Prevalence**               | {{DATASET.PREVALENCE}}% |
| **Train / Validation / Test**   | {{DATASET.SPLITS}} |

> *Inclusion / Exclusion Criteria:* {{DATASET.CRITERIA}}

---

## Methodology
1. **Pre-processing Pipeline**  
   - Resize → CLAHE → Color-constancy normalization  
   - Optic-disc masking using Hough-transform.  
2. **Feature Engineering**  
   Micro-aneurysm heat-maps, Hard-exudate segmentation masks.  
3. **Inference Model**  
   `resnet50 + attention-gated FPN` trained with **focal-loss (γ = 2.0)**.  
4. **Evaluation Protocol**  
   Stratified 5-fold cross-validation, patient-level holdout.  

---

## Performance Metrics

### 5.1 Overall Metrics
| Metric | Value | CI 95% |
|--------|-------|--------|
| **AUROC** | {{METRIC.AUROC}} | {{METRIC.AUROC_CI}} |
| **Accuracy** | {{METRIC.ACCURACY}} | {{METRIC.ACCURACY_CI}} |
| **Sensitivity** | {{METRIC.SENSITIVITY}} | {{METRIC.SENSITIVITY_CI}} |
| **Specificity** | {{METRIC.SPECIFICITY}} | {{METRIC.SPECIFICITY_CI}} |
| **F1-Score** | {{METRIC.F1}} | {{METRIC.F1_CI}} |

### 5.2 Stage-Wise Metrics
| DR Stage | Sensitivity | Specificity | AUROC |
|----------|-------------|-------------|-------|
| **No DR (0)** | {{METRIC.SENS0}} | {{METRIC.SPEC0}} | {{METRIC.AUC0}} |
| **Mild (1)** | {{METRIC.SENS1}} | {{METRIC.SPEC1}} | {{METRIC.AUC1}} |
| **Moderate (2)** | {{METRIC.SENS2}} | {{METRIC.SPEC2}} | {{METRIC.AUC2}} |
| **Severe (3)** | {{METRIC.SENS3}} | {{METRIC.SPEC3}} | {{METRIC.AUC3}} |
| **PDR (4)** | {{METRIC.SENS4}} | {{METRIC.SPEC4}} | {{METRIC.AUC4}} |

### 5.3 Calibration Curve
![Calibration Plot](assets/{{PLOTS.CALIBRATION_IMG}})

### 5.4 Confusion Matrix
|               | Predicted Non-Referable | Predicted Referable |
|---------------|------------------------|---------------------|
| **True Non-Referable** | {{CM.TN}} | {{CM.FP}} |
| **True Referable**     | {{CM.FN}} | {{CM.TP}} |

---

## Error Analysis
**Top-N Misclassified Images (Likely Failure Modes)**  

| Rank | Image ID | Ground Truth | Prediction | Confidence | Notes |
|------|----------|--------------|------------|------------|-------|
| 1 | {{ERRORS.IMG1_ID}} | {{ERRORS.IMG1_GT}} | {{ERRORS.IMG1_PRED}} | {{ERRORS.IMG1_CONF}} | {{ERRORS.IMG1_NOTE}} |
| 2 | {{ERRORS.IMG2_ID}} | {{ERRORS.IMG2_GT}} | {{ERRORS.IMG2_PRED}} | {{ERRORS.IMG2_CONF}} | {{ERRORS.IMG2_NOTE}} |
| … | … | … | … | … | … |

> *Clinician Comment:* {{ERRORS.CLINICIAN_COMMENT}}

---

## Compliance & Safety Checks
| Check | Status | Details |
|-------|--------|---------|
| **HIPAA Dataset Encryption** | {{CHECK.HIPAA_DATA_ENCRYPT}} | {{CHECK.HIPAA_DATA_ENCRYPT_NOTE}} |
| **ISO 13485 Traceability** | {{CHECK.ISO_TRACE}} | {{CHECK.ISO_TRACE_NOTE}} |
| **IEC 62304 Classification** | {{CHECK.SOFTWARE_CLASS}} | {{CHECK.SOFTWARE_CLASS_NOTE}} |
| **Clinical Thresholds Met** | {{CHECK.THRESHOLDS_MET}} | Sens ≥ 85%, Spec ≥ 80% |

---

## Regression Against Prior Model
| Metric | Current (v{{MODEL_VERSION}}) | Previous (v{{PREV_MODEL_VERSION}}) | Δ |
|--------|-----------------------------|------------------------------------|---|
| **AUROC** | {{METRIC.AUROC}} | {{PREV_METRIC.AUROC}} | {{DELTA.AUROC}} |
| **Sensitivity** | {{METRIC.SENSITIVITY}} | {{PREV_METRIC.SENSITIVITY}} | {{DELTA.SENSITIVITY}} |
| **Specificity** | {{METRIC.SPECIFICITY}} | {{PREV_METRIC.SPECIFICITY}} | {{DELTA.SPECIFICITY}} |

> Regression test **{{REGRESSION_STATUS}}**.

---

## Observer Events Audit
Captured via in-process **Observer Pattern** hooks.

| Event Type | Count | Last Timestamp |
|------------|-------|----------------|
| `INFERENCE_START` | {{OBS.EVENT_INFER_START}} | {{OBS.EVENT_INFER_START_LAST}} |
| `INFERENCE_END` | {{OBS.EVENT_INFER_END}} | {{OBS.EVENT_INFER_END_LAST}} |
| `MODEL_REGISTRY_UPDATE` | {{OBS.EVENT_REG_UPDATE}} | {{OBS.EVENT_REG_UPDATE_LAST}} |
| `ALERT_TRIGGERED` | {{OBS.EVENT_ALERT}} | {{OBS.EVENT_ALERT_LAST}} |

---

## Reproducibility Commands
```bash
# 1. Checkout exact commit
git checkout {{GIT_SHA}}

# 2. Build with deterministic flags
make clean && CFLAGS="-O2 -march=native -Werror" make all

# 3. Run validation harness
./bin/retinaguard --validate \
                  --config configs/validation.toml \
                  --output {{REPORT_OUTPUT_DIR}}

# 4. Generate this report
make validation-report
```

---

## Sign-Off
| Role | Name | Signature | Date |
|------|------|-----------|------|
| ML Engineer | {{SIGNOFF.ENGINEER}} | {{SIGNOFF.ENGINEER_SIG}} | {{SIGNOFF.ENGINEER_DATE}} |
| QA Lead | {{SIGNOFF.QA}} | {{SIGNOFF.QA_SIG}} | {{SIGNOFF.QA_DATE}} |
| Medical Advisor | {{SIGNOFF.MEDICAL}} | {{SIGNOFF.MEDICAL_SIG}} | {{SIGNOFF.MEDICAL_DATE}} |

---

<!-- End of template -->
```