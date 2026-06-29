---
name: task_dependency_feature
description: Ongoing multi-session ChronoFlow task dependency feature scope and session boundary
type: project
recallCount: 0
---

ChronoFlow Task Dependency is a multi-session feature. Session 1 prepared the data/repository foundation. Session 2 added CQS-level dependency command/query DTOs, dependency create/delete/query handlers, cycle rejection for create dependency, task status update logic that rejects completion while blockers remain incomplete, and focused unit coverage for the completion gate.

**Why:** The user split the feature into sessions. Session 2 was explicitly scoped to business logic and CQS integration, not API endpoint delivery.

**How to apply:** In the next session, continue from the repository and CQS/business-logic foundation. Remaining likely work is transport/API exposure and broader integration verification if requested; do not assume extra business rules beyond the dependency completion gate unless the session asks for them.
