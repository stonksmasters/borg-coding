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
6. Verification is a durable Core gate, not an event interpretation. `REVIEWING`, `DELIVERY_READY`, and delivery require a persisted passed verification result for the current repair attempt.
7. Verification/review may make a slice checkpoint-ready, but they do not advance the project. Only successful delivery/checkpoint completion may yield `advance_slice` or `request_feedback`.
8. Core selects the slice index for `initial`, `advance`, and `revise`; server, gateway, UI, and build docs never increment or choose it independently.
9. Project-plan revisions are numbered by Core. An approved project plan is frozen against silent replanning.
10. The outer project loop and inner slice mini-loop are explicit workflow domains. A slice mini-loop cannot restart project planning.
11. Recovery is bounded and classified by `RecoveryService`; unknown and exhausted failures stop.
12. Recovery state is durable: category, previous task state, checkpoint ID, safe resume action, and reason are stored with the workflow.
13. Restart recovery reads SQLite. Generated build documents may be recreated from it.
14. Canonical UI activity is projected from raw task telemetry into stable workflow event categories/kinds; raw event provenance remains available for diagnostics.
15. Internal slices reuse the primary chat session; they are workflow steps, not child conversations.

## Migration

The migration is compatible with existing task/event consumers:

1. Add and populate `project_workflows` lazily when a task starts.
2. Route all task transitions through `WorkflowEngine`.
3. Publish normalized workflow state alongside legacy activity fields.
4. Carry workspace contract/preflight forward and delegate classification to Core `RecoveryService`.
5. Reuse the primary session for slices; gateway automation follows Core `nextAction`.
6. Legacy `.localcode/build` reads are permitted only when no SQLite workflow row exists. Once durable state exists, file projections cannot influence progression.
7. Focused Page, Component, and Styles tasks may own independent task lifecycles, but they bind explicitly to the root project's workflow for approved project-plan context.

## Recovery boundary

Workspace preflight runs before execution and every retry. It repairs only contract directories, verifies the approved Git head, and records evidence. Recoverable failures retry the same approved slice with compact context. Approval violations, path escapes, invalid repositories, permission failures, unknown failures, and exhausted retries block rather than mutate further.


## Verification gate

`WorkflowState.verification` records the current verification status, repair attempt, profile, summary, browser/specialist verdicts, evidence hash, and completion time.

Entering `VERIFYING` or starting a repair resets the gate to pending. The verifier records the result through `WorkflowEngine.recordVerification()`. A failed gate schedules repair; a successful gate is required before review, delivery readiness, or delivery may proceed. This prevents an agent response, raw event, or UI action from bypassing quality verification.

## Canonical events

Raw `TaskEvent` records remain append-only evidence. `packages/core/src/workflow-events.ts` projects them into the stable `WorkflowEvent` contract used by the status/activity UI. Consumers should depend on canonical event category/kind/status and retain `sourceType` only for diagnostics.

## Restart recovery

Interrupted mutation-capable tasks are converted through `WorkflowEngine.markRecoveryRequired()`. The workflow records the interrupted task state, recovery category, recovery checkpoint, reason, and explicit safe resume action. Checkpoints snapshot workflow version, verification, and recovery state so continuation can restore evidence rather than infer it.
