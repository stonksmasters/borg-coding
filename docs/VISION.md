# BORG Code Vision

Last updated: 2026-09-18

## North star

BORG Code is a private local AI website builder that turns a natural-language brief into a complete, verified website while keeping the user continuously informed and in control.

The target experience is simple:

1. The user describes the website they want.
2. BORG turns the brief into a concrete project direction and implementation plan.
3. The user approves the direction.
4. BORG builds the frontend autonomously in small, inspectable slices.
5. Each slice is verified in the browser, repaired when necessary, documented, and handed off to the next slice.
6. When the frontend satisfies the approved brief, the user reviews the finished frontend.
7. If the brief requires accounts, persistence, integrations, server logic, or other backend work, BORG begins a separate backend phase using the approved frontend as its contract.
8. The completed project remains understandable, editable, and resumable later.

BORG is not a chat wrapper around a coding model. It is a persistent local software-development system whose primary product is a high-quality website.

## Product principles

### Website first

The default BORG experience optimizes for building and refining websites, not exposing every engineering primitive in the runtime. Worktrees, checkpoints, role routing, review history, browser evidence, task events, and local-model controls remain important, but they support the website-building workflow rather than define the user experience.

### One brief can drive a complete build

A sufficiently clear initial brief should be enough to begin the full frontend workflow. BORG may ask for approval at meaningful product boundaries, but it should not require the user to repeatedly restate the project or manually break normal implementation into developer-sized tasks.

### Persistent knowledge, bounded model context

BORG should remember the project without repeatedly sending the entire conversation or repository to the model.

Durable project state belongs in structured files and persistence. Model context is compiled for the current task from only the information that matters now.

This distinction is foundational:

- project memory is long-lived;
- model context is temporary;
- repository contents are inspected selectively;
- decisions are recorded rather than rediscovered;
- handoffs summarize completed work and required next actions.

### Outer workflow, inner loops

A website build has an outer workflow:

Project -> Phase -> Slice -> Next Slice -> Phase Completion

Each slice has a smaller execution loop:

Context -> Implement -> Preview -> Verify -> Repair -> Document -> Handoff

BORG must not restart the entire project-planning loop every time a slice needs another implementation pass.

### Quality is a product requirement

A build is not complete because code compiles.

User-facing work must meet an explicit visual and interaction standard. BORG uses design direction, browser evidence, responsive inspection, accessibility checks, runtime evidence, and independent review to distinguish technically valid output from finished product quality.

### Observable autonomy

The user should always be able to understand:

- what phase BORG is in;
- what slice it is working on;
- what it is doing now;
- why that action is relevant;
- what files or surfaces are affected;
- what passed or failed verification;
- whether BORG is implementing, verifying, repairing, reviewing, or waiting for approval.

Autonomy without observability becomes a black box. BORG should expose progress without forcing the user to read raw chain-of-thought or low-level logs.

### Human control at meaningful boundaries

BORG may operate autonomously inside an approved implementation scope, but important boundaries remain explicit. Examples include approving a project plan, accepting a frontend phase, authorizing work outside the approved scope, and selecting whether to continue into a backend phase.

### Local and private by default

BORG is designed around local execution, local models, local repositories, and durable local state. External providers may be added deliberately, but privacy and local ownership are default architectural assumptions.

## Long-term product model

A BORG website becomes a structured project rather than an undifferentiated repository.

A project contains:

- phases;
- implementation slices;
- pages;
- reusable components;
- design direction;
- project decisions;
- data contracts;
- verification evidence;
- handoffs;
- change history.

Pages and components become first-class entities with dedicated workspaces. Editing a ProductCard should not require loading the entire history of the project. Editing a Checkout page should compile context around that page, its dependencies, its design contract, and its recent verification state.

Over time, high-quality components and page patterns can form a BORG-owned local corpus. The first goal is to build and catalog quality assets. Automatic retrieval from that corpus is a later capability and must not be added before the corpus and selection rules are trustworthy.

## Success criteria

BORG is moving toward the target when it can repeatedly:

- take a complex website brief and form a coherent frontend plan;
- maintain the plan across a long-running build;
- execute each slice without unnecessary repository-wide replanning;
- preserve important decisions without context bloat;
- produce visually strong, responsive, accessible interfaces;
- verify claims with deterministic and browser evidence;
- recover from failures without losing project state;
- show the user exactly where the build stands;
- let the user isolate and improve a page or component later;
- continue into backend implementation only when the product requires it.

The final goal is not maximum agent complexity. The final goal is a dependable local builder that can create, inspect, improve, verify, and maintain excellent full-stack websites from a high-level brief.
