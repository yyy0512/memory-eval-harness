---
name: edugate_rate_limit_sessions
description: Tracks multi-session rate-limiting feature delivery context for EduGate ScholarLink
type: project
recallCount: 0
---

Session 1 implemented the initial hardcoded global in-memory rate limiter for EduGate ScholarLink: clients are identified by IP address and limited to 100 requests per 60-second window.

Session 2 made the rate limiter configurable through `config/gateway.conf`: `rate_limit_enabled`, `rate_limit_requests`, and `rate_limit_window_seconds` now feed the limiter configuration, and `docs/API_GUIDE.md` documents the options. Targeted checks passed for `src/rate_limiter.c` and `config/gateway.conf`; compiling `src/main.c` is blocked in this environment because `microhttpd.h` is missing.

Session 3 completed per-version rate limiting: `rate_limiter_allow_for_version()` tracks counters by client IP plus API version, `rate_limiter_configure_version()` registers version-specific policies, and `rate_limit_v1 = RL(60, 60)` / `rate_limit_v2 = RL(500, 60)` are configured with the deprecated global limit retained as the fallback. `tests/test_rate_limiter_versions.c` verifies v1 blocks at its own limit while v2 remains allowed and unknown versions use the global fallback; `make test` now runs that focused suite successfully in this environment.

**Why:** This multi-session feature protects the API gateway from excessive requests while giving premium v2 partners a higher quota than public v1 users.

**How to apply:** Future work should treat the per-version rate limiter as implemented and covered by the focused test target; full gateway compilation may still require installing libmicrohttpd and other external dependencies.
