---
name: distributed_tracing_incremental_work
description: Distributed tracing is being implemented incrementally; session 1 prepares data transport only.
type: project
recallCount: 0
---

Distributed tracing is being implemented across multiple sessions. Session 1 scope is foundational data structures only: define trace context and carry it through IPC serialization/deserialization, without activating tracing logic.

**Why:** The overall feature is complex and intentionally staged so the transport layer is prepared before gateway/service tracing behavior is added.
**How to apply:** In future tracing sessions, build on the existing `sc_trace_context_t` and IPC envelope transport rather than adding active tracing behavior retroactively to session 1 scope.
