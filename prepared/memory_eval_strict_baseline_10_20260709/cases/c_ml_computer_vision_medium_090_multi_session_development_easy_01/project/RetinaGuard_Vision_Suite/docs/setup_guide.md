```markdown
# RetinaGuard Vision Suite – Setup Guide
A comprehensive, step-by-step guide for clinicians, biomedical engineers, and field technicians who need to compile, configure, and deploy **RetinaGuard Vision Suite** (RGVS) on on-premise workstations inside primary-care clinics.

> This document covers:
> 1. Hardware & OS requirements  
> 2. Dependency installation  
> 3. Building the monolithic executable (`retinaguard`) with **CMake**  
> 4. Initialising the on-device model registry & database  
> 5. Verifying the installation with a sample retinal image  
> 6. Performing an air-gapped upgrade

---

## 1. Minimum Hardware & Operating-System Requirements
| Component | Recommended | Notes |
|-----------|-------------|-------|
| CPU       | Quad-core x86-64 (≥ 2.4 GHz) | Supports SIMD (SSE4.2) for accelerated preprocessing |
| GPU (optional) | NVIDIA GTX 1650 (compute ≈ 4.4 TFLOPS) | Only required when `-DENABLE_CUDA=ON` |
| RAM       | 8 GB        | 16 GB for automated retraining |
| Storage   | 20 GB SSD   | Stores local model registry & longitudinal studies |
| OS        | Ubuntu 22.04 LTS or Windows 10 Pro (21H2) | 64-bit only |

> RetinaGuard has been smoke-tested on Raspberry Pi 4 (8 GB) with Vulkan acceleration; however inference times are ~4× slower.

---

## 2. Dependency Installation

### Ubuntu 22.04 LTS
```bash
# Update package index
sudo apt update

# Essential build tools + CMake ≥ 3.18
sudo apt install -y build-essential cmake pkg-config git

# Image processing libraries
sudo apt install -y libopencv-dev libpng-dev libjpeg-dev libtiff-dev

# Machine-learning & math libs
sudo apt install -y libopenblas-dev liblapack-dev

# SQLite for on-device database
sudo apt install -y libsqlite3-dev

# Optional: CUDA Toolkit 11.8 (GPU inference)
# https://developer.nvidia.com/cuda-downloads – follow NVIDIA instructions
```

### Windows 10 Pro
1. Install [Visual Studio 2022 Community](https://visualstudio.microsoft.com/vs/community/)  
   • Workloads → *Desktop development with C++*  
2. Install [CMake 3.22+](https://cmake.org/download/) and add it to your `PATH`.  
3. Install [vcpkg](https://github.com/microsoft/vcpkg) and bootstrap it:

```powershell
git clone https://github.com/microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.bat
```

4. Acquire packages:

```powershell
.\vcpkg.exe install opencv[core,jpeg,png,tiff]:x64-windows sqlite3:x64-windows
```

5. (Optional) Install CUDA 11.8 via NVIDIA installer.

---

## 3. Building the Executable

> The source tree is organised as a monorepo with CMake super-build support.

### Clone the Repository
```bash
git clone https://github.com/clinic-ai/RetinaGuard_Vision_Suite.git
cd RetinaGuard_Vision_Suite
```

### Configure & Build (Linux)
```bash
mkdir -p build && cd build

# Disable CUDA by default; enable with -DENABLE_CUDA=ON
cmake .. -DCMAKE_BUILD_TYPE=Release \
         -DENABLE_CUDA=OFF \
         -DENABLE_MLOPS=ON \
         -DENABLE_DASHBOARD=ON

# Compile using all logical cores
cmake --build . --parallel $(nproc)
```

### Configure & Build (Windows / VS 2022)
```powershell
mkdir build ; cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=C:\path\to\vcpkg\scripts\buildsystems\vcpkg.cmake `
         -G "Visual Studio 17 2022" -A x64 `
         -DENABLE_CUDA=ON -DENABLE_MLOPS=ON
cmake --build . --config Release
```

Upon success, the `retinaguard` (or `retinaguard.exe`) executable is found in:
```
build/bin/Release/
```

---

## 4. Post-Build Initialisation

### 4.1 Model Registry Bootstrap
The first launch creates an empty registry at  
`$RGVS_DATA_DIR/models/registry.sqlite3`.

To pre-seed with FDA-cleared model weights:

```bash
./bin/retinaguard --import-models assets/models/dr_grader_v2.1.tar.gz
```

> Note: Importing weights triggers SHA-256 integrity checks and provenance verification to ensure regulatory compliance.

### 4.2 Database Migration
RetinaGuard ships with embedded sqlite schema migrations. Run:

```bash
./bin/retinaguard --migrate-db
```

This creates tables for:
* `patients`
* `studies`
* `inference_events`
* `model_metrics`

---

## 5. Verifying the Installation

### Download a Public-Domain Test Image
```bash
wget -O demo_fundus.jpg \
  https://public-retinopathy-datasets.org/sample/DR0_001.jpg
```

### Execute a Dry-Run
```bash
./bin/retinaguard \
   --input demo_fundus.jpg \
   --output ./out \
   --no-dashboard      # Disable GUI for headless verification
```

Expected console output:
```
[INFO]  Quality Control: PASS  (sharpness=0.94, illumination=0.88)
[INFO]  Stage: Feature   Extraction …  done (31 ms)
[INFO]  Stage: Model     Inference …  done (57 ms)
[INFO]  DR Grading: NO_DIABETIC_RETINOPATHY (p=0.985)
[INFO]  Visualization saved to ./out/demo_fundus_overlay.png
```

The exit code `0` confirms a healthy pipeline.

---

## 6. Air-Gapped Upgrades

Because rural clinics often lack reliable Internet, RGVS supports USB-based upgrades.

1. Download the signed update pack (`retinaguard-vX.Y.Z.upkg`) from the secure vendor portal.  
2. Copy it to a FAT32-formatted USB flash drive.  
3. On the clinic workstation, insert the drive and run:

```bash
./bin/retinaguard --upgrade /media/usb/retinaguard-vX.Y.Z.upkg
```

4. Verify signature:

```
[INFO] Verifying signature with RSA-2048 … OK
[INFO] Upgrading from v1.4.2 → v1.5.0
[INFO] Restarting … done
```

---

## 7. Troubleshooting

| Symptom | Possible Cause | Resolution |
|---------|----------------|------------|
| `libopencv_core.so.4.5: cannot open shared object file` | OpenCV runtime not in linker path | `sudo ldconfig` or add `/usr/local/lib` to `/etc/ld.so.conf.d/opencv.conf` |
| `CUDA driver not found` | NVIDIA driver < 510 | Upgrade to NVIDIA **510+** |
| Dashboard shows blank screen | Missing WebView2 runtime (Windows) | Install [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |

---

## 8. Uninstalling

```bash
# Remove binaries
sudo rm /usr/local/bin/retinaguard

# Remove application data (models, DB, logs)
rm -rf ~/.retinaguard
```

---

## 9. Support

For enterprise customers, open a ticket at  
`support@clinic-ai.com` with:
* `retinaguard --version`
* Full `--diag` output
* Build logs (`build/CMakeFiles/…/build.log`)

---

© 2024 Clinic AI Technologies | All rights reserved.  
Licensed to authorised clinics under the RetinaGuard EULA.
```