---
name: conditional_cache_bypass_plan
description: Multi-session plan for implementing X-Cache-Bypass support in MercuryMonolith response caching.
type: project
recallCount: 0
---

Conditional cache bypass work is split across sessions. Session 1 identified the global HTTP response cache middleware as the primary implementation target; future sessions should add `X-Cache-Bypass: true` detection before cache lookup, route bypassed requests directly to backend/downstream logic, and emit a `CACHE_BYPASS` log including the request ID.

**Why:** The requested feature must preserve normal cache behavior while allowing traceable per-request cache bypass.

**How to apply:** In Session 2, implement the middleware/request-handling change first, then in Session 3 update `tests/test_main.txt` to cover bypass, normal caching regression, and bypass logging.
