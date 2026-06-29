Session 2 completed: integrated HTTP rate limiting for UtiliREST EchoHub.

Changes made:
- `UtiliREST_EchoHub/src/http_handler.c` now includes `config.h` and `rate_limiter.h`, derives a client key from `X-Real-IP` then `X-Forwarded-For` (fallback `unknown`), checks `is_rate_limited()` at the start of `http_handle_request()`, and immediately returns HTTP 429 JSON error for blocked clients.
- `http_handle_request()` adds `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers for every handled request before route dispatch or 429 response.
- `UtiliREST_EchoHub/include/rate_limiter.h` and `src/rate_limiter.c` now expose `rate_limiter_get_remaining()` and `rate_limiter_get_reset_epoch()` so HTTP responses can report quota state without duplicating limiter internals.
- `UtiliREST_EchoHub/docs/api/v1.openapi.yaml` documents reusable rate-limit headers and `TooManyRequests` response, and adds 429 responses to Echoes endpoints.

Verification:
- `make -C UtiliREST_EchoHub test` passed. The environment printed `pkg-config: not found`, but rate limiter unit tests built and ran successfully.
- `make -C UtiliREST_EchoHub all` did not complete because the environment lacks `pkg-config` and `cJSON.h`; failure occurred before validating `http_handler.c` changes against full app dependencies.
- `git diff --check` passed.

Remaining work for session 3:
- Add/extend integration tests for HTTP 429 and `X-RateLimit-*` headers once the HTTP adapter test harness or dependencies are available.
- Confirm whether `urest_http` has a canonical remote-address accessor; current implementation uses request headers because no local declaration for a direct client-IP API was present in this repo snapshot.
