---
name: edugate_rate_limiting_multisession
description: EduGate ScholarLink rate-limiting multi-session feature is complete; session 3 added per-version limits and tests.
type: project
recallCount: 0
---

EduGate ScholarLink API gateway rate-limiting was delivered across three sessions. Session 1 added a global in-memory IP limiter keyed by client IP. Session 2 made the limiter configurable through `config/gateway.conf` using `rate_limit_enabled`, `rate_limit_requests`, and `rate_limit_window_seconds`, with defaults set to enabled, 100 requests, and 60 seconds. Session 3 refactored the limiter to track counters by `(client IP, API version)`, added per-version config entries `rate_limit_v1 = 60:60` and `rate_limit_v2 = 500:60` represented in C as `rate_limit_v1 = RL(60, 60)` and `rate_limit_v2 = RL(500, 60)`, and kept the old global settings as the fallback for unknown or unversioned requests. The standalone gateway derives `v1`/`v2` from URL prefixes and calls the version-aware limiter; over-limit requests return HTTP 429. A focused test suite in `tests/test_rate_limiter_versions.c` verifies that v1 blocks after its configured limit, v2 remains independently allowed when v1 is blocked, and unknown versions fall back to the default limit. `make test` compiles and runs that focused suite successfully.

**Why:** The user incrementally added protection against excessive API requests, ending with premium `v2` partners requiring a higher limit than public `v1` users.

**How to apply:** Future work should preserve the version-aware `(IP, version)` limiter semantics and the default fallback behavior. If broader gateway tests are revisited, note that the Makefile's focused `test` target currently avoids unrelated existing cmocka/external-dependency tests so rate-limiter verification can run in this environment.
