# BORG Website Builder Workflow

Last updated: 2026-09-18

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

### Design direction

Before frontend mutation, BORG establishes a concrete design direction covering:

- composition;
- typography hierarchy;
- color direction;
- visual rhythm;
- responsive behavior;
- motion;
- content voice;
- explicit anti-patterns.

The objective is not to produce a generic design-system paragraph. It is to create an art-direction contract that can guide implementation and later design review.

### Project plan

BORG creates a tailored frontend plan rather than a fixed slice list.

The plan includes:

- site goal;
- audience;
- visual direction;
- pages;
- features;
- ordered frontend slices;
- outcome for each slice;
- scope for each slice;
- acceptance criteria;
- frontend completion gate;
- whether a backend phase will eventually be required.

A simple site may use only a few slices. A marketplace may use many.

### Approval

The user approves the project direction before mutation when the active permission model requires it.

Approval applies to the plan and scope, not every individual tool call inside an approved slice.

### Slice execution

Each slice gets its own mini-loop.

#### Context

Compile the current slice context from durable project state.

#### Implement

Change only what is necessary to achieve the slice outcome while preserving established project contracts.

#### Preview

Refresh or restart the live preview only when needed. Preview should not constantly reload when no relevant change occurred.

#### Verify

Collect deterministic and browser evidence appropriate to the slice.

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

Low-level engineering details remain available when useful but should not dominate the primary experience.

## Completion definition

BORG should never claim completion only because files changed or a model produced an implementation report.

Completion is a persisted workflow state backed by evidence.
