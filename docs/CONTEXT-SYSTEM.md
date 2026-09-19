# BORG Context System

Last updated: 2026-09-19

## Purpose

BORG needs long-running project memory without turning every model call into a full replay of the repository and conversation.

The solution is a Context Compiler: a server-owned layer that assembles the smallest sufficient context for the current action from durable project state.

The Context Compiler now exists as an explicit, bounded service for frontend work. It consumes authoritative project-plan and slice state when available, pins the global website product/design contract, records a provenance manifest, and adds only relevant project-model, handoff, decision, evidence, and source-file context. Generated build files remain fallback/projection inputs for migration and inspection rather than progression authority.

## Core distinction

### Durable project memory

Long-lived, inspectable, recoverable information.

Examples:

- original brief;
- approved goals;
- audience;
- page and feature inventory;
- design direction;
- architecture decisions;
- accepted constraints;
- current phase and slice;
- slice acceptance criteria;
- completed work;
- open risks;
- data contracts;
- relevant verification evidence;
- handoffs.

### Ephemeral model context

The information supplied to one model invocation.

It should contain only what that invocation needs.

A model working on ProductCard should not receive the full history of unrelated checkout, authentication, deployment, or earlier visual experiments unless those facts materially constrain ProductCard.

## Conceptual compiler output

A compiled context should resemble:

    PROJECT
    - goal
    - audience
    - product constraints
    - design direction
    - important durable decisions

    CURRENT WORK
    - phase
    - slice or entity
    - user-visible outcome
    - acceptance criteria
    - current status

    RELEVANT STRUCTURE
    - related pages
    - related components
    - relevant files
    - dependencies
    - interfaces and data contracts

    HANDOFF
    - what is already complete
    - what was verified
    - unresolved issues
    - required next action

    EVIDENCE
    - recent failures
    - browser evidence
    - review findings

    OPERATING RULES
    - active mode
    - allowed tools
    - mutation scope
    - verification requirements

The exact serialization may evolve. The information boundaries should not.

## Context selection rules

### Include durable decisions, not the whole discussion that produced them

If the project decided discovery is mobile-first with persistent bottom navigation, the model needs the decision. It usually does not need every previous message discussing alternatives.

### Include relevant files, not arbitrary repository breadth

Repository intelligence should identify likely dependencies and surfaces before broad source reads.

### Include recent evidence when it changes the next action

A browser failure, reviewer finding, or failed build belongs in context when the model is repairing that failure.

Old passing evidence should usually be summarized.

### Prefer structured state over assistant prose

The compiler should read authoritative project state, not infer truth from free-form completion claims.

### Use handoffs as compression boundaries

At the end of a slice or role transition, persist a concise handoff containing:

- objective;
- completed work;
- changed surfaces;
- evidence;
- open risks;
- next action.

Future work consumes the handoff rather than replaying all preceding turns.

## Replanning policy

Full planning is expensive and destabilizing.

BORG should re-run project-level planning only when:

- the user materially changes the project goal;
- the approved plan becomes impossible;
- repository state invalidates core assumptions;
- a new phase begins and needs a phase-specific plan;
- the user explicitly requests replanning.

Normal repair, refinement, or continuation stays inside the existing phase and slice loop.

## Page and component scoped context

When pages and components become first-class entities, the Context Compiler should support entity-scoped contexts.

For a component workspace, include:

- component purpose;
- visual contract;
- props and interfaces;
- source files;
- parent and child dependencies;
- pages that consume it;
- recent edit history;
- verification state;
- active user request.

For a page workspace, include:

- route and purpose;
- page composition;
- page-level acceptance criteria;
- components used;
- relevant data contract;
- responsive requirements;
- current evidence.

This is one of the main ways BORG can improve quality while reducing prompt size.

## What must not live only in model memory

Do not rely on the model to remember:

- current slice number;
- whether approval occurred;
- what the previous slice changed;
- what verification passed;
- unresolved reviewer findings;
- project architecture;
- component ownership;
- backend handoff contracts.

Those belong to the system.

## Current implementation

The current compiler provides:

- typed project/slice/scope inputs;
- authoritative workflow-state injection;
- pinned website product/design contract;
- bounded character budgets;
- source provenance manifests;
- project-model and registry context;
- handoff and durable-decision compression;
- recent verification/review evidence;
- relevant source selection using path and bounded content signals;
- persisted exact model-input diagnostics;
- tests proving irrelevant project files are excluded.

The Ollama request trimmer reserves substantially more of its budget for pinned system/product contracts than for old tool history. Under context pressure, stale tool turns should disappear before the current product contract and slice acceptance criteria do.

Next hardening should use language-intelligence dependency mappings for file selection and add richer page/component-specific profiles rather than broadening prompts again.

## Success criteria

The context system is working when BORG can run a long multi-slice build while:

- remembering approved decisions;
- avoiding repeated full-repository discovery;
- avoiding repeated project planning;
- keeping prompts bounded;
- resuming after restart;
- moving cleanly between project, page, and component scopes;
- producing better results because the model sees less irrelevant information, not more.
