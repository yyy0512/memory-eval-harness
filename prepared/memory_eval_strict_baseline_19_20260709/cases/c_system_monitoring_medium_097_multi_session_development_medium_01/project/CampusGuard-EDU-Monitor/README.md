```markdown
# CampusGuard EDU Monitor  
_Professional-grade, C-based system-monitoring and DevSecOps learning suite_

![CI](https://img.shields.io/github/actions/workflow/status/university-systems-lab/CampusGuard-EDU-Monitor/ci.yml?branch=main)
![License](https://img.shields.io/github/license/university-systems-lab/CampusGuard-EDU-Monitor)

---

## 1  |  Motivation

CampusGuard EDU Monitor brings industry-proven monitoring, log aggregation, security scanning and
backup automation into the classroom.  
The project is designed around a clean Model–View–Controller (MVC) core
and leverages additional patterns (Observer, Chain-of-Responsibility, Event-Driven, Service Mesh)
to show students how **professional DevSecOps software** is
structured, built and maintained *in real life*.

---

## 2  |  Feature Matrix

| Category            | Highlighted Capabilities                                                                  |
|---------------------|-------------------------------------------------------------------------------------------|
| System Monitoring   | Live CPU/RAM/Net metrics via `libstatgrab`, pluggable sensor bus                          |
| Log Aggregation     | Journald/Syslog tailing, time-window queries, regex/PCRE alerts                           |
| Security Scanning   | CVE feed sync, port-sweep, file-integrity (SHA-256 fan-out)                               |
| Backup & Recovery   | Incremental `rsync` snapshots, auto-purge policy, push-button DR simulation               |
| Deployment Pipeline | Git-based IaC manifests → CI → lab VM service-mesh rollout                                |

All components are exposed through a lightweight GTK or ncurses dashboard,
plus an internal REST API for scripting or data-science exercises.

---

## 3  |  High-Level Architecture

```
┌───────────┐   Observer   ┌──────────────┐   Chain-of-Resp.  ┌─────────────┐
│  Sensors  │ ───────────▶ │ Event Broker │ ─────────────────▶│ Controllers │
└───────────┘              └──────────────┘                   └────┬────────┘
     ▲                            ▲                                 │
     │ Publish                    │ Store                           │ REST
┌────┴─────┐               ┌──────┴────────┐                       ▼
│  Models  │◀──────────────│  SQLite/FS    │◀─────────────────┌──────────┐
└──────────┘   CQRS/CRUD   └───────────────┘   Snapshot/Logs   │  Views   │
                                                             └──────────┘
```

*Every* interaction is propagated as an event, providing a consistent, testable funnel for
permissions, audit logging, replay and classroom observability demos.

---

## 4  |  Getting Started

### 4.1  Prerequisites

* GNU Make 4.0+ or **Meson 0.63+** / Ninja
* `gcc` 11 or `clang` 14
* `pkg-config`, `sqlite3`-dev, `glib-2.0`-dev, `libcurl`-dev, `libstatgrab`-dev  
  _(all available on Debian/Ubuntu/Fedora/Arch)_

### 4.2  Build (Makefile)

```bash
git clone https://github.com/university-systems-lab/CampusGuard-EDU-Monitor
cd CampusGuard-EDU-Monitor
make        # parallel build automatically detected
sudo make install PREFIX=/opt/campusguard
```

Or with Meson:

```bash
meson setup build
meson compile -C build
sudo meson install -C build
```

### 4.3  Run Lab Demo

```bash
# Start core services on the instructor workstation
campusguard-broker --config cfg/broker.toml &
campusguard-controller http://localhost:7490 &

# Launch a simulated VM agent
campusguard-agent --join http://localhost:7490 --vm-id vm01 &

# Bring up the ncurses dashboard on any terminal
campusguard-dashboard
```

Sensors will begin emitting metrics immediately; try
`printf 'scan quick\n' | campusguard-cli` to queue a CVE scan.

---

## 5  |  Directory Map

```
.
├── cfg/                  # TOML/YAML default configs
├── docs/                 # Extra documentation (Doxygen, tutorials)
├── src/
│   ├── core/             # Event bus, middleware, common utilities
│   ├── controller/       # Permission chain, job scheduler
│   ├── model/            # SQLite DAL, backup manager
│   ├── sensors/          # CPU, memory, net, FIM, CVE modules
│   └── ui/               # GTK, ncurses, REST
├── tests/                # Criterion & CMocka unit/integration tests
└── tools/                # Helper scripts (log-replayer, seed-db)
```

---

## 6  |  Code Style & Conventions

* C17 dialect, `-Wall -Wextra -Werror -pedantic`
* `clang-format` enforced via CI
* Single-header public APIs, `_priv.h` for internal declarations
* **Strong error-handling**: Early returns, `GError*` style for library calls
* Unit tests must reach **≥ 85 % line coverage** before merge

See `docs/contributing.md` for full guidelines.

---

## 7  |  Example: Writing a Custom Sensor

Below is a *fully functional* temperature sensor that pushes events every
15 seconds via the observer API.

```c
/*
 * temp_sensor.c — Example plug-in
 * Compile with:
 *   gcc -fPIC -shared temp_sensor.c -o libtempc.so $(pkg-config --cflags --libs glib-2.0)
 */
#include <glib.h>
#include "cg_sensor.h"          /* Public sensor API */

static gboolean
publish_temperature(gpointer bus)
{
    double temp = g_random_double_range(20.0, 75.0);  /* mock data */

    cg_event_t ev = {
        .type   = CG_EVENT_METRIC,
        .origin = "temp-sensor",
        .metric = { .name = "core.temp", .value = temp, .unit = "°C" }
    };
    return cg_bus_publish(bus, &ev);
}

G_MODULE_EXPORT cg_sensor_plugin_t *
cg_sensor_init(void)
{
    static cg_sensor_plugin_t plugin = {
        .name        = "temperature",
        .version     = "1.0",
        .interval_ms = 15 * 1000,
        .tick_cb     = publish_temperature
    };
    return &plugin;
}
```

Place the resulting `libtempc.so` in `/opt/campusguard/sensors/` and restart
`campusguard-agent`; the new metric becomes instantly available in the dashboard.

---

## 8  |  Testing

```bash
# Run fast unit tests
ctest --output-on-failure

# Full integration (docker-compose lab)
./tools/test-lab.sh
```

A GitHub Actions pipeline executes both paths for every pull request.

---

## 9  |  Security Model

1. All IPC is over mutual-TLS (`wolfSSL`) with short-lived certs
2. Each Controller step validates an ACL token (`libsodium` MAC)
3. Sensitive blobs (backups, scan results) are encrypted at rest (`AES-256 GCM`)
4. Secrets are injected only at runtime via `tmpfs` + `systemd-creds`

---

## 10  |  License

CampusGuard EDU Monitor is released under the **MIT License**—see `LICENSE`.

---

## 11  |  Acknowledgements

The project was created and is maintained by the
[University Systems Laboratory](https://github.com/university-systems-lab).  
We thank the open-source community and *every* student contributor for making
CampusGuard a vibrant teaching platform.

Happy hacking! :rocket:
```