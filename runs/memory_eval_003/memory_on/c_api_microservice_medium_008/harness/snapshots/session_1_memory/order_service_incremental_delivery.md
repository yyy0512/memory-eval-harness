---
name: order_service_incremental_delivery
description: Context for the three-session incremental implementation of MerchantMatrix order_service
type: project
recallCount: 0
---

The `order_service` is being implemented incrementally over three sessions. Session 1 created only a compilable service skeleton: `src/main.c`, `include/mm_logger.h`, `tests/.gitkeep`, and `CMakeLists.txt`, wired to shared `mm_logger.c` and a simple signal-aware server loop that logs start/stop. No order-specific logic has been implemented yet.

**Why:** The user explicitly requested a staged build-up and asked Session 1 to stop at service scaffolding/setup.

**How to apply:** In later sessions, build on this scaffold without replacing it with the old `STUB.md` domain implementation; add order logic only when that session's requirements ask for it. Note that `cmake` was unavailable in the environment during Session 1, so compilation was verified with `cc` instead.
