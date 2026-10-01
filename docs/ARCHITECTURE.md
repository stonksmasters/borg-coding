# BORG Code Architecture

Last updated: 2026-09-29

## Overview

BORG has three architectural layers that should not be confused.

The lower layer is the durable agent and capability runtime: conversations, tasks, permission modes, typed capabilities, provider adapters, scoped targets, jobs, events, artifacts, evidence, verification, review, checkpoints, persistence, and local-model execution.

The middle layer contains focused workflow domains such as Development, Security and Recon, Files and Knowledge, Infrastructure, Computer Control, Data, and Automation. Each domain adds typed concepts and user interfaces while reusing the lower runtime.

The upper layer is General Chat: the primary command surface that interprets a user's intent, selects registered capabilities, presents progress and approvals, and links to focused workspaces when richer inspection is useful.

The website builder is the most mature Development workflow. Its project, phase, slice, Context Compiler, RunView, browser evidence, and repair systems remain core architectural assets, but they no longer define the entire product boundary.

## Platform execution model

The canonical cross-domain path is:

```text
Conversation or focused workspace
  -> typed capability request
  -> permission and scope policy
  -> durable job and step
  -> provider and execution node
  -> explicit tool operation
  -> artifacts and normalized evidence
  -> verification and review
  -> durable result and user explanation
```

The model may select a capability and supply schema-constrained arguments. BORG code owns provider selection, invocation construction, side effects, bounds, parsing, persistence, and verification.

Chat, focused workspaces, and automation must converge on this same path. They must not create parallel execution or approval systems.

## Shared runtime boundaries

### Model providers

Model providers handle inference and streaming model output. They do not perform hidden filesystem, shell, Git, network, browser, or verification side effects.

### Capability registry

The registry declares a capability's typed input and output, purpose, risk, required permissions, scope behavior, compatible providers, evidence types, and verification expectations. Discovery makes a capability visible; it does not authorize execution.

### Execution providers and nodes

Providers translate a typed job into operations on a particular environment. Initial examples include the local workspace, browser, Git, generic SSH, and Kali. Nodes describe concrete machines or services. A Kali Raspberry Pi is a node used by a provider, not an independent agent or workflow owner.

### Policy and scope

ASK / PLAN / EDIT / AGENT semantics remain consistent across domains. Each capability also enforces relevant boundaries such as a selected repository root, approved security targets, trusted execution nodes, network access, or an allowed application surface.

### Jobs, artifacts, and evidence

Every material execution is represented by a durable job with inspectable steps, events, cancellation, timeouts, outputs, and errors. Raw artifacts are retained when useful. Normalized evidence records provenance and supports domain entities, observations, relationships, findings, and verification.

### Durable knowledge and context

SQLite is the durable system of record. `.localcode/` contains inspectable project knowledge and generated projections. Models receive bounded ContextPacks compiled for the current request rather than entire histories or repositories.

## Domain authority

`WorkflowEngine` remains the durable workflow authority. Domain services can validate, plan, normalize, and project their own state, but they do not infer or advance workflow state independently.

Focused domains extend the shared runtime:

- Development adds projects, phases, slices, pages, components, diffs, previews, and build verification.
- Security adds assessments, cases, scopes, assets, identities, services, observations, relationships, confidence, and evidence.
- Knowledge adds indexed sources, chunks, citations, collections, and retrieval records.
- Infrastructure adds machines, services, health observations, deployments, and incidents.
- Automation adds triggers and schedules around already registered capabilities.

The desktop gateway remains transport. User interfaces render persisted state and server-owned views rather than deriving authoritative status from model prose.

## Kali provider boundary

Kali extends BORG as a security execution provider:

```text
Security capability
  -> assessment scope and operation policy
  -> approval when required
  -> KaliProvider
  -> MCP or SSH transport
  -> fixed typed adapter
  -> Kali tool
  -> raw and normalized evidence
```

MCP can supply tool discovery and transport, but it does not replace BORG's capability registry, target validation, risk classification, command construction, evidence model, or workflow authority. Generic terminal execution is an explicit advanced capability rather than the normal interface offered to the model.

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

### Project Blueprint

For website projects, the durable project plan is produced as a staged blueprint before implementation:

    Product Map
      -> Design Direction
      -> Global Design System
      -> Component Architecture
      -> Build Roadmap
      -> Operator Approval

The stages are ordered dependencies, not parallel suggestions. Sitemap/routes/user journeys are resolved before visual-system planning; component architecture is derived from the frozen product map and design system; implementation slices are derived last. The first frontend slice establishes shared visual primitives before product-specific UI.

These planning stages may use multiple model calls, but they do not create parallel workflow authority. Only the final validated blueprint is submitted to `WorkflowEngine.setProjectPlan()`. Pre-approval feedback rejects the proposed plan and starts another outer project-planning pass without authorizing source mutation.

The UI reads the authoritative blueprint through the workflow-status surface. Generated `.localcode/build/plan.md`, `site-map.md`, `styles.md`, and related files remain projections for agent/human context.

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

## Context artifacts

Model context is not assembled by replaying chat history or rereading the repository wholesale. The Context Compiler produces a typed `ContextPack` for the active slice, page, component, or global Styles workspace.

A ContextPack contains the durable project constraints, current-work boundary, relevant entity registry entries, bounded handoff/decision projections, and selected source files with hashes. Registered source mappings are preferred; repository-memory symbol/import paths provide ranked hints; known frontend entrypoints are only a final fallback. The compiler itself does not perform a broad source-tree content scan.

ContextPacks are persisted in SQLite before model execution and have deterministic fingerprints. Exact provider request bodies remain a separate audit artifact. This makes project knowledge reusable and inspectable without making provider-specific prompt serialization part of project state.

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
