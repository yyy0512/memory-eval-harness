---
name: cache_bypass_implementation_plan
description: Session 1 analysis and plan for X-Cache-Bypass feature in MercuryMonolith cache middleware and tests
type: project
recallCount: 0
---

Conditional cache bypass should be implemented in `src/module_11.txt` (`mm_resp_cache_middleware`) and verified in `tests/test_main.txt`.

**Why:** Session 1 analysis found `src/module_11.txt` is the API-gateway response-cache middleware that receives `mm_http_request_t`, checks cache eligibility, builds the key, performs lookup, calls downstream, and backfills cache. `tests/test_main.txt` is the requested test suite and already has cache-hit/miss regression coverage with fake repository/cache counters.

**How to apply:** In Session 2, add a case-insensitive check for `X-Cache-Bypass: true` before cache key lookup. Use existing header access patterns (`req->headers.*` and/or `mm_http_header_get`) and preserve existing population behavior unless the requirement is interpreted to skip lookup only. Emit an existing logger call such as `MM_LOG_INFO` or `MM_LOG_DEBUG` containing `CACHE_BYPASS` and the request ID from `X-Request-Id`/request correlation field. In Session 3, extend `tests/test_main.txt` with header/request-context fakes as needed to assert bypass avoids cache hits, non-bypass still caches, and bypass logging includes `CACHE_BYPASS` plus request ID.
