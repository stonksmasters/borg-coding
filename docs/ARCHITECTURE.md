# BORG Code Architecture

Last updated: 2026-09-20

## Overview

BORG has two architectural layers that should not be confused.

The lower layer is the durable coding-agent runtime: tasks, sessions, permission modes, worktrees, specialist routing, implementation, verification, review, repair, checkpoints, and local-model execution.

The upper layer is the website-builder product: project planning, frontend phases, implementation slices, design direction, live preview, browser verification, phase completion, page/component organization, and eventually backend continuation.

The website-builder layer orchestrates the runtime. The runtime should not force the user to think in its internal primitives.

## Product execution hierarchy

The canonical hierarchy is:

    Website Project
      -> Phase
        -> Slice
          -> Mini-loop
            -> Context
            -> Implement
            -> Preview
            -> Verify
            -> Repair if needed
            -> Document
            -> Handoff

### Project

The project is the durable product-level container. It owns the original brief, approved goals, audience, design direction, page inventory, feature inventory, project decisions, and current workflow state.

### Phase

A phase is a major product boundary.

The default website workflow begins with Frontend.

A Backend phase is created only when the approved brief requires server features, persistence, accounts, payments, integrations, private data, or other backend behavior. Frontend completion should not be blocked by speculative backend work.

### Slice

A slice is a concrete user-visible outcome small enough to implement and verify independently.

Examples:

- global application shell and navigation;
- product discovery feed;
- product detail experience;
- cart interactions;
- checkout frontend;
- responsive polish and accessibility repair.

A slice is not merely a list of files. It has scope, acceptance criteria, status, evidence, and a handoff.

### Mini-loop

The slice mini-loop is the unit of autonomous execution.

A normal implementation pass should operate inside the current slice. It should not re-run full repository discovery, regenerate the project plan, or reconsider unrelated phases unless evidence shows the existing project state is invalid.

## Runtime roles

The existing engineering runtime remains useful beneath the website workflow.

The runtime can route work through roles such as:

- Architect;
- Implementer;
- Verifier;
- Reviewer.

It may also route by engineering discipline such as frontend, backend, database, security, QA, DevOps, and infrastructure.

These roles are execution mechanics, not the primary product navigation.

For example, a frontend slice may internally use an Implementer, Verifier, and Reviewer while the user still sees a single website-builder state: "Building Product Discovery - verifying responsive behavior."

## Canonical state ownership

A single persistent `WorkflowEngine` owns project progression. SQLite is the durable source of truth. The desktop gateway transports commands and streams events; it does not invent progression. `.localcode/build/` is a generated knowledge projection for compact model context and human inspection, not an independent workflow authority.

Normal website builds reuse the project's primary chat/session. Slice boundaries are durable workflow/task boundaries, not hidden child-chat ownership boundaries.

The workflow records an explicit loop ownership domain: `project`, `slice`, `backend`, or `general`. The outer project loop owns plan creation and revision. The inner slice loop owns only the Core-selected slice and cannot increment the sitemap/slice roadmap, replace the project plan, or begin backend work. Verification makes work eligible for checkpointing; successful delivery/checkpoint completion is the only operation that advances to the next slice or completes the frontend phase.

The UI should render the persisted project/task state rather than infer progress from assistant prose. The server exposes a normalized `RunView` containing phase, slice, stage, current action, verification state, blocker, and next action. Model output can explain work, but it must not be the source of truth for whether a plan is approved, a slice is complete, verification passed, or a phase has advanced.

Durable state includes:

- project identity and original brief;
- approved project plan;
- current phase;
- current slice;
- slice status;
- role assignments and handoffs;
- task events;
- verification reports;
- design-review results;
- approvals;
- checkpoints and continuations.

## Generated project documentation

Each website project may maintain runtime-generated documentation under .localcode/build/.

That project documentation is different from BORG's own repository documentation.

BORG repository docs describe how BORG works.

.localcode/build/ describes the website currently being built: plan, decisions, data contracts, slice state, and handoffs.

The generated project docs exist so important decisions do not need to remain in model memory. They are regenerated from authoritative state after workflow mutations and should never be used to override newer SQLite workflow state.

## Preview and verification

The live preview is part of the execution architecture, not a cosmetic extra.

User-facing slices should be exercised in a real browser whenever possible. Verification may include:

- page loading;
- DOM and interaction checks;
- console errors;
- network failures;
- responsive behavior;
- accessibility;
- visual-regression evidence;
- design-quality review;
- screenshots.

A model claim that something works is not verification evidence. Fresh review must account for the active slice outcome and acceptance criteria, and a required criterion without evidence is treated as not proven.

Visual regression has two different failure classes: a true regression/dimension/comparison failure blocks verification, while a first verified screenshot without a baseline becomes a separate operator-acceptance gate. BORG never writes or updates a visual baseline automatically.

## Recovery

Long-running autonomous work must tolerate interruption.

A recoverable task should be able to reconstruct:

- the project;
- the approved plan;
- the current phase and slice;
- the latest checkpoint;
- the last verified state;
- unresolved findings;
- the next required action.

Recovery should continue the current workflow rather than inventing a new project plan.

## First-class project entities

Pages, components, the global style system, slices, requirements, and decisions are canonical project-domain entities rather than being inferred only from files.

A page entity will represent a navigable product surface.

A component entity will represent a reusable UI capability.

Each entity can have:

- identity;
- source files;
- dependencies;
- design contract;
- usage locations;
- verification state;
- edit history;
- scoped workspace context.

See PAGES-AND-COMPONENTS.md.

## Architectural rule

When choosing between more agent complexity and clearer durable state, prefer clearer durable state.

BORG should make the model solve the current problem, while the system owns continuity, boundaries, evidence, and workflow.
