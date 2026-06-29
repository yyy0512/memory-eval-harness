---
name: edugate_rate_limiting_multisession
description: EduGate ScholarLink rate-limiting work is being delivered over multiple sessions; session 2 made the in-memory IP limiter configurable.
type: project
recallCount: 0
---

EduGate ScholarLink API gateway rate-limiting is a multi-session feature. Session 1 added a global in-memory IP limiter keyed by client IP. Session 2 made the limiter configurable through `config/gateway.conf` using `rate_limit_enabled`, `rate_limit_requests`, and `rate_limit_window_seconds`, with defaults set to enabled, 100 requests, and 60 seconds. The standalone gateway reads those compiled-in values at startup and passes them to `rate_limiter_configure`; requests over the limit return HTTP 429. `docs/API_GUIDE.md` now documents the three configuration options.

**Why:** The user is incrementally adding protection against excessive API requests; session 2 specifically required configuration and documentation instead of hardcoded limiter constants.

**How to apply:** In future sessions, build on the configurable in-memory limiter rather than replacing it unnecessarily. Automated tests are still expected in a later session. Local verification compiled `src/rate_limiter.c` and separately compiled a `config/gateway.conf` include check; compiling/running the full gateway may still be blocked in this environment because libmicrohttpd development headers are unavailable.
