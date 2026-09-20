# BORG Code Roadmap

Last updated: 2026-09-20

This roadmap is product-oriented. Historical alpha documents describe implementation milestones; this file describes where BORG is going and what major capabilities are complete, active, or later.

## Status legend

- Built: implemented foundation exists in the current repository.
- Active: current development frontier; implementation exists in part but the product capability is not yet reliable end to end.
- Next: intentionally next after the active frontier.
- Later: planned, but should not distract from the current reliability goals.

## 0. Local coding runtime - Built

Foundation includes:

- local Ollama model execution;
- streamed tool use;
- task persistence;
- permission modes;
- isolated worktrees;
- repository inspection;
- terminal and process execution;
- checkpoints and continuations;
- review and repair infrastructure.

The runtime is no longer the primary product goal. It is the execution substrate for the website builder.

## 1. Persistent coding workstation - Built / hardening

Foundation includes:

- persistent sessions;
- desktop launcher;
- local state restoration;
- mode and approval handling;
- task history;
- durable review decisions;
- guarded desktop synchronization.

Remaining work here should be treated as reliability hardening, not a reason to delay the website-builder product.

## 2. Browser verification and evidence - Built / hardening

Foundation includes:

- local preview execution;
- browser-driven verification;
- console and network evidence;
- responsive checks;
- screenshots;
- accessibility-oriented verification;
- visual-regression support;
- repair loops.

The ongoing goal is to make evidence more reliable and better integrated into the website workflow.

## 3. Website-first builder - Built / active

Current repository capabilities include:

- website project creation;
- original brief persistence;
- tailored project planning;
- page and feature inventory in the plan;
- visual direction;
- ordered frontend slices;
- per-slice acceptance criteria;
- frontend completion gates;
- backend-required classification;
- generated build documentation;
- live preview integration.

The remaining challenge is not basic scaffolding. It is reliable autonomous continuation across a large multi-slice build.

## 4. Phased autonomous frontend workflow - Built / hardening

Target:

One brief -> approved plan -> slice 1 -> verify/repair -> handoff -> slice 2 -> ... -> finished frontend.

Key requirements:

- server-owned phase and slice state;
- no unnecessary full-repository replanning between passes;
- mini-loops inside slices;
- deterministic advancement rules;
- bounded repair;
- clean restart and recovery;
- frontend review as a real product boundary.

A large benchmark such as a social-commerce storefront should be able to run through multiple slices without losing coherence.

## 5. Context Compiler and project memory - Built / hardening

Current foundation:

- slice-scoped Context Compiler;
- authoritative workflow plan/slice input;
- pinned website product and design contracts;
- bounded inclusion budgets;
- source provenance manifests;
- deterministic persisted ContextPacks;
- separate exact model-input audit records;
- slice/page/component/styles profiles;
- page/component registry context;
- repository-memory symbol/import source hints;
- handoff and decision compression;
- recorded model inputs for diagnostics;
- tests for bounded relevance, deterministic replay, restart persistence, and exclusion.

Hardening remains focused on improving source-map freshness, evidence/repair overlays, and keeping critical contracts pinned under local-model context pressure.

## 6. Execution observability - Built / consolidation

Current foundation:

- server-owned RunView derived from durable task/workflow state;
- structured activity feed and execution inspector;
- current phase, slice, action, next transition, and blocker;
- verification and repair visibility;
- Preview / Plan / Changes / Evidence product surfaces;
- advanced logs, project memory, and raw context diagnostics;
- persisted state as the normal UI source of truth.

Consolidation work should continue to remove duplicate status derivation and improve evidence summaries without exposing unnecessary runtime internals.

## 7. First-class Pages and Components - Partial / next

Target:

Represent project structure as product entities, not only files.

Deliverables:

- page registry;
- component registry;
- source/dependency mapping;
- page and component navigation;
- dedicated scoped workspaces;
- focused previews;
- focused verification;
- entity edit history;
- entity-scoped Context Compiler profiles.

This should materially reduce context size for iterative work.

## 8. High-quality component and page corpus - Later

Target:

Build a trustworthy local corpus of reusable UI assets.

First phase:

- collect components and page patterns;
- retain screenshots and evidence;
- retain provenance;
- classify variants;
- record supported states;
- establish promotion quality gates.

Do not automatically inject corpus items into model context yet.

## 9. Component-library intelligence - Later

Only after the corpus is useful and trustworthy:

- semantic and structural retrieval;
- design-fit matching;
- dependency-aware suggestions;
- adaptation rather than blind copying;
- deduplication;
- quality-weighted selection;
- project-aware recommendations.

Retrieval should improve design quality rather than homogenize it.

## 10. Full autonomous full-stack builder - Later

Target:

Extend the same disciplined workflow beyond frontend completion.

Capabilities include:

- backend phase planning;
- data models;
- authentication;
- persistence;
- integrations;
- payments;
- admin/seller tooling;
- server verification;
- end-to-end flows;
- deployment readiness;
- security and dependency review near delivery.

Backend should be driven by the approved product contract, not invented prematurely.

## Immediate development order

The current priority order is:

1. benchmark and harden the completed multi-slice frontend workflow, Context Compiler, and RunView on difficult real projects;
2. replace heuristic Page/Component source relationships with language-intelligence-backed mappings;
3. introduce dedicated Page and Component workspaces using entity-scoped context and verification;
4. build a high-quality reusable component/page corpus with evidence and provenance;
5. add retrieval intelligence only after the corpus is trustworthy;
6. expand the same durable workflow into reliable full-stack implementation.

## Benchmark principle

Use realistic, difficult builds to drive the roadmap.

Benchmarks should expose:

- loss of project coherence;
- context bloat;
- repeated planning;
- weak design;
- broken preview behavior;
- verification gaps;
- recovery failures;
- false completion claims.

Fix the architectural cause rather than teaching the benchmark prompt to work around it.
