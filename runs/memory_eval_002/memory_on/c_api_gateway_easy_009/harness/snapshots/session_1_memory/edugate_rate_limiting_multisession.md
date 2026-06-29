---
name: edugate_rate_limiting_multisession
description: EduGate ScholarLink rate-limiting work is being delivered over multiple sessions; session 1 added a hardcoded in-memory IP limiter.
type: project
recallCount: 0
---

EduGate ScholarLink API gateway rate-limiting is a multi-session feature. Session 1 added a hardcoded global in-memory IP limiter: more than 100 requests per client IP in a 60-second window returns HTTP 429.

**Why:** The user is incrementally adding protection against excessive API requests; configurability and automated tests are explicitly deferred to the next session.

**How to apply:** In future sessions, build on the existing basic limiter rather than replacing it unnecessarily; expect upcoming work to make it configurable and add automated tests. The limiter is wired into the active standalone libmicrohttpd request path and counts each logical request once, including streaming requests. Local verification compiled the limiter module, but compiling the full gateway was blocked because this environment lacks the libmicrohttpd development header.
