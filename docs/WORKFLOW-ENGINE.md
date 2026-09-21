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
13. Mutation attempt state is durable but minimal. TaskState owns lifecycle; `attemptPhase` distinguishes only `implementation`, `technical_repair`, and `design_refinement`, while `designRefinementAttempt` owns the dedicated visual-refinement budget.
14. Tool permissions derive from durable TaskState + attempt phase. Missing attempt phase on a legacy IMPLEMENTING task fails closed to the bounded repair toolset.
15. Application services produce evidence/classifications; `WorkflowEngine` outcome APIs decide retry, block, quality review, fresh review, replan, and delivery readiness.
16. Restart recovery reads SQLite. Generated build documents may be recreated from it.
17. Canonical UI activity is projected from raw task telemetry into stable workflow event categories/kinds; raw event provenance remains available for diagnostics.
18. Internal slices reuse the primary chat session; they are workflow steps, not child conversations.

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

Entering `VERIFYING` or starting a technical/design repair resets the gate to pending. The verifier records evidence through `WorkflowEngine.recordVerification()`. Core then evaluates that persisted gate through `applyVerificationOutcome()`: failure can repair/block, while success yields the explicit `quality_review` action. Product/visual quality is submitted through `applyQualityOutcome()`; only a pass enters REVIEWING and yields `review`. Fresh review is submitted through `applyReviewOutcome()`; only a pass reaches DELIVERY_READY/`checkpoint`. This prevents an agent response, raw event, server conditional, or UI action from bypassing any quality gate.

## Canonical events

Raw `TaskEvent` records remain append-only evidence. `packages/core/src/workflow-events.ts` projects them into the stable `WorkflowEvent` contract used by the status/activity UI. Consumers should depend on canonical event category/kind/status and retain `sourceType` only for diagnostics.

## Restart recovery

Interrupted mutation-capable tasks are converted through `WorkflowEngine.markRecoveryRequired()`. The workflow records the interrupted task state, recovery category, recovery checkpoint, reason, and explicit safe resume action. Checkpoints snapshot workflow version, verification, recovery, `attemptPhase`, and `designRefinementAttempt`. Continuation back to IMPLEMENTING restores that durable mutation phase; if a legacy checkpoint lacks one, Core defaults to bounded technical repair rather than broad implementation authority.


## Outcome authority

The server does not answer “what happens next?” after execution evidence. It submits results to Core:

- `completeImplementation()` moves approved mutation into VERIFYING.
- `applyRecoveryDecision()` consumes RecoveryService classification and durably chooses retry or block.
- `applyVerificationOutcome()` consumes the persisted verification gate and chooses quality review, technical repair, or block.
- `applyQualityOutcome()` chooses fresh review, technical repair, design refinement, plan repair, or block.
- `applyReviewOutcome()` chooses delivery readiness, technical repair, or block.

Low-level retry and design-refinement mutations are private WorkflowEngine implementation details. SQLite remains the only source that a restart needs to determine the active lifecycle and mutation phase.
