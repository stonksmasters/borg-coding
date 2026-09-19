# Workflow ownership

`WorkflowEngine` is the sole authority for project progression. It owns the durable answer to: **what happens next?**

## Sources of truth

- SQLite `project_workflows` is authoritative for project phase, active task, slice, repair state, and next action.
- Task, approval, checkpoint, continuation, review, and event tables remain authoritative for their own records.
- `.localcode/build/workflow-state.json` is a generated, replaceable projection written only after mutation authority exists. It is context for agents and people, never an input used to decide progression.
- The desktop gateway transports commands and events, persists chat presentation state, and follows `nextAction`; it does not invent workflow state.
- The UI consumes `/api/tasks/:taskId/workflow-status`, whose `source` is `sqlite` when authoritative state exists.

## Invariants

1. One project has one persisted workflow row and one active owning task.
2. A stale task cannot advance another task's workflow.
3. Task state, its transition event, and workflow projection commit in one SQLite transaction.
4. PLAN remains read-only and stops at `AWAITING_APPROVAL`.
5. Approved mutation occurs only in the recorded worktree.
6. Verification and review precede delivery readiness.
7. A verified non-final slice yields `advance_slice`; a final slice yields `request_feedback`.
8. Recovery is bounded and classified by `RecoveryService`; unknown and exhausted failures stop.
9. Restart recovery reads SQLite. Generated build documents may be recreated from it.
10. Internal slices reuse the primary chat session; they are workflow steps, not child conversations.

## Migration

The migration is compatible with existing task/event consumers:

1. Add and populate `project_workflows` lazily when a task starts.
2. Route all task transitions through `WorkflowEngine`.
3. Publish normalized workflow state alongside legacy activity fields.
4. Carry workspace contract/preflight forward and delegate classification to Core `RecoveryService`.
5. Reuse the primary session for slices; gateway automation follows Core `nextAction`.
6. Retire legacy `.localcode/build` reads from progression decisions after existing projects acquire SQLite state.

## Recovery boundary

Workspace preflight runs before execution and every retry. It repairs only contract directories, verifies the approved Git head, and records evidence. Recoverable failures retry the same approved slice with compact context. Approval violations, path escapes, invalid repositories, permission failures, unknown failures, and exhausted retries block rather than mutate further.
