---
name: EduGate rate limiting rollout
description: Multi-session project context for adding IP-based rate limiting to EduGate ScholarLink API gateway.
type: project
recallCount: 0  # Number of times this memory has been recalled (auto-maintained)
---

EduGate ScholarLink API gateway is being updated across multiple sessions to add a rate-limiting feature. Session 1 implemented a basic global in-memory limiter in `EduGate_ScholarLink/src/rate_limiter.c`/`.h` that blocks a client IP after 100 requests in a 60-second window. It is integrated in `EduGate_ScholarLink/src/main.c` at the libmicrohttpd callback before route dispatch and uses `MHD_get_connection_info(...CLIENT_ADDRESS)` with `inet_ntop` for IPv4/IPv6. The Makefile includes `src/rate_limiter.c`. Configurability and automated tests are intentionally deferred to later sessions.

**Why:** The user framed this as session 1 of a multi-session development task and explicitly needs context retained between sessions.

**How to apply:** In future sessions, continue from the assumption that the initial implementation should be simple and hardcoded unless the user advances to configurability/tests; avoid expanding scope beyond the session’s stated requirements.
