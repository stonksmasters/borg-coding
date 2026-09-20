# BORG Context System

Last updated: 2026-09-20

## Purpose

BORG needs long-running project memory without turning every model call into a full replay of the repository and conversation.

The solution is a Context Compiler: a server-owned layer that assembles the smallest sufficient context for the current action from durable project state.

The Context Compiler is an explicit, bounded service for frontend work. Its canonical output is a typed `ContextPack`: a deterministic, fingerprinted artifact containing a profile, authority source, bounded text, provenance manifest, and exact source hashes. Packs are persisted in SQLite before model execution so restart/recovery and diagnostics can inspect exactly what knowledge BORG assembled.

The compiler consumes the durable project plan and workflow slice when available. Generated build files are supplemental projection inputs only; they cannot replace newer workflow authority. The exact serialized Ollama request is persisted separately in `model_contexts`. A ContextPack answers "what project knowledge did BORG compile?"; a model-context record answers "what exact request body did the runtime send?"

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

Repository intelligence identifies likely dependencies and surfaces before source reads. Context compilation no longer walks hundreds of files and reads their contents to rank relevance on every mini-loop. Source selection follows this order:

1. registered Page/Component source mappings;
2. ranked symbol/import paths from the persistent repository-memory index;
3. a small known-entrypoint fallback when neither exists.

The model can still use read-only repository tools when a scoped pack proves insufficient, but broad scanning is no longer the compiler's default behavior.

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

## Scoped context profiles

Pages, components, slices, and global styles use the same ContextPack compiler with different profiles.

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

For the Styles workspace, include the canonical global style system, compact page/component inventory, shared style/layout sources, relevant decisions, and representative source hints without injecting every component implementation.

This is one of the main ways BORG improves quality while reducing prompt size.

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

- one canonical `ContextPack` domain contract;
- explicit `slice`, `page`, `component`, and `styles` profiles;
- planning / execution / repair stage identity;
- authoritative workflow plan and slice injection;
- canonical style-system injection from the durable project plan;
- pinned website product and original-project contracts;
- bounded character budgets;
- required vs optional manifest entries;
- SHA-256 provenance for every included section;
- deterministic pack fingerprints;
- project-model Page/Component registry context;
- handoff and durable-decision compression;
- source selection from registered mappings and repository-memory symbol/import hints;
- no compiler-owned broad source-tree content scan;
- a small entrypoint fallback for unmapped greenfield projects;
- SQLite persistence of compiled packs;
- separate persistence of exact model request bodies;
- diagnostic endpoints for both artifacts;
- tests for relevance, deterministic fingerprints, Styles isolation, dependency hints, and restart persistence.

Under context pressure, pinned product/project/style/current-work contracts are added before optional projections and source files. Optional history and source context is dropped before durable constraints.

Remaining hardening should improve the freshness and precision of Page/Component source mappings and attach repair/evidence overlays to the same pack model without broadening the base prompt.

## Success criteria

The context system is working when BORG can run a long multi-slice build while:

- remembering approved decisions;
- avoiding repeated full-repository discovery;
- avoiding repeated project planning;
- keeping prompts bounded;
- resuming after restart;
- moving cleanly between project, page, and component scopes;
- producing better results because the model sees less irrelevant information, not more.
