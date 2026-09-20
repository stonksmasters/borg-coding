# Server orchestration boundary refactor

## Goal

Reduce `apps/server/src/index.ts` from an inline application engine into a composition/transport layer while preserving the durable workflow architecture:

- `WorkflowEngine` is the sole authority for project progression and the durable answer to **what happens next?**
- SQLite workflow/task/approval/checkpoint/review records remain authoritative.
- Application services perform bounded work and return evidence/results; they do not invent workflow progression.
- `.localcode/build` remains a replaceable projection.
- Gateway/UI remain consumers and command transports, not workflow authorities.
- Existing worktree, approval, verification, recovery, and slice boundaries must remain behaviorally compatible throughout the refactor.

This refactor is intentionally split into five mergeable slices. Each slice must pass typecheck, lint, tests, build, and desktop lifecycle before the next slice changes behavior or ownership.

## Slice 1 — Characterize behavior and extract task scope resolution

**Status:** in progress

### Purpose

Create a stable seam around the repeated scope-classification logic currently embedded in `/api/chat` and `/api/tasks/:id/execute`.

### Work

- Add characterization tests for:
  - initial project planning,
  - approved frontend slice start/advance/revise,
  - focused page/component workspaces,
  - global styles workspace,
  - backend planning,
  - ASK/general work,
  - blocked-task retry rejection from chat,
  - missing focused-scope IDs,
  - missing Core slice commands,
  - execution scope restored from persisted task events.
- Extract a pure `TaskScopeResolver`.
- Route existing planning/execution scope decisions through the resolver.
- Keep all current Core calls, workflow transitions, event names, approval behavior, worktree behavior, prompts, and retry limits unchanged.
- Document the remaining four slices and invariants in this file.

### Acceptance criteria

- No new workflow state or transition is introduced.
- Resolver output is derived only from already-authoritative inputs; it does not read or mutate SQLite/files itself.
- Slice indexes still come exclusively from `WorkflowEngine`.
- Existing endpoints emit the same externally meaningful events and approvals.
- Characterization tests fail if focused work can start without an approved plan or if a slice can start without the required Core command.
- `index.ts` begins shrinking without moving workflow authority out of Core.

## Slice 2 — Extract PlanningOrchestrator

### Purpose

Move the planning use case out of the HTTP handler while preserving its exact external behavior.

### Target flow

```
HTTP/SSE
  -> PlanningOrchestrator
      -> TaskScopeResolver
      -> WorkflowEngine.start/startFrontendSlice
      -> bounded context compilation
      -> optional Design Director
      -> Architect
      -> architect-output validation
      -> project-plan semantic validation/retry when applicable
      -> WorkflowEngine.setProjectPlan
      -> projection writers
      -> WorkflowEngine.requestApproval
  -> events/result to transport
```

### Work

- Introduce a typed planning command/result contract.
- Move repository-context assembly, context-pack compilation, design-direction invocation, Architect invocation, semantic plan retry, handoff creation, and approval preparation behind the orchestrator.
- Inject services/repositories instead of importing global server singletons inside the orchestrator.
- Keep HTTP parsing, NDJSON headers, abort wiring, and response serialization in the transport layer.
- Preserve every canonical workflow transition/event and approval contract.

### Acceptance criteria

- `POST /api/chat` is primarily request parsing + event sink + one orchestration call.
- PlanningOrchestrator cannot increment slices or mutate workflow outside `WorkflowEngine`.
- PLAN remains read-only and ends at approval.
- Mini-loops continue using bounded context without repository rediscovery.
- Characterization tests from Slice 1 remain unchanged and green.

## Slice 3 — Extract ExecutionOrchestrator and VerificationService

### Purpose

Remove the giant implementation/verification loop from the HTTP route without creating a second state machine.

### Target flow

```
approved execute command
  -> ExecutionOrchestrator
      -> workspace preflight
      -> bounded execution context
      -> Implementer
      -> VerificationService
          -> deterministic profile
          -> focused-route/browser evidence
          -> specialist evidence
          -> visual regression
      -> submit evidence/result to Core
      -> follow Core-owned action
```

### Work

- Introduce typed execution context/outcome contracts.
- Extract implementer invocation, bounded continuation/no-progress checks, preflight, and repair grounding.
- Extract deterministic/browser/specialist verification into `VerificationService`.
- Keep ToolBroker permissions and existing worktree authority unchanged.
- Preserve verification evidence hashing and `WorkflowEngine.recordVerification()`.
- Avoid giving ExecutionOrchestrator authority to choose the next slice/project phase.

### Acceptance criteria

- `POST /api/tasks/:id/execute` no longer contains the implementation/verification loop.
- Verification result is normalized in one contract.
- Failed verification cannot reach review or delivery.
- Repair remains bounded to the approved worktree and evidenced failure.
- Existing technical/browser verification tests remain green.

## Slice 4 — Extract QualityGateService and ProjectPlanRevisionService

### Purpose

Separate visual/product/code quality evaluation and plan repair from execution transport.

### Target quality decision

```ts
type QualityDecision =
  | { action: "pass" }
  | { action: "repair_current_slice"; evidence: unknown }
  | { action: "revise_project_plan"; scope: "cross_slice" | "project_plan"; evidence: unknown }
  | { action: "block"; reason: string };
```

### Work

- Normalize local vision, Visual Director, fresh-context review, and review-history blocking into a bounded quality service.
- Move the recently added project-plan revision generation into `ProjectPlanRevisionService`:
  - bounded revision prompt,
  - Architect call,
  - semantic retry,
  - coverage validation,
  - plan delta,
  - build-doc projection.
- The revision service returns a proposed revision; only `WorkflowEngine` may number/store/approve/resume it.
- Keep `current_slice` repairs local; route `cross_slice`/`project_plan` evidence through Core recovery/replanning.

### Acceptance criteria

- Visual/review code in `index.ts` is reduced to service calls/result transport.
- ProjectPlanRevisionService cannot transition WorkflowState.
- Existing plan revision preserves the active worktree/slice.
- Quality failures cannot silently broaden scope.
- Current PR #44 regressions remain green.

## Slice 5 — Tighten Core outcome authority and durable attempt phase

### Purpose

Finish the ownership move so application services report outcomes and Core consistently determines the legal next action.

### Work

- Review the ephemeral `ExecutionState` machine (`IMPLEMENT/VERIFY/REPAIR/BROWSER_VERIFY/REVIEW/...`).
- Persist only the attempt phase needed for restart/tool-permission correctness; do not duplicate TaskState unnecessarily.
- Add outcome-oriented Core APIs where server code still manually chooses transitions, for example:
  - verification outcome -> repair/review/block,
  - quality outcome -> repair/replan/block/pass,
  - review outcome -> repair/delivery-ready/block.
- Make ToolBroker permission policy depend on authoritative/durable attempt state when mutation safety requires it.
- Remove remaining server-side progression conditionals that answer “what happens next?”
- Update workflow architecture documentation and restart-recovery tests.

### Acceptance criteria

- A crash/restart can recover the active mutation/repair phase from SQLite without inferring progression from raw events or build docs.
- Server/application services submit evidence and execute Core commands; they do not independently choose project progression.
- `WorkflowEngine` remains the single progression authority in code as well as documentation.
- `index.ts` is predominantly composition, transport, routing, and thin adapter code.

## Refactor invariants

Every slice must preserve these invariants:

1. SQLite is authoritative for workflow progression.
2. `WorkflowEngine` owns legal transitions, plan revision numbers, slice indexes, and next actions.
3. No build document can advance workflow.
4. No UI/gateway/server helper may independently increment a slice.
5. PLAN performs no source mutation.
6. Mutation requires an approved worktree/base commit.
7. Verification is a durable gate before review/delivery.
8. Recovery remains classified and bounded.
9. Plan repair preserves completed work and the existing worktree unless Core explicitly requires otherwise.
10. Inner slice/focus/style loops cannot silently restart outer project planning.
11. Each extraction is behavior-preserving until a later slice explicitly moves policy into Core.
12. Characterization tests are retained across all five slices as regression gates.
