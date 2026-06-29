---
name: task_dependency_feature
description: Ongoing multi-session ChronoFlow task dependency feature scope and session boundary
type: project
recallCount: 0
---

ChronoFlow Task Dependency is a multi-session feature. Session 1 was scoped to the data and repository layer only: define dependency relationships, add persistence, and expose repository functions for creating dependencies, listing blockers for a task, and deleting dependencies.

**Why:** The user explicitly split the feature across sessions and said not to implement business logic or API endpoints yet.

**How to apply:** In future sessions, preserve the session boundary: continue from the data/repository foundation and avoid assuming business logic or API endpoints should exist unless the current session asks for them.
