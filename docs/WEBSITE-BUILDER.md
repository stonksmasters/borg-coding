# BORG Website Builder Workflow

Last updated: 2026-09-19

## Goal

The website-builder workflow turns one high-level website brief into a complete frontend and, when required, a separate backend phase.

The workflow should be autonomous inside approved boundaries, persistent across sessions, and visible to the user at every meaningful step.

## Phase 1: Frontend

Every new website starts with Frontend.

### Intake

BORG records:

- original brief;
- project name and location;
- audience;
- requested pages and features;
- explicit constraints;
- known integrations;
- whether the repository is greenfield or existing.

### Project Bootstrap

Before frontend mutation, BORG establishes only the durable authority needed to begin a page at a time:

1. **Rough product map** — site goal, audience, likely routes in build order, lightweight purposes/section hints, important user journeys, explicit capabilities, and backend requirement. Future pages do not receive detailed acceptance criteria or component inventories yet.
2. **Design direction and global styles** — the Design Director and style stage establish audience-specific art direction plus concrete site-wide tokens, typography, layout, responsive, motion, accessibility, and anti-pattern rules.
3. **Page queue** — bounded implementation slices identify the next page or coherent page group. The first slice is the homepage or primary entry route. The outer plan's component inventory remains empty or limited to already-verified registry reuse.

The durable project plan is a compass, not a full website specification. Detailed sections, interactions, responsive behavior, acceptance criteria, and components are resolved inside the active page slice.

### Progressive Page Slice

Each page advances through the same inner loop:

1. Plan the current page from the rough sitemap, approved global styles, existing component registry, and relevant source context.
2. Resolve which verified components to reuse and which new components this page actually justifies.
3. Implement the page in the isolated worktree.
4. Run deterministic, browser, accessibility, and visual verification.
5. Repair or refine only the current page when evidence requires it.
6. Checkpoint the page and update the global component/page registry from verified source evidence.
7. Advance to the next page queue item.

Components therefore emerge from rendered, verified work. A later page can explicitly reuse components already present in the registry and add only the new components its own composition requires.

`WorkflowEngine.setProjectPlan()` is called only with the final validated blueprint candidate. SQLite remains authoritative; generated `.localcode/build` files are inspectable projections.

The blueprint includes site goal/audience, sitemap/routes, ordered page sections, user journeys, product capabilities, global design system, component inventory, ordered frontend slices, acceptance criteria, completion gates, and backend-required classification.

A simple site may use only a few slices. A marketplace or application may use many.

### Approval

The user approves the project direction before mutation when the active permission model requires it.

Approval applies to the plan and scope, not every individual tool call inside an approved slice.

### Slice execution

Each slice gets its own mini-loop inside the same primary website session. `WorkflowEngine` persists the command that starts or advances the slice, so the UI and gateway do not need a second manual "start next slice" path.

#### Context

Compile the current slice context from durable project state.

#### Implement

Change only what is necessary to achieve the slice outcome while preserving established project contracts.

#### Preview

Refresh or restart the live preview only when needed. Preview should not constantly reload when no relevant change occurred.

#### Verify

Collect deterministic and browser evidence appropriate to the slice. The independent fresh reviewer must explicitly account for the slice outcome and every supplied acceptance criterion; missing proof is not a pass.

Visual regression failures repair the implementation. A first verified screenshot with no baseline instead becomes an explicit operator-acceptance gate in Evidence; baseline bytes are never accepted automatically.

#### Repair

When verification or independent review finds a real failure, repair the bounded findings and re-run relevant evidence.

Repair should not trigger project-wide replanning.

#### Document

Update decisions, state, contracts, and verification summaries.

#### Handoff

Persist what was completed, what evidence passed, remaining risks, and the required next action.

Then advance to the next slice.

## Frontend completion gate

Frontend is complete only when the approved frontend contract is satisfied.

Typical requirements include:

- every approved page is navigable;
- required interactions function;
- no serious console or network failures remain;
- responsive behavior is acceptable across required viewports;
- accessibility gates pass;
- visual and design review has no blocking findings;
- no placeholder pages or fake controls remain;
- the live preview represents the finished frontend.

The user should then be able to review the complete frontend as a product rather than as disconnected slice outputs.

## Phase 2: Backend

Backend is separate from frontend.

BORG should offer or begin backend work only when the approved product requires it.

Backend work consumes the finished frontend contract, including:

- page and interaction behavior;
- data requirements;
- interfaces and contracts;
- authentication needs;
- persistence needs;
- integration requirements;
- frontend decisions that must not be broken.

Examples include:

- accounts;
- stored user data;
- checkout and payment processing;
- order persistence;
- seller or admin systems;
- search services;
- external APIs;
- server-side authorization;
- transactional workflows.

A static site should not be forced through backend architecture it does not need.

## Existing repositories

For an existing project, BORG should preserve established architecture and design conventions unless the user requests a redesign or architectural change.

Repository inspection should identify enough structure to form the requested plan, but ongoing slice execution should use scoped inspection rather than rereading everything.

## Failure handling

When a slice stalls:

1. identify the failing acceptance criterion;
2. use the latest relevant evidence;
3. repair within the current scope;
4. escalate only when the failure proves the approved plan or architecture is invalid.

A task that times out or restarts should resume from persisted workflow state.

## User experience

The workspace should expose the website-builder model directly.

The user should see:

- project;
- phase;
- current slice;
- plan;
- preview;
- current execution activity;
- verification;
- changes;
- relevant failures;
- completion state.

Low-level engineering details remain available when useful but do not dominate the primary experience. The normal workspace surfaces are Preview, Plan, Changes, and Evidence. Project memory, process logs, raw model-context manifests, review history, and checkpoints are advanced diagnostics.

## Completion definition

BORG should never claim completion only because files changed or a model produced an implementation report.

Completion is a persisted workflow state backed by evidence.
