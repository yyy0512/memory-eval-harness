---
name: order_service_incremental_delivery
description: Context for the three-session incremental implementation of MerchantMatrix order_service
type: project
recallCount: 0
---

The `order_service` is being implemented incrementally over three sessions. Session 1 created a compilable service skeleton: `src/main.c`, `include/mm_logger.h`, `tests/.gitkeep`, and `CMakeLists.txt`, wired to shared `mm_logger.c` and a simple signal-aware server loop that logs start/stop.

Session 2 added core domain code only: `include/model.h`, `src/model.c`, `include/handlers.h`, `src/handlers.c`, and `tests/test_order_model.c`. The model layer defines `Order` and `OrderItem`, safe create/free functions, max 16 items, UUID-length order IDs, three-letter currencies, computed `total_cents`, and pending initial status. The handler layer has `handle_create_order`, validates at least one item, rejects duplicate IDs, and persists orders in a simple process-global non-thread-safe singly linked list with test helpers to find/count/clear.

**Why:** The user explicitly requested a staged build-up over three sessions. Session 2 scope was data modeling, initial business logic, in-memory persistence, and unit tests; no HTTP/API or advanced lifecycle work has been requested yet.

**How to apply:** In Session 3, build on these files rather than replacing them with the full old `STUB.md` implementation. The environment still lacks `cmake`, so verification used direct `cc` commands; `cmocka` was also unavailable, so Session 2 tests use plain C `assert` and are wired into CTest as a standalone executable.
