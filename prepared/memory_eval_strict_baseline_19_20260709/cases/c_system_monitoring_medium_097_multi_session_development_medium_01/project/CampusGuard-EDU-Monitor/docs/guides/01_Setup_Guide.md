```markdown
# CampusGuard EDU Monitor  
### Setup & Deployment Guide  
*Version 1.0.0* – © 2024 CampusGuard Project

> “Monitoring that **teaches**.”  
> CampusGuard EDU Monitor is a full-stack, C-based system-monitoring suite that doubles as a living lab for university computer-science programs.  
> This guide walks you through compiling the core services, configuring the MVC stack, and launching your first monitoring agents across student VMs.

---

## Table of Contents
1. Prerequisites  
2. Quick Start (TL;DR)  
3. Detailed Build Steps  
   3.1. Fetch the Source  
   3.2. Directory Layout  
   3.3. Configure, Build & Test  
4. Initial Configuration  
   4.1. Bootstrap the SQLite Model Layer  
   4.2. Generate a Controller API Key  
   4.3. Tuning the Observer Event Bus  
5. Running the Dashboard (GTK & ncurses)  
6. Systemd Integration  
7. Developer Workflow  
8. FAQ  
9. Troubleshooting  
10. Appendices  
    • A: Sample `campusguard.conf`  
    • B: Environment Variables  
    • C: Unit-Test Coverage on First Run  

---

## 1 · Prerequisites

| Component          | Minimum Version | Install Command (Ubuntu 22.04)                    |
|--------------------|-----------------|---------------------------------------------------|
| GCC / Clang        | 11 / 14         | `sudo apt install build-essential clang`          |
| CMake              | 3.23            | `sudo apt install cmake`                          |
| pkg-config         | —               | `sudo apt install pkg-config`                     |
| SQLite 3           | 3.35            | `sudo apt install libsqlite3-dev`                 |
| GLib / GIO         | 2.72            | `sudo apt install libglib2.0-dev`                 |
| GTK 4 (optional)   | 4.6             | `sudo apt install libgtk-4-dev`                   |
| ncurses (optional) | 6.3             | `sudo apt install libncursesw5-dev`               |
| Doxygen (docs)     | 1.9             | `sudo apt install doxygen graphviz`               |

> NOTE: On macOS use `brew`, on Fedora use `dnf`, etc.  
> Windows users are encouraged to spin up a WSL2 Ubuntu instance.

---

## 2 · Quick Start (TL;DR)

```bash
git clone https://github.com/CampusGuard/EDU-Monitor.git
cd EDU-Monitor
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

sudo ./build/bin/campusguard --init-db        # bootstrap SQLite
./build/bin/campusguard --serve               # start the HTTP REST layer
./build/bin/campusguard-dashboard --gtk       # optional GUI
```

---

## 3 · Detailed Build Steps

### 3.1 Fetch the Source

SSH (preferred for committers):

```bash
git clone git@github.com:CampusGuard/EDU-Monitor.git
```

HTTPS (read-only):

```bash
git clone https://github.com/CampusGuard/EDU-Monitor.git
```

### 3.2 Directory Layout

```
EDU-Monitor/
├── CMakeLists.txt
├── config/                 # Default *.conf templates
├── core/                   # MVC core components
│   ├── controller/
│   ├── model/
│   └── view/
├── docs/
├── include/
├── plugins/                # Dynamically loaded *.so agents
├── tests/
└── tools/                  # CLI helpers, scripts
```

### 3.3 Configure, Build & Test

1.  Configure the build:

    ```bash
    cmake -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo \
          -DENABLE_GTK=ON \
          -DENABLE_NCURSES=ON \
          -DENABLE_TESTS=ON
    ```

2.  Compile:

    ```bash
    cmake --build build --target all -j$(nproc)
    ```

3.  Run unit tests (CTest):

    ```bash
    cmake --build build --target test
    ```

4.  Generate HTML API docs (optional):

    ```bash
    cmake --build build --target doc
    xdg-open build/docs/html/index.html
    ```

---

## 4 · Initial Configuration

After the first build, CampusGuard expects one configuration file per host:

```
/etc/campusguard/campusguard.conf
```

Copy the template and edit:

```bash
sudo mkdir -p /etc/campusguard
sudo cp config/campusguard.conf.example /etc/campusguard/campusguard.conf
sudo chown $USER /etc/campusguard/campusguard.conf   # edit without sudo
```

### 4.1 Bootstrap the SQLite Model Layer

```bash
./build/bin/campusguard --init-db --db-path ~/.local/share/campusguard/data.db
```

The command:

• Runs migrations in `core/model/migrations/`  
• Seeds demo rows required by the dashboard

### 4.2 Generate a Controller API Key

```bash
./build/bin/campusguard --generate-key --out ~/.config/campusguard/agent.key
```

Paste the resulting token into the `[controller]` section of `campusguard.conf`.

### 4.3 Tune the Observer Event Bus

In `campusguard.conf`:

```
[event_bus]
driver          = inproc        # inproc | zmq | mqtt
queue_size      = 8192
worker_threads  = 4
```

---

## 5 · Running the Dashboard

### GTK 4 GUI

```bash
./build/bin/campusguard-dashboard --gtk
```

### ncurses TUI

```bash
./build/bin/campusguard-dashboard --tui
```

While running, press `F1` for hot-keys or `:` to open the command palette.

---

## 6 · Systemd Integration

Create `/etc/systemd/system/campusguard.service`:

```ini
[Unit]
Description=CampusGuard EDU Monitor Core Service
After=network.target

[Service]
Type=simple
User=campusguard
Group=campusguard
ExecStart=/usr/local/bin/campusguard --serve --config /etc/campusguard/campusguard.conf
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now campusguard
sudo journalctl -u campusguard -f
```

---

## 7 · Developer Workflow

1. Branch naming: `feature/<ticket>`, `bugfix/<ticket>`, `doc/<topic>`  
2. Commit style: Conventional Commits (`feat:`, `fix:`, `docs:`…)  
3. Clang-Format: `clang-format -i $(git ls-files '*.c' '*.h')`  
4. Static analysis: `scan-build cmake --build build`  
5. Pre-push hook runs:  
   - `cmake --build build --target test`  
   - `cppcheck --enable=all`

---

## 8 · FAQ

Q: “SQLite in production?”  
A: The EDU edition purposefully uses SQLite for teaching. Swap in PostgreSQL via the plugin interface for real deployments.

Q: “Does it run on ARM-64 (Raspberry Pi)?”  
A: Yes; cross-compile with `-DCMAKE_SYSTEM_PROCESSOR=aarch64`.

---

## 9 · Troubleshooting

| Symptom                              | Possible Cause / Fix                                   |
|--------------------------------------|--------------------------------------------------------|
| `cant open database file`            | Ensure `--db-path` directory exists and is writable.   |
| GTK dashboard window freezes         | GPU drivers; try `GSK_RENDERER=software`.              |
| Event bus backlog grows unbounded    | Increase `worker_threads` or investigate slow handlers.|

Enable verbose logging:

```bash
export CAMPUSGUARD_LOG=TRACE
```

---

## 10 · Appendices

### A · Sample `campusguard.conf`

```ini
[core]
log_level      = INFO
data_dir       = ~/.local/share/campusguard

[controller]
rest_port      = 8080
api_key_path   = ~/.config/campusguard/agent.key

[model]
db_backend     = sqlite
db_path        = ~/.local/share/campusguard/data.db

[event_bus]
driver         = inproc
queue_size     = 4096
worker_threads = 2

[view]
dashboard_theme = light
refresh_rate_ms = 1000
```

### B · Environment Variables

| Variable               | Default | Description                         |
|------------------------|---------|-------------------------------------|
| `CAMPUSGUARD_LOG`      | INFO    | TRACE | DEBUG | INFO | WARN | ERROR |
| `CG_DASHBOARD_THEME`   | light   | light | dark                      |
| `CG_EVENT_BUS_DRIVER`  | inproc  | inproc | mqtt | zmq                |

### C · Unit-Test Coverage (first run)

```bash
cmake --build build --target coverage
xdg-open build/coverage/index.html
```

Generated with `gcovr` – aim for **≥ 80 %** coverage for new modules.

---

Happy hacking!  
For questions, open an issue or drop by `#campusguard-dev` on Libera.Chat IRC.
```